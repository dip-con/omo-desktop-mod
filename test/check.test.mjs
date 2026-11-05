// Tests for the plain report of loader/check.mjs on a temp app folder and a temp mods root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { plainReport } from '../loader/check.mjs';
import { makeMacBundle } from './helpers/mac-app.mjs';

function writeMod(modsRoot, id, raw) {
  fs.mkdirSync(path.join(modsRoot, id), { recursive: true });
  fs.writeFileSync(path.join(modsRoot, id, 'mod.json'), typeof raw === 'string' ? raw : JSON.stringify(raw));
}

test('the plain report gives the build key, the app version, and each valid mod with its enabled flag', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-check-test-'));
  try {
    // Given: a fake OmO.app bundle (no testedBuilds in any mod.json) and a mods root with two valid mods (one disabled) and one broken mod.json
    const app = makeMacBundle(path.join(dir, 'OmO.app'));
    const modsRoot = path.join(dir, 'mods');
    const base = { name: 'x', nameKo: 'x', version: '1', order: 1, entry: { page: 'page.js' }, contributes: {}, anchors: [] };
    writeMod(modsRoot, 'alpha', { ...base, id: 'alpha', enabled: true });
    writeMod(modsRoot, 'beta', { ...base, id: 'beta', enabled: false });
    writeMod(modsRoot, 'gamma', '{ not json');
    // When
    const report = plainReport({ appBundle: app, modsRoot });
    // Then: the version is the asar's, the key is a 64-char hash, and only valid mods are listed with their flags
    assert.equal(report.appVersion, '9.9.9');
    assert.equal(report.fingerprint.length, 64);
    assert.deepEqual(report.mods, [
      { id: 'alpha', enabled: true, tested: false },
      { id: 'beta', enabled: false, tested: false },
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
