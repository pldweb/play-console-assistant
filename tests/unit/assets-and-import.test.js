import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverAssets, validateMapping, findDuplicateContent } from '../../src/services/asset-discovery.js';
import { DEFAULT_SETTINGS } from '../../src/data/settings-repository.js';
import { createAssetRepository, createMemoryBackend, referencedAssetIds } from '../../src/data/asset-repository.js';
import { buildExport, planImport } from '../../src/services/export-import.js';
import { createApplication } from '../../src/data/schema.js';
import { readyApp } from '../helpers/factories.js';

const conv = DEFAULT_SETTINGS.filenameConventions;
const files = (...names) => names.map((name) => ({ name, size: 10 }));

test('discovers conventional names with explicit screenshot order', () => {
  const r = discoverAssets(files('phone-02.png', 'app-icon.png', 'feature-graphic.jpg', 'phone-01.png', 'phone-10.png',
    'release.aab', 'release-notes.txt', 'tablet-7-01.png', 'tablet10-01.png'), conv);
  assert.equal(r.assignments.appIcon, 'app-icon.png');
  assert.equal(r.assignments.featureGraphic, 'feature-graphic.jpg');
  assert.deepEqual(r.assignments.phoneScreenshots, ['phone-01.png', 'phone-02.png', 'phone-10.png']);
  assert.deepEqual(r.assignments.tablet7Screenshots, ['tablet-7-01.png']);
  assert.deepEqual(r.assignments.tablet10Screenshots, ['tablet10-01.png']);
  assert.equal(r.assignments.aabFile, 'release.aab');
  assert.equal(r.assignments.releaseNotes, 'release-notes.txt');
  assert.deepEqual(r.ambiguous, []);
});

test('multiple candidates for a single role are ambiguous, never first-wins', () => {
  const r = discoverAssets(files('release.aab', 'release-old.aab', 'icon.png', 'app-icon.png'), conv);
  assert.equal(r.assignments.aabFile, undefined);
  assert.equal(r.assignments.appIcon, undefined);
  assert.ok(r.ambiguous.some((a) => a.role === 'aabFile' && a.candidates.length === 2));
  assert.ok(r.ambiguous.some((a) => a.role === 'appIcon'));
});

test('duplicate screenshot positions are ambiguous', () => {
  const r = discoverAssets(files('phone-1.png', 'phone-01.png', 'phone-02.png'), conv);
  assert.equal(r.assignments.phoneScreenshots, undefined);
  assert.ok(r.ambiguous.some((a) => /position 1/.test(a.reason)));
});

test('unmatched files stay unassigned; hidden files ignored', () => {
  const r = discoverAssets(files('random.png', '.DS_Store', 'Thumbs.db', 'screenshot.png'), conv);
  assert.deepEqual(r.unassigned.sort(), ['random.png', 'screenshot.png']);
  assert.deepEqual(r.assignments, {});
});

test('more than 8 screenshots requires a choice', () => {
  const names = Array.from({ length: 9 }, (_, i) => `phone-0${i + 1}.png`);
  const r = discoverAssets(files(...names), conv);
  assert.equal(r.assignments.phoneScreenshots, undefined);
  assert.ok(r.ambiguous.some((a) => a.role === 'phoneScreenshots'));
});

test('files matching two conventions are conflicts', () => {
  const r = discoverAssets(files('icon.png'), { ...conv, featureGraphic: '^icon\\.png$' });
  assert.deepEqual(r.conflicts, [{ file: 'icon.png', roles: ['appIcon', 'featureGraphic'] }]);
});

test('validateMapping blocks a file used twice and multi-files on single roles', () => {
  assert.equal(validateMapping({ appIcon: 'a.png', phoneScreenshots: ['b.png', 'c.png'] }).valid, true);
  assert.equal(validateMapping({ appIcon: 'a.png', featureGraphic: 'a.png' }).valid, false);
  assert.equal(validateMapping({ appIcon: ['a.png', 'b.png'] }).valid, false);
});

test('findDuplicateContent groups identical hashes', () => {
  assert.deepEqual(findDuplicateContent({ 'a.png': 'h1', 'b.png': 'h1', 'c.png': 'h2' }), [['a.png', 'b.png']]);
});

test('asset repository scopes records to their application', async () => {
  const repo = createAssetRepository({ backend: createMemoryBackend() });
  const meta = await repo.put({ appId: 'app-1', role: 'appIcon', fileName: 'icon.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) });
  assert.equal(meta.size, 3);
  assert.equal(meta.bytes, undefined);
  assert.ok(await repo.getForApp('app-1', meta.id));
  assert.equal(await repo.getForApp('app-2', meta.id), null, 'other app must not read this asset');
  await repo.put({ appId: 'app-1', role: 'phoneScreenshots', fileName: 'p.png', bytes: new Uint8Array([9]) });
  assert.equal((await repo.listForApp('app-1')).length, 2);
  assert.equal(await repo.pruneUnreferenced('app-1', [meta.id]), 1);
  await repo.removeForApp('app-1');
  assert.equal((await repo.listForApp('app-1')).length, 0);
});

test('referencedAssetIds collects every asset slot', () => {
  const app = readyApp();
  assert.equal(referencedAssetIds(app).length, 5);
});

test('export/import round trip strips assets and resets workflow', () => {
  const a = readyApp();
  a.workflow.state = 'STORE_LISTING_COMPLETED';
  const json = JSON.stringify(buildExport([a]));
  const plan = planImport(json, []);
  assert.equal(plan.ok, true);
  assert.equal(plan.toAdd.length, 1);
  const imported = plan.toAdd[0];
  assert.equal(imported.id, a.id);
  assert.equal(imported.workflow.state, 'DRAFT');
  assert.equal(imported.assets.appIcon, null);
  assert.equal(imported.release.aabFile, null);
  assert.equal(imported.storeListing.fullDescription, a.storeListing.fullDescription);
});

test('import plan separates overwrites, invalid records and package conflicts', () => {
  const existing = createApplication({ metadata: { appName: 'E', packageName: 'com.acme.one' } });
  const overwrite = { ...structuredClone(existing), metadata: { ...existing.metadata, appName: 'E2' } };
  const conflict = createApplication({ metadata: { packageName: 'com.acme.one' } });
  const bad = createApplication({ metadata: { packageName: 'nope' } });
  const plan = planImport(JSON.stringify(buildExport([overwrite, conflict, bad])), [existing]);
  assert.equal(plan.toOverwrite.length, 1);
  assert.equal(plan.toAdd.length, 1);
  assert.equal(plan.invalid.length, 1);
  assert.equal(plan.packageConflicts.length, 1);
  assert.equal(plan.packageConflicts[0].packageName, 'com.acme.one');
});

test('import rejects foreign or malformed files', () => {
  assert.equal(planImport('{', []).ok, false);
  assert.equal(planImport(JSON.stringify({ format: 'other' }), []).ok, false);
  assert.equal(planImport(JSON.stringify({ format: 'play-console-assistant-export', exportVersion: 9, applications: [] }), []).ok, false);
  const newer = { ...createApplication(), schemaVersion: 99 };
  const plan = planImport(JSON.stringify(buildExport([newer])), []);
  assert.equal(plan.invalid.length, 1);
  assert.match(plan.invalid[0].errors[0].message, /newer/);
});
