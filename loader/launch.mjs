// Launch policy and the loader's main flow. Every side effect (spawn, message box, state, lock, processes) arrives
// through deps so the tests run on fakes and temp dirs. Run directly: node loader/launch.mjs [--no-mods] [--plan-only]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateMod } from './mods.mjs';
import { lockIsStale } from './ownership.mjs';
import { isBlockedPort } from './ports.mjs';
import { ALREADY_RUNNING_TEXT, DEBUG_PORT_TEXT, PLAIN_START_TEXT } from './messages.mjs';

const AGENT_DIR_VARS = ['OMO_CODING_AGENT_DIR', 'SENPI_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'T3CODE_OMO_AGENT_DIR'];
export const PORT_VAR = 'OMO_DESKTOP_REMOTE_DEBUGGING_PORT';
export const LOOPBACK_HOST = '127.0.0.1';
export const WAIT_FOR_VERSION_MS = 60000;
export const NOT_RUNNING_TEXT = ALREADY_RUNNING_TEXT;
export const FAILED_TEXT = 'OmO 모드 도우미가 실행에 실패했어요. 로그를 확인하세요.';

const same = (a, b) => a === b;

// Executable paths compare exactly, after resolving '.', '..' and doubled slashes.
export function sameExe(a, b) {
  return path.resolve(a) === path.resolve(b);
}

// Violations of the home rule: the process must see the real home, and no agent-dir variable may point elsewhere.
// An empty list means the app may be launched.
export function checkHome({ osHome, homedir, env }) {
  const problems = [];
  if (!same(path.resolve(homedir), path.resolve(osHome))) problems.push(`homedir ${homedir} != ${osHome}`);
  const expected = path.resolve(osHome, '.omo', 'agent');
  for (const name of AGENT_DIR_VARS) {
    const value = env[name];
    if (value !== undefined && value !== '' && !same(path.resolve(value), expected)) problems.push(`${name} points elsewhere`);
  }
  return problems;
}

// Three branches. Not running: launch. Running and the state file names a port that answers and is owned by the
// OmO process tree: attach only. Anything else while OmO is running: refuse, and never close the running app.
export function decideLaunch({ processes, state, probe }) {
  if (!probe.appExeExists) return { action: 'refuse', exitCode: 2 };
  if (processes.length === 0) return { action: 'launch' };
  const attachable = state !== null && Number.isInteger(state.port) && probe.portResponds && probe.ownerInOmoTree;
  if (attachable) return { action: 'attach', port: state.port };
  return { action: 'refuse', exitCode: 3 };
}

// Single-instance lock as a file holding the owner pid. A lock whose pid is dead is taken over.
// The lock holds {pid, startedAt}. A lock written as a plain pid (older helpers) has no start time.
function readLock(file) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    const o = JSON.parse(text);
    if (typeof o !== 'object' || o === null) throw new SyntaxError('legacy pid lock');
    return { pid: Number(o.pid), startedAt: Number(o.startedAt) };
  } catch {
    return { pid: Number(text), startedAt: null };
  }
}

export function acquireLock(lockFile, { pid, isAlive, startTimeOf = () => null, now = () => Date.now() }) {
  const take = () => {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid, startedAt: now() }));
    fs.closeSync(fd);
    return { acquired: true, release: () => fs.rmSync(lockFile, { force: true }) };
  };
  try {
    return take();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const lock = readLock(lockFile);
  if (!lockIsStale({ lock, pidAlive: isAlive, startTimeOf })) return { acquired: false, ownerPid: lock.pid };
  fs.rmSync(lockFile, { force: true });
  return take();
}

const PICK_ATTEMPTS = 50;

// An ephemeral port, bound on the loopback host only. A port that Node's WebSocket and fetch refuse (ports.mjs) is
// released and asked for again. createServer is injectable so the bind host is observable.
export async function pickLoopbackPort({ createServer = net.createServer } = {}) {
  for (let attempt = 0; attempt < PICK_ATTEMPTS; attempt += 1) {
    const port = await listenOnce(createServer);
    if (!isBlockedPort(port)) return port;
  }
  throw new Error(`no unblocked loopback port after ${PICK_ATTEMPTS} attempts`);
}

// Binds an ephemeral loopback port, closes the server, and resolves with the port number.
function listenOnce(createServer) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, LOOPBACK_HOST, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function parseArgs(argv) {
  return { noMods: argv.includes('--no-mods'), planOnly: argv.includes('--plan-only'), safe: argv.includes('--safe') };
}

// Plain start: the OmO executable with no arguments, once per run. `run.started` records that this run has started or attached to the app.
function startPlain(deps, run) {
  deps.plainStart();
  run.started = true;
}

