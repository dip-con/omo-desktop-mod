// Mod discovery and mod.json checks. Reads only; the loader decides what to inject from the results.
import fs from 'node:fs';
import path from 'node:path';

// Mods live beside the loader folder. Installed: <mods-home>/_loader -> <mods-home>. Development: REPO/loader -> REPO/mods.
export function modsRootFor(loaderDir) {
  return path.basename(loaderDir) === '_loader' ? path.dirname(loaderDir) : path.join(path.dirname(loaderDir), 'mods');
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// A relative path that stays inside the mod folder.
function isInsideModFolder(rel) {
  if (typeof rel !== 'string' || rel === '' || path.isAbsolute(rel)) return false;
  const parts = rel.split(/[\\/]/);
  return !parts.includes('..');
}

// Returns { ok: true, mod } or { ok: false, reason } where reason names the first broken field.
export function parseModJson(raw, folderName) {
  if (!isPlainObject(raw)) return { ok: false, reason: 'mod.json is not an object' };
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return { ok: false, reason: 'id must be lowercase letters, digits, dashes' };
  if (raw.id !== folderName) return { ok: false, reason: `id ${raw.id} must equal folder name ${folderName}` };
  for (const k of ['name', 'nameKo', 'version']) {
    if (typeof raw[k] !== 'string' || raw[k] === '') return { ok: false, reason: `${k} must be a non-empty string` };
  }
  if (typeof raw.enabled !== 'boolean') return { ok: false, reason: 'enabled must be boolean' };
  if (raw.locked !== undefined && typeof raw.locked !== 'boolean') return { ok: false, reason: 'locked must be boolean' };
  if (raw.descriptionKo !== undefined && typeof raw.descriptionKo !== 'string') return { ok: false, reason: 'descriptionKo must be a string' };
  if (!Number.isInteger(raw.order)) return { ok: false, reason: 'order must be an integer' };
  if (!isPlainObject(raw.entry) || !isInsideModFolder(raw.entry.page)) return { ok: false, reason: 'entry.page must be a relative path inside the mod' };
  if (raw.entry.css !== undefined && !isInsideModFolder(raw.entry.css)) return { ok: false, reason: 'entry.css must be a relative path inside the mod' };
  if (raw.entry.host !== undefined && !isInsideModFolder(raw.entry.host)) return { ok: false, reason: 'entry.host must be a relative path inside the mod' };
  if (!isPlainObject(raw.contributes)) return { ok: false, reason: 'contributes must be an object' };
  if (raw.contributes.settingsPage !== undefined) {
    const sp = raw.contributes.settingsPage;
    if (!isPlainObject(sp) || typeof sp.id !== 'string' || typeof sp.label !== 'string') return { ok: false, reason: 'contributes.settingsPage needs id and label' };
  }
  if (!Array.isArray(raw.testedBuilds) || !raw.testedBuilds.every((b) => typeof b === 'string')) return { ok: false, reason: 'testedBuilds must be a string array' };
  if (!Array.isArray(raw.anchors)) return { ok: false, reason: 'anchors must be an array' };
  for (const a of raw.anchors) {
    if (!isPlainObject(a) || typeof a.selector !== 'string' || a.selector === '') return { ok: false, reason: 'each anchor needs a selector' };
    if (typeof a.route !== 'string' || !(a.route === '*' || a.route.startsWith('/'))) return { ok: false, reason: 'each anchor route must be * or start with /' };
  }
  return { ok: true, mod: { ...raw, locked: raw.locked === true, folder: folderName } };
}

// Finds <root>/*/mod.json (one level), skipping the _loader folder. Broken entries are returned, not thrown.
export function discoverMods(modsRoot) {
  const mods = [];
  const skipped = [];
  if (!fs.existsSync(modsRoot)) return { mods, skipped };
  for (const name of fs.readdirSync(modsRoot).sort()) {
    if (name === '_loader') continue;
    const file = path.join(modsRoot, name, 'mod.json');
    if (!fs.existsSync(file)) continue;
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      skipped.push({ id: name, reason: `mod.json is not valid JSON: ${err.message}` });
      continue;
    }
    const parsed = parseModJson(raw, name);
    if (parsed.ok) mods.push(parsed.mod);
    else skipped.push({ id: name, reason: parsed.reason });
  }
  mods.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { mods, skipped };
}

// enabled:false mods never reach the bundle. They are reported with reason DISABLED by the caller.
// A locked mod (the built-in modmgr) stays active whatever its enabled value says.
export function partitionEnabled(mods) {
  return { active: mods.filter((m) => m.enabled || m.locked), disabled: mods.filter((m) => !m.enabled && !m.locked) };
}

// '*' matches every page. A route ending in '/' is a prefix; any other route matches itself and its sub-paths.
export function routeMatches(route, pathname) {
  if (route === '*') return true;
  if (route.endsWith('/')) return pathname.startsWith(route);
  return pathname === route || pathname.startsWith(`${route}/`);
}

// Decides one mod's state for one page. `present(selector)` answers whether that anchor exists now.
// Every anchor that applies to this page is checked, whatever the build. A missing anchor switches only this mod off.
// An unknown build with all anchors present still attaches, with reason UNKNOWN_BUILD.
export function evaluateMod(mod, { pathname, buildKey, present }) {
  const applicable = mod.anchors.filter((a) => routeMatches(a.route, pathname));
  if (applicable.some((a) => !present(a.selector))) return { id: mod.id, attached: false, reason: 'ANCHOR_MISSING' };
  if (!mod.testedBuilds.includes(buildKey)) return { id: mod.id, attached: true, reason: 'UNKNOWN_BUILD' };
  return { id: mod.id, attached: true, reason: null };
}
