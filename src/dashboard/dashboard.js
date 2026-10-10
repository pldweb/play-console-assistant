/**
 * Dashboard: application list, progress, automation controls, approvals,
 * submission confirmation, recovery, import/export, logs and settings.
 */
import { createApplicationRepository } from '../data/application-repository.js';
import { createProgressRepository } from '../data/progress-repository.js';
import { createSettingsRepository, DEFAULT_SETTINGS } from '../data/settings-repository.js';
import { createAssetRepository } from '../data/asset-repository.js';
import { createLogger } from '../services/logger.js';
import { buildExport, planImport } from '../services/export-import.js';
import { sendToBackground } from '../services/messaging.js';
import { STATES, STAGES, STATE_LABELS, isRunningState } from '../automation/workflow-states.js';
import { STAGE_DEFINITIONS } from '../adapters/index.js';
import { fieldLabel } from '../data/schema.js';
import { h, clear, announce, formatTime, confirmDialog, downloadBlob, STATE_BADGE } from '../services/ui.js';

const apps = createApplicationRepository();
const progressRepo = createProgressRepository();
const settingsRepo = createSettingsRepository();
const assetRepo = createAssetRepository();
const logger = createLogger();

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const notify = (t, k = 'info') => announce(statusEl, t, k);

let all = [];
let progressById = new Map();
let selectedId = new URLSearchParams(location.search).get('app') || null;
let tabs = [];

// ------------------------------------------------------------------ tabs
function selectedTabId() {
  const v = $('tab-select').value;
  return v ? Number(v) : null;
}

async function refreshTabs() {
  try {
    tabs = await sendToBackground({ type: 'TAB_LIST' });
  } catch (e) {
    tabs = [];
    notify(`Could not list tabs: ${e.message}`, 'error');
  }
  const sel = $('tab-select');
  const prev = sessionStorage.getItem('pca-tab');
  clear(sel, tabs.length ? null : h('option', { value: '' }, 'No Play Console tab open'),
    tabs.map((t) => h('option', { value: String(t.id) }, `${t.title || 'Play Console'} — ${t.url.replace('https://play.google.com', '')}`)));
  if (prev && tabs.some((t) => String(t.id) === prev)) sel.value = prev;
  await describeTab();
}

async function describeTab() {
  const id = selectedTabId();
  sessionStorage.setItem('pca-tab', id ? String(id) : '');
  if (!id) { clear($('tab-info'), 'Open Play Console, sign in, then press Refresh.'); return; }
  const page = await sendToBackground({ type: 'TAB_DETECT', tabId: id }).catch(() => null);
  if (!page) { clear($('tab-info'), 'The extension cannot read this tab yet. Reload the Play Console tab, then press Refresh.'); return; }
  const linked = all.find((a) => page.appId && a.playConsole.appId === page.appId);
  clear($('tab-info'),
    `Detected page: ${page.pageType}${page.ready ? '' : ' (still loading)'}`,
    page.developerId ? ` · developer ${page.developerId}` : '',
    page.appId ? ` · Play Console app ${page.appId}` : '',
    linked ? ` · linked to “${linked.metadata.appName}”` : page.appId ? ' · not linked to any record' : '');
}

// --------------------------------------------------------------- loading
async function loadAll() {
  all = await apps.list();
  const entries = await Promise.all(all.map(async (a) => [a.id, await progressRepo.get(a.id)]));
  progressById = new Map(entries);
  renderFilter();
  renderSummary();
  renderList();
  await renderDetail();
}

function renderFilter() {
  const sel = $('filter');
  const cur = sel.value;
  clear(sel, h('option', { value: '' }, 'All statuses'), Object.values(STATES).map((s) => h('option', { value: s }, STATE_LABELS[s])));
  sel.value = cur;
}

function renderSummary() {
  const counts = new Map();
  for (const a of all) counts.set(a.workflow.state, (counts.get(a.workflow.state) || 0) + 1);
  const stat = (label, n) => h('div', { class: 'stat' }, h('strong', {}, String(n)), label);
  clear($('summary'),
    stat('Applications', all.length),
    [...counts.entries()].map(([s, n]) => stat(STATE_LABELS[s], n)));
}

function badge(state) {
  return h('span', { class: `badge ${STATE_BADGE[state] || ''}` }, STATE_LABELS[state]);
}

