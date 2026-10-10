/**
 * Versioned application schema, defaults, validation and migration.
 *
 * Limits below come from Play Console Help (see docs/PLATFORM_AUDIT.md).
 * Unanswered declarations are `null`, never `false`: `false` would be a
 * factual answer ("no ads") that the user did not give.
 */
import { STATES } from '../automation/workflow-states.js';

export const SCHEMA_VERSION = 1;

export const LIMITS = Object.freeze({
  appName: 30,
  title: 30,
  shortDescription: 80,
  fullDescription: 4000,
  releaseNotes: 500,
  packageName: 150,
  maxScreenshotsPerType: 8,
  minScreenshotsTotal: 2,
  maxVersionCode: 2100000000,
});

export const APP_OR_GAME = Object.freeze(['app', 'game']);
export const PRICING = Object.freeze(['free', 'paid']);
export const RELEASE_TRACKS = Object.freeze(['internal', 'closed', 'open', 'production']);
export const APP_ACCESS = Object.freeze(['all_available', 'restricted']);
export const MANUAL_SECTION_STATUS = Object.freeze(['not_started', 'completed_by_user']);

// Category lists as published in Play Console Help at audit time.
// UNVERIFIED against the live dropdown; the adapter matches by visible text.
export const APP_CATEGORIES = Object.freeze([
  'Art & Design', 'Auto & Vehicles', 'Beauty', 'Books & Reference', 'Business', 'Comics',
  'Communication', 'Dating', 'Education', 'Entertainment', 'Events', 'Finance', 'Food & Drink',
  'Health & Fitness', 'House & Home', 'Libraries & Demo', 'Lifestyle', 'Maps & Navigation',
  'Medical', 'Music & Audio', 'News & Magazines', 'Parenting', 'Personalization', 'Photography',
  'Productivity', 'Shopping', 'Social', 'Sports', 'Tools', 'Travel & Local',
  'Video Players & Editors', 'Weather',
]);
export const GAME_CATEGORIES = Object.freeze([
  'Action', 'Adventure', 'Arcade', 'Board', 'Card', 'Casino', 'Casual', 'Educational', 'Music',
  'Puzzle', 'Racing', 'Role Playing', 'Simulation', 'Sports', 'Strategy', 'Trivia', 'Word',
]);

export const ASSET_ROLES = Object.freeze({
  appIcon: { multiple: false, label: 'App icon' },
  featureGraphic: { multiple: false, label: 'Feature graphic' },
  phoneScreenshots: { multiple: true, label: 'Phone screenshots' },
  tablet7Screenshots: { multiple: true, label: '7-inch tablet screenshots' },
  tablet10Screenshots: { multiple: true, label: '10-inch tablet screenshots' },
  aabFile: { multiple: false, label: 'Android App Bundle (.aab)' },
});

/** Manual sections the extension never answers; it only checks completion. */
export const MANUAL_SECTIONS = Object.freeze([
  { key: 'contentRatingStatus', label: 'Content rating' },
  { key: 'targetAudienceStatus', label: 'Target audience and content' },
  { key: 'dataSafetyStatus', label: 'Data safety' },
]);

/** Human labels for validation paths (UI only). */
export const FIELD_LABELS = Object.freeze({
  'metadata.appName': 'App name',
  'metadata.packageName': 'Package name',
  'metadata.defaultLanguage': 'Default language',
  'metadata.appOrGame': 'App or game',
  'metadata.pricing': 'Free or paid',
  'storeListing.title': 'Store listing app name',
  'storeListing.shortDescription': 'Short description',
  'storeListing.fullDescription': 'Full description',
  'storeListing.category': 'Category',
  'storeListing.supportEmail': 'Support email',
  'storeListing.supportWebsite': 'Website',
  'storeListing.supportPhone': 'Phone',
  'storeListing.privacyPolicyUrl': 'Privacy policy URL',
  'storeListing.promoVideoUrl': 'YouTube video URL',
  'assets.appIcon': 'App icon',
  'assets.featureGraphic': 'Feature graphic',
  'assets.phoneScreenshots': 'Screenshots',
  'assets.tablet7Screenshots': '7-inch tablet screenshots',
  'assets.tablet10Screenshots': '10-inch tablet screenshots',
  'appContent.containsAds': 'Contains ads',
  'appContent.appAccess': 'App access',
  'appContent.declarations.policiesAccepted': 'Developer Program Policies declaration',
  'appContent.declarations.exportLawsAccepted': 'US export laws declaration',
  'release.aabFile': 'App bundle',
  'release.versionCode': 'Version code',
  'release.releaseNotes': 'Release notes',
  'release.releaseTrack': 'Release track',
});

