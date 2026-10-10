/**
 * Local backup export/import of structured application data.
 *
 * Exports contain metadata only (no file bytes, no logs). Imported records
 * are migrated, validated, reset to DRAFT and stripped of asset references,
 * because the binary files are not part of the backup.
 */
import { migrateApplication, validateApplication, SCHEMA_VERSION } from '../data/schema.js';
import { STATES } from '../automation/workflow-states.js';

export const EXPORT_FORMAT = 'play-console-assistant-export';
export const EXPORT_VERSION = 1;

export function buildExport(apps, now = new Date()) {
  return {
    format: EXPORT_FORMAT,
    exportVersion: EXPORT_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now.toISOString(),
    applications: apps.map((a) => structuredClone(a)),
  };
}

function stripForImport(app) {
  const a = structuredClone(app);
  a.assets = {
    ...a.assets,
    appIcon: null,
    featureGraphic: null,
    phoneScreenshots: [],
    tablet7Screenshots: [],
    tablet10Screenshots: [],
  };
  a.release = { ...a.release, aabFile: null };
  a.workflow = { state: STATES.DRAFT, lastCompletedStage: null, lastVerifiedAt: null, errorCode: null, errorMessage: null };
  return a;
}

/**
 * Parses and validates an export file and plans the import against the
 * existing records. Nothing is written here; the caller shows the plan and
 * asks for confirmation before overwriting.
 *
 * @returns {{ ok:boolean, error?:string, toAdd:object[], toOverwrite:object[], invalid:Array<{index:number,id:any,errors:any[]}>, packageConflicts:Array<{packageName:string, ids:string[]}> }}
 */
export function planImport(jsonText, existingApps) {
  const empty = { toAdd: [], toOverwrite: [], invalid: [], packageConflicts: [] };
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: 'File is not valid JSON.', ...empty };
  }
  if (!data || data.format !== EXPORT_FORMAT) return { ok: false, error: 'This file is not a Play Console Assistant export.', ...empty };
  if (data.exportVersion !== EXPORT_VERSION) return { ok: false, error: `Unsupported export version ${data.exportVersion}.`, ...empty };
  if (!Array.isArray(data.applications)) return { ok: false, error: 'Export has no applications list.', ...empty };

  const existingById = new Map(existingApps.map((a) => [a.id, a]));
  const plan = { ok: true, ...empty };
  const seenIds = new Set();
  data.applications.forEach((raw, index) => {
    let app;
    try {
      app = stripForImport(migrateApplication(raw));
    } catch (e) {
      plan.invalid.push({ index, id: raw && raw.id, errors: [{ path: '', message: e.message }] });
      return;
    }
    const v = validateApplication(app, { level: 'structure' });
    if (!v.valid) { plan.invalid.push({ index, id: app.id, errors: v.errors }); return; }
    if (seenIds.has(app.id)) { plan.invalid.push({ index, id: app.id, errors: [{ path: 'id', message: 'Duplicate id inside the file.' }] }); return; }
    seenIds.add(app.id);
    if (existingById.has(app.id)) plan.toOverwrite.push(app);
    else plan.toAdd.push(app);
  });

  // Same package name on two different records is almost certainly a
  // mix-up; surface it so the user resolves it explicitly.
  const byPkg = new Map();
  const finalIds = new Set([...plan.toAdd, ...plan.toOverwrite].map((a) => a.id));
  const all = [...existingApps.filter((a) => !finalIds.has(a.id)), ...plan.toAdd, ...plan.toOverwrite];
  for (const a of all) {
    const p = a.metadata.packageName;
    if (!p) continue;
    if (!byPkg.has(p)) byPkg.set(p, []);
    byPkg.get(p).push(a.id);
  }
  plan.packageConflicts = [...byPkg.entries()].filter(([, ids]) => ids.length > 1).map(([packageName, ids]) => ({ packageName, ids }));
  return plan;
}
