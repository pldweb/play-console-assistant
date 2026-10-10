/**
 * Application form page: create or edit one application record.
 * URL: application-form.html?id=<appId>  (no id = new application)
 */
import { createApplicationRepository } from '../data/application-repository.js';
import { createAssetRepository } from '../data/asset-repository.js';
import { createSettingsRepository } from '../data/settings-repository.js';
import { createApplication, fieldLabel } from '../data/schema.js';
import { STATE_LABELS, EDITABLE_STATES } from '../automation/workflow-states.js';
import { readForm, fillForm, updateCounters, showValidation, validate, fillCategoryOptions } from './form-validation.js';
import { createAssetMapper } from './asset-mapper.js';
import { h, clear, announce, STATE_BADGE } from '../services/ui.js';

const apps = createApplicationRepository();
const assetRepo = createAssetRepository();
const settingsRepo = createSettingsRepository();

const form = document.getElementById('app-form');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const titleEl = document.getElementById('form-title');
const badgeEl = document.getElementById('state-badge');
const lockNote = document.getElementById('lock-note');

const COMMON_LANGS = ['en-US', 'en-GB', 'id', 'ms', 'th', 'vi', 'fil', 'es-ES', 'es-419', 'pt-BR', 'pt-PT', 'fr-FR', 'de-DE', 'it-IT', 'ja-JP', 'ko-KR', 'zh-CN', 'zh-TW', 'hi-IN', 'ar', 'ru-RU', 'tr-TR'];
document.getElementById('lang-list').append(...COMMON_LANGS.map((c) => h('option', { value: c })));

let app = null;
let isNew = false;
let dirty = false;

function notify(text, kind = 'info') { announce(statusEl, text, kind); }

function setEditable(editable) {
  for (const el of form.elements) el.disabled = !editable;
  lockNote.hidden = editable;
}

function renderHeader() {
  titleEl.textContent = isNew ? 'New application' : app.metadata.appName || 'Untitled application';
  badgeEl.textContent = STATE_LABELS[app.workflow.state];
  badgeEl.className = `badge ${STATE_BADGE[app.workflow.state] || ''}`;
  document.title = `${titleEl.textContent} · Play Console Assistant`;
}

function renderSummary(result, level) {
  const unplaced = showValidation(form, result);
  if (result.valid && level === 'ready') {
    clear(summaryEl, h('div', { class: 'notice ok' }, 'All required data for automation is present.', result.warnings.length ? ` ${result.warnings.length} warning(s) shown next to the fields.` : ''));
    return;
  }
  if (result.valid) { clear(summaryEl); return; }
  clear(summaryEl, h('div', { class: 'notice danger', role: 'alert' },
    h('strong', {}, `${result.errors.length} problem(s) ${level === 'ready' ? 'before automation can start' : 'must be fixed before saving'}:`),
    h('ul', {}, result.errors.map((e) => {
      const target = form.querySelector(`[data-path="${e.path}"]`);
      const text = `${fieldLabel(e.path)}: ${e.message}`;
      return h('li', {}, target ? h('a', { href: `#${target.id || ''}`, onclick: (ev) => { ev.preventDefault(); target.focus(); } }, text) : text);
    })),
    unplaced.length ? h('p', { class: 'small' }, 'Asset problems are listed in the Assets section.') : null));
}

async function save({ quiet = false } = {}) {
  const next = readForm(form, app);
  const result = validate(next, 'structure');
  renderSummary(result, 'structure');
  if (!result.valid) { notify('Not saved: fix the highlighted fields.', 'error'); return null; }
  try {
    const saved = await apps.saveUserEdits(next);
    app = saved;
    if (isNew) {
      isNew = false;
      history.replaceState(null, '', `?id=${encodeURIComponent(app.id)}`);
    }
    dirty = false;
    renderHeader();
    if (!quiet) notify('Saved.', 'ok');
    return saved;
  } catch (e) {
    notify(`Not saved: ${e.message}`, 'error');
    return null;
  }
}

async function init() {
  const id = new URLSearchParams(location.search).get('id');
  if (id) {
    app = await apps.get(id);
    if (!app) { notify('This application no longer exists.', 'error'); form.hidden = true; return; }
  } else {
    app = createApplication();
    isNew = true;
  }
  fillForm(form, app);
  renderHeader();
  setEditable(EDITABLE_STATES.includes(app.workflow.state));
  if (app.workflow.state === 'SUBMITTED') notify('This app has been submitted. Changes here do not affect Play Console.', 'warn');

  form.addEventListener('input', () => { dirty = true; updateCounters(form); });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'appOrGame') {
      fillCategoryOptions(form.querySelector('[data-path="storeListing.category"]'), e.target.value, form.querySelector('[data-path="storeListing.category"]').value);
    }
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  document.getElementById('validate-btn').addEventListener('click', () => {
    const r = validate(readForm(form, app), 'ready');
    renderSummary(r, 'ready');
    summaryEl.scrollIntoView({ block: 'nearest' });
  });
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  createAssetMapper({
    container: document.getElementById('asset-mapper'),
    assetRepo,
    settingsRepo,
    notify,
    getApp: () => readForm(form, app),
    applyAssets: async (patch) => {
      // Assets belong to a saved record: save the form first.
      if (isNew || dirty) {
        const s = await save({ quiet: true });
        if (!s) throw new Error('fix the form errors first');
      }
      const next = readForm(form, app);
      next.assets = { ...next.assets, ...patch.assets };
      next.release = { ...next.release, ...patch.release };
      const saved = await apps.saveUserEdits(next);
      app = saved;
      fillForm(form, app);
      dirty = false;
      return saved;
    },
  });

  // Keep the state badge and lock in sync with the engine.
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area !== 'local' || !app || !changes[`app:${app.id}`]) return;
    const fresh = changes[`app:${app.id}`].newValue;
    if (!fresh) { notify('This application was deleted.', 'error'); setEditable(false); return; }
    app = { ...app, workflow: fresh.workflow, playConsole: fresh.playConsole };
    renderHeader();
    setEditable(EDITABLE_STATES.includes(app.workflow.state));
  });
}

init();
