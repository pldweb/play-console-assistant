/**
 * Asset folder selection and mapping UI.
 *
 * Folder selection: showDirectoryPicker() when available, falling back to
 * <input webkitdirectory>, plus a plain multi-file picker. Directory handles
 * are NOT persisted: file bytes are copied into IndexedDB on save, so the
 * mapping keeps working after a browser restart without re-granting access.
 */
import { h, clear, formatBytes, confirmDialog } from '../services/ui.js';
import { discoverAssets, validateMapping, findDuplicateContent } from '../services/asset-discovery.js';
import { validateFileForRole, sha256Hex } from '../services/file-validation.js';
import { referencedAssetIds } from '../data/asset-repository.js';
import { ASSET_ROLES, LIMITS, charLength } from '../data/schema.js';

const ROLE_OPTIONS = [
  ['', '— Not used —'],
  ['appIcon', 'App icon'],
  ['featureGraphic', 'Feature graphic'],
  ['phoneScreenshots', 'Phone screenshot'],
  ['tablet7Screenshots', '7-inch tablet screenshot'],
  ['tablet10Screenshots', '10-inch tablet screenshot'],
  ['aabFile', 'App bundle (.aab)'],
  ['releaseNotes', 'Release notes (.txt)'],
];
const MULTI = ['phoneScreenshots', 'tablet7Screenshots', 'tablet10Screenshots'];
const MAX_DEPTH = 1;

async function collectDirectory(dir, prefix = '', depth = 0, out = []) {
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') out.push({ file: await handle.getFile(), path: prefix + name });
    else if (handle.kind === 'directory' && depth < MAX_DEPTH) await collectDirectory(handle, `${prefix}${name}/`, depth + 1, out);
  }
  return out;
}

/**
 * @param {object} o
 * @param {HTMLElement} o.container
 * @param {object} o.assetRepo
 * @param {object} o.settingsRepo
 * @param {() => object} o.getApp current (possibly unsaved) form model
 * @param {(patch:object) => Promise<object>} o.applyAssets persists asset changes, returns saved app
 * @param {(msg:string, kind?:string) => void} o.notify
 */
