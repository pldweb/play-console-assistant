import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStorageArea, fixedClock } from '../mocks/chrome.js';
import { createApplicationRepository } from '../../src/data/application-repository.js';
import { createProgressRepository } from '../../src/data/progress-repository.js';
import { createSettingsRepository, DEFAULT_SETTINGS } from '../../src/data/settings-repository.js';
import { createLogger, redact } from '../../src/services/logger.js';
import { readyApp } from '../helpers/factories.js';

test('applications persist under separate keys and list in creation order', async () => {
  const storage = createStorageArea();
  const repo = createApplicationRepository({ storage, clock: fixedClock() });
  const a = await repo.create({ metadata: { appName: 'A' } });
  const b = await repo.create({ metadata: { appName: 'B' } });
  const dump = storage._dump();
  assert.ok(dump[`app:${a.id}`]);
  assert.ok(dump[`app:${b.id}`]);
  const list = await repo.list();
  assert.deepEqual(list.map((x) => x.metadata.appName), ['A', 'B']);
});

test('save rejects structurally invalid data', async () => {
  const repo = createApplicationRepository({ storage: createStorageArea() });
  const a = await repo.create();
  a.metadata.packageName = 'bad';
  await assert.rejects(repo.save(a), (e) => e.code === 'VALIDATION_FAILED');
});

test('update writes only the targeted application', async () => {
  const storage = createStorageArea();
  const repo = createApplicationRepository({ storage });
  const a = await repo.create({ metadata: { appName: 'A' } });
  const b = await repo.create({ metadata: { appName: 'B' } });
  await repo.update(a.id, (x) => { x.metadata.appName = 'A2'; return x; });
  assert.equal((await repo.get(a.id)).metadata.appName, 'A2');
  assert.equal((await repo.get(b.id)).metadata.appName, 'B');
});

test('saveUserEdits preserves engine-owned workflow and Play Console link', async () => {
  const repo = createApplicationRepository({ storage: createStorageArea() });
  const a = await repo.create();
  await repo.update(a.id, (x) => {
    x.workflow.state = 'APP_CREATED';
    x.playConsole = { developerId: 'd1', appId: '42', linkedAt: 't' };
    return x;
  });
  const stale = structuredClone(a); // form loaded before the engine wrote
  stale.metadata.appName = 'Edited';
  const saved = await repo.saveUserEdits(stale);
  assert.equal(saved.metadata.appName, 'Edited');
  assert.equal(saved.workflow.state, 'APP_CREATED');
  assert.equal(saved.playConsole.appId, '42');
});

test('saveUserEdits is refused while automation is running', async () => {
  const repo = createApplicationRepository({ storage: createStorageArea() });
  const a = await repo.create();
  await repo.update(a.id, (x) => { x.workflow.state = 'STORE_LISTING_IN_PROGRESS'; return x; });
  await assert.rejects(repo.saveUserEdits(a), (e) => e.code === 'LOCKED');
});

test('editing a READY_TO_START app sends it back to DRAFT for revalidation', async () => {
  const repo = createApplicationRepository({ storage: createStorageArea() });
  const a = await repo.create();
  await repo.update(a.id, (x) => { x.workflow.state = 'READY_TO_START'; return x; });
  const saved = await repo.saveUserEdits({ ...a, metadata: { ...a.metadata, appName: 'X' } });
  assert.equal(saved.workflow.state, 'DRAFT');
});

test('duplicate never copies identity, assets, bundle or (by default) declarations', async () => {
  const repo = createApplicationRepository({ storage: createStorageArea() });
  const src = await repo.save(readyApp());
  await repo.update(src.id, (x) => { x.playConsole.appId = '99'; x.appContent.dataSafetyStatus = 'completed_by_user'; return x; });
  const copy = await repo.duplicate(src.id);
  assert.notEqual(copy.id, src.id);
  assert.equal(copy.metadata.packageName, '');
  assert.equal(copy.playConsole.appId, null);
  assert.equal(copy.assets.appIcon, null);
  assert.equal(copy.release.aabFile, null);
  assert.equal(copy.appContent.containsAds, null);
  assert.equal(copy.appContent.declarations.policiesAccepted, null);
  assert.equal(copy.workflow.state, 'DRAFT');
  assert.equal(copy.storeListing.fullDescription, src.storeListing.fullDescription);

  const withDecl = await repo.duplicate(src.id, { copyDeclarations: true });
  assert.equal(withDecl.appContent.containsAds, false);
  assert.equal(withDecl.appContent.dataSafetyStatus, 'not_started');
});

test('remove deletes only that application', async () => {
  const repo = createApplicationRepository({ storage: createStorageArea() });
  const a = await repo.create();
  const b = await repo.create();
  await repo.remove(a.id);
  assert.equal(await repo.get(a.id), null);
  assert.ok(await repo.get(b.id));
});

test('progress repository returns defaults and caps history', async () => {
  const repo = createProgressRepository({ storage: createStorageArea() });
  const p = await repo.get('x');
  assert.equal(p.appId, 'x');
  p.history = Array.from({ length: 80 }, (_, i) => ({ i }));
  await repo.put(p);
  const back = await repo.get('x');
  assert.equal(back.history.length, 50);
  assert.equal(back.history[49].i, 79);
});

test('settings merge defaults, clamp numbers and reject bad regexes', async () => {
  const repo = createSettingsRepository({ storage: createStorageArea() });
  assert.equal((await repo.get()).requirePlanApproval, true);
  const s = await repo.set({ retryLimit: 99 });
  assert.equal(s.retryLimit, 5);
  assert.equal(s.filenameConventions.appIcon, DEFAULT_SETTINGS.filenameConventions.appIcon);
  await assert.rejects(repo.set({ filenameConventions: { appIcon: '(' } }), /regular expression/);
});

test('logger stores structured entries and redacts secrets', async () => {
  const logger = createLogger({ storage: createStorageArea(), clock: fixedClock() });
  await logger.log({ appId: 'a', stage: 'CREATE_APP', action: 'apply', outcome: 'success', details: { password: 'hunter2', note: 'ok' } });
  await logger.log({ appId: 'b', action: 'x', outcome: 'error', errorCode: 'UNKNOWN_PAGE' });
  const all = await logger.list();
  assert.equal(all.length, 2);
  assert.equal(all[0].details.password, '[redacted]');
  assert.equal(all[0].details.note, 'ok');
  assert.ok(all[0].ts);
  assert.equal((await logger.list({ appId: 'b' }))[0].errorCode, 'UNKNOWN_PAGE');
  await logger.clear('a');
  assert.equal((await logger.list()).length, 1);
});

test('redact truncates long strings and hides auth-like keys', () => {
  const r = redact({ Authorization: 'Bearer x', cookie: 'c', text: 'y'.repeat(1000) });
  assert.equal(r.Authorization, '[redacted]');
  assert.equal(r.cookie, '[redacted]');
  assert.ok(r.text.length < 400);
});