function renderList() {
  const q = $('search').value.trim().toLowerCase();
  const f = $('filter').value;
  const shown = all.filter((a) => (!f || a.workflow.state === f)
    && (!q || a.metadata.appName.toLowerCase().includes(q) || a.metadata.packageName.toLowerCase().includes(q)));
  $('empty').hidden = all.length > 0;
  clear($('app-rows'), shown.map((a) => h('tr', { class: a.id === selectedId ? 'selected' : '' },
    h('td', {}, h('a', { href: `?app=${encodeURIComponent(a.id)}`, onclick: (e) => { e.preventDefault(); select(a.id); } }, a.metadata.appName || '(untitled)'),
      h('div', { class: 'pkg' }, a.metadata.packageName || 'no package name')),
    h('td', {}, badge(a.workflow.state)),
    h('td', { class: 'small' }, formatTime(a.updatedAt)),
    h('td', {}, h('div', { class: 'row-actions' },
      h('a', { class: 'button', href: `../form/application-form.html?id=${encodeURIComponent(a.id)}` }, 'Edit'),
      h('button', { type: 'button', onclick: () => duplicate(a) }, 'Duplicate'),
      h('button', { type: 'button', class: 'danger', onclick: () => remove(a) }, 'Delete'))))));
}

function select(id) {
  selectedId = id;
  history.replaceState(null, '', `?app=${encodeURIComponent(id)}`);
  renderList();
  renderDetail();
}

// ------------------------------------------------------------ list actions
async function duplicate(a) {
  const box = h('input', { type: 'checkbox', id: 'dup-decl' });
  const ok = await confirmDialog({
    title: `Duplicate “${a.metadata.appName}”?`,
    message: 'Creates a new draft with the same listing text. Package name, Play Console link, files and progress are not copied.',
    details: h('label', { class: 'inline', for: 'dup-decl' }, box, 'Also copy app-content answers — I confirm they are true for the new app'),
    confirmLabel: 'Duplicate',
  });
  if (!ok) return;
  const copy = await apps.duplicate(a.id, { copyDeclarations: box.checked });
  notify(`Created “${copy.metadata.appName}”. Set its package name and files before starting.`, 'ok');
  await loadAll();
  select(copy.id);
}

async function remove(a) {
  const lock = await sendToBackground({ type: 'ACTIVE_STATUS' }).catch(() => ({ lock: null }));
  if (lock.lock && lock.lock.appId === a.id) { notify('Stop the automation for this app before deleting it.', 'error'); return; }
  const ok = await confirmDialog({
    title: 'Delete application?',
    message: `This deletes “${a.metadata.appName}”, its stored files, progress and logs from this browser. Nothing is changed in Play Console.`,
    confirmLabel: 'Delete', danger: true, requireText: a.metadata.appName || 'DELETE',
  });
  if (!ok) return;
  await apps.remove(a.id);
  await progressRepo.remove(a.id);
  await assetRepo.removeForApp(a.id);
  await logger.clear(a.id);
  if (selectedId === a.id) selectedId = null;
  notify('Application deleted.', 'ok');
  await loadAll();
}

// ----------------------------------------------------------------- detail
async function engine(type, extra = {}) {
  try {
    return await sendToBackground({ type, appId: selectedId, ...extra });
  } catch (e) {
    notify(e.message, 'error');
    return null;
  }
}

function needTab() {
  const id = selectedTabId();
  if (!id) notify('Select the Play Console tab to use (open Play Console and press Refresh).', 'error');
  return id;
}

function stageList(app, progress) {
  const done = new Set(STAGES.filter((s, i) => {
    const idx = STAGES.findIndex((x) => x.id === app.workflow.lastCompletedStage);
    return idx >= 0 && i <= idx;
  }).map((s) => s.id));
  return h('ol', { class: 'stages' }, STAGES.map((s) => {
    const steps = STAGE_DEFINITIONS[s.id].steps;
    const completed = progress.completedSteps[s.id] || [];
    const isCurrent = progress.stage === s.id && !done.has(s.id);
    const mark = done.has(s.id) ? '✓' : isCurrent ? '▶' : '·';
    return h('li', {}, h('span', { class: 'mark', 'aria-hidden': 'true' }, mark),
      h('span', {}, s.label, done.has(s.id) ? h('span', { class: 'sr-only' }, ' (done)') : '',
        isCurrent ? h('span', { class: 'muted small' }, ` — ${completed.length}/${steps.length} steps verified`) : ''));
  }));
}

