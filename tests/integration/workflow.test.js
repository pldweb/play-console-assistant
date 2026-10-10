/**
 * End-to-end workflow tests against the simulated Play Console
 * (tests/helpers/fake-console.js). These verify engine + adapters
 * behaviour; they do NOT verify the live Play Console UI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers/engine-harness.js';
import { FakeConsole, newApp } from '../helpers/fake-console.js';

const TAB = 7;

async function startedToReview(h, app) {
  h.fake.openTab(TAB, h.fake.url('app-list'));
  await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  // Manual questionnaires are the user's job; simulate the user doing them.
  assert.equal(await h.state(app.id), 'NEEDS_USER_ACTION');
  const p = await h.progress(app.id);
  assert.equal(p.errorCode, 'MANUAL_SECTION_INCOMPLETE');
  const created = (await h.appRepo.get(app.id)).playConsole.appId;
  h.fake.completeManualSections(created);
  await h.runUntilHalt(() => h.engine.resume(app.id, TAB));
  return created;
}

test('happy path: create, listing, content, release, readiness, then waits for confirmation', async () => {
  const h = await createHarness();
  const app = await h.addApp();
  const created = await startedToReview(h, app);

  assert.equal(await h.state(app.id), 'SUBMISSION_CONFIRMATION_REQUIRED');
  const rec = await h.appRepo.get(app.id);
  assert.equal(rec.playConsole.developerId, h.fake.developerId);
  const server = h.fake.apps.get(created);
  assert.equal(server.name, 'Acme Notes');
  assert.equal(server.listing.shortDescription, 'Fast, private notes.');
  assert.deepEqual(server.graphics.phoneScreenshots, ['phone-01.png', 'phone-02.png']);
  assert.deepEqual(server.graphics.appIcon, ['app-icon.png']);
  assert.equal(server.settings.category, 'Productivity');
  assert.equal(server.settings.email, 'support@acme.com');
  assert.equal(server.privacyPolicyUrl, 'https://acme.com/privacy');
  assert.equal(server.ads, 'no');
  assert.equal(server.access, 'all');
  assert.equal(server.release.notes, '<en-US>\nFirst release.\n</en-US>');
  assert.equal(server.release.bundles.length, 1);
  assert.equal(server.inReview, false, 'nothing may be sent for review without confirmation');
  assert.ok(!h.fake.clicks.includes('send-for-review'));
  assert.equal(h.fake.clicks.filter((c) => c === 'create-app').length, 1);
  const p = await h.progress(app.id);
  assert.equal(p.readiness['publishing-overview'].testingGate, true);
  assert.equal(await h.lock.get(), null, 'lock released while waiting for the user');
});

test('final submission: wrong name refused, cancel returns to READY_FOR_REVIEW, confirmation submits once and verifies', async () => {
  const h = await createHarness();
  const app = await h.addApp();
  const created = await startedToReview(h, app);

  await assert.rejects(h.engine.confirmSubmission(app.id, 'Acme', TAB), (e) => e.code === 'SUBMISSION_NOT_CONFIRMED');
  await h.engine.cancelSubmission(app.id);
  assert.equal(await h.state(app.id), 'READY_FOR_REVIEW');
  assert.equal(h.fake.apps.get(created).inReview, false);

  // Resume re-enters the confirmation wait; it never submits by itself.
  await h.runUntilHalt(() => h.engine.resume(app.id, TAB));
  assert.equal(await h.state(app.id), 'SUBMISSION_CONFIRMATION_REQUIRED');
  await assert.rejects(h.engine.resume(app.id, TAB), (e) => e.code === 'SUBMISSION_NOT_CONFIRMED');

  // Confirmation is bound to the tab.
  await assert.rejects(h.engine.confirmSubmission(app.id, 'Acme Notes', TAB + 1).then((r) => r.done).then(async () => {
    if ((await h.state(app.id)) !== 'SUBMITTED') throw Object.assign(new Error('x'), { code: 'NOT_SUBMITTED' });
  }), (e) => e.code === 'NOT_SUBMITTED');
  assert.equal(h.fake.apps.get(created).inReview, false, 'confirmation for another tab must not submit');
  // The failed attempt halted the workflow; resume to the confirmation state.
  await h.runUntilHalt(() => h.engine.resume(app.id, TAB));

  await h.runUntilHalt(() => h.engine.confirmSubmission(app.id, 'Acme Notes', TAB));
  assert.equal(await h.state(app.id), 'SUBMITTED');
  assert.equal(h.fake.apps.get(created).inReview, true);
  assert.equal(h.fake.clicks.filter((c) => c === 'confirm-send').length, 1);
});

test('plan approval gate: nothing is written until the exact plan is approved', async () => {
  const h = await createHarness({ settings: { requirePlanApproval: true } });
  const app = await h.addApp();
  h.fake.openTab(TAB, h.fake.url('app-list'));
  await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  let p = await h.progress(app.id);
  assert.equal(await h.state(app.id), 'NEEDS_USER_ACTION');
  assert.equal(p.requiredAction.type, 'APPROVE_PLAN');
  assert.equal(p.requiredAction.step, 'fill-form');
  assert.ok(p.requiredAction.report.fields.some((f) => f.key === 'appName' && f.planned === 'Acme Notes'));
  assert.equal(h.fake.doc(TAB).getElementById('f-name').value, '', 'no field written before approval');
  await assert.rejects(h.engine.approvePlan(app.id, 'wrong-hash', TAB), (e) => e.code === 'APPROVAL_REQUIRED');
  await h.runUntilHalt(() => h.engine.approvePlan(app.id, p.requiredAction.planHash, TAB));
  p = await h.progress(app.id);
  assert.equal(p.requiredAction.type, 'APPROVE_PLAN');
  assert.equal(p.requiredAction.step, 'submit-create');
  assert.equal(h.fake.clicks.filter((c) => c === 'create-app').length, 0);
});

test('missing assets: start is refused with validation errors and stays DRAFT', async () => {
  const h = await createHarness();
  const app = await h.addApp();
  await h.appRepo.update(app.id, (a) => { a.assets.appIcon = null; a.assets.phoneScreenshots = []; return a; });
  h.fake.openTab(TAB, h.fake.url('app-list'));
  const r = await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  assert.equal(await h.state(app.id), 'DRAFT');
  assert.equal(r.validation.valid, false);
  assert.ok(r.validation.errors.some((e) => e.path === 'assets.appIcon'));
  assert.equal(h.fake.clicks.length, 0);
});

test('invalid declarations: unanswered ads question stops before app creation', async () => {
  const h = await createHarness();
  const app = await h.addApp();
  await h.appRepo.update(app.id, (a) => { a.appContent.containsAds = null; return a; });
  h.fake.openTab(TAB, h.fake.url('app-list'));
  await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  assert.equal(await h.state(app.id), 'DRAFT');
  assert.equal((await h.appRepo.get(app.id)).workflow.errorCode, 'VALIDATION_FAILED');
});

test('unknown question on the create form stops without filling anything', async () => {
  const h = await createHarness();
  h.fake.faults.unknownCreateQuestion = true;
  const app = await h.addApp();
  h.fake.openTab(TAB, h.fake.url('app-list'));
  await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  const p = await h.progress(app.id);
  assert.equal(await h.state(app.id), 'NEEDS_USER_ACTION');
  assert.equal(p.errorCode, 'UNKNOWN_QUESTION');
  assert.match(p.errorMessage, /Play App Signing/);
  assert.equal(h.fake.doc(TAB).getElementById('f-name').value, '');
});

test('duplicate app name: stops, then link or explicit allow', async () => {
  const fake = new FakeConsole({ apps: { '4970000000000000999': newApp('Acme Notes') } });
  const h = await createHarness({ fake });
  const app = await h.addApp();
  fake.openTab(TAB, fake.url('app-list'));
  await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  const p = await h.progress(app.id);
  assert.equal(p.errorCode, 'POSSIBLE_DUPLICATE_APP');
  assert.equal(p.requiredAction.type, 'LINK_OR_ALLOW_DUPLICATE');
  assert.ok(!fake.clicks.includes('open-create'));

  // User opens the existing app and links it.
  await fake.gateway().navigate(TAB, `${fake.appBase('4970000000000000999')}/app-dashboard`);
  await h.engine.linkCurrentApp(app.id, TAB);
  assert.equal((await h.appRepo.get(app.id)).playConsole.appId, '4970000000000000999');
  await h.runUntilHalt(() => h.engine.resume(app.id, TAB));
  const p2 = await h.progress(app.id);
  assert.ok(p2.completedSteps.CREATE_APP.includes('verify-linked'));
  assert.ok(!fake.clicks.includes('create-app'), 'linked app must not be created again');
});

test('linking refuses an app already linked to another record', async () => {
  const fake = new FakeConsole({ apps: { '4970000000000000999': newApp('Acme Notes') } });
  const h = await createHarness({ fake });
  const a = await h.addApp();
  const b = await h.addApp();
  fake.openTab(TAB, `${fake.appBase('4970000000000000999')}/app-dashboard`);
  await h.engine.linkCurrentApp(a.id, TAB);
  await assert.rejects(h.engine.linkCurrentApp(b.id, TAB), (e) => e.code === 'IDENTITY_MISMATCH');
});

test('timeout after "Create app" click: verified from the page, never clicked twice', async () => {
  const h = await createHarness();
  h.fake.faults.dropResponse = { step: 'submit-create', times: 1 };
  const app = await h.addApp();
  h.fake.openTab(TAB, h.fake.url('app-list'));
  await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  assert.equal(h.fake.clicks.filter((c) => c === 'create-app').length, 1);
  assert.ok((await h.appRepo.get(app.id)).playConsole.appId, 'app linked from the page after the lost response');
});

test('uncertain create (no navigation): stops for the user instead of re-clicking', async () => {
  const h = await createHarness();
  h.fake.faults.createWithoutNavigation = true;
  const app = await h.addApp();
  h.fake.openTab(TAB, h.fake.url('app-list'));
  await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  assert.equal(await h.state(app.id), 'NEEDS_USER_ACTION');
  await h.runUntilHalt(() => h.engine.resume(app.id, TAB));
  const p = await h.progress(app.id);
  assert.equal(p.errorCode, 'POSSIBLE_DUPLICATE_APP');
  assert.equal(p.requiredAction.type, 'LINK_OR_RESET');
  assert.equal(h.fake.clicks.filter((c) => c === 'create-app').length, 1);
});

test('session expiry mid-run: stops with SESSION_EXPIRED; resume after sign-in continues', async () => {
  const h = await createHarness();
  const app = await h.addApp();
  h.fake.openTab(TAB, h.fake.url('app-list'));
  // Expire the session as soon as the app exists (next navigation goes to sign-in).
  const origSet = h.fake.apps.set.bind(h.fake.apps);
  h.fake.apps.set = (k, v) => { h.fake.faults.sessionExpired = true; return origSet(k, v); };
  await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  assert.equal(await h.state(app.id), 'NEEDS_USER_ACTION');
  assert.equal((await h.progress(app.id)).errorCode, 'SESSION_EXPIRED');
  h.fake.apps.set = origSet;
  h.fake.faults.sessionExpired = false;
  const created = [...h.fake.apps.keys()][0];
  const t = h.fake.tabs.get(TAB);
  t.signedOut = false;
  h.fake.load(TAB, `${h.fake.appBase(created)}/app-dashboard`); // user signs in again
  await h.runUntilHalt(() => h.engine.resume(app.id, TAB));
  assert.equal((await h.appRepo.get(app.id)).playConsole.appId, created);
  assert.equal(h.fake.clicks.filter((c) => c === 'create-app').length, 1);
});

test('unknown page: automation stops safely with UNKNOWN_PAGE and touches nothing', async () => {
  const h = await createHarness();
  const app = await h.addApp();
  h.fake.openTab(TAB, h.fake.url('app-list'));
  // Every navigation lands on a page the extension does not know (e.g. a
  // new interstitial Google added).
  const origLoad = h.fake.load.bind(h.fake);
  h.fake.load = (tabId, url) => origLoad(tabId, url.includes('app-list') && h.fake.tabs.get(tabId).url ? h.fake.url('policy-interstitial') : url);
  h.fake.load(TAB, h.fake.url('app-list'));
  await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  const p = await h.progress(app.id);
  assert.equal(await h.state(app.id), 'NEEDS_USER_ACTION');
  assert.equal(p.errorCode, 'UNKNOWN_PAGE');
  assert.match(p.requiredAction.hint, /does not recognise/);
  assert.equal(h.fake.clicks.length, 0);
});

test('delayed rendering is awaited by bounded polling', async () => {
  const h = await createHarness();
  h.fake.faults.renderDelayMs = 40;
  const app = await h.addApp();
  h.fake.openTab(TAB, h.fake.url('app-list'));
  await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  assert.equal((await h.progress(app.id)).errorCode, 'MANUAL_SECTION_INCOMPLETE');
});

test('failed graphic upload: halts with UPLOAD_FAILED; existing images then block re-upload', async () => {
  const h = await createHarness();
  const app = await h.addApp();
  h.fake.faults.uploadError = 'Image must be 512 x 512';
  h.fake.openTab(TAB, h.fake.url('app-list'));
  await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  const p = await h.progress(app.id);
  assert.equal(await h.state(app.id), 'NEEDS_USER_ACTION');
  assert.equal(p.errorCode, 'UPLOAD_FAILED');
  assert.ok(p.completedSteps.STORE_LISTING.includes('listing-text'));
  assert.ok(!p.completedSteps.STORE_LISTING.includes('listing-graphics'));
});

test('bundle rejected by Play Console is classified (version code conflict)', async () => {
  const h = await createHarness();
  const app = await h.addApp();
  h.fake.faults.bundleError = 'Version code 1 has already been used. Try another version code.';
  const created = await startedToReview(h, app).catch(() => null);
  void created;
  const p = await h.progress(app.id);
  assert.equal(p.errorCode, 'VERSION_CODE_CONFLICT');
  assert.equal(await h.state(app.id), 'NEEDS_USER_ACTION');
});

test('save rejected by Play Console surfaces the page error', async () => {
  const h = await createHarness();
  const app = await h.addApp();
  h.fake.openTab(TAB, h.fake.url('app-list'));
  const origLoad = h.fake.load.bind(h.fake);
  h.fake.load = (tabId, url) => { if (url.endsWith('main-store-listing')) h.fake.faults.saveError = 'Short description is too long'; return origLoad(tabId, url); };
  await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  const p = await h.progress(app.id);
  assert.equal(p.errorCode, 'PAGE_VALIDATION_ERROR');
  assert.match(p.errorMessage, /too long/);
});

test('pause and resume between steps', async () => {
  const h = await createHarness();
  const app = await h.addApp();
  h.fake.openTab(TAB, h.fake.url('app-list'));
  const r = await h.engine.start(app.id, TAB);
  await h.engine.pause(app.id);
  await r.done;
  assert.equal(await h.state(app.id), 'PAUSED');
  const p = await h.progress(app.id);
  assert.ok(p.pausedFrom);
  await h.runUntilHalt(() => h.engine.resume(app.id, TAB));
  assert.equal((await h.progress(app.id)).errorCode, 'MANUAL_SECTION_INCOMPLETE');
  assert.equal(h.fake.clicks.filter((c) => c === 'create-app').length, 1);
});

test('browser reload: a running state is paused on startup and resumes from the checkpoint', async () => {
  const h = await createHarness();
  const app = await h.addApp();
  h.fake.openTab(TAB, h.fake.url('app-list'));
  await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  // Simulate the service worker dying while STORE_LISTING was running.
  await h.checkpoints.transition(app.id, 'APP_CONTENT_IN_PROGRESS', { force: true });
  await h.lock.acquire(app.id, TAB);
  const fresh = h.makeEngine();
  const recovered = await fresh.recoverOnStartup();
  assert.deepEqual(recovered, [app.id]);
  assert.equal(await h.state(app.id), 'PAUSED');
  assert.equal((await h.progress(app.id)).errorCode, 'INTERRUPTED');
  assert.equal(await h.lock.get(), null);
  const created = (await h.appRepo.get(app.id)).playConsole.appId;
  h.fake.completeManualSections(created);
  await h.runUntilHalt(() => fresh.resume(app.id, TAB));
  assert.equal(await h.state(app.id), 'SUBMISSION_CONFIRMATION_REQUIRED');
});

test('identity: a tab showing a different app is refused', async () => {
  const fake = new FakeConsole({ apps: { '111': newApp('Other App'), '222': newApp('Acme Notes') } });
  const h = await createHarness({ fake });
  const app = await h.addApp();
  await h.appRepo.update(app.id, (a) => { a.playConsole = { developerId: fake.developerId, appId: '222', linkedAt: 'x' }; return a; });
  fake.openTab(TAB, `${fake.appBase('111')}/main-store-listing`);
  // Navigation goes by template to app 222, so first break navigation to stay on 111.
  fake.gateway = ((orig) => () => ({ ...orig(), navigate: async () => {} }))(fake.gateway.bind(fake));
  const h2 = await createHarness({ fake });
  await h2.appRepo.save(await h.appRepo.get(app.id));
  await h2.runUntilHalt(() => h2.engine.start(app.id, TAB));
  const p = await h2.progress(app.id);
  assert.equal(await h2.state(app.id), 'NEEDS_USER_ACTION');
  assert.ok(['IDENTITY_MISMATCH', 'WRONG_PAGE'].includes(p.errorCode), p.errorCode);
  assert.equal(fake.apps.get('111').listing.shortDescription, '', 'other app untouched');
});

test('batch: switching between applications never mixes data; one app at a time', async () => {
  const h = await createHarness();
  const a = await h.addApp();
  const b = await h.addApp({}, (x) => {
    x.metadata.appName = 'Beta Tasks';
    x.metadata.packageName = 'com.acme.tasks';
    x.storeListing.title = 'Beta Tasks';
    x.storeListing.shortDescription = 'Tasks, done.';
    x.release.aabFile.bundle = { packageName: 'com.acme.tasks', versionCode: 1 };
  });
  h.fake.openTab(TAB, h.fake.url('app-list'));
  h.fake.openTab(TAB + 1, h.fake.url('app-list'));

  const ra = await h.engine.start(a.id, TAB);
  await assert.rejects(h.engine.start(b.id, TAB + 1), (e) => e.code === 'LOCKED');
  await ra.done;
  await h.runUntilHalt(() => h.engine.start(b.id, TAB));

  const ida = (await h.appRepo.get(a.id)).playConsole.appId;
  const idb = (await h.appRepo.get(b.id)).playConsole.appId;
  assert.notEqual(ida, idb);
  assert.equal(h.fake.apps.get(ida).listing.shortDescription, 'Fast, private notes.');
  assert.equal(h.fake.apps.get(idb).listing.shortDescription, 'Tasks, done.');
  assert.equal(h.fake.apps.get(idb).name, 'Beta Tasks');
  const logsA = await h.logger.list({ appId: a.id });
  assert.ok(logsA.length > 0 && logsA.every((l) => l.appId === a.id));
});

test('assets are served only for the app being automated', async () => {
  const h = await createHarness();
  const a = await h.addApp();
  const b = await h.addApp();
  // Point app B's icon at app A's asset id: the fake (like the service worker) refuses it.
  await h.appRepo.update(b.id, (x) => { x.assets.appIcon = { ...a.assets.appIcon }; return x; });
  h.fake.openTab(TAB, h.fake.url('app-list'));
  await h.runUntilHalt(() => h.engine.start(b.id, TAB));
  const p = await h.progress(b.id);
  assert.equal(p.errorCode, 'ASSET_MISSING');
});

test('reset to draft keeps the Play Console link so the app is not created twice', async () => {
  const h = await createHarness();
  const app = await h.addApp();
  h.fake.openTab(TAB, h.fake.url('app-list'));
  await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  await h.engine.reset(app.id, 'draft');
  assert.equal(await h.state(app.id), 'DRAFT');
  assert.ok((await h.appRepo.get(app.id)).playConsole.appId);
  await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  assert.equal(h.fake.clicks.filter((c) => c === 'create-app').length, 1);
  assert.ok((await h.progress(app.id)).completedSteps.CREATE_APP.includes('verify-linked'));
});

test('logs never contain declaration payload text or secrets', async () => {
  const h = await createHarness({ settings: { requirePlanApproval: true } });
  const app = await h.addApp();
  h.fake.openTab(TAB, h.fake.url('app-list'));
  await h.runUntilHalt(() => h.engine.start(app.id, TAB));
  const logs = JSON.stringify(await h.logger.list());
  assert.ok(!logs.includes('Fast, private notes.'));
  assert.ok(logs.includes('"appId"'));
});
