/**
 * Store listing stage.
 *
 * Steps:
 *  1. listing-text     (STORE_LISTING)  app name, short and full description,
 *                                       optional YouTube video URL; Save.
 *  2. listing-graphics (STORE_LISTING)  icon, feature graphic, screenshots;
 *                                       Save. Stops if a section already has
 *                                       images (never overwrites silently).
 *  3. store-settings   (STORE_SETTINGS) category and contact details; Save.
 *
 * Text steps are verified after a page reload so that only saved values
 * count. All labels are UNVERIFIED (docs/SELECTOR_MAP.md).
 */
import { defineStage, inspectFields, applyFields, verifyFields, saveChanges, blocking, assertNoBlocking } from './base-adapter.js';
import { PAGE_TYPES } from '../content/page-detector.js';
import { getSection, isVisible, setFileInput, waitFor, collectValidationErrors } from '../content/dom-utils.js';
import { PCAError, ERROR_CODES, toPCAError } from '../services/errors.js';

export const LISTING_TEXT_FIELDS = [
  { key: 'title', label: 'App name', kind: 'text', value: (p) => p.title },
  { key: 'shortDescription', label: 'Short description', kind: 'text', value: (p) => p.shortDescription },
  { key: 'fullDescription', label: 'Full description', kind: 'text', value: (p) => p.fullDescription },
  { key: 'promoVideoUrl', label: /^Video( URL)?$/i, kind: 'text', value: (p) => (p.promoVideoUrl ? p.promoVideoUrl : undefined) },
];

export const STORE_SETTINGS_FIELDS = [
  { key: 'category', label: 'Category', kind: 'select', value: (p) => p.category || undefined },
  { key: 'supportEmail', label: 'Email address', kind: 'text', value: (p) => p.supportEmail },
  { key: 'supportPhone', label: 'Phone number', kind: 'text', value: (p) => (p.supportPhone ? p.supportPhone : undefined) },
  { key: 'supportWebsite', label: 'Website', kind: 'text', value: (p) => (p.supportWebsite ? p.supportWebsite : undefined) },
];

/** Graphic sections in upload order. */
export const GRAPHIC_SECTIONS = [
  { role: 'appIcon', title: 'App icon' },
  { role: 'featureGraphic', title: 'Feature graphic' },
  { role: 'phoneScreenshots', title: 'Phone screenshots' },
  { role: 'tablet7Screenshots', title: '7-inch tablet screenshots' },
  { role: 'tablet10Screenshots', title: '10-inch tablet screenshots' },
];

function previewCount(section) {
  return [...section.querySelectorAll('img,[role=img]')].filter(isVisible).length;
}

function uploadInput(section) {
  const inputs = [...section.querySelectorAll('input[type=file]')].filter((i) => !i.disabled);
  if (inputs.length === 0) throw new PCAError(ERROR_CODES.ELEMENT_NOT_FOUND, 'No upload control found in this section.');
  if (inputs.length > 1) throw new PCAError(ERROR_CODES.AMBIGUOUS_ELEMENT, 'More than one upload control in this section.');
  return inputs[0];
}

function graphicsPayload(app) {
  const a = app.assets;
  const ids = (list) => list.map((r) => ({ assetId: r.assetId, fileName: r.fileName }));
  return {
    graphics: {
      appIcon: a.appIcon ? ids([a.appIcon]) : [],
      featureGraphic: a.featureGraphic ? ids([a.featureGraphic]) : [],
      phoneScreenshots: ids(a.phoneScreenshots),
      tablet7Screenshots: ids(a.tablet7Screenshots),
      tablet10Screenshots: ids(a.tablet10Screenshots),
    },
  };
}

function inspectGraphics(root, p) {
  const report = { fields: [], blocking: [], notes: [] };
  for (const { role, title } of GRAPHIC_SECTIONS) {
    const files = p.graphics[role] || [];
    if (!files.length) { report.fields.push({ key: role, label: title, kind: 'file', status: 'skipped' }); continue; }
    try {
      const section = getSection(root, title);
      const existing = previewCount(section);
      uploadInput(section);
      const planned = files.map((f, i) => `${i + 1}. ${f.fileName}`).join(', ');
      if (existing === files.length && p.alreadyUploaded && p.alreadyUploaded.includes(role)) {
        report.fields.push({ key: role, label: title, kind: 'file', status: 'found', current: `${existing} image(s)`, planned, willChange: false });
      } else if (existing > 0) {
        report.fields.push({ key: role, label: title, kind: 'file', status: 'found', current: `${existing} image(s)`, planned, willChange: true });
        report.blocking.push(blocking(ERROR_CODES.EXISTING_CONTENT,
          `"${title}" already has ${existing} image(s). Remove them in Play Console first if they should be replaced; the extension does not overwrite existing graphics.`, { field: role }));
      } else {
        report.fields.push({ key: role, label: title, kind: 'file', status: 'found', current: 'empty', planned, willChange: true });
      }
    } catch (e) {
      const err = toPCAError(e);
      report.fields.push({ key: role, label: title, kind: 'file', status: err.code === ERROR_CODES.AMBIGUOUS_ELEMENT ? 'ambiguous' : 'missing' });
      report.blocking.push(blocking(err.code, `${title}: ${err.message}`, { field: role }));
    }
  }
  report.notes.push('Screenshots are uploaded one at a time in the order shown, and each upload is confirmed before the next.');
  return report;
}

