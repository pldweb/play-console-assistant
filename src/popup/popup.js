/**
 * Popup: detection status of the active tab, the app being automated,
 * its stage, quick controls and the next action. Editing happens in the
 * dashboard.
 */
import { createApplicationRepository } from '../data/application-repository.js';
import { createProgressRepository } from '../data/progress-repository.js';
import { sendToBackground } from '../services/messaging.js';
import { STATE_LABELS, STATES, getStage, isRunningState } from '../automation/workflow-states.js';
import { h, clear, announce } from '../services/ui.js';

const apps = createApplicationRepository();
const progressRepo = createProgressRepository();
const $ = (id) => document.getElementById(id);

document.getElementById('open-dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
  window.close();
});

async function act(type, appId, tabId) {
  try {
    await sendToBackground({ type, appId, ...(tabId ? { tabId } : {}) });
    await render();
  } catch (e) {
    announce($('message'), e.message, 'error');
  }
}

async function render() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // tab.url is only visible on Play Console (host permission scope).
  const onConsole = Boolean(tab && tab.url && tab.url.startsWith('https://play.google.com/console/'));
  const page = onConsole ? await sendToBackground({ type: 'TAB_DETECT', tabId: tab.id }).catch(() => null) : null;
  const { lock } = await sendToBackground({ type: 'ACTIVE_STATUS' }).catch(() => ({ lock: null }));
  const all = await apps.list();

  // Which app? The one being automated, else the one linked to this page.
  let app = lock ? all.find((a) => a.id === lock.appId) : null;
  if (!app && page && page.appId) app = all.find((a) => a.playConsole.appId === page.appId) || null;

  $('page').textContent = !onConsole ? 'Not a Play Console tab' : page ? `${page.pageType}${page.ready ? '' : ' (loading)'}` : 'Play Console (not readable yet — reload the tab)';
  $('app').textContent = app ? `${app.metadata.appName} · ${app.metadata.packageName || 'no package'}` : page && page.appId ? `Play Console app ${page.appId} (not linked)` : '—';
  const progress = app ? await progressRepo.get(app.id) : null;
  $('stage').textContent = app ? `${STATE_LABELS[app.workflow.state]}${progress && progress.stage && getStage(progress.stage) ? ` — ${getStage(progress.stage).label}` : ''}` : '—';

  const msgs = [];
  if (page && page.appId && app && app.playConsole.appId && page.appId !== app.playConsole.appId) {
    msgs.push(h('div', { class: 'notice warn' }, 'This tab shows a different app than the one being automated.'));
  }
  if (app && app.workflow.errorMessage) msgs.push(h('div', { class: 'notice danger' }, app.workflow.errorMessage));
  if (progress && progress.requiredAction && progress.requiredAction.hint) msgs.push(h('div', { class: 'notice' }, 'Next: ', progress.requiredAction.hint));
  clear($('message'), msgs);

  const controls = [];
  if (app) {
    const running = Boolean(lock && lock.appId === app.id);
    const s = app.workflow.state;
    const tabOk = onConsole && tab;
    if (running) {
      controls.push(h('button', { type: 'button', onclick: () => act('ENGINE_PAUSE', app.id) }, 'Pause'));
      controls.push(h('button', { type: 'button', onclick: () => act('ENGINE_STOP', app.id) }, 'Stop'));
    } else if (s === STATES.DRAFT || s === STATES.READY_TO_START) {
      controls.push(h('button', { type: 'button', class: 'primary', disabled: !tabOk, onclick: () => act('ENGINE_START', app.id, tab.id) }, 'Start in this tab'));
    } else if (s !== STATES.SUBMITTED && s !== STATES.SUBMISSION_CONFIRMATION_REQUIRED) {
      if (!(s === STATES.NEEDS_USER_ACTION && progress.requiredAction && progress.requiredAction.type === 'APPROVE_PLAN')) {
        controls.push(h('button', { type: 'button', class: 'primary', disabled: !tabOk, onclick: () => act('ENGINE_RESUME', app.id, tab.id) }, 'Resume in this tab'));
      }
      if (s !== STATES.PAUSED && !isRunningState(s)) controls.push(h('button', { type: 'button', onclick: () => act('ENGINE_PAUSE', app.id) }, 'Pause'));
    }
    if (s === STATES.SUBMISSION_CONFIRMATION_REQUIRED || (progress && progress.requiredAction && progress.requiredAction.type === 'APPROVE_PLAN')) {
      msgs.push(h('p', { class: 'small' }, 'Approvals and submission are confirmed in the dashboard.'));
      clear($('message'), msgs);
    }
  }
  clear($('controls'), controls);
}

render();
chrome.storage.onChanged.addListener(() => render());
