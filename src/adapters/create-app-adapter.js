/**
 * Create app stage (Play Console: Home > Create app).
 *
 * Fields (checked on the live console 2026-10-10): app name, app package
 * name (+ "Check availability"), default language, app or game, free or
 * paid, and the Developer Program Policies / US export laws declarations.
 *
 * Steps:
 *  1. precheck     (APP_LIST)   look for an existing app with the same name,
 *                               then open the create form.
 *  2. fill-form    (CREATE_APP) fill fields, check the package name is
 *                               available; stop on unknown questions.
 *  3. submit-create(CREATE_APP) click "Create app" once. Not idempotent;
 *                               the engine verifies by detecting the new
 *                               app's dashboard and never re-clicks.
 */
import { defineStage, inspectFields, applyFields, verifyFields, findUnknownControls, blocking, assertNoBlocking, hasButton } from './base-adapter.js';
import { PAGE_TYPES } from '../content/page-detector.js';
import { getButton, clickElement, collectValidationErrors, normalize, isVisible, waitFor } from '../content/dom-utils.js';
import { PCAError, ERROR_CODES } from '../services/errors.js';

export const CREATE_APP_BUTTON = /^Create app$/i;
export const CHECK_AVAILABILITY_BUTTON = /^Check availability$/i;
const PACKAGE_AVAILABLE = /\bpackage name available\b/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches option text like "English (United States) – en-US". */
export function languageOptionMatcher(code) {
  return new RegExp(`(^|[\\s–—(-])${escapeRe(code)}\\)?$`, 'i');
}

export const CREATE_FORM_FIELDS = [
  { key: 'appName', label: 'App name', kind: 'text', value: (p) => p.appName },
  { key: 'packageName', label: 'App package name', kind: 'text', value: (p) => p.packageName || undefined },
  // The dropdown's accessible name is "Default language: <current value>".
  { key: 'defaultLanguage', label: /^Default language(:|$)/i, kind: 'select', value: (p) => languageOptionMatcher(p.defaultLanguage) },
  { key: 'appOrGame', label: 'App or game', kind: 'radio', value: (p) => (p.appOrGame === 'game' ? 'Game' : 'App') },
  { key: 'pricing', label: 'Free or paid', kind: 'radio', value: (p) => (p.pricing === 'paid' ? 'Paid' : 'Free') },
  { key: 'policiesAccepted', label: /Developer Program Policies/i, kind: 'checkbox', value: (p) => (p.policiesAccepted === true ? true : undefined) },
  { key: 'exportLawsAccepted', label: /US export laws/i, kind: 'checkbox', value: (p) => (p.exportLawsAccepted === true ? true : undefined) },
];
const KNOWN_CONTROLS = ['App', 'Game', 'Free', 'Paid', /Developer Program Policies/i, /US export laws/i];

function createPayload(app, ctx = {}) {
  return {
    appName: app.metadata.appName,
    packageName: app.metadata.packageName,
    defaultLanguage: app.metadata.defaultLanguage,
    appOrGame: app.metadata.appOrGame,
    pricing: app.metadata.pricing,
    policiesAccepted: app.appContent.declarations.policiesAccepted,
    exportLawsAccepted: app.appContent.declarations.exportLawsAccepted,
    allowDuplicateName: Boolean(ctx.progress && ctx.progress.allowDuplicateName),
  };
}

/** First non-empty leaf text in `el` (the app name above its package name). */
function firstLeafText(el) {
  for (const n of el.querySelectorAll('*')) {
    if (n.children.length || !isVisible(n)) continue;
    const t = normalize(n.textContent);
    if (t) return t;
  }
  return normalize(el.textContent);
}

/**
 * Visible app names in the app list. Live, the list is a role=grid whose
 * first gridcell holds the name and, below it, the package name.
 */
export function listedAppNames(root) {
  const names = [];
  for (const r of root.querySelectorAll('[role=grid] [role=row],[role=table] [role=row],table tr')) {
    if (r.querySelector('[role=columnheader],th:not([scope=row])')) continue;
    const cell = r.querySelector('[role=rowheader],[role=gridcell],[role=cell],th,td');
    const t = cell ? firstLeafText(cell) : '';
    if (t) names.push(t);
  }
  return names;
}

/** The live region that reports the package name check, if shown. */
function packageStatus(root) {
  const region = [...root.querySelectorAll('[aria-live]:not([aria-live=off]),[role=status],[role=alert]')]
    .find((r) => isVisible(r) && /package name/i.test(r.textContent));
  return region ? normalize(region.textContent).replace(/^(check_circle|error|warning)\s*/, '') : '';
}

