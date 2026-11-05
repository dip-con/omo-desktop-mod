// Real operating-system dependencies for the loader's main flow (launch.mjs). Tests never reach these effects;
// they pass fakes into runLaunch instead. macOS only: processes come from ps, the port owner from lsof, the boxes
// and the Shift state from osascript.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT_VAR, pickLoopbackPort } from './launch.mjs';
import { defaultMessageBox, omoProcesses, portOwner, processChildren, readOmoProfileWith, selectOmoProcesses, shiftHeldWith, startTimeOf } from './macos.mjs';
import { appResourcesDir, readFingerprint, buildKey } from './fingerprint.mjs';
import { discoverMods, modsRootFor, partitionEnabled } from './mods.mjs';
import { serveMainWindows, loadModSources } from './inject.mjs';
import { ownerAllowed } from './ownership.mjs';
import { watchApp } from './lifecycle.mjs';
import { pidAlive } from './pid.mjs';
import { mainRuleFromFacts } from './target.mjs';

export { appResourcesDir };
// The macOS queries keep their old import path for callers and tests.
export { childrenFrom, defaultMessageBox, dialogArgs, MODIFIER_SCRIPT, modifierFlagsHoldShift, omoProcessesFrom, parsePsRows, queryOptions, readOmoProfileWith, selectOmoProcesses, shiftHeldWith } from './macos.mjs';

const loaderDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP_BUNDLE = '/Applications/OmO.app';
const WATCHDOG_TEXT = '화면이 비어 있거나 모드 오류가 나서 모드를 떼고 원래 화면으로 다시 열었어요.';

// LOADER_STATE_DIR moves the state file, lock and logs (tests and subprocess checks).
export function defaultStateDir() {
  return process.env.LOADER_STATE_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'omo-app-mods');
}

const stateDir = defaultStateDir();
const stateFile = path.join(stateDir, 'state.json');
const logDir = path.join(stateDir, 'logs');

// The app bundle named by <loaderDir>/config.json "appBundle", else /Applications/OmO.app.
export function readConfigAppBundle() {
  const file = path.join(loaderDir, 'config.json');
  const bundle = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).appBundle : undefined;
  return typeof bundle === 'string' && bundle !== '' ? bundle : DEFAULT_APP_BUNDLE;
}

// The executable inside a bundle.
export function bundleExe(bundle) {
  return path.join(bundle, 'Contents', 'MacOS', 'OmO');
}

export function readConfigAppExe() {
  return bundleExe(readConfigAppBundle());
}

export function readState() {
  return fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
}

// Written to a temp file and renamed, so a reader never sees half a file.
export function writeStateFile(file, state, io = fs) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  io.writeFileSync(tmp, JSON.stringify(state, null, 2));
  io.renameSync(tmp, file);
}

function writeState(state) {
  writeStateFile(stateFile, state);
}

async function answers(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

export const LOG_KEEP = 10;

// Removes all but the newest `keep` launch logs (names sort by their UTC time).
export function pruneLogs(dir, keep = LOG_KEEP) {
  const names = fs.readdirSync(dir).filter((n) => n.startsWith('launch-')).sort();
  for (const old of names.slice(0, Math.max(0, names.length - keep))) fs.rmSync(path.join(dir, old), { force: true });
}

// One log per launch; this launch's file is the newest, so the older ones keep room for it.
function openLog(now) {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, `launch-${now.replace(/[:.]/g, '-')}.log`);
  pruneLogs(logDir, LOG_KEEP - 1);
  return (line) => fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
}

// One box per target for the whole launch: the set is keyed by the session that owns the target, so only the first
// watchdog event of a session shows it, whatever the reload count.
const watchdogBoxShown = new Set();
export function notifyWatchdog(ev, messageBox, shown = watchdogBoxShown) {
  if (ev.kind !== 'watchdog' || shown.has(ev.sessionId)) return;
  shown.add(ev.sessionId);
  messageBox(WATCHDOG_TEXT);
}

// Reported entries from the loader's own checks (disabled, unreadable mod.json, unreadable files).
function reportedFor({ disabled, badFormat, badFiles }) {
  return [
    ...disabled.map((m) => ({ id: m.id, name: m.nameKo ?? m.id, attached: false, reason: 'DISABLED' })),
    ...badFormat.map((s) => ({ id: s.id, name: s.id, attached: false, reason: 'BAD_FORMAT' })),
    ...badFiles.map((s) => ({ id: s.id, name: s.id, attached: false, reason: 'BAD_FILES' })),
  ];
}

