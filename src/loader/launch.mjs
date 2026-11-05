// Launch policy and the loader's main flow: node launch.mjs [--safe] [--no-mods] [--plan-only].
// Every side effect (spawn, dialog, state, lock, processes, CDP) arrives through deps, so tests run on fakes.
// The loader never quits, kills or signals OmO.
import fs from 'node:fs';
import { isEntry } from '../core/entry.mjs';

export const PORT_VAR = 'OMO_DESKTOP_REMOTE_DEBUGGING_PORT';
export const TEXT = {
  refuse: 'OmO가 이미 실행 중이에요. 완전히 종료한 뒤 OmO Mods로 다시 여세요.',
  appMissing: 'OmO 앱을 찾을 수 없어요. OmO를 설치한 뒤 다시 여세요.',
  plainStart: '모드 도우미가 시작하지 못해 OmO를 모드 없이 열었어요. 다시 열면 모드를 다시 시도해요.',
  failed: '모드 도우미가 OmO를 열지 못했어요. 로그를 확인하세요.',
  attachFailed: 'OmO는 켜졌지만 모드를 붙이지 못했어요. 앱을 완전히 끄고 다시 열면 다시 시도해요.',
};
export const EXIT = { ok: 0, appMissing: 2, refuse: 3, attachFailed: 6, plainStart: 20 };

export function parseArgs(argv) {
  return { safe: argv.includes('--safe'), noMods: argv.includes('--no-mods'), planOnly: argv.includes('--plan-only') };
}

// processes: running OmO main processes; probe: { appExists, portAnswers, ownerInTree } for state.port.
export function decide({ processes, state, probe }) {
  if (!probe.appExists) return { action: 'refuse', exitCode: EXIT.appMissing, reason: 'APP_MISSING' };
  if (processes.length === 0) return { action: 'launch', exitCode: null, port: null };
  if (Number.isInteger(state?.port) && probe.portAnswers && probe.ownerInTree) return { action: 'attach', exitCode: null, port: state.port };
  return { action: 'refuse', exitCode: EXIT.refuse, reason: 'ALREADY_RUNNING' };
}

// Single-instance lock: a file holding {pid, startedAt}. A lock whose pid is dead, or that does not parse, is taken over.
export function acquireLock(lockFile, { pid, isAlive, now = Date.now }) {
  const take = () => {
    fs.writeFileSync(lockFile, JSON.stringify({ pid, startedAt: now() }), { flag: 'wx' });
    return { acquired: true, release: () => fs.rmSync(lockFile, { force: true }) };
  };
  try {
    return take();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  let owner = null;
  try {
    owner = JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid;
  } catch {
    owner = null;
  }
  if (Number.isInteger(owner) && isAlive(owner)) return { acquired: false, ownerPid: owner };
  fs.rmSync(lockFile, { force: true });
  return take();
}

// Plain start (no debug port) once, after a failure before this run started the app.
export function failOpen(deps) {
  try {
    deps.plainStart();
  } catch (err) {
    deps.log(`plain start failed: ${err.message}`);
    deps.dialog(TEXT.failed);
    return EXIT.plainStart;
  }
  deps.dialog(TEXT.plainStart);
  return EXIT.plainStart;
}

// The main flow. Returns the exit code.
export async function runLaunch(argv, deps) {
  const flags = parseArgs(argv);
  // Plan-only reports the decision and never starts, shows or locks anything, even when the probe fails.
  if (flags.planOnly) {
    try {
      const { decision } = await assess(deps);
      deps.report({ ...decision, app: deps.appBundle });
      return EXIT.ok;
    } catch (err) {
      deps.report({ action: 'error', exitCode: EXIT.plainStart, error: err.message, app: deps.appBundle });
      return EXIT.plainStart;
    }
  }
  const run = { started: false };
  try {
    const lock = acquireLock(deps.lockFile, { pid: deps.pid, isAlive: deps.isAlive });
    if (!lock.acquired) {
      deps.log(`another loader runs as ${lock.ownerPid}`);
      return EXIT.ok;
    }
    try {
      return await launchOnce(flags, deps, run);
    } finally {
      lock.release();
    }
  } catch (err) {
    deps.log(`launch failed${run.started ? ' after start' : ''}: ${err.stack ?? err.message}`);
    if (!run.started) return failOpen(deps);
    deps.dialog(TEXT.attachFailed);
    return EXIT.attachFailed;
  }
}

async function assess(deps) {
  const processes = deps.omoProcesses();
  const state = deps.readState();
  const probe = await deps.probe(state, processes);
  const decision = decide({ processes, state, probe });
  deps.log(`decision ${JSON.stringify(decision)}`);
  return { processes, state, decision };
}

async function launchOnce(flags, deps, run) {
  const { processes, state, decision } = await assess(deps);
  if (flags.safe || deps.shiftHeld()) {
    deps.log('safe start');
    if (processes.length === 0 && decision.reason !== 'APP_MISSING') {
      deps.plainStart();
      run.started = true;
    }
    return EXIT.ok;
  }
  if (decision.action === 'refuse') {
    deps.dialog(decision.exitCode === EXIT.refuse ? TEXT.refuse : TEXT.appMissing);
    return decision.exitCode;
  }
  let omoPid;
  let port;
  if (decision.action === 'attach') {
    port = decision.port;
    omoPid = processes.some((p) => p.pid === state.omoPid) ? state.omoPid : processes[0].pid;
    run.started = true;
  } else {
    port = await deps.pickPort();
    omoPid = deps.spawnApp(port);
    run.started = true;
    deps.log(`spawned OmO pid ${omoPid} port ${port}`);
    deps.writeState({ omoPid, port, app: deps.appInfo(), startedAt: new Date(deps.now()).toISOString(), mods: [] });
  }
  if (!(await deps.waitForPort(port))) {
    deps.log(`port ${port} never answered`);
    deps.dialog(TEXT.attachFailed);
    return EXIT.attachFailed;
  }
  if (flags.noMods) return EXIT.ok;
  const connect = () => deps.connect({ port, omoPid });
  const first = await connect();
  return deps.supervise({ omoPid, first, reconnect: connect, probe: () => deps.portAnswers(port), isAlive: deps.isAlive, log: deps.log });
}

export async function main(argv) {
  const { realDeps } = await import('./deps.mjs');
  return runLaunch(argv, realDeps({ planOnly: parseArgs(argv).planOnly }));
}

if (isEntry(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
