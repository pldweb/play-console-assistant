/**
 * Global execution lock (MVP: one application automated at a time).
 * Stored in chrome.storage.session so it is shared by every extension
 * context and cleared when the browser closes.
 */
import { PCAError, ERROR_CODES } from '../services/errors.js';

export const LOCK_KEY = 'executionLock';

function defaultStorage() {
  return globalThis.chrome.storage.session;
}

export function createExecutionLock({ storage = defaultStorage(), clock = () => new Date() } = {}) {
  async function get() {
    const res = await storage.get(LOCK_KEY);
    return res[LOCK_KEY] || null;
  }

  async function acquire(appId, tabId) {
    const cur = await get();
    if (cur && (cur.appId !== appId || cur.tabId !== tabId)) {
      throw new PCAError(ERROR_CODES.LOCKED,
        cur.appId !== appId ? 'Another application is being automated. Pause or stop it first.' : 'This application is being automated in a different tab.',
        { lock: cur });
    }
    const lock = { appId, tabId, acquiredAt: cur ? cur.acquiredAt : clock().toISOString() };
    await storage.set({ [LOCK_KEY]: lock });
    return lock;
  }

  async function release(appId) {
    const cur = await get();
    if (cur && (appId === undefined || cur.appId === appId)) await storage.remove(LOCK_KEY);
  }

  async function holds(appId, tabId) {
    const cur = await get();
    return Boolean(cur && cur.appId === appId && (tabId === undefined || cur.tabId === tabId));
  }

  return { get, acquire, release, holds };
}
