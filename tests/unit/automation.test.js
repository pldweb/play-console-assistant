import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRetryPolicy, backoffDelay } from '../../src/automation/retry-policy.js';
import { createExecutionLock } from '../../src/automation/execution-lock.js';
import { createTaskRunner } from '../../src/automation/task-runner.js';
import { createCheckpointManager } from '../../src/automation/checkpoint-manager.js';
import { createApplicationRepository } from '../../src/data/application-repository.js';
import { PCAError, classifyError, toPCAError, errorPayload, isRetryable, ERROR_CODES } from '../../src/services/errors.js';
import { createStorageArea } from '../mocks/chrome.js';

const noSleep = () => Promise.resolve();

test('error classification', () => {
  assert.equal(classifyError('WAIT_TIMEOUT'), 'retryable');
  assert.equal(classifyError('SESSION_EXPIRED'), 'userAction');
  assert.equal(classifyError('VALIDATION_FAILED'), 'fatal');
  assert.equal(classifyError('SOMETHING_ELSE'), 'fatal');
  assert.equal(isRetryable('ACTION_TIMEOUT'), true);
  assert.equal(isRetryable('UNKNOWN_QUESTION'), false);
  for (const code of Object.keys(ERROR_CODES)) assert.ok(['retryable', 'userAction', 'fatal'].includes(classifyError(code)));
  const e = toPCAError(new Error('boom'));
  assert.equal(e.code, 'UNEXPECTED');
  assert.deepEqual(errorPayload(new PCAError('UNKNOWN_PAGE', 'x', { a: 1 })), { code: 'UNKNOWN_PAGE', message: 'x', details: { a: 1 } });
  assert.equal(toPCAError({ code: 'LOCKED', message: 'm' }).code, 'LOCKED');
});

test('retry policy retries only retryable errors on idempotent operations', async () => {
  const p = createRetryPolicy({ retryLimit: 2, sleep: noSleep });
  let n = 0;
  const r = await p.run(async () => { n += 1; if (n < 3) throw new PCAError('WAIT_TIMEOUT', 't'); return 'ok'; });
  assert.deepEqual([r.value, r.attempts], ['ok', 3]);

  n = 0;
  await assert.rejects(p.run(async () => { n += 1; throw new PCAError('WAIT_TIMEOUT', 't'); }), (e) => e.code === 'WAIT_TIMEOUT');
  assert.equal(n, 3, 'initial attempt + 2 retries');

  n = 0;
  await assert.rejects(p.run(async () => { n += 1; throw new PCAError('UNKNOWN_QUESTION', 'q'); }));
  assert.equal(n, 1, 'non-retryable errors are not retried');

  n = 0;
  await assert.rejects(p.run(async () => { n += 1; throw new PCAError('ACTION_TIMEOUT', 't'); }, { idempotent: false }));
  assert.equal(n, 1, 'non-idempotent operations are never retried');
});

test('retry policy checks the page before repeating', async () => {
  const p = createRetryPolicy({ retryLimit: 2, sleep: noSleep });
  let n = 0;
  const r = await p.run(async () => { n += 1; throw new PCAError('ACTION_TIMEOUT', 't'); }, { beforeRetry: async () => 'done' });
  assert.equal(n, 1);
  assert.equal(r.recovered, true);
  await assert.rejects(p.run(async () => { throw new PCAError('ACTION_TIMEOUT', 't'); }, { beforeRetry: async () => 'stop' }));
  assert.equal(backoffDelay(1, 100), 100);
  assert.equal(backoffDelay(3, 100), 400);
});

test('execution lock: one application at a time, one tab per application', async () => {
  const lock = createExecutionLock({ storage: createStorageArea() });
  await lock.acquire('a', 1);
  await lock.acquire('a', 1); // re-entrant for same app/tab
  await assert.rejects(lock.acquire('b', 2), (e) => e.code === 'LOCKED');
  await assert.rejects(lock.acquire('a', 2), (e) => e.code === 'LOCKED');
  assert.equal(await lock.holds('a', 1), true);
  assert.equal(await lock.holds('a', 2), false);
  await lock.release('b'); // not the holder: no effect
  assert.equal(await lock.holds('a'), true);
  await lock.release('a');
  await lock.acquire('b', 2);
});

test('task runner rejects a second job on the same tab', async () => {
  const runner = createTaskRunner();
  let release;
  const first = runner.runExclusive(1, 'a', () => new Promise((r) => { release = r; }));
  await assert.rejects(runner.runExclusive(1, 'b', async () => 'x'), (e) => e.code === 'LOCKED');
  assert.equal(runner.isBusy(1), true);
  assert.equal(runner.busyApp('a'), true);
  const other = await runner.runExclusive(2, 'c', async () => 'other tab ok');
  assert.equal(other, 'other tab ok');
  release('done');
  assert.equal(await first, 'done');
  assert.equal(runner.isBusy(1), false);
});

test('checkpoint manager: atomic app+progress writes, legal transitions, history', async () => {
  const storage = createStorageArea();
  const apps = createApplicationRepository({ storage });
  const cp = createCheckpointManager({ storage });
  const a = await apps.create({ metadata: { packageName: 'com.acme.x' } });
  await cp.transition(a.id, 'VALIDATING_DATA');
  await assert.rejects(cp.transition(a.id, 'SUBMITTED'), (e) => e.code === 'INVALID_TRANSITION');
  await cp.transition(a.id, 'READY_TO_START');
  await cp.transition(a.id, 'APP_CREATION_IN_PROGRESS', { mutate: (x, p) => { p.stage = 'CREATE_APP'; } });
  await cp.completeStep(a.id, 'CREATE_APP', 'fill-form');
  await cp.transition(a.id, 'NEEDS_USER_ACTION', { error: { code: 'UNKNOWN_PAGE', message: 'm', requiredAction: { type: 'RESOLVE' } } });
  const { app, progress } = await cp.load(a.id);
  assert.equal(app.workflow.state, 'NEEDS_USER_ACTION');
  assert.equal(progress.state, 'NEEDS_USER_ACTION');
  assert.equal(app.workflow.errorCode, 'UNKNOWN_PAGE');
  assert.equal(progress.requiredAction.type, 'RESOLVE');
  assert.equal(progress.targetPackageName, 'com.acme.x');
  assert.deepEqual(progress.completedSteps.CREATE_APP, ['fill-form']);
  assert.equal(progress.lastVerifiedCheckpoint.step, 'fill-form');
  assert.deepEqual(progress.history.map((x) => x.to), ['VALIDATING_DATA', 'READY_TO_START', 'APP_CREATION_IN_PROGRESS', 'NEEDS_USER_ACTION']);
  // Clearing the error on the next transition.
  await cp.transition(a.id, 'APP_CREATION_IN_PROGRESS');
  assert.equal((await cp.load(a.id)).app.workflow.errorCode, null);
});

test('checkpoint reset keeps click guards', async () => {
  const storage = createStorageArea();
  const apps = createApplicationRepository({ storage });
  const cp = createCheckpointManager({ storage });
  const a = await apps.create();
  await cp.updateProgress(a.id, (p) => { p.guards = { 'CREATE_APP:submit-create': 't' }; p.completedSteps = { CREATE_APP: ['precheck'] }; });
  await cp.reset(a.id, 'draft');
  const { app, progress } = await cp.load(a.id);
  assert.equal(app.workflow.state, 'DRAFT');
  assert.deepEqual(progress.completedSteps, {});
  assert.equal(progress.guards['CREATE_APP:submit-create'], 't');
  assert.ok(progress.history.at(-1).forced);
});
