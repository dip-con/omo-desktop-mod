#!/usr/bin/env node
// OmO app-mods installer: copies loader/ and mods/ into a mods home and writes the hidden-console launch.vbs.
// By default it creates no shortcuts. --with-icons also retargets the three real OmO.lnk icons (tools/shortcuts.mjs
// apply, backed up first). It never touches the app directory or the terminal home.
//
//   node tools/install.mjs [--with-icons] [--mods-home <dir>] [--source-root <dir>] [--real-home <dir>] [--app-exe <file>] [--dry-run]
//   node tools/install.mjs --uninstall [--mods-home <dir>] [--real-home <dir>] [--dry-run]
//
// - Everything is planned and checked before the first write. A file that already exists but is not listed in
//   <mods-home>/_loader/install-manifest.json is never overwritten: exit 1, nothing written.
// - Reinstall keeps a user-changed mod.json `enabled`. Files from the previous install that the new one no longer
//   needs are removed, including the 'OmO (모드).lnk' shortcut an older install recorded.
// - --uninstall removes exactly the manifest's files, then the manifest itself. It refuses (ICONS_STILL_RETARGETED)
//   while any real OmO.lnk still launches the mod launcher.
// - --source-root (default: the repo this script lives in) lets tests and dry-runs use a fixture tree.
// - --real-home (default: the account's profile folder) is where the three real OmO.lnk icons are looked up.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, readLinks } from '../mods/modmgr/host/lnk.mjs';
import { BOX_TITLE, PLAIN_START_TEXT } from '../loader/messages.mjs';
import { newestBackup, runShortcuts } from './shortcuts.mjs';

const DEFAULT_SOURCE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The account's own profile folder. USERPROFILE is not used: the agent environment redirects it.
const REAL_HOME = os.userInfo().homedir;
const DEFAULT_MODS_HOME = path.join(REAL_HOME, '.omo', 'app-mods');
const APP_EXE = path.join(REAL_HOME, 'AppData', 'Local', 'Programs', 'omo', 'OmO.exe');
const MANIFEST_NAME = 'install-manifest.json';
const USAGE = `usage: node tools/install.mjs [--mod <dir>]... [--with-icons] [--mods-home <dir>] [--source-root <dir>] [--real-home <dir>] [--app-exe <file>] [--dry-run] | --uninstall
  --mod            install an external mod directory (repeatable)
  --mods-home      default ${DEFAULT_MODS_HOME}
  --source-root    default ${DEFAULT_SOURCE_ROOT}
  --real-home      folder that holds the three real OmO.lnk icons, default ${REAL_HOME}
  --app-exe        OmO.exe that launch.vbs starts when the mod helper cannot, default ${APP_EXE}
  --with-icons     also retarget the three real OmO.lnk to the mod launcher (backup in <mods-home>/backup/<time>)
  --dry-run        print what would be written; write nothing
  --uninstall      restore the icons from the newest backup record, then remove the files listed in the manifest
                   (refused, nothing removed, when an icon is retargeted and no backup record exists)`;

function parseArgs(argv) {
  const opts = {
    modsHome: DEFAULT_MODS_HOME,
    sourceRoot: DEFAULT_SOURCE_ROOT,
    realHome: REAL_HOME,
    appExe: APP_EXE,
    dryRun: false,
    uninstall: false,
    withIcons: false,
    externalMods: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    if (arg === '--mods-home') opts.modsHome = path.resolve(value());
    else if (arg === '--source-root') opts.sourceRoot = path.resolve(value());
    else if (arg === '--real-home') opts.realHome = path.resolve(value());
    else if (arg === '--app-exe') opts.appExe = path.resolve(value());
    else if (arg === '--mod') opts.externalMods.push(path.resolve(value()));
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--uninstall') opts.uninstall = true;
    else if (arg === '--with-icons') opts.withIcons = true;
    else if (arg === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

// Relative file paths under root, skipping dot-files such as .gitkeep.
function listFiles(root, rel = '') {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.')) return [];
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) return listFiles(root, child);
    return entry.isFile() ? [child] : [];
  });
}

