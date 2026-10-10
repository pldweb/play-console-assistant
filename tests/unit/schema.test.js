import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createApplication, validateApplication, validatePackageName, validateHttpUrl, validateEmail,
  validatePhone, validateYouTubeUrl, validateLanguageTag, validateVersionCode, migrateApplication,
  SCHEMA_VERSION, LIMITS, charLength,
} from '../../src/data/schema.js';
import { readyApp } from '../helpers/factories.js';

test('createApplication produces a valid v1 draft with a stable id', () => {
  const a = createApplication();
  const b = createApplication();
  assert.equal(a.schemaVersion, SCHEMA_VERSION);
  assert.notEqual(a.id, b.id);
  assert.equal(a.workflow.state, 'DRAFT');
  assert.equal(validateApplication(a).valid, true);
});

test('unanswered declarations default to null, never false', () => {
  const a = createApplication();
  assert.equal(a.appContent.containsAds, null);
  assert.equal(a.appContent.appAccess, null);
  assert.equal(a.appContent.declarations.policiesAccepted, null);
  assert.equal(a.appContent.declarations.exportLawsAccepted, null);
});

test('id is independent of package name', () => {
  const a = createApplication({ metadata: { packageName: 'com.acme.one' } });
  assert.notEqual(a.id, 'com.acme.one');
  assert.ok(!a.id.includes('acme'));
});

test('package name validation', () => {
  assert.equal(validatePackageName('com.acme.app'), null);
  assert.equal(validatePackageName('com.acme.app_2'), null);
  assert.match(validatePackageName(''), /required/);
  assert.match(validatePackageName('acme'), /two segments/);
  assert.match(validatePackageName('com.1acme'), /start with a letter/);
  assert.match(validatePackageName('com.acme-app'), /letters, digits or underscores/);
  assert.match(validatePackageName('com.class.app'), /reserved/);
  assert.match(validatePackageName('com.example.app'), /com\.example/);
  assert.match(validatePackageName('com.' + 'a'.repeat(200)), /at most/);
  assert.match(validatePackageName('com..app'), /Segment/);
});

test('URL, email, phone, language and version code validation', () => {
  assert.equal(validateHttpUrl('https://acme.com/privacy'), null);
  assert.match(validateHttpUrl('ftp://acme.com'), /http/);
  assert.match(validateHttpUrl('not a url'), /valid URL/);
  assert.match(validateHttpUrl('https://localhost/x'), /domain/);
  assert.match(validateHttpUrl('', { required: true }), /required/);
  assert.equal(validateHttpUrl(''), null);
  assert.equal(validateEmail('dev@acme.com'), null);
  assert.match(validateEmail('dev@acme'), /valid email/);
  assert.equal(validatePhone('+62 812-3456-7890'), null);
  assert.match(validatePhone('0812345678'), /international/);
  assert.equal(validateLanguageTag('en-US'), null);
  assert.equal(validateLanguageTag('id'), null);
  assert.match(validateLanguageTag('english'), /language code/);
  assert.equal(validateVersionCode(12), null);
  assert.equal(validateVersionCode(null), null);
  assert.match(validateVersionCode(0), /integer/);
  assert.match(validateVersionCode(1.5), /integer/);
});

test('YouTube promo video URL rules', () => {
  assert.equal(validateYouTubeUrl('https://www.youtube.com/watch?v=abc123'), null);
  assert.equal(validateYouTubeUrl('https://youtu.be/abc123'), null);
  assert.match(validateYouTubeUrl('https://vimeo.com/1'), /YouTube/);
  assert.match(validateYouTubeUrl('https://www.youtube.com/watch?v=a&list=PL1'), /playlist/);
  assert.match(validateYouTubeUrl('https://youtu.be/abc?t=30'), /timecodes/);
  assert.match(validateYouTubeUrl('https://www.youtube.com/channel/x'), /video URL/);
});

