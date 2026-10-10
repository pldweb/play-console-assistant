/**
 * Runtime message contracts and sender validation.
 *
 * - Extension pages (dashboard, popup, form) may send ENGINE_* / TAB_*.
 * - The Play Console content script (top frame only) may send
 *   PCA_STEP_PROGRESS and open the 'pca-asset' port.
 * - Nothing is accepted from web pages: there is no onMessageExternal and
 *   no externally_connectable entry in the manifest.
 */
import { PCAError, ERROR_CODES } from './errors.js';

export const CONSOLE_URL_PREFIX = 'https://play.google.com/console/';
export const ASSET_PORT = 'pca-asset';
export const ASSET_CHUNK_BYTES = 4 * 1024 * 1024;

const str = (v) => typeof v === 'string' && v.length > 0 && v.length < 200;
const int = (v) => Number.isInteger(v) && v >= 0;
const optInt = (v) => v === undefined || v === null || int(v);

/** type -> payload validator for messages from extension pages. */
export const PAGE_MESSAGES = Object.freeze({
  ENGINE_START: (m) => str(m.appId) && int(m.tabId),
  ENGINE_RESUME: (m) => str(m.appId) && int(m.tabId),
  ENGINE_PAUSE: (m) => str(m.appId),
  ENGINE_STOP: (m) => str(m.appId),
  ENGINE_APPROVE_PLAN: (m) => str(m.appId) && int(m.tabId) && /^[a-f0-9]{64}$/.test(m.planHash),
  ENGINE_ALLOW_DUPLICATE: (m) => str(m.appId) && int(m.tabId),
  ENGINE_LINK_CURRENT_APP: (m) => str(m.appId) && int(m.tabId),
  ENGINE_CONFIRM_SUBMISSION: (m) => str(m.appId) && int(m.tabId) && typeof m.typedName === 'string' && m.typedName.length <= 60,
  ENGINE_CANCEL_SUBMISSION: (m) => str(m.appId),
  ENGINE_RESET: (m) => str(m.appId) && (m.mode === 'draft' || m.mode === 'checkpoint'),
  ENGINE_STATUS: (m) => str(m.appId),
  TAB_LIST: () => true,
  TAB_DETECT: (m) => int(m.tabId),
  TAB_OPEN_CONSOLE: () => true,
  ACTIVE_STATUS: (m) => optInt(m.tabId),
});

/** type -> validator for messages from the content script. */
export const CONTENT_MESSAGES = Object.freeze({
  PCA_STEP_PROGRESS: (m) => str(m.appId) && str(m.stage) && str(m.step),
});

export function isExtensionPageSender(sender, runtimeId) {
  return Boolean(sender && sender.id === runtimeId && typeof sender.url === 'string'
    && sender.url.startsWith(`chrome-extension://${runtimeId}/`));
}

export function isConsoleContentSender(sender, runtimeId) {
  return Boolean(sender && sender.id === runtimeId && sender.tab && Number.isInteger(sender.tab.id)
    && sender.frameId === 0 && typeof sender.url === 'string' && sender.url.startsWith(CONSOLE_URL_PREFIX));
}

/**
 * Classifies a runtime message. Returns { kind: 'page'|'content' } or
 * throws MESSAGE_REJECTED.
 */
export function validateRuntimeMessage(msg, sender, runtimeId) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    throw new PCAError(ERROR_CODES.MESSAGE_REJECTED, 'Malformed message.');
  }
  if (PAGE_MESSAGES[msg.type]) {
    if (!isExtensionPageSender(sender, runtimeId)) throw new PCAError(ERROR_CODES.MESSAGE_REJECTED, `${msg.type} is only accepted from extension pages.`);
    if (!PAGE_MESSAGES[msg.type](msg)) throw new PCAError(ERROR_CODES.MESSAGE_REJECTED, `Invalid payload for ${msg.type}.`);
    return { kind: 'page' };
  }
  if (CONTENT_MESSAGES[msg.type]) {
    if (!isConsoleContentSender(sender, runtimeId)) throw new PCAError(ERROR_CODES.MESSAGE_REJECTED, `${msg.type} is only accepted from the Play Console content script.`);
    if (!CONTENT_MESSAGES[msg.type](msg)) throw new PCAError(ERROR_CODES.MESSAGE_REJECTED, `Invalid payload for ${msg.type}.`);
    return { kind: 'content' };
  }
  throw new PCAError(ERROR_CODES.MESSAGE_REJECTED, `Unknown message type ${msg.type}.`);
}

// --- base64 for chunked transfer over ports (messages are JSON-serialised) --
export function bytesToBase64(bytes) {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function chunkBytes(bytes, size = ASSET_CHUNK_BYTES) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
  if (chunks.length === 0) chunks.push(new Uint8Array(0));
  return chunks;
}

/** Thin promise wrapper used by extension pages. */
export async function sendToBackground(message) {
  const resp = await globalThis.chrome.runtime.sendMessage(message);
  if (!resp) throw new PCAError(ERROR_CODES.UNEXPECTED, 'No response from the extension background.');
  if (!resp.ok) throw new PCAError(resp.error.code, resp.error.message, resp.error.details || undefined);
  return resp.result;
}