function readSources(sourceRoot, externalMods) {
  const loaderRoot = path.join(sourceRoot, 'loader');
  if (!fs.existsSync(path.join(loaderRoot, 'launch.mjs'))) throw new Error(`loader/launch.mjs not found under ${sourceRoot}`);
  const factsFile = path.join(sourceRoot, 'docs', 'app-facts.json');
  if (!fs.existsSync(factsFile)) throw new Error('docs/app-facts.json not found; nothing installed');
  const modsRoot = path.join(sourceRoot, 'mods');
  const mods = (fs.existsSync(modsRoot) ? fs.readdirSync(modsRoot, { withFileTypes: true }) : []).flatMap((entry) => {
    const dir = path.join(modsRoot, entry.name);
    if (!entry.isDirectory() || !fs.existsSync(path.join(dir, 'mod.json'))) return [];
    const mod = JSON.parse(fs.readFileSync(path.join(dir, 'mod.json'), 'utf8'));
    if (!Array.isArray(mod.anchors) || mod.anchors.length === 0) {
      throw new Error(`mod ${entry.name}: mod.json has no anchors; nothing installed`);
    }
    return [{ id: entry.name, dir, files: listFiles(dir) }];
  });
  for (const dir of externalMods) {
    const manifest = path.join(dir, 'mod.json');
    if (!fs.existsSync(manifest)) throw new Error(`mod.json not found in ${dir}`);
    const mod = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const id = mod?.id;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(id)) {
      throw new Error(`unsafe mod id: ${id}`);
    }
    if (!Array.isArray(mod.anchors) || mod.anchors.length === 0) {
      throw new Error(`mod ${id}: mod.json has no anchors; nothing installed`);
    }
    if (mods.some((m) => m.id.toLowerCase() === id.toLowerCase())) throw new Error(`duplicate mod id: ${id}`);
    mods.push({ id, dir, files: listFiles(dir), external: true });
  }
  return { loaderRoot, factsFile, mods };
}

function repoCommit(sourceRoot) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: sourceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null; // not a git checkout (a fixture tree)
  }
}

