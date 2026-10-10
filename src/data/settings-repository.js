/**
 * User-adjustable settings. Defaults are conservative: plan approval is on,
 * retries are few, and URL templates are marked UNVERIFIED in the docs.
 */
export const SETTINGS_KEY = 'settings';

export const DEFAULT_SETTINGS = Object.freeze({
  // Require the user to approve each stage's inspection report before the
  // extension writes anything. Keep on until selectors are verified live.
  requirePlanApproval: true,
  retryLimit: 2,
  retryBaseDelayMs: 1000,
  stepTimeoutMs: 30000,
  navigationTimeoutMs: 30000,
  pollIntervalMs: 1000,
  bundleProcessingTimeoutMs: 600000,
  // Which signed-in Google account index Play Console uses (/console/u/N/).
  consoleUserIndex: 0,
  filenameConventions: {
    appIcon: '^(app[-_ ]?)?icon\\.png$',
    featureGraphic: '^feature[-_ ]?graphic\\.(png|jpe?g)$',
    phoneScreenshots: '^phone[-_ ]?(\\d{1,2})\\.(png|jpe?g)$',
    tablet7Screenshots: '^tablet[-_ ]?7[-_ ](\\d{1,2})\\.(png|jpe?g)$',
    tablet10Screenshots: '^tablet[-_ ]?10[-_ ](\\d{1,2})\\.(png|jpe?g)$',
    aabFile: '\\.aab$',
    releaseNotes: '^release[-_ ]?notes\\.txt$',
  },
});

function defaultStorage() {
  return globalThis.chrome.storage.local;
}

export function createSettingsRepository({ storage = defaultStorage() } = {}) {
  async function get() {
    const res = await storage.get(SETTINGS_KEY);
    const saved = res[SETTINGS_KEY] || {};
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      filenameConventions: { ...DEFAULT_SETTINGS.filenameConventions, ...(saved.filenameConventions || {}) },
    };
  }

  async function set(partial) {
    const current = await get();
    const next = { ...current, ...partial };
    next.retryLimit = clampInt(next.retryLimit, 0, 5);
    next.stepTimeoutMs = clampInt(next.stepTimeoutMs, 5000, 300000);
    next.consoleUserIndex = clampInt(next.consoleUserIndex, 0, 9);
    for (const [k, v] of Object.entries(next.filenameConventions)) {
      try {
        new RegExp(v, 'i');
      } catch {
        throw new Error(`Filename convention for ${k} is not a valid regular expression.`);
      }
    }
    await storage.set({ [SETTINGS_KEY]: next });
    return next;
  }

  return { get, set };
}

function clampInt(v, min, max) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