export function fieldLabel(path) {
  return FIELD_LABELS[path] || FIELD_LABELS[String(path).replace(/\[\d+\]$/, '')] || path;
}

export function generateId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Fallback is only for very old runtimes; extension pages have randomUUID.
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function createApplication(overrides = {}, now = new Date()) {
  const ts = now.toISOString();
  const base = {
    schemaVersion: SCHEMA_VERSION,
    id: generateId(),
    createdAt: ts,
    updatedAt: ts,
    metadata: {
      appName: '',
      packageName: '',
      defaultLanguage: 'en-US',
      appOrGame: 'app',
      pricing: 'free',
    },
    playConsole: {
      developerId: null,
      appId: null,
      linkedAt: null,
    },
    storeListing: {
      title: '',
      shortDescription: '',
      fullDescription: '',
      category: '',
      supportEmail: '',
      supportWebsite: '',
      supportPhone: '',
      privacyPolicyUrl: '',
      promoVideoUrl: '',
    },
    assets: {
      folderName: '',
      appIcon: null,
      featureGraphic: null,
      phoneScreenshots: [],
      tablet7Screenshots: [],
      tablet10Screenshots: [],
    },
    appContent: {
      containsAds: null,
      appAccess: null,
      contentRatingStatus: 'not_started',
      targetAudienceStatus: 'not_started',
      dataSafetyStatus: 'not_started',
      declarations: {
        policiesAccepted: null,
        exportLawsAccepted: null,
      },
    },
    release: {
      aabFile: null,
      releaseTrack: 'internal',
      releaseName: '',
      releaseNotes: '',
      versionName: '',
      versionCode: null,
    },
    workflow: {
      state: STATES.DRAFT,
      lastCompletedStage: null,
      lastVerifiedAt: null,
      errorCode: null,
      errorMessage: null,
    },
  };
  return deepMerge(base, overrides);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, src) {
  if (!isPlainObject(src)) return target;
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [k, v] of Object.entries(src)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Field validators (pure, exported for unit tests and the form)
// ---------------------------------------------------------------------------

const JAVA_KEYWORDS = new Set(('abstract assert boolean break byte case catch char class const continue default do double '
  + 'else enum extends final finally float for goto if implements import instanceof int interface long native new '
  + 'package private protected public return short static strictfp super switch synchronized this throw throws '
  + 'transient try void volatile while true false null').split(' '));

/** Returns an error message, or null when the package name is valid. */
export function validatePackageName(name) {
  if (typeof name !== 'string' || name.length === 0) return 'Package name is required.';
  if (name.length > LIMITS.packageName) return `Package name must be at most ${LIMITS.packageName} characters.`;
  const segments = name.split('.');
  if (segments.length < 2) return 'Package name needs at least two segments (for example com.company.app).';
  for (const seg of segments) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(seg)) {
      return `Segment "${seg}" must start with a letter and contain only letters, digits or underscores.`;
    }
    if (JAVA_KEYWORDS.has(seg)) return `Segment "${seg}" is a reserved Java keyword.`;
  }
  if (/^com\.example(\.|$)/i.test(name)) return 'Google Play rejects package names that start with com.example.';
  return null;
}

export function validateHttpUrl(value, { required = false, httpsOnly = false } = {}) {
  if (!value) return required ? 'URL is required.' : null;
  let u;
  try {
    u = new URL(value);
  } catch {
    return 'Not a valid URL.';
  }
  if (httpsOnly && u.protocol !== 'https:') return 'URL must use https://.';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'URL must start with http:// or https://.';
  if (!u.hostname.includes('.')) return 'URL must include a full domain name.';
  return null;
}

