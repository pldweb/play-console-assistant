/**
 * Play Console page detection.
 *
 * A page is recognised only when BOTH its URL path and its main heading
 * match. APP_LIST, CREATE_APP, APP_DASHBOARD and STORE_LISTING were checked
 * on the live console (2026-10-10); the rest is UNVERIFIED (see
 * docs/SELECTOR_MAP.md). Anything that does not match is UNKNOWN and
 * automation stops.
 */
import { getHeadingTexts, normalize, pageHasText, hasElementWithExactText } from './dom-utils.js';

export const PAGE_TYPES = Object.freeze({
  APP_LIST: 'APP_LIST',
  CREATE_APP: 'CREATE_APP',
  APP_DASHBOARD: 'APP_DASHBOARD',
  STORE_LISTING: 'STORE_LISTING',
  STORE_SETTINGS: 'STORE_SETTINGS',
  APP_CONTENT_OVERVIEW: 'APP_CONTENT_OVERVIEW',
  APP_CONTENT_PRIVACY_POLICY: 'APP_CONTENT_PRIVACY_POLICY',
  APP_CONTENT_ADS: 'APP_CONTENT_ADS',
  APP_CONTENT_APP_ACCESS: 'APP_CONTENT_APP_ACCESS',
  TRACK: 'TRACK',
  RELEASE_EDIT: 'RELEASE_EDIT',
  PUBLISHING_OVERVIEW: 'PUBLISHING_OVERVIEW',
  SIGNUP: 'SIGNUP',
  SIGN_IN: 'SIGN_IN',
  UNKNOWN: 'UNKNOWN',
});
const P = PAGE_TYPES;

export const CONSOLE_ORIGIN = 'https://play.google.com';

// Path suffix after /console/u/{n}/developers/{devId}/  (live-checked)
const DEV_ROUTES = [
  { re: /^app-list\/?$/, type: P.APP_LIST },
  { re: /^create-new-app\/?$/, type: P.CREATE_APP },
];
// Path suffix after .../app/{appId}/  (app-dashboard, store-listings/default/edit,
// store-settings, app-content/overview, tracks/*, closed-testing and publishing
// seen live as navigation links; the others are UNVERIFIED)
const APP_ROUTES = [
  { re: /^app-dashboard\/?$/, type: P.APP_DASHBOARD },
  { re: /^store-listings\/default\/edit\/?$/, type: P.STORE_LISTING },
  { re: /^store-settings\/?$/, type: P.STORE_SETTINGS },
  { re: /^app-content\/privacy-policy\/?$/, type: P.APP_CONTENT_PRIVACY_POLICY },
  { re: /^app-content\/ads-declaration\/?$/, type: P.APP_CONTENT_ADS },
  { re: /^app-content\/testing-credentials\/?$/, type: P.APP_CONTENT_APP_ACCESS },
  { re: /^app-content(\/overview)?\/?$/, type: P.APP_CONTENT_OVERVIEW },
  { re: /^tracks\/([a-z-]+)\/?$/, type: P.TRACK, track: 1 },
  { re: /^(closed-testing)\/?$/, type: P.TRACK, track: 1 },
  { re: /^tracks\/([a-z-]+)\/releases\/([^/]+)\/(prepare|create|edit)\/?$/, type: P.RELEASE_EDIT, track: 1 },
  { re: /^publishing\/?$/, type: P.PUBLISHING_OVERVIEW },
];

/** Expected main heading per page type (see the file comment for what is live-checked). */
export const PAGE_HEADINGS = Object.freeze({
  // The app list's h1 is the developer account name; the level-2 heading
  // counts the apps ("2 apps").
  [P.APP_LIST]: /^(All apps|Home|\d+ apps?)$/i,
  [P.CREATE_APP]: /^Create app$/i,
  [P.APP_DASHBOARD]: /^Dashboard$/i,
  [P.STORE_LISTING]: /^(Default|Main) store listing$/i,
  [P.STORE_SETTINGS]: /^Store settings$/i,
  [P.APP_CONTENT_OVERVIEW]: /^App content$/i,
  [P.APP_CONTENT_PRIVACY_POLICY]: /^Privacy policy$/i,
  [P.APP_CONTENT_ADS]: /^Ads$/i,
  [P.APP_CONTENT_APP_ACCESS]: /^App access$/i,
  [P.TRACK]: /^(Internal testing|Closed testing|Open testing|Production)$/i,
  [P.RELEASE_EDIT]: /^(Create|Edit) (internal testing |closed testing |open testing |production )?release$/i,
  [P.PUBLISHING_OVERVIEW]: /^Publishing overview$/i,
});

/** Internal track id -> URL slug. */
export const TRACK_SLUGS = Object.freeze({
  internal: 'internal-testing',
  closed: 'closed-testing',
  open: 'open-testing',
  production: 'production',
});
/** Track page path below .../app/{appId}/ (closed testing has no tracks/ prefix). */
const TRACK_PATHS = Object.freeze({
  internal: 'tracks/internal-testing',
  closed: 'closed-testing',
  open: 'tracks/open-testing',
  production: 'tracks/production',
});

