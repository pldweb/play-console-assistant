/*
 * Classic-script loader injected into Play Console pages (top frame only).
 * Content scripts cannot be ES modules, so this loads src/content/main.js
 * with a dynamic import and forwards only PCA_* requests from this
 * extension's own background context.
 */
(() => {
  if (window.__pcaContentLoaded) return;
  window.__pcaContentLoaded = true;
  const modulePromise = import(chrome.runtime.getURL('src/content/main.js'));

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only the extension's service worker talks to us (it has no sender.tab).
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('PCA_')) return false;
    modulePromise
      .then((m) => m.handleMessage(msg))
      .then(sendResponse, (e) => sendResponse({ ok: false, error: { code: 'UNEXPECTED', message: String((e && e.message) || e) } }));
    return true; // async response
  });
})();
