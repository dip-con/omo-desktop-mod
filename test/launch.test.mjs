// Tests for loader/launch.mjs and loader/fingerprint.mjs. Assertions check codes, fields and call arguments, never
// message wording. Every side effect is a fake; the only child process is the plan-only entry run in a temp state dir.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { acquireLock, checkHome, decideLaunch, LOOPBACK_HOST, pickLoopbackPort, runLaunch, sameExe, PORT_VAR } from '../loader/launch.mjs';
import { ALREADY_RUNNING_TEXT, DEBUG_PORT_TEXT, PLAIN_START_TEXT } from '../loader/messages.mjs';
import { modifierKeysHoldShift, readOmoProfileWith, shiftHeldWith } from '../loader/deps.mjs';
import { partitionEnabled } from '../loader/mods.mjs';
import { buildKey, readAsarEntry, readFingerprint } from '../loader/fingerprint.mjs';
import { makeAsar } from './helpers/asar.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS_HOME = 'C:/Users/alice';
const APP_EXE = 'C:/app/OmO.exe';
const OMO_PROC = { pid: 1, exePath: APP_EXE };

function withTempDir(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-launch-test-'));
  return Promise.resolve(body(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

// Fake dependencies: every side effect is recorded; nothing is spawned, shown or written outside dir.
function fakeDeps(dir, overrides = {}) {
  const rec = { spawned: [], messages: [], logs: [], states: [], injected: [], reports: [], watched: [], plain: [] };
  const parentEnv = { USERPROFILE: 'C:\\Users\\alice', PATH: 'C:\\Windows', OMO_PROFILE: 'work' };
  const deps = {
    osHome: OS_HOME,
    homedir: OS_HOME,
    env: parentEnv,
    appExe: APP_EXE,
    omoProfile: 'work',
    lockFile: path.join(dir, 'loader.lock'),
    isAlive: () => false,
    log: (line) => rec.logs.push(line),
    report: (obj) => rec.reports.push(obj),
    messageBox: (text) => rec.messages.push(text),
    omoProcesses: () => [],
    readState: () => null,
    probe: async () => ({ appExeExists: true, portResponds: false, ownerInOmoTree: false }),
    pickPort: async () => 41234,
    plainStart: () => {
      rec.plain.push(1);
    },
    shiftHeld: () => false,
    spawn: (exe, args, opts) => {
      rec.spawned.push({ exe, args, opts });
      return { pid: 777 };
    },
    writeState: (s) => rec.states.push(s),
    now: () => '2026-11-02T00:00:00.000Z',
    fingerprint: () => ({ appVersion: 'test' }),
    waitForVersion: async () => true,
    inject: async (opts) => {
      rec.injected.push(opts);
      return { done: Promise.resolve() };
    },
    watch: (args) => {
      rec.watched.push(args);
      return { exitCode: Promise.resolve(0), idle: async () => {} };
    },
    ...overrides,
  };
  return { deps, rec, parentEnv };
}

test('a home guard trip exits 4 with the existing box, and starts nothing', async () => {
  await withTempDir(async (dir) => {
    const { deps, rec } = fakeDeps(dir, { homedir: 'C:/Users/alice/.omo-lane/home' });
    assert.equal(await runLaunch([], deps), 4);
    assert.equal(rec.spawned.length, 0);
    assert.equal(rec.plain.length, 0);
    assert.equal(rec.messages.length, 1);
  });
});

test('another launcher holding the lock exits 0 with nothing started and no box', async () => {
  await withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, 'loader.lock'), '4242');
    const { deps, rec } = fakeDeps(dir, { isAlive: (pid) => pid === 4242, omoProcesses: () => { throw new Error('must not query'); } });
    assert.equal(await runLaunch([], deps), 0);
    assert.equal(rec.spawned.length, 0);
    assert.equal(rec.plain.length, 0);
    assert.deepEqual(rec.messages, []);
  });
});