export function validateEmail(value, { required = false } = {}) {
  if (!value) return required ? 'Email is required.' : null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'Not a valid email address.';
  return null;
}

export function validatePhone(value) {
  if (!value) return null;
  if (!/^\+[0-9][0-9 ()-]{5,22}$/.test(value)) return 'Use international format starting with + and the country code.';
  return null;
}

/** Play requires a single public/unlisted YouTube video URL without extra parameters. */
export function validateYouTubeUrl(value) {
  if (!value) return null;
  let u;
  try {
    u = new URL(value);
  } catch {
    return 'Not a valid URL.';
  }
  const host = u.hostname.replace(/^www\.|^m\./, '');
  if (host !== 'youtube.com' && host !== 'youtu.be') return 'Promo video must be a YouTube URL.';
  if (u.searchParams.has('list')) return 'Use a single video URL, not a playlist.';
  if (u.searchParams.has('t') || u.hash) return 'Remove extra parameters such as timecodes.';
  if (host === 'youtube.com' && !(u.pathname === '/watch' && u.searchParams.get('v'))) {
    return 'Use a video URL like https://www.youtube.com/watch?v=VIDEO_ID.';
  }
  return null;
}

export function validateLanguageTag(value) {
  if (!value) return 'Default language is required.';
  if (!/^[a-z]{2,3}(-[A-Z]{2}|-[0-9]{3}|-[A-Z][a-z]{3})?$/.test(value)) {
    return 'Use a language code such as en-US, id or pt-BR.';
  }
  return null;
}

export function validateVersionCode(value) {
  if (value === null || value === undefined || value === '') return null;
  if (!Number.isInteger(value) || value < 1 || value > LIMITS.maxVersionCode) {
    return `Version code must be an integer between 1 and ${LIMITS.maxVersionCode}.`;
  }
  return null;
}

/** Counts characters the way users see them (code points, not UTF-16 units). */
export function charLength(s) {
  return [...String(s || '')].length;
}

function validateAssetRef(ref) {
  if (ref === null) return null;
  if (!isPlainObject(ref)) return 'Asset reference must be an object.';
  if (typeof ref.assetId !== 'string' || !ref.assetId) return 'Asset reference has no assetId.';
  if (typeof ref.fileName !== 'string') return 'Asset reference has no fileName.';
  if (!Number.isFinite(ref.size) || ref.size < 0) return 'Asset reference has an invalid size.';
  return null;
}

/**
 * Validates an application.
 * level 'structure' — types and formats only (used on save and import).
 * level 'ready'     — everything required before automation may start.
 * @returns {{ valid: boolean, errors: Array<{path:string,message:string}>, warnings: Array<{path:string,message:string}> }}
 */
