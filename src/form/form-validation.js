/**
 * Form <-> application model binding and inline validation messages.
 * Inputs declare their model path with data-path; error slots declare
 * data-error-for. Unanswered tri-state answers map to null, never false.
 */
import { validateApplication, charLength, APP_CATEGORIES, GAME_CATEGORIES } from '../data/schema.js';

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys[keys.length - 1]] = value;
}

function parseValue(input) {
  const type = input.dataset.type;
  if (type === 'int') {
    const t = input.value.trim();
    if (t === '') return null;
    return /^\d+$/.test(t) ? Number(t) : Number.NaN;
  }
  if (type === 'nullable-bool') return input.value === '' ? null : input.value === 'yes';
  if (type === 'nullable') return input.value === '' ? null : input.value;
  return input.value;
}

/** Copies form values onto a clone of `app`. */
export function readForm(form, app) {
  const next = structuredClone(app);
  for (const input of form.querySelectorAll('[data-path]')) {
    const path = input.dataset.path;
    if (input.type === 'radio') {
      if (input.checked) setPath(next, path, parseValue(input));
    } else if (input.type === 'checkbox') {
      // Ticked = explicit true; unticked = not answered (null).
      setPath(next, path, input.dataset.tristate === 'true-or-null' ? (input.checked ? true : null) : input.checked);
    } else {
      const v = parseValue(input);
      setPath(next, path, typeof v === 'string' && input.tagName !== 'TEXTAREA' ? v.trim() : v);
    }
  }
  return next;
}

export function fillCategoryOptions(select, appOrGame, current) {
  const cats = appOrGame === 'game' ? GAME_CATEGORIES : APP_CATEGORIES;
  select.replaceChildren(new Option('— Select —', ''), ...cats.map((c) => new Option(c, c)));
  if (current && !cats.includes(current)) select.append(new Option(`${current} (not valid for ${appOrGame})`, current));
  select.value = current || '';
}

export function fillForm(form, app) {
  fillCategoryOptions(form.querySelector('[data-path="storeListing.category"]'), app.metadata.appOrGame, app.storeListing.category);
  for (const input of form.querySelectorAll('[data-path]')) {
    const v = getPath(app, input.dataset.path);
    if (input.type === 'radio') {
      const type = input.dataset.type;
      const repr = type === 'nullable-bool' ? (v === null || v === undefined ? '' : v ? 'yes' : 'no') : (v === null || v === undefined ? '' : String(v));
      input.checked = input.value === repr;
    } else if (input.type === 'checkbox') {
      input.checked = v === true;
    } else {
      input.value = v === null || v === undefined ? '' : String(v);
    }
  }
  updateCounters(form);
}

export function updateCounters(form) {
  for (const input of form.querySelectorAll('[data-max]')) {
    const counter = form.querySelector(`[data-counter-for="${input.dataset.path}"]`);
    if (!counter) continue;
    const n = charLength(input.value);
    const max = Number(input.dataset.max);
    counter.textContent = `${n}/${max}`;
    counter.classList.toggle('over', n > max);
  }
}

/** Shows errors/warnings next to fields. Returns the list for a summary. */
export function showValidation(form, result) {
  for (const slot of form.querySelectorAll('[data-error-for]')) slot.textContent = '';
  for (const input of form.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');
  const unplaced = [];
  const place = (item, isError) => {
    const slot = form.querySelector(`[data-error-for="${item.path}"]`) || form.querySelector(`[data-error-for="${item.path.replace(/\[\d+\]$/, '')}"]`);
    if (!slot) { unplaced.push(item); return; }
    slot.textContent = slot.textContent ? `${slot.textContent} ${item.message}` : item.message;
    if (isError) {
      const input = form.querySelector(`[data-path="${item.path}"]`);
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        if (slot.id === '') slot.id = `err-${item.path.replace(/\W/g, '-')}`;
        input.setAttribute('aria-describedby', slot.id);
      }
    }
  };
  result.errors.forEach((e) => place(e, true));
  result.warnings.forEach((w) => place(w, false));
  return unplaced;
}

export function validate(app, level) {
  // A non-numeric version code arrives as NaN and fails validateVersionCode.
  return validateApplication(app, { level });
}
