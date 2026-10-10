/**
 * Internal workflow states and the legal transition table.
 *
 * These are extension-internal states. They are NOT Google Play Console
 * status names and must not be presented as such in the UI.
 */
import { PCAError, ERROR_CODES } from '../services/errors.js';

export const STATES = Object.freeze({
  DRAFT: 'DRAFT',
  VALIDATING_DATA: 'VALIDATING_DATA',
  READY_TO_START: 'READY_TO_START',
  APP_CREATION_IN_PROGRESS: 'APP_CREATION_IN_PROGRESS',
  APP_CREATED: 'APP_CREATED',
  STORE_LISTING_IN_PROGRESS: 'STORE_LISTING_IN_PROGRESS',
  STORE_LISTING_COMPLETED: 'STORE_LISTING_COMPLETED',
  APP_CONTENT_IN_PROGRESS: 'APP_CONTENT_IN_PROGRESS',
  APP_CONTENT_COMPLETED: 'APP_CONTENT_COMPLETED',
  RELEASE_IN_PROGRESS: 'RELEASE_IN_PROGRESS',
  RELEASE_READY: 'RELEASE_READY',
  REVIEW_READINESS_CHECK: 'REVIEW_READINESS_CHECK',
  READY_FOR_REVIEW: 'READY_FOR_REVIEW',
  SUBMISSION_CONFIRMATION_REQUIRED: 'SUBMISSION_CONFIRMATION_REQUIRED',
  SUBMITTED: 'SUBMITTED',
  PAUSED: 'PAUSED',
  NEEDS_USER_ACTION: 'NEEDS_USER_ACTION',
  FAILED: 'FAILED',
});

const S = STATES;

/**
 * Ordered stages. `active` is the state while the stage runs, `done` is the
 * state recorded only after the stage has been verified.
 */
export const STAGES = Object.freeze([
  { id: 'CREATE_APP', label: 'Create app', active: S.APP_CREATION_IN_PROGRESS, done: S.APP_CREATED },
  { id: 'STORE_LISTING', label: 'Store listing', active: S.STORE_LISTING_IN_PROGRESS, done: S.STORE_LISTING_COMPLETED },
  { id: 'APP_CONTENT', label: 'App content', active: S.APP_CONTENT_IN_PROGRESS, done: S.APP_CONTENT_COMPLETED },
  { id: 'RELEASE', label: 'Release', active: S.RELEASE_IN_PROGRESS, done: S.RELEASE_READY },
  { id: 'REVIEW_READINESS', label: 'Review readiness', active: S.REVIEW_READINESS_CHECK, done: S.READY_FOR_REVIEW },
  { id: 'SUBMISSION', label: 'Submission', active: S.SUBMISSION_CONFIRMATION_REQUIRED, done: S.SUBMITTED },
]);

export const STAGE_IDS = STAGES.map((s) => s.id);

export function getStage(stageId) {
  return STAGES.find((s) => s.id === stageId) || null;
}

/** Stage that should run next when the workflow sits in `state`. */
export function nextStageFor(state) {
  if (state === S.READY_TO_START) return STAGES[0];
  const idx = STAGES.findIndex((s) => s.done === state);
  if (idx >= 0) return STAGES[idx + 1] || null;
  const activeIdx = STAGES.findIndex((s) => s.active === state);
  if (activeIdx >= 0) return STAGES[activeIdx];
  return null;
}

export const ACTIVE_STATES = Object.freeze(STAGES.map((s) => s.active));
export const COMPLETED_STATES = Object.freeze(STAGES.map((s) => s.done));
const INTERRUPT = [S.PAUSED, S.NEEDS_USER_ACTION, S.FAILED];

/** States in which automation is considered to be running. */
export function isRunningState(state) {
  return ACTIVE_STATES.includes(state) && state !== S.SUBMISSION_CONFIRMATION_REQUIRED;
}

/** States in which application data may be edited by the user. */
export const EDITABLE_STATES = Object.freeze([
  S.DRAFT, S.VALIDATING_DATA, S.READY_TO_START, S.PAUSED, S.NEEDS_USER_ACTION, S.FAILED,
  ...COMPLETED_STATES.filter((s) => s !== S.SUBMITTED),
]);

