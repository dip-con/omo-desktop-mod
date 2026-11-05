import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appResourcesDir, bundleExe, childrenFrom, dialogArgs, omoProcessesFrom, parsePsRows, queryOptions, readOmoProfileWith, selectOmoProcesses, wireInject, writeStateFile } from '../loader/deps.mjs';
import { partitionEnabled } from '../loader/mods.mjs';
import { ownerAllowed } from '../loader/ownership.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const loaderDir = path.resolve(here, '..', 'loader');
const APP_EXE = '/Applications/OmO.app/Contents/MacOS/OmO';

// Fakes for every effect of the inject step. Nothing spawns, nothing touches the network, nothing reads a real file.
function fakeIo({ mods = [], skipped = [], badFiles = [], state = {}, owner = null, children = () => [] } = {}) {
  const calls = { load: [], served: [], writes: [], messages: [] };
  const io = {
    calls,
    answers: async () => ({ webSocketDebuggerUrl: 'ws://fake' }),
    readFacts: () => ({}),
    discoverMods: () => ({ mods, skipped }),
    partitionEnabled,
    loadModSources: (active) => {
      calls.load.push(active.map((m) => m.id));
      return { loaded: active.map((m) => ({ id: m.id })), skipped: badFiles };
    },
    mainRuleFromFacts: () => 'rule',
    serveMainWindows: (args) => {
      calls.served.push(args);
      return 'served';
    },
    ownerAllowed,
    portOwner: () => owner,
    processChildren: () => children,
    readState: () => state,
    writeState: (s) => calls.writes.push(s),
    messageBox: (text) => calls.messages.push(text),
    log: () => {},
    buildKey: () => 'key',
    fingerprint: () => 'fp',
    loaderDir,
    modsRoot: '/mods',
  };
  return io;
}

async function runInject(io) {
  await wireInject(io)({ port: 9222, omoProfile: 'prof' });
  return io.calls.served[0];
}

test('every system query carries a 15 s timeout and the C locale, and keeps the given env', () => {
  const opts = queryOptions({ EXTRA: 'x' });
  assert.equal(opts.timeout, 15000);
  assert.equal(opts.env.LC_ALL, 'C');
  assert.equal(opts.env.EXTRA, 'x');
});

const PS_TEXT = [
  `  101     1 ${APP_EXE}`,
  '  102   101 /Applications/OmO.app/Contents/Resources/omo-runtime/darwin-arm64/omo',
  '  103     1 /Users/alice/Downloads/OmO.app/Contents/MacOS/OmO',
  '  104     1 /Applications/Other App.app/Contents/MacOS/Other App',
  '',
].join('\n');

test('omoProcessesFrom keeps only the ps rows whose executable is exactly the app executable', () => {
  assert.deepEqual(omoProcessesFrom(PS_TEXT, APP_EXE), [{ pid: 101, ppid: 1, exePath: APP_EXE }]);
});

test('parsePsRows keeps executable paths that contain spaces', () => {
  assert.equal(parsePsRows(PS_TEXT).find((r) => r.pid === 104).exePath, '/Applications/Other App.app/Contents/MacOS/Other App');
});

test('childrenFrom answers the children of a pid from ps pid/ppid rows', () => {
  const childrenOf = childrenFrom('  100     1\n  200   100\n  201   100\n  300   200\n');
  assert.deepEqual(childrenOf(100), [200, 201]);
  assert.deepEqual(childrenOf(999), []);
});

test('without OMO_DESKTOP_HOME every process of the app executable counts as running', () => {
  const all = [{ pid: 101, ppid: 1, exePath: APP_EXE }];
  const result = selectOmoProcesses({ env: {}, state: { omoPid: 555 }, appExe: APP_EXE, isAlive: () => true, listAll: () => all });
  assert.deepEqual(result, all);
});

test('with OMO_DESKTOP_HOME only the live pid in the loader state counts, and other OmO processes are ignored', () => {
  const listAll = () => {
    throw new Error('an isolated instance must not list other OmO processes');
  };
  const env = { OMO_DESKTOP_HOME: '/tmp/qa-home' };
  assert.deepEqual(selectOmoProcesses({ env, state: { omoPid: 555 }, appExe: APP_EXE, isAlive: (pid) => pid === 555, listAll }), [{ pid: 555, ppid: null, exePath: APP_EXE }]);
  assert.deepEqual(selectOmoProcesses({ env, state: { omoPid: 555 }, appExe: APP_EXE, isAlive: () => false, listAll }), []);
  assert.deepEqual(selectOmoProcesses({ env, state: null, appExe: APP_EXE, isAlive: () => true, listAll }), []);
});

