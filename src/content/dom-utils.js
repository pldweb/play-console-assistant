/**
 * DOM helpers for semantic element lookup and verified interaction.
 *
 * Rules:
 *  - Elements are located by accessible name, role, label association or
 *    exact visible text. No generated class names, no positions.
 *  - Zero matches -> ELEMENT_NOT_FOUND; more than one -> AMBIGUOUS_ELEMENT.
 *    The caller stops instead of guessing.
 *  - Every write is read back; a value that did not stick throws
 *    VALUE_NOT_APPLIED.
 *  - Values are set the way a user's input would arrive (native value
 *    setter + input/change events). No framework internals are touched.
 *
 * All functions take a root node; window constructors are taken from the
 * root's own window so the code runs unchanged in jsdom and in Chrome.
 */
import { PCAError, ERROR_CODES } from '../services/errors.js';

export const winOf = (node) => (node.ownerDocument || node).defaultView;
export const docOf = (node) => node.ownerDocument || node;
export const normalize = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

const TEXTBOX = 'input:not([type]),input[type=text],input[type=email],input[type=url],input[type=tel],input[type=number],input[type=search],textarea,[role=textbox],[contenteditable=true]';
const COMBOBOX = 'select,[role=combobox]';
const CHECKBOX = 'input[type=checkbox],[role=checkbox]';
const RADIO = 'input[type=radio],[role=radio]';
const FILE = 'input[type=file]';
const BUTTON = 'button,[role=button],input[type=submit],input[type=button]';
export const KIND_SELECTORS = Object.freeze({ text: TEXTBOX, select: COMBOBOX, checkbox: CHECKBOX, radio: RADIO, file: FILE, button: BUTTON });

export function isVisible(el) {
  const win = winOf(el);
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.hidden || n.getAttribute('aria-hidden') === 'true' || n.inert) {
      // File inputs are commonly visually hidden behind an upload button but
      // remain the real control; treat them as present when not inert.
      if (!(el.matches(FILE) && n === el && !n.inert)) return false;
    }
    const style = win.getComputedStyle(n);
    if (style.display === 'none' || (style.visibility === 'hidden' && !el.matches(FILE))) return false;
  }
  return true;
}

function textOf(el) {
  return normalize(el ? el.textContent : '');
}

/** Simplified accessible-name computation (aria-labelledby > aria-label > label > title > content > placeholder). */
export function accessibleName(el) {
  const doc = docOf(el);
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const t = labelledby.split(/\s+/).map((id) => textOf(doc.getElementById(id))).filter(Boolean).join(' ');
    if (t) return t;
  }
  const aria = el.getAttribute('aria-label');
  if (aria && normalize(aria)) return normalize(aria);
  if (el.id) {
    const labels = [...doc.querySelectorAll('label[for]')].filter((l) => l.getAttribute('for') === el.id);
    if (labels.length) return normalize(labels.map(textOf).join(' '));
  }
  const wrapping = el.closest('label');
  if (wrapping) return textOf(wrapping);
  if (el.getAttribute('title')) return normalize(el.getAttribute('title'));
  const role = el.getAttribute('role');
  if (el.matches('button,[role=button],[role=option],[role=radio],[role=checkbox],[role=tab],a') || role === 'menuitem') {
    return textOf(el) || normalize(el.value);
  }
  if (el.matches('input[type=submit],input[type=button]')) return normalize(el.value);
  if (el.getAttribute('placeholder')) return normalize(el.getAttribute('placeholder'));
  return '';
}

/** Strips required markers and character counters from a label. */
export function cleanLabel(s) {
  return normalize(s).replace(/\s*\*$/, '').replace(/\s*\(required\)$/i, '').replace(/\s*\d+\s*\/\s*\d+$/, '').trim();
}

export function matchesLabel(name, label) {
  if (label instanceof RegExp) return label.test(normalize(name));
  return cleanLabel(name).toLowerCase() === cleanLabel(label).toLowerCase();
}

function describe(label) {
  return label instanceof RegExp ? label.toString() : `"${label}"`;
}

