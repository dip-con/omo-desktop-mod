#!/usr/bin/env node
// Retargets the three OmO.lnk icons to the mod launcher. It makes no other icon: an 'OmO (순정).lnk' left by an earlier
// version is only reported by status and taken back by restore.
// A folder without a flag defaults from the account's profile folder (os.userInfo().homedir, never USERPROFILE or HOME,
// which the agent environment redirects) and the Windows known-folder API. An explicit flag always wins, so a run in a
// temp tree never reaches the real icons.
//
//   node tools/shortcuts.mjs status  [dir flags]
//   node tools/shortcuts.mjs apply   [dir flags] [--backup-dir <d>] [--dry-run]
//   node tools/shortcuts.mjs restore [dir flags] [--backup-dir <d>] [--dry-run]
//
// Default backup dir: <mods-home>/backup/<ISO time>. restore without --backup-dir takes the newest one that holds a manifest.
//
// apply writes <backup-dir>/manifest.json before it modifies any shortcut. restore copies the backed-up bytes back and
// checks each sha256 against the manifest, then removes the manifest.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_USER_MODEL_ID, classify, readLink, readLinks, writeLink } from '../mods/modmgr/host/lnk.mjs';

const LINK_NAME = 'OmO.lnk';
const CREATED_NAME = 'OmO (순정).lnk';
const CREATED_DESCRIPTION = 'OmO (모드 없이)';
const MANIFEST_NAME = 'manifest.json';
const COMMANDS = ['status', 'apply', 'restore'];
const DIR_FLAGS = ['desktop-dir', 'start-menu-dir', 'taskbar-dir', 'mods-home', 'app-dir'];
const USAGE = `usage: node tools/shortcuts.mjs <status|apply|restore> [--desktop-dir <dir>] [--start-menu-dir <dir>] [--taskbar-dir <dir>] [--mods-home <dir>] [--app-dir <dir>] [--backup-dir <dir>] [--dry-run]
  status   read-only report of the three OmO.lnk and any 'OmO (순정).lnk' an earlier version left on the desktop
  apply    retarget the three OmO.lnk to the mod launcher (backs them up first; default backup <mods-home>/backup/<time>)
  restore  put the backed-up bytes back and remove what an earlier apply created (default: the newest backup)
  defaults: home = your account's profile folder; mods home = <home>/.omo/app-mods; app dir = <home>/AppData/Local/Programs/omo;
            desktop and start menu from the Windows known folders. A flag always wins.
  --dry-run prints the plan and writes nothing`;

class UsageError extends Error {}

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.includes(command)) throw new UsageError(`unknown or missing command${command ? `: ${command}` : ''}`);
  const allowed = command === 'status' ? DIR_FLAGS : [...DIR_FLAGS, 'backup-dir', 'dry-run'];
  const flags = new Map();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (!allowed.includes(name)) throw new UsageError(`unknown flag for ${command}: ${arg}`);
    if (name === 'dry-run') {
      flags.set(name, true);
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`missing value for ${arg}`);
    flags.set(name, value);
    i += 1;
  }
  const dir = (name) => (flags.has(name) ? path.resolve(flags.get(name)) : null);
  return {
    command,
    dryRun: flags.get('dry-run') === true,
    desktopDir: dir('desktop-dir'),
    startMenuDir: dir('start-menu-dir'),
    taskbarDir: dir('taskbar-dir'),
    modsHome: dir('mods-home'),
    appDir: dir('app-dir'),
    backupDir: dir('backup-dir'),
  };
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// The Windows known-folder API answers for the account even when HOME or USERPROFILE is redirected.
function knownFolders() {
  const script = "$f=@{desktop=[Environment]::GetFolderPath('Desktop');programs=[Environment]::GetFolderPath('Programs');appData=[Environment]::GetFolderPath('ApplicationData')}; $f | ConvertTo-Json -Compress";
  // The known-folder API reads USERPROFILE and APPDATA: a redirected value would move Desktop and Start Menu (it returned
  // an empty Desktop under a redirected profile). The child gets the account's own values instead.
  const home = os.userInfo().homedir;
  const env = { ...process.env, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming') };
  delete env.HOME;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 30000, env });
  if (r.error || r.status !== 0) throw new ToolError('KNOWN_FOLDERS', `cannot read the Windows known folders${r.stderr ? `: ${r.stderr.trim()}` : ''}`);
  return JSON.parse(r.stdout);
}

// The newest <mods-home>/backup/<time> folder that still holds a manifest, or null.
export function newestBackup(modsHome) {
  const root = path.join(modsHome, 'backup');
  if (!fs.existsSync(root)) return null;
  const names = fs.readdirSync(root).filter((name) => fs.existsSync(path.join(root, name, MANIFEST_NAME))).sort();
  return names.length > 0 ? path.join(root, names[names.length - 1]) : null;
}