// The inject step: the logic lives here, every OS or file effect comes in through io. realDeps passes the real functions.
export function wireInject(io) {
  const hostFailures = new Map();
  return async ({ port, omoProfile: profile }) => {
    const info = await io.answers(port);
    const facts = io.readFacts();
    // The mods are read again on every __reload: serveMainWindows calls resolveMods then.
    let current = { loaded: [], reported: [] };
    const resolveMods = () => {
      const discovered = io.discoverMods(io.modsRoot);
      const { active, disabled } = io.partitionEnabled(discovered.mods);
      const { loaded, skipped } = io.loadModSources(active, io.modsRoot);
      const reported = reportedFor({ disabled, badFormat: discovered.skipped, badFiles: skipped });
      for (const r of reported) io.log(`reported ${r.id}: ${r.reason}`);
      current = { loaded, reported };
      return current;
    };
    resolveMods();
    return io.serveMainWindows({
      wsUrl: info.webSocketDebuggerUrl,
      rule: io.mainRuleFromFacts(facts),
      resolveMods,
      omoProfile: profile,
      buildKey: io.buildKey(io.fingerprint()),
      loaderDir: io.loaderDir,
      ownerOk: async () => io.ownerAllowed({ ownerPid: io.portOwner(port), spawnedPid: io.readState()?.omoPid ?? null, childrenOf: io.processChildren() }),
      onEvent: (ev) => {
        io.log(`event ${ev.kind}`);
        const prev = io.readState() ?? {};
        if (ev.kind === 'host-failed') {
          hostFailures.set(ev.mod, ev.detail);
          io.writeState({ ...prev, mods: (prev.mods ?? []).map((m) => (m.id === ev.mod ? { ...m, attached: false, reason: 'HOST_FAILED' } : m)) });
        }
        if (ev.kind === 'plan') {
          const mods = [...ev.states, ...current.reported].map((m) => (hostFailures.has(m.id) ? { ...m, attached: false, reason: 'HOST_FAILED' } : m));
          io.writeState({ ...prev, mods, omoProfile: profile, pathname: ev.pathname });
        }
        if (ev.kind === 'fail') io.writeState({ ...prev, mods: (prev.mods ?? []).map((m) => (m.id === ev.mod ? { ...m, attached: false, reason: 'MOD_ERROR' } : m)) });
        if (ev.kind === 'watchdog') io.writeState({ ...prev, mods: current.loaded.map((m) => ({ id: m.id, attached: false, reason: 'WATCHDOG' })) });
        if (ev.kind === 'reloaded') io.writeState({ ...prev, mods: current.reported });
        notifyWatchdog(ev, io.messageBox);
      },
      log: io.log,
    });
  };
}

export function realDeps({ planOnly = false } = {}) {
  const appBundle = readConfigAppBundle();
  const appExe = bundleExe(appBundle);
  const log = openLog(new Date().toISOString());
  process.on('beforeExit', (code) => log(`process beforeExit ${code}`));
  process.on('exit', (code) => log(`process exit ${code}`));
  const factsFile = fs.existsSync(path.join(loaderDir, 'app-facts.json'))
    ? path.join(loaderDir, 'app-facts.json')
    : path.join(loaderDir, '..', 'docs', 'app-facts.json');
  const modsRoot = modsRootFor(loaderDir);
  const omoProfile = readOmoProfileWith(process.env);
  const deps = {
    osHome: os.userInfo().homedir,
    homedir: os.homedir(),
    env: process.env,
    appExe,
    omoProfile,
    lockFile: path.join(stateDir, 'loader.lock'),
    isAlive: pidAlive,
    startTimeOf,
    log,
    report: (obj) => {
      if (planOnly) console.log(JSON.stringify(obj));
    },
    // Plan-only never shows a box: the text goes to the log instead.
    messageBox: planOnly ? (text) => log(`plan-only message: ${text}`) : defaultMessageBox,
    omoProcesses: () => selectOmoProcesses({ env: process.env, state: readState(), appExe, isAlive: pidAlive, listAll: () => omoProcesses(appExe) }),
    readState,
    probe: async (state, processes) => {
      const port = state?.port;
      const info = Number.isInteger(port) ? await answers(port) : null;
      const owner = Number.isInteger(port) ? portOwner(port) : null;
      return {
        appExeExists: fs.existsSync(appExe),
        portResponds: info !== null,
        ownerInOmoTree: owner !== null && processes.some((p) => p.pid === owner),
      };
    },
    pickPort: () => pickLoopbackPort(),
    // Plain start: the bundle executable with no arguments and the debug-port variable removed. Detached and never waited for.
    plainStart: () => {
      const env = { ...process.env };
      delete env[PORT_VAR];
      const child = spawn(appExe, [], { env, detached: true, stdio: 'ignore' });
      child.on('error', (err) => log(`plain start failed: ${err.message}`));
      child.unref();
    },
    shiftHeld: () => shiftHeldWith(),
    spawn: (exe, args, opts) => {
      const child = spawn(exe, args, opts);
      child.unref();
      return child;
    },
    writeState,
    now: () => new Date().toISOString(),
    fingerprint: () => readFingerprint(appBundle),
    waitForVersion: async (port, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (await answers(port)) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return false;
    },
    // io.messageBox goes through deps.messageBox: plan-only never calls inject, and outside plan-only
    // deps.messageBox is defaultMessageBox, so the real behaviour is unchanged.
    inject: wireInject({
      answers,
      readFacts: () => JSON.parse(fs.readFileSync(factsFile, 'utf8')),
      discoverMods,
      partitionEnabled,
      loadModSources,
      mainRuleFromFacts,
      serveMainWindows,
      ownerAllowed,
      portOwner,
      processChildren,
      readState,
      writeState,
      messageBox: (text) => deps.messageBox(text),
      log,
      buildKey,
      fingerprint: () => readFingerprint(appBundle),
      loaderDir,
      modsRoot,
    }),
    // Supervises the attached session until OmO is gone or its endpoint stays down (see lifecycle.mjs).
    watch: ({ omoPid, port, first, omoProfile }) =>
      watchApp({
        omoPid,
        first,
        reconnect: () => deps.inject({ port, omoProfile }),
        probeVersion: () => answers(port),
        pidAlive,
        now: () => Date.now(),
        schedule: (fn, ms) => setTimeout(fn, ms),
        emit: (ev) => log(`watch ${ev.kind}${ev.code === undefined ? '' : ` ${ev.code}`}`),
      }),
  };
  return deps;
}
