import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sniffType, parsePng, parseJpeg, validateImageForRole, inspectAab, readZipDirectory, sha256Hex, validateFileForRole,
} from '../../src/services/file-validation.js';
import { makePng, makeJpeg, makeAab, makeZip } from '../helpers/binary.js';

test('sniffType uses magic bytes, not names', () => {
  assert.equal(sniffType(makePng(10, 10)), 'png');
  assert.equal(sniffType(makeJpeg(10, 10)), 'jpeg');
  assert.equal(sniffType(makeAab()), 'zip');
  assert.equal(sniffType(new TextEncoder().encode('hello')), 'unknown');
});

test('parsePng reads dimensions and alpha', () => {
  const rgba = parsePng(makePng(512, 512, { colorType: 6 }));
  assert.deepEqual([rgba.width, rgba.height, rgba.hasAlpha, rgba.is32BitRgba], [512, 512, true, true]);
  const rgb = parsePng(makePng(1024, 500));
  assert.equal(rgb.hasAlpha, false);
  assert.equal(parsePng(makePng(10, 10, { trns: true })).hasAlpha, true);
});

test('parseJpeg reads SOF dimensions', () => {
  const j = parseJpeg(makeJpeg(1080, 1920));
  assert.deepEqual([j.width, j.height], [1080, 1920]);
});

test('app icon rules', () => {
  assert.equal(validateImageForRole('appIcon', makePng(512, 512, { colorType: 6 }), { fileName: 'icon.png' }).ok, true);
  const wrongSize = validateImageForRole('appIcon', makePng(500, 500, { colorType: 6 }));
  assert.match(wrongSize.errors[0], /512 x 512/);
  const jpeg = validateImageForRole('appIcon', makeJpeg(512, 512));
  assert.ok(jpeg.errors.some((e) => /PNG/.test(e)));
  const rgb = validateImageForRole('appIcon', makePng(512, 512));
  assert.equal(rgb.ok, true);
  assert.ok(rgb.warnings.some((w) => /32-bit/.test(w)));
  const big = validateImageForRole('appIcon', makePng(512, 512, { colorType: 6, padTo: 1024 * 1024 + 10 }));
  assert.ok(big.errors.some((e) => /KB/.test(e)));
});

test('feature graphic rules: exact size, no alpha', () => {
  assert.equal(validateImageForRole('featureGraphic', makeJpeg(1024, 500)).ok, true);
  assert.equal(validateImageForRole('featureGraphic', makePng(1024, 500)).ok, true);
  assert.ok(validateImageForRole('featureGraphic', makePng(1024, 500, { colorType: 6 })).errors.some((e) => /alpha/.test(e)));
  assert.equal(validateImageForRole('featureGraphic', makePng(1000, 500)).ok, false);
});

test('screenshot rules: side range and aspect ratio', () => {
  assert.equal(validateImageForRole('phoneScreenshots', makePng(1080, 1920)).ok, true);
  assert.ok(validateImageForRole('phoneScreenshots', makePng(300, 600)).errors.some((e) => /between 320 and 3840/.test(e)));
  assert.ok(validateImageForRole('phoneScreenshots', makePng(400, 900)).errors.some((e) => /2x/.test(e)));
  assert.ok(validateImageForRole('phoneScreenshots', makePng(4000, 3000)).errors.length > 0);
  assert.ok(validateImageForRole('tablet10Screenshots', makePng(600, 960)).warnings.some((w) => /1080/.test(w)));
});

test('non-image bytes with an image name are rejected', () => {
  const r = validateImageForRole('phoneScreenshots', new TextEncoder().encode('not an image'), { fileName: 'phone-01.png' });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /file contents/);
});

test('extension/content mismatch is reported', () => {
  const r = validateImageForRole('phoneScreenshots', makeJpeg(1080, 1920), { fileName: 'phone-01.png' });
  assert.ok(r.warnings.some((w) => /does not match/.test(w)));
});

test('AAB: deflated manifest yields package name and version code', async () => {
  const r = await inspectAab(makeAab({ packageName: 'com.acme.notes', versionCode: '42' }), { fileName: 'release.aab' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.info.packageName, 'com.acme.notes');
  assert.equal(r.info.versionCode, 42);
  assert.deepEqual(r.info.modules, ['base']);
});

test('AAB: stored (uncompressed) manifest also parses', async () => {
  const r = await inspectAab(makeAab({ deflate: false, packageName: 'org.x.y' }), { fileName: 'a.aab' });
  assert.equal(r.info.packageName, 'org.x.y');
});

test('AAB: .aab extension alone is not enough', async () => {
  const fake = await inspectAab(new TextEncoder().encode('PK? no'), { fileName: 'release.aab' });
  assert.equal(fake.ok, false);
  const apkLike = await inspectAab(makeZip([{ name: 'AndroidManifest.xml', data: new Uint8Array([1]) }]), { fileName: 'release.aab' });
  assert.equal(apkLike.ok, false);
  assert.ok(apkLike.errors.some((e) => /BundleConfig/.test(e)));
});

test('AAB: unsigned bundle and unreadable manifest produce warnings, not guesses', async () => {
  const unsigned = await inspectAab(makeAab({ signed: false }), { fileName: 'r.aab' });
  assert.ok(unsigned.warnings.some((w) => /signed/.test(w)));
  const broken = makeZip([
    { name: 'base/manifest/AndroidManifest.xml', data: new Uint8Array([0xff, 0xff, 0xff]) },
    { name: 'BundleConfig.pb', data: new Uint8Array([0]) },
  ]);
  const r = await inspectAab(broken, { fileName: 'r.aab' });
  assert.equal(r.ok, true);
  assert.equal(r.info.packageName, null);
  assert.ok(r.warnings.some((w) => /could not be read/.test(w)));
});

test('readZipDirectory rejects truncated archives', () => {
  const aab = makeAab();
  assert.throws(() => readZipDirectory(aab.subarray(0, aab.length - 30)), /end-of-central-directory|corrupt/);
});

test('sha256Hex and validateFileForRole dispatch', async () => {
  const h = await sha256Hex(new TextEncoder().encode('abc'));
  assert.equal(h, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal((await validateFileForRole('aabFile', makeAab(), { fileName: 'x.aab' })).ok, true);
  assert.equal((await validateFileForRole('appIcon', makePng(512, 512, { colorType: 6 }))).ok, true);
});