/** All visible elements of `kind` under root whose accessible name matches. */
export function queryAllByLabel(root, label, kind = 'text') {
  const sel = KIND_SELECTORS[kind];
  if (!sel) throw new Error(`Unknown element kind ${kind}`);
  return [...root.querySelectorAll(sel)].filter((el) => isVisible(el) && matchesLabel(accessibleName(el), label));
}

/** Exactly one match or a classified error. */
export function getByLabel(root, label, kind = 'text') {
  const found = queryAllByLabel(root, label, kind);
  if (found.length === 0) throw new PCAError(ERROR_CODES.ELEMENT_NOT_FOUND, `No ${kind} field labelled ${describe(label)} was found.`, { label: String(label), kind });
  if (found.length > 1) throw new PCAError(ERROR_CODES.AMBIGUOUS_ELEMENT, `${found.length} ${kind} fields are labelled ${describe(label)}; refusing to guess.`, { label: String(label), kind, count: found.length });
  return found[0];
}

export function queryButtons(root, text) {
  return [...root.querySelectorAll(BUTTON)].filter((el) => isVisible(el) && matchesLabel(accessibleName(el), text));
}

export function getButton(root, text) {
  const found = queryButtons(root, text);
  if (found.length === 0) throw new PCAError(ERROR_CODES.ELEMENT_NOT_FOUND, `No button ${describe(text)} was found.`, { label: String(text), kind: 'button' });
  if (found.length > 1) throw new PCAError(ERROR_CODES.AMBIGUOUS_ELEMENT, `${found.length} buttons match ${describe(text)}; refusing to guess.`, { label: String(text), kind: 'button', count: found.length });
  return found[0];
}

/**
 * Finds the container for a titled section: a region/group/fieldset named
 * `title`, or a <section> whose heading matches.
 */
export function getSection(root, title) {
  const candidates = new Set();
  for (const el of root.querySelectorAll('[role=region],[role=group],section,fieldset')) {
    if (!isVisible(el)) continue;
    const legend = el.matches('fieldset') ? el.querySelector(':scope > legend') : null;
    const name = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ? accessibleName(el) : legend ? textOf(legend) : '';
    if (name && matchesLabel(name, title)) { candidates.add(el); continue; }
    const heading = el.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > header h2, :scope > header h3, :scope > [role=heading]');
    if (heading && matchesLabel(textOf(heading), title)) candidates.add(el);
  }
  // Prefer the innermost containers when nested sections both match.
  const list = [...candidates].filter((c) => ![...candidates].some((o) => o !== c && c.contains(o)));
  if (list.length === 0) throw new PCAError(ERROR_CODES.ELEMENT_NOT_FOUND, `Section ${describe(title)} was not found.`, { label: String(title), kind: 'section' });
  if (list.length > 1) throw new PCAError(ERROR_CODES.AMBIGUOUS_ELEMENT, `${list.length} sections match ${describe(title)}.`, { label: String(title), kind: 'section' });
  return list[0];
}

export function getHeadingTexts(root) {
  return [...root.querySelectorAll('h1,h2,[role=heading][aria-level="1"]')].filter(isVisible).map(textOf);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Bounded polling until `predicate()` returns a truthy value.
 * Errors thrown by the predicate propagate immediately when `rethrow` is set.
 */
export async function waitFor(predicate, { timeout = 10000, interval = 100, description = 'condition', rethrow = false } = {}) {
  const end = Date.now() + timeout;
  let lastError = null;
  for (;;) {
    try {
      const v = await predicate();
      if (v) return v;
    } catch (e) {
      if (rethrow) throw e;
      lastError = e;
    }
    if (Date.now() >= end) {
      throw new PCAError(ERROR_CODES.WAIT_TIMEOUT, `Timed out after ${timeout} ms waiting for ${description}.`, lastError ? { lastError: lastError.message } : undefined);
    }
    await sleep(interval);
  }
}

function assertEnabled(el) {
  if (el.disabled || el.getAttribute('aria-disabled') === 'true' || el.readOnly || el.getAttribute('aria-readonly') === 'true') {
    throw new PCAError(ERROR_CODES.ELEMENT_DISABLED, `Field "${accessibleName(el)}" is disabled or read-only.`);
  }
}

function fire(el, type, init = {}) {
  const win = winOf(el);
  const Ctor = type === 'input' && win.InputEvent ? win.InputEvent : win.Event;
  el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: false, composed: true, ...init }));
}