function reportTable(report) {
  if (!report || !report.fields || !report.fields.length) return null;
  const fmt = (v) => (v === undefined || v === null ? '—' : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));
  return h('div', { class: 'table-wrap' }, h('table', { class: 'report' },
    h('thead', {}, h('tr', {}, h('th', {}, 'Field'), h('th', {}, 'Found'), h('th', {}, 'Current'), h('th', {}, 'Will set'))),
    h('tbody', {}, report.fields.map((f) => h('tr', {},
      h('td', {}, f.label),
      h('td', {}, f.status === 'found' ? 'yes' : f.status),
      h('td', {}, h('pre', {}, fmt(f.current))),
      h('td', { class: f.willChange ? 'change' : '' }, f.status === 'skipped' ? 'not changed' : f.willChange ? h('pre', {}, fmt(f.planned)) : 'already correct'))))));
}

function requiredActionBox(app, progress) {
  const ra = progress.requiredAction;
  if (!ra && !app.workflow.errorMessage) return null;
  const tabId = () => needTab();
  const parts = [];
  if (app.workflow.errorMessage) parts.push(h('p', {}, h('strong', {}, app.workflow.errorCode ? `${app.workflow.errorCode}: ` : ''), app.workflow.errorMessage));
  if (ra && ra.hint) parts.push(h('p', { class: 'small' }, 'Next: ', ra.hint));
  if (ra && ra.type === 'FIX_DATA' && ra.errors) {
    parts.push(h('ul', {}, ra.errors.slice(0, 20).map((e) => h('li', { class: 'small' }, `${fieldLabel(e.path)}: ${e.message}`))));
  }
  if (ra && ra.report) {
    if (ra.report.blocking && ra.report.blocking.length) parts.push(h('ul', {}, ra.report.blocking.map((b) => h('li', { class: 'small' }, b.message))));
    if (ra.report.notes && ra.report.notes.length) parts.push(h('ul', { class: 'muted small' }, ra.report.notes.map((n) => h('li', {}, n))));
    parts.push(reportTable(ra.report));
  }
  if (ra && ra.mismatches) parts.push(h('ul', {}, ra.mismatches.map((m) => h('li', { class: 'small' }, m.message))));
  const buttons = [];
  if (ra && ra.type === 'APPROVE_PLAN') {
    buttons.push(h('button', { type: 'button', class: 'primary', onclick: async () => { const t = tabId(); if (t) await engine('ENGINE_APPROVE_PLAN', { planHash: ra.planHash, tabId: t }); } }, 'Approve these changes and continue'));
  }
  if (ra && (ra.type === 'LINK_OR_ALLOW_DUPLICATE' || ra.type === 'LINK_OR_RESET')) {
    buttons.push(h('button', { type: 'button', onclick: async () => {
      const t = tabId(); if (!t) return;
      const ok = await confirmDialog({ title: 'Link to the app open in the tab?', message: `The record “${app.metadata.appName}” will be linked to the Play Console app currently open in the automation tab. Make sure it is the right app.`, confirmLabel: 'Link' });
      if (ok && await engine('ENGINE_LINK_CURRENT_APP', { tabId: t })) notify('Linked. Press Resume to continue.', 'ok');
    } }, 'Link app open in tab'));
  }
  if (ra && ra.type === 'LINK_OR_ALLOW_DUPLICATE') {
    buttons.push(h('button', { type: 'button', class: 'danger', onclick: async () => {
      const t = tabId(); if (!t) return;
      const ok = await confirmDialog({ title: 'Create another app with the same name?', message: 'Only do this if the existing app is a different product. Play Console allows duplicate names; the extension will not check again.', confirmLabel: 'Create anyway', danger: true, requireText: app.metadata.appName });
      if (ok) await engine('ENGINE_ALLOW_DUPLICATE', { tabId: t });
    } }, 'Create a new app anyway'));
  }
  return h('div', { class: `notice ${app.workflow.state === STATES.FAILED ? 'danger' : 'warn'}`, role: 'status' }, parts, buttons.length ? h('div', { class: 'row' }, buttons) : null);
}