/** URL templates for navigation. */
export const URL_TEMPLATES = Object.freeze({
  [P.APP_LIST]: '/console/u/{u}/developers/{dev}/app-list',
  [P.CREATE_APP]: '/console/u/{u}/developers/{dev}/create-new-app',
  [P.APP_DASHBOARD]: '/console/u/{u}/developers/{dev}/app/{app}/app-dashboard',
  [P.STORE_LISTING]: '/console/u/{u}/developers/{dev}/app/{app}/store-listings/default/edit',
  [P.STORE_SETTINGS]: '/console/u/{u}/developers/{dev}/app/{app}/store-settings',
  [P.APP_CONTENT_OVERVIEW]: '/console/u/{u}/developers/{dev}/app/{app}/app-content/overview',
  [P.APP_CONTENT_PRIVACY_POLICY]: '/console/u/{u}/developers/{dev}/app/{app}/app-content/privacy-policy',
  [P.APP_CONTENT_ADS]: '/console/u/{u}/developers/{dev}/app/{app}/app-content/ads-declaration',
  [P.APP_CONTENT_APP_ACCESS]: '/console/u/{u}/developers/{dev}/app/{app}/app-content/testing-credentials',
  [P.TRACK]: '/console/u/{u}/developers/{dev}/app/{app}/{track}',
  [P.PUBLISHING_OVERVIEW]: '/console/u/{u}/developers/{dev}/app/{app}/publishing',
});

export function buildConsoleUrl(pageType, { userIndex = 0, developerId, appId, track } = {}) {
  const tpl = URL_TEMPLATES[pageType];
  if (!tpl) return null;
  if (tpl.includes('{dev}') && !developerId) return null;
  if (tpl.includes('{app}') && !appId) return null;
  return CONSOLE_ORIGIN + tpl
    .replace('{u}', String(userIndex))
    .replace('{dev}', encodeURIComponent(developerId || ''))
    .replace('{app}', encodeURIComponent(appId || ''))
    .replace('{track}', TRACK_PATHS[track] || TRACK_PATHS.internal);
}

/** Parses a Play Console URL into identity parts and a URL-level page type. */
export function parseConsoleUrl(href) {
  let u;
  try {
    u = new URL(href);
  } catch {
    return { pageType: P.UNKNOWN, reason: 'invalid-url' };
  }
  if (u.hostname === 'accounts.google.com') return { pageType: P.SIGN_IN };
  if (u.origin !== CONSOLE_ORIGIN || !u.pathname.startsWith('/console')) return { pageType: P.UNKNOWN, reason: 'not-console' };
  if (/^\/console(\/u\/\d+)?\/signup/.test(u.pathname)) return { pageType: P.SIGNUP };
  const m = u.pathname.match(/^\/console\/u\/(\d+)\/developers\/([^/]+)\/(.*)$/);
  if (!m) return { pageType: P.UNKNOWN, reason: 'no-developer-path' };
  const [, userIndex, developerId, rest] = m;
  const base = { userIndex: Number(userIndex), developerId: decodeURIComponent(developerId), appId: null, track: null };
  const am = rest.match(/^app\/([^/]+)\/(.*)$/);
  if (am) {
    const appId = decodeURIComponent(am[1]);
    for (const r of APP_ROUTES) {
      const mm = am[2].match(r.re);
      if (mm) return { ...base, appId, pageType: r.type, track: r.track ? trackFromSlug(mm[r.track]) : null };
    }
    return { ...base, appId, pageType: P.UNKNOWN, reason: 'unknown-app-route' };
  }
  for (const r of DEV_ROUTES) if (r.re.test(rest)) return { ...base, pageType: r.type };
  return { ...base, pageType: P.UNKNOWN, reason: 'unknown-developer-route' };
}

function trackFromSlug(slug) {
  const hit = Object.entries(TRACK_SLUGS).find(([, s]) => s === slug);
  return hit ? hit[0] : null;
}

/**
 * Full detection: URL + heading. `ready` is false while the expected
 * heading has not rendered yet (the engine polls with a bound).
 */
export function detectPage(doc, href) {
  const parsed = parseConsoleUrl(href);
  const headings = getHeadingTexts(doc.body || doc);
  const expected = PAGE_HEADINGS[parsed.pageType];
  const headingMatched = expected ? headings.some((h) => expected.test(h)) : false;
  const signedOutBanner = pageHasText(doc.body || doc, /sign in to continue to google play console/i);
  return {
    url: href,
    pageType: parsed.pageType,
    userIndex: parsed.userIndex ?? null,
    developerId: parsed.developerId ?? null,
    appId: parsed.appId ?? null,
    track: parsed.track ?? null,
    headings,
    headingMatched,
    ready: headingMatched,
    authenticated: parsed.pageType !== P.SIGN_IN && !signedOutBanner,
    title: normalize(doc.title),
  };
}

/**
 * True when a visible element's whole text is exactly the app name (case
 * sensitive). A substring match is not enough: "Acme" must not match an
 * app called "Acme Notes".
 */
export function pageShowsAppName(doc, appName) {
  if (!appName) return false;
  return hasElementWithExactText(doc.body || doc, appName);
}