export function getFieldValue(el) {
  if (el.matches('[contenteditable=true],[role=textbox]:not(input):not(textarea)')) return el.textContent;
  if (el.matches('select')) return el.selectedOptions[0] ? normalize(el.selectedOptions[0].textContent) : '';
  if (el.matches('[role=combobox]:not(input)')) return textOf(el);
  return el.value;
}

/** Normalises line endings so textarea read-back compares equal. */
const eqText = (a, b) => String(a ?? '').replace(/\r\n/g, '\n') === String(b ?? '').replace(/\r\n/g, '\n');

export function setTextValue(el, value) {
  assertEnabled(el);
  const win = winOf(el);
  el.focus();
  if (el.matches('[contenteditable=true],[role=textbox]:not(input):not(textarea)')) {
    el.textContent = value;
    fire(el, 'input', { inputType: 'insertReplacementText', data: value });
  } else {
    const proto = el.matches('textarea') ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    fire(el, 'input', { inputType: 'insertReplacementText', data: value });
    fire(el, 'change');
  }
  el.dispatchEvent(new win.FocusEvent('blur'));
  el.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }));
  if (!eqText(getFieldValue(el), value)) {
    throw new PCAError(ERROR_CODES.VALUE_NOT_APPLIED, `Value for "${accessibleName(el)}" did not stick.`);
  }
}

function optionMatches(text, wanted) {
  if (wanted instanceof RegExp) return wanted.test(normalize(text));
  return normalize(text).toLowerCase() === normalize(wanted).toLowerCase();
}

/** Selects an option in a native <select> or an ARIA combobox/listbox. */
export async function selectOption(el, wanted, { timeout = 5000 } = {}) {
  assertEnabled(el);
  const win = winOf(el);
  const doc = docOf(el);
  if (el.matches('select')) {
    const opts = [...el.options].filter((o) => optionMatches(o.textContent, wanted) || (typeof wanted === 'string' && o.value === wanted));
    if (opts.length === 0) throw new PCAError(ERROR_CODES.ELEMENT_NOT_FOUND, `Option ${describe(wanted)} not found in "${accessibleName(el)}".`);
    if (opts.length > 1) throw new PCAError(ERROR_CODES.AMBIGUOUS_ELEMENT, `Several options match ${describe(wanted)} in "${accessibleName(el)}".`);
    const setter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value').set;
    setter.call(el, opts[0].value);
    fire(el, 'input');
    fire(el, 'change');
    if (el.selectedOptions[0] !== opts[0]) throw new PCAError(ERROR_CODES.VALUE_NOT_APPLIED, `Option was not selected in "${accessibleName(el)}".`);
    return normalize(opts[0].textContent);
  }
  // ARIA combobox: open, wait for options, click the single match.
  if (el.getAttribute('aria-expanded') !== 'true') el.click();
  const controls = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
  const scope = () => (controls && doc.getElementById(controls)) || doc;
  const option = await waitFor(() => {
    const opts = [...scope().querySelectorAll('[role=option]')].filter((o) => isVisible(o) && optionMatches(o.textContent, wanted));
    if (opts.length > 1) throw new PCAError(ERROR_CODES.AMBIGUOUS_ELEMENT, `Several options match ${describe(wanted)}.`);
    return opts[0];
  }, { timeout, description: `option ${describe(wanted)}`, rethrow: true });
  const label = normalize(option.textContent);
  option.click();
  await waitFor(() => normalize(getFieldValue(el)).toLowerCase().includes(label.toLowerCase())
    || option.getAttribute('aria-selected') === 'true', { timeout, description: 'selection to apply' })
    .catch(() => { throw new PCAError(ERROR_CODES.VALUE_NOT_APPLIED, `Option ${describe(wanted)} did not apply.`); });
  return label;
}

