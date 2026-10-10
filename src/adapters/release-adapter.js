/**
 * Release stage. Prepares a release draft on the chosen testing track; it
 * never rolls out. Rolling out / sending for review is the SUBMISSION stage
 * and needs the user's explicit confirmation.
 *
 * Steps:
 *  1. open-release   (TRACK)        click "Create new release" once, or
 *                                   "Edit release" for a draft we created.
 *  2. upload-bundle  (RELEASE_EDIT) upload the AAB, wait for processing,
 *                                   verify the version code row appears.
 *  3. release-details(RELEASE_EDIT) release name / notes; Save.
 *
 * Labels are UNVERIFIED (docs/SELECTOR_MAP.md).
 */
import { defineStage, inspectFields, applyFields, verifyFields, saveChanges, blocking, assertNoBlocking, hasButton } from './base-adapter.js';
import { PAGE_TYPES } from '../content/page-detector.js';
import { getSection, getButton, clickElement, setFileInput, waitFor, collectValidationErrors, normalize, isVisible, pageHasText } from '../content/dom-utils.js';
import { PCAError, ERROR_CODES, toPCAError } from '../services/errors.js';

export const CREATE_RELEASE = /^Create new release$/i;
export const EDIT_RELEASE = /^Edit release$/i;
const BUNDLES_SECTION = /^App bundles$/i;

/** Play Console release notes format: <lang>…</lang>. */
export function formatReleaseNotes(lang, notes) {
  return notes ? `<${lang}>\n${notes}\n</${lang}>` : '';
}

export const RELEASE_DETAIL_FIELDS = [
  { key: 'releaseName', label: 'Release name', kind: 'text', value: (p) => (p.releaseName ? p.releaseName : undefined) },
  { key: 'releaseNotes', label: 'Release notes', kind: 'text', value: (p) => (p.releaseNotesFormatted ? p.releaseNotesFormatted : undefined) },
];

