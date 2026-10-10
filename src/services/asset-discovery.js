/**
 * Maps files from a selected folder to asset roles using configurable
 * filename conventions. Never guesses: a role with more than one candidate
 * is reported as ambiguous, files that match nothing are left unassigned,
 * and screenshot order comes only from the number in the filename (or the
 * user's explicit order in the mapping UI).
 */
import { ASSET_ROLES, LIMITS } from '../data/schema.js';

const SCREENSHOT_ROLES = ['phoneScreenshots', 'tablet7Screenshots', 'tablet10Screenshots'];
export const ALL_ROLES = [...Object.keys(ASSET_ROLES), 'releaseNotes'];

/**
 * @param {Array<{name:string, path?:string, size:number}>} files
 * @param {Record<string,string>} conventions role -> regex source
 * @returns {{
 *   assignments: Record<string, any>,
 *   ambiguous: Array<{role:string, candidates:string[], reason:string}>,
 *   unassigned: string[],
 *   conflicts: Array<{file:string, roles:string[]}>,
 * }}
 */
export function discoverAssets(files, conventions) {
  const patterns = Object.fromEntries(
    Object.entries(conventions).filter(([role]) => ALL_ROLES.includes(role)).map(([role, src]) => [role, new RegExp(src, 'i')]),
  );
  const matchesByRole = Object.fromEntries(ALL_ROLES.map((r) => [r, []]));
  const conflicts = [];
  const unassigned = [];

  for (const f of files) {
    if (isHiddenOrSystem(f.name)) continue;
    const roles = [];
    for (const [role, re] of Object.entries(patterns)) {
      const m = f.name.match(re);
      if (m) roles.push({ role, order: m[1] !== undefined ? Number(m[1]) : null });
    }
    if (roles.length === 0) unassigned.push(f.name);
    else if (roles.length > 1) conflicts.push({ file: f.name, roles: roles.map((r) => r.role) });
    else matchesByRole[roles[0].role].push({ file: f, order: roles[0].order });
  }

  const assignments = {};
  const ambiguous = [];
  for (const role of ALL_ROLES) {
    const list = matchesByRole[role];
    if (SCREENSHOT_ROLES.includes(role)) {
      const byOrder = new Map();
      for (const item of list) {
        if (item.order === null || !Number.isFinite(item.order)) {
          ambiguous.push({ role, candidates: [item.file.name], reason: 'Screenshot has no order number.' });
          continue;
        }
        if (!byOrder.has(item.order)) byOrder.set(item.order, []);
        byOrder.get(item.order).push(item.file.name);
      }
      const dupes = [...byOrder.entries()].filter(([, names]) => names.length > 1);
      for (const [order, names] of dupes) ambiguous.push({ role, candidates: names, reason: `More than one file uses position ${order}.` });
      if (dupes.length) continue;
      const ordered = [...byOrder.entries()].sort((a, b) => a[0] - b[0]).map(([, names]) => names[0]);
      if (ordered.length > LIMITS.maxScreenshotsPerType) {
        ambiguous.push({ role, candidates: ordered, reason: `More than ${LIMITS.maxScreenshotsPerType} screenshots; choose which to use.` });
        continue;
      }
      if (ordered.length) assignments[role] = ordered;
    } else if (list.length === 1) {
      assignments[role] = list[0].file.name;
    } else if (list.length > 1) {
      ambiguous.push({ role, candidates: list.map((x) => x.file.name), reason: 'More than one file matches.' });
    }
  }
  return { assignments, ambiguous, unassigned, conflicts };
}

function isHiddenOrSystem(name) {
  return name.startsWith('.') || /^(thumbs\.db|desktop\.ini)$/i.test(name);
}

/**
 * Validates a user-edited mapping (role -> filename | filename[]) before it
 * is saved: every file used at most once, single roles hold one file,
 * screenshot lists within limits.
 */
export function validateMapping(mapping) {
  const errors = [];
  const used = new Map();
  for (const [role, value] of Object.entries(mapping)) {
    if (!ALL_ROLES.includes(role)) { errors.push(`Unknown role ${role}.`); continue; }
    const names = [].concat(value || []);
    if (!SCREENSHOT_ROLES.includes(role) && names.length > 1) errors.push(`${role} accepts only one file.`);
    if (SCREENSHOT_ROLES.includes(role) && names.length > LIMITS.maxScreenshotsPerType) errors.push(`${role} accepts at most ${LIMITS.maxScreenshotsPerType} files.`);
    for (const n of names) {
      if (used.has(n)) errors.push(`${n} is assigned to both ${used.get(n)} and ${role}.`);
      else used.set(n, role);
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Finds files with identical content (by sha256) across a mapping. */
export function findDuplicateContent(hashByFile) {
  const byHash = new Map();
  for (const [file, hash] of Object.entries(hashByFile)) {
    if (!byHash.has(hash)) byHash.set(hash, []);
    byHash.get(hash).push(file);
  }
  return [...byHash.values()].filter((names) => names.length > 1);
}
