import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { EXIT, TEXT, acquireLock, decide, runLaunch } from '../src/loader/launch.mjs';
import { tempDir } from './fixtures/mods-home.mjs';

const OMO = { pid: 500, ppid: 1, exe: '/Applications/OmO.app/Contents/MacOS/OmO' };
const okProbe = { appExists: true, portAnswers: true, ownerInTree: true };

test('decide: launch, attach, refuse and missing app', () => {
  assert.equal(decide({ processes: [], state: null, probe: okProbe }).action, 'launch');
  assert.deepEqual(decide({ processes: [OMO], state: { port: 9333 }, probe: okProbe }), { action: 'attach', exitCode: null, port: 9333 });
  assert.equal(decide({ processes: [OMO], state: null, probe: okProbe }).exitCode, EXIT.refuse);
  assert.equal(decide({ processes: [OMO], state: { port: 9333 }, probe: { ...okProbe, ownerInTree: false } }).exitCode, EXIT.refuse);
  assert.equal(decide({ processes: [], state: null, probe: { ...okProbe, appExists: false } }).exitCode, EXIT.appMissing);
});

test('acquireLock: second holder is refused while the owner lives; a dead owner is taken over', () => {
  const file = path.join(tempDir(), 'loader.lock');
  const first = acquireLock(file, { pid: 11, isAlive: () => true });
  assert.equal(first.acquired, true);
  assert.deepEqual(acquireLock(file, { pid: 12, isAlive: () => true }), { acquired: false, ownerPid: 11 });
  const taken = acquireLock(file, { pid: 12, isAlive: () => false });
  assert.equal(taken.acquired, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 12);
  taken.release();
  assert.equal(fs.existsSync(file), false);
});

function fakeDeps(over = {}) {
  const calls = { dialog: [], report: [], spawnApp: [], plainStart: 0, writeState: [], connect: 0 };
  const deps = {
    appBundle: '/Applications/OmO.app',
    pid: 42,
    lockFile: path.join(tempDir(), 'loader.lock'),
    log: () => {},
    report: (o) => calls.report.push(o),
    dialog: (t) => calls.dialog.push(t),
    isAlive: () => true,
    now: () => 0,
    shiftHeld: () => false,
    appInfo: () => ({ version: '2026.1102.3' }),
    readState: () => null,
    writeState: (s) => calls.writeState.push(s),
    omoProcesses: () => [],
    probe: async () => okProbe,
    pickPort: async () => 9333,
    spawnApp: (port) => (calls.spawnApp.push(port), 500),
    plainStart: () => {
      calls.plainStart += 1;
    },
    waitForPort: async () => true,
    portAnswers: async () => true,
    connect: async () => {
      calls.connect += 1;
      return { done: new Promise(() => {}) };
    },
    supervise: async () => 0,
    ...over,
  };
  return { deps, calls };
}

test('plan-only reports the decision and starts, shows and locks nothing', async () => {
  const { deps, calls } = fakeDeps({ omoProcesses: () => [OMO] });
  assert.equal(await runLaunch(['--plan-only'], deps), EXIT.ok);
  assert.equal(calls.report[0].action, 'refuse');
  assert.equal(calls.report[0].exitCode, EXIT.refuse);
  assert.deepEqual([calls.spawnApp, calls.plainStart, calls.dialog], [[], 0, []]);
  assert.equal(fs.existsSync(deps.lockFile), false);
});

test('plan-only never fails open when the probe throws', async () => {
  const { deps, calls } = fakeDeps({ omoProcesses: () => { throw new Error('ps broke'); } });
  assert.equal(await runLaunch(['--plan-only'], deps), EXIT.plainStart);
  assert.equal(calls.report[0].action, 'error');
  assert.equal(calls.plainStart, 0);
});

test('launch spawns OmO with the port, writes state, connects and supervises', async () => {
  let supervised = null;
  const { deps, calls } = fakeDeps({ supervise: async (o) => ((supervised = o), 0) });
  assert.equal(await runLaunch([], deps), 0);
  assert.deepEqual(calls.spawnApp, [9333]);
  assert.deepEqual(calls.writeState[0], { omoPid: 500, port: 9333, app: { version: '2026.1102.3' }, startedAt: '1970-01-01T00:00:00.000Z', mods: [] });
  assert.equal(calls.connect, 1);
  assert.equal(supervised.omoPid, 500);
  assert.equal(fs.existsSync(deps.lockFile), false);
});

test('a running OmO not started by the loader is refused with the dialog and exit 3, never touched', async () => {
  const { deps, calls } = fakeDeps({ omoProcesses: () => [OMO], probe: async () => ({ ...okProbe, portAnswers: false }) });
  assert.equal(await runLaunch([], deps), EXIT.refuse);
  assert.deepEqual(calls.dialog, [TEXT.refuse]);
  assert.deepEqual([calls.spawnApp, calls.plainStart], [[], 0]);
});

test('attach reuses the recorded port without spawning', async () => {
  const { deps, calls } = fakeDeps({ omoProcesses: () => [OMO], readState: () => ({ omoPid: 500, port: 9444 }) });
  assert.equal(await runLaunch([], deps), 0);
  assert.deepEqual(calls.spawnApp, []);
  assert.equal(calls.connect, 1);
});

test('a failure before the app started opens OmO plain once with exit 20', async () => {
  const { deps, calls } = fakeDeps({ pickPort: async () => { throw new Error('no port'); } });
  assert.equal(await runLaunch([], deps), EXIT.plainStart);
  assert.equal(calls.plainStart, 1);
  assert.deepEqual(calls.dialog, [TEXT.plainStart]);
});

test('a failure after the start never starts a second copy', async () => {
  const { deps, calls } = fakeDeps({ connect: async () => { throw new Error('cdp'); } });
  assert.equal(await runLaunch([], deps), EXIT.attachFailed);
  assert.equal(calls.plainStart, 0);
  assert.deepEqual(calls.dialog, [TEXT.attachFailed]);
});

test('--safe starts plain only when OmO is not running; --no-mods skips connect', async () => {
  const safe = fakeDeps();
  assert.equal(await runLaunch(['--safe'], safe.deps), 0);
  assert.deepEqual([safe.calls.plainStart, safe.calls.spawnApp], [1, []]);
  const noMods = fakeDeps();
  assert.equal(await runLaunch(['--no-mods'], noMods.deps), 0);
  assert.deepEqual([noMods.calls.spawnApp, noMods.calls.connect], [[9333], 0]);
});

test('a second loader exits 0 without acting while the lock owner lives', async () => {
  const { deps, calls } = fakeDeps();
  fs.writeFileSync(deps.lockFile, JSON.stringify({ pid: 7, startedAt: 0 }));
  assert.equal(await runLaunch([], deps), 0);
  assert.deepEqual(calls.spawnApp, []);
});