test('a debug port that never opens exits 6 with the debug-port box and starts no second copy', async () => {
  await withTempDir(async (dir) => {
    const { deps, rec } = fakeDeps(dir, { waitForVersion: async () => false });
    assert.equal(await runLaunch([], deps), 6);
    assert.equal(rec.spawned.length, 1);
    assert.equal(rec.plain.length, 0);
    assert.deepEqual(rec.messages, [DEBUG_PORT_TEXT]);
  });
});

test('an injection failure after the app started exits 6 and starts no second copy', async () => {
  await withTempDir(async (dir) => {
    const { deps, rec } = fakeDeps(dir, {
      inject: async () => {
        throw new Error('cdp lost');
      },
    });
    assert.equal(await runLaunch([], deps), 6);
    assert.equal(rec.spawned.length, 1);
    assert.equal(rec.plain.length, 0);
    assert.deepEqual(rec.messages, [DEBUG_PORT_TEXT]);
  });
});

test('a failing process query, state read, probe or port pick opens OmO plain once and exits 20', async () => {
  const failures = [
    { omoProcesses: () => { throw new Error('wmi'); } },
    { readState: () => { throw new Error('state'); } },
    { probe: async () => { throw new Error('probe'); } },
    { pickPort: async () => { throw new Error('port'); } },
  ];
  for (const overrides of failures) {
    await withTempDir(async (dir) => {
      const { deps, rec } = fakeDeps(dir, overrides);
      assert.equal(await runLaunch([], deps), 20);
      assert.equal(rec.plain.length, 1);
      assert.equal(rec.spawned.length, 0);
      assert.deepEqual(rec.messages, [PLAIN_START_TEXT]);
    });
  }
});

test('--safe starts OmO plain when none is running, does no mod work, and shows no box', async () => {
  await withTempDir(async (dir) => {
    const { deps, rec } = fakeDeps(dir);
    assert.equal(await runLaunch(['--safe'], deps), 0);
    assert.equal(rec.plain.length, 1);
    assert.equal(rec.spawned.length, 0);
    assert.equal(rec.injected.length, 0);
    assert.deepEqual(rec.messages, []);
  });
});

test('--safe while OmO runs starts nothing and shows no box', async () => {
  await withTempDir(async (dir) => {
    const { deps, rec } = fakeDeps(dir, { omoProcesses: () => [OMO_PROC] });
    assert.equal(await runLaunch(['--safe'], deps), 0);
    assert.equal(rec.plain.length, 0);
    assert.deepEqual(rec.messages, []);
  });
});

test('a held Shift starts plain exactly like --safe, with and without OMO_PROFILE in the environment', async () => {
  const environments = [{ PATH: 'C:\\Windows' }, { PATH: 'C:\\Windows', OMO_PROFILE: 'work' }];
  for (const env of environments) {
    await withTempDir(async (dir) => {
      const { deps, rec } = fakeDeps(dir, { env, omoProfile: env.OMO_PROFILE ?? null, shiftHeld: () => true });
      assert.equal(await runLaunch([], deps), 0);
      assert.equal(rec.plain.length, 1);
      assert.equal(rec.injected.length, 0);
      assert.deepEqual(rec.messages, []);
    });
  }
});

test('the Shift check reads the ModifierKeys output, alone or among other modifiers', () => {
  assert.equal(modifierKeysHoldShift('Shift\r\n'), true);
  assert.equal(modifierKeysHoldShift('Control, Shift\r\n'), true);
  assert.equal(modifierKeysHoldShift('None\r\n'), false);
  assert.equal(modifierKeysHoldShift('Control\r\n'), false);
});

test('with OMO_PROFILE set the Shift check still runs its own PowerShell call, with the env it was given', () => {
  const env = { PATH: 'C:\\Windows', OMO_PROFILE: 'work' };
  const calls = [];
  const run = (script, callEnv) => {
    calls.push({ script, callEnv });
    return 'Shift';
  };
  assert.equal(readOmoProfileWith(env, run), 'work');
  assert.deepEqual(calls, []);
  assert.equal(shiftHeldWith(run, env), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].script, /ModifierKeys/);
  assert.equal(calls[0].callEnv, env);
});

