/**
 * Binary asset storage. File bytes live in IndexedDB on the extension
 * origin (chrome.storage.local is reserved for structured metadata).
 * Records carry their owning appId so an asset can never be served for a
 * different application.
 */
import { generateId } from './schema.js';

const DB_NAME = 'pca-assets';
const STORE = 'assets';

/** IndexedDB backend (extension pages and service worker). */
export function createIdbBackend(indexedDB = globalThis.indexedDB) {
  let dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
          store.createIndex('appId', 'appId', { unique: false });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      Promise.resolve(fn(store, (r) => { result = r; })).catch(reject);
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('IndexedDB transaction aborted'));
    });
  };
  const reqP = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  return {
    put: (rec) => tx('readwrite', (s) => { s.put(rec); }),
    get: (id) => tx('readonly', async (s, set) => set(await reqP(s.get(id)))),
    delete: (id) => tx('readwrite', (s) => { s.delete(id); }),
    listByApp: (appId) => tx('readonly', async (s, set) => set(await reqP(s.index('appId').getAll(appId)))),
  };
}

/** In-memory backend used by tests. */
export function createMemoryBackend() {
  const m = new Map();
  return {
    put: async (rec) => { m.set(rec.id, rec); },
    get: async (id) => m.get(id),
    delete: async (id) => { m.delete(id); },
    listByApp: async (appId) => [...m.values()].filter((r) => r.appId === appId),
  };
}

export function createAssetRepository({ backend = createIdbBackend(), clock = () => new Date() } = {}) {
  /** Stores bytes and returns the record (without bytes). */
  async function put({ appId, role, fileName, mimeType, bytes }) {
    if (!appId || !role || !fileName) throw new Error('appId, role and fileName are required.');
    const rec = {
      id: generateId(),
      appId,
      role,
      fileName,
      mimeType: mimeType || 'application/octet-stream',
      size: bytes.byteLength,
      bytes: bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      storedAt: clock().toISOString(),
    };
    await backend.put(rec);
    const { bytes: _omit, ...meta } = rec;
    return meta;
  }

  /** Returns the record only when it belongs to `appId`. */
  async function getForApp(appId, assetId) {
    const rec = await backend.get(assetId);
    if (!rec || rec.appId !== appId) return null;
    return rec;
  }

  async function remove(assetId) {
    await backend.delete(assetId);
  }

  async function listForApp(appId) {
    const recs = await backend.listByApp(appId);
    return recs.map(({ bytes: _b, ...meta }) => meta);
  }

  async function removeForApp(appId) {
    for (const r of await backend.listByApp(appId)) await backend.delete(r.id);
  }

  /** Deletes stored assets of `appId` that the record no longer references. */
  async function pruneUnreferenced(appId, referencedIds) {
    const keep = new Set(referencedIds);
    let removed = 0;
    for (const r of await backend.listByApp(appId)) {
      if (!keep.has(r.id)) { await backend.delete(r.id); removed += 1; }
    }
    return removed;
  }

  return { put, getForApp, remove, listForApp, removeForApp, pruneUnreferenced };
}

/** All asset ids referenced by an application record. */
export function referencedAssetIds(app) {
  const ids = [];
  const a = app.assets;
  for (const v of [a.appIcon, a.featureGraphic, ...a.phoneScreenshots, ...a.tablet7Screenshots, ...a.tablet10Screenshots, app.release.aabFile]) {
    if (v && v.assetId) ids.push(v.assetId);
  }
  return ids;
}