export const storeListingStage = defineStage('STORE_LISTING', [
  {
    id: 'listing-text',
    page: PAGE_TYPES.STORE_LISTING,
    verifyAfterReload: true,
    buildPayload: (app) => ({
      title: app.storeListing.title,
      shortDescription: app.storeListing.shortDescription,
      fullDescription: app.storeListing.fullDescription,
      promoVideoUrl: app.storeListing.promoVideoUrl,
    }),
    inspect: (root, p) => inspectFields(root, LISTING_TEXT_FIELDS, p),
    async apply(root, p, ctx = {}) {
      assertNoBlocking(this.inspect(root, p));
      const applied = await applyFields(root, LISTING_TEXT_FIELDS, p);
      if (applied.length) await saveChanges(root, { timeout: ctx.stepTimeoutMs });
      return { applied };
    },
    verify(root, p) {
      const mismatches = verifyFields(root, LISTING_TEXT_FIELDS, p);
      return { ok: mismatches.length === 0, mismatches };
    },
  },
  {
    id: 'listing-graphics',
    page: PAGE_TYPES.STORE_LISTING,
    // Uploading the same file twice would add a duplicate image.
    idempotent: false,
    onUncertain: 'reinspect',
    verifyAfterReload: true,
    // Each file may take up to 2x the step timeout to show its preview.
    applyTimeoutMs: (p, s) => (Object.values(p.graphics).reduce((n, l) => n + l.length, 0) * 2 + 2) * s.stepTimeoutMs,
    buildPayload: (app, ctx = {}) => ({ ...graphicsPayload(app), alreadyUploaded: (ctx.progress && ctx.progress.guards['STORE_LISTING:uploaded']) || [] }),
    inspect: inspectGraphics,
    async apply(root, p, ctx) {
      assertNoBlocking(this.inspect(root, p));
      const uploaded = [];
      for (const { role, title } of GRAPHIC_SECTIONS) {
        const files = p.graphics[role] || [];
        if (!files.length || (p.alreadyUploaded || []).includes(role)) continue;
        for (let i = 0; i < files.length; i++) {
          const section = getSection(root, title);
          const before = previewCount(section);
          const file = await ctx.getAsset(files[i].assetId);
          setFileInput(uploadInput(section), [file]);
          await waitFor(() => {
            const s = getSection(root, title);
            const errs = collectValidationErrors(s);
            if (errs.length) throw new PCAError(ERROR_CODES.UPLOAD_FAILED, `${title}: ${errs.map((e) => e.message).join('; ')}`);
            return previewCount(s) === before + 1;
          }, { timeout: ctx.uploadTimeoutMs || 60000, description: `${title} upload ${i + 1}`, rethrow: true });
        }
        uploaded.push(role);
        if (ctx.reportProgress) await ctx.reportProgress({ uploaded: role });
      }
      await saveChanges(root, { timeout: ctx.stepTimeoutMs });
      return { uploaded };
    },
    verify(root, p) {
      const mismatches = [];
      for (const { role, title } of GRAPHIC_SECTIONS) {
        const want = (p.graphics[role] || []).length;
        if (!want) continue;
        try {
          const have = previewCount(getSection(root, title));
          if (have !== want) mismatches.push({ field: role, message: `${title}: expected ${want} image(s), page shows ${have}.` });
        } catch (e) {
          mismatches.push({ field: role, message: toPCAError(e).message });
        }
      }
      return { ok: mismatches.length === 0, mismatches };
    },
  },
  {
    id: 'store-settings',
    page: PAGE_TYPES.STORE_SETTINGS,
    verifyAfterReload: true,
    buildPayload: (app) => ({
      category: app.storeListing.category,
      supportEmail: app.storeListing.supportEmail,
      supportPhone: app.storeListing.supportPhone,
      supportWebsite: app.storeListing.supportWebsite,
    }),
    inspect: (root, p) => inspectFields(root, STORE_SETTINGS_FIELDS, p),
    async apply(root, p, ctx = {}) {
      assertNoBlocking(this.inspect(root, p));
      const applied = await applyFields(root, STORE_SETTINGS_FIELDS, p);
      if (applied.length) await saveChanges(root, { timeout: ctx.stepTimeoutMs });
      return { applied };
    },
    verify(root, p) {
      const mismatches = verifyFields(root, STORE_SETTINGS_FIELDS, p);
      return { ok: mismatches.length === 0, mismatches };
    },
  },
]);