export function isChecked(el) {
  if (el.matches('input[type=checkbox],input[type=radio]')) return el.checked;
  return el.getAttribute('aria-checked') === 'true';
}

export function setChecked(el, desired) {
  assertEnabled(el);
  if (isChecked(el) !== desired) el.click();
  if (isChecked(el) !== desired) {
    throw new PCAError(ERROR_CODES.VALUE_NOT_APPLIED, `Could not ${desired ? 'check' : 'uncheck'} "${accessibleName(el)}".`);
  }
}

export function clickElement(el) {
  if (el.disabled || el.getAttribute('aria-disabled') === 'true') {
    throw new PCAError(ERROR_CODES.ELEMENT_DISABLED, `"${accessibleName(el)}" is disabled.`);
  }
  el.click();
}

/**
 * Collects visible validation errors: role=alert messages and fields with
 * aria-invalid=true (with their aria-describedby text).
 */
export function collectValidationErrors(root) {
  const doc = docOf(root);
  const out = [];
  for (const el of root.querySelectorAll('[role=alert]')) {
    if (isVisible(el) && textOf(el)) out.push({ field: null, message: textOf(el) });
  }
  for (const el of root.querySelectorAll('[aria-invalid=true]')) {
    if (!isVisible(el)) continue;
    const ids = (el.getAttribute('aria-describedby') || el.getAttribute('aria-errormessage') || '').split(/\s+/).filter(Boolean);
    const msg = ids.map((id) => textOf(doc.getElementById(id))).filter(Boolean).join(' ') || 'Field is marked invalid.';
    out.push({ field: accessibleName(el), message: msg });
  }
  return out;
}

/**
 * Assigns files to a file input the way a drag-and-drop would, then fires
 * input/change. Requires DataTransfer (available in Chrome).
 */
export function setFileInput(input, files) {
  const win = winOf(input);
  if (input.disabled) throw new PCAError(ERROR_CODES.ELEMENT_DISABLED, 'Upload input is disabled.');
  if (files.length > 1 && !input.multiple) throw new PCAError(ERROR_CODES.UPLOAD_FAILED, 'Upload input accepts one file at a time.');
  if (typeof win.DataTransfer !== 'function') throw new PCAError(ERROR_CODES.UPLOAD_FAILED, 'This browser cannot assign files programmatically.');
  const dt = new win.DataTransfer();
  for (const f of files) dt.items.add(f);
  input.files = dt.files;
  fire(input, 'input');
  fire(input, 'change');
  if (!input.files || input.files.length !== files.length) throw new PCAError(ERROR_CODES.UPLOAD_FAILED, 'Files were not attached to the upload input.');
}

/**
 * Visible text with a space between text nodes. Plain `textContent`
 * glues adjacent elements together ("All appsAcme Notes"), which breaks
 * word-boundary matching.
 */
export function visibleText(root) {
  const doc = docOf(root);
  const win = winOf(root);
  const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT);
  const parts = [];
  const visibleCache = new Map();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const p = n.parentElement;
    if (!p || p.closest('script,style,template')) continue;
    if (!visibleCache.has(p)) visibleCache.set(p, isVisible(p));
    if (visibleCache.get(p)) parts.push(n.data);
  }
  return normalize(parts.join(' '));
}

/** True when `text` (string or RegExp) appears in the visible page text. */
export function pageHasText(root, text) {
  const body = visibleText(root);
  return text instanceof RegExp ? text.test(body) : body.toLowerCase().includes(normalize(text).toLowerCase());
}

/** True when some visible element's entire text equals `text` exactly. */
export function hasElementWithExactText(root, text) {
  const want = normalize(text);
  if (!want) return false;
  for (const el of root.querySelectorAll('*')) {
    if (normalize(el.textContent) === want && isVisible(el)) return true;
  }
  return false;
}