// A VBScript string literal. Characters outside printable ASCII and the double quote become ChrW codes, so the file
// reads the same under any code page wscript uses.
function vbsString(text) {
  return text.split(/([^\x20-\x7e]|")/u).filter((s) => s !== '')
    .map((s) => (/^([^\x20-\x7e]|")$/u.test(s) ? `ChrW(${s.codePointAt(0)})` : `"${s}"`)).join(' & ');
}

// launch.vbs: runs node on boot.mjs hidden. When node or boot.mjs is missing or node cannot start, starts OmO plain once.
function launchVbs({ node, boot, app }) {
  const lines = [
    "' Written by tools/install.mjs. Starts OmO through the mod helper; if the helper cannot start, starts OmO plain once.",
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `node = ${vbsString(node)}`,
    `boot = ${vbsString(boot)}`,
    `app = ${vbsString(app)}`,
    'flags = ""',
    'For Each arg In WScript.Arguments',
    '  If arg = "--safe" Then flags = flags & " --safe"',
    'Next',
    'If fso.FileExists(node) And fso.FileExists(boot) Then',
    '  On Error Resume Next',
    '  sh.Run """" & node & """ """ & boot & """ """ & app & """" & flags, 0, False',
    '  started = (Err.Number = 0)',
    '  On Error GoTo 0',
    '  If started Then WScript.Quit 0',
    'End If',
    'sh.Environment("PROCESS")("OMO_DESKTOP_REMOTE_DEBUGGING_PORT") = ""',
    'sh.Run """" & app & """", 1, False',
    'If sh.Environment("PROCESS")("OMO_LAUNCH_NO_BOX") = "" Then',
    `  sh.Environment("PROCESS")("LOADER_MESSAGE_TEXT") = ${vbsString(PLAIN_START_TEXT)}`,
    `  sh.Environment("PROCESS")("LOADER_MESSAGE_TITLE") = ${vbsString(BOX_TITLE)}`,
    '  sh.Run "powershell.exe -NoProfile -Command ""Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:LOADER_MESSAGE_TEXT, $env:LOADER_MESSAGE_TITLE) | Out-Null""", 0, False',
    'End If',
    'WScript.Quit 20',
  ];
  return `${lines.join('\r\n')}\r\n`;
}

// A reinstall keeps the enabled flag the user set in the installed mod.json.
function modFileData(modsHome, id, rel, buf) {
  if (rel !== 'mod.json') return buf;
  const installed = path.join(modsHome, id, 'mod.json');
  if (!fs.existsSync(installed)) return buf;
  const { enabled } = JSON.parse(fs.readFileSync(installed, 'utf8'));
  const mod = JSON.parse(buf.toString('utf8'));
  if (typeof enabled === 'boolean') mod.enabled = enabled;
  return `${JSON.stringify(mod, null, 2)}\n`;
}

function planFiles(modsHome, src, meta) {
  const loaderDir = path.join(modsHome, '_loader');
  return [
    ...listFiles(src.loaderRoot).map((rel) => ({
      rel: path.join('_loader', rel), data: fs.readFileSync(path.join(src.loaderRoot, rel)),
    })),
    { rel: path.join('_loader', 'app-facts.json'), data: fs.readFileSync(src.factsFile) },
    {
      rel: path.join('_loader', 'config.json'),
      data: `${JSON.stringify({ node: process.execPath, appExe: meta.appExe, installedAt: meta.installedAt, repoCommit: meta.repoCommit }, null, 2)}\n`,
    },
    {
      rel: path.join('_loader', 'launch.vbs'),
      data: launchVbs({ node: process.execPath, boot: path.join(loaderDir, 'boot.mjs'), app: meta.appExe }),
    },
    ...src.mods.flatMap((mod) => mod.files.map((rel) => ({
      rel: path.join(mod.id, rel),
      data: modFileData(modsHome, mod.id, rel, fs.readFileSync(path.join(mod.dir, rel))),
    }))),
  ];
}

function manifestPath(modsHome) {
  return path.join(modsHome, '_loader', MANIFEST_NAME);
}

function readManifest(modsHome) {
  const file = manifestPath(modsHome);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function managedPaths(modsHome, manifest) {
  return [...manifest.files.map((rel) => path.join(modsHome, rel)), ...manifest.shortcuts];
}

// The folders of the three icons a user pins or double-clicks, under the account's profile folder (the REAL_HOME rule).
function realIconDirs(realHome) {
  return {
    desktop: path.join(realHome, 'Desktop'),
    startMenu: path.join(realHome, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    taskbar: path.join(realHome, 'AppData', 'Roaming', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
  };
}

function realIconPaths(realHome) {
  const dirs = realIconDirs(realHome);
  return [dirs.desktop, dirs.startMenu, dirs.taskbar].map((dir) => path.join(dir, 'OmO.lnk'));
}

// The flags tools/shortcuts.mjs needs for the real icons, this mod home and the app folder of opts.appExe.
function iconFlags(opts) {
  const dirs = realIconDirs(opts.realHome);
  return ['--desktop-dir', dirs.desktop, '--start-menu-dir', dirs.startMenu, '--taskbar-dir', dirs.taskbar,
    '--mods-home', opts.modsHome, '--app-dir', path.dirname(opts.appExe)];
}

async function install(opts) {
  const { modsHome, sourceRoot, appExe, dryRun } = opts;
  const src = readSources(sourceRoot, opts.externalMods);
  const prev = readManifest(modsHome);
  for (const mod of src.mods.filter((m) => m.external)) {
    const dest = path.join(modsHome, mod.id);
    const prefix = `${mod.id}${path.sep}`;
    if (fs.existsSync(dest) && !prev?.files.some((rel) => rel.startsWith(prefix))) {
      throw new Error(`not created by this installer, refusing to overwrite folder: ${dest}`);
    }
  }
  const meta = { installedAt: new Date().toISOString(), repoCommit: repoCommit(sourceRoot), appExe };
  const files = planFiles(modsHome, src, meta);
  const managed = new Set(prev ? managedPaths(modsHome, prev) : []);
  const wantedFiles = files.map((f) => path.join(modsHome, f.rel));
  const foreign = wantedFiles.filter((p) => fs.existsSync(p) && !managed.has(p));
  if (foreign.length > 0) {
    throw new Error(`not created by this installer, refusing to overwrite:\n  ${foreign.join('\n  ')}`);
  }

  if (dryRun) {
    console.log(`dry-run: would write under ${modsHome}`);
    for (const p of wantedFiles) console.log(`  file ${p}`);
    console.log(`  file ${manifestPath(modsHome)}`);
    if (opts.withIcons) console.log('dry-run: then tools/shortcuts.mjs apply retargets the three real OmO.lnk (backup in <mods-home>/backup/<time>)');
    console.log('dry-run: nothing written');
    return;
  }

  for (const f of files) {
    const abs = path.join(modsHome, f.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.data);
  }
  const stale = prev ? managedPaths(modsHome, prev).filter((p) => !wantedFiles.includes(p)) : [];
  for (const p of stale) fs.rmSync(p, { force: true });
  fs.writeFileSync(manifestPath(modsHome), `${JSON.stringify({
    version: 1,
    installedAt: meta.installedAt,
    repoCommit: meta.repoCommit,
    files: files.map((f) => f.rel),
    shortcuts: [],
  }, null, 2)}\n`);
  console.log(`installed ${files.length} files into ${modsHome}`);
  if (opts.withIcons) {
    const code = await runShortcuts(['apply', ...iconFlags(opts)]);
    if (code !== 0) throw new Error(`mods installed, but the icons were not retargeted (shortcuts apply exit ${code})`);
  }
}

async function uninstall(opts) {
  const { modsHome, realHome, dryRun } = opts;
  const infos = await readLinks(realIconPaths(realHome));
  const retargeted = infos.filter((info) => classify(info, path.dirname(APP_EXE)) === 'mod').map((info) => info.path);
  if (retargeted.length > 0) {
    // The icons go back first, from the newest backup record. Nothing else is removed unless they are back.
    const backup = newestBackup(modsHome);
    if (!backup) {
      throw new Error(`ICONS_STILL_RETARGETED: ${retargeted.join(', ')} still launch the mod launcher and ${path.join(modsHome, 'backup')} holds no backup record; `
        + 'restore them by hand (see ROLLBACK.md). Nothing removed.');
    }
    const code = await runShortcuts(['restore', ...iconFlags(opts), '--backup-dir', backup, ...(dryRun ? ['--dry-run'] : [])]);
    if (code !== 0) throw new Error(`icons not restored (shortcuts restore exit ${code}); nothing removed`);
  }
  const prev = readManifest(modsHome);
  if (!prev) {
    console.log(`nothing to uninstall: ${manifestPath(modsHome)} not present`);
    return;
  }
  const targets = [...managedPaths(modsHome, prev), manifestPath(modsHome)];
  if (dryRun) {
    for (const p of targets) console.log(`would remove ${p}`);
    return;
  }
  for (const p of targets) fs.rmSync(p, { force: true });
  const dirs = new Set();
  for (const rel of prev.files) {
    for (let d = path.dirname(path.join(modsHome, rel)); d.length > modsHome.length; d = path.dirname(d)) dirs.add(d);
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    if (fs.existsSync(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
  }
  console.log(`removed ${targets.length} managed paths from ${modsHome}`);
}

async function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) console.log(USAGE);
    else if (opts.withIcons && opts.uninstall) throw new Error('--with-icons and --uninstall cannot be used together');
    else if (opts.uninstall) await uninstall(opts);
    else await install(opts);
  } catch (err) {
    console.error(`omo-app-mods install: ${err.message}`);
    process.exitCode = 1;
  }
}

await main();