test('an empty OMO_DESKTOP_HOME is not isolated mode', () => {
  const all = [{ pid: 101, ppid: 1, exePath: APP_EXE }];
  assert.deepEqual(selectOmoProcesses({ env: { OMO_DESKTOP_HOME: '' }, state: null, appExe: APP_EXE, isAlive: () => false, listAll: () => all }), all);
});

test('writeStateFile makes the directory, writes a temp file and renames it over the state file', () => {
  const file = path.join('state', 'dir', 'state.json');
  const ops = [];
  const io = {
    mkdirSync: (dir, opts) => ops.push(['mkdir', dir, opts.recursive]),
    writeFileSync: (p, data) => ops.push(['write', p, JSON.parse(data).n]),
    renameSync: (from, to) => ops.push(['rename', from, to]),
  };
  writeStateFile(file, { n: 1 }, io);
  assert.deepEqual(ops, [
    ['mkdir', path.dirname(file), true],
    ['write', `${file}.tmp`, 1],
    ['rename', `${file}.tmp`, file],
  ]);
});

test('readOmoProfileWith returns OMO_PROFILE from the environment without asking launchd', () => {
  const run = () => {
    throw new Error('launchd must not be asked');
  };
  assert.equal(readOmoProfileWith({ OMO_PROFILE: 'env-profile' }, run), 'env-profile');
});

test('readOmoProfileWith reads OMO_PROFILE with launchctl getenv, read only, when the env is empty', () => {
  const calls = [];
  const run = (file, args) => {
    calls.push([file, ...args]);
    return 'launchd-profile';
  };
  assert.equal(readOmoProfileWith({}, run), 'launchd-profile');
  assert.deepEqual(calls, [['launchctl', 'getenv', 'OMO_PROFILE']]);
});

test('readOmoProfileWith returns null when launchd has no value', () => {
  assert.equal(readOmoProfileWith({}, () => ''), null);
});

test('the dialog passes text and title as osascript argv, never inside the script', () => {
  const args = dialogArgs('a "quoted" text', 'Title');
  assert.deepEqual(args.slice(-2), ['a "quoted" text', 'Title']);
  assert.equal(args.slice(0, -2).some((a) => a.includes('quoted')), false);
});

test('the config names the app bundle, and the executable and resources sit inside it', () => {
  assert.equal(bundleExe('/Applications/OmO.app'), '/Applications/OmO.app/Contents/MacOS/OmO');
  assert.equal(appResourcesDir('/Applications/OmO.app'), '/Applications/OmO.app/Contents/Resources');
});

test('inject loads only the enabled mods', async () => {
  const io = fakeIo({
    mods: [
      { id: 'on', enabled: true },
      { id: 'off', enabled: false },
    ],
  });
  await runInject(io);
  assert.deepEqual(io.calls.load, [['on']]);
});

test('inject reports the disabled, bad-format and bad-file entries to serveMainWindows', async () => {
  const io = fakeIo({
    mods: [
      { id: 'on', enabled: true },
      { id: 'off', enabled: false, nameKo: '끄기' },
    ],
    skipped: [{ id: 'bad', reason: 'x' }],
    badFiles: [{ id: 'badfile', reason: 'y' }],
  });
  const served = await runInject(io);
  assert.deepEqual(served.resolveMods().reported, [
    { id: 'off', name: '끄기', attached: false, reason: 'DISABLED' },
    { id: 'bad', name: 'bad', attached: false, reason: 'BAD_FORMAT' },
    { id: 'badfile', name: 'badfile', attached: false, reason: 'BAD_FILES' },
  ]);
});

test('the plan event writes the loaded states followed by the reported entries', async () => {
  const io = fakeIo({
    mods: [{ id: 'off', enabled: false }],
    state: { omoPid: 5 },
  });
  const served = await runInject(io);
  const states = [{ id: 'on', attached: true, reason: null }];
  served.onEvent({ kind: 'plan', states, pathname: '/main' });
  assert.deepEqual(io.calls.writes, [
    {
      omoPid: 5,
      mods: [...states, { id: 'off', name: 'off', attached: false, reason: 'DISABLED' }],
      omoProfile: 'prof',
      pathname: '/main',
    },
  ]);
});

