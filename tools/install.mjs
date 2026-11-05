#!/usr/bin/env node
// OmO app-mods installer (macOS): copies loader/ and the mods into a mods home and writes the "OmO Mods.app" launcher.
// It never writes into the OmO app bundle and never starts or stops OmO.
//
//   node tools/install.mjs [--mods-home <dir>] [--apps-dir <dir>] [--app <bundle>] [--mod <dir>]... [--dry-run] [--no-launcher]
//   node tools/install.mjs --uninstall [--mods-home <dir>] [--dry-run]
//
// - Everything is planned and checked before the first write. A file that already exists but is not listed in
//   <mods-home>/_loader/install-manifest.json is never overwritten: exit 1, nothing written.
// - Reinstall keeps a user-changed mod.json `enabled`. Files (and a launcher) from the previous install that the new
//   one no longer plans are removed.
// - --uninstall removes exactly the manifest's files and launcher, then the manifest itself. User data stays.
// - --source-root (default: the repo this script lives in) lets tests use a fixture tree.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAUNCHER_NAME, isOurLauncher, writeLauncher } from './macapp.mjs';

const DEFAULT_SOURCE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOME = os.userInfo().homedir;
const DEFAULT_MODS_HOME = path.join(HOME, '.omo', 'app-mods');
const DEFAULT_APPS_DIR = path.join(HOME, 'Applications');
const DEFAULT_APP = '/Applications/OmO.app';
const MANIFEST_NAME = 'install-manifest.json';
const SKIPPED = new Set(['node_modules', 'tests', 'test']);
const USAGE = `usage: node tools/install.mjs [--mods-home <dir>] [--apps-dir <dir>] [--app <bundle>] [--mod <dir>]... [--dry-run] [--no-launcher] | --uninstall
  --mods-home      default ${DEFAULT_MODS_HOME}
  --apps-dir       folder for "${LAUNCHER_NAME}", default ${DEFAULT_APPS_DIR}
  --app            OmO app bundle the launcher starts, default ${DEFAULT_APP}
  --mod            install an external mod folder (repeatable; folder name = mod id)
  --source-root    default ${DEFAULT_SOURCE_ROOT}
  --no-launcher    do not write "${LAUNCHER_NAME}"
  --dry-run        print what would be written; write nothing
  --uninstall      remove the files and launcher listed in the manifest`;

function parseArgs(argv) {
  const opts = {
    modsHome: DEFAULT_MODS_HOME, appsDir: DEFAULT_APPS_DIR, app: DEFAULT_APP, sourceRoot: DEFAULT_SOURCE_ROOT,
    externalMods: [], dryRun: false, uninstall: false, launcher: true, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return path.resolve(v);
    };
    if (arg === '--mods-home') opts.modsHome = value();
    else if (arg === '--apps-dir') opts.appsDir = value();
    else if (arg === '--app') opts.app = value();
    else if (arg === '--source-root') opts.sourceRoot = value();
    else if (arg === '--mod') opts.externalMods.push(value());
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--uninstall') opts.uninstall = true;
    else if (arg === '--no-launcher') opts.launcher = false;
    else if (arg === '--help') opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

// Relative file paths under root, skipping dot-files (.git, .gitkeep) and dependency/test folders.
function listFiles(root, rel = '') {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || SKIPPED.has(entry.name)) return [];
    const child = path.join(rel, entry.name);
    if (entry.isDirectory()) return listFiles(root, child);
    return entry.isFile() ? [child] : [];
  });
}

const isStringArray = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string');

function readMod(dir) {
  const file = path.join(dir, 'mod.json');
  if (!fs.existsSync(file)) throw new Error(`mod.json not found in ${dir}`);
  const mod = JSON.parse(fs.readFileSync(file, 'utf8'));
  const id = path.basename(dir);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id) || id === '_loader') throw new Error(`unsafe mod id: ${id}`);
  if (mod.id !== undefined && mod.id !== id) throw new Error(`unsafe mod id: mod.json id ${mod.id} differs from folder name ${id}`);
  if (!Array.isArray(mod.anchors) || mod.anchors.length === 0) throw new Error(`mod ${id}: mod.json has no anchors; nothing installed`);
  if (mod.testedBuilds !== undefined && !isStringArray(mod.testedBuilds)) throw new Error(`mod ${id}: testedBuilds must be a string array`);
  if (mod.update !== undefined && (typeof mod.update?.repo !== 'string' || typeof mod.update?.subdir !== 'string')) {
    throw new Error(`mod ${id}: update must be {"repo": string, "subdir": string}`);
  }
  return { id, dir, files: listFiles(dir) };
}

