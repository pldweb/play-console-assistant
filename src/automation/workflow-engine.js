/**
 * Workflow engine (runs in the service worker).
 *
 * For each stage and step:
 *   ensure page (navigate if a template exists, detect, check identity)
 *   -> inspect (no writes) -> stop on blocking issues
 *   -> plan approval / submission confirmation gate
 *   -> guard for non-idempotent actions -> apply (with retry policy)
 *   -> verify (after navigation or reload where required)
 *   -> checkpoint.
 *
 * Nothing is marked complete without a successful verification. Every
 * dependency is injected so the engine can be tested against a simulated
 * Play Console.
 */
import { STATES, STAGES, getStage, nextStageFor, isRunningState, COMPLETED_STATES } from './workflow-states.js';
import { createRetryPolicy } from './retry-policy.js';
import { STAGE_DEFINITIONS } from '../adapters/index.js';
import { PAGE_TYPES, buildConsoleUrl } from '../content/page-detector.js';
import { validateApplication } from '../data/schema.js';
import { PCAError, ERROR_CODES, toPCAError, classifyError } from '../services/errors.js';

const PAUSE = Symbol('pause');
const SUBMISSION_TOKEN_TTL_MS = 5 * 60 * 1000;
const DEVELOPER_PAGES = [PAGE_TYPES.APP_LIST, PAGE_TYPES.CREATE_APP];

/** What the user is asked to do for each error code. */
export const USER_ACTION_HINTS = Object.freeze({
  NO_CONSOLE_TAB: 'Open Google Play Console in a tab and select it as the automation tab.',
  TAB_CLOSED: 'The automation tab was closed. Open Play Console again and resume.',
  SESSION_EXPIRED: 'Sign in to Play Console in the automation tab (complete any 2-step verification yourself), then resume.',
  UNKNOWN_PAGE: 'The tab shows a page the extension does not recognise. Navigate to the expected page, then resume.',
  WRONG_PAGE: 'Navigate the automation tab to the page named in the message, then resume.',
  NAVIGATION_TIMEOUT: 'The page did not finish loading. Check the tab, then resume.',
  CONTENT_SCRIPT_UNAVAILABLE: 'The extension cannot talk to the tab. Reload the Play Console tab, then resume.',
  IDENTITY_MISMATCH: 'The tab shows a different app or developer account than this record. Open the correct app, or link/unlink it, then resume.',
  POSSIBLE_DUPLICATE_APP: 'An app with the same name exists. Link this record to it, or confirm that a new app should be created.',
  ELEMENT_NOT_FOUND: 'A field or button was not found. The Play Console UI may have changed; complete this step manually or report the selector.',
  AMBIGUOUS_ELEMENT: 'More than one matching field was found. Complete this step manually or report the selector.',
  ELEMENT_DISABLED: 'A field is disabled. Check the page for a reason, then resume.',
  UNKNOWN_QUESTION: 'Play Console asks a question the extension does not know. Answer it yourself, then resume.',
  PAGE_VALIDATION_ERROR: 'Play Console rejected a value. Fix the data or the page, then resume.',
  EXISTING_CONTENT: 'The page already has content the extension will not overwrite. Remove or confirm it in Play Console, then resume.',
  UPLOAD_FAILED: 'An upload failed. Check the message, fix the file, then resume.',
  UPLOAD_NOT_CONFIRMED: 'The upload could not be confirmed. Check the page; resume will re-check before uploading again.',
  PROCESSING_TIMEOUT: 'The bundle is still processing or failed. Check the release page, then resume.',
  VERSION_CODE_CONFLICT: 'This version code was already used. Build a bundle with a higher version code.',
  PACKAGE_MISMATCH: 'The bundle belongs to a different package. Select the correct .aab for this app.',
  PACKAGE_UNAVAILABLE: 'Play Console says this package name cannot be used. Change the package name in the app form, then resume.',
  VERIFY_FAILED: 'The result could not be verified. Check the page and the details, then resume.',
  DECLARATION_UNANSWERED: 'Answer the declaration in this app\'s form first.',
  MANUAL_SECTION_INCOMPLETE: 'Complete the listed sections yourself in Play Console, then resume.',
  READINESS_ISSUES: 'Resolve the issues Play Console lists, then resume.',
  SUBMISSION_NOT_CONFIRMED: 'Submission needs your typed confirmation for this app.',
  INTERRUPTED: 'The extension restarted during automation. Check the tab and resume when ready.',
  APPROVAL_REQUIRED: 'Review the planned changes and approve them to continue.',
  VALIDATION_FAILED: 'Fix the application data, then resume.',
  ASSET_MISSING: 'Select the missing file in the application form.',
  LOCKED: 'Another automation is running. Pause it first.',
});

