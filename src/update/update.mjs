// Update check and apply for an installed mods home. modsHome/install.json records where every id came from:
// github sources are compared by commit sha, local sources by folder hash. apply stages the new folder under
// modsHome/.staging and swaps it in, putting the old folder back when the swap fails. The installed mod.json keeps its
// "enabled" value, _loader keeps config.json, and files the install did not write are carried over.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic } from '../core/fsx.mjs';
import { installBytes, installedVersion, latestVersion, listFiles, materialize } from './tree.mjs';

export const installFile = (modsHome) => path.join(modsHome, 'install.json');

// Asks each distinct github repo@ref (or local folder) once per call.
function versionLookup(fetch) {
  const memo = new Map();
  return (source) => {
    const key = source.type === 'github' ? `${source.repo}@${source.ref}` : `local:${source.path}`;
    if (!memo.has(key)) memo.set(key, latestVersion(source, { fetch }));
    return memo.get(key);
  };
}

async function checkOne(record, id, lookup) {
  const source = record.sources[id] ?? null;
  const item = { id, source, installed: source ? installedVersion(source) : null, latest: null, changed: false, error: null };
  if (!source) return { ...item, error: `no install source recorded for ${id}` };
  try {
    const latest = await lookup(source);
    return { ...item, latest, changed: latest !== item.installed };
  } catch (error) {
    return { ...item, error: error.message };
  }
}

export async function check({ modsHome, ids, fetch = globalThis.fetch }) {
  const record = readJson(installFile(modsHome));
  if (!record?.sources) return { ok: false, items: [], error: `${installFile(modsHome)} not found or invalid` };
  const targets = ids?.length ? ids : Object.keys(record.sources);
  const lookup = versionLookup(fetch);
  const items = await Promise.all(targets.map((id) => checkOne(record, id, lookup)));
  return { ok: items.every((item) => !item.error), items };
}

// Every file under dir (dot names included), '/'-separated.
function allFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'));
}

function copyInto(fromDir, toDir, rel, bytes) {
  const dest = path.join(toDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes ?? fs.readFileSync(path.join(fromDir, rel)));
}

// Replaces modsHome/<id> with the files of sourceDir. Returns the managed file list of the new folder.
export function swapIn({ modsHome, id, sourceDir, managed = [] }) {
  const stagingRoot = path.join(modsHome, '.staging');
  const tag = crypto.randomBytes(6).toString('hex');
  const staged = path.join(stagingRoot, `${id}-${tag}`);
  const old = path.join(stagingRoot, `${id}-old-${tag}`);
  const target = path.join(modsHome, id);
  fs.mkdirSync(staged, { recursive: true });
  try {
    const files = listFiles(sourceDir);
    for (const rel of files) {
      copyInto(sourceDir, staged, rel, installBytes({ srcFile: path.join(sourceDir, rel), rel, installedDir: target }));
    }
    const managedSet = new Set(managed);
    const newSet = new Set(files);
    const keptConfig = id === '_loader' && fs.existsSync(path.join(target, 'config.json'));
    for (const rel of allFiles(target)) {
      const foreign = !managedSet.has(rel) && !newSet.has(rel);
      if (foreign || (keptConfig && rel === 'config.json')) copyInto(target, staged, rel);
    }
    const exists = fs.existsSync(target);
    if (exists) fs.renameSync(target, old);
    try {
      fs.renameSync(staged, target);
    } catch (error) {
      if (exists) fs.renameSync(old, target);
      throw error;
    }
    fs.rmSync(old, { recursive: true, force: true });
    return keptConfig && !newSet.has('config.json') ? [...files, 'config.json'].sort() : files;
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
    if (fs.existsSync(stagingRoot) && fs.readdirSync(stagingRoot).length === 0) fs.rmdirSync(stagingRoot);
  }
}

export async function apply({ modsHome, ids, fetch = globalThis.fetch }) {
  const result = { ok: true, applied: [], skipped: [], errors: [] };
  const checked = await check({ modsHome, ids, fetch });
  if (checked.error) return { ...result, ok: false, errors: [{ id: null, message: checked.error }] };
  let record = readJson(installFile(modsHome));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-mods-update-'));
  const cache = new Map();
  try {
    for (const item of checked.items) {
      if (item.error) result.errors.push({ id: item.id, message: item.error });
      else if (!item.changed) result.skipped.push({ id: item.id, reason: 'UNCHANGED' });
      else {
        try {
          const { dir, source } = await materialize(item.source, { fetch, tmpDir, cache });
          const files = swapIn({ modsHome, id: item.id, sourceDir: dir, managed: record.files?.[item.id] ?? [] });
          record = { ...record, sources: { ...record.sources, [item.id]: source }, files: { ...record.files, [item.id]: files } };
          writeJsonAtomic(installFile(modsHome), record);
          result.applied.push(item.id);
        } catch (error) {
          result.errors.push({ id: item.id, message: `APPLY_FAILED: ${error.message}` });
        }
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return { ...result, ok: result.errors.length === 0 };
}