function readSources(sourceRoot, externalMods) {
  const loaderRoot = path.join(sourceRoot, 'loader');
  if (!fs.existsSync(path.join(loaderRoot, 'boot.mjs'))) throw new Error(`loader/boot.mjs not found under ${sourceRoot}`);
  const factsFile = path.join(sourceRoot, 'docs', 'app-facts.json');
  if (!fs.existsSync(factsFile)) throw new Error('docs/app-facts.json not found; nothing installed');
  const modsRoot = path.join(sourceRoot, 'mods');
  const mods = (fs.existsSync(modsRoot) ? fs.readdirSync(modsRoot, { withFileTypes: true }) : [])
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(modsRoot, e.name, 'mod.json')))
    .map((e) => readMod(path.join(modsRoot, e.name)));
  for (const dir of externalMods) {
    const mod = { ...readMod(dir), external: true };
    if (mods.some((m) => m.id.toLowerCase() === mod.id.toLowerCase())) throw new Error(`duplicate mod id: ${mod.id}`);
    mods.push(mod);
  }
  return { loaderRoot, factsFile, mods };
}

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null; // not a git work tree, or no such remote
  }
}

// Where a unit was installed from, for loader/update.mjs.
function detectSource(dir) {
  const repoRoot = git(dir, ['rev-parse', '--show-toplevel']);
  if (!repoRoot) return { repoRoot: null, subdir: null, remote: null, commit: null };
  const firstRemote = git(repoRoot, ['remote'])?.split('\n')[0];
  const remote = git(repoRoot, ['remote', 'get-url', 'origin']) ?? (firstRemote ? git(repoRoot, ['remote', 'get-url', firstRemote]) : null);
  const subdir = path.relative(fs.realpathSync(repoRoot), fs.realpathSync(dir)).split(path.sep).join('/');
  return { repoRoot, subdir, remote, commit: git(repoRoot, ['rev-parse', 'HEAD']) };
}

// A reinstall keeps the enabled flag the user set in the installed mod.json.
function modFileData(modsHome, id, rel, buf) {
  const installed = path.join(modsHome, id, 'mod.json');
  if (rel !== 'mod.json' || !fs.existsSync(installed)) return buf;
  const { enabled } = JSON.parse(fs.readFileSync(installed, 'utf8'));
  const mod = JSON.parse(buf.toString('utf8'));
  if (typeof enabled === 'boolean') mod.enabled = enabled;
  return `${JSON.stringify(mod, null, 2)}\n`;
}

function planFiles(modsHome, src, config) {
  return [
    ...listFiles(src.loaderRoot).map((rel) => ({ rel: path.join('_loader', rel), data: fs.readFileSync(path.join(src.loaderRoot, rel)) })),
    { rel: path.join('_loader', 'app-facts.json'), data: fs.readFileSync(src.factsFile) },
    { rel: path.join('_loader', 'config.json'), data: `${JSON.stringify(config, null, 2)}\n` },
    ...src.mods.flatMap((mod) => mod.files.map((rel) => ({
      rel: path.join(mod.id, rel), data: modFileData(modsHome, mod.id, rel, fs.readFileSync(path.join(mod.dir, rel))),
    }))),
  ];
}

const manifestPath = (modsHome) => path.join(modsHome, '_loader', MANIFEST_NAME);

function readManifest(modsHome) {
  const file = manifestPath(modsHome);
  if (!fs.existsSync(file)) return null;
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { files: (m.files ?? []).map((f) => (typeof f === 'string' ? f : f.path)), launcher: m.launcher ?? null };
}

