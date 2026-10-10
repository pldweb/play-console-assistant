/**
 * Content-side request handler. Executes only the step operations the
 * workflow engine asks for, on the current document, and always returns a
 * structured { ok, ... } result. Pure with respect to its inputs so it can
 * run against jsdom in tests.
 */
import { detectPage, pageShowsAppName } from './page-detector.js';
import { getStep } from '../adapters/index.js';
import { errorPayload, PCAError, ERROR_CODES } from '../services/errors.js';

const HEARTBEAT_MS = 20000;

export const CONTENT_MESSAGE_TYPES = Object.freeze(['PCA_DETECT', 'PCA_INSPECT', 'PCA_APPLY', 'PCA_VERIFY', 'PCA_PING']);

/**
 * @param {object} env
 * @param {Document} env.document
 * @param {() => string} env.getHref
 * @param {(assetId:string, appId:string) => Promise<File>} env.getAsset
 * @param {(data:object) => Promise<void>} [env.reportProgress]
 */
export function createContentHandler(env) {
  let busy = false;

  return async function handle(msg) {
    if (!msg || typeof msg !== 'object' || !CONTENT_MESSAGE_TYPES.includes(msg.type)) {
      return { ok: false, error: errorPayload(new PCAError(ERROR_CODES.MESSAGE_REJECTED, 'Unsupported request.')) };
    }
    if (msg.type === 'PCA_PING') return { ok: true, pong: true };
    const root = env.document.body;
    const page = detectPage(env.document, env.getHref());
    if (msg.type === 'PCA_DETECT') {
      if (typeof msg.appName === 'string' && msg.appName) page.appNameShown = pageShowsAppName(env.document, msg.appName);
      return { ok: true, page };
    }

    const { stage, step: stepId, payload, expectedPage, appId } = msg;
    try {
      const step = getStep(stage, stepId);
      // Re-check page type at execution time; the tab may have navigated.
      if (page.pageType !== step.page || (expectedPage && expectedPage.appId && page.appId !== expectedPage.appId)) {
        throw new PCAError(ERROR_CODES.WRONG_PAGE, `Expected ${step.page}${expectedPage && expectedPage.appId ? ` for app ${expectedPage.appId}` : ''}, found ${page.pageType}${page.appId ? ` for app ${page.appId}` : ''}.`, { page });
      }
      if (!page.ready) throw new PCAError(ERROR_CODES.WAIT_TIMEOUT, 'Page has not finished rendering.');
      if (msg.type === 'PCA_INSPECT') {
        const report = await step.inspect(root, payload);
        return { ok: true, page, report: { fields: [], blocking: [], notes: [], ...report } };
      }
      if (msg.type === 'PCA_VERIFY') {
        return { ok: true, page, verify: await step.verify(root, payload) };
      }
      // PCA_APPLY: one write operation at a time per tab.
      if (busy) throw new PCAError(ERROR_CODES.LOCKED, 'Another action is already running in this tab.');
      busy = true;
      // Long applies (uploads, bundle processing) send periodic progress
      // messages so the service worker sees activity and is not stopped idle.
      const heartbeat = env.reportProgress
        ? setInterval(() => { env.reportProgress({ appId, stage, step: stepId, heartbeat: true }); }, HEARTBEAT_MS)
        : null;
      try {
        const ctx = {
          stepTimeoutMs: msg.stepTimeoutMs,
          uploadTimeoutMs: msg.uploadTimeoutMs,
          getAsset: (assetId) => env.getAsset(assetId, appId),
          reportProgress: env.reportProgress ? (data) => env.reportProgress({ appId, stage, step: stepId, ...data }) : null,
        };
        const result = await step.apply(root, payload, ctx);
        return { ok: true, page, result };
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        busy = false;
      }
    } catch (e) {
      return { ok: false, page, error: errorPayload(e) };
    }
  };
}
