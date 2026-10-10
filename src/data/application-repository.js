/**
 * CRUD for application records in chrome.storage.local.
 *
 * Each record lives under its own key (`app:<id>`), so writes to one
 * application never rewrite another application's data.
 */
import { createApplication, migrateApplication, validateApplication, SCHEMA_VERSION } from './schema.js';
import { STATES, EDITABLE_STATES } from '../automation/workflow-states.js';
import { PCAError, ERROR_CODES } from '../services/errors.js';

export const APP_KEY_PREFIX = 'app:';
export const appKey = (id) => `${APP_KEY_PREFIX}${id}`;

function defaultStorage() {
  return globalThis.chrome.storage.local;
}

export function createApplicationRepository({ storage = defaultStorage(), clock = () => new Date() } = {}) {
  async function get(id) {
    const key = appKey(id);
    const res = await storage.get(key);
    return res[key] ? migrateApplication(res[key]) : null;
  }

  async function list() {
    const all = await storage.get(null);
    return Object.entries(all)
      .filter(([k]) => k.startsWith(APP_KEY_PREFIX))
      .map(([, v]) => migrateApplication(v))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  async function save(app) {
    const result = validateApplication(app, { level: 'structure' });
    if (!result.valid) {
      throw new PCAError(ERROR_CODES.VALIDATION_FAILED, 'Application data is invalid.', { errors: result.errors });
    }
    const record = { ...app, schemaVersion: SCHEMA_VERSION, updatedAt: clock().toISOString() };
    await storage.set({ [appKey(app.id)]: record });
    return record;
  }

  async function create(overrides = {}) {
    const app = createApplication(overrides, clock());
    return save(app);
  }

  /**
   * Read-modify-write helper. The mutator receives a fresh copy so that
   * concurrent writers (dashboard vs. engine) do not clobber each other's
   * sections.
   */
  async function update(id, mutator) {
    const current = await get(id);
    if (!current) throw new PCAError(ERROR_CODES.VALIDATION_FAILED, `Application ${id} not found.`);
    const next = mutator(structuredClone(current)) || current;
    if (next.id !== id) throw new PCAError(ERROR_CODES.VALIDATION_FAILED, 'Application id cannot change.');
    return save(next);
  }

  /**
   * Saves user-edited fields while preserving the engine-owned sections
   * (workflow, playConsole link) from the stored record.
   */
  async function saveUserEdits(edited) {
    const current = await get(edited.id);
    if (current && !EDITABLE_STATES.includes(current.workflow.state)) {
      throw new PCAError(ERROR_CODES.LOCKED, 'Pause the automation before editing this application.');
    }
    const merged = {
      ...edited,
      createdAt: current ? current.createdAt : edited.createdAt,
      workflow: current ? current.workflow : edited.workflow,
      playConsole: current ? current.playConsole : edited.playConsole,
    };
    // Editing data after validation requires re-validation before start.
    if (merged.workflow.state === STATES.READY_TO_START) {
      merged.workflow = { ...merged.workflow, state: STATES.DRAFT };
    }
    return save(merged);
  }

  async function remove(id) {
    await storage.remove(appKey(id));
  }

  /**
   * Duplicate as a new draft. Identity, Play Console link, binary assets,
   * the bundle and progress are never copied. Declarations are copied only
   * when the user explicitly confirmed they apply to the new app.
   */
  async function duplicate(id, { copyDeclarations = false } = {}) {
    const src = await get(id);
    if (!src) throw new PCAError(ERROR_CODES.VALIDATION_FAILED, `Application ${id} not found.`);
    const copy = createApplication({
      metadata: { ...src.metadata, appName: truncate(`Copy of ${src.metadata.appName}`, 30), packageName: '' },
      storeListing: { ...src.storeListing },
      release: { releaseTrack: src.release.releaseTrack, releaseNotes: src.release.releaseNotes },
    }, clock());
    if (copyDeclarations) {
      copy.appContent = {
        ...structuredClone(src.appContent),
        // Manual questionnaires are per app in Play Console; never carry over.
        contentRatingStatus: 'not_started',
        targetAudienceStatus: 'not_started',
        dataSafetyStatus: 'not_started',
      };
    }
    return save(copy);
  }

  return { get, list, save, create, update, saveUserEdits, remove, duplicate };
}

function truncate(s, n) {
  const chars = [...s];
  return chars.length > n ? chars.slice(0, n).join('') : s;
}