// Removes now-empty folders left by removed files, deepest first, never modsHome itself.
function pruneDirs(modsHome, rels) {
  const dirs = new Set();
  for (const rel of rels) {
    for (let d = path.dirname(path.join(modsHome, rel)); d.length > modsHome.length; d = path.dirname(d)) dirs.add(d);
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    if (fs.existsSync(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
  }
}

function install(opts) {
  const { modsHome, dryRun } = opts;
  const src = readSources(opts.sourceRoot, opts.externalMods);
  const prev = readManifest(modsHome);
  for (const mod of src.mods.filter((m) => m.external)) {
    const dest = path.join(modsHome, mod.id);
    if (fs.existsSync(dest) && !prev?.files.some((rel) => rel.startsWith(`${mod.id}${path.sep}`))) {
      throw new Error(`not created by this installer, refusing to overwrite folder: ${dest}`);
    }
  }
  const launcher = opts.launcher ? path.join(opts.appsDir, LAUNCHER_NAME) : null;
  if (launcher && fs.existsSync(launcher) && prev?.launcher !== launcher && !isOurLauncher(launcher)) {
    throw new Error(`not created by this installer, refusing to overwrite: ${launcher}`);
  }
  const sources = Object.fromEntries([
    ['_loader', detectSource(src.loaderRoot)],
    ...src.mods.map((mod) => [mod.id, detectSource(mod.dir)]),
  ]);
  const installedAt = new Date().toISOString();
  const config = { node: process.execPath, appBundle: opts.app, installedAt, repoCommit: sources._loader.commit };
  const files = planFiles(modsHome, src, config);
  const managed = new Set((prev?.files ?? []).map((rel) => path.join(modsHome, rel)));
  const wanted = files.map((f) => path.join(modsHome, f.rel));
  const foreign = wanted.filter((p) => fs.existsSync(p) && !managed.has(p));
  if (foreign.length > 0) throw new Error(`not created by this installer, refusing to overwrite:\n  ${foreign.join('\n  ')}`);
  if (!fs.existsSync(path.join(opts.app, 'Contents', 'MacOS', 'OmO'))) console.warn(`warning: ${opts.app}/Contents/MacOS/OmO not found`);

  if (dryRun) {
    console.log(`dry-run: would write under ${modsHome}`);
    for (const p of [...wanted, manifestPath(modsHome)]) console.log(`  file ${p}`);
    if (launcher) console.log(`  launcher ${launcher}`);
    console.log('dry-run: nothing written');
    return;
  }

  for (const f of files) {
    const abs = path.join(modsHome, f.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.data);
  }
  const staleRels = (prev?.files ?? []).filter((rel) => !wanted.includes(path.join(modsHome, rel)));
  for (const rel of staleRels) fs.rmSync(path.join(modsHome, rel), { force: true });
  pruneDirs(modsHome, staleRels);
  if (prev?.launcher && prev.launcher !== launcher && isOurLauncher(prev.launcher)) fs.rmSync(prev.launcher, { recursive: true, force: true });
  if (launcher) {
    fs.mkdirSync(opts.appsDir, { recursive: true });
    for (const w of writeLauncher({ app: launcher, node: process.execPath, modsHome, appBundle: opts.app })) console.warn(`warning: ${w}`);
  }
  const sha256 = Object.fromEntries(files.map((f) => [f.rel, crypto.createHash('sha256').update(f.data).digest('hex')]));
  fs.writeFileSync(manifestPath(modsHome), `${JSON.stringify({
    version: 2, installedAt, repoCommit: config.repoCommit, files: files.map((f) => f.rel), sha256, launcher, sources,
  }, null, 2)}\n`);
  console.log(`installed ${files.length} files into ${modsHome}${launcher ? ` and ${launcher}` : ''}`);
}

function uninstall({ modsHome, dryRun }) {
  const prev = readManifest(modsHome);
  if (!prev) {
    console.log(`nothing to uninstall: ${manifestPath(modsHome)} not present`);
    return;
  }
  const targets = [...prev.files.map((rel) => path.join(modsHome, rel)), manifestPath(modsHome)];
  const launcher = prev.launcher && isOurLauncher(prev.launcher) ? prev.launcher : null;
  if (dryRun) {
    for (const p of [...targets, ...(launcher ? [launcher] : [])]) console.log(`would remove ${p}`);
    return;
  }
  for (const p of targets) fs.rmSync(p, { force: true });
  if (launcher) fs.rmSync(launcher, { recursive: true, force: true });
  pruneDirs(modsHome, [...prev.files, path.join('_loader', MANIFEST_NAME)]);
  console.log(`removed ${targets.length} managed files from ${modsHome}${launcher ? ` and ${launcher}` : ''}`);
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) console.log(USAGE);
    else if (opts.uninstall) uninstall(opts);
    else install(opts);
  } catch (err) {
    console.error(`omo-app-mods install: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
