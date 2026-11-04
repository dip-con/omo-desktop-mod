#!/usr/bin/env node
// Status and maintenance for the loader.
//   node loader/check.mjs                    -> {fingerprint, appVersion, mods:[{id, enabled, tested}]}
//   node loader/check.mjs status --json      -> {running, modded, port, fingerprint, mods:[{id, attached, reason}]}
//   node loader/check.mjs --record-build     -> adds the current build key to each mod.json testedBuilds.
//   --record-build is manual only: run it after a new app version passed the QA, never automatically.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildKey, readFingerprint } from './fingerprint.mjs';
import { discoverMods, modsRootFor } from './mods.mjs';
import { readConfigAppExe, readState } from './deps.mjs';
import { pidAlive } from './pid.mjs';

const loaderDir = path.dirname(fileURLToPath(import.meta.url));


async function answers(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

// Plain report: the build key, the app version, and each valid mod with its enabled flag and whether it was tested.
export function plainReport({ appDir, modsRoot }) {
  const fp = readFingerprint(appDir);
  const key = buildKey(fp);
  const { mods } = discoverMods(modsRoot);
  return {
    fingerprint: key,
    appVersion: fp.appVersion,
    mods: mods.map((m) => ({ id: m.id, enabled: m.enabled, tested: m.testedBuilds.includes(key) })),
  };
}

export async function status() {
  const state = readState();
  const port = state?.port ?? null;
  const running = state !== null && Number.isInteger(state.omoPid) && pidAlive(state.omoPid);
  const modded = port !== null && (await answers(port));
  const fingerprint = buildKey(readFingerprint(path.dirname(readConfigAppExe())));
  return { running, modded, port, fingerprint, mods: state?.mods ?? [] };
}

export function recordBuild() {
  const key = buildKey(readFingerprint(path.dirname(readConfigAppExe())));
  const modsRoot = modsRootFor(loaderDir);
  const { mods } = discoverMods(modsRoot);
  const recorded = [];
  for (const m of mods) {
    if (m.testedBuilds.includes(key)) continue;
    const file = path.join(modsRoot, m.id, 'mod.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.testedBuilds = [...raw.testedBuilds, key];
    fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
    recorded.push(m.id);
  }
  return { fingerprint: key, recorded };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--record-build')) {
    console.log(JSON.stringify(recordBuild()));
  } else if (process.argv[2] === 'status') {
    console.log(JSON.stringify(await status()));
  } else if (process.argv.length === 2) {
    console.log(JSON.stringify(plainReport({ appDir: path.dirname(readConfigAppExe()), modsRoot: modsRootFor(loaderDir) })));
  } else {
    console.error('usage: node loader/check.mjs [status --json | --record-build]');
    process.exitCode = 2;
  }
}