const T = {
  [S.DRAFT]: [S.VALIDATING_DATA],
  [S.VALIDATING_DATA]: [S.READY_TO_START, S.DRAFT],
  [S.READY_TO_START]: [S.APP_CREATION_IN_PROGRESS, S.DRAFT, S.VALIDATING_DATA, S.PAUSED],
  [S.APP_CREATION_IN_PROGRESS]: [S.APP_CREATED, ...INTERRUPT],
  [S.APP_CREATED]: [S.STORE_LISTING_IN_PROGRESS, S.PAUSED],
  [S.STORE_LISTING_IN_PROGRESS]: [S.STORE_LISTING_COMPLETED, ...INTERRUPT],
  [S.STORE_LISTING_COMPLETED]: [S.APP_CONTENT_IN_PROGRESS, S.PAUSED],
  [S.APP_CONTENT_IN_PROGRESS]: [S.APP_CONTENT_COMPLETED, ...INTERRUPT],
  [S.APP_CONTENT_COMPLETED]: [S.RELEASE_IN_PROGRESS, S.PAUSED],
  [S.RELEASE_IN_PROGRESS]: [S.RELEASE_READY, ...INTERRUPT],
  [S.RELEASE_READY]: [S.REVIEW_READINESS_CHECK, S.PAUSED],
  [S.REVIEW_READINESS_CHECK]: [S.READY_FOR_REVIEW, ...INTERRUPT],
  [S.READY_FOR_REVIEW]: [S.SUBMISSION_CONFIRMATION_REQUIRED, S.REVIEW_READINESS_CHECK, S.PAUSED],
  // Cancelling the confirmation returns to READY_FOR_REVIEW.
  [S.SUBMISSION_CONFIRMATION_REQUIRED]: [S.SUBMITTED, S.READY_FOR_REVIEW, S.NEEDS_USER_ACTION, S.FAILED],
  [S.SUBMITTED]: [],
  // Resume targets are restricted further by the engine (must equal the
  // state recorded when the workflow was interrupted).
  [S.PAUSED]: [...ACTIVE_STATES, ...COMPLETED_STATES.filter((s) => s !== S.SUBMITTED), S.READY_TO_START],
  [S.NEEDS_USER_ACTION]: [...ACTIVE_STATES, S.PAUSED, S.FAILED, S.READY_FOR_REVIEW],
  [S.FAILED]: [...ACTIVE_STATES, S.PAUSED],
};

export const TRANSITIONS = Object.freeze(Object.fromEntries(
  Object.entries(T).map(([k, v]) => [k, Object.freeze([...new Set(v)])]),
));

export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new PCAError(ERROR_CODES.INVALID_TRANSITION, `Illegal workflow transition ${from} -> ${to}`, { from, to });
  }
}

/** Human labels for internal states (explicitly extension-internal). */
export const STATE_LABELS = Object.freeze({
  DRAFT: 'Draft',
  VALIDATING_DATA: 'Validating data',
  READY_TO_START: 'Ready to start',
  APP_CREATION_IN_PROGRESS: 'Creating app',
  APP_CREATED: 'App created',
  STORE_LISTING_IN_PROGRESS: 'Filling store listing',
  STORE_LISTING_COMPLETED: 'Store listing done',
  APP_CONTENT_IN_PROGRESS: 'Filling app content',
  APP_CONTENT_COMPLETED: 'App content done',
  RELEASE_IN_PROGRESS: 'Preparing release',
  RELEASE_READY: 'Release prepared',
  REVIEW_READINESS_CHECK: 'Checking readiness',
  READY_FOR_REVIEW: 'Ready for review',
  SUBMISSION_CONFIRMATION_REQUIRED: 'Awaiting your submit confirmation',
  SUBMITTED: 'Submitted (verified)',
  PAUSED: 'Paused',
  NEEDS_USER_ACTION: 'Needs your action',
  FAILED: 'Failed',
});
