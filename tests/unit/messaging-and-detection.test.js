import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeMessage, bytesToBase64, base64ToBytes, chunkBytes, isConsoleContentSender } from '../../src/services/messaging.js';
import { parseConsoleUrl, buildConsoleUrl, PAGE_TYPES } from '../../src/content/page-detector.js';

const RID = 'abcdefghijklmnop';
const pageSender = { id: RID, url: `chrome-extension://${RID}/src/dashboard/dashboard.html`, tab: { id: 3 } };
const contentSender = { id: RID, url: 'https://play.google.com/console/u/0/developers/1/app-list', tab: { id: 9 }, frameId: 0 };

test('extension-page messages are accepted only from extension pages with valid payloads', () => {
  assert.deepEqual(validateRuntimeMessage({ type: 'ENGINE_START', appId: 'a', tabId: 9 }, pageSender, RID), { kind: 'page' });
  assert.throws(() => validateRuntimeMessage({ type: 'ENGINE_START', appId: 'a', tabId: 9 }, contentSender, RID), (e) => e.code === 'MESSAGE_REJECTED');
  assert.throws(() => validateRuntimeMessage({ type: 'ENGINE_START', appId: 'a' }, pageSender, RID), /Invalid payload/);
  assert.throws(() => validateRuntimeMessage({ type: 'ENGINE_START', appId: 'a', tabId: 9 }, { ...pageSender, id: 'other' }, RID));
  assert.throws(() => validateRuntimeMessage({ type: 'ENGINE_APPROVE_PLAN', appId: 'a', tabId: 1, planHash: 'nothex' }, pageSender, RID));
  assert.throws(() => validateRuntimeMessage({ type: 'ENGINE_RESET', appId: 'a', mode: 'everything' }, pageSender, RID));
  assert.throws(() => validateRuntimeMessage({ type: 'EVIL' }, pageSender, RID), /Unknown message type/);
  assert.throws(() => validateRuntimeMessage(null, pageSender, RID), /Malformed/);
});

test('content messages are accepted only from the top frame of a Play Console tab', () => {
  const m = { type: 'PCA_STEP_PROGRESS', appId: 'a', stage: 'STORE_LISTING', step: 'listing-graphics', uploaded: 'appIcon' };
  assert.deepEqual(validateRuntimeMessage(m, contentSender, RID), { kind: 'content' });
  assert.throws(() => validateRuntimeMessage(m, { ...contentSender, frameId: 2 }, RID));
  assert.throws(() => validateRuntimeMessage(m, { ...contentSender, url: 'https://evil.example/console/' }, RID));
  assert.throws(() => validateRuntimeMessage(m, pageSender, RID));
  assert.equal(isConsoleContentSender({ ...contentSender, tab: undefined }, RID), false);
});

test('base64 chunking round-trips binary data', () => {
  const bytes = new Uint8Array(70000).map((_, i) => i % 251);
  const chunks = chunkBytes(bytes, 30000);
  assert.equal(chunks.length, 3);
  const back = chunks.map((c) => base64ToBytes(bytesToBase64(c)));
  const joined = new Uint8Array(back.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of back) { joined.set(c, o); o += c.length; }
  assert.deepEqual(joined, bytes);
  assert.equal(chunkBytes(new Uint8Array(0)).length, 1);
});

test('parseConsoleUrl extracts identity and page type', () => {
  const base = 'https://play.google.com/console/u/1/developers/555/app/4970/';
  assert.deepEqual(
    (({ pageType, userIndex, developerId, appId }) => ({ pageType, userIndex, developerId, appId }))(parseConsoleUrl(`${base}main-store-listing`)),
    { pageType: 'STORE_LISTING', userIndex: 1, developerId: '555', appId: '4970' },
  );
  assert.equal(parseConsoleUrl(`${base}tracks/internal-testing`).track, 'internal');
  assert.equal(parseConsoleUrl(`${base}tracks/internal-testing/releases/3/prepare`).pageType, 'RELEASE_EDIT');
  assert.equal(parseConsoleUrl(`${base}app-content/overview`).pageType, 'APP_CONTENT_OVERVIEW');
  assert.equal(parseConsoleUrl(`${base}something-new`).pageType, 'UNKNOWN');
  assert.equal(parseConsoleUrl('https://play.google.com/console/u/0/developers/555/app-list').pageType, 'APP_LIST');
  assert.equal(parseConsoleUrl('https://accounts.google.com/signin').pageType, 'SIGN_IN');
  assert.equal(parseConsoleUrl('https://play.google.com/store/apps').pageType, 'UNKNOWN');
  assert.equal(parseConsoleUrl('https://play.google.com/console/signup').pageType, 'SIGNUP');
  assert.equal(parseConsoleUrl('not a url').pageType, 'UNKNOWN');
});

test('buildConsoleUrl refuses to build app pages without an app id', () => {
  assert.equal(buildConsoleUrl(PAGE_TYPES.STORE_LISTING, { developerId: '1' }), null);
  assert.equal(buildConsoleUrl(PAGE_TYPES.RELEASE_EDIT, { developerId: '1', appId: '2' }), null);
  assert.equal(buildConsoleUrl(PAGE_TYPES.APP_LIST, { developerId: '1', userIndex: 2 }), 'https://play.google.com/console/u/2/developers/1/app-list');
  const u = buildConsoleUrl(PAGE_TYPES.TRACK, { developerId: '1', appId: '2', track: 'internal' });
  assert.equal(parseConsoleUrl(u).pageType, 'TRACK');
});
