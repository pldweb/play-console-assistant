/**
 * Create app stage (Play Console: Home > Create app).
 *
 * Fields per Play Console Help: app name, default language, app or game,
 * free or paid, and the Developer Program Policies / US export laws
 * declarations. The package name is NOT entered here; it is fixed by the
 * first uploaded bundle.
 *
 * Steps:
 *  1. precheck     (APP_LIST)   look for an existing app with the same name,
 *                               then open the create form.
 *  2. fill-form    (CREATE_APP) fill fields; stop on unknown questions.
 *  3. submit-create(CREATE_APP) click "Create app" once. Not idempotent;
 *                               the engine verifies by detecting the new
 *                               app's dashboard and never re-clicks.
 *
 * All labels are UNVERIFIED (docs/SELECTOR_MAP.md).
 */
import { defineStage, inspectFields, applyFields, verifyFields, findUnknownControls, blocking, assertNoBlocking, hasButton } from './base-adapter.js';
import { PAGE_TYPES } from '../content/page-detector.js';
import { getButton, clickElement, collectValidationErrors, normalize } from '../content/dom-utils.js';
import { ERROR_CODES } from '../services/errors.js';

export const CREATE_APP_BUTTON = /^Create app$/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches option text like "English (United States) – en-US". */
export function languageOptionMatcher(code) {
  return new RegExp(`(^|[\\s–—(-])${escapeRe(code)}\\)?$`, 'i');
}

export const CREATE_FORM_FIELDS = [
  { key: 'appName', label: 'App name', kind: 'text', value: (p) => p.appName },
  { key: 'defaultLanguage', label: 'Default language', kind: 'select', value: (p) => languageOptionMatcher(p.defaultLanguage) },
  { key: 'appOrGame', label: 'App or game', kind: 'radio', value: (p) => (p.appOrGame === 'game' ? 'Game' : 'App') },
  { key: 'pricing', label: 'Free or paid', kind: 'radio', value: (p) => (p.pricing === 'paid' ? 'Paid' : 'Free') },
  { key: 'policiesAccepted', label: /Developer Program Policies/i, kind: 'checkbox', value: (p) => (p.policiesAccepted === true ? true : undefined) },
  { key: 'exportLawsAccepted', label: /US export laws/i, kind: 'checkbox', value: (p) => (p.exportLawsAccepted === true ? true : undefined) },
];
const KNOWN_CONTROLS = ['App', 'Game', 'Free', 'Paid', /Developer Program Policies/i, /US export laws/i];

function createPayload(app, ctx = {}) {
  return {
    appName: app.metadata.appName,
    defaultLanguage: app.metadata.defaultLanguage,
    appOrGame: app.metadata.appOrGame,
    pricing: app.metadata.pricing,
    policiesAccepted: app.appContent.declarations.policiesAccepted,
    exportLawsAccepted: app.appContent.declarations.exportLawsAccepted,
    allowDuplicateName: Boolean(ctx.progress && ctx.progress.allowDuplicateName),
  };
}

/** Visible app names in the app list (rows of a table/grid or list items). */
export function listedAppNames(root) {
  const rows = root.querySelectorAll('[role=row],tr,[role=listitem]');
  const names = [];
  for (const r of rows) {
    const cell = r.querySelector('[role=rowheader],th,[role=cell],td') || r;
    const t = normalize(cell.textContent);
    if (t) names.push(t);
  }
  return names;
}

export const createAppStage = defineStage('CREATE_APP', [
  {
    id: 'precheck',
    page: PAGE_TYPES.APP_LIST,
    expectsNavigation: true,
    approval: false, // only opens the form
    navigatesTo: PAGE_TYPES.CREATE_APP,
    buildPayload: createPayload,
    inspect(root, p) {
      const report = { fields: [], blocking: [], notes: [] };
      const lower = p.appName.toLowerCase();
      const dupes = listedAppNames(root).filter((n) => n.toLowerCase() === lower || n.toLowerCase().startsWith(`${lower} `));
      if (dupes.length && !p.allowDuplicateName) {
        report.blocking.push(blocking(ERROR_CODES.POSSIBLE_DUPLICATE_APP,
          `An app named "${p.appName}" already appears in this account. Link it to this record or confirm that a second app should be created.`, { matches: dupes }));
      }
      if (!hasButton(root, CREATE_APP_BUTTON)) report.blocking.push(blocking(ERROR_CODES.ELEMENT_NOT_FOUND, 'The "Create app" button is not visible on this page.'));
      report.notes.push('Opens the Create app form. Nothing is created in this step.');
      return report;
    },
    apply(root, p) {
      assertNoBlocking(this.inspect(root, p));
      clickElement(getButton(root, CREATE_APP_BUTTON));
      return { clicked: 'Create app' };
    },
    verify: () => ({ ok: true, mismatches: [] }), // verified by navigation to CREATE_APP
  },
  {
    id: 'fill-form',
    page: PAGE_TYPES.CREATE_APP,
    buildPayload: createPayload,
    inspect(root, p) {
      const r = inspectFields(root, CREATE_FORM_FIELDS, p);
      const unknown = findUnknownControls(root, KNOWN_CONTROLS);
      for (const u of unknown) r.blocking.push(blocking(ERROR_CODES.UNKNOWN_QUESTION, `Unrecognised question on the Create app form: ${u}`));
      if (p.policiesAccepted !== true || p.exportLawsAccepted !== true) {
        r.blocking.push(blocking(ERROR_CODES.DECLARATION_UNANSWERED, 'Confirm both creation declarations for this app in its form first.'));
      }
      return r;
    },
    async apply(root, p) {
      assertNoBlocking(this.inspect(root, p));
      return { applied: await applyFields(root, CREATE_FORM_FIELDS, p) };
    },
    verify(root, p) {
      const mismatches = verifyFields(root, CREATE_FORM_FIELDS, p);
      for (const e of collectValidationErrors(root)) mismatches.push({ field: e.field, message: e.message });
      return { ok: mismatches.length === 0, mismatches };
    },
  },
  {
    id: 'submit-create',
    page: PAGE_TYPES.CREATE_APP,
    idempotent: false,
    onUncertain: 'verify',
    expectsNavigation: true,
    navigatesTo: PAGE_TYPES.APP_DASHBOARD,
    buildPayload: createPayload,
    inspect(root, p) {
      const r = { fields: [], blocking: [], notes: ['Clicks "Create app" once. This creates the app in your Play Console account.'] };
      const mismatches = verifyFields(root, CREATE_FORM_FIELDS, p);
      for (const m of mismatches) r.blocking.push(blocking(ERROR_CODES.VERIFY_FAILED, m.message, { field: m.field }));
      if (!hasButton(root, CREATE_APP_BUTTON)) r.blocking.push(blocking(ERROR_CODES.ELEMENT_NOT_FOUND, 'The "Create app" submit button is not visible.'));
      return r;
    },
    apply(root, p) {
      assertNoBlocking(this.inspect(root, p));
      clickElement(getButton(root, CREATE_APP_BUTTON));
      return { clicked: 'Create app' };
    },
    verify: () => ({ ok: true, mismatches: [] }), // the engine verifies via the new dashboard page
  },
]);