test('realDeps wires shiftHeld to the ModifierKeys check, not to a constant', () => {
  const source = fs.readFileSync(path.join(here, '..', 'loader', 'deps.mjs'), 'utf8');
  assert.match(source, /shiftHeld:\s*\(\)\s*=>\s*shiftHeldWith\(\)/);
});

test('the home guard passes on the real home and fails when homedir or an agent-dir variable points elsewhere', () => {
  assert.deepEqual(checkHome({ osHome: OS_HOME, homedir: OS_HOME, env: {} }), []);
  assert.equal(checkHome({ osHome: OS_HOME, homedir: 'C:/Users/alice/.omo-lane/home', env: {} }).length > 0, true);
  assert.equal(checkHome({ osHome: OS_HOME, homedir: OS_HOME, env: { PI_CODING_AGENT_DIR: 'C:/Users/alice/.omo-lane/home/.omo/agent' } }).length > 0, true);
  assert.deepEqual(checkHome({ osHome: OS_HOME, homedir: OS_HOME, env: { PI_CODING_AGENT_DIR: 'C:/Users/alice/.omo/agent' } }), []);
});

test('decideLaunch: not running launches', () => {
  assert.deepEqual(decideLaunch({ processes: [], state: null, probe: { appExeExists: true, portResponds: false, ownerInOmoTree: false } }), { action: 'launch' });
});

test('decideLaunch: running with a live port owned by the OmO tree attaches only', () => {
  const decision = decideLaunch({
    processes: [OMO_PROC],
    state: { omoPid: 1, port: 9333, fingerprint: 'f', startedAt: 'now' },
    probe: { appExeExists: true, portResponds: true, ownerInOmoTree: true },
  });
  assert.deepEqual(decision, { action: 'attach', port: 9333 });
});

test('decideLaunch: running without a usable port refuses with code 3', () => {
  const noState = decideLaunch({ processes: [OMO_PROC], state: null, probe: { appExeExists: true, portResponds: false, ownerInOmoTree: false } });
  const deadPort = decideLaunch({
    processes: [OMO_PROC],
    state: { omoPid: 1, port: 9333, fingerprint: 'f', startedAt: 'now' },
    probe: { appExeExists: true, portResponds: false, ownerInOmoTree: true },
  });
  assert.deepEqual(noState, { action: 'refuse', exitCode: 3 });
  assert.deepEqual(deadPort, { action: 'refuse', exitCode: 3 });
});

test('decideLaunch: a missing app executable refuses with code 2 and no launch', () => {
  assert.deepEqual(decideLaunch({ processes: [], state: null, probe: { appExeExists: false, portResponds: false, ownerInOmoTree: false } }), { action: 'refuse', exitCode: 2 });
});

test('a home-redirected run exits 4 and spawns nothing', async () => {
  await withTempDir(async (dir) => {
    const { deps, rec } = fakeDeps(dir, { homedir: 'C:/Users/alice/.omo-lane/home' });
    assert.equal(await runLaunch([], deps), 4);
    assert.equal(rec.spawned.length, 0);
    assert.equal(rec.messages.length, 1);
  });
});

test('a running OmO without a port exits 22 with the already-running box, and starts nothing', async () => {
  await withTempDir(async (dir) => {
    const { deps, rec } = fakeDeps(dir, { omoProcesses: () => [OMO_PROC] });
    assert.equal(await runLaunch([], deps), 22);
    assert.equal(rec.spawned.length, 0);
    assert.equal(rec.plain.length, 0);
    assert.deepEqual(rec.messages, [ALREADY_RUNNING_TEXT]);
    assert.equal(rec.injected.length, 0);
  });
});

