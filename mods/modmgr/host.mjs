// Host side of the locked built-in mod modmgr (Settings > 모드). The loader imports this module and calls
// handle(method, args) for each bridge call. list() reads every installed mod.json and the loader's state.json.
// setEnabled() changes the one `enabled` token of one unlocked mod.json, after a stale check and a verified backup.
// checkUpdates() and applyUpdates() delegate to the loader's update.mjs for this mods folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicWriteText, sha256 } from './host/fsx-lite.mjs';

const MODMGR_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODS_ROOT = path.dirname(MODMGR_DIR);
// mods.mjs (discovery and mod.json checks): the installed copy beside _loader, else the repository loader.
const LOADER_MODS = [
  path.join(DEFAULT_MODS_ROOT, '_loader', 'mods.mjs'),
  path.join(MODMGR_DIR, '..', '..', 'loader', 'mods.mjs'),
];
const { discoverMods } = await import(pathToFileURL(LOADER_MODS.find((file) => fs.existsSync(file))).href);
// update.mjs, by the same rule, for the mods folder the host serves.
const loaderUpdate = (modsRoot) => {
  const file = [path.join(modsRoot, '_loader', 'update.mjs'), path.join(MODMGR_DIR, '..', '..', 'loader', 'update.mjs')].find((f) => fs.existsSync(f));
  return file ? import(pathToFileURL(file).href) : Promise.reject(new Error('update.mjs not found'));
};

// The reasons the loader writes to state.json (loader/deps.mjs, loader/inject.mjs), in Korean for the page.
const REASON_KO = {
  ANCHOR_MISSING: '화면 자리를 찾지 못했어요',
  BAD_FORMAT: 'mod.json 형식이 맞지 않아요',
  BAD_FILES: '모드 파일을 읽지 못했어요',
  HOST_FAILED: '모드 뒤편 코드가 실패했어요',
  MOD_ERROR: '모드 화면 코드에서 오류가 났어요',
  WATCHDOG: '화면이 비어 있어 모드를 뗐어요',
};

const refusal = (code, message = code) => ({ ok: false, code, message });
const sameExceptEnabled = (a, b) => JSON.stringify({ ...a, enabled: null }) === JSON.stringify({ ...b, enabled: null });

// Status for one mod: the file's switch first, then the loader's last report for that mod. A locked mod is always on.
function statusOf(mod, entry) {
  const switchedOff = (mod.enabled === false && !mod.locked) || entry?.reason === 'DISABLED';
  if (switchedOff) return { status: '꺼짐', reasonKo: '' };
  if (!entry) return { status: '아직 확인 전', reasonKo: '' };
  if (entry.attached) return { status: '붙음', reasonKo: '' };
  return { status: '못 붙음', reasonKo: REASON_KO[entry.reason] ?? String(entry.reason) };
}

// Same rule as loader/deps.mjs defaultStateDir(): LOADER_STATE_DIR first, else ~/Library/Application Support/omo-app-mods.
export function defaultStateFile() {
  const dir = process.env.LOADER_STATE_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'omo-app-mods');
  return path.join(dir, 'state.json');
}

