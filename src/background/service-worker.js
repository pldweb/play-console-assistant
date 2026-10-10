/**
 * Service worker: message router, workflow engine host and asset server.
 * Registered as a module service worker in manifest.json.
 */
import { createApplicationRepository } from '../data/application-repository.js';
import { createSettingsRepository } from '../data/settings-repository.js';
import { createAssetRepository } from '../data/asset-repository.js';
import { createCheckpointManager } from '../automation/checkpoint-manager.js';
import { createExecutionLock } from '../automation/execution-lock.js';
import { createTaskRunner } from '../automation/task-runner.js';
import { createWorkflowEngine } from '../automation/workflow-engine.js';
import { createLogger } from '../services/logger.js';
import { validateRuntimeMessage, isConsoleContentSender, ASSET_PORT, chunkBytes, bytesToBase64, CONSOLE_URL_PREFIX } from '../services/messaging.js';
import { PCAError, ERROR_CODES, errorPayload, toPCAError } from '../services/errors.js';

const appRepo = createApplicationRepository();
const settingsRepo = createSettingsRepository();
const assetRepo = createAssetRepository();
const lock = createExecutionLock();
const logger = createLogger();

/** Chrome implementation of the engine's tab gateway. */
const gateway = {
  async getTab(tabId) {
    try {
      const t = await chrome.tabs.get(tabId);
      // With host permissions limited to Play Console, `url` is only
      // visible while the tab is on Play Console.
      return { id: t.id, status: t.status, url: t.url || t.pendingUrl || undefined };
    } catch {
      return null;
    }
  },
  async send(tabId, msg, timeoutMs) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new PCAError(ERROR_CODES.ACTION_TIMEOUT, `No response from the tab within ${timeoutMs} ms.`)), timeoutMs);
    });
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch((e) => {
          throw new PCAError(ERROR_CODES.CONTENT_SCRIPT_UNAVAILABLE, `Cannot reach the Play Console tab (${e.message}).`);
        }),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  },
  async navigate(tabId, url) {
    if (!url.startsWith(CONSOLE_URL_PREFIX)) throw new PCAError(ERROR_CODES.WRONG_PAGE, 'Refusing to navigate outside Play Console.');
    await chrome.tabs.update(tabId, { url });
  },
  async reload(tabId) {
    await chrome.tabs.reload(tabId);
  },
};

const engine = createWorkflowEngine({
  checkpoints: createCheckpointManager(),
  appRepo,
  settingsRepo,
  lock,
  runner: createTaskRunner(),
  logger,
  gateway,
});

// A fresh service worker cannot have a running job: pause any state that
// claims otherwise so it is resumed only after the user checks the tab.
const startup = engine.recoverOnStartup().catch((e) => logger.log({ action: 'recover', outcome: 'error', message: e.message }));

async function listConsoleTabs() {
  const tabs = await chrome.tabs.query({ url: `${CONSOLE_URL_PREFIX}*` });
  return tabs.map((t) => ({ id: t.id, title: t.title || '', url: t.url || '', active: t.active, windowId: t.windowId }));
}

const strip = (r) => {
  if (!r || typeof r !== 'object') return r;
  const { done: _done, ...rest } = r;
  return rest;
};

async function handlePageMessage(msg) {
  await startup;
  switch (msg.type) {
    case 'ENGINE_START': return strip(await engine.start(msg.appId, msg.tabId));
    case 'ENGINE_RESUME': return strip(await engine.resume(msg.appId, msg.tabId));
    case 'ENGINE_PAUSE': return strip(await engine.pause(msg.appId));
    case 'ENGINE_STOP': return strip(await engine.stop(msg.appId));
    case 'ENGINE_APPROVE_PLAN': return strip(await engine.approvePlan(msg.appId, msg.planHash, msg.tabId));
    case 'ENGINE_ALLOW_DUPLICATE': return strip(await engine.allowDuplicateName(msg.appId, msg.tabId));
    case 'ENGINE_LINK_CURRENT_APP': return strip(await engine.linkCurrentApp(msg.appId, msg.tabId));
    case 'ENGINE_CONFIRM_SUBMISSION': return strip(await engine.confirmSubmission(msg.appId, msg.typedName, msg.tabId));
    case 'ENGINE_CANCEL_SUBMISSION': return strip(await engine.cancelSubmission(msg.appId));
    case 'ENGINE_RESET': return strip(await engine.reset(msg.appId, msg.mode));
    case 'ENGINE_STATUS': return strip(await engine.status(msg.appId));
    case 'TAB_LIST': return listConsoleTabs();
    case 'TAB_DETECT': {
      try {
        const r = await gateway.send(msg.tabId, { type: 'PCA_DETECT' }, 5000);
        return r && r.ok ? r.page : null;
      } catch {
        return null;
      }
    }
    case 'TAB_OPEN_CONSOLE': {
      const t = await chrome.tabs.create({ url: 'https://play.google.com/console/' });
      return { id: t.id };
    }
    case 'ACTIVE_STATUS': return { lock: await lock.get() };
    default: throw new PCAError(ERROR_CODES.MESSAGE_REJECTED, 'Unhandled message.');
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let kind;
  try {
    ({ kind } = validateRuntimeMessage(msg, sender, chrome.runtime.id));
  } catch (e) {
    sendResponse({ ok: false, error: errorPayload(e) });
    return false;
  }
  const work = kind === 'page'
    ? handlePageMessage(msg)
    : engine.recordStepProgress(msg.appId, sender.tab.id, msg);
  work.then((result) => sendResponse({ ok: true, result }), (e) => sendResponse({ ok: false, error: errorPayload(e) }));
  return true;
});

/**
 * Asset transfer: content script -> port -> bytes in base64 chunks.
 * Served only to the top frame of the tab holding the execution lock, and
 * only for assets owned by the application being automated there.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== ASSET_PORT || !isConsoleContentSender(port.sender, chrome.runtime.id)) {
    port.disconnect();
    return;
  }
  port.onMessage.addListener(async (m) => {
    try {
      if (!m || m.type !== 'GET_ASSET' || typeof m.assetId !== 'string' || typeof m.appId !== 'string') {
        throw new PCAError(ERROR_CODES.MESSAGE_REJECTED, 'Invalid asset request.');
      }
      if (!(await lock.holds(m.appId, port.sender.tab.id))) {
        throw new PCAError(ERROR_CODES.MESSAGE_REJECTED, 'This tab is not automating that application.');
      }
      const rec = await assetRepo.getForApp(m.appId, m.assetId);
      if (!rec) throw new PCAError(ERROR_CODES.ASSET_MISSING, 'The file is not stored for this application. Re-select the asset folder.');
      const chunks = chunkBytes(new Uint8Array(rec.bytes));
      port.postMessage({ type: 'META', fileName: rec.fileName, mimeType: rec.mimeType, size: rec.size, chunks: chunks.length });
      chunks.forEach((c, index) => port.postMessage({ type: 'CHUNK', index, data: bytesToBase64(c) }));
      port.postMessage({ type: 'END' });
      logger.log({ appId: m.appId, action: 'asset-served', outcome: 'success', message: rec.role });
    } catch (e) {
      const err = toPCAError(e);
      try { port.postMessage({ type: 'ERROR', error: errorPayload(err) }); } catch { /* port gone */ }
      logger.log({ appId: m && m.appId, action: 'asset-served', outcome: 'error', errorCode: err.code, message: err.message });
    }
  });
});

