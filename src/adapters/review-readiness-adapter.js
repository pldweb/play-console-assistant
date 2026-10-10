/**
 * Review readiness and submission.
 *
 * REVIEW_READINESS (read-only):
 *  - dashboard-tasks     (APP_DASHBOARD)       outstanding "Set up your app" tasks.
 *  - publishing-overview (PUBLISHING_OVERVIEW) errors/warnings, testing gate,
 *                                              availability of the send action.
 *
 * SUBMISSION (only after explicit confirmation, enforced by the engine with
 * a single-use token; the content side additionally requires `confirmed`):
 *  - send-for-review     (PUBLISHING_OVERVIEW) click the send button and the
 *                                              confirmation dialog button
 *                                              once, then verify "in review".
 *
 * Labels are UNVERIFIED (docs/SELECTOR_MAP.md).
 */
import { defineStage, blocking } from './base-adapter.js';
import { PAGE_TYPES } from '../content/page-detector.js';
import { getSection, normalize, isVisible, queryButtons, getButton, clickElement, waitFor, pageHasText, collectValidationErrors } from '../content/dom-utils.js';
import { PCAError, ERROR_CODES } from '../services/errors.js';

export const SEND_FOR_REVIEW = /^Send (\d+ )?changes? for review$/i;
export const DIALOG_CONFIRM = /^Send changes for review$/i;
export const IN_REVIEW = /\b(changes? )?(are )?in review\b/i;
export const TESTING_GATE = /(12 testers|closed test).*(14 days|production)|apply for production/i;

function listItems(section) {
  return [...section.querySelectorAll('[role=listitem],li')].filter(isVisible).map((el) => normalize(el.textContent)).filter(Boolean);
}

function optionalSection(root, title) {
  try {
    return getSection(root, title);
  } catch {
    return null;
  }
}

/** Read-only summary of the publishing overview. */
export function readPublishingOverview(root) {
  const errorsSection = optionalSection(root, /^Errors?$/i);
  const warningsSection = optionalSection(root, /^Warnings?$/i);
  const alerts = collectValidationErrors(root).map((e) => e.message);
  const errors = [...new Set([...(errorsSection ? listItems(errorsSection) : []), ...alerts])];
  const warnings = warningsSection ? listItems(warningsSection) : [];
  const sendButtons = queryButtons(root, SEND_FOR_REVIEW);
  return {
    errors,
    warnings,
    sendAvailable: sendButtons.length === 1 && !sendButtons[0].disabled && sendButtons[0].getAttribute('aria-disabled') !== 'true',
    sendButtonCount: sendButtons.length,
    sendLabel: sendButtons[0] ? normalize(sendButtons[0].textContent) : null,
    testingGate: pageHasText(root, TESTING_GATE),
    inReview: pageHasText(root, IN_REVIEW),
  };
}