function readinessBox(progress) {
  const r = progress.readiness;
  if (!r) return null;
  const po = r['publishing-overview'];
  const dt = r['dashboard-tasks'];
  return h('div', {},
    h('h3', {}, 'Readiness (as read from Play Console)'),
    h('p', { class: 'small muted' }, `Checked ${formatTime(r.checkedAt)}`),
    po ? h('dl', { class: 'kv' },
      h('dt', {}, 'Errors'), h('dd', {}, po.errors.length ? po.errors.join('; ') : 'none'),
      h('dt', {}, 'Warnings'), h('dd', {}, po.warnings.length ? po.warnings.join('; ') : 'none'),
      h('dt', {}, 'Send action'), h('dd', {}, po.sendLabel || 'not available'),
      h('dt', {}, 'Testing requirement'), h('dd', {}, po.testingGate ? 'Play Console mentions the closed-testing requirement for production access.' : 'not mentioned')) : null,
    dt ? h('p', { class: 'small' }, `Open dashboard tasks: ${dt.outstandingTasks && dt.outstandingTasks.length ? dt.outstandingTasks.join(', ') : 'none'}`) : null);
}

function submissionBox(app, progress) {
  if (app.workflow.state !== STATES.SUBMISSION_CONFIRMATION_REQUIRED) return null;
  const input = h('input', { id: 'confirm-name', autocomplete: 'off', 'aria-describedby': 'confirm-help' });
  const send = h('button', { type: 'button', class: 'danger', disabled: true }, 'Send this app for review');
  input.addEventListener('input', () => { send.disabled = input.value.trim() !== app.metadata.appName; });
  send.addEventListener('click', async () => {
    const t = needTab(); if (!t) return;
    const ok = await confirmDialog({
      title: 'Final confirmation',
      message: `Send “${app.metadata.appName}” (${app.metadata.packageName}, Play Console app ${app.playConsole.appId}) for Google Play review now? This cannot be undone from the extension.`,
      confirmLabel: 'Send for review', danger: true,
    });
    if (!ok) return;
    if (await engine('ENGINE_CONFIRM_SUBMISSION', { typedName: input.value.trim(), tabId: t })) notify('Submission started. The status is verified on the page before it is marked submitted.', 'ok');
  });
  return h('div', { class: 'notice warn' },
    h('h3', {}, 'Submission needs your confirmation'),
    h('p', {}, 'Review the readiness summary above and the app in Play Console. Nothing has been sent for review.'),
    h('label', { for: 'confirm-name' }, `Type the app name “${app.metadata.appName}” to enable sending`),
    h('p', { id: 'confirm-help', class: 'hint' }, 'The confirmation is valid once, for this app and the selected tab, for 5 minutes.'),
    input,
    h('div', { class: 'row', style: 'margin-top:.5rem' }, send,
      h('button', { type: 'button', onclick: () => engine('ENGINE_CANCEL_SUBMISSION') }, 'Cancel (do not submit)')));
}

