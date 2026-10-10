/**
 * Checkpoint persistence. Every state change writes the application's
 * workflow summary and its detailed progress record in ONE storage.set
 * call, so the two can not drift apart.
 */
import { appKey } from '../data/application-repository.js';
import { progressKey, emptyProgress } from '../data/progress-repository.js';
import { migrateApplication } from '../data/schema.js';
import { assertTransition, STATES } from './workflow-states.js';
import { PCAError, ERROR_CODES } from '../services/errors.js';

function defaultStorage() {
  return globalThis.chrome.storage.local;
}

export function createCheckpointManager({ storage = defaultStorage(), clock = () => new Date() } = {}) {
  async function load(appId) {
    const res = await storage.get([appKey(appId), progressKey(appId)]);
    const raw = res[appKey(appId)];
    if (!raw) throw new PCAError(ERROR_CODES.VALIDATION_FAILED, `Application ${appId} not found.`);
    const app = migrateApplication(raw);
    const progress = { ...emptyProgress(appId), ...(res[progressKey(appId)] || {}) };
    return { app, progress };
  }

  async function write(app, progress) {
    const ts = clock().toISOString();
    app.updatedAt = ts;
    progress.updatedAt = ts;
    progress.history = (progress.history || []).slice(-50);
    await storage.set({ [appKey(app.id)]: app, [progressKey(app.id)]: progress });
  }

  /**
   * Validated state transition.
   * @param {object} opts
   * @param {object} [opts.error] { code, message, requiredAction }
   * @param {boolean} [opts.force] bypass the table (explicit user reset only)
   * @param {(app, progress) => void} [opts.mutate] extra changes in the same write
   */
  async function transition(appId, to, { error = null, force = false, mutate = null, note = '' } = {}) {
    const { app, progress } = await load(appId);
    const from = app.workflow.state;
    if (!force) assertTransition(from, to);
    const ts = clock().toISOString();
    app.workflow = {
      ...app.workflow,
      state: to,
      errorCode: error ? error.code : null,
      errorMessage: error ? error.message : null,
    };
    progress.state = to;
    progress.targetPackageName = app.metadata.packageName;
    progress.playConsoleAppId = app.playConsole.appId;
    progress.errorCode = app.workflow.errorCode;
    progress.errorMessage = app.workflow.errorMessage;
    progress.requiredAction = error && error.requiredAction ? error.requiredAction : null;
    progress.history = [...(progress.history || []), { from, to, ts, ...(error ? { errorCode: error.code } : {}), ...(note ? { note } : {}), ...(force ? { forced: true } : {}) }];
    if (mutate) mutate(app, progress);
    await write(app, progress);
    return { app, progress, from };
  }

  /** Records a verified step; nothing is recorded for unverified steps. */
  async function completeStep(appId, stageId, stepId, { mutate = null } = {}) {
    const { app, progress } = await load(appId);
    const done = new Set(progress.completedSteps[stageId] || []);
    done.add(stepId);
    progress.completedSteps = { ...progress.completedSteps, [stageId]: [...done] };
    progress.stage = stageId;
    progress.step = stepId;
    progress.attempts = 0;
    progress.lastVerifiedCheckpoint = { stage: stageId, step: stepId, at: clock().toISOString() };
    app.workflow.lastVerifiedAt = progress.lastVerifiedCheckpoint.at;
    if (mutate) mutate(app, progress);
    await write(app, progress);
    return { app, progress };
  }

  async function updateProgress(appId, mutate) {
    const { app, progress } = await load(appId);
    mutate(progress, app);
    await write(app, progress);
    return { app, progress };
  }

  /** User-confirmed reset. Guards survive so non-idempotent clicks are never replayed blindly. */
  async function reset(appId, mode) {
    return transition(appId, mode === 'draft' ? STATES.DRAFT : mode.state, {
      force: true,
      note: `reset:${mode === 'draft' ? 'draft' : 'checkpoint'}`,
      mutate: (app, progress) => {
        if (mode === 'draft') {
          progress.completedSteps = {};
          progress.approvals = {};
          progress.stage = null;
          progress.step = null;
          progress.readiness = null;
          app.workflow.lastCompletedStage = null;
        } else {
          // Drop partial progress of the stage that was in flight.
          const cs = { ...progress.completedSteps };
          if (mode.clearStage) delete cs[mode.clearStage];
          progress.completedSteps = cs;
        }
        progress.pausedFrom = null;
        progress.attempts = 0;
      },
    });
  }

  return { load, write, transition, completeStep, updateProgress, reset };
}
