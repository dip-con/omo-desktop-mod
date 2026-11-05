import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { appBundleFrom, inTree, nextMods, omoMains, openLog, pickPort } from '../src/loader/deps.mjs';
import { tempDir } from './fixtures/mods-home.mjs';

test('omoMains keeps only bundle main executables', () => {
  const procs = [
    { pid: 1, ppid: 0, exe: '/Applications/OmO.app/Contents/MacOS/OmO' },
    { pid: 2, ppid: 1, exe: '/Applications/OmO.app/Contents/Frameworks/OmO Helper.app/Contents/MacOS/OmO Helper' },
    { pid: 3, ppid: 0, exe: '/Users/x/Applications/OmO Mods.app/Contents/MacOS/OmO Mods' },
  ];
  assert.deepEqual(omoMains(procs).map((p) => p.pid), [1]);
});

test('inTree follows the parent chain to a root', () => {
  const procs = [{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 20, ppid: 1 }];
  assert.equal(inTree(12, [10], procs), true);
  assert.equal(inTree(10, [10], procs), true);
  assert.equal(inTree(20, [10], procs), false);
  assert.equal(inTree(null, [10], procs), false);
});

test('nextMods turns inject events into state.json mods', () => {
  const reported = [{ id: 'off', name: 'off', attached: false, reason: 'DISABLED' }];
  const plan = nextMods([], { kind: 'plan', states: [{ id: 'ko', attached: true, reason: null }, { id: 'h', attached: true, reason: null }], reported }, new Set(['h']));
  assert.deepEqual(plan, [
    { id: 'ko', attached: true, reason: null },
    { id: 'h', attached: false, reason: 'HOST_FAILED' },
    { id: 'off', attached: false, reason: 'DISABLED' },
  ]);
  assert.equal(nextMods(plan, { kind: 'fail', mod: 'ko' }, new Set())[0].reason, 'MOD_ERROR');
  assert.deepEqual(nextMods(plan, { kind: 'watchdog' }, new Set()).map((m) => m.reason), ['WATCHDOG', 'HOST_FAILED', 'DISABLED']);
  assert.deepEqual(nextMods(plan, { kind: 'reloaded', reported }, new Set()), [{ id: 'off', attached: false, reason: 'DISABLED' }]);
});

test('openLog keeps the newest 10 launch logs including the new one', () => {
  const dir = tempDir();
  for (let i = 0; i < 12; i += 1) fs.writeFileSync(path.join(dir, `launch-2026-01-${String(i + 10)}.log`), '');
  fs.writeFileSync(path.join(dir, 'other.txt'), '');
  openLog(dir, '2026-12-31T00:00:00.000Z')('hello');
  const logs = fs.readdirSync(dir).filter((n) => n.startsWith('launch-')).sort();
  assert.equal(logs.length, 10);
  assert.equal(logs.at(-1), 'launch-2026-12-31T00-00-00-000Z.log');
  assert.equal(logs[0], 'launch-2026-01-13.log');
  assert.ok(fs.existsSync(path.join(dir, 'other.txt')));
});

test('appBundleFrom reads config.json app, else the default bundle', () => {
  const root = tempDir();
  assert.equal(appBundleFrom(root), '/Applications/OmO.app');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ app: '/tmp/Other.app' }));
  assert.equal(appBundleFrom(root), '/tmp/Other.app');
});

test('pickPort returns a free loopback port', async () => {
  const port = await pickPort();
  assert.ok(Number.isInteger(port) && port > 1024);
});
