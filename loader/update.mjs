// Update check and apply for installed loader and mods. Each installed folder (<mods-home>/<id>) is compared with the
// folder it was installed from (install-manifest.json "sources"), by a sha256 over relative paths and contents.
// apply copies the source into a staging folder and swaps it in; the installed mod.json keeps its "enabled" value and
// _loader keeps its own files (config, manifest, backups, logs). Every git and fs effect goes through `io`.
// CLI: node update.mjs [--check] [--pull] [--mod <id>]... [--mods-home <dir>]  -> JSON on stdout, exit 1 on any error.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST = 'install-manifest.json';
const SKIPPED_NAMES = new Set(['node_modules', 'tests']);
// Top-level entries of _loader that belong to the install, not to the loader source.
const LOADER_KEEP = new Set(['config.json', MANIFEST, 'backups', 'logs', 'app-facts.json', 'launch.vbs']);
const STAGING = '.update-staging';

const git = (repoRoot, args) => {
  const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? r.error?.message ?? '').trim() };
};
export const defaultIo = { fs, git };

const keptBy = (id) => (rel) => id === '_loader' && LOADER_KEEP.has(rel.split('/')[0]);

// Relative paths ('/' separated, sorted) under root: dot names (.git), node_modules and tests are not part of a mod.
function listFiles(io, root, isKept, rel = '') {
  return io.fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.name.startsWith('.') || SKIPPED_NAMES.has(entry.name) || isKept(child)) return [];
    if (entry.isDirectory()) return listFiles(io, root, isKept, child);
    return entry.isFile() ? [child] : [];
  }).sort();
}

// mod.json is compared without "enabled": the user's switch is not an update.
function hashedBytes(rel, bytes) {
  if (rel !== 'mod.json') return bytes;
  try {
    const { enabled, ...rest } = JSON.parse(bytes.toString('utf8'));
    return Buffer.from(JSON.stringify(rest));
  } catch {
    return bytes;
  }
}

export function folderHash(io, root, id) {
  const hash = createHash('sha256');
  for (const rel of listFiles(io, root, keptBy(id))) {
    hash.update(`${rel}\0`).update(hashedBytes(rel, io.fs.readFileSync(path.join(root, rel)))).update('\0');
  }
  return hash.digest('hex');
}

const manifestFile = (modsHome) => path.join(modsHome, '_loader', MANIFEST);
function readManifest(io, modsHome) {
  return JSON.parse(io.fs.readFileSync(manifestFile(modsHome), 'utf8'));
}

// The source of one id: the manifest entry, else the installed mod.json "update" field when it names a local folder.
function sourceOf(io, modsHome, manifest, id) {
  const entry = manifest.sources?.[id];
  if (entry?.repoRoot) return { repoRoot: entry.repoRoot, subdir: entry.subdir ?? '', remote: entry.remote ?? null, commit: entry.commit ?? null };
  try {
    const update = JSON.parse(io.fs.readFileSync(path.join(modsHome, id, 'mod.json'), 'utf8')).update;
    if (typeof update?.repo === 'string' && path.isAbsolute(update.repo)) {
      return { repoRoot: update.repo, subdir: typeof update.subdir === 'string' ? update.subdir : '', remote: null, commit: null };
    }
  } catch {
    // no installed mod.json: the id has no source
  }
  return null;
}

const idsOf = (manifest, ids) => (ids?.length ? [...ids] : Object.keys(manifest.sources ?? {}));

function checkOne(io, modsHome, manifest, id) {
  const source = sourceOf(io, modsHome, manifest, id);
  const item = { id, source, installedHash: null, sourceHash: null, changed: false, error: null };
  if (!source) return { ...item, error: `NO_SOURCE: no install source recorded for ${id}` };
  const dir = path.join(source.repoRoot, source.subdir);
  if (!io.fs.existsSync(dir)) return { ...item, error: `SOURCE_MISSING: ${dir} not found` };
  try {
    const sourceHash = folderHash(io, dir, id);
    const installed = path.join(modsHome, id);
    const installedHash = io.fs.existsSync(installed) ? folderHash(io, installed, id) : null;
    return { ...item, installedHash, sourceHash, changed: installedHash !== sourceHash };
  } catch (error) {
    return { ...item, error: `READ_FAILED: ${error.message}` };
  }
}

