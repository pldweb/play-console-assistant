import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  getByLabel, getButton, getSection, setTextValue, selectOption, setChecked, isChecked, collectValidationErrors,
  waitFor, accessibleName, setFileInput, getFieldValue,
} from '../../src/content/dom-utils.js';
import { installFilePolyfills } from '../helpers/fake-console.js';

function dom(body) {
  const d = new JSDOM(`<!doctype html><body>${body}</body>`, { url: 'https://play.google.com/console/' });
  installFilePolyfills(d.window);
  return d.window.document;
}

test('label lookups: for=, wrapping label, aria-label, aria-labelledby; required markers and counters ignored', () => {
  const doc = dom(`
    <label for="a">App name *</label><input id="a">
    <label>Website <input id="b"></label>
    <textarea id="c" aria-label="Full description 0/4000"></textarea>
    <span id="l">Short description</span><div role="textbox" contenteditable="true" id="d" aria-labelledby="l"></div>`);
  assert.equal(getByLabel(doc.body, 'App name').id, 'a');
  assert.equal(getByLabel(doc.body, 'Website').id, 'b');
  assert.equal(getByLabel(doc.body, 'Full description').id, 'c');
  assert.equal(getByLabel(doc.body, 'Short description').id, 'd');
});

test('missing and ambiguous fields throw classified errors', () => {
  const doc = dom('<label for="x">Email</label><input id="x"><label for="y">Email</label><input id="y">');
  assert.throws(() => getByLabel(doc.body, 'Phone'), (e) => e.code === 'ELEMENT_NOT_FOUND');
  assert.throws(() => getByLabel(doc.body, 'Email'), (e) => e.code === 'AMBIGUOUS_ELEMENT');
});

test('hidden elements are ignored', () => {
  const doc = dom('<div hidden><label for="x">Email</label><input id="x"></div><div style="display:none"><input aria-label="Email"></div><input aria-label="Email" id="v">');
  assert.equal(getByLabel(doc.body, 'Email').id, 'v');
});

test('setTextValue fires input/change events, supports framework-style listeners and verifies', () => {
  const doc = dom('<input aria-label="Title" id="t"><textarea aria-label="Notes"></textarea><div role="textbox" contenteditable="true" aria-label="Rich"></div>');
  const events = [];
  const t = doc.getElementById('t');
  t.addEventListener('input', (e) => events.push(`input:${e.target.value}`));
  t.addEventListener('change', () => events.push('change'));
  setTextValue(t, 'Hello');
  assert.deepEqual(events, ['input:Hello', 'change']);
  const ta = getByLabel(doc.body, 'Notes');
  setTextValue(ta, 'line1\nline2');
  assert.equal(ta.value, 'line1\nline2');
  const rich = getByLabel(doc.body, 'Rich');
  setTextValue(rich, 'Rich text');
  assert.equal(getFieldValue(rich), 'Rich text');
});

test('setTextValue detects values that do not stick and disabled fields', () => {
  const doc = dom('<input aria-label="Locked" disabled><input aria-label="Reverting" maxlength="3">');
  assert.throws(() => setTextValue(getByLabel(doc.body, 'Locked'), 'x'), (e) => e.code === 'ELEMENT_DISABLED');
  const rev = getByLabel(doc.body, 'Reverting');
  rev.addEventListener('input', () => { rev.value = rev.value.slice(0, 3); }); // app truncates
  assert.throws(() => setTextValue(rev, 'abcdef'), (e) => e.code === 'VALUE_NOT_APPLIED');
});

test('native select: by text, ambiguity, missing option', async () => {
  const doc = dom('<label for="c">Category</label><select id="c"><option value="">Pick</option><option value="p">Productivity</option><option value="t">Tools</option><option value="t2">Tools</option></select>');
  const sel = getByLabel(doc.body, 'Category', 'select');
  let changed = 0;
  sel.addEventListener('change', () => { changed += 1; });
  await selectOption(sel, 'Productivity');
  assert.equal(sel.value, 'p');
  assert.equal(changed, 1);
  await assert.rejects(selectOption(sel, 'Tools'), (e) => e.code === 'AMBIGUOUS_ELEMENT');
  await assert.rejects(selectOption(sel, 'Games'), (e) => e.code === 'ELEMENT_NOT_FOUND');
});

