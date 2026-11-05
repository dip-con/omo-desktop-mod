import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempDir } from './fixtures/mods-home.mjs';

const STATUS = fileURLToPath(new URL('../bin/status.mjs', import.meta.url));
const run = (stateDir, args) => execFileSync(process.execPath, [STATUS, '--app', path.join(stateDir, 'Missing.app'), ...args], { env: { ...process.env, LOADER_STATE_DIR: stateDir }, encoding: 'utf8' });

test('status --json summarizes state.json and appInfo', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ omoPid: 2147483646, port: 9333, startedAt: 'now', mods: [{ id: 'ko', attached: false, reason: 'DISABLED' }] }));
  const out = JSON.parse(run(dir, ['--json']));
  assert.equal(out.running, false);
  assert.equal(out.port, 9333);
  assert.deepEqual(out.mods, [{ id: 'ko', attached: false, reason: 'DISABLED' }]);
  assert.equal(out.app.version, null);
});

test('status without a state file says the loader has not opened OmO', () => {
  assert.match(run(tempDir(), []), /모드 도우미로 연 기록이 없어요/);
});