export function checkUpdates({ modsHome, manifest, ids, io = defaultIo } = {}) {
  let m = manifest;
  try {
    m ??= readManifest(io, modsHome);
  } catch (error) {
    return { ok: false, code: 'NO_MANIFEST', message: `${manifestFile(modsHome)}: ${error.message}` };
  }
  return { ok: true, items: idsOf(m, ids).map((id) => checkOne(io, modsHome, m, id)) };
}

// git pull --ff-only, only on a clean work tree with an upstream. Returns null or an error message.
function pullRepo(io, repoRoot) {
  const status = io.git(repoRoot, ['status', '--porcelain']);
  if (!status.ok) return `git status failed: ${status.stderr}`;
  if (status.stdout !== '') return null;
  if (!io.git(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).ok) return null;
  const pulled = io.git(repoRoot, ['pull', '--ff-only']);
  return pulled.ok ? null : `git pull --ff-only failed: ${pulled.stderr}`;
}

// The installed mod.json "enabled" value, written into the new mod.json the way tools/install.mjs does.
function keepEnabled(io, installedDir, stagedDir) {
  const staged = path.join(stagedDir, 'mod.json');
  const installed = path.join(installedDir, 'mod.json');
  if (!io.fs.existsSync(staged) || !io.fs.existsSync(installed)) return;
  const { enabled } = JSON.parse(io.fs.readFileSync(installed, 'utf8'));
  if (typeof enabled !== 'boolean') return;
  const mod = JSON.parse(io.fs.readFileSync(staged, 'utf8'));
  mod.enabled = enabled;
  io.fs.writeFileSync(staged, `${JSON.stringify(mod, null, 2)}\n`);
}

// Builds <mods-home>/.update-staging/<id>-<rand> and swaps it into <mods-home>/<id>; the old folder is put back when
// the swap fails. Returns the installed relative file list (for the manifest).
function swapIn(io, modsHome, id, sourceDir) {
  const tag = randomBytes(6).toString('hex');
  const stagingRoot = path.join(modsHome, STAGING);
  const staged = path.join(stagingRoot, `${id}-${tag}`);
  const old = path.join(stagingRoot, `${id}-old-${tag}`);
  const target = path.join(modsHome, id);
  io.fs.mkdirSync(staged, { recursive: true });
  try {
    const files = listFiles(io, sourceDir, keptBy(id));
    for (const rel of files) {
      io.fs.mkdirSync(path.dirname(path.join(staged, rel)), { recursive: true });
      io.fs.copyFileSync(path.join(sourceDir, rel), path.join(staged, rel));
    }
    const exists = io.fs.existsSync(target);
    if (exists && id === '_loader') {
      for (const name of LOADER_KEEP) {
        if (io.fs.existsSync(path.join(target, name))) io.fs.cpSync(path.join(target, name), path.join(staged, name), { recursive: true });
      }
    }
    if (exists) keepEnabled(io, target, staged);
    if (exists) io.fs.renameSync(target, old);
    try {
      io.fs.renameSync(staged, target);
    } catch (error) {
      if (exists) io.fs.renameSync(old, target);
      throw error;
    }
    if (exists) io.fs.rmSync(old, { recursive: true, force: true });
    return files;
  } finally {
    io.fs.rmSync(staged, { recursive: true, force: true });
    if (io.fs.existsSync(stagingRoot) && io.fs.readdirSync(stagingRoot).length === 0) io.fs.rmdirSync(stagingRoot);
  }
}

function writeManifest(io, modsHome, manifest) {
  const file = manifestFile(modsHome);
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  io.fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  io.fs.renameSync(temporary, file);
}