export const reviewReadinessStage = defineStage('REVIEW_READINESS', [
  {
    id: 'dashboard-tasks',
    page: PAGE_TYPES.APP_DASHBOARD,
    readOnly: true,
    buildPayload: () => ({}),
    inspect(root) {
      const r = { fields: [], blocking: [], notes: ['Read-only check of the dashboard setup tasks.'], summary: {} };
      const section = optionalSection(root, /^Set up your app$/i);
      if (!section) {
        r.notes.push('No "Set up your app" task list is shown on the dashboard.');
        r.summary.outstandingTasks = [];
        return r;
      }
      const tasks = [...section.querySelectorAll('[role=listitem],li')].filter(isVisible);
      // A task counts as done only when its label STARTS with "Completed"
      // ("Not completed: ..." must stay outstanding).
      const isDone = (t) => /^(completed|done)\b/i.test(t.getAttribute('aria-label') || '') || Boolean(t.querySelector('[aria-label="Completed" i]'));
      const outstanding = tasks.filter((t) => !isDone(t))
        .map((t) => normalize((t.querySelector('h3,[role=heading],a') || t).textContent));
      r.summary.outstandingTasks = outstanding;
      if (outstanding.length) r.blocking.push(blocking(ERROR_CODES.READINESS_ISSUES, `Dashboard tasks still open: ${outstanding.join(', ')}.`, { outstanding }));
      return r;
    },
    apply: () => ({ applied: [] }),
    verify(root) {
      const r = this.inspect(root);
      return { ok: r.blocking.length === 0, mismatches: r.blocking.map((b) => ({ field: 'tasks', message: b.message })), summary: r.summary };
    },
  },
  {
    id: 'publishing-overview',
    page: PAGE_TYPES.PUBLISHING_OVERVIEW,
    readOnly: true,
    buildPayload: () => ({}),
    inspect(root) {
      const s = readPublishingOverview(root);
      const r = { fields: [], blocking: [], notes: ['Read-only. Nothing is sent for review in this stage.'], summary: s };
      if (s.errors.length) r.blocking.push(blocking(ERROR_CODES.READINESS_ISSUES, `Play Console lists errors: ${s.errors.join('; ')}`, { errors: s.errors }));
      if (s.testingGate) r.notes.push('Play Console mentions the closed-testing requirement for production access. The extension cannot and will not bypass it.');
      if (s.inReview) r.notes.push('Play Console already shows changes in review.');
      if (!s.sendAvailable && !s.inReview) r.blocking.push(blocking(ERROR_CODES.READINESS_ISSUES, s.sendButtonCount > 1 ? 'More than one send-for-review action is visible.' : 'No "Send changes for review" action is available yet.'));
      return r;
    },
    apply: () => ({ applied: [] }),
    verify(root) {
      const r = this.inspect(root);
      return { ok: r.blocking.length === 0, mismatches: r.blocking.map((b) => ({ field: 'publishing', message: b.message })), summary: r.summary };
    },
  },
]);

export const submissionStage = defineStage('SUBMISSION', [
  {
    id: 'send-for-review',
    page: PAGE_TYPES.PUBLISHING_OVERVIEW,
    idempotent: false,
    onUncertain: 'reinspect',
    verifyAfterReload: true,
    approval: false, // replaced by the typed submission confirmation
    requiresConfirmation: true,
    buildPayload: (app, ctx = {}) => ({ confirmed: Boolean(ctx.submissionConfirmed), appName: app.metadata.appName }),
    inspect(root) {
      const s = readPublishingOverview(root);
      const r = { fields: [], blocking: [], notes: [], summary: s };
      if (s.inReview) { r.notes.push('Changes are already in review; nothing will be clicked.'); return r; }
      if (s.errors.length) r.blocking.push(blocking(ERROR_CODES.READINESS_ISSUES, `Play Console lists errors: ${s.errors.join('; ')}`));
      if (!s.sendAvailable) r.blocking.push(blocking(ERROR_CODES.ELEMENT_NOT_FOUND, 'The send-for-review action is not available.'));
      r.fields.push({ key: 'send', label: s.sendLabel || 'Send changes for review', kind: 'button', status: s.sendAvailable ? 'found' : 'missing', willChange: true });
      return r;
    },
    async apply(root, p, ctx = {}) {
      if (!p.confirmed) throw new PCAError(ERROR_CODES.SUBMISSION_NOT_CONFIRMED, 'Submission was not confirmed for this app.');
      const r = this.inspect(root);
      if (r.summary.inReview) return { clicked: false, alreadyInReview: true };
      if (r.blocking.length) throw new PCAError(r.blocking[0].code, r.blocking[0].message);
      clickElement(getButton(root, SEND_FOR_REVIEW));
      // A confirmation dialog may follow; it is part of the same confirmed action.
      const dialogButton = await waitFor(() => {
        const dialogs = [...root.ownerDocument.querySelectorAll('[role=dialog],[role=alertdialog],dialog[open]')].filter(isVisible);
        for (const d of dialogs) {
          const b = queryButtons(d, DIALOG_CONFIRM);
          if (b.length === 1) return b[0];
        }
        return pageHasText(root, IN_REVIEW) ? 'none' : null;
      }, { timeout: ctx.stepTimeoutMs || 15000, description: 'review confirmation dialog' });
      if (dialogButton !== 'none') clickElement(dialogButton);
      // The resulting status is verified by the engine after a reload.
      return { clicked: true };
    },
    verify(root) {
      const ok = pageHasText(root, IN_REVIEW);
      return { ok, mismatches: ok ? [] : [{ field: 'status', message: 'Play Console does not show the changes as in review.' }] };
    },
  },
]);