// A failure before this run started the app opens OmO plain (exit 20). After the start, a failure never starts a second copy (exit 6).
function failOpen(deps, run) {
  try {
    startPlain(deps, run);
  } catch (err) {
    deps.log(`plain start failed: ${err.message}`);
    deps.messageBox(FAILED_TEXT);
    return 20;
  }
  deps.messageBox(PLAIN_START_TEXT);
  return 20;
}

// The loader's main flow. Returns the exit code. It never closes or kills the running app.
export async function runLaunch(argv, deps) {
  const run = { started: false };
  try {
    return await launchOnce(parseArgs(argv), deps, run);
  } catch (err) {
    if (run.started) {
      // The app is up. Any failure from here, a throwing log included, is tagged so boot.mjs never starts a second copy.
      try {
        deps.messageBox(DEBUG_PORT_TEXT);
        deps.log(`launch failed after start: ${err.message}`);
        return 6;
      } catch (failure) {
        throw Object.assign(failure, { started: true });
      }
    }
    deps.log(`launch failed: ${err.message}`);
    return failOpen(deps, run);
  }
}

async function launchOnce({ noMods, planOnly, safe }, deps, run) {
  const violations = checkHome({ osHome: deps.osHome, homedir: deps.homedir, env: deps.env });
  if (violations.length > 0) {
    deps.log(`home redirected: ${violations.join('; ')}`);
    deps.messageBox('OmO 모드 도우미를 실제 사용자 홈에서만 실행할 수 있어요. 앱을 띄우지 않았어요.');
    return 4;
  }
  const lock = acquireLock(deps.lockFile, { pid: process.pid, isAlive: deps.isAlive, startTimeOf: deps.startTimeOf ?? (() => null) });
  if (!lock.acquired) {
    deps.log(`second helper, owner ${lock.ownerPid}; not launching`);
    return 0;
  }
  try {
    const processes = deps.omoProcesses();
    const state = deps.readState();
    const probe = await deps.probe(state, processes);
    const decision = decideLaunch({ processes, state, probe });
    deps.log(`decision ${decision.action}${decision.exitCode ? ` ${decision.exitCode}` : ''}`);
    if (planOnly) {
      deps.report({ action: decision.action, exitCode: decision.exitCode ?? null, port: decision.port ?? null, omoProfile: deps.omoProfile });
      return 0;
    }
    if (safe || deps.shiftHeld()) {
      deps.log('safe start');
      if (processes.length === 0) startPlain(deps, run);
      return 0;
    }
    if (decision.action === 'refuse' && decision.exitCode === 3) {
      deps.messageBox(NOT_RUNNING_TEXT);
      return 22;
    }
    if (decision.action === 'refuse') {
      deps.messageBox('OmO 앱을 찾을 수 없어요. 설치 후 다시 실행하세요.');
      return decision.exitCode;
    }
    const port = decision.action === 'attach' ? decision.port : await deps.pickPort();
    let omoPid = state?.omoPid ?? null;
    if (decision.action === 'attach') run.started = true;
    if (decision.action === 'launch') {
      // The app gets the parent environment unchanged, plus the debug port. Nothing is scrubbed or cleared.
      const env = { ...deps.env, [PORT_VAR]: String(port) };
      const child = deps.spawn(deps.appExe, [`--remote-debugging-address=${LOOPBACK_HOST}`], { env, detached: true, stdio: 'ignore' });
      omoPid = child.pid;
      run.started = true;
      deps.log(`spawned app pid ${child.pid}`);
      deps.writeState({ omoPid: child.pid, port, fingerprint: deps.fingerprint(), startedAt: deps.now(), omoProfile: deps.omoProfile });
    }
    const up = await deps.waitForVersion(port, WAIT_FOR_VERSION_MS);
    deps.log(`version ${up ? 'up' : 'timeout'} port ${port}`);
    if (!up) {
      deps.messageBox(DEBUG_PORT_TEXT);
      return 6;
    }
    if (noMods) return 0;
    deps.log('inject start');
    const served = await deps.inject({ port, omoProfile: deps.omoProfile });
    deps.log('inject returned');
    // deps.watch returns the supervision object { exitCode, idle }; the process exit code is its exitCode promise.
    const supervision = deps.watch({ omoPid, port, first: served, omoProfile: deps.omoProfile });
    return await supervision.exitCode;
  } finally {
    lock.release();
  }
}

// Entry: loads the real dependencies only when run as the script itself.
export async function main(argv) {
  const { realDeps } = await import('./deps.mjs');
  return runLaunch(argv, realDeps({ planOnly: argv.includes('--plan-only') }));
}

// No top-level await here: main() imports deps.mjs, which imports this module back, and an awaited entry would deadlock.
// realpath on both sides: on macOS the temp folder /var is a link to /private/var, and import.meta.url is resolved.
if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