/** Bundle rows: elements in the App bundles section mentioning a version code. */
export function listedVersionCodes(section) {
  const codes = new Set();
  for (const el of section.querySelectorAll('[role=row],tr,[role=listitem],li')) {
    if (!isVisible(el)) continue;
    const t = normalize(el.textContent);
    const m = t.match(/\bversion code\b\D{0,5}(\d{1,10})/i) || t.match(/^(\d{1,10})\s*\(/);
    if (m) codes.add(Number(m[1]));
  }
  return [...codes];
}

function classifyUploadError(text) {
  if (/version code .*already (been )?used/i.test(text)) return ERROR_CODES.VERSION_CODE_CONFLICT;
  if (/package name/i.test(text)) return ERROR_CODES.PACKAGE_MISMATCH;
  return ERROR_CODES.UPLOAD_FAILED;
}

export const releaseStage = defineStage('RELEASE', [
  {
    id: 'open-release',
    page: PAGE_TYPES.TRACK,
    idempotent: false,
    onUncertain: 'reinspect',
    expectsNavigation: true,
    navigatesTo: PAGE_TYPES.RELEASE_EDIT,
    buildPayload: (app, ctx = {}) => ({
      track: app.release.releaseTrack,
      ownDraft: Boolean(ctx.progress && ctx.progress.guards['RELEASE:open-release']),
    }),
    inspect(root, p) {
      const r = { fields: [], blocking: [], notes: [] };
      const canCreate = hasButton(root, CREATE_RELEASE);
      const canEdit = hasButton(root, EDIT_RELEASE);
      if (canEdit && !p.ownDraft) {
        r.blocking.push(blocking(ERROR_CODES.EXISTING_CONTENT, 'This track already has a draft release that the extension did not create. Review or discard it in Play Console, then resume.'));
      } else if (canEdit) {
        r.notes.push('Opens the draft release created earlier by the extension.');
      } else if (canCreate) {
        r.notes.push(`Creates a new draft release on the ${p.track} track. Nothing is rolled out.`);
      } else {
        r.blocking.push(blocking(ERROR_CODES.ELEMENT_NOT_FOUND, 'Neither "Create new release" nor "Edit release" is available on this track page.'));
      }
      return r;
    },
    apply(root, p) {
      assertNoBlocking(this.inspect(root, p));
      if (hasButton(root, EDIT_RELEASE)) { clickElement(getButton(root, EDIT_RELEASE)); return { clicked: 'Edit release' }; }
      clickElement(getButton(root, CREATE_RELEASE));
      return { clicked: 'Create new release', createdDraft: true };
    },
    verify: () => ({ ok: true, mismatches: [] }),
  },
  {
    id: 'upload-bundle',
    page: PAGE_TYPES.RELEASE_EDIT,
    idempotent: false,
    onUncertain: 'reinspect',
    applyTimeoutMs: (p) => p.processingTimeoutMs + 60000,
    buildPayload: (app, ctx = {}) => ({
      assetId: app.release.aabFile && app.release.aabFile.assetId,
      fileName: app.release.aabFile && app.release.aabFile.fileName,
      versionCode: (app.release.aabFile && app.release.aabFile.bundle && app.release.aabFile.bundle.versionCode) || app.release.versionCode || null,
      packageName: app.metadata.packageName,
      processingTimeoutMs: (ctx.settings && ctx.settings.bundleProcessingTimeoutMs) || 600000,
    }),
    inspect(root, p) {
      const r = { fields: [], blocking: [], notes: ['Play Console validates the bundle after upload; only its processed result counts as success.'] };
      if (!p.assetId) { r.blocking.push(blocking(ERROR_CODES.ASSET_MISSING, 'No .aab file is mapped for this app.')); return r; }
      if (!p.versionCode) r.blocking.push(blocking(ERROR_CODES.VALIDATION_FAILED, 'The version code is unknown (not readable from the bundle and not entered). It is needed to verify the upload.'));
      try {
        const section = getSection(root, BUNDLES_SECTION);
        const codes = listedVersionCodes(section);
        const inputs = section.querySelectorAll('input[type=file]');
        if (inputs.length !== 1) r.blocking.push(blocking(inputs.length ? ERROR_CODES.AMBIGUOUS_ELEMENT : ERROR_CODES.ELEMENT_NOT_FOUND, 'Could not identify a single bundle upload control.'));
        const already = codes.includes(p.versionCode);
        r.fields.push({ key: 'aab', label: 'App bundles', kind: 'file', status: 'found', current: codes.length ? `version codes: ${codes.join(', ')}` : 'empty', planned: `${p.fileName} (version code ${p.versionCode})`, willChange: !already });
        if (codes.length && !already) r.blocking.push(blocking(ERROR_CODES.EXISTING_CONTENT, `This release already contains other bundles (${codes.join(', ')}). Remove them in Play Console or adjust the release first.`));
      } catch (e) {
        const err = toPCAError(e);
        r.blocking.push(blocking(err.code, err.message));
      }
      return r;
    },
    async apply(root, p, ctx) {
      assertNoBlocking(this.inspect(root, p));
      let section = getSection(root, BUNDLES_SECTION);
      if (listedVersionCodes(section).includes(p.versionCode)) return { uploaded: false, alreadyPresent: true };
      const file = await ctx.getAsset(p.assetId);
      setFileInput(section.querySelector('input[type=file]'), [file]);
      await waitFor(() => {
        section = getSection(root, BUNDLES_SECTION);
        const errs = collectValidationErrors(section);
        if (errs.length) {
          const text = errs.map((e) => e.message).join('; ');
          throw new PCAError(classifyUploadError(text), `Play Console rejected the bundle: ${text}`);
        }
        return listedVersionCodes(section).includes(p.versionCode);
      }, { timeout: p.processingTimeoutMs, interval: 1000, description: 'bundle processing', rethrow: true })
        .catch((e) => {
          const err = toPCAError(e);
          if (err.code === ERROR_CODES.WAIT_TIMEOUT) throw new PCAError(ERROR_CODES.PROCESSING_TIMEOUT, 'The bundle did not finish processing in time. Check the release page; the extension will re-check before uploading again.');
          throw err;
        });
      return { uploaded: true };
    },
    verify(root, p) {
      const mismatches = [];
      try {
        const section = getSection(root, BUNDLES_SECTION);
        if (!listedVersionCodes(section).includes(p.versionCode)) mismatches.push({ field: 'aab', message: `No bundle with version code ${p.versionCode} is listed.` });
        for (const e of collectValidationErrors(section)) mismatches.push({ field: 'aab', message: e.message });
      } catch (e) {
        mismatches.push({ field: 'aab', message: toPCAError(e).message });
      }
      // After the first upload the package name becomes visible; if the page
      // shows a different package name, that is a hard identity failure.
      if (p.packageName && pageHasText(root, /package name/i) && !pageHasText(root, p.packageName)) {
        mismatches.push({ field: 'packageName', message: `The page does not show the expected package name ${p.packageName}.` });
      }
      return { ok: mismatches.length === 0, mismatches };
    },
  },
  {
    id: 'release-details',
    page: PAGE_TYPES.RELEASE_EDIT,
    verifyAfterReload: true,
    buildPayload: (app) => ({
      releaseName: app.release.releaseName,
      releaseNotesFormatted: formatReleaseNotes(app.metadata.defaultLanguage, app.release.releaseNotes),
    }),
    inspect: (root, p) => inspectFields(root, RELEASE_DETAIL_FIELDS, p),
    async apply(root, p, ctx = {}) {
      assertNoBlocking(this.inspect(root, p));
      const applied = await applyFields(root, RELEASE_DETAIL_FIELDS, p);
      await saveChanges(root, { timeout: ctx.stepTimeoutMs });
      return { applied };
    },
    verify(root, p) {
      const mismatches = verifyFields(root, RELEASE_DETAIL_FIELDS, p);
      return { ok: mismatches.length === 0, mismatches };
    },
  },
]);
