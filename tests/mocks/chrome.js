/**
 * Minimal in-memory implementation of the chrome.* APIs the extension uses.
 * Mirrors chrome.storage semantics: values are JSON-cloned on write/read.
 */
export function createStorageArea({ failOnSet = null } = {}) {
  let data = {};
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    _dump: () => clone(data),
    _reset: () => { data = {}; },
    async get(keys) {
      if (keys === null || keys === undefined) return clone(data);
      if (typeof keys === 'string') return keys in data ? { [keys]: clone(data[keys]) } : {};
      if (Array.isArray(keys)) {
        const out = {};
        for (const k of keys) if (k in data) out[k] = clone(data[k]);
        return out;
      }
      const out = {};
      for (const [k, def] of Object.entries(keys)) out[k] = k in data ? clone(data[k]) : def;
      return out;
    },
    async set(items) {
      if (failOnSet && failOnSet(items)) throw new Error('QUOTA_BYTES quota exceeded');
      for (const [k, v] of Object.entries(items)) data[k] = clone(v);
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
    async clear() { data = {}; },
  };
}

export function createChromeMock() {
  return {
    runtime: { id: 'test-extension-id' },
    storage: { local: createStorageArea(), session: createStorageArea() },
  };
}

/** Deterministic clock for tests. */
export function fixedClock(start = '2026-01-01T00:00:00.000Z', stepMs = 1000) {
  let t = new Date(start).getTime();
  return () => { const d = new Date(t); t += stepMs; return d; };
}
