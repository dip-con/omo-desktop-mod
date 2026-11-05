// Installs the loader (src/ -> modsHome/_loader), the built-in modmgr mod and the requested mods, writes
// modsHome/install.json and the "OmO Mods.app" launcher. Everything is planned and checked before the first write:
// a file this installer did not write is never overwritten (error, nothing written). Never touches the OmO bundle.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from '../core/fsx.mjs';
import { appExe } from '../core/paths.mjs';
import { installFile } from '../update/update.mjs';
import { installBytes, listFiles, materialize, modIdOf, parseSpec, pruneEmptyDirs } from '../update/tree.mjs';
import { isOurLauncher, launcherPath, writeLauncher } from './launcher.mjs';

// The repo this file lives in (the checkout or the extracted tarball the installer runs from).
export const OWN_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const V1_MANIFEST = path.join('_loader', 'install-manifest.json');

const sub = (source, folder) => (source.type === 'github'
  ? { ...source, path: [source.path, folder].filter(Boolean).join('/') }
  : { type: 'local', path: path.join(source.path, folder) });

// Absolute paths of every file the previous install (v2 install.json, or a v1 manifest) wrote.
function previousFiles(modsHome) {
  const v2 = readJson(installFile(modsHome))?.files ?? {};
  const v1 = readJson(path.join(modsHome, V1_MANIFEST))?.files ?? [];
  return new Set([
    ...Object.entries(v2).flatMap(([id, rels]) => rels.map((rel) => path.join(modsHome, id, rel))),
    ...v1.map((entry) => path.join(modsHome, typeof entry === 'string' ? entry : entry.path)),
  ]);
}

async function resolveUnits({ loader, mods, fetch, tmpDir }) {
  const cache = new Map();
  const repo = parseSpec(loader);
  const wanted = [
    { id: '_loader', source: sub(repo, 'src') },
    { id: 'modmgr', source: sub(repo, 'mods/modmgr') },
    ...mods.map((spec) => ({ id: null, source: parseSpec(spec) })),
  ];
  const units = [];
  for (const unit of wanted) {
    const { dir, source } = await materialize(unit.source, { fetch, tmpDir, cache });
    const id = unit.id ?? modIdOf(dir);
    if (units.some((u) => u.id.toLowerCase() === id.toLowerCase())) throw new Error(`duplicate or reserved mod id: ${id}`);
    units.push({ id, dir, source, files: listFiles(dir) });
  }
  return units;
}

// Plans the install: {units, write:[{abs,id,rel,from|data}], remove:[abs], foreign:[abs]}.
function plan({ modsHome, units, config }) {
  const prev = previousFiles(modsHome);
  const write = units.flatMap((unit) => unit.files.map((rel) => ({
    id: unit.id, rel, abs: path.join(modsHome, unit.id, rel), from: path.join(unit.dir, rel),
  })));
  write.push({ id: '_loader', rel: 'config.json', abs: path.join(modsHome, '_loader', 'config.json'), data: `${JSON.stringify(config, null, 2)}\n` });
  const planned = new Set(write.map((w) => w.abs));
  const foreign = write.filter((w) => fs.existsSync(w.abs) && !prev.has(w.abs)).map((w) => w.abs);
  const remove = [...prev].filter((abs) => !planned.has(abs) && fs.existsSync(abs));
  if (fs.existsSync(path.join(modsHome, V1_MANIFEST))) remove.push(path.join(modsHome, V1_MANIFEST));
  return { write, remove, foreign };
}

export async function install({ modsHome, appsDir, app, mods = [], dryRun = false, loader = OWN_REPO, fetch = globalThis.fetch, node = process.execPath }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-mods-install-'));
  try {
    const units = await resolveUnits({ loader, mods, fetch, tmpDir });
    const config = { app, node };
    const { write, remove, foreign } = plan({ modsHome, units, config });
    const launcher = launcherPath(appsDir);
    if (fs.existsSync(launcher) && !isOurLauncher(launcher)) foreign.push(launcher);
    if (foreign.length) throw new Error(`설치 프로그램이 만들지 않은 파일이 있어서 덮어쓰지 않았어요:\n  ${foreign.join('\n  ')}`);
    const warnings = fs.existsSync(appExe(app)) ? [] : [`OmO 앱을 찾지 못했어요: ${appExe(app)}`];
    const sources = Object.fromEntries(units.map((u) => [u.id, u.source]));
    const files = Object.fromEntries(units.map((u) => [u.id, u.id === '_loader' ? [...u.files, 'config.json'].sort() : u.files]));
    const summary = { ok: true, dryRun, modsHome, sources, write: write.map((w) => w.abs), remove, launcher, warnings };
    if (dryRun) return summary;

    for (const w of write) {
      fs.mkdirSync(path.dirname(w.abs), { recursive: true });
      fs.writeFileSync(w.abs, w.data ?? installBytes({ srcFile: w.from, rel: w.rel, installedDir: path.join(modsHome, w.id) }));
    }
    for (const abs of remove) fs.rmSync(abs, { force: true });
    pruneEmptyDirs(modsHome, remove);
    fs.mkdirSync(appsDir, { recursive: true });
    warnings.push(...await writeLauncher({ appsDir, node, modsHome, app }));
    writeJsonAtomic(installFile(modsHome), { version: 2, installedAt: new Date().toISOString(), node, app, sources, files });
    return summary;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Removes exactly the files install.json lists, the launcher when it is ours, and install.json. User data stays.
export function uninstall({ modsHome, appsDir, dryRun = false }) {
  const record = readJson(installFile(modsHome));
  if (!record) return { ok: true, dryRun, removed: [], message: `${installFile(modsHome)} 파일이 없어서 지울 것이 없어요` };
  const targets = [...previousFiles(modsHome)].filter((abs) => fs.existsSync(abs));
  const launcher = launcherPath(appsDir);
  const removed = [...targets, installFile(modsHome), ...(isOurLauncher(launcher) ? [launcher] : [])];
  if (dryRun) return { ok: true, dryRun, removed };
  for (const abs of targets) fs.rmSync(abs, { force: true });
  pruneEmptyDirs(modsHome, targets);
  fs.rmSync(installFile(modsHome), { force: true });
  if (isOurLauncher(launcher)) fs.rmSync(launcher, { recursive: true, force: true });
  return { ok: true, dryRun, removed };
}