export function createAssetMapper({ container, assetRepo, settingsRepo, getApp, applyAssets, notify }) {
  let rows = [];
  let folderName = '';
  let discovery = null;

  const dirInput = h('input', { type: 'file', webkitdirectory: true, multiple: true, hidden: true });
  const filesInput = h('input', { type: 'file', multiple: true, hidden: true, accept: '.png,.jpg,.jpeg,.aab,.txt' });
  const currentBox = h('div');
  const discoveryBox = h('div', { 'aria-live': 'polite' });
  const tableBox = h('div', { class: 'table-wrap' });
  const checkBtn = h('button', { type: 'button', disabled: true, onclick: () => runChecks() }, 'Check files');
  const saveBtn = h('button', { type: 'button', class: 'primary', disabled: true, onclick: () => save() }, 'Save assets');

  dirInput.addEventListener('change', () => {
    const files = [...dirInput.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }));
    const top = files[0] && files[0].path.includes('/') ? files[0].path.split('/')[0] : '';
    // webkitdirectory includes all depths; keep the same depth as the picker.
    load(files.filter((f) => f.path.split('/').length - (top ? 1 : 0) <= MAX_DEPTH + 1).map((f) => ({ ...f, path: top ? f.path.slice(top.length + 1) : f.path })), top);
    dirInput.value = '';
  });
  filesInput.addEventListener('change', () => {
    load([...filesInput.files].map((file) => ({ file, path: file.name })), '');
    filesInput.value = '';
  });

  async function pickFolder() {
    if (typeof window.showDirectoryPicker === 'function') {
      try {
        const dir = await window.showDirectoryPicker({ mode: 'read', id: 'pca-assets' });
        load(await collectDirectory(dir), dir.name);
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        notify('The folder picker is not available here; using the browser folder upload dialog instead.', 'warn');
      }
    }
    dirInput.click();
  }

  async function load(files, name) {
    folderName = name;
    const settings = await settingsRepo.get();
    discovery = discoverAssets(files.map((f) => ({ name: f.path.split('/').pop(), path: f.path, size: f.file.size })), settings.filenameConventions);
    const byName = new Map();
    rows = files
      .filter((f) => !f.path.split('/').pop().startsWith('.'))
      .map((f) => {
        const row = { file: f.file, name: f.path.split('/').pop(), path: f.path, size: f.file.size, role: '', order: null, result: null, hash: null, note: '' };
        byName.set(row.name, [...(byName.get(row.name) || []), row]);
        return row;
      });
    for (const [role, value] of Object.entries(discovery.assignments)) {
      [].concat(value).forEach((n, i) => {
        const matches = byName.get(n) || [];
        if (matches.length !== 1) return; // same file name in two subfolders: leave for the user
        matches[0].role = role;
        if (MULTI.includes(role)) matches[0].order = i + 1;
      });
    }
    for (const a of discovery.ambiguous) for (const n of a.candidates) for (const r of byName.get(n) || []) r.note = `Ambiguous for ${ASSET_ROLES[a.role] ? ASSET_ROLES[a.role].label : a.role}: ${a.reason}`;
    for (const c of discovery.conflicts) for (const r of byName.get(c.file) || []) r.note = `Matches several conventions (${c.roles.join(', ')}); choose one.`;
    render();
  }

  function renderCurrent() {
    const app = getApp();
    const items = [];
    const line = (label, refs) => {
      const list = [].concat(refs || []).filter(Boolean);
      items.push(h('li', {}, h('strong', {}, `${label}: `), list.length ? list.map((r, i) => `${MULTI.length && list.length > 1 ? `${i + 1}. ` : ''}${r.fileName}${r.width ? ` (${r.width}×${r.height})` : ''}${r.validation && r.validation.errors.length ? ' ⚠ invalid' : ''}`).join(', ') : h('span', { class: 'muted' }, 'none')));
    };
    for (const [role, def] of Object.entries(ASSET_ROLES)) line(def.label, role === 'aabFile' ? app.release.aabFile : app.assets[role]);
    const b = app.release.aabFile && app.release.aabFile.bundle;
    clear(currentBox,
      h('h3', {}, 'Saved assets', app.assets.folderName ? h('span', { class: 'muted small' }, ` — from folder “${app.assets.folderName}”`) : null),
      h('ul', { class: 'current-assets' }, items),
      b ? h('p', { class: 'small' }, `Bundle: package ${b.packageName || 'unknown (not readable)'}, version code ${b.versionCode ?? 'unknown'}.`) : null);
  }

  function roleSelect(row) {
    const sel = h('select', { 'aria-label': `Role for ${row.path}` }, ROLE_OPTIONS.map(([v, l]) => h('option', { value: v }, l)));
    sel.value = row.role;
    sel.addEventListener('change', () => {
      row.role = sel.value;
      row.result = null;
      if (MULTI.includes(row.role) && !row.order) {
        const used = rows.filter((r) => r.role === row.role && r !== row).map((r) => r.order || 0);
        row.order = Math.max(0, ...used) + 1;
      }
      render();
    });
    return sel;
  }

  function orderInput(row) {
    if (!MULTI.includes(row.role)) return h('span', { class: 'muted' }, '—');
    const inp = h('input', { type: 'number', min: '1', max: String(LIMITS.maxScreenshotsPerType), value: String(row.order || ''), 'aria-label': `Position of ${row.path}` });
    inp.addEventListener('change', () => { row.order = Number(inp.value) || null; });
    return inp;
  }

  function statusCell(row) {
    const parts = [];
    if (row.note) parts.push(h('div', { class: 'warn-text' }, row.note));
    if (row.result) {
      if (row.result.ok) parts.push(h('div', { class: 'ok-text' }, '✓ Valid', row.result.info && row.result.info.width ? ` (${row.result.info.width}×${row.result.info.height})` : ''));
      if (row.result.errors.length) parts.push(h('ul', { class: 'error-text' }, row.result.errors.map((e) => h('li', {}, e))));
      if (row.result.warnings.length) parts.push(h('ul', { class: 'warn-text' }, row.result.warnings.map((e) => h('li', {}, e))));
    }
    return h('td', { class: 'asset-status' }, parts);
  }

  function render() {
    renderCurrent();
    const notes = [];
    if (discovery) {
      const assigned = rows.filter((r) => r.role).length;
      notes.push(h('p', {}, `${rows.length} file(s) in “${folderName || 'selection'}”; ${assigned} matched by filename. Check every role below before saving.`));
      if (discovery.ambiguous.length) notes.push(h('div', { class: 'notice warn' }, `${discovery.ambiguous.length} ambiguous match(es) were left unassigned. Choose the right file manually.`));
      if (discovery.unassigned.length) notes.push(h('p', { class: 'small muted' }, `Not matched: ${discovery.unassigned.join(', ')}`));
    }
    clear(discoveryBox, notes);
    if (!rows.length) {
      clear(tableBox);
    } else {
      clear(tableBox, h('table', { class: 'asset-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'File'), h('th', {}, 'Size'), h('th', {}, 'Role'), h('th', {}, 'Position'), h('th', {}, 'Check'))),
        h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.path), h('td', {}, formatBytes(r.size)), h('td', {}, roleSelect(r)), h('td', {}, orderInput(r)), statusCell(r))))));
    }
    checkBtn.disabled = !rows.some((r) => r.role);
    saveBtn.disabled = !rows.some((r) => r.role);
  }

  async function checkRow(row) {
    const bytes = new Uint8Array(await row.file.arrayBuffer());
    if (row.role === 'releaseNotes') {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).trim();
      const errors = charLength(text) > LIMITS.releaseNotes ? [`Release notes exceed ${LIMITS.releaseNotes} characters.`] : [];
      row.result = { ok: errors.length === 0, errors, warnings: [], info: null, text };
    } else {
      row.result = await validateFileForRole(row.role, bytes, { fileName: row.name });
    }
    row.hash = await sha256Hex(bytes);
    row.bytes = bytes;
  }

  async function runChecks() {
    checkBtn.disabled = true;
    try {
      const used = rows.filter((r) => r.role);
      for (const r of used) await checkRow(r);
      const dupes = findDuplicateContent(Object.fromEntries(used.map((r) => [r.path, r.hash])));
      for (const group of dupes) {
        for (const r of used.filter((x) => group.includes(x.path))) r.result.warnings.push(`Identical content to ${group.filter((p) => p !== r.path).join(', ')}.`);
      }
      notify(`Checked ${used.length} file(s).`, 'ok');
    } catch (e) {
      notify(`Could not read a file: ${e.message}`, 'error');
    }
    render();
  }

  function buildMapping() {
    const mapping = {};
    const errors = [];
    for (const role of ROLE_OPTIONS.map(([v]) => v).filter(Boolean)) {
      const list = rows.filter((r) => r.role === role);
      if (!list.length) continue;
      if (MULTI.includes(role)) {
        const orders = list.map((r) => r.order);
        if (orders.some((o) => !Number.isInteger(o) || o < 1)) errors.push(`${ASSET_ROLES[role].label}: every screenshot needs a position.`);
        if (new Set(orders).size !== orders.length) errors.push(`${ASSET_ROLES[role].label}: two screenshots share a position.`);
        mapping[role] = [...list].sort((a, b) => a.order - b.order).map((r) => r.path);
      } else {
        mapping[role] = list.map((r) => r.path);
      }
    }
    const v = validateMapping(Object.fromEntries(Object.entries(mapping).map(([k, v2]) => [k, MULTI.includes(k) ? v2 : v2.length === 1 ? v2[0] : v2])));
    return { mapping, errors: [...errors, ...v.errors] };
  }

  async function save() {
    const { mapping, errors } = buildMapping();
    if (errors.length) { notify(errors.join(' '), 'error'); return; }
    const used = rows.filter((r) => r.role);
    if (used.some((r) => !r.result)) await runChecks();
    const app = getApp();
    const byPath = new Map(rows.map((r) => [r.path, r]));

    // Never overwrite silently: list every replacement and ask.
    const replacements = [];
    for (const [role, paths] of Object.entries(mapping)) {
      if (role === 'releaseNotes') {
        const text = byPath.get(paths[0]).result.text;
        if (app.release.releaseNotes && app.release.releaseNotes !== text) replacements.push(`Release notes: replace the current text with ${paths[0]}`);
        continue;
      }
      const existing = [].concat(role === 'aabFile' ? app.release.aabFile : app.assets[role]).filter(Boolean);
      const next = paths.map((p) => byPath.get(p).name);
      if (existing.length && existing.map((e) => e.fileName).join('|') !== next.join('|')) {
        replacements.push(`${ASSET_ROLES[role].label}: ${existing.map((e) => e.fileName).join(', ')} → ${next.join(', ')}`);
      }
    }
    const invalid = used.filter((r) => r.result && !r.result.ok);
    if (replacements.length || invalid.length) {
      const ok = await confirmDialog({
        title: 'Save these assets?',
        message: replacements.length ? 'The following saved assets will be replaced:' : 'Some files did not pass the checks.',
        details: h('div', {},
          replacements.length ? h('ul', {}, replacements.map((x) => h('li', {}, x))) : null,
          invalid.length ? h('p', { class: 'error-text' }, `${invalid.length} file(s) have errors and will block automation until replaced: ${invalid.map((r) => r.path).join(', ')}`) : null),
        confirmLabel: 'Save assets',
      });
      if (!ok) return;
    }

    saveBtn.disabled = true;
    try {
      const patch = { assets: { folderName }, release: {} };
      for (const [role, paths] of Object.entries(mapping)) {
        if (role === 'releaseNotes') { patch.release.releaseNotes = byPath.get(paths[0]).result.text; continue; }
        const refs = [];
        for (const p of paths) {
          const r = byPath.get(p);
          const meta = await assetRepo.put({ appId: app.id, role, fileName: r.name, mimeType: r.file.type || (role === 'aabFile' ? 'application/octet-stream' : `image/${r.result.info ? r.result.info.format : 'png'}`), bytes: r.bytes });
          const info = r.result.info || {};
          refs.push({
            assetId: meta.id,
            fileName: r.name,
            size: r.size,
            mimeType: meta.mimeType,
            sha256: r.hash,
            ...(info.width ? { width: info.width, height: info.height, hasAlpha: info.hasAlpha } : {}),
            ...(role === 'aabFile' ? { bundle: { packageName: info.packageName, versionCode: info.versionCode, versionName: info.versionName } } : {}),
            validation: { errors: r.result.errors, warnings: r.result.warnings },
          });
        }
        if (role === 'aabFile') {
          patch.release.aabFile = refs[0];
          if (refs[0].bundle.versionCode && !app.release.versionCode) patch.release.versionCode = refs[0].bundle.versionCode;
          if (refs[0].bundle.versionName && !app.release.versionName) patch.release.versionName = refs[0].bundle.versionName;
        } else {
          patch.assets[role] = ASSET_ROLES[role].multiple ? refs : refs[0];
        }
      }
      const saved = await applyAssets(patch);
      const removed = await assetRepo.pruneUnreferenced(saved.id, referencedAssetIds(saved));
      notify(`Assets saved.${removed ? ` ${removed} replaced file(s) removed from storage.` : ''}`, 'ok');
      rows = [];
      discovery = null;
      render();
    } catch (e) {
      notify(`Saving assets failed: ${e.message}`, 'error');
      render();
    }
  }

  clear(container,
    currentBox,
    h('div', { class: 'row', style: 'margin:.6rem 0' },
      h('button', { type: 'button', onclick: pickFolder }, 'Select folder…'),
      h('button', { type: 'button', onclick: () => filesInput.click() }, 'Select files…'),
      dirInput, filesInput),
    discoveryBox, tableBox,
    h('div', { class: 'row', style: 'margin-top:.6rem' }, checkBtn, saveBtn));
  render();
  return { refresh: render };
}