test('a fresh start passes the parent environment unchanged plus the port, binds the loopback host, and injects', async () => {
  await withTempDir(async (dir) => {
    const { deps, rec, parentEnv } = fakeDeps(dir);
    assert.equal(await runLaunch([], deps), 0);
    assert.equal(rec.spawned.length, 1);
    // The app's environment: the parent's variables untouched (OMO_PROFILE included), plus the debug port.
    assert.deepEqual(rec.spawned[0].opts.env, { ...parentEnv, [PORT_VAR]: '41234' });
    assert.deepEqual(rec.spawned[0].args, [`--remote-debugging-address=${LOOPBACK_HOST}`]);
    assert.equal(rec.states[0].port, 41234);
    assert.equal(rec.states[0].omoProfile, 'work');
    assert.deepEqual(rec.injected, [{ port: 41234, omoProfile: 'work' }]);
  });
});

test('runLaunch returns exactly the exit code that supervision resolves to', async () => {
  for (const code of [5, 0]) {
    await withTempDir(async (dir) => {
      const { deps } = fakeDeps(dir, { watch: () => ({ exitCode: Promise.resolve(code), idle: async () => {} }) });
      assert.equal(await runLaunch([], deps), code);
    });
  }
});

test('the single-instance lock is held while supervision runs, a second helper is refused meanwhile, and the lock is released after exit', { timeout: 10000 }, async () => {
  await withTempDir(async (dir) => {
    const lockFile = path.join(dir, 'loader.lock');
    let resolveExit;
    const exitCode = new Promise((resolve) => {
      resolveExit = resolve;
    });
    let onWatch;
    const watchCalled = new Promise((resolve) => {
      onWatch = resolve;
    });
    const { deps, rec } = fakeDeps(dir, {
      watch: (args) => {
        rec.watched.push(args);
        onWatch();
        return { exitCode, idle: async () => {} };
      },
    });
    const running = runLaunch([], deps);
    await watchCalled;
    // Supervision is live: the lock file must still exist.
    assert.equal(fs.existsSync(lockFile), true);
    // A second helper finds the lock owned by a live pid: it does not launch.
    assert.equal(await runLaunch([], { ...deps, isAlive: () => true }), 0);
    assert.equal(rec.spawned.length, 1);
    resolveExit(0);
    assert.equal(await running, 0);
    assert.equal(fs.existsSync(lockFile), false);
  });
});

test('a log failure after the app spawned rejects tagged as started and never starts a second copy', async () => {
  await withTempDir(async (dir) => {
    const { deps, rec } = fakeDeps(dir, {
      log: (line) => {
        if (rec.spawned.length > 0) throw new Error('appendFileSync EIO');
        rec.logs.push(line);
      },
    });
    await assert.rejects(runLaunch([], deps), (err) => err.started === true && err.message === 'appendFileSync EIO');
    assert.equal(rec.spawned.length, 1);
    assert.equal(rec.plain.length, 0);
    assert.deepEqual(rec.messages, [DEBUG_PORT_TEXT]);
  });
});

test('--no-mods returns 0 and never starts supervision', async () => {
  await withTempDir(async (dir) => {
    let watchCalls = 0;
    const { deps } = fakeDeps(dir, {
      watch: async () => {
        watchCalls += 1;
        return 5;
      },
    });
    assert.equal(await runLaunch(['--no-mods'], deps), 0);
    assert.equal(watchCalls, 0);
  });
});

test('--no-mods starts the app and skips injection', async () => {
  await withTempDir(async (dir) => {
    const { deps, rec } = fakeDeps(dir);
    assert.equal(await runLaunch(['--no-mods'], deps), 0);
    assert.equal(rec.spawned.length, 1);
    assert.equal(rec.injected.length, 0);
  });
});

test('a failure before the app started opens OmO plain once, shows the plain-start box, and exits 20', async () => {
  await withTempDir(async (dir) => {
    const { deps, rec } = fakeDeps(dir, {
      spawn: () => {
        throw new Error('spawn denied');
      },
    });
    assert.equal(await runLaunch([], deps), 20);
    assert.equal(rec.plain.length, 1);
    assert.deepEqual(rec.messages, [PLAIN_START_TEXT]);
    assert.equal(rec.logs.some((l) => l.includes('spawn denied')), true);
  });
});

