/**
 * Content script entry (ES module, loaded by content-script.js).
 * Wires the DOM handler to Chrome messaging and the asset port.
 */
import { createContentHandler } from './message-handler.js';
import { ASSET_PORT, base64ToBytes } from '../services/messaging.js';
import { PCAError, ERROR_CODES } from '../services/errors.js';

const ASSET_TIMEOUT_MS = 120000;

/**
 * Receives an asset's bytes from the service worker over a port. The
 * service worker only serves assets of the application it is automating
 * in this tab.
 */
function fetchAsset(assetId, appId) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: ASSET_PORT });
    const chunks = [];
    let meta = null;
    const timer = setTimeout(() => { port.disconnect(); reject(new PCAError(ERROR_CODES.UPLOAD_FAILED, 'Timed out receiving the file from the extension.')); }, ASSET_TIMEOUT_MS);
    const done = (fn, v) => { clearTimeout(timer); try { port.disconnect(); } catch { /* already closed */ } fn(v); };
    port.onMessage.addListener((m) => {
      if (m.type === 'META') meta = m;
      else if (m.type === 'CHUNK') chunks[m.index] = base64ToBytes(m.data);
      else if (m.type === 'END') {
        if (!meta || chunks.length !== meta.chunks) return done(reject, new PCAError(ERROR_CODES.UPLOAD_FAILED, 'File transfer was incomplete.'));
        const file = new File(chunks, meta.fileName, { type: meta.mimeType });
        if (file.size !== meta.size) return done(reject, new PCAError(ERROR_CODES.UPLOAD_FAILED, 'File size mismatch after transfer.'));
        done(resolve, file);
      } else if (m.type === 'ERROR') done(reject, new PCAError(m.error.code, m.error.message));
    });
    port.onDisconnect.addListener(() => done(reject, new PCAError(ERROR_CODES.UPLOAD_FAILED, 'File transfer channel closed.')));
    port.postMessage({ type: 'GET_ASSET', assetId, appId });
  });
}

export const handleMessage = createContentHandler({
  document,
  getHref: () => location.href,
  getAsset: fetchAsset,
  reportProgress: (data) => chrome.runtime.sendMessage({ type: 'PCA_STEP_PROGRESS', ...data }).catch(() => {}),
});
