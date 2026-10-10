import { createStorageArea } from '../mocks/chrome.js';
import { createApplicationRepository } from '../../src/data/application-repository.js';
import { createProgressRepository } from '../../src/data/progress-repository.js';
import { createSettingsRepository } from '../../src/data/settings-repository.js';
import { createCheckpointManager } from '../../src/automation/checkpoint-manager.js';
import { createExecutionLock } from '../../src/automation/execution-lock.js';
import { createTaskRunner } from '../../src/automation/task-runner.js';
import { createWorkflowEngine } from '../../src/automation/workflow-engine.js';
import { createLogger } from '../../src/services/logger.js';
import { FakeConsole } from './fake-console.js';
import { readyApp } from './factories.js';

export const FAST_SETTINGS = {
  requirePlanApproval: false,
  retryLimit: 2,
  retryBaseDelayMs: 1,
  stepTimeoutMs: 5000,
  navigationTimeoutMs: 1500,
  pollIntervalMs: 5,
  bundleProcessingTimeoutMs: 2000,
};

export async function createHarness({ settings = {}, fake = new FakeConsole() } = {}) {
  const local = createStorageArea();
  const session = createStorageArea();
  const appRepo = createApplicationRepository({ storage: local });
  const progressRepo = createProgressRepository({ storage: local });
  const settingsRepo = createSettingsRepository({ storage: local });
  await settingsRepo.set({ ...FAST_SETTINGS, ...settings });
  const checkpoints = createCheckpointManager({ storage: local });
  const lock = createExecutionLock({ storage: session });
  const runner = createTaskRunner();
  const logger = createLogger({ storage: local });
  const makeEngine = () => createWorkflowEngine({
    checkpoints, appRepo, settingsRepo, lock, runner: createTaskRunner(), logger, gateway: fake.gateway(), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  });
  const engine = createWorkflowEngine({
    checkpoints, appRepo, settingsRepo, lock, runner, logger, gateway: fake.gateway(), sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  });

  /** Saves a ready app and registers its asset bytes with the fake console. */
  async function addApp(overrides = {}, mutate = null) {
    const app = readyApp(overrides);
    if (mutate) mutate(app);
    const saved = await appRepo.save(app);
    const refs = [saved.assets.appIcon, saved.assets.featureGraphic, ...saved.assets.phoneScreenshots, saved.release.aabFile];
    for (const r of refs) fake.assets.set(r.assetId, { appId: saved.id, name: r.fileName, type: r.mimeType, bytes: new Uint8Array([1, 2, 3]) });
    return saved;
  }

  const state = async (appId) => (await appRepo.get(appId)).workflow.state;
  const progress = async (appId) => progressRepo.get(appId);

  /** Starts/resumes and waits until the run halts. */
  async function runUntilHalt(fn) {
    const r = await fn();
    await r.done;
    return r;
  }

  return { fake, local, session, appRepo, progressRepo, settingsRepo, checkpoints, lock, runner, logger, engine, makeEngine, addApp, state, progress, runUntilHalt };
}