test('a second helper while the first holds the lock does not launch and leaves the lock', async () => {
  await withTempDir(async (dir) => {
    fs.writeFileSync(path.join(dir, 'loader.lock'), '4242');
    const { deps, rec } = fakeDeps(dir, { isAlive: (pid) => pid === 4242 });
    assert.equal(await runLaunch([], deps), 0);
    assert.equal(rec.spawned.length, 0);
    assert.equal(fs.existsSync(path.join(dir, 'loader.lock')), true);
  });
});

test('a lock whose owner pid is dead is taken over and released', async () => {
  await withTempDir((dir) => {
    const lockFile = path.join(dir, 'loader.lock');
    fs.writeFileSync(lockFile, '5151');
    const lock = acquireLock(lockFile, { pid: process.pid, isAlive: () => false });
    assert.equal(lock.acquired, true);
    lock.release();
    assert.equal(fs.existsSync(lockFile), false);
  });
});

test('a lock whose pid was reused by a later process is taken over, while a live earlier owner is refused', async () => {
  await withTempDir((dir) => {
    const lockFile = path.join(dir, 'loader.lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 5151, startedAt: 1000 }));
    // Reused: the pid now belongs to a process that started after the lock was written.
    const taken = acquireLock(lockFile, { pid: process.pid, isAlive: () => true, startTimeOf: () => 2000, now: () => 3000 });
    assert.equal(taken.acquired, true);
    taken.release();
    // A live owner that started before the lock: refused, and the lock stays.
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 5151, startedAt: 1000 }));
    const refused = acquireLock(lockFile, { pid: process.pid, isAlive: () => true, startTimeOf: () => 500, now: () => 3000 });
    assert.equal(refused.acquired, false);
    assert.equal(fs.existsSync(lockFile), true);
  });
});

test('pickLoopbackPort asks the server to listen on the loopback host only', async () => {
  // Given: a fake server that records the host it is asked to listen on
  const calls = [];
  const createServer = () => ({
    once() {},
    listen(port, host, cb) {
      calls.push({ port, host });
      cb();
    },
    address: () => ({ port: 4321 }),
    close: (cb) => cb(),
  });
  // When
  const port = await pickLoopbackPort({ createServer });
  // Then: the bind host is the loopback address, and the port is the one the server reports
  assert.deepEqual(calls, [{ port: 0, host: '127.0.0.1' }]);
  assert.equal(LOOPBACK_HOST, '127.0.0.1');
  assert.equal(port, 4321);
});

test('partitionEnabled splits enabled and disabled mods so a disabled mod never reaches injection', () => {
  const base = { name: 'x', nameKo: 'x', version: '1', order: 1, entry: { page: 'p.js' }, contributes: {}, testedBuilds: [], anchors: [] };
  const mods = [{ ...base, id: 'on', enabled: true }, { ...base, id: 'off', enabled: false }];
  const { active, disabled } = partitionEnabled(mods);
  assert.deepEqual(active.map((m) => m.id), ['on']);
  assert.deepEqual(disabled.map((m) => m.id), ['off']);
});

test('sameExe ignores separator style and letter case, and rejects a different file', () => {
  assert.equal(sameExe('C:/Users/alice/AppData/Local/Programs/omo/OmO.exe', 'c:\\users\\alice\\appdata\\local\\programs\\omo\\omo.EXE'), true);
  assert.equal(sameExe('C:/app/OmO.exe', 'C:/app/OmO-helper.exe'), false);
});