async function sha256Json(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function randomToken() {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {object} deps
 * @param {ReturnType<import('./checkpoint-manager.js').createCheckpointManager>} deps.checkpoints
 * @param {{ list(): Promise<object[]> }} deps.appRepo
 * @param {{ get(): Promise<object> }} deps.settingsRepo
 * @param {ReturnType<import('./execution-lock.js').createExecutionLock>} deps.lock
 * @param {ReturnType<import('./task-runner.js').createTaskRunner>} deps.runner
 * @param {{ log(entry): any }} deps.logger
 * @param {object} deps.gateway tab gateway: getTab, send, navigate, reload
 */
export function createWorkflowEngine(deps) {
  const {
    checkpoints, appRepo, settingsRepo, lock, runner, logger, gateway,
    clock = () => new Date(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = deps;
  const pauseRequests = new Set();
  const submissionTokens = new Map();
  const active = new Set(); // apps with a launched run (covers the gap before the runner starts)

  const log = (appId, stage, action, outcome, extra = {}) => logger.log({ appId, stage, action, outcome, ...extra });
  const now = () => clock().getTime();

  // ---------------------------------------------------------------- tab I/O
  async function contentCall(tabId, msg, timeoutMs) {
    let resp;
    try {
      resp = await gateway.send(tabId, msg, timeoutMs);
    } catch (e) {
      throw toPCAError(e);
    }
    if (!resp) throw new PCAError(ERROR_CODES.CONTENT_SCRIPT_UNAVAILABLE, 'No response from the Play Console tab.');
    if (!resp.ok) {
      const err = resp.error || {};
      throw new PCAError(err.code || ERROR_CODES.UNEXPECTED, err.message || 'Content script error.', err.details || undefined);
    }
    return resp;
  }

  async function detect(tabId, appName, timeoutMs) {
    try {
      const r = await gateway.send(tabId, { type: 'PCA_DETECT', appName }, timeoutMs);
      return r && r.ok ? r.page : null;
    } catch {
      return null;
    }
  }

  async function requireTab(tabId) {
    const tab = await gateway.getTab(tabId);
    if (!tab) throw new PCAError(ERROR_CODES.TAB_CLOSED, 'The automation tab no longer exists.');
    return tab;
  }

  /** Bounded polling until the tab shows `want` and it has rendered. */
  async function waitForPage(tabId, want, { appName, settings }) {
    const end = now() + settings.navigationTimeoutMs;
    let last = null;
    for (;;) {
      const tab = await requireTab(tabId);
      if (tab.status !== 'loading') {
        if (!tab.url) {
          // Host permissions only reveal Play Console URLs. No URL means the
          // tab left Play Console (e.g. redirected to the Google sign-in page).
          throw new PCAError(ERROR_CODES.SESSION_EXPIRED, 'The automation tab is no longer on Play Console (signed out or navigated away).');
        }
        const page = await detect(tabId, appName, settings.pollIntervalMs * 3);
        if (page) {
          last = page;
          if (!page.authenticated || page.pageType === PAGE_TYPES.SIGN_IN) throw new PCAError(ERROR_CODES.SESSION_EXPIRED, 'Play Console is asking you to sign in.');
          if (page.pageType === want && page.ready) return page;
        }
      }
      if (now() >= end) {
        if (!last) throw new PCAError(ERROR_CODES.NAVIGATION_TIMEOUT, `Timed out waiting for ${want}.`);
        if (last.pageType === PAGE_TYPES.UNKNOWN) throw new PCAError(ERROR_CODES.UNKNOWN_PAGE, `Unrecognised page (${last.url}). Expected ${want}.`, { page: last });
        throw new PCAError(ERROR_CODES.WRONG_PAGE, `Expected ${want} but the tab shows ${last.pageType}${last.ready ? '' : ' (not finished rendering)'}.`, { page: last });
      }
      await sleep(settings.pollIntervalMs);
    }
  }

  function checkIdentity(page, app, progress, want) {
    const devId = app.playConsole.developerId || progress.developerId;
    if (devId && page.developerId && page.developerId !== devId) {
      throw new PCAError(ERROR_CODES.IDENTITY_MISMATCH, `The tab belongs to developer account ${page.developerId}, but this app uses ${devId}.`);
    }
    if (!DEVELOPER_PAGES.includes(want) && page.appId !== app.playConsole.appId) {
      throw new PCAError(ERROR_CODES.IDENTITY_MISMATCH, `The tab shows Play Console app ${page.appId || '(none)'}, but this record is linked to ${app.playConsole.appId}.`);
    }
  }

  /** Puts the tab on the step's page or explains why it can't. */
  async function ensurePage(appId, tabId, step, settings) {
    const { app, progress } = await checkpoints.load(appId);
    const tab = await requireTab(tabId);
    if (!tab.url) throw new PCAError(ERROR_CODES.SESSION_EXPIRED, 'The automation tab is not on Play Console (signed out or navigated away).');
    const cur = await detect(tabId, app.metadata.appName, settings.pollIntervalMs * 3);
    if (cur && (!cur.authenticated || cur.pageType === PAGE_TYPES.SIGN_IN)) throw new PCAError(ERROR_CODES.SESSION_EXPIRED, 'Play Console is asking you to sign in.');
    const devId = app.playConsole.developerId || progress.developerId || (cur && cur.developerId);
    if (!devId) throw new PCAError(ERROR_CODES.WRONG_PAGE, 'Open your Play Console developer account (All apps) in the automation tab.');
    if (!progress.developerId) await checkpoints.updateProgress(appId, (p) => { p.developerId = devId; });

    const trackOk = (p) => step.page !== PAGE_TYPES.TRACK || p.track === app.release.releaseTrack;
    if (cur && cur.pageType === step.page && cur.ready && trackOk(cur)) {
      checkIdentity(cur, app, { ...progress, developerId: devId }, step.page);
      if (!step.readOnly) return cur;
      // Read-only checks must not trust a page rendered before the user's
      // manual changes: reload it first.
      await gateway.reload(tabId);
      await sleep(settings.pollIntervalMs);
      const fresh = await waitForPage(tabId, step.page, { appName: app.metadata.appName, settings });
      checkIdentity(fresh, app, { ...progress, developerId: devId }, step.page);
      return fresh;
    }
    if (cur && cur.developerId && cur.developerId !== devId) checkIdentity(cur, app, { ...progress, developerId: devId }, step.page);
    if (step.page === PAGE_TYPES.RELEASE_EDIT) {
      // The release editor has no stable URL; reopen it from the track page.
      if ((progress.completedSteps.RELEASE || []).includes('open-release')) {
        await checkpoints.updateProgress(appId, (p) => {
          p.completedSteps = { ...p.completedSteps, RELEASE: (p.completedSteps.RELEASE || []).filter((s) => s !== 'open-release') };
        });
        return 'restart-stage';
      }
      throw new PCAError(ERROR_CODES.WRONG_PAGE, 'Open the release editor for this app, then resume.');
    }
    const url = buildConsoleUrl(step.page, {
      userIndex: cur && cur.userIndex !== null && cur.userIndex !== undefined ? cur.userIndex : settings.consoleUserIndex,
      developerId: devId,
      appId: app.playConsole.appId,
      track: app.release.releaseTrack,
    });
    if (!url) throw new PCAError(ERROR_CODES.WRONG_PAGE, `Open the ${step.page} page for this app, then resume.`);
    await log(appId, null, 'navigate', 'info', { message: step.page });
    await gateway.navigate(tabId, url);
    const page = await waitForPage(tabId, step.page, { appName: app.metadata.appName, settings });
    checkIdentity(page, app, { ...progress, developerId: devId }, step.page);
    return page;
  }

  // ---------------------------------------------------------- submission
  function tokenValid(appId, tabId, app) {
    const t = submissionTokens.get(appId);
    return Boolean(t && t.tabId === tabId && t.playConsoleAppId === app.playConsole.appId && t.expiresAt > now());
  }

  function consumeToken(appId, tabId, app) {
    const ok = tokenValid(appId, tabId, app);
    submissionTokens.delete(appId); // single use, even when invalid
    if (!ok) throw new PCAError(ERROR_CODES.SUBMISSION_NOT_CONFIRMED, 'Submission confirmation is missing, expired, or belongs to another tab/app.');
  }

  // ---------------------------------------------------------------- steps
  async function runStep(appId, tabId, stage, step, settings) {
    const key = `${stage.id}:${step.id}`;
    // A non-idempotent action ran before without a verified result: look at
    // the tab as it is now (do not navigate away from a possible result).
    const before = await checkpoints.load(appId);
    if (!step.idempotent && before.progress.guards[key] && step.onUncertain === 'verify') {
      await log(appId, stage.id, `${step.id}:uncertain`, 'info', { message: 'Previous attempt not verified; verifying instead of repeating.' });
      return resolveUncertain(appId, tabId, stage, step, settings);
    }
    const page = await ensurePage(appId, tabId, step, settings);
    if (page === 'restart-stage') return 'restart-stage';
    const { app, progress } = await checkpoints.load(appId);
    const payload = step.buildPayload(app, { progress, settings, submissionConfirmed: step.requiresConfirmation ? tokenValid(appId, tabId, app) : false });
    const base = { stage: stage.id, step: step.id, payload, appId, expectedPage: { appId: app.playConsole.appId || null } };

    const insp = await contentCall(tabId, { type: 'PCA_INSPECT', ...base }, settings.stepTimeoutMs);
    const report = insp.report;
    await checkpoints.updateProgress(appId, (p) => { p.lastReport = { stage: stage.id, step: step.id, report, payload, at: clock().toISOString() }; });
    await log(appId, stage.id, `${step.id}:inspect`, report.blocking.length ? 'blocked' : 'success', { details: { fields: report.fields.length, blocking: report.blocking.length } });
    if (report.blocking.length) {
      const first = report.blocking[0];
      throw new PCAError(first.code || ERROR_CODES.UNKNOWN_QUESTION, report.blocking.map((b) => b.message).join(' '), {
        requiredAction: { type: first.code === ERROR_CODES.POSSIBLE_DUPLICATE_APP ? 'LINK_OR_ALLOW_DUPLICATE' : 'RESOLVE_ON_PAGE', stage: stage.id, step: step.id, report },
      });
    }

    const nothingToDo = report.fields.length > 0 && report.fields.every((f) => f.status === 'skipped' || f.willChange === false);
    let uncertain = false;
    if (!step.readOnly && !nothingToDo) {
      if (step.requiresConfirmation) {
        consumeToken(appId, tabId, app);
      } else if (settings.requirePlanApproval && step.approval) {
        const planHash = await sha256Json({ stage: stage.id, step: step.id, payload, fields: report.fields });
        if (progress.approvals[key] !== planHash) {
          throw new PCAError(ERROR_CODES.APPROVAL_REQUIRED, `Review the planned changes for ${stage.label}: ${step.id}.`, {
            requiredAction: { type: 'APPROVE_PLAN', stage: stage.id, step: step.id, planHash, report, payload },
          });
        }
      }
      if (!step.idempotent) await checkpoints.updateProgress(appId, (p) => { p.guards = { ...p.guards, [key]: clock().toISOString() }; });
      uncertain = await applyStep(appId, tabId, stage, step, base, settings);
    }

    const mutate = await verifyStep(appId, tabId, stage, step, base, settings, { uncertain });
    await checkpoints.completeStep(appId, stage.id, step.id, { mutate });
    await log(appId, stage.id, `${step.id}:verify`, 'success');
    return 'done';
  }

  /** Applies with the retry policy. Returns true when the outcome is unknown. */
  async function applyStep(appId, tabId, stage, step, base, settings) {
    const policy = createRetryPolicy({ retryLimit: settings.retryLimit, baseDelayMs: settings.retryBaseDelayMs, sleep });
    const timeout = step.applyTimeoutMs ? step.applyTimeoutMs(base.payload, settings) : settings.stepTimeoutMs * 4;
    try {
      const r = await policy.run(async (attempt) => {
        await checkpoints.updateProgress(appId, (p) => { p.attempts = attempt; });
        const resp = await contentCall(tabId, { type: 'PCA_APPLY', ...base, stepTimeoutMs: settings.stepTimeoutMs, uploadTimeoutMs: settings.stepTimeoutMs * 2 }, timeout);
        return resp.result;
      }, {
        idempotent: step.idempotent && !step.expectsNavigation,
        // Before repeating, look at the page: the earlier attempt may have worked.
        beforeRetry: async (err) => {
          await log(appId, stage.id, `${step.id}:apply`, 'retry', { errorCode: err.code, message: err.message });
          try {
            const v = await contentCall(tabId, { type: 'PCA_VERIFY', ...base }, settings.stepTimeoutMs);
            return v.verify.ok ? 'done' : 'retry';
          } catch {
            return 'retry';
          }
        },
      });
      await log(appId, stage.id, `${step.id}:apply`, r.recovered ? 'recovered' : 'success', { details: r.value || {} });
      return false;
    } catch (e) {
      const err = toPCAError(e);
      const lost = [ERROR_CODES.ACTION_TIMEOUT, ERROR_CODES.CONTENT_SCRIPT_UNAVAILABLE].includes(err.code);
      // Navigation tears down the content script, so a lost response is expected.
      if (lost && (step.expectsNavigation || !step.idempotent)) {
        await log(appId, stage.id, `${step.id}:apply`, 'uncertain', { errorCode: err.code, message: err.message });
        return true;
      }
      throw err;
    }
  }

  async function verifyStep(appId, tabId, stage, step, base, settings, { uncertain }) {
    const { app } = await checkpoints.load(appId);
    if (step.expectsNavigation) {
      const page = await waitForPage(tabId, step.navigatesTo, { appName: app.metadata.appName, settings });
      if (stage.id === 'CREATE_APP' && step.id === 'submit-create') return linkCreatedApp(app, page);
      checkIdentity(page, app, { developerId: page.developerId }, step.navigatesTo);
      return null;
    }
    if (step.verifyAfterReload) {
      await gateway.reload(tabId);
      await sleep(settings.pollIntervalMs);
      await waitForPage(tabId, step.page, { appName: app.metadata.appName, settings });
    }
    const v = await contentCall(tabId, { type: 'PCA_VERIFY', ...base }, settings.stepTimeoutMs);
    if (!v.verify.ok) {
      const msg = v.verify.mismatches.map((m) => m.message).join(' ');
      throw new PCAError(uncertain ? ERROR_CODES.UPLOAD_NOT_CONFIRMED : ERROR_CODES.VERIFY_FAILED, msg || 'Verification failed.', {
        requiredAction: { type: 'RESOLVE_ON_PAGE', stage: stage.id, step: step.id, mismatches: v.verify.mismatches },
      });
    }
    if (v.verify.summary) {
      return (a, p) => { p.readiness = { ...(p.readiness || {}), [step.id]: v.verify.summary, checkedAt: clock().toISOString() }; };
    }
    return null;
  }

  function linkCreatedApp(app, page) {
    if (!page.appId) throw new PCAError(ERROR_CODES.VERIFY_FAILED, 'The new app page has no app id in its URL.');
    if (!page.appNameShown) {
      throw new PCAError(ERROR_CODES.IDENTITY_MISMATCH, `The page after creation does not show "${app.metadata.appName}". Check All apps before continuing.`);
    }
    return (a, p) => {
      a.playConsole = { developerId: page.developerId, appId: page.appId, linkedAt: clock().toISOString() };
      p.playConsoleAppId = page.appId;
    };
  }

  /** "Create app" was clicked before but never verified: never click again. */
  async function resolveUncertain(appId, tabId, stage, step, settings) {
    const { app } = await checkpoints.load(appId);
    const page = await detect(tabId, app.metadata.appName, settings.stepTimeoutMs);
    const { progress } = await checkpoints.load(appId);
    const devOk = page && (!progress.developerId || page.developerId === progress.developerId);
    const linkedElsewhere = page && page.appId && (await appRepo.list()).some((a) => a.id !== appId && a.playConsole.appId === page.appId);
    if (page && devOk && !linkedElsewhere && page.pageType === step.navigatesTo && page.ready && page.appNameShown && page.appId) {
      await checkpoints.completeStep(appId, stage.id, step.id, { mutate: linkCreatedApp(app, page) });
      await log(appId, stage.id, `${step.id}:verify`, 'recovered', { message: 'Earlier action confirmed from the current page.' });
      return 'done';
    }
    throw new PCAError(ERROR_CODES.POSSIBLE_DUPLICATE_APP,
      `"${step.id}" was attempted earlier but its result could not be confirmed. Open the app in Play Console and link it, or reset this app if it was not created.`,
      { requiredAction: { type: 'LINK_OR_RESET', stage: stage.id, step: step.id } });
  }

  /** CREATE_APP for a record already linked to a Play Console app. */
  async function verifyLinkedApp(appId, tabId, settings) {
    const step = { id: 'verify-linked', page: PAGE_TYPES.APP_DASHBOARD };
    const page = await ensurePage(appId, tabId, step, settings);
    const { app } = await checkpoints.load(appId);
    const named = await detect(tabId, app.metadata.appName, settings.stepTimeoutMs);
    if (!named || !named.appNameShown) {
      throw new PCAError(ERROR_CODES.IDENTITY_MISMATCH, `Linked app ${app.playConsole.appId} does not show the name "${app.metadata.appName}".`);
    }
    await checkpoints.completeStep(appId, 'CREATE_APP', 'verify-linked');
    await log(appId, 'CREATE_APP', 'verify-linked', 'success', { message: `Linked app ${page.appId} verified.` });
  }

  // ---------------------------------------------------------------- stages
  async function haltWithError(appId, stageId, e) {
    const err = toPCAError(e);
    const target = classifyError(err.code) === 'fatal' ? STATES.FAILED : STATES.NEEDS_USER_ACTION;
    const requiredAction = (err.details && err.details.requiredAction) || { type: 'RESOLVE', stage: stageId };
    requiredAction.hint = USER_ACTION_HINTS[err.code] || 'Check the details, then resume.';
    if (err.details && !err.details.requiredAction) requiredAction.details = err.details;
    await checkpoints.transition(appId, target, { error: { code: err.code, message: err.message, requiredAction } });
    await log(appId, stageId, 'halt', target === STATES.FAILED ? 'failed' : 'needs_user_action', { errorCode: err.code, message: err.message });
  }

  async function doPause(appId) {
    pauseRequests.delete(appId);
    const { app } = await checkpoints.load(appId);
    const s = app.workflow.state;
    const pausable = isRunningState(s) || s === STATES.NEEDS_USER_ACTION || s === STATES.FAILED || s === STATES.READY_TO_START
      || (COMPLETED_STATES.includes(s) && s !== STATES.SUBMITTED);
    if (pausable) {
      await checkpoints.transition(appId, STATES.PAUSED, {
        mutate: (a, p) => {
          const interrupted = s === STATES.NEEDS_USER_ACTION || s === STATES.FAILED;
          p.pausedFrom = interrupted ? (getStage(p.stage) ? getStage(p.stage).active : STATES.READY_TO_START) : s;
        },
      });
      await log(appId, null, 'pause', 'info');
    }
  }

  async function runStage(appId, tabId, stage, settings) {
    try {
      const { app } = await checkpoints.load(appId);
      const v = validateApplication(app, { level: 'ready' });
      if (!v.valid) {
        throw new PCAError(ERROR_CODES.VALIDATION_FAILED, `Application data is incomplete: ${v.errors.slice(0, 3).map((x) => `${x.path}: ${x.message}`).join('; ')}`, { errors: v.errors });
      }
      if (stage.id === 'CREATE_APP' && app.playConsole.appId) {
        await verifyLinkedApp(appId, tabId, settings);
        return true;
      }
      if (stage.id !== 'CREATE_APP' && !app.playConsole.appId) {
        throw new PCAError(ERROR_CODES.IDENTITY_MISMATCH, 'This record is not linked to a Play Console app yet.');
      }
      const steps = STAGE_DEFINITIONS[stage.id].steps;
      for (let i = 0; i < steps.length; i++) {
        const { progress } = await checkpoints.load(appId);
        if ((progress.completedSteps[stage.id] || []).includes(steps[i].id)) continue;
        if (pauseRequests.has(appId)) throw PAUSE;
        const r = await runStep(appId, tabId, stage, steps[i], settings);
        if (r === 'restart-stage') i = -1;
      }
      return true;
    } catch (e) {
      if (e === PAUSE) { await doPause(appId); return false; }
      await haltWithError(appId, stage.id, e);
      return false;
    }
  }

  async function runLoop(appId, tabId) {
    const settings = await settingsRepo.get();
    for (;;) {
      const { app } = await checkpoints.load(appId);
      const state = app.workflow.state;
      if (pauseRequests.has(appId)) { await doPause(appId); return; }
      const stage = nextStageFor(state);
      if (!stage) return;
      if (stage.id === 'SUBMISSION') {
        if (state === STATES.READY_FOR_REVIEW) {
          await checkpoints.transition(appId, STATES.SUBMISSION_CONFIRMATION_REQUIRED, {
            mutate: (a, p) => {
              p.stage = 'SUBMISSION';
              p.requiredAction = { type: 'CONFIRM_SUBMISSION', hint: 'Review the summary and type the app name to send this app for review.' };
            },
          });
          await log(appId, 'SUBMISSION', 'await-confirmation', 'info');
          return;
        }
        if (!tokenValid(appId, tabId, app)) return;
      }
      if (state !== stage.active) {
        await checkpoints.transition(appId, stage.active, { mutate: (a, p) => { p.stage = stage.id; } });
        await log(appId, stage.id, 'stage-start', 'info');
      }
      const ok = await runStage(appId, tabId, stage, settings);
      if (!ok) return;
      await checkpoints.transition(appId, stage.done, {
        mutate: (a) => { a.workflow.lastCompletedStage = stage.id; a.workflow.lastVerifiedAt = clock().toISOString(); },
      });
      await log(appId, stage.id, 'stage-complete', 'success');
    }
  }

  function run(appId, tabId) {
    active.add(appId);
    const done = (async () => {
      try {
        await lock.acquire(appId, tabId);
        try {
          await runner.runExclusive(tabId, appId, () => runLoop(appId, tabId));
        } finally {
          await lock.release(appId);
        }
      } finally {
        active.delete(appId);
        pauseRequests.delete(appId);
      }
    })();
    return done;
  }

  async function snapshot(appId) {
    const { app, progress } = await checkpoints.load(appId);
    return { appId, state: app.workflow.state, workflow: app.workflow, progress, running: active.has(appId) || runner.busyApp(appId) };
  }

  /** Starts `done` and resolves once the lock is held (or fails). */
  async function launch(appId, tabId) {
    const holder = await lock.get();
    if (holder && holder.appId !== appId) throw new PCAError(ERROR_CODES.LOCKED, 'Another application is being automated. Pause or stop it first.', { lock: holder });
    if (runner.isBusy(tabId) || runner.busyApp(appId) || active.has(appId)) throw new PCAError(ERROR_CODES.LOCKED, 'Automation is already running for this tab or app.');
    const done = run(appId, tabId).catch(async (e) => {
      await log(appId, null, 'run', 'error', { errorCode: toPCAError(e).code, message: toPCAError(e).message });
    });
    return { ...(await snapshot(appId)), done };
  }

  // ---------------------------------------------------------------- public
  async function start(appId, tabId) {
    if (tabId === undefined || tabId === null) throw new PCAError(ERROR_CODES.NO_CONSOLE_TAB, USER_ACTION_HINTS.NO_CONSOLE_TAB);
    const { app } = await checkpoints.load(appId);
    const s = app.workflow.state;
    if (s !== STATES.DRAFT && s !== STATES.READY_TO_START) return resume(appId, tabId);
    await checkpoints.transition(appId, STATES.VALIDATING_DATA);
    const v = validateApplication((await checkpoints.load(appId)).app, { level: 'ready' });
    if (!v.valid) {
      await checkpoints.transition(appId, STATES.DRAFT, { error: { code: ERROR_CODES.VALIDATION_FAILED, message: `${v.errors.length} problem(s) must be fixed before starting.`, requiredAction: { type: 'FIX_DATA', errors: v.errors, hint: USER_ACTION_HINTS.VALIDATION_FAILED } } });
      await log(appId, null, 'validate', 'failed', { errorCode: ERROR_CODES.VALIDATION_FAILED, details: { count: v.errors.length } });
      return { ...(await snapshot(appId)), validation: v, done: Promise.resolve() };
    }
    await checkpoints.transition(appId, STATES.READY_TO_START);
    await log(appId, null, 'validate', 'success');
    return launch(appId, tabId);
  }

  async function resume(appId, tabId) {
    if (tabId === undefined || tabId === null) throw new PCAError(ERROR_CODES.NO_CONSOLE_TAB, USER_ACTION_HINTS.NO_CONSOLE_TAB);
    const { app, progress } = await checkpoints.load(appId);
    const s = app.workflow.state;
    if (s === STATES.DRAFT) return start(appId, tabId);
    if (s === STATES.SUBMITTED) return { ...(await snapshot(appId)), done: Promise.resolve() };
    if (s === STATES.SUBMISSION_CONFIRMATION_REQUIRED) {
      throw new PCAError(ERROR_CODES.SUBMISSION_NOT_CONFIRMED, 'This app is waiting for your submission confirmation in the dashboard.');
    }
    let target = null;
    if (s === STATES.PAUSED) target = progress.pausedFrom;
    else if (s === STATES.NEEDS_USER_ACTION || s === STATES.FAILED) target = progress.stage ? getStage(progress.stage).active : STATES.APP_CREATION_IN_PROGRESS;
    if (target && target !== s) {
      await checkpoints.transition(appId, target, { mutate: (a, p) => { p.pausedFrom = null; p.attempts = 0; } });
      await log(appId, progress.stage, 'resume', 'info', { message: `Resuming at ${target}` });
    }
    return launch(appId, tabId);
  }

  async function pause(appId) {
    if (active.has(appId) || runner.busyApp(appId)) {
      pauseRequests.add(appId);
      return { ...(await snapshot(appId)), pauseRequested: true };
    }
    const { app } = await checkpoints.load(appId);
    if (app.workflow.state !== STATES.PAUSED && app.workflow.state !== STATES.SUBMISSION_CONFIRMATION_REQUIRED) await doPause(appId);
    return snapshot(appId);
  }

  async function approvePlan(appId, planHash, tabId) {
    const { progress } = await checkpoints.load(appId);
    const ra = progress.requiredAction;
    if (!ra || ra.type !== 'APPROVE_PLAN' || ra.planHash !== planHash) {
      throw new PCAError(ERROR_CODES.APPROVAL_REQUIRED, 'This plan is not the one awaiting approval; reload the dashboard.');
    }
    await checkpoints.updateProgress(appId, (p) => { p.approvals = { ...p.approvals, [`${ra.stage}:${ra.step}`]: planHash }; });
    await log(appId, ra.stage, `${ra.step}:approve`, 'info');
    return resume(appId, tabId);
  }

  async function allowDuplicateName(appId, tabId) {
    await checkpoints.updateProgress(appId, (p) => { p.allowDuplicateName = true; });
    await log(appId, 'CREATE_APP', 'allow-duplicate-name', 'info');
    return resume(appId, tabId);
  }

  /** Links the record to the app open in the tab (user-confirmed in the UI). */
  async function linkCurrentApp(appId, tabId) {
    const { app } = await checkpoints.load(appId);
    const settings = await settingsRepo.get();
    const page = await detect(tabId, app.metadata.appName, settings.stepTimeoutMs);
    if (!page || !page.appId || !page.ready) throw new PCAError(ERROR_CODES.WRONG_PAGE, 'Open the app\'s dashboard (or any page of that app) in Play Console first.');
    if (!page.appNameShown) throw new PCAError(ERROR_CODES.IDENTITY_MISMATCH, `The open app does not show the name "${app.metadata.appName}".`);
    const others = (await appRepo.list()).filter((a) => a.id !== appId && a.playConsole.appId === page.appId);
    if (others.length) throw new PCAError(ERROR_CODES.IDENTITY_MISMATCH, `Play Console app ${page.appId} is already linked to "${others[0].metadata.appName}".`);
    await checkpoints.updateProgress(appId, (p, a) => {
      a.playConsole = { developerId: page.developerId, appId: page.appId, linkedAt: clock().toISOString() };
      p.playConsoleAppId = page.appId;
      p.developerId = page.developerId;
    });
    await log(appId, 'CREATE_APP', 'link', 'success', { message: `Linked to Play Console app ${page.appId}` });
    return snapshot(appId);
  }

  async function confirmSubmission(appId, typedName, tabId) {
    const { app, progress } = await checkpoints.load(appId);
    if (app.workflow.state !== STATES.SUBMISSION_CONFIRMATION_REQUIRED) throw new PCAError(ERROR_CODES.SUBMISSION_NOT_CONFIRMED, 'This app is not waiting for submission.');
    if (typeof typedName !== 'string' || typedName.trim() !== app.metadata.appName) throw new PCAError(ERROR_CODES.SUBMISSION_NOT_CONFIRMED, 'The typed name does not match this app\'s name exactly.');
    if (!progress.readiness || !progress.readiness['publishing-overview']) throw new PCAError(ERROR_CODES.READINESS_ISSUES, 'Run the readiness check before submitting.');
    submissionTokens.set(appId, { token: randomToken(), tabId, playConsoleAppId: app.playConsole.appId, expiresAt: now() + SUBMISSION_TOKEN_TTL_MS });
    await log(appId, 'SUBMISSION', 'confirm', 'info', { message: 'User confirmed submission.' });
    return launch(appId, tabId);
  }

  async function cancelSubmission(appId) {
    submissionTokens.delete(appId);
    const { app } = await checkpoints.load(appId);
    if (app.workflow.state === STATES.SUBMISSION_CONFIRMATION_REQUIRED) {
      await checkpoints.transition(appId, STATES.READY_FOR_REVIEW, { note: 'submission cancelled by user' });
      await log(appId, 'SUBMISSION', 'cancel', 'info');
    }
    return snapshot(appId);
  }

  /**
   * mode 'draft': back to DRAFT (Play Console link and click guards kept).
   * mode 'checkpoint': back to the last verified stage boundary.
   */
  async function reset(appId, mode) {
    if (active.has(appId) || runner.busyApp(appId)) throw new PCAError(ERROR_CODES.LOCKED, 'Pause the automation before resetting.');
    submissionTokens.delete(appId);
    const { app } = await checkpoints.load(appId);
    if (mode === 'draft') {
      await checkpoints.reset(appId, 'draft');
    } else {
      const last = app.workflow.lastCompletedStage;
      const state = last ? getStage(last).done : STATES.READY_TO_START;
      const idx = last ? STAGES.findIndex((s) => s.id === last) + 1 : 0;
      await checkpoints.reset(appId, { state, clearStage: STAGES[idx] ? STAGES[idx].id : null });
    }
    await log(appId, null, 'reset', 'info', { message: mode });
    return snapshot(appId);
  }

  /** Called when the service worker starts: no job can be running yet. */
  async function recoverOnStartup() {
    await lock.release();
    const apps = await appRepo.list();
    const recovered = [];
    for (const a of apps) {
      if (isRunningState(a.workflow.state)) {
        const from = a.workflow.state;
        await checkpoints.transition(a.id, STATES.PAUSED, {
          error: { code: ERROR_CODES.INTERRUPTED, message: 'Automation was interrupted by an extension or browser restart.', requiredAction: { type: 'RESUME_AFTER_INTERRUPTION', hint: USER_ACTION_HINTS.INTERRUPTED } },
          mutate: (x, p) => { p.pausedFrom = from; },
        });
        await log(a.id, null, 'recover', 'info', { message: `Paused after restart (was ${from}).` });
        recovered.push(a.id);
      }
    }
    return recovered;
  }

  /** Content-side progress during a long step (e.g. graphics uploaded). */
  async function recordStepProgress(appId, tabId, data) {
    if (!(await lock.holds(appId, tabId))) throw new PCAError(ERROR_CODES.MESSAGE_REJECTED, 'Progress from a tab that is not running this app.');
    if (data.stage === 'STORE_LISTING' && typeof data.uploaded === 'string') {
      await checkpoints.updateProgress(appId, (p) => {
        const list = new Set(p.guards['STORE_LISTING:uploaded'] || []);
        list.add(data.uploaded);
        p.guards = { ...p.guards, 'STORE_LISTING:uploaded': [...list] };
      });
    }
  }

  return {
    start, resume, pause, stop: pause, approvePlan, allowDuplicateName, linkCurrentApp,
    confirmSubmission, cancelSubmission, reset, recoverOnStartup, recordStepProgress, status: snapshot,
  };
}