// The manifest after one applied id: its commit and its file list (uninstall removes exactly the listed files).
function recordApplied(manifest, { id, source, commit, files }) {
  const prefix = `${id}/`;
  const ownFile = (rel) => rel.replace(/\\/g, '/').startsWith(prefix) && !keptBy(id)(rel.replace(/\\/g, '/').slice(prefix.length));
  return {
    ...manifest,
    ...(Array.isArray(manifest.files) ? { files: [...manifest.files.filter((rel) => !ownFile(rel)), ...files.map((rel) => `${prefix}${rel}`)] } : {}),
    sources: { ...manifest.sources, [id]: { ...(manifest.sources?.[id] ?? { repoRoot: source.repoRoot, subdir: source.subdir, remote: source.remote }), commit } },
  };
}

export function applyUpdates({ modsHome, ids, pull = false, io = defaultIo } = {}) {
  let manifest;
  try {
    manifest = readManifest(io, modsHome);
  } catch (error) {
    return { ok: false, code: 'NO_MANIFEST', message: `${manifestFile(modsHome)}: ${error.message}` };
  }
  const result = { ok: true, applied: [], skipped: [], errors: [] };
  const targets = idsOf(manifest, ids);
  if (pull) {
    const repos = new Map();
    for (const id of targets) {
      const repoRoot = sourceOf(io, modsHome, manifest, id)?.repoRoot;
      if (repoRoot && io.fs.existsSync(repoRoot) && !repos.has(repoRoot)) repos.set(repoRoot, pullRepo(io, repoRoot));
      const failure = repoRoot ? repos.get(repoRoot) : null;
      if (failure) result.errors.push({ id, message: failure });
    }
  }
  for (const id of targets) {
    const item = checkOne(io, modsHome, manifest, id);
    if (item.error) {
      result.errors.push({ id, message: item.error });
      continue;
    }
    if (!item.changed) {
      result.skipped.push({ id, reason: 'UNCHANGED' });
      continue;
    }
    try {
      const files = swapIn(io, modsHome, id, path.join(item.source.repoRoot, item.source.subdir));
      const head = io.git(item.source.repoRoot, ['rev-parse', 'HEAD']);
      manifest = recordApplied(manifest, { id, source: item.source, commit: head.ok ? head.stdout : null, files });
      writeManifest(io, modsHome, manifest);
      result.applied.push(id);
    } catch (error) {
      result.errors.push({ id, message: `APPLY_FAILED: ${error.message}` });
    }
  }
  return result;
}

// The folder holding this file is _loader when installed: its parent is the mods home.
export function defaultModsHome(file = fileURLToPath(import.meta.url)) {
  const dir = path.dirname(file);
  return path.basename(dir) === '_loader' ? path.dirname(dir) : path.join(os.homedir(), '.omo', 'app-mods');
}

export function parseArgs(argv) {
  const opts = { check: false, pull: false, ids: [], modsHome: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--check') opts.check = true;
    else if (arg === '--pull') opts.pull = true;
    else if (arg === '--mod') opts.ids.push(value());
    else if (arg === '--mods-home') opts.modsHome = path.resolve(value());
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

// Prints the JSON answer and returns the exit code.
export function main(argv, { modsHome: fallbackHome = defaultModsHome(), io = defaultIo, out = console.log } = {}) {
  let answer;
  try {
    const opts = parseArgs(argv);
    const modsHome = opts.modsHome ?? fallbackHome;
    const ids = opts.ids.length ? opts.ids : undefined;
    answer = opts.check ? checkUpdates({ modsHome, ids, io }) : applyUpdates({ modsHome, ids, pull: opts.pull, io });
  } catch (error) {
    answer = { ok: false, code: 'BAD_ARGS', message: error.message };
  }
  out(JSON.stringify(answer, null, 2));
  const failed = !answer.ok || (answer.items ?? []).some((item) => item.error) || (answer.errors ?? []).length > 0;
  return failed ? 1 : 0;
}

const runDirectly = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (runDirectly) process.exitCode = main(process.argv.slice(2));