/** Clicks "Check availability" and waits for Play Console's answer. */
async function checkPackageAvailability(root, timeout = 15000) {
  if (PACKAGE_AVAILABLE.test(packageStatus(root))) return;
  clickElement(getButton(root, CHECK_AVAILABILITY_BUTTON));
  const status = await waitFor(() => packageStatus(root), { timeout, description: 'package name availability' });
  if (!PACKAGE_AVAILABLE.test(status) || /\b(not|un)available\b/i.test(status)) {
    throw new PCAError(ERROR_CODES.PACKAGE_UNAVAILABLE, `Play Console: ${status}`);
  }
}

export const createAppStage = defineStage('CREATE_APP', [
  {
    id: 'precheck',
    page: PAGE_TYPES.APP_LIST,
    expectsNavigation: true,
    approval: false, // only opens the form
    navigatesTo: PAGE_TYPES.CREATE_APP,
    buildPayload: createPayload,
    inspect(root, p) {
      const report = { fields: [], blocking: [], notes: [] };
      const lower = p.appName.toLowerCase();
      const dupes = listedAppNames(root).filter((n) => n.toLowerCase() === lower || n.toLowerCase().startsWith(`${lower} `));
      if (dupes.length && !p.allowDuplicateName) {
        report.blocking.push(blocking(ERROR_CODES.POSSIBLE_DUPLICATE_APP,
          `An app named "${p.appName}" already appears in this account. Link it to this record or confirm that a second app should be created.`, { matches: dupes }));
      }
      // On the app list "Create app" is a link, not a button.
      if (!hasButton(root, CREATE_APP_BUTTON, { links: true })) report.blocking.push(blocking(ERROR_CODES.ELEMENT_NOT_FOUND, 'The "Create app" button is not visible on this page.'));
      report.notes.push('Opens the Create app form. Nothing is created in this step.');
      return report;
    },
    apply(root, p) {
      assertNoBlocking(this.inspect(root, p));
      clickElement(getButton(root, CREATE_APP_BUTTON, { links: true }));
      return { clicked: 'Create app' };
    },
    verify: () => ({ ok: true, mismatches: [] }), // verified by navigation to CREATE_APP
  },
  {
    id: 'fill-form',
    page: PAGE_TYPES.CREATE_APP,
    buildPayload: createPayload,
    inspect(root, p) {
      const r = inspectFields(root, CREATE_FORM_FIELDS, p);
      if (!p.packageName) r.blocking.push(blocking(ERROR_CODES.VALIDATION_FAILED, 'Play Console asks for the package name when creating the app. Enter it in this app\'s form first.', { field: 'packageName' }));
      const status = packageStatus(root);
      if (status) r.notes = [`Package name check: ${status}`];
      const unknown = findUnknownControls(root, KNOWN_CONTROLS);
      for (const u of unknown) r.blocking.push(blocking(ERROR_CODES.UNKNOWN_QUESTION, `Unrecognised question on the Create app form: ${u}`));
      if (p.policiesAccepted !== true || p.exportLawsAccepted !== true) {
        r.blocking.push(blocking(ERROR_CODES.DECLARATION_UNANSWERED, 'Confirm both creation declarations for this app in its form first.'));
      }
      return r;
    },
    async apply(root, p) {
      assertNoBlocking(this.inspect(root, p));
      const applied = await applyFields(root, CREATE_FORM_FIELDS, p);
      await checkPackageAvailability(root);
      return { applied };
    },
    verify(root, p) {
      const mismatches = verifyFields(root, CREATE_FORM_FIELDS, p);
      if (!PACKAGE_AVAILABLE.test(packageStatus(root))) mismatches.push({ field: 'packageName', message: 'Play Console has not confirmed that the package name is available.' });
      for (const e of collectValidationErrors(root)) mismatches.push({ field: e.field, message: e.message });
      return { ok: mismatches.length === 0, mismatches };
    },
  },
  {
    id: 'submit-create',
    page: PAGE_TYPES.CREATE_APP,
    idempotent: false,
    onUncertain: 'verify',
    expectsNavigation: true,
    navigatesTo: PAGE_TYPES.APP_DASHBOARD,
    buildPayload: createPayload,
    inspect(root, p) {
      const r = { fields: [], blocking: [], notes: ['Clicks "Create app" once. This creates the app in your Play Console account.'] };
      const mismatches = verifyFields(root, CREATE_FORM_FIELDS, p);
      for (const m of mismatches) r.blocking.push(blocking(ERROR_CODES.VERIFY_FAILED, m.message, { field: m.field }));
      if (!hasButton(root, CREATE_APP_BUTTON)) r.blocking.push(blocking(ERROR_CODES.ELEMENT_NOT_FOUND, 'The "Create app" submit button is not visible.'));
      return r;
    },
    apply(root, p) {
      assertNoBlocking(this.inspect(root, p));
      clickElement(getButton(root, CREATE_APP_BUTTON));
      return { clicked: 'Create app' };
    },
    verify: () => ({ ok: true, mismatches: [] }), // the engine verifies via the new dashboard page
  },
]);
