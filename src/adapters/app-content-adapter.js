/**
 * App content stage.
 *
 * Applies ONLY explicit per-app answers the user entered:
 *  1. privacy-policy (APP_CONTENT_PRIVACY_POLICY) privacy policy URL.
 *  2. ads            (APP_CONTENT_ADS)            contains ads yes/no.
 *  3. app-access     (APP_CONTENT_APP_ACCESS)     "all functionality available"
 *                    only; restricted access needs instructions and test
 *                    credentials, which the user enters manually.
 *  4. sections-check (APP_CONTENT_OVERVIEW)       read-only: every remaining
 *                    to-do (content rating, target audience, data safety,
 *                    ...) must be completed by the user in Play Console.
 *
 * The extension never answers questionnaires and stops on any question it
 * does not recognise. All labels are UNVERIFIED (docs/SELECTOR_MAP.md).
 */
import { defineStage, inspectFields, applyFields, verifyFields, saveChanges, findUnknownControls, blocking, assertNoBlocking } from './base-adapter.js';
import { PAGE_TYPES } from '../content/page-detector.js';
import { getSection, normalize, isVisible, getByLabel, isChecked } from '../content/dom-utils.js';
import { ERROR_CODES, toPCAError } from '../services/errors.js';

export const ADS_YES = /^Yes, my app contains ads$/i;
export const ADS_NO = /^No, my app does not contain ads$/i;
export const ACCESS_ALL = /^All functionality (in my app )?is available without (any )?(special )?access( restrictions)?$/i;
export const ACCESS_RESTRICTED = /^All or some functionality (in my app )?is restricted$/i;

const PRIVACY_FIELDS = [{ key: 'privacyPolicyUrl', label: 'Privacy policy URL', kind: 'text', value: (p) => p.privacyPolicyUrl }];
const ADS_FIELDS = [{ key: 'containsAds', label: 'Ads', kind: 'radio', value: (p) => (p.containsAds === true ? ADS_YES : p.containsAds === false ? ADS_NO : undefined) }];
const ACCESS_FIELDS = [{ key: 'appAccess', label: 'App access', kind: 'radio', value: (p) => (p.appAccess === 'all_available' ? ACCESS_ALL : undefined) }];

function simpleStep({ id, page, fields, known, payload, unanswered }) {
  return {
    id,
    page,
    verifyAfterReload: true,
    buildPayload: payload,
    inspect(root, p) {
      const r = inspectFields(root, fields, p);
      if (unanswered && unanswered(p)) r.blocking.push(blocking(ERROR_CODES.DECLARATION_UNANSWERED, unanswered(p)));
      if (known) {
        for (const u of findUnknownControls(root, known)) r.blocking.push(blocking(ERROR_CODES.UNKNOWN_QUESTION, `Unrecognised question: ${u}`));
      }
      return r;
    },
    async apply(root, p, ctx = {}) {
      assertNoBlocking(this.inspect(root, p));
      const applied = await applyFields(root, fields, p);
      if (applied.length) await saveChanges(root, { timeout: ctx.stepTimeoutMs });
      return { applied };
    },
    verify(root, p) {
      const mismatches = verifyFields(root, fields, p);
      return { ok: mismatches.length === 0, mismatches };
    },
  };
}

/**
 * Reads the App content overview. Expects a section titled "To do" listing
 * outstanding declarations. Missing structure -> blocking (never assume done).
 */
export function readOutstandingSections(root) {
  let todo;
  try {
    todo = getSection(root, /^To do$/i);
  } catch (e) {
    const err = toPCAError(e);
    // A page with no "To do" section but an explicit "Actioned" section and
    // no to-do list means everything is done — only if that section exists.
    try {
      getSection(root, /^Actioned$/i);
      return { outstanding: [], structureFound: true };
    } catch {
      return { outstanding: null, structureFound: false, error: err.message };
    }
  }
  const items = [...todo.querySelectorAll('[role=listitem],li,h3,[role=heading]')]
    .filter(isVisible)
    .map((el) => normalize((el.querySelector('h3,[role=heading]') || el).textContent))
    .filter(Boolean);
  return { outstanding: [...new Set(items)], structureFound: true };
}

