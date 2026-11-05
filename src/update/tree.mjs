// Source records ("github:owner/repo/path#ref" or a local folder), their current version, and copying a source
// folder into a mods home. Shared by install and update.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, sha256Dir } from '../core/fsx.mjs';
import { fetchTree, latestCommit } from './github.mjs';

const SKIPPED = new Set(['node_modules', 'test', 'tests']);
const ID = /^[a-z0-9][a-z0-9_-]*$/i;

// Relative '/'-separated files of a source folder, with the same skips as sha256Dir.
export function listFiles(root, rel = '') {
  return fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || SKIPPED.has(entry.name)) return [];
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listFiles(root, child);
    return entry.isFile() ? [child] : [];
  }).sort();
}

// "github:<owner>/<repo>/<path>[#ref]" or a local folder path -> a source record without version.
export function parseSpec(spec, cwd = process.cwd()) {
  if (!spec.startsWith('github:')) return { type: 'local', path: path.resolve(cwd, spec) };
  const [body, ref = 'main'] = spec.slice('github:'.length).split('#');
  const [owner, name, ...rest] = body.split('/').filter(Boolean);
  if (!owner || !name || !ref) throw new Error(`bad mod spec: ${spec}`);
  return { type: 'github', repo: `${owner}/${name}`, ref, path: rest.join('/') };
}

// The version a source has now: commit sha (github) or folder hash (local).
export async function latestVersion(source, { fetch } = {}) {
  switch (source.type) {
    case 'github': return latestCommit({ repo: source.repo, ref: source.ref, fetch });
    case 'local': return sha256Dir(source.path);
    default: throw new Error(`unknown source type: ${source.type}`);
  }
}

export const installedVersion = (source) => (source.type === 'github' ? source.commit : source.hash) ?? null;

// Makes a source available on disk: {dir, source} where source carries its version (commit or hash).
export async function materialize(source, { fetch, tmpDir, cache } = {}) {
  switch (source.type) {
    case 'github': {
      const commit = await latestCommit({ repo: source.repo, ref: source.ref, fetch });
      const dir = await fetchTree({ repo: source.repo, ref: commit, path: source.path, fetch, tmpDir, cache });
      return { dir, source: { type: 'github', repo: source.repo, ref: source.ref, path: source.path, commit } };
    }
    case 'local': {
      if (!fs.existsSync(source.path)) throw new Error(`source folder not found: ${source.path}`);
      return { dir: source.path, source: { type: 'local', path: source.path, hash: sha256Dir(source.path) } };
    }
    default: throw new Error(`unknown source type: ${source.type}`);
  }
}

// The id a mod folder declares in mod.json (checked to be a safe folder name).
export function modIdOf(dir) {
  const mod = readJson(path.join(dir, 'mod.json'));
  if (!mod) throw new Error(`mod.json missing or invalid in ${dir}`);
  if (typeof mod.id !== 'string' || !ID.test(mod.id)) throw new Error(`unsafe mod id in ${dir}: ${mod.id}`);
  return mod.id;
}

// File bytes to install: mod.json keeps the "enabled" value of the currently installed copy.
export function installBytes({ srcFile, rel, installedDir }) {
  const bytes = fs.readFileSync(srcFile);
  if (rel !== 'mod.json') return bytes;
  const enabled = readJson(path.join(installedDir, 'mod.json'))?.enabled;
  if (typeof enabled !== 'boolean') return bytes;
  return `${JSON.stringify({ ...JSON.parse(bytes.toString('utf8')), enabled }, null, 2)}\n`;
}

// Removes now-empty folders above the given files, deepest first, never `root` itself.
export function pruneEmptyDirs(root, absFiles) {
  const dirs = new Set();
  for (const file of absFiles) {
    for (let d = path.dirname(file); d.startsWith(`${root}${path.sep}`); d = path.dirname(d)) dirs.add(d);
  }
  for (const d of [...dirs].sort((a, b) => b.length - a.length)) {
    if (fs.existsSync(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
  }
}
