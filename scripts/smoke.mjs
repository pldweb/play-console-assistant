/**
 * Browser smoke test in a real Chrome, with a throw-away profile.
 *
 * Loads the unpacked extension via the DevTools protocol
 * (Extensions.loadUnpacked, needs --enable-unsafe-extension-debugging and
 * --remote-debugging-pipe), then checks: manifest loads, service worker
 * starts, dashboard/popup/form render without exceptions, data persists
 * across page loads, runtime messaging works and rejects unknown messages,
 * and the IndexedDB asset store works.
 *
 * It does NOT touch play.google.com.
 *
 *   node scripts/smoke.mjs [--chrome=PATH] [--headed]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { makePng, makeAab } from '../tests/helpers/binary.js';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const CANDIDATES = [
  args.chrome,
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chromePath = CANDIDATES.find((p) => existsSync(p));
if (!chromePath) { console.error('Chrome not found; pass --chrome=PATH'); process.exit(2); }

const profile = mkdtempSync(join(tmpdir(), 'pca-smoke-'));
const chrome = spawn(chromePath, [
  `--user-data-dir=${profile}`,
  '--remote-debugging-pipe',
  '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  ...(args.headed ? [] : ['--headless=new']),
  'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });

let stderr = '';
chrome.stderr.on('data', (d) => { stderr += d; });

// ---- CDP over pipe ---------------------------------------------------------
const toChrome = chrome.stdio[3];
const fromChrome = chrome.stdio[4];
let nextId = 1;
const pending = new Map();
const listeners = [];
let buf = '';
fromChrome.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data || ''}`)) : res(msg.result);
    } else {
      for (const l of listeners) l(msg);
    }
  }
});
function send(method, params = {}, sessionId) {
  const id = nextId++;
  toChrome.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
  return new Promise((res, reject) => {
    pending.set(id, { resolve: res, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 20000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function openPage(url) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const errors = [];
  listeners.push((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
  });
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Page.navigate', { url }, sessionId);
  await sleep(1500);
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { targetId, sessionId, errors, evaluate, close: () => send('Target.closeTarget', { targetId }) };
}

async function main() {
  const version = await send('Browser.getVersion');
  check('Chrome started', true, version.product);

  let extId;
  try {
    ({ id: extId } = await send('Extensions.loadUnpacked', { path: ROOT }));
    check('Extension loads (manifest accepted)', Boolean(extId), extId);
  } catch (e) {
    check('Extension loads (manifest accepted)', false, e.message);
    return;
  }
  const base = `chrome-extension://${extId}`;

  let sw = null;
  for (let i = 0; i < 20 && !sw; i++) {
    const { targetInfos } = await send('Target.getTargets');
    sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(base));
    if (!sw) await sleep(250);
  }
  check('Service worker registered', Boolean(sw), sw ? sw.url.replace(base, '') : 'not found');

  // Dashboard renders.
  const dash = await openPage(`${base}/src/dashboard/dashboard.html`);
  const dashInfo = await dash.evaluate(`({ h1: document.querySelector('h1')?.textContent, rows: document.querySelectorAll('#app-rows tr').length, empty: !document.getElementById('empty').hidden })`);
  check('Dashboard opens', dashInfo.h1 === 'Play Console Assistant', JSON.stringify(dashInfo));

  // Messaging with the service worker.
  const status = await dash.evaluate(`chrome.runtime.sendMessage({ type: 'ACTIVE_STATUS' })`);
  check('Runtime messaging: ACTIVE_STATUS answered', status && status.ok === true && status.result.lock === null, JSON.stringify(status));
  const rejected = await dash.evaluate(`chrome.runtime.sendMessage({ type: 'EVIL_COMMAND' })`);
  check('Runtime messaging: unknown type rejected', rejected && rejected.ok === false && rejected.error.code === 'MESSAGE_REJECTED', JSON.stringify(rejected));
  const badPayload = await dash.evaluate(`chrome.runtime.sendMessage({ type: 'ENGINE_START', appId: 'x' })`);
  check('Runtime messaging: invalid payload rejected', badPayload && badPayload.ok === false, JSON.stringify(badPayload));
  const tabs = await dash.evaluate(`chrome.runtime.sendMessage({ type: 'TAB_LIST' })`);
  check('Runtime messaging: TAB_LIST works (no Play Console tab expected)', tabs && tabs.ok === true && Array.isArray(tabs.result), JSON.stringify(tabs));

  // Create an application through the form UI.
  const form = await openPage(`${base}/src/form/application-form.html`);
  const saved = await form.evaluate(`(async () => {
    const set = (sel, v) => { const el = document.querySelector(sel); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('#appName', 'Smoke Test App');
    set('#packageName', 'com.smoketest.app');
    set('#title', 'Smoke Test App');
    set('#shortDescription', 'Short text');
    document.querySelector('#app-form button[type=submit]').click();
    await new Promise((r) => setTimeout(r, 800));
    return { status: document.getElementById('status').textContent, url: location.search };
  })()`);
  check('Form saves a new application', /Saved/.test(saved.status) && /id=/.test(saved.url), JSON.stringify(saved));
  const invalid = await form.evaluate(`(async () => {
    const el = document.querySelector('#packageName'); el.value = 'bad name'; el.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#app-form button[type=submit]').click();
    await new Promise((r) => setTimeout(r, 500));
    return { status: document.getElementById('status').textContent, err: document.querySelector('[data-error-for="metadata.packageName"]').textContent };
  })()`);
  check('Form blocks invalid package name with inline error', /Not saved/.test(invalid.status) && invalid.err.length > 0, JSON.stringify(invalid));

  // Persistence: a fresh dashboard load shows the record from storage.
  const dash2 = await openPage(`${base}/src/dashboard/dashboard.html`);
  const listed = await dash2.evaluate(`[...document.querySelectorAll('#app-rows tr')].map((r) => r.textContent)`);
  check('Data persists (record listed after reload)', listed.some((t) => t.includes('Smoke Test App') && t.includes('com.smoketest.app')), JSON.stringify(listed));
  const stored = await dash2.evaluate(`chrome.storage.local.get(null).then((all) => Object.keys(all).filter((k) => k.startsWith('app:')).length)`);
  check('chrome.storage.local holds the record', stored === 1, `records=${stored}`);

  // Starting without a Play Console tab must not do anything.
  const appId = await dash2.evaluate(`chrome.storage.local.get(null).then((all) => Object.values(all).find((v) => v && v.metadata)?.id)`);
  const start = await dash2.evaluate(`chrome.runtime.sendMessage({ type: 'ENGINE_START', appId: ${JSON.stringify(appId)}, tabId: 999999 })`);
  await sleep(500);
  const after = await dash2.evaluate(`chrome.storage.local.get('app:${appId}').then((r) => r['app:${appId}'].workflow)`);
  check('Start with incomplete data is refused and stays DRAFT', start.ok === true && after.state === 'DRAFT' && after.errorCode === 'VALIDATION_FAILED', JSON.stringify(after));

  // IndexedDB asset storage in the real browser.
  const idb = await dash2.evaluate(`(async () => {
    const m = await import('/src/data/asset-repository.js');
    const repo = m.createAssetRepository();
    const meta = await repo.put({ appId: 'smoke', role: 'appIcon', fileName: 'icon.png', mimeType: 'image/png', bytes: new Uint8Array([1,2,3,4]) });
    const rec = await repo.getForApp('smoke', meta.id);
    const other = await repo.getForApp('other', meta.id);
    await repo.removeForApp('smoke');
    return { size: rec && rec.bytes.byteLength, other, left: (await repo.listForApp('smoke')).length };
  })()`);
  check('IndexedDB asset store works and is app-scoped', idb.size === 4 && idb.other === null && idb.left === 0, JSON.stringify(idb));

  // Byte validation with the browser's DecompressionStream.
  const fv = await dash2.evaluate(`(async () => {
    const m = await import('/src/services/file-validation.js');
    const png = new Uint8Array([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,13, 0x49,0x48,0x44,0x52, 0,0,2,0, 0,0,2,0, 8,6,0,0,0, 0,0,0,0]);
    return m.validateImageForRole('appIcon', png, { fileName: 'icon.png' });
  })()`);
  check('Byte-level image validation runs in the browser', fv.ok === true && fv.info.width === 512, JSON.stringify(fv.info));

  // Content-side modules (handler + adapters + DOM helpers) run in Chrome
  // against a SYNTHETIC page in an iframe. This checks the module graph and
  // DOM interaction code in a real browser; it does not prove the live
  // Play Console selectors.
  const content = await dash2.evaluate(`(async () => {
    const { createContentHandler } = await import('/src/content/message-handler.js');
    const frame = document.createElement('iframe');
    frame.srcdoc = '<main><h1>Main store listing</h1><label for="t">App name</label><input id="t"><label for="s">Short description</label><textarea id="s"></textarea><label for="f">Full description</label><textarea id="f"></textarea><button type="button">Save</button></main>';
    document.body.append(frame);
    await new Promise((r) => frame.addEventListener('load', r, { once: true }));
    const doc = frame.contentDocument;
    // The page acknowledges a save by disabling the button (inline handlers are blocked by CSP).
    doc.querySelector('button').addEventListener('click', (e) => { e.target.disabled = true; });
    const handle = createContentHandler({ document: doc, getHref: () => 'https://play.google.com/console/u/0/developers/1/app/2/main-store-listing', getAsset: async () => null });
    const payload = { title: 'Smoke', shortDescription: 'Short', fullDescription: 'Full', promoVideoUrl: '' };
    const detect = await handle({ type: 'PCA_DETECT' });
    const apply = await handle({ type: 'PCA_APPLY', stage: 'STORE_LISTING', step: 'listing-text', payload, stepTimeoutMs: 2000 });
    const verify = await handle({ type: 'PCA_VERIFY', stage: 'STORE_LISTING', step: 'listing-text', payload });
    frame.remove();
    return { page: detect.page.pageType, ready: detect.page.ready, apply: apply.ok, verify: verify.verify && verify.verify.ok };
  })()`);
  check('Content modules run in Chrome on a synthetic page (detect/apply/verify)', content.page === 'STORE_LISTING' && content.ready && content.apply && content.verify, JSON.stringify(content));

  // Asset pipeline in the real form page: files are attached with
  // DOM.setFileInputFiles (the same as the user picking them).
  const assetDir = mkdtempSync(join(tmpdir(), 'pca-assets-'));
  const files = {
    'app-icon.png': makePng(512, 512, { colorType: 6 }),
    'feature-graphic.png': makePng(1024, 500),
    'phone-02.png': makePng(1080, 1920),
    'phone-01.png': makePng(1080, 1920, { padTo: 200 }),
    'release.aab': makeAab({ packageName: 'com.smoketest.app', versionCode: '3' }),
    'release-notes.txt': new TextEncoder().encode('Smoke release notes'),
    'random.png': makePng(10, 10),
  };
  for (const [n, b] of Object.entries(files)) writeFileSync(join(assetDir, n), b);
  const af = await openPage(`${base}/src/form/application-form.html?id=${appId}`);
  const { root } = await send('DOM.getDocument', {}, af.sessionId);
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#asset-mapper input[type=file][accept]' }, af.sessionId);
  await send('DOM.setFileInputFiles', { nodeId, files: Object.keys(files).map((n) => join(assetDir, n)) }, af.sessionId);
  await sleep(800);
  const mapped = await af.evaluate(`[...document.querySelectorAll('.asset-table tbody tr')].map((tr) => [tr.cells[0].textContent, tr.querySelector('select').value, tr.querySelector('input[type=number]') ? tr.querySelector('input[type=number]').value : ''])`);
  const roleOf = Object.fromEntries(mapped.map(([n, r, o]) => [n, `${r}${o ? `#${o}` : ''}`]));
  check('Asset discovery maps conventional names and leaves others unassigned',
    roleOf['app-icon.png'] === 'appIcon' && roleOf['phone-01.png'] === 'phoneScreenshots#1' && roleOf['phone-02.png'] === 'phoneScreenshots#2'
    && roleOf['release.aab'] === 'aabFile' && roleOf['random.png'] === '', JSON.stringify(roleOf));
  await af.evaluate(`[...document.querySelectorAll('#asset-mapper button')].find((b) => b.textContent === 'Check files').click()`);
  await sleep(800);
  const checks = await af.evaluate(`[...document.querySelectorAll('.asset-table tbody tr')].map((tr) => tr.cells[0].textContent + ': ' + tr.cells[4].textContent).join(' | ')`);
  check('Asset byte checks run in the browser', /release\.aab: ✓ Valid/.test(checks) && /app-icon\.png: ✓ Valid/.test(checks), checks);
  await af.evaluate(`[...document.querySelectorAll('#asset-mapper button')].find((b) => b.textContent === 'Save assets').click()`);
  await sleep(1200);
  const savedApp = await af.evaluate(`chrome.storage.local.get('app:${appId}').then((r) => r['app:${appId}'])`);
  const idbCount = await af.evaluate(`import('/src/data/asset-repository.js').then((m) => m.createAssetRepository().listForApp(${JSON.stringify(appId)})).then((l) => l.length)`);
  check('Assets saved: metadata in storage, bytes in IndexedDB, bundle identity read',
    savedApp.assets.appIcon && savedApp.assets.phoneScreenshots.map((x) => x.fileName).join(',') === 'phone-01.png,phone-02.png'
    && savedApp.release.aabFile.bundle.packageName === 'com.smoketest.app' && savedApp.release.versionCode === 3
    && savedApp.release.releaseNotes === 'Smoke release notes' && idbCount === 5,
    JSON.stringify({ icon: savedApp.assets.appIcon && savedApp.assets.appIcon.fileName, bundle: savedApp.release.aabFile && savedApp.release.aabFile.bundle, idbCount, notes: savedApp.release.releaseNotes }));
  // Re-selecting a different icon must ask before replacing.
  writeFileSync(join(assetDir, 'icon.png'), makePng(512, 512, { colorType: 6, padTo: 300 }));
  await send('DOM.setFileInputFiles', { nodeId, files: [join(assetDir, 'icon.png')] }, af.sessionId);
  await sleep(600);
  await af.evaluate(`[...document.querySelectorAll('#asset-mapper button')].find((b) => b.textContent === 'Save assets').click()`);
  await sleep(800);
  const dlg = await af.evaluate(`(() => { const d = document.querySelector('dialog[open]'); const t = d ? d.textContent : null; if (d) [...d.querySelectorAll('button')].find((b) => b.textContent === 'Cancel').click(); return t; })()`);
  const stillOld = await af.evaluate(`chrome.storage.local.get('app:${appId}').then((r) => r['app:${appId}'].assets.appIcon.fileName)`);
  check('Replacing a saved asset asks first; cancel keeps the old one', Boolean(dlg && /app-icon\.png → icon\.png/.test(dlg)) && stillOld === 'app-icon.png', `${dlg ? dlg.slice(0, 120) : 'no dialog'} / kept=${stillOld}`);
  try { rmSync(assetDir, { recursive: true, force: true }); } catch { /* ignore */ }

  // Popup renders.
  const popup = await openPage(`${base}/src/popup/popup.html`);
  await sleep(500);
  const pop = await popup.evaluate(`({ page: document.getElementById('page').textContent })`);
  check('Popup opens', pop.page.length > 0, JSON.stringify(pop));

  if (args.screenshots) {
    mkdirSync(args.screenshots, { recursive: true });
    const shot = async (pg, name, width = 1280, height = 900) => {
      await send('Page.bringToFront', {}, pg.sessionId);
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, pg.sessionId);
      await sleep(400);
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, pg.sessionId);
      writeFileSync(join(args.screenshots, `${name}.png`), Buffer.from(data, 'base64'));
    };
    await dash2.evaluate(`document.querySelector('#app-rows a').click()`);
    await sleep(500);
    await shot(dash2, 'dashboard');
    const formShot = await openPage(`${base}/src/form/application-form.html?id=${appId}`);
    await formShot.evaluate(`document.getElementById('validate-btn').click()`);
    await shot(formShot, 'form');
    await shot(popup, 'popup', 360, 260);
    console.log(`screenshots written to ${args.screenshots}`);
  }

  const allErrors = [dash, form, dash2, popup, af].flatMap((p) => p.errors).filter((e) => !/favicon/.test(e));
  check('No uncaught exceptions or console errors on extension pages', allErrors.length === 0, allErrors.join(' | '));
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  check('Smoke run completed', false, e.stack || e.message);
} finally {
  try { await send('Browser.close'); } catch { chrome.kill(); }
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold files */ }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} smoke checks passed.`);
  if (failed.length) exitCode = 1;
  if (failed.length && stderr) console.log(`Chrome stderr (tail):\n${stderr.split('\n').slice(-15).join('\n')}`);
  process.exit(exitCode);
}