export const appContentStage = defineStage('APP_CONTENT', [
  simpleStep({
    id: 'privacy-policy',
    page: PAGE_TYPES.APP_CONTENT_PRIVACY_POLICY,
    fields: PRIVACY_FIELDS,
    payload: (app) => ({ privacyPolicyUrl: app.storeListing.privacyPolicyUrl }),
    unanswered: (p) => (!p.privacyPolicyUrl ? 'No privacy policy URL is set for this app.' : null),
  }),
  simpleStep({
    id: 'ads',
    page: PAGE_TYPES.APP_CONTENT_ADS,
    fields: ADS_FIELDS,
    known: [ADS_YES, ADS_NO],
    payload: (app) => ({ containsAds: app.appContent.containsAds }),
    unanswered: (p) => (p.containsAds === null || p.containsAds === undefined ? 'You have not answered whether this app contains ads.' : null),
  }),
  {
    id: 'app-access',
    page: PAGE_TYPES.APP_CONTENT_APP_ACCESS,
    verifyAfterReload: true,
    buildPayload: (app) => ({ appAccess: app.appContent.appAccess }),
    inspect(root, p) {
      if (p.appAccess === null || p.appAccess === undefined) {
        return { fields: [], blocking: [blocking(ERROR_CODES.DECLARATION_UNANSWERED, 'You have not answered the app access question for this app.')] };
      }
      if (p.appAccess === 'restricted') {
        // Manual: the user must enter instructions/credentials themselves.
        const r = { fields: [], blocking: [], notes: ['Restricted access: enter the access instructions in Play Console yourself. The extension only checks that "restricted" is selected and saved.'] };
        try {
          const el = getByLabel(root, ACCESS_RESTRICTED, 'radio');
          r.fields.push({ key: 'appAccess', label: ACCESS_RESTRICTED.source, kind: 'radio', status: 'found', current: isChecked(el), planned: true, willChange: false });
          if (!isChecked(el)) r.blocking.push(blocking(ERROR_CODES.MANUAL_SECTION_INCOMPLETE, 'Select "restricted" and add access instructions in Play Console, save, then resume.'));
        } catch (e) {
          const err = toPCAError(e);
          r.blocking.push(blocking(err.code, err.message));
        }
        return r;
      }
      const r = inspectFields(root, ACCESS_FIELDS, p);
      for (const u of findUnknownControls(root, [ACCESS_ALL, ACCESS_RESTRICTED])) r.blocking.push(blocking(ERROR_CODES.UNKNOWN_QUESTION, `Unrecognised question: ${u}`));
      return r;
    },
    async apply(root, p, ctx = {}) {
      assertNoBlocking(this.inspect(root, p));
      if (p.appAccess === 'restricted') return { applied: [] };
      const applied = await applyFields(root, ACCESS_FIELDS, p);
      if (applied.length) await saveChanges(root, { timeout: ctx.stepTimeoutMs });
      return { applied };
    },
    verify(root, p) {
      if (p.appAccess === 'restricted') {
        const r = this.inspect(root, p);
        return { ok: r.blocking.length === 0, mismatches: r.blocking.map((b) => ({ field: 'appAccess', message: b.message })) };
      }
      const mismatches = verifyFields(root, ACCESS_FIELDS, p);
      return { ok: mismatches.length === 0, mismatches };
    },
  },
  {
    id: 'sections-check',
    page: PAGE_TYPES.APP_CONTENT_OVERVIEW,
    readOnly: true,
    buildPayload: () => ({}),
    inspect(root) {
      const res = readOutstandingSections(root);
      const r = { fields: [], blocking: [], notes: ['Read-only check. Content rating, target audience, data safety and other questionnaires are completed by you in Play Console.'] };
      if (!res.structureFound) r.blocking.push(blocking(ERROR_CODES.ELEMENT_NOT_FOUND, `Could not read the App content task list (${res.error}).`));
      else if (res.outstanding.length) {
        r.blocking.push(blocking(ERROR_CODES.MANUAL_SECTION_INCOMPLETE, `Complete these App content sections in Play Console, then resume: ${res.outstanding.join(', ')}.`, { outstanding: res.outstanding }));
      }
      r.fields.push({ key: 'outstanding', label: 'Outstanding sections', kind: 'read', status: res.structureFound ? 'found' : 'missing', current: res.outstanding ? res.outstanding.join(', ') || 'none' : null, willChange: false });
      return r;
    },
    apply: () => ({ applied: [] }),
    verify(root) {
      const r = this.inspect(root);
      return { ok: r.blocking.length === 0, mismatches: r.blocking.map((b) => ({ field: 'sections', message: b.message })) };
    },
  },
]);
