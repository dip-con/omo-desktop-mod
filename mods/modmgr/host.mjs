// Host side of the built-in modmgr mod (설정 > 모드). The loader imports this module and calls
// handle(method, args, ctx) for every bridge call, with ctx = { modId, modDir, stateDir, modsHome }.
//   list           one row per <modsHome>/<id>/mod.json, with the loader's last report for it (stateDir/state.json)
//   setEnabled     flips the one `enabled` token of an unlocked mod.json, after a stale check against the hash list() gave
//   checkUpdates   check({ modsHome }) of the loader's update module
//   applyUpdates   apply({ modsHome, ids }) of the same module
// The update module is the installed copy <modsHome>/_loader/update/update.mjs, else the repository's src/update/update.mjs.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The loader's reasons for a mod that did not attach, in Korean for the page; any other reason shows as itself.
export const REASON_KO = {
  ANCHOR_MISSING: '화면 자리를 찾지 못했어요',
  BAD_FORMAT: 'mod.json 형식이 맞지 않아요',
  BAD_FILES: '모드 파일을 읽지 못했어요',
  HOST_FAILED: '모드 뒤편 코드가 실패했어요',
  MOD_ERROR: '모드 화면 코드에서 오류가 났어요',
  WATCHDOG: '화면이 비어 있어 모드를 뗐어요',
};
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

const refusal = (code, message = code) => ({ ok: false, code, message });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const sameExceptEnabled = (a, b) => JSON.stringify({ ...a, enabled: null }) === JSON.stringify({ ...b, enabled: null });

// Status of one mod: the file's switch first, then the loader's last report. A locked mod is always on.
function statusOf(mod, entry) {
  if ((mod.enabled === false && !mod.locked) || entry?.reason === 'DISABLED') return { status: '꺼짐', reasonKo: '' };
  if (!entry) return { status: '아직 확인 전', reasonKo: '' };
  if (entry.attached === true) return { status: '붙음', reasonKo: '' };
  return { status: '못 붙음', reasonKo: REASON_KO[entry.reason] ?? String(entry.reason ?? '') };
}

// The loader's last report per mod id; empty before the loader wrote a state. Throws when the file is not JSON.
function stateEntries(stateDir) {
  const file = path.join(stateDir, 'state.json');
  if (!fs.existsSync(file)) return new Map();
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Map((Array.isArray(state?.mods) ? state.mods : []).filter(isObject).map((m) => [m.id, m]));
}

// One row per <modsHome>/<name>/mod.json; names starting with '_' or '.' (_loader, .staging) are not mods. A mod.json
// that does not parse or names another id is a broken row (못 붙음). Rows sort by order then id, broken rows last.
function readRows(modsHome, entries) {
  const names = fs.existsSync(modsHome)
    ? fs.readdirSync(modsHome, { withFileTypes: true }).filter((d) => d.isDirectory() && !/^[_.]/.test(d.name)).map((d) => d.name)
    : [];
  const rows = [];
  for (const name of names) {
    const file = path.join(modsHome, name, 'mod.json');
    if (!fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file);
    let mod = null;
    try {
      mod = JSON.parse(bytes.toString('utf8'));
    } catch {
      mod = null;
    }
    if (!isObject(mod) || mod.id !== name) {
      rows.push({ id: name, name, nameKo: name, description: '', version: '', enabled: null, locked: false, order: Infinity, status: '못 붙음', reasonKo: REASON_KO.BAD_FORMAT, expected: null });
      continue;
    }
    rows.push({
      id: name,
      name: text(mod.name) || name,
      nameKo: text(mod.nameKo) || text(mod.name) || name,
      description: text(mod.description),
      version: text(mod.version),
      enabled: typeof mod.enabled === 'boolean' ? mod.enabled : null,
      locked: mod.locked === true,
      order: Number.isInteger(mod.order) ? mod.order : Infinity,
      ...statusOf(mod, entries.get(name)),
      expected: sha256(bytes),
    });
  }
  return rows.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id)).map(({ order, ...row }) => row);
}