export function createModmgrHost({ modsRoot = DEFAULT_MODS_ROOT, stateFile = defaultStateFile() } = {}) {
  const modJsonOf = (id) => path.join(modsRoot, id, 'mod.json');

  function readStateMods() {
    if (!fs.existsSync(stateFile)) return [];
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return Array.isArray(state?.mods) ? state.mods : [];
  }

  function list() {
    let entries;
    try {
      entries = readStateMods();
    } catch (error) {
      return refusal('BAD_STATE', `state file is not readable JSON: ${error.message}`);
    }
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const found = discoverMods(modsRoot);
    const rows = found.mods.map((mod) => ({
      id: mod.id,
      name: mod.name,
      nameKo: mod.nameKo,
      descriptionKo: mod.descriptionKo ?? '',
      version: mod.version,
      enabled: mod.enabled,
      locked: mod.locked,
      ...statusOf(mod, byId.get(mod.id)),
      expected: sha256(fs.readFileSync(modJsonOf(mod.id))),
    }));
    const broken = found.skipped.map(({ id }) => ({
      id, name: id, nameKo: id, descriptionKo: '', version: '', enabled: null, locked: false,
      status: '못 붙음', reasonKo: REASON_KO.BAD_FORMAT, expected: null,
    }));
    return { ok: true, mods: [...rows, ...broken] };
  }

  // Changes only the `enabled` token of an unlocked mod. `expected` is the sha256 of the mod.json that list() showed.
  function setEnabled({ id, on, expected } = {}) {
    if (typeof id !== 'string' || typeof on !== 'boolean' || typeof expected !== 'string') {
      return refusal('BAD_ARGS', 'setEnabled needs {id, on, expected}');
    }
    const mod = discoverMods(modsRoot).mods.find((m) => m.id === id);
    if (!mod) return refusal('UNKNOWN_MOD', `no installed mod ${id}`);
    if (mod.locked) return refusal('LOCKED', `${id} is built in and cannot be switched off`);
    const file = modJsonOf(id);
    const before = fs.readFileSync(file);
    if (sha256(before) !== expected) return refusal('STALE', `${id} changed since the list was read`);
    const parsedBefore = JSON.parse(before.toString('utf8'));
    if (parsedBefore.enabled === on) return { ok: true, id, enabled: on, changed: false };
    const next = before.toString('utf8').replace(/("enabled"\s*:\s*)(?:true|false)/, `$1${on}`);
    const parsedAfter = JSON.parse(next);
    if (parsedAfter.enabled !== on || !sameExceptEnabled(parsedBefore, parsedAfter)) {
      return refusal('BAD_FORMAT', `${id} mod.json has no single top-level enabled value to change`);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(modsRoot, '_loader', 'backups', stamp, `${id}-mod.json`);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, before);
    if (sha256(fs.readFileSync(backup)) !== expected) return refusal('BACKUP_FAILED', `backup ${backup} does not match the original`);
    atomicWriteText(file, next);
    const written = fs.readFileSync(file, 'utf8');
    const reparsed = JSON.parse(written);
    if (written !== next || reparsed.enabled !== on || !sameExceptEnabled(parsedBefore, reparsed)) {
      atomicWriteText(file, before);
      return refusal('VERIFY_FAILED', `${id} did not read back as written; the original bytes were restored`);
    }
    return { ok: true, id, enabled: on, changed: true, backup, sha256: sha256(fs.readFileSync(file)) };
  }

  // Compares each installed folder with its install source; changes nothing.
  async function checkUpdates() {
    return (await loaderUpdate(modsRoot)).checkUpdates({ modsHome: modsRoot });
  }

  // Copies changed sources in (optionally after git pull --ff-only); mod.json "enabled" values are kept.
  async function applyUpdates({ ids, pull = false } = {}) {
    if ((ids !== undefined && (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string'))) || typeof pull !== 'boolean') {
      return refusal('BAD_ARGS', 'applyUpdates needs {ids?: string[], pull?: boolean}');
    }
    return (await loaderUpdate(modsRoot)).applyUpdates({ modsHome: modsRoot, ids, pull });
  }

  const methods = { list, setEnabled, checkUpdates, applyUpdates };
  // Bridge entry: a refusal is a value the page renders; a throw or a rejected promise becomes one too.
  function handle(method, args = []) {
    if (!Object.hasOwn(methods, method)) return refusal('UNKNOWN_METHOD', `unknown method ${method}`);
    if (!Array.isArray(args)) return refusal('BAD_ARGS', 'args must be an array');
    try {
      const value = methods[method](...args);
      return value instanceof Promise ? value.catch((error) => refusal('HOST_ERROR', String(error?.message ?? error))) : value;
    } catch (error) {
      return refusal('HOST_ERROR', String(error?.message ?? error));
    }
  }

  return { list, setEnabled, checkUpdates, applyUpdates, handle };
}

// The loader's entry point: the host reads the loader's own state file and its mods folder.
let appHost = null;
const forApp = () => (appHost ??= createModmgrHost());
export function handle(method, args) {
  return forApp().handle(method, args);
}
