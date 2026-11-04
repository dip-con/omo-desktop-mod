// Host side of the locked built-in mod modmgr (Settings > 모드). The loader imports this module and calls
// handle(method, args) for each bridge call. list() reads every installed mod.json and the loader's state.json.
// setEnabled() changes the one `enabled` token of one unlocked mod.json, after a stale check and a verified backup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicWriteText, sha256 } from './host/fsx-lite.mjs';
import { classify, readLinks as readLinksReal } from './host/lnk.mjs';

const MODMGR_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODS_ROOT = path.dirname(MODMGR_DIR);
// mods.mjs (discovery and mod.json checks): the installed copy beside _loader, else the repository loader.
const LOADER_MODS = [
  path.join(DEFAULT_MODS_ROOT, '_loader', 'mods.mjs'),
  path.join(MODMGR_DIR, '..', '..', 'loader', 'mods.mjs'),
];
const { discoverMods } = await import(pathToFileURL(LOADER_MODS.find((file) => fs.existsSync(file))).href);

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
  if (entry.attached) return { status: entry.reason === 'UNKNOWN_BUILD' ? '붙음: 확인 안 된 앱 버전' : '붙음', reasonKo: '' };
  return { status: '못 붙음', reasonKo: REASON_KO[entry.reason] ?? String(entry.reason) };
}

// Same rule as loader/deps.mjs: LOADER_STATE_DIR first, else %LOCALAPPDATA%\omo-app-mods.
function defaultStateFile() {
  const dir = process.env.LOADER_STATE_DIR || path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'omo-app-mods');
  return path.join(dir, 'state.json');
}

// The icons tools/shortcuts.mjs manages, under the account's own profile folder (the tools/install.mjs REAL_HOME rule:
// os.userInfo().homedir, never USERPROFILE, which the agent environment redirects), and the app folder classify needs.
export function defaultShortcutDirs(home = os.userInfo().homedir) {
  const roaming = path.join(home, 'AppData', 'Roaming');
  return {
    desktop: path.join(home, 'Desktop'),
    startMenu: path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    taskbar: path.join(roaming, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
    appDir: path.join(home, 'AppData', 'Local', 'Programs', 'omo'),
  };
}

export function createModmgrHost({ modsRoot = DEFAULT_MODS_ROOT, stateFile = defaultStateFile(), shortcutDirs = null, readLinks = readLinksReal } = {}) {
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

  // Read only: the three OmO.lnk (tools/shortcuts.mjs labels), classified by
  // lnk.mjs (mod / plain / other / missing). One PowerShell read for all three, asynchronous, inside lnk.mjs's own
  // timeout. A missing, unreadable or foreign file is that row's state; the call still answers ok.
  // Cache rule: the answer is kept while every icon file has the same size and mtime (or stays missing), checked
  // with a stat per call; any change, and any read that failed as a whole, makes the next call read again.
  const dirs = shortcutDirs ?? defaultShortcutDirs();
  const links = [
    { label: 'desktop', path: path.join(dirs.desktop, 'OmO.lnk') },
    { label: 'startmenu', path: path.join(dirs.startMenu, 'OmO.lnk') },
    { label: 'taskbar', path: path.join(dirs.taskbar, 'OmO.lnk') },
  ];
  let cache = null;
  const signature = () => links.map((link) => {
    try {
      const stat = fs.statSync(link.path);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return '-';
    }
  }).join('|');

  async function readShortcuts() {
    let infos;
    let failed = false;
    try {
      infos = await readLinks(links.map((link) => link.path));
    } catch (error) {
      failed = true;
      infos = links.map((link) => (fs.existsSync(link.path) ? { exists: true, error: `READ_FAILED: ${error.message}` } : { exists: false }));
    }
    const shortcuts = links.map((link, i) => {
      const info = infos[i] ?? { exists: false };
      return {
        label: link.label, path: link.path, kind: classify(info, dirs.appDir), error: info.error ?? null, target: info.target ?? null,
        args: info.args ?? null, workdir: info.workdir ?? null, icon: info.icon ?? null, aumid: info.aumid ?? null, description: info.description ?? null,
      };
    });
    return { failed, answer: { ok: true, shortcuts } };
  }

  function shortcuts() {
    const key = signature();
    if (!cache || cache.key !== key) {
      const entry = { key, promise: null };
      entry.promise = readShortcuts().then(({ failed, answer }) => {
        if (failed && cache === entry) cache = null;
        return answer;
      });
      cache = entry;
    }
    return cache.promise;
  }

  const methods = { list, setEnabled, shortcuts };
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

  return { list, setEnabled, shortcuts, handle };
}

// The loader's entry point: the host reads the loader's own state file and its mods folder.
let appHost = null;
const forApp = () => (appHost ??= createModmgrHost());
export function handle(method, args) {
  return forApp().handle(method, args);
}
