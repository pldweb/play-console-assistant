/**
 * Structured local log stored as a ring buffer in chrome.storage.local.
 * Never logs credentials, cookies or tokens; sensitive keys are redacted
 * and long strings are truncated.
 */
export const LOG_KEY = 'logs';
export const LOG_LIMIT = 2000;

const SENSITIVE_KEY = /pass(word)?|token|cookie|secret|auth|credential|session|otp/i;
const MAX_STRING = 300;

export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value !== 'object') return value;
  if (depth > 4) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function defaultStorage() {
  return globalThis.chrome.storage.local;
}

export function createLogger({ storage = defaultStorage(), clock = () => new Date(), echo = false } = {}) {
  // Serialise writes so concurrent log calls don't drop entries.
  let chain = Promise.resolve();

  function log({ appId = null, stage = null, action, outcome, errorCode = null, message = '', details = undefined }) {
    const entry = {
      ts: clock().toISOString(),
      appId,
      stage,
      action: String(action || ''),
      outcome: String(outcome || 'info'),
      errorCode,
      message: redact(String(message || '')),
      ...(details !== undefined ? { details: redact(details) } : {}),
    };
    if (echo) console.debug('[PCA]', entry);
    chain = chain.then(async () => {
      const res = await storage.get(LOG_KEY);
      const logs = Array.isArray(res[LOG_KEY]) ? res[LOG_KEY] : [];
      logs.push(entry);
      await storage.set({ [LOG_KEY]: logs.slice(-LOG_LIMIT) });
    }).catch(() => {});
    return chain.then(() => entry);
  }

  async function list({ appId = null, limit = 200 } = {}) {
    await chain;
    const res = await storage.get(LOG_KEY);
    const logs = Array.isArray(res[LOG_KEY]) ? res[LOG_KEY] : [];
    return (appId ? logs.filter((l) => l.appId === appId) : logs).slice(-limit);
  }

  async function clear(appId = null) {
    await chain;
    if (!appId) { await storage.set({ [LOG_KEY]: [] }); return; }
    const res = await storage.get(LOG_KEY);
    const logs = Array.isArray(res[LOG_KEY]) ? res[LOG_KEY] : [];
    await storage.set({ [LOG_KEY]: logs.filter((l) => l.appId !== appId) });
  }

  return { log, list, clear };
}
