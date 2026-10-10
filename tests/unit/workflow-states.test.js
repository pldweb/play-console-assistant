import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATES, STAGES, TRANSITIONS, canTransition, assertTransition, nextStageFor, isRunningState,
} from '../../src/automation/workflow-states.js';

test('every state has a transition entry', () => {
  for (const s of Object.values(STATES)) assert.ok(Array.isArray(TRANSITIONS[s]), s);
});

test('happy path transitions are legal in order', () => {
  const path = [
    'DRAFT', 'VALIDATING_DATA', 'READY_TO_START', 'APP_CREATION_IN_PROGRESS', 'APP_CREATED',
    'STORE_LISTING_IN_PROGRESS', 'STORE_LISTING_COMPLETED', 'APP_CONTENT_IN_PROGRESS', 'APP_CONTENT_COMPLETED',
    'RELEASE_IN_PROGRESS', 'RELEASE_READY', 'REVIEW_READINESS_CHECK', 'READY_FOR_REVIEW',
    'SUBMISSION_CONFIRMATION_REQUIRED', 'SUBMITTED',
  ];
  for (let i = 0; i < path.length - 1; i++) assert.ok(canTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`);
});

test('stages cannot be skipped', () => {
  assert.equal(canTransition('DRAFT', 'APP_CREATION_IN_PROGRESS'), false);
  assert.equal(canTransition('APP_CREATED', 'RELEASE_IN_PROGRESS'), false);
  assert.equal(canTransition('READY_FOR_REVIEW', 'SUBMITTED'), false);
  assert.equal(canTransition('RELEASE_READY', 'SUBMISSION_CONFIRMATION_REQUIRED'), false);
});

test('SUBMITTED is terminal', () => {
  assert.deepEqual(TRANSITIONS.SUBMITTED, []);
});

test('submission can only be reached from the confirmation state', () => {
  const sources = Object.entries(TRANSITIONS).filter(([, to]) => to.includes('SUBMITTED')).map(([from]) => from);
  assert.deepEqual(sources, ['SUBMISSION_CONFIRMATION_REQUIRED']);
});

test('cancelling the confirmation returns to READY_FOR_REVIEW', () => {
  assert.ok(canTransition('SUBMISSION_CONFIRMATION_REQUIRED', 'READY_FOR_REVIEW'));
});

test('in-progress states can be interrupted', () => {
  for (const st of STAGES.slice(0, 5)) {
    for (const t of ['PAUSED', 'NEEDS_USER_ACTION', 'FAILED']) assert.ok(canTransition(st.active, t), `${st.active} -> ${t}`);
  }
});

test('assertTransition throws a classified error', () => {
  assert.throws(() => assertTransition('DRAFT', 'SUBMITTED'), (e) => e.code === 'INVALID_TRANSITION');
});

test('nextStageFor walks the stages', () => {
  assert.equal(nextStageFor('READY_TO_START').id, 'CREATE_APP');
  assert.equal(nextStageFor('APP_CREATED').id, 'STORE_LISTING');
  assert.equal(nextStageFor('RELEASE_IN_PROGRESS').id, 'RELEASE');
  assert.equal(nextStageFor('READY_FOR_REVIEW').id, 'SUBMISSION');
  assert.equal(nextStageFor('SUBMITTED'), null);
  assert.equal(nextStageFor('DRAFT'), null);
});

test('running states exclude the confirmation wait', () => {
  assert.equal(isRunningState('STORE_LISTING_IN_PROGRESS'), true);
  assert.equal(isRunningState('SUBMISSION_CONFIRMATION_REQUIRED'), false);
  assert.equal(isRunningState('PAUSED'), false);
});