async function renderDetail() {
  const body = $('detail-body');
  const app = all.find((a) => a.id === selectedId);
  if (!app) { $('detail-title').textContent = 'Select an application'; clear(body, 'Choose an app from the list to see its progress and controls.'); return; }
  body.className = '';
  const progress = progressById.get(app.id) || await progressRepo.get(app.id);
  const status = await sendToBackground({ type: 'ENGINE_STATUS', appId: app.id }).catch(() => null);
  const running = Boolean(status && status.running);
  const s = app.workflow.state;
  $('detail-title').textContent = app.metadata.appName || '(untitled)';

  const controls = [];
  const startLike = (type, label, cls = 'primary') => h('button', { type: 'button', class: cls, onclick: async () => { const t = needTab(); if (!t) return; const r = await engine(type, { tabId: t }); if (r && r.validation && !r.validation.valid) notify('Data is incomplete — see the list below.', 'error'); } }, label);
  if (running) {
    controls.push(h('button', { type: 'button', onclick: () => engine('ENGINE_PAUSE') }, 'Pause'));
    controls.push(h('button', { type: 'button', onclick: () => engine('ENGINE_STOP') }, 'Stop after current action'));
  } else if (s === STATES.DRAFT || s === STATES.READY_TO_START) {
    controls.push(startLike('ENGINE_START', 'Validate and start'));
  } else if ([STATES.PAUSED, STATES.NEEDS_USER_ACTION, STATES.FAILED].includes(s) || (isRunningState(s) && !running)
    || [STATES.APP_CREATED, STATES.STORE_LISTING_COMPLETED, STATES.APP_CONTENT_COMPLETED, STATES.RELEASE_READY, STATES.READY_FOR_REVIEW].includes(s)) {
    controls.push(startLike('ENGINE_RESUME', 'Resume'));
    if (s !== STATES.PAUSED) controls.push(h('button', { type: 'button', onclick: () => engine('ENGINE_PAUSE') }, 'Pause'));
  }
  controls.push(h('a', { class: 'button', href: `../form/application-form.html?id=${encodeURIComponent(app.id)}` }, 'Edit data'));

  const resetControls = running || s === STATES.DRAFT || s === STATES.SUBMITTED ? null : h('details', {},
    h('summary', {}, 'Recovery'),
    h('p', { class: 'small' }, 'Use when the saved progress no longer matches Play Console. The link to the Play Console app and the record of clicks already made are kept, so nothing is created twice.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', onclick: async () => {
        if (await confirmDialog({ title: 'Reset to last checkpoint?', message: 'Partial progress of the current stage is discarded; that stage is re-checked from its first step.', confirmLabel: 'Reset' })) engine('ENGINE_RESET', { mode: 'checkpoint' });
      } }, 'Reset to last checkpoint'),
      h('button', { type: 'button', class: 'danger', onclick: async () => {
        if (await confirmDialog({ title: 'Reset to draft?', message: 'All recorded progress for this app is cleared. Every stage will be inspected again on the next start.', confirmLabel: 'Reset to draft', danger: true, requireText: app.metadata.appName || 'RESET' })) engine('ENGINE_RESET', { mode: 'draft' });
      } }, 'Reset to draft')));

  const logs = await logger.list({ appId: app.id, limit: 60 });
  clear(body,
    h('div', { class: 'row' }, badge(s), running ? h('span', { class: 'badge accent' }, 'running') : null),
    h('dl', { class: 'kv' },
      h('dt', {}, 'Package'), h('dd', {}, app.metadata.packageName || '—'),
      h('dt', {}, 'Play Console app'), h('dd', {}, app.playConsole.appId ? `${app.playConsole.appId} (developer ${app.playConsole.developerId})` : 'not linked yet'),
      h('dt', {}, 'Last verified'), h('dd', {}, formatTime(app.workflow.lastVerifiedAt)),
      h('dt', {}, 'Attempts'), h('dd', {}, String(progress.attempts || 0))),
    h('div', { class: 'row' }, controls),
    h('p', { class: 'hint' }, 'States shown here are the extension\'s own progress, not Google Play statuses.'),
    requiredActionBox(app, progress),
    h('h3', {}, 'Stages'),
    stageList(app, progress),
    readinessBox(progress),
    submissionBox(app, progress),
    resetControls,
    h('details', {}, h('summary', {}, `Log (${logs.length})`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'log-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Stage'), h('th', {}, 'Action'), h('th', {}, 'Outcome'), h('th', {}, 'Details'))),
        h('tbody', {}, [...logs].reverse().map((l) => h('tr', {},
          h('td', {}, formatTime(l.ts)), h('td', {}, l.stage || ''), h('td', {}, l.action), h('td', {}, l.outcome),
          h('td', {}, [l.errorCode, l.message].filter(Boolean).join(' — ')))))))));
}

// --------------------------------------------------------- import/export
async function doExport() {
  const data = buildExport(await apps.list());
  downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `play-console-assistant-${new Date().toISOString().slice(0, 10)}.json`);
  notify(`Exported ${data.applications.length} application(s). Files (images, bundles) are not included in the backup.`, 'ok');
}

