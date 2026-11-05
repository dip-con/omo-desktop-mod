// The plain `node loader/check.mjs` branch, run from a temp copy of loader/ whose config.json points at a synthetic app.
// The installed app is never read: every file the fingerprint needs is written into a temp folder first.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildKey, readFingerprint } from '../loader/fingerprint.mjs';
import { makeMacBundle } from './helpers/mac-app.mjs';

const LOADER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'loader');

test('plain check run prints {fingerprint, appVersion, mods} and exits 0', () => {
  // Given: a loader copy whose config.json names a synthetic OmO.app bundle and whose mods folder holds one valid mod
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'check-cli-'));
  try {
    const loaderCopy = path.join(root, 'loader');
    fs.cpSync(LOADER, loaderCopy, { recursive: true });
    const appBundle = makeMacBundle(path.join(root, 'OmO.app'));
    fs.writeFileSync(path.join(loaderCopy, 'config.json'), JSON.stringify({ appBundle }));
    const modDir = path.join(root, 'mods', 'hello');
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(path.join(modDir, 'page.js'), '');
    fs.writeFileSync(
      path.join(modDir, 'mod.json'),
      JSON.stringify({ id: 'hello', name: 'Hello', nameKo: '안녕', version: '1.0.0', enabled: true, order: 1, entry: { page: 'page.js' }, contributes: {}, anchors: [] }),
    );
    // When: the check runs with no arguments
    const run = spawnSync(process.execPath, [path.join(loaderCopy, 'check.mjs')], { encoding: 'utf8' });
    // Then: exit 0, and the JSON shape carries the fingerprint of the synthetic app and the mod's flags
    assert.equal(run.status, 0, run.stderr);
    const out = JSON.parse(run.stdout);
    assert.deepEqual(Object.keys(out).sort(), ['appVersion', 'fingerprint', 'mods']);
    assert.equal(out.appVersion, '9.9.9');
    assert.equal(out.fingerprint, buildKey(readFingerprint(appBundle)));
    assert.deepEqual(out.mods, [{ id: 'hello', enabled: true, tested: false }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