function list(_arg, ctx) {
  let entries;
  try {
    entries = stateEntries(ctx.stateDir);
  } catch (error) {
    return refusal('BAD_STATE', `state.json is not readable JSON: ${error.message}`);
  }
  return { ok: true, mods: readRows(ctx.modsHome, entries) };
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

// Changes only the `enabled` token of an unlocked mod.json; every other byte stays. `expected` is the sha256 list() showed.
function setEnabled(arg, ctx) {
  const { id, on, expected } = isObject(arg) ? arg : {};
  if (typeof id !== 'string' || typeof on !== 'boolean' || typeof expected !== 'string') return refusal('BAD_ARGS', 'setEnabled needs {id, on, expected}');
  const file = path.join(ctx.modsHome, id, 'mod.json');
  if (!ID_PATTERN.test(id) || !fs.existsSync(file)) return refusal('UNKNOWN_MOD', `no installed mod ${id}`);
  const before = fs.readFileSync(file);
  if (sha256(before) !== expected) return refusal('STALE', `${id}/mod.json changed since the list was read`);
  const source = before.toString('utf8');
  let mod;
  try {
    mod = JSON.parse(source);
  } catch {
    return refusal('BAD_FORMAT', `${id}/mod.json is not valid JSON`);
  }
  if (mod.locked === true) return refusal('LOCKED', `${id} is built in and stays on`);
  if (mod.enabled === on) return { ok: true, id, enabled: on, changed: false, expected };
  const next = source.replace(/("enabled"\s*:\s*)(true|false)/, `$1${on}`);
  let after = null;
  try {
    after = JSON.parse(next);
  } catch {
    after = null;
  }
  if (!after || after.enabled !== on || !sameExceptEnabled(mod, after)) return refusal('BAD_FORMAT', `${id}/mod.json has no single top-level enabled value to change`);
  writeAtomic(file, next);
  return { ok: true, id, enabled: on, changed: true, expected: sha256(Buffer.from(next, 'utf8')) };
}

// The loader's update module for this mods home. The `?gen=n` the loader imported this host with is passed on, so a
// __reload gets a fresh update module as well.
async function updateModule(ctx) {
  const candidates = [path.join(ctx.modsHome, '_loader', 'update', 'update.mjs')];
  if (typeof ctx.modDir === 'string') candidates.push(path.resolve(ctx.modDir, '..', '..', 'src', 'update', 'update.mjs'));
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) throw new Error(`update module not found (${candidates.join(', ')})`);
  return import(pathToFileURL(file).href + new URL(import.meta.url).search);
}

// Compares every installed id with its install source; changes nothing. Per-id failures stay in items[].error; a
// missing or unreadable install.json is the refusal NO_INSTALL_RECORD.
async function checkUpdates(_arg, ctx) {
  const r = await (await updateModule(ctx)).check({ modsHome: ctx.modsHome });
  if (typeof r?.error === 'string') return refusal('NO_INSTALL_RECORD', r.error);
  return { ok: true, items: Array.isArray(r?.items) ? r.items : [] };
}

// Brings the given ids up to their sources; mod.json "enabled" values are kept by the update module.
async function applyUpdates(arg, ctx) {
  const ids = isObject(arg) ? arg.ids : undefined;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string' && id !== '')) {
    return refusal('BAD_ARGS', 'applyUpdates needs {ids: [id, ...]}');
  }
  const r = await (await updateModule(ctx)).apply({ modsHome: ctx.modsHome, ids });
  const errors = Array.isArray(r?.errors) ? r.errors : [];
  const fatal = errors.find((e) => isObject(e) && e.id === null);
  if (fatal) return refusal('NO_INSTALL_RECORD', String(fatal.message));
  return { ok: true, applied: Array.isArray(r?.applied) ? r.applied : [], skipped: Array.isArray(r?.skipped) ? r.skipped : [], errors };
}

const METHODS = { list, setEnabled, checkUpdates, applyUpdates };

// Bridge entry. A refusal is a value the page renders; a throw or a rejection becomes one too.
export async function handle(method, args = [], ctx = {}) {
  if (!Object.hasOwn(METHODS, method)) return refusal('UNKNOWN_METHOD', `unknown method ${method}`);
  if (!Array.isArray(args)) return refusal('BAD_ARGS', 'args must be an array');
  if (typeof ctx?.modsHome !== 'string' || typeof ctx?.stateDir !== 'string') return refusal('HOST_ERROR', 'ctx needs modsHome and stateDir');
  try {
    return await METHODS[method](args[0], ctx);
  } catch (error) {
    return refusal('HOST_ERROR', String(error?.message ?? error));
  }
}
