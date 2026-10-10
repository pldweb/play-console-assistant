/**
 * Adapter-level DOM tests against the synthetic fixtures in
 * tests/fixtures/pages.js (NOT captured from the live Play Console).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createContentHandler } from '../../src/content/message-handler.js';
import { detectPage } from '../../src/content/page-detector.js';
import { languageOptionMatcher, listedAppNames } from '../../src/adapters/create-app-adapter.js';
import { readOutstandingSections } from '../../src/adapters/app-content-adapter.js';
import { listedVersionCodes, formatReleaseNotes } from '../../src/adapters/release-adapter.js';
import { readPublishingOverview } from '../../src/adapters/review-readiness-adapter.js';
import { installFilePolyfills } from '../helpers/fake-console.js';
import { FIXTURES } from '../fixtures/pages.js';

const BASE = 'https://play.google.com/console/u/0/developers/555';

function page(url, body) {
  const dom = new JSDOM(`<!doctype html><body>${body}</body>`, { url });
  installFilePolyfills(dom.window);
  const handler = createContentHandler({
    document: dom.window.document,
    getHref: () => dom.window.location.href,
    getAsset: async (id) => new dom.window.File([new Uint8Array([1])], `${id}.png`, { type: 'image/png' }),
  });
  return { doc: dom.window.document, handler };
}

test('page detection needs both URL and heading', () => {
  const ok = page(`${BASE}/app/1/main-store-listing`, FIXTURES.storeListing());
  assert.equal(detectPage(ok.doc, `${BASE}/app/1/main-store-listing`).ready, true);
  const loading = page(`${BASE}/app/1/main-store-listing`, '<div role="progressbar"></div>');
  const d = detectPage(loading.doc, `${BASE}/app/1/main-store-listing`);
  assert.equal(d.pageType, 'STORE_LISTING');
  assert.equal(d.ready, false);
});

test('content handler rejects unknown request types and wrong pages', async () => {
  const p = page(`${BASE}/app/1/main-store-listing`, FIXTURES.storeListing());
  assert.equal((await p.handler({ type: 'EVAL', code: 'x' })).error.code, 'MESSAGE_REJECTED');
  const r = await p.handler({ type: 'PCA_APPLY', stage: 'STORE_SETTINGS', step: 'x' });
  assert.equal(r.ok, false);
  const wrong = await p.handler({ type: 'PCA_INSPECT', stage: 'APP_CONTENT', step: 'ads', payload: { containsAds: true } });
  assert.equal(wrong.error.code, 'WRONG_PAGE');
  const otherApp = await p.handler({ type: 'PCA_INSPECT', stage: 'STORE_LISTING', step: 'listing-text', payload: {}, expectedPage: { appId: '2' } });
  assert.equal(otherApp.error.code, 'WRONG_PAGE');
});

test('create app: language option matching and app list parsing', () => {
  const m = languageOptionMatcher('en-US');
  assert.ok(m.test('English (United States) – en-US'));
  assert.ok(!m.test('English (United Kingdom) – en-GB'));
  assert.ok(languageOptionMatcher('id').test('Indonesian – id'));
  assert.ok(!languageOptionMatcher('id').test('Yiddish – yi'));
  const p = page(`${BASE}/app-list`, FIXTURES.appList(['Acme Notes', 'Beta']));
  assert.deepEqual(listedAppNames(p.doc.body).filter((n) => n !== 'App'), ['Acme Notes', 'Beta']);
});

test('create app form: inspect reports fields; ambiguous field blocks', async () => {
  const payload = { appName: 'Acme', defaultLanguage: 'en-US', appOrGame: 'app', pricing: 'free', policiesAccepted: true, exportLawsAccepted: true };
  const p = page(`${BASE}/create-new-app`, FIXTURES.createApp());
  const r = await p.handler({ type: 'PCA_INSPECT', stage: 'CREATE_APP', step: 'fill-form', payload });
  assert.equal(r.ok, true);
  assert.deepEqual(r.report.blocking, []);
  assert.ok(r.report.fields.find((f) => f.key === 'appName').willChange);
  const dup = page(`${BASE}/create-new-app`, FIXTURES.createApp({ duplicateNameField: true }));
  const r2 = await dup.handler({ type: 'PCA_INSPECT', stage: 'CREATE_APP', step: 'fill-form', payload });
  assert.equal(r2.report.blocking[0].code, 'AMBIGUOUS_ELEMENT');
  const a = await dup.handler({ type: 'PCA_APPLY', stage: 'CREATE_APP', step: 'fill-form', payload });
  assert.equal(a.ok, false, 'apply refuses when inspection is blocked');
});

test('create app form: unanswered declarations are never ticked', async () => {
  const p = page(`${BASE}/create-new-app`, FIXTURES.createApp());
  const r = await p.handler({ type: 'PCA_INSPECT', stage: 'CREATE_APP', step: 'fill-form', payload: { appName: 'A', defaultLanguage: 'en-US', appOrGame: 'app', pricing: 'free', policiesAccepted: null, exportLawsAccepted: true } });
  assert.ok(r.report.blocking.some((b) => b.code === 'DECLARATION_UNANSWERED'));
  const box = p.doc.getElementById('d1');
  assert.equal(box.checked, false);
});

test('store listing text: apply then verify; existing graphics block uploads', async () => {
  const p = page(`${BASE}/app/1/main-store-listing`, FIXTURES.storeListing({ iconCount: 1 }));
  const payload = { title: 'Acme', shortDescription: 'Short', fullDescription: 'Full\ntext', promoVideoUrl: '' };
  // Simulate the page acknowledging the save.
  p.doc.querySelector('main > button').addEventListener('click', () => { p.doc.querySelector('[role=status]').textContent = 'Changes saved'; });
  const a = await p.handler({ type: 'PCA_APPLY', stage: 'STORE_LISTING', step: 'listing-text', payload });
  assert.equal(a.ok, true, JSON.stringify(a.error));
  const v = await p.handler({ type: 'PCA_VERIFY', stage: 'STORE_LISTING', step: 'listing-text', payload });
  assert.equal(v.verify.ok, true);
  const g = await p.handler({ type: 'PCA_INSPECT', stage: 'STORE_LISTING', step: 'listing-graphics', payload: { graphics: { appIcon: [{ assetId: 'i', fileName: 'icon.png' }], featureGraphic: [], phoneScreenshots: [], tablet7Screenshots: [], tablet10Screenshots: [] }, alreadyUploaded: [] } });
  assert.equal(g.report.blocking[0].code, 'EXISTING_CONTENT');
});

test('store listing: a save the page never acknowledges is not treated as success', async () => {
  const p = page(`${BASE}/app/1/main-store-listing`, FIXTURES.storeListing());
  const r = await p.handler({ type: 'PCA_APPLY', stage: 'STORE_LISTING', step: 'listing-text', stepTimeoutMs: 100, payload: { title: 'A', shortDescription: 'B', fullDescription: 'C', promoVideoUrl: '' } });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'WAIT_TIMEOUT');
});

test('store listing: video field left untouched when no URL is provided', async () => {
  const p = page(`${BASE}/app/1/main-store-listing`, FIXTURES.storeListing({ video: 'https://youtu.be/old' }));
  const r = await p.handler({ type: 'PCA_INSPECT', stage: 'STORE_LISTING', step: 'listing-text', payload: { title: 'A', shortDescription: 'B', fullDescription: 'C', promoVideoUrl: '' } });
  assert.equal(r.report.fields.find((f) => f.key === 'promoVideoUrl').status, 'skipped');
});

test('app content: unknown question on ads page blocks; restricted access is manual', async () => {
  const ads = page(`${BASE}/app/1/app-content/ads-declaration`, FIXTURES.ads({ extraQuestion: true }));
  const r = await ads.handler({ type: 'PCA_INSPECT', stage: 'APP_CONTENT', step: 'ads', payload: { containsAds: false } });
  assert.ok(r.report.blocking.some((b) => b.code === 'UNKNOWN_QUESTION'));
  const acc = page(`${BASE}/app/1/app-content/testing-credentials`, FIXTURES.appAccess());
  const r2 = await acc.handler({ type: 'PCA_INSPECT', stage: 'APP_CONTENT', step: 'app-access', payload: { appAccess: 'restricted' } });
  assert.equal(r2.report.blocking[0].code, 'MANUAL_SECTION_INCOMPLETE');
});

test('app content overview: outstanding sections and missing structure', () => {
  const p = page(`${BASE}/app/1/app-content/overview`, FIXTURES.appContent(['Data safety', 'Content rating']));
  assert.deepEqual(readOutstandingSections(p.doc.body).outstanding, ['Data safety', 'Content rating']);
  const done = page(`${BASE}/app/1/app-content/overview`, FIXTURES.appContent([]));
  assert.deepEqual(readOutstandingSections(done.doc.body).outstanding, []);
  const weird = page(`${BASE}/app/1/app-content/overview`, '<h1>App content</h1><p>Redesigned page</p>');
  assert.equal(readOutstandingSections(weird.doc.body).structureFound, false);
});

test('release: version codes, notes format, upload error classification', async () => {
  const p = page(`${BASE}/app/1/tracks/internal-testing/releases/1/prepare`, FIXTURES.release({ bundles: [7], error: 'Version code 7 has already been used.' }));
  const section = p.doc.querySelector('[aria-label="App bundles"]');
  assert.deepEqual(listedVersionCodes(section), [7]);
  assert.equal(formatReleaseNotes('en-US', 'Fixes'), '<en-US>\nFixes\n</en-US>');
  const r = await p.handler({ type: 'PCA_INSPECT', stage: 'RELEASE', step: 'upload-bundle', payload: { assetId: 'a', fileName: 'r.aab', versionCode: 8, processingTimeoutMs: 100 } });
  assert.equal(r.report.blocking[0].code, 'EXISTING_CONTENT');
  const same = await p.handler({ type: 'PCA_INSPECT', stage: 'RELEASE', step: 'upload-bundle', payload: { assetId: 'a', fileName: 'r.aab', versionCode: 7, processingTimeoutMs: 100 } });
  assert.equal(same.report.fields[0].willChange, false, 'already uploaded bundle is detected, not re-uploaded');
});

test('publishing overview: errors, gate text, send availability', () => {
  const p = page(`${BASE}/app/1/publishing`, FIXTURES.publishing({ errors: ['Missing privacy policy'], send: true }));
  const s = readPublishingOverview(p.doc.body);
  assert.deepEqual(s.errors, ['Missing privacy policy']);
  assert.equal(s.sendAvailable, true);
  assert.equal(s.testingGate, true);
  const none = page(`${BASE}/app/1/publishing`, FIXTURES.publishing({ send: false }));
  assert.equal(readPublishingOverview(none.doc.body).sendAvailable, false);
});

test('submission apply refuses without confirmation flag', async () => {
  const p = page(`${BASE}/app/1/publishing`, FIXTURES.publishing({ send: true }));
  const r = await p.handler({ type: 'PCA_APPLY', stage: 'SUBMISSION', step: 'send-for-review', payload: { confirmed: false } });
  assert.equal(r.error.code, 'SUBMISSION_NOT_CONFIRMED');
  assert.equal(p.doc.querySelectorAll('[role=dialog]').length, 0);
});