test('ARIA combobox with delayed options', async () => {
  const doc = dom(`<span id="l">Default language</span>
    <div role="combobox" tabindex="0" aria-labelledby="l" aria-controls="list" aria-expanded="false">English (United States) – en-US</div>
    <ul role="listbox" id="list"></ul>`);
  const combo = getByLabel(doc.body, 'Default language', 'select');
  combo.addEventListener('click', () => {
    setTimeout(() => {
      doc.getElementById('list').innerHTML = '<li role="option">Indonesian – id</li><li role="option">English (United States) – en-US</li>';
      for (const o of doc.querySelectorAll('[role=option]')) o.addEventListener('click', () => { combo.textContent = o.textContent; });
    }, 20);
  });
  const chosen = await selectOption(combo, /(^|[\s–-])id$/i);
  assert.equal(chosen, 'Indonesian – id');
  assert.equal(combo.textContent, 'Indonesian – id');
});

test('checkboxes and radios (native and ARIA)', () => {
  const doc = dom(`
    <label><input type="checkbox">I accept the policies</label>
    <div role="checkbox" aria-checked="false" aria-label="Custom box" tabindex="0"></div>
    <label><input type="radio" name="g">Free</label><label><input type="radio" name="g">Paid</label>`);
  const box = getByLabel(doc.body, /policies/i, 'checkbox');
  setChecked(box, true);
  assert.equal(box.checked, true);
  setChecked(box, true); // idempotent
  assert.equal(box.checked, true);
  const custom = getByLabel(doc.body, 'Custom box', 'checkbox');
  custom.addEventListener('click', () => custom.setAttribute('aria-checked', String(custom.getAttribute('aria-checked') !== 'true')));
  setChecked(custom, true);
  assert.equal(isChecked(custom), true);
  const paid = getByLabel(doc.body, 'Paid', 'radio');
  setChecked(paid, true);
  assert.equal(isChecked(getByLabel(doc.body, 'Free', 'radio')), false);
  const dead = doc.createElement('div');
  dead.setAttribute('role', 'checkbox');
  dead.setAttribute('aria-label', 'Dead');
  doc.body.appendChild(dead);
  assert.throws(() => setChecked(dead, true), (e) => e.code === 'VALUE_NOT_APPLIED');
});

test('buttons by exact text; sections by heading or label', () => {
  const doc = dom(`<button>Save</button><button>Save draft</button><div role="button" aria-disabled="true">Create app</div>
    <section aria-label="App icon"><h3>App icon</h3></section><section><h2>Phone screenshots</h2></section>`);
  assert.equal(getButton(doc.body, 'Save').textContent, 'Save');
  assert.equal(accessibleName(getButton(doc.body, /^Create app$/)), 'Create app');
  assert.ok(getSection(doc.body, 'App icon'));
  assert.ok(getSection(doc.body, 'Phone screenshots'));
  assert.throws(() => getSection(doc.body, 'Feature graphic'), (e) => e.code === 'ELEMENT_NOT_FOUND');
});

test('validation errors: role=alert and aria-invalid with describedby', () => {
  const doc = dom(`<div role="alert">Fix the errors below</div>
    <label for="e">Email</label><input id="e" aria-invalid="true" aria-describedby="e-err"><span id="e-err">Enter a valid email</span>
    <div role="alert" hidden>Old</div>`);
  const errs = collectValidationErrors(doc.body);
  assert.deepEqual(errs, [{ field: null, message: 'Fix the errors below' }, { field: 'Email', message: 'Enter a valid email' }]);
});

test('waitFor resolves on delayed rendering and times out with WAIT_TIMEOUT', async () => {
  const doc = dom('<main></main>');
  setTimeout(() => { doc.querySelector('main').innerHTML = '<h1>Ready</h1>'; }, 30);
  const h = await waitFor(() => doc.querySelector('h1'), { timeout: 1000, interval: 5 });
  assert.equal(h.textContent, 'Ready');
  await assert.rejects(waitFor(() => false, { timeout: 30, interval: 5, description: 'never' }), (e) => e.code === 'WAIT_TIMEOUT');
});

test('setFileInput attaches files and fires change; single inputs refuse multiple files', () => {
  const doc = dom('<input type="file" id="one"><input type="file" id="many" multiple>');
  const win = doc.defaultView;
  const f1 = new win.File(['a'], 'a.png', { type: 'image/png' });
  const f2 = new win.File(['b'], 'b.png', { type: 'image/png' });
  let changes = 0;
  doc.getElementById('many').addEventListener('change', () => { changes += 1; });
  setFileInput(doc.getElementById('many'), [f1, f2]);
  assert.equal(changes, 1);
  assert.equal(doc.getElementById('many').files.length, 2);
  assert.throws(() => setFileInput(doc.getElementById('one'), [f1, f2]), (e) => e.code === 'UPLOAD_FAILED');
});