test('the fail event marks only the failing mod as MOD_ERROR', async () => {
  const io = fakeIo({
    state: {
      mods: [
        { id: 'a', attached: true, reason: null },
        { id: 'b', attached: true, reason: null },
      ],
    },
  });
  const served = await runInject(io);
  served.onEvent({ kind: 'fail', mod: 'a' });
  assert.deepEqual(io.calls.writes[0].mods, [
    { id: 'a', attached: false, reason: 'MOD_ERROR' },
    { id: 'b', attached: true, reason: null },
  ]);
});

test('the watchdog event marks every loaded mod as WATCHDOG', async () => {
  const io = fakeIo({ mods: [{ id: 'a', enabled: true }, { id: 'b', enabled: true }] });
  const served = await runInject(io);
  served.onEvent({ kind: 'watchdog', reloads: 2 });
  assert.deepEqual(io.calls.writes[0].mods, [
    { id: 'a', attached: false, reason: 'WATCHDOG' },
    { id: 'b', attached: false, reason: 'WATCHDOG' },
  ]);
});

test('the watchdog message box is shown for a target\'s first watchdog', async () => {
  const io = fakeIo();
  const served = await runInject(io);
  served.onEvent({ kind: 'watchdog', sessionId: 'box-first', reloads: 1 });
  assert.equal(io.calls.messages.length, 1);
});

test('the watchdog message box is not shown again for the same target', async () => {
  const io = fakeIo();
  const served = await runInject(io);
  served.onEvent({ kind: 'watchdog', sessionId: 'box-again', reloads: 1 });
  served.onEvent({ kind: 'watchdog', sessionId: 'box-again', reloads: 2 });
  assert.equal(io.calls.messages.length, 1);
});

test('ownerOk accepts the port owner when it is a child of the spawned OmO process', async () => {
  const io = fakeIo({ owner: 200, state: { omoPid: 100 }, children: (pid) => (pid === 100 ? [200] : []) });
  const served = await runInject(io);
  assert.equal(await served.ownerOk(), true);
});

test('ownerOk rejects a port owner that is another OmO process outside the spawned tree', async () => {
  const io = fakeIo({ owner: 300, state: { omoPid: 100 }, children: (pid) => (pid === 100 ? [200] : []) });
  const served = await runInject(io);
  assert.equal(await served.ownerOk(), false);
});

test('ownerOk rejects when nothing listens on the port', async () => {
  const io = fakeIo({ owner: null, state: { omoPid: 100 }, children: () => [200] });
  const served = await runInject(io);
  assert.equal(await served.ownerOk(), false);
});

test('realDeps keeps the lock file in the state dir, not in the loader dir', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-wiring-'));
  try {
    const depsUrl = pathToFileURL(path.join(loaderDir, 'deps.mjs')).href;
    const code = `const { realDeps } = await import(${JSON.stringify(depsUrl)}); console.log(JSON.stringify({ lockFile: realDeps({ planOnly: true }).lockFile }));`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
      env: { ...process.env, LOADER_STATE_DIR: stateDir, OMO_PROFILE: 'x' },
    });
    const { lockFile } = JSON.parse(out.trim().split('\n').at(-1));
    const lock = path.resolve(lockFile);
    assert.ok(lock.startsWith(path.resolve(stateDir) + path.sep));
    assert.ok(!lock.startsWith(loaderDir + path.sep));
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a reload writes the state from the mods read at that reload', async () => {
  // Given: one enabled mod at start; a second mod is switched off on disk before the reload
  const mods = [{ id: 'on', enabled: true }];
  const io = fakeIo({ mods });
  const served = await runInject(io);
  mods.push({ id: 'off', enabled: false, nameKo: '끄기' });
  // When: serveMainWindows re-reads the mods on __reload, then reports the reload
  served.resolveMods();
  served.onEvent({ kind: 'reloaded' });
  // Then: the state lists the switched-off mod
  assert.deepEqual(io.calls.writes.at(-1).mods, [{ id: 'off', name: '끄기', attached: false, reason: 'DISABLED' }]);
});
