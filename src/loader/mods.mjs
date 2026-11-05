// Mod discovery and mod.json v2 checks. Reads only; nothing here writes or throws for a broken mod.
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../core/fsx.mjs';

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const TOP_KEYS = new Set(['id', 'name', 'nameKo', 'description', 'version', 'enabled', 'locked', 'order', 'entry', 'settingsPage', 'anchors', 'source']);
const ENTRY_KEYS = new Set(['page', 'css', 'host']);
const SOURCE_KEYS = new Set(['repo', 'path', 'ref']);

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v !== '';
const optionalText = (v) => v === undefined || typeof v === 'string';
const unknownKey = (obj, allowed) => Object.keys(obj).find((k) => !allowed.has(k));

// A relative path that stays inside the mod folder.
function isInside(rel) {
  return isText(rel) && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..');
}

// Returns { ok: true, mod } or { ok: false, reason } naming the first broken field.
export function validateModJson(raw, folderName) {
  const bad = (reason) => ({ ok: false, reason });
  if (!isObject(raw)) return bad('mod.json is not an object');
  const extra = unknownKey(raw, TOP_KEYS);
  if (extra) return bad(`unknown field ${extra}`);
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return bad('id must be lowercase letters, digits, dashes');
  if (raw.id !== folderName) return bad(`id ${raw.id} must equal folder name ${folderName}`);
  if (!isText(raw.name) || !isText(raw.version)) return bad('name and version must be non-empty strings');
  if (!optionalText(raw.nameKo) || !optionalText(raw.description)) return bad('nameKo and description must be strings');
  if (typeof raw.enabled !== 'boolean') return bad('enabled must be boolean');
  if (raw.locked !== undefined && typeof raw.locked !== 'boolean') return bad('locked must be boolean');
  if (!Number.isInteger(raw.order)) return bad('order must be an integer');
  if (!isObject(raw.entry) || unknownKey(raw.entry, ENTRY_KEYS) || !isInside(raw.entry.page)) return bad('entry needs page and only page, css, host');
  for (const k of ['css', 'host']) if (raw.entry[k] !== undefined && !isInside(raw.entry[k])) return bad(`entry.${k} must be a relative path inside the mod`);
  if (raw.settingsPage !== undefined) {
    const sp = raw.settingsPage;
    if (!isObject(sp) || unknownKey(sp, new Set(['id', 'label'])) || !isText(sp.id) || !isText(sp.label)) return bad('settingsPage needs id and label');
  }
  if (raw.source !== undefined) {
    const s = raw.source;
    if (!isObject(s) || unknownKey(s, SOURCE_KEYS) || !isText(s.repo) || !optionalText(s.path) || !optionalText(s.ref)) return bad('source needs repo and optional path, ref');
  }
  if (!Array.isArray(raw.anchors)) return bad('anchors must be an array');
  for (const a of raw.anchors) {
    if (!isObject(a) || unknownKey(a, new Set(['selector', 'route'])) || !isText(a.selector)) return bad('each anchor needs a selector');
    if (typeof a.route !== 'string' || !(a.route === '*' || a.route.startsWith('/'))) return bad('each anchor route must be * or start with /');
  }
  return { ok: true, mod: { ...raw, nameKo: raw.nameKo ?? raw.name, locked: raw.locked === true } };
}

// Every <modsHome>/<id>/mod.json one level down. Names starting with '_' or '.' (_loader, .staging) are not mods.
// Returns { mods, broken }: mods sorted by order then id, broken as [{ id, reason }].
export function discover(modsHome) {
  const mods = [];
  const broken = [];
  let names = [];
  try {
    names = fs.readdirSync(modsHome, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return { mods, broken };
  }
  for (const name of names) {
    if (name.startsWith('_') || name.startsWith('.')) continue;
    const file = path.join(modsHome, name, 'mod.json');
    if (!fs.existsSync(file)) continue;
    const unreadable = Symbol('unreadable');
    const raw = readJson(file, unreadable);
    const parsed = raw === unreadable ? { ok: false, reason: 'mod.json is not valid JSON' } : validateModJson(raw, name);
    if (parsed.ok) mods.push({ ...parsed.mod, dir: path.join(modsHome, name) });
    else broken.push({ id: name, reason: parsed.reason });
  }
  mods.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  return { mods, broken };
}

// '*' matches every page. A route ending in '/' is a prefix; any other route matches itself and its sub-paths.
// Copied into the page bundle as text, so it must stay self-contained.
export function routeMatches(route, pathname) {
  if (route === '*') return true;
  if (route.endsWith('/')) return pathname.startsWith(route);
  return pathname === route || pathname.startsWith(`${route}/`);
}