test('character limits count code points', () => {
  assert.equal(charLength('😀😀'), 2);
  const a = createApplication({ storeListing: { title: 'x'.repeat(LIMITS.title + 1) } });
  const r = validateApplication(a);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.path === 'storeListing.title'));
  const ok = createApplication({ storeListing: { title: '😀'.repeat(LIMITS.title) } });
  assert.equal(validateApplication(ok).valid, true);
});

test('ready-level validation lists every missing required field', () => {
  const r = validateApplication(createApplication(), { level: 'ready' });
  const paths = r.errors.map((e) => e.path);
  for (const p of [
    'metadata.appName', 'metadata.packageName', 'storeListing.title', 'storeListing.shortDescription',
    'storeListing.fullDescription', 'storeListing.category', 'storeListing.supportEmail',
    'storeListing.privacyPolicyUrl', 'assets.appIcon', 'assets.featureGraphic', 'assets.phoneScreenshots',
    'appContent.containsAds', 'appContent.appAccess', 'appContent.declarations.policiesAccepted',
    'appContent.declarations.exportLawsAccepted', 'release.aabFile',
  ]) {
    assert.ok(paths.includes(p), `missing error for ${p}`);
  }
});

test('a fully filled app passes ready validation', () => {
  const r = validateApplication(readyApp(), { level: 'ready' });
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid, true);
});

test('cross-field: bundle package name must match the app', () => {
  const a = readyApp();
  a.release.aabFile.bundle = { packageName: 'com.other.app', versionCode: 3 };
  const r = validateApplication(a, { level: 'ready' });
  assert.ok(r.errors.some((e) => e.path === 'release.aabFile' && /does not match/.test(e.message)));
});

test('cross-field: game categories are checked against appOrGame', () => {
  const a = readyApp();
  a.metadata.appOrGame = 'game';
  a.storeListing.category = 'Productivity';
  const r = validateApplication(a, { level: 'ready' });
  assert.ok(r.errors.some((e) => e.path === 'storeListing.category'));
  a.storeListing.category = 'Puzzle';
  assert.equal(validateApplication(a, { level: 'ready' }).valid, true);
});

test('enum validation rejects unknown values', () => {
  const a = createApplication();
  a.metadata.pricing = 'freemium';
  a.release.releaseTrack = 'beta';
  a.appContent.appAccess = 'maybe';
  a.appContent.containsAds = 'no';
  const paths = validateApplication(a).errors.map((e) => e.path);
  assert.ok(paths.includes('metadata.pricing'));
  assert.ok(paths.includes('release.releaseTrack'));
  assert.ok(paths.includes('appContent.appAccess'));
  assert.ok(paths.includes('appContent.containsAds'));
});

test('declarations must be explicitly true; null is unanswered', () => {
  const a = readyApp();
  a.appContent.declarations.policiesAccepted = null;
  const r = validateApplication(a, { level: 'ready' });
  assert.ok(r.errors.some((e) => e.path === 'appContent.declarations.policiesAccepted'));
});

test('asset validation errors block readiness', () => {
  const a = readyApp();
  a.assets.appIcon.validation = { errors: ['Icon must be 512 x 512 px.'], warnings: [] };
  const r = validateApplication(a, { level: 'ready' });
  assert.ok(r.errors.some((e) => e.path === 'assets.appIcon'));
});

test('duplicate screenshot references are rejected', () => {
  const a = readyApp();
  a.assets.phoneScreenshots.push({ ...a.assets.phoneScreenshots[0] });
  const r = validateApplication(a);
  assert.ok(r.errors.some((e) => /listed twice/.test(e.message)));
});

test('migration: v0 record gets defaults, newer version is refused', () => {
  const m = migrateApplication({ id: 'legacy-1', metadata: { appName: 'Old' } });
  assert.equal(m.schemaVersion, SCHEMA_VERSION);
  assert.equal(m.id, 'legacy-1');
  assert.equal(m.metadata.appName, 'Old');
  assert.equal(m.appContent.containsAds, null);
  assert.throws(() => migrateApplication({ schemaVersion: SCHEMA_VERSION + 1 }), /newer/);
  const current = createApplication();
  assert.equal(migrateApplication(current), current);
});
