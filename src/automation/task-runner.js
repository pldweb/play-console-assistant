/**
 * Per-tab exclusive runner. A second job for a tab that already has a job
 * running is rejected (not queued), so two automation jobs can never act
 * on the same Play Console tab at once.
 */
import { PCAError, ERROR_CODES } from '../services/errors.js';

export function createTaskRunner() {
  const running = new Map(); // tabId -> { appId, promise }

  async function runExclusive(tabId, appId, fn) {
    if (running.has(tabId)) {
      throw new PCAError(ERROR_CODES.LOCKED, 'An automation job is already running in this tab.', { tabId, appId: running.get(tabId).appId });
    }
    const promise = (async () => fn())();
    running.set(tabId, { appId, promise });
    try {
      return await promise;
    } finally {
      running.delete(tabId);
    }
  }

  return {
    runExclusive,
    isBusy: (tabId) => running.has(tabId),
    busyApp: (appId) => [...running.values()].some((r) => r.appId === appId),
    running: () => [...running.entries()].map(([tabId, r]) => ({ tabId, appId: r.appId })),
  };
}
