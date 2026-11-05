import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appInfo } from '../src/core/app.mjs';

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('appInfo reads version, client hash, runtime ref/sha and plugin hash', () => {
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'core-app-'));
  const res = path.join(b, 'Contents', 'Resources');
  write(path.join(b, 'Contents', 'Info.plist'), '<dict><key>CFBundleShortVersionString</key>\n  <string>1.2.3</string></dict>');
  write(path.join(res, 'omo-server', 'client', 'index.html'), 'html');
  const rt = path.join(res, 'omo-runtime', 'darwin-test');
  write(path.join(rt, 'bundle-manifest.json'), JSON.stringify({ omoRef: 'v1', resolvedShas: { omo: 'abc' } }));
  write(path.join(rt, 'plugin', 'extensions', 'omo.js'), 'plugin');
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  assert.deepEqual(appInfo(b), { version: '1.2.3', client: sha('html'), runtime: { ref: 'v1', sha: 'abc' }, plugin: sha('plugin') });
});

test('appInfo reports null for every unreadable part and never throws', () => {
  assert.deepEqual(appInfo('/nope'), { version: null, client: null, runtime: { ref: null, sha: null }, plugin: null });
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'core-app-'));
  write(path.join(b, 'Contents', 'Resources', 'omo-runtime', 'darwin-x', 'bundle-manifest.json'), '{broken');
  assert.deepEqual(appInfo(b), { version: null, client: null, runtime: { ref: null, sha: null }, plugin: null });
});