// Fills every folder the command got no flag for. Explicit flags win; nothing reads USERPROFILE or HOME.
export function withDefaults(opts) {
  const home = os.userInfo().homedir;
  const modsHome = opts.modsHome ?? path.join(home, '.omo', 'app-mods');
  const known = opts.desktopDir && opts.startMenuDir && opts.taskbarDir ? null : knownFolders();
  let backupDir = opts.backupDir;
  if (backupDir === null && opts.command === 'apply') backupDir = path.join(modsHome, 'backup', stamp());
  if (backupDir === null && opts.command === 'restore') backupDir = newestBackup(modsHome);
  return {
    ...opts,
    modsHome,
    backupDir,
    appDir: opts.appDir ?? path.join(home, 'AppData', 'Local', 'Programs', 'omo'),
    desktopDir: opts.desktopDir ?? known.desktop,
    startMenuDir: opts.startMenuDir ?? known.programs,
    taskbarDir: opts.taskbarDir ?? path.join(known.appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
  };
}

function layout(opts) {
  const appExe = path.join(opts.appDir, 'OmO.exe');
  return {
    appExe,
    loaderDir: path.join(opts.modsHome, '_loader'),
    retarget: [
      { label: 'desktop', path: path.join(opts.desktopDir, LINK_NAME) },
      { label: 'startmenu', path: path.join(opts.startMenuDir, LINK_NAME) },
      { label: 'taskbar', path: path.join(opts.taskbarDir, LINK_NAME) },
    ],
    // Made by an earlier design (desktop only). apply no longer makes it; status reports it and restore takes it back
    // from a manifest that lists it.
    legacy: [{ label: 'desktop-pure', path: path.join(opts.desktopDir, CREATED_NAME) }],
  };
}

function modSpec(lay, lnkPath) {
  return {
    path: lnkPath,
    create: false,
    target: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe'),
    args: `"${path.join(lay.loaderDir, 'launch.vbs')}"`,
    workDir: lay.loaderDir,
    iconPath: lay.appExe,
    iconIndex: 0,
    description: null,
    aumid: APP_USER_MODEL_ID,
  };
}

const same = (a, b) => path.win32.normalize(a ?? '').toLowerCase() === path.win32.normalize(b ?? '').toLowerCase();
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function facts(file) {
  const stat = fs.statSync(file);
  return { sha256: sha(file), size: stat.size, mtime: stat.mtime.toISOString() };
}

function isModLink(info, lay) {
  return classify(info, path.dirname(lay.appExe)) === 'mod'
    && same(info.target, path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe'))
    && info.args === `"${path.join(lay.loaderDir, 'launch.vbs')}"`
    && same(info.workdir, lay.loaderDir)
    && same(info.icon, `${lay.appExe},0`)
    && info.aumid === APP_USER_MODEL_ID;
}

function isPureLink(info, appDir) {
  return classify(info, appDir) === 'plain' && (info.aumid ?? '') === '' && info.description === CREATED_DESCRIPTION;
}

function loadManifest(dir) {
  const file = path.join(dir, MANIFEST_NAME);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
}

function requireDirs(opts) {
  for (const dir of [opts.desktopDir, opts.startMenuDir, opts.taskbarDir]) {
    if (!fs.existsSync(dir)) throw new ToolError('DIR_MISSING', `directory not found: ${dir}`);
  }
}

async function statusOf(opts, lay) {
  const all = [...lay.retarget, ...lay.legacy];
  const infos = await readLinks(all.map((link) => link.path));
  return all.map((link, i) => {
    const info = infos[i];
    return {
      label: link.label,
      path: link.path,
      kind: classify(info, opts.appDir),
      error: info.error ?? null,
      target: info.target ?? null,
      args: info.args ?? null,
      workdir: info.workdir ?? null,
      icon: info.icon ?? null,
      aumid: info.aumid ?? null,
      description: info.description ?? null,
      ...(info.exists ? facts(link.path) : {}),
    };
  });
}

function describe(steps) {
  return steps.map(({ label, path: p, action, reason }) => ({ label, path: p, action, ...(reason ? { reason } : {}) }));
}

async function planApply(opts, lay) {
  const retargetInfos = await readLinks(lay.retarget.map((link) => link.path));
  const steps = [];
  lay.retarget.forEach((link, i) => {
    const info = retargetInfos[i];
    const kind = classify(info, opts.appDir);
    if (kind === 'missing') steps.push({ ...link, action: 'skip', reason: 'missing' });
    else if (kind === 'mod') steps.push({ ...link, action: 'skip', reason: 'already-mod' });
    else if (kind !== 'plain') throw new ToolError('FOREIGN_SHORTCUT', `${link.path} does not start OmO.exe; nothing written`);
    else if (info.aumid !== APP_USER_MODEL_ID) {
      throw new ToolError('UNEXPECTED_AUMID', `${link.path} has AUMID '${info.aumid}', expected ${APP_USER_MODEL_ID}; nothing written`);
    } else steps.push({ ...link, action: 'retarget', spec: modSpec(lay, link.path) });
  });
  return steps;
}

async function apply(opts, lay) {
  requireDirs(opts);
  if (!fs.existsSync(path.join(lay.loaderDir, 'launch.vbs'))) {
    throw new ToolError('MODS_NOT_INSTALLED', `${path.join(lay.loaderDir, 'launch.vbs')} not found; run tools/install.mjs first`);
  }
  if (!fs.existsSync(lay.appExe)) throw new ToolError('APP_MISSING', `${lay.appExe} not found`);
  const steps = await planApply(opts, lay);
  const writes = steps.filter((step) => step.action === 'retarget');
  if (opts.dryRun || writes.length === 0) {
    return { command: 'apply', dryRun: opts.dryRun, steps: describe(steps), shortcuts: opts.dryRun ? null : await statusOf(opts, lay) };
  }
  // The manifest lands before any shortcut is modified, so an interrupted apply can still be restored.
  const manifest = loadManifest(opts.backupDir) ?? { version: 1, createdAt: new Date().toISOString(), entries: [] };
  const hasEntry = (p) => manifest.entries.some((entry) => same(entry.path, p));
  for (const step of writes) {
    if (hasEntry(step.path)) continue;
    const backup = `${step.label}-${LINK_NAME}`;
    const backupFile = path.join(opts.backupDir, backup);
    fs.mkdirSync(opts.backupDir, { recursive: true });
    fs.copyFileSync(step.path, backupFile);
    if (sha(backupFile) !== sha(step.path)) throw new ToolError('COPY_MISMATCH', `backup of ${step.path} does not match the original`);
    manifest.entries.push({ label: step.label, path: step.path, kind: 'retarget', backup, ...facts(backupFile) });
  }
  writeManifest(opts.backupDir, manifest);
  for (const step of writes) {
    await writeLink(step.spec);
    const after = await readLink(step.path);
    if (!isModLink(after, lay)) throw new ToolError('VERIFY_FAILED', `${step.path} re-read does not match the mod launcher`);
  }
  return { command: 'apply', dryRun: false, steps: describe(steps), shortcuts: await statusOf(opts, lay) };
}

async function restore(opts, lay) {
  requireDirs(opts);
  const manifest = opts.backupDir ? loadManifest(opts.backupDir) : null;
  if (!manifest) throw new ToolError('NO_MANIFEST', `no backup record: ${opts.backupDir ? path.join(opts.backupDir, MANIFEST_NAME) : path.join(opts.modsHome, 'backup')} not found`);
  const infos = await readLinks(manifest.entries.map((entry) => entry.path));
  const steps = manifest.entries.map((entry, i) => {
    if (entry.kind === 'retarget') {
      const backupFile = path.join(opts.backupDir, entry.backup);
      if (!fs.existsSync(backupFile)) throw new ToolError('BACKUP_MISSING', `${backupFile} not found`);
      if (sha(backupFile) !== entry.sha256) throw new ToolError('BACKUP_MISMATCH', `${backupFile} does not match the manifest`);
      return { ...entry, action: 'restore', backupFile };
    }
    const info = infos[i];
    if (!info.exists) return { ...entry, action: 'none' };
    const ours = entry.sha256 ? sha(entry.path) === entry.sha256 : isPureLink(info, opts.appDir);
    if (!ours) throw new ToolError('FOREIGN_SHORTCUT', `${entry.path} is not the file apply created; nothing removed`);
    return { ...entry, action: 'remove' };
  });
  if (opts.dryRun) return { command: 'restore', dryRun: true, steps: describe(steps) };
  for (const step of steps) {
    if (step.action === 'restore') {
      fs.copyFileSync(step.backupFile, step.path);
      if (sha(step.path) !== step.sha256) throw new ToolError('RESTORE_MISMATCH', `${step.path} does not match its backup after restore`);
    } else if (step.action === 'remove') {
      fs.rmSync(step.path, { force: true });
    }
  }
  fs.rmSync(path.join(opts.backupDir, MANIFEST_NAME), { force: true });
  return { command: 'restore', dryRun: false, steps: describe(steps), shortcuts: await statusOf(opts, lay) };
}

export async function runShortcuts(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  try {
    opts = withDefaults(opts);
    const lay = layout(opts);
    let result;
    if (opts.command === 'status') result = { command: 'status', shortcuts: await statusOf(opts, lay) };
    else if (opts.command === 'apply') result = await apply(opts, lay);
    else result = await restore(opts, lay);
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (err) {
    console.error(`${err.code ?? 'ERROR'}: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runShortcuts(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