async function doImport(file) {
  const plan = planImport(await file.text(), await apps.list());
  if (!plan.ok) { notify(`Import refused: ${plan.error}`, 'error'); return; }
  const lock = await sendToBackground({ type: 'ACTIVE_STATUS' }).catch(() => ({ lock: null }));
  if (lock.lock && plan.toOverwrite.some((a) => a.id === lock.lock.appId)) { notify('Import would overwrite the app being automated. Stop it first.', 'error'); return; }
  const details = h('div', {},
    h('ul', {},
      h('li', {}, `${plan.toAdd.length} new application(s)`),
      h('li', {}, `${plan.toOverwrite.length} existing application(s) will be OVERWRITTEN: ${plan.toOverwrite.map((a) => a.metadata.appName).join(', ') || '—'}`),
      h('li', {}, `${plan.invalid.length} invalid record(s) will be skipped`)),
    plan.packageConflicts.length ? h('p', { class: 'error-text' }, `Package names used by more than one record: ${plan.packageConflicts.map((c) => c.packageName).join(', ')}. Resolve this after import.`) : null,
    h('p', { class: 'small' }, 'Imported records start as drafts and have no files; select each app\'s asset folder again.'));
  const ok = await confirmDialog({
    title: 'Import applications?', message: 'Review what will change:', details, confirmLabel: 'Import',
    danger: plan.toOverwrite.length > 0, requireText: plan.toOverwrite.length ? 'OVERWRITE' : null,
  });
  if (!ok) return;
  for (const a of [...plan.toAdd, ...plan.toOverwrite]) {
    if (plan.toOverwrite.includes(a)) { await progressRepo.remove(a.id); await assetRepo.removeForApp(a.id); }
    await apps.save(a);
  }
  notify(`Imported ${plan.toAdd.length + plan.toOverwrite.length} application(s).`, 'ok');
  await loadAll();
}

// ----------------------------------------------------------------- settings
async function renderSettings() {
  const s = await settingsRepo.get();
  const f = $('settings-form');
  f.requirePlanApproval.checked = s.requirePlanApproval;
  for (const k of ['retryLimit', 'stepTimeoutMs', 'navigationTimeoutMs', 'bundleProcessingTimeoutMs', 'consoleUserIndex']) f[k].value = s[k];
  clear($('conventions'), Object.entries(s.filenameConventions).map(([k, v]) => h('div', {},
    h('label', { for: `conv-${k}` }, k), h('input', { id: `conv-${k}`, 'data-conv': k, value: v, spellcheck: 'false' }))));
}

async function saveSettings(e) {
  e.preventDefault();
  const f = $('settings-form');
  const conv = Object.fromEntries([...f.querySelectorAll('[data-conv]')].map((i) => [i.dataset.conv, i.value]));
  try {
    await settingsRepo.set({
      requirePlanApproval: f.requirePlanApproval.checked,
      retryLimit: Number(f.retryLimit.value),
      stepTimeoutMs: Number(f.stepTimeoutMs.value),
      navigationTimeoutMs: Number(f.navigationTimeoutMs.value),
      bundleProcessingTimeoutMs: Number(f.bundleProcessingTimeoutMs.value),
      consoleUserIndex: Number(f.consoleUserIndex.value),
      filenameConventions: conv,
    });
    notify('Settings saved.', 'ok');
    renderSettings();
  } catch (err) {
    notify(err.message, 'error');
  }
}

// ------------------------------------------------------------------ wiring
$('search').addEventListener('input', renderList);
$('filter').addEventListener('change', renderList);
$('tabs-refresh').addEventListener('click', refreshTabs);
$('tab-select').addEventListener('change', describeTab);
$('open-console').addEventListener('click', async () => { await sendToBackground({ type: 'TAB_OPEN_CONSOLE' }); setTimeout(refreshTabs, 1500); });
$('export-btn').addEventListener('click', doExport);
$('import-btn').addEventListener('click', () => $('import-input').click());
$('import-input').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await doImport(f); });
$('settings-btn').addEventListener('click', () => {
  const p = $('settings-panel');
  p.hidden = !p.hidden;
  $('settings-btn').setAttribute('aria-expanded', String(!p.hidden));
  if (!p.hidden) renderSettings();
});
$('settings-form').addEventListener('submit', saveSettings);
$('settings-reset').addEventListener('click', async () => {
  if (await confirmDialog({ title: 'Restore default settings?', message: 'Timeouts, retries, approval and filename conventions return to their defaults.', confirmLabel: 'Restore' })) {
    await settingsRepo.set({ ...DEFAULT_SETTINGS });
    renderSettings();
  }
});

let pending = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!Object.keys(changes).some((k) => k.startsWith('app:') || k.startsWith('progress:') || k === 'logs')) return;
  clearTimeout(pending);
  pending = setTimeout(loadAll, 150);
});

loadAll().then(refreshTabs);