test('the entry file runs the launch when executed (plan-only, temp copy of loader, no spawn)', async () => {
  await withTempDir(async (dir) => {
    // Given: a copy of loader/ whose config points at an exe that does not exist, so no real OmO.exe is reachable from this run
    const copy = path.join(dir, 'app', 'loader');
    fs.cpSync(path.join(here, '..', 'loader'), copy, { recursive: true });
    fs.writeFileSync(path.join(copy, 'config.json'), JSON.stringify({ appExe: path.join(dir, 'missing', 'OmO.exe') }));
    const entry = path.join(copy, 'launch.mjs');
    // The child keeps the real home as USERPROFILE so the home guard passes; --plan-only never spawns or shows a box.
    const home = os.userInfo().homedir;
    const childEnv = { ...process.env, USERPROFILE: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2), LOADER_STATE_DIR: dir };
    for (const k of ['OMO_CODING_AGENT_DIR', 'SENPI_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'T3CODE_OMO_AGENT_DIR']) delete childEnv[k];
    const out = execFileSync(process.execPath, [entry, '--plan-only'], { encoding: 'utf8', timeout: 120000, env: childEnv });
    // Then: the entry ran runLaunch (a JSON report on stdout), the missing exe is refused with code 2, the log is in the temp dir
    const report = JSON.parse(out.trim().split('\n').pop());
    assert.equal(report.action, 'refuse');
    assert.equal(report.exitCode, 2);
    assert.equal(fs.existsSync(path.join(dir, 'logs')), true);
    assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
  });
});

// Scans every test file: no line that starts a child process names the real app exe or a path under the real account home.
test('no test spawns a child with the real OmO.exe or the real account home', () => {
  const real = /DEFAULT_APP_EXE|Programs[\\/]omo|homedir\(\)|AppData/i;
  const spawning = /spawn|exec|fork/;
  const files = fs.readdirSync(here).filter((name) => name.endsWith('.test.mjs'));
  const hits = [];
  for (const name of files) {
    fs.readFileSync(path.join(here, name), 'utf8').split('\n').forEach((line, i) => {
      if (spawning.test(line) && real.test(line)) hits.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});

// Builds a fake install: the asar header with a package.json, the client html, the runtime manifest and the plugin.
function makeAppDir(dir, { clientHtml = '<html>a</html>' } = {}) {
  const res = path.join(dir, 'resources');
  fs.mkdirSync(path.join(res, 'omo-server', 'client'), { recursive: true });
  fs.mkdirSync(path.join(res, 'omo-runtime', 'win32-x64', 'plugin', 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(res, 'app.asar'), makeAsar({ 'package.json': Buffer.from(JSON.stringify({ version: '9.9.9' })) }));
  fs.writeFileSync(path.join(res, 'omo-server', 'client', 'index.html'), clientHtml);
  fs.writeFileSync(path.join(res, 'omo-runtime', 'win32-x64', 'bundle-manifest.json'), JSON.stringify({ omoRef: 'v1', resolvedShas: { omo: 'abc' } }));
  fs.writeFileSync(path.join(res, 'omo-runtime', 'win32-x64', 'plugin', 'extensions', 'omo.js'), 'plugin');
}

test('the fingerprint reads the asar package version and the runtime values', async () => {
  await withTempDir((dir) => {
    makeAppDir(dir);
    const fp = readFingerprint(dir);
    assert.equal(fp.appVersion, '9.9.9');
    assert.equal(fp.runtime.omoRef, 'v1');
    assert.equal(fp.runtime.omoSha, 'abc');
    assert.equal(readAsarEntry(path.join(dir, 'resources', 'app.asar'), 'package.json').toString('utf8').includes('9.9.9'), true);
  });
});

test('the build key changes when the client file changes and is stable otherwise', async () => {
  await withTempDir((dir) => {
    const a = path.join(dir, 'a');
    const b = path.join(dir, 'b');
    makeAppDir(a);
    makeAppDir(b, { clientHtml: '<html>changed</html>' });
    assert.equal(buildKey(readFingerprint(a)), buildKey(readFingerprint(a)));
    assert.notEqual(buildKey(readFingerprint(a)), buildKey(readFingerprint(b)));
  });
});