export function validateApplication(app, { level = 'structure' } = {}) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });
  const ready = level === 'ready';

  if (!isPlainObject(app)) {
    return { valid: false, errors: [{ path: '', message: 'Application must be an object.' }], warnings };
  }
  if (app.schemaVersion !== SCHEMA_VERSION) err('schemaVersion', `Unsupported schema version ${app.schemaVersion}.`);
  if (typeof app.id !== 'string' || !app.id) err('id', 'Missing stable id.');
  for (const section of ['metadata', 'playConsole', 'storeListing', 'assets', 'appContent', 'release', 'workflow']) {
    if (!isPlainObject(app[section])) err(section, `Missing section "${section}".`);
  }
  if (errors.length) return { valid: false, errors, warnings };

  const { metadata: m, storeListing: sl, assets: a, appContent: ac, release: r, workflow: w } = app;

  // metadata
  if (ready && !m.appName) err('metadata.appName', 'App name is required.');
  if (charLength(m.appName) > LIMITS.appName) err('metadata.appName', `App name must be at most ${LIMITS.appName} characters.`);
  if (m.packageName || ready) {
    const pe = validatePackageName(m.packageName);
    if (pe) err('metadata.packageName', pe);
  }
  const le = validateLanguageTag(m.defaultLanguage);
  if (le) err('metadata.defaultLanguage', le);
  if (!APP_OR_GAME.includes(m.appOrGame)) err('metadata.appOrGame', 'Choose "app" or "game".');
  if (!PRICING.includes(m.pricing)) err('metadata.pricing', 'Choose "free" or "paid".');
  if (m.pricing === 'paid') warn('metadata.pricing', 'Paid apps need a payments profile; this cannot be checked by the extension.');

  // store listing
  const textFields = [['title', LIMITS.title], ['shortDescription', LIMITS.shortDescription], ['fullDescription', LIMITS.fullDescription]];
  for (const [key, max] of textFields) {
    const v = sl[key];
    if (typeof v !== 'string') { err(`storeListing.${key}`, 'Must be text.'); continue; }
    if (ready && !v.trim()) err(`storeListing.${key}`, 'Required.');
    if (charLength(v) > max) err(`storeListing.${key}`, `Must be at most ${max} characters (currently ${charLength(v)}).`);
  }
  if (sl.title && m.appName && sl.title !== m.appName) {
    warn('storeListing.title', 'Store listing title differs from the app name entered at creation.');
  }
  const cats = m.appOrGame === 'game' ? GAME_CATEGORIES : APP_CATEGORIES;
  if (sl.category && !cats.includes(sl.category)) err('storeListing.category', `"${sl.category}" is not a known ${m.appOrGame} category.`);
  if (ready && !sl.category) err('storeListing.category', 'Category is required.');
  const ee = validateEmail(sl.supportEmail, { required: ready });
  if (ee) err('storeListing.supportEmail', ee);
  const we = validateHttpUrl(sl.supportWebsite);
  if (we) err('storeListing.supportWebsite', we);
  const phe = validatePhone(sl.supportPhone);
  if (phe) err('storeListing.supportPhone', phe);
  const ppe = validateHttpUrl(sl.privacyPolicyUrl, { required: ready });
  if (ppe) err('storeListing.privacyPolicyUrl', ppe);
  if (sl.privacyPolicyUrl && sl.privacyPolicyUrl.startsWith('http://')) warn('storeListing.privacyPolicyUrl', 'An https:// privacy policy URL is strongly recommended.');
  const ye = validateYouTubeUrl(sl.promoVideoUrl);
  if (ye) err('storeListing.promoVideoUrl', ye);

  // assets
  for (const [role, def] of Object.entries(ASSET_ROLES)) {
    if (role === 'aabFile') continue;
    const v = a[role];
    if (def.multiple) {
      if (!Array.isArray(v)) { err(`assets.${role}`, 'Must be a list.'); continue; }
      if (v.length > LIMITS.maxScreenshotsPerType) err(`assets.${role}`, `At most ${LIMITS.maxScreenshotsPerType} screenshots per device type.`);
      v.forEach((ref, i) => { const e = validateAssetRef(ref); if (e || ref === null) err(`assets.${role}[${i}]`, e || 'Empty slot.'); });
      const ids = v.filter(Boolean).map((x) => x.assetId);
      if (new Set(ids).size !== ids.length) err(`assets.${role}`, 'The same file is listed twice.');
    } else {
      const e = validateAssetRef(v ?? null);
      if (e) err(`assets.${role}`, e);
    }
  }
  if (ready) {
    if (!a.appIcon) err('assets.appIcon', 'App icon is required.');
    if (!a.featureGraphic) err('assets.featureGraphic', 'Feature graphic is required.');
    const total = a.phoneScreenshots.length + a.tablet7Screenshots.length + a.tablet10Screenshots.length;
    if (total < LIMITS.minScreenshotsTotal) err('assets.phoneScreenshots', `At least ${LIMITS.minScreenshotsTotal} screenshots are required.`);
    for (const role of Object.keys(ASSET_ROLES)) {
      const v = role === 'aabFile' ? r.aabFile : a[role];
      for (const ref of [].concat(v || [])) {
        if (ref && ref.validation && ref.validation.errors && ref.validation.errors.length) {
          err(`assets.${role}`, `${ref.fileName}: ${ref.validation.errors[0]}`);
        }
      }
    }
  }

  // app content
  if (ac.containsAds !== null && typeof ac.containsAds !== 'boolean') err('appContent.containsAds', 'Must be yes, no or unanswered.');
  if (ac.appAccess !== null && !APP_ACCESS.includes(ac.appAccess)) err('appContent.appAccess', 'Invalid app access answer.');
  for (const s of MANUAL_SECTIONS) {
    if (!MANUAL_SECTION_STATUS.includes(ac[s.key])) err(`appContent.${s.key}`, 'Invalid status.');
  }
  if (!isPlainObject(ac.declarations)) err('appContent.declarations', 'Must be an object.');
  else {
    for (const [k, v] of Object.entries(ac.declarations)) {
      if (v !== null && typeof v !== 'boolean' && typeof v !== 'string') err(`appContent.declarations.${k}`, 'Answer must be yes/no, text or unanswered.');
    }
  }
  if (ready) {
    if (ac.containsAds === null) err('appContent.containsAds', 'Answer whether the app contains ads.');
    if (ac.appAccess === null) err('appContent.appAccess', 'Answer the app access question.');
    if (ac.declarations.policiesAccepted !== true) err('appContent.declarations.policiesAccepted', 'You must personally confirm the Developer Program Policies declaration for this app.');
    if (ac.declarations.exportLawsAccepted !== true) err('appContent.declarations.exportLawsAccepted', 'You must personally confirm the US export laws declaration for this app.');
  }

  // release
  if (!RELEASE_TRACKS.includes(r.releaseTrack)) err('release.releaseTrack', 'Invalid release track.');
  if (r.releaseTrack === 'production') warn('release.releaseTrack', 'New personal accounts must complete closed testing before production access.');
  if (charLength(r.releaseNotes) > LIMITS.releaseNotes) err('release.releaseNotes', `Release notes must be at most ${LIMITS.releaseNotes} characters.`);
  const vce = validateVersionCode(r.versionCode);
  if (vce) err('release.versionCode', vce);
  const ae = validateAssetRef(r.aabFile ?? null);
  if (ae) err('release.aabFile', ae);
  if (ready && !r.aabFile) err('release.aabFile', 'Select the .aab file.');
  if (r.aabFile && r.aabFile.bundle) {
    const b = r.aabFile.bundle;
    if (b.packageName && m.packageName && b.packageName !== m.packageName) {
      err('release.aabFile', `The bundle's package name (${b.packageName}) does not match this app (${m.packageName}).`);
    }
    if (b.versionCode && r.versionCode && b.versionCode !== r.versionCode) {
      err('release.versionCode', `The bundle's version code is ${b.versionCode}, not ${r.versionCode}.`);
    }
    if (ready && !b.packageName) warn('release.aabFile', 'The package name could not be read from the bundle; it will be verified in Play Console after upload.');
  }

  // workflow
  if (!Object.values(STATES).includes(w.state)) err('workflow.state', `Unknown workflow state ${w.state}.`);

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Migrates a stored/imported record to the current schema version.
 * Throws for records written by a newer version of the extension.
 */
export function migrateApplication(raw) {
  if (!isPlainObject(raw)) throw new Error('Application record must be an object.');
  const version = raw.schemaVersion ?? 0;
  if (version > SCHEMA_VERSION) {
    throw new Error(`Record schema version ${version} is newer than supported version ${SCHEMA_VERSION}.`);
  }
  let rec = raw;
  if (version === 0) {
    // Version 0: pre-release drafts without schemaVersion. Fill defaults
    // without inventing answers (declarations stay null).
    rec = createApplication({ ...raw, schemaVersion: 1 }, new Date(raw.createdAt || Date.now()));
    if (raw.id) rec.id = raw.id;
  }
  // Future: if (rec.schemaVersion === 1) rec = migrateV1toV2(rec);
  return rec;
}
