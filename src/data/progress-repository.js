/**
 * Detailed per-application checkpoint records (`progress:<appId>`).
 *
 * The summary state lives in `app.workflow`; this record holds the
 * step-level detail needed for safe recovery: completed steps, attempt
 * counts, guards for non-idempotent clicks, the required user action and a
 * short transition history.
 */
export const PROGRESS_KEY_PREFIX = 'progress:';
export const progressKey = (appId) => `${PROGRESS_KEY_PREFIX}${appId}`;
const HISTORY_LIMIT = 50;

export function emptyProgress(appId) {
  return {
    appId,
    targetPackageName: '',
    playConsoleAppId: null,
    state: 'DRAFT',
    stage: null,
    step: null,
    completedSteps: {},
    lastVerifiedCheckpoint: null,
    updatedAt: null,
    attempts: 0,
    errorCode: null,
    errorMessage: null,
    requiredAction: null,
    pausedFrom: null,
    approvals: {},
    guards: {},
    readiness: null,
    allowDuplicateName: false,
    history: [],
  };
}

function defaultStorage() {
  return globalThis.chrome.storage.local;
}

export function createProgressRepository({ storage = defaultStorage() } = {}) {
  async function get(appId) {
    const key = progressKey(appId);
    const res = await storage.get(key);
    return res[key] ? { ...emptyProgress(appId), ...res[key] } : emptyProgress(appId);
  }

  /** Build the storage entry; callers combine it with the app write. */
  function entry(progress) {
    const p = { ...progress, history: (progress.history || []).slice(-HISTORY_LIMIT) };
    return { [progressKey(progress.appId)]: p };
  }

  async function put(progress) {
    await storage.set(entry(progress));
    return progress;
  }

  async function remove(appId) {
    await storage.remove(progressKey(appId));
  }

  return { get, put, entry, remove };
}
