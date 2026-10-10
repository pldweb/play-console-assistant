/**
 * Base adapter: declarative field specs with shared inspect/apply/verify.
 *
 * A stage is a list of steps. Each step targets one page type and exposes:
 *   buildPayload(app, ctx) -> plain JSON payload (runs in the service worker)
 *   inspect(dom, payload)  -> report (no writes)
 *   apply(dom, payload)    -> performs the writes / clicks
 *   verify(dom, payload)   -> { ok, mismatches }
 * plus flags: idempotent, expectsNavigation, verifyAfterReload, manual.
 *
 * Field spec:
 *   { key, label, kind: 'text'|'select'|'radio'|'checkbox', within?, value(payload) }
 *   value() returning undefined means "do not touch this field".
 *   radio: value() returns the label of the option to choose.
 *   select: value() returns the option text (string or RegExp).
 *   checkbox: value() returns true/false.
 */
import {
  getByLabel, getSection, getFieldValue, setTextValue, selectOption, setChecked, isChecked,
  getButton, clickElement, collectValidationErrors, waitFor, accessibleName, isVisible, normalize,
  KIND_SELECTORS, matchesLabel, queryButtons,
} from '../content/dom-utils.js';
import { PCAError, ERROR_CODES, toPCAError } from '../services/errors.js';

export function defineStep(step) {
  return {
    idempotent: true,
    expectsNavigation: false,
    verifyAfterReload: false,
    manual: false,
    // readOnly: never writes; no approval needed.
    readOnly: false,
    // approval: whether the plan-approval gate applies (when enabled in settings).
    approval: !step.readOnly,
    // onUncertain (non-idempotent steps): after an action whose outcome is
    // unknown, 'verify' = only verify, never act again; 'reinspect' = the
    // step's inspection is designed to detect its own earlier effect.
    onUncertain: 'verify',
    fields: [],
    buildPayload: () => ({}),
    ...step,
  };
}

export function defineStage(id, steps) {
  return { id, steps: steps.map(defineStep) };
}

const labelText = (l) => (l instanceof RegExp ? l.source : String(l));
const sameText = (a, b) => String(a ?? '').replace(/\r\n/g, '\n') === String(b ?? '').replace(/\r\n/g, '\n');

function locate(root, spec, planned) {
  const scope = spec.within ? getSection(root, spec.within) : root;
  if (spec.kind === 'radio') return getByLabel(scope, planned, 'radio');
  return getByLabel(scope, spec.label, spec.kind);
}

function currentValue(el, spec) {
  if (spec.kind === 'checkbox' || spec.kind === 'radio') return isChecked(el);
  return getFieldValue(el);
}

function alreadyApplied(el, spec, planned) {
  const cur = currentValue(el, spec);
  if (spec.kind === 'radio') return cur === true;
  if (spec.kind === 'checkbox') return cur === planned;
  if (spec.kind === 'select') {
    return planned instanceof RegExp ? planned.test(normalize(cur)) : normalize(cur).toLowerCase() === normalize(planned).toLowerCase();
  }
  return sameText(cur, planned);
}

/** Report on every field without writing anything. */
export function inspectFields(root, specs, payload) {
  const fields = [];
  const blocking = [];
  for (const spec of specs) {
    const planned = spec.value(payload);
    const base = { key: spec.key, label: labelText(spec.kind === 'radio' && planned !== undefined ? planned : spec.label), kind: spec.kind };
    if (planned === undefined) { fields.push({ ...base, status: 'skipped' }); continue; }
    try {
      const el = locate(root, spec, planned);
      const done = alreadyApplied(el, spec, planned);
      fields.push({ ...base, status: 'found', current: currentValue(el, spec), planned: planned instanceof RegExp ? planned.source : planned, willChange: !done });
    } catch (e) {
      const err = toPCAError(e);
      fields.push({ ...base, status: err.code === ERROR_CODES.AMBIGUOUS_ELEMENT ? 'ambiguous' : 'missing', planned: planned instanceof RegExp ? planned.source : planned });
      blocking.push({ code: err.code, message: err.message, field: spec.key });
    }
  }
  return { fields, blocking };
}

export async function applyFields(root, specs, payload) {
  const applied = [];
  for (const spec of specs) {
    const planned = spec.value(payload);
    if (planned === undefined) continue;
    const el = locate(root, spec, planned);
    if (alreadyApplied(el, spec, planned)) continue;
    if (spec.kind === 'text') setTextValue(el, planned);
    else if (spec.kind === 'select') await selectOption(el, planned);
    else if (spec.kind === 'checkbox') setChecked(el, planned);
    else if (spec.kind === 'radio') setChecked(el, true);
    applied.push(spec.key);
  }
  return applied;
}

export function verifyFields(root, specs, payload) {
  const mismatches = [];
  for (const spec of specs) {
    const planned = spec.value(payload);
    if (planned === undefined) continue;
    try {
      const el = locate(root, spec, planned);
      if (!alreadyApplied(el, spec, planned)) mismatches.push({ field: spec.key, message: `"${labelText(spec.label)}" does not show the expected value.` });
    } catch (e) {
      mismatches.push({ field: spec.key, message: toPCAError(e).message });
    }
  }
  return mismatches;
}

/**
 * Lists checkboxes and radio groups in `root` that are not covered by
 * `knownLabels`. New or unrecognised questions must stop automation.
 */
export function findUnknownControls(root, knownLabels) {
  const known = (name) => knownLabels.some((l) => matchesLabel(name, l));
  const unknown = [];
  for (const el of root.querySelectorAll(KIND_SELECTORS.checkbox)) {
    if (!isVisible(el)) continue;
    const name = accessibleName(el);
    if (!known(name)) unknown.push(name || '(unlabelled checkbox)');
  }
  const groups = new Map();
  for (const el of root.querySelectorAll(KIND_SELECTORS.radio)) {
    if (!isVisible(el)) continue;
    const group = el.closest('[role=radiogroup],fieldset');
    const key = el.getAttribute('name') || (group && (group.getAttribute('aria-label') || group.id)) || accessibleName(el);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(accessibleName(el));
  }
  for (const [key, names] of groups) {
    if (!names.some(known)) unknown.push(`Radio group "${key}": ${names.join(' / ')}`);
  }
  return unknown;
}

export const SAVE_BUTTON = /^Save( changes| as draft)?$/i;

/**
 * Clicks Save and waits until the page either reports validation errors
 * (throws PAGE_VALIDATION_ERROR) or the save button is no longer actionable
 * / a "saved" status appears.
 */
export async function saveChanges(root, { button = SAVE_BUTTON, timeout = 15000 } = {}) {
  const before = collectValidationErrors(root).map((e) => e.message);
  const btn = getButton(root, button);
  clickElement(btn);
  return waitFor(() => {
    const errs = collectValidationErrors(root).filter((e) => !before.includes(e.message));
    if (errs.length) throw new PCAError(ERROR_CODES.PAGE_VALIDATION_ERROR, `Play Console reported: ${errs.map((e) => e.message).join('; ')}`, { errors: errs });
    const statusSaved = [...root.querySelectorAll('[role=status],[aria-live]')].some((s) => /\bsaved\b/i.test(s.textContent));
    return statusSaved || btn.disabled || btn.getAttribute('aria-disabled') === 'true' || !btn.isConnected;
  }, { timeout, description: 'save confirmation', rethrow: true });
}

export function hasButton(root, text, options) {
  return queryButtons(root, text, options).length > 0;
}

export function blocking(code, message, extra = {}) {
  return { code, message, ...extra };
}

/** Throws when an inspection report has blocking issues. */
export function assertNoBlocking(report) {
  if (report.blocking && report.blocking.length) {
    const first = report.blocking[0];
    throw new PCAError(first.code || ERROR_CODES.UNKNOWN_QUESTION, first.message, { blocking: report.blocking });
  }
}
