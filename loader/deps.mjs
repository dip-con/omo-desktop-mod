// Real operating-system dependencies for the loader's main flow (launch.mjs). Tests never reach these effects;
// they pass fakes into runLaunch instead.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT_VAR, pickLoopbackPort, sameExe } from './launch.mjs';
import { readFingerprint, buildKey } from './fingerprint.mjs';
import { discoverMods, modsRootFor, partitionEnabled } from './mods.mjs';
import { serveMainWindows, loadModSources } from './inject.mjs';
import { ownerAllowed } from './ownership.mjs';
import { watchApp } from './lifecycle.mjs';
import { pidAlive } from './pid.mjs';
import { mainRuleFromFacts } from './target.mjs';

const loaderDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_APP_EXE = path.join(os.userInfo().homedir, 'AppData', 'Local', 'Programs', 'omo', 'OmO.exe');
// LOADER_STATE_DIR moves the state file, lock and logs (tests and subprocess checks). Default: %LOCALAPPDATA%.
const stateDir = process.env.LOADER_STATE_DIR || path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'omo-app-mods');
const stateFile = path.join(stateDir, 'state.json');
const logDir = path.join(stateDir, 'logs');
const WATCHDOG_TEXT = '화면이 비어 있거나 모드 오류가 나서 모드를 떼고 원래 화면으로 다시 열었어요.';

export function readConfigAppExe() {
  const file = path.join(loaderDir, 'config.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).appExe : DEFAULT_APP_EXE;
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

const POWERSHELL_TIMEOUT_MS = 15000;

// Options for every PowerShell query. A query that hangs (a stuck WMI provider) is killed after the timeout and throws,
// the same way a non-zero exit does, so each caller already handles it.
export function powershellOptions(env = {}) {
  return { encoding: 'utf8', env: { ...process.env, ...env }, timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true };
}

function powershell(script, env = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], powershellOptions(env)).trim();
}

// Pure: the rows (CIM JSON, one object or an array) whose executable is appExe. sameExe normalises case and slashes.
export function omoProcessesFrom(rows, appExe) {
  return [rows]
    .flat()
    .filter((r) => r.ExecutablePath && sameExe(r.ExecutablePath, appExe))
    .map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, exePath: r.ExecutablePath }));
}

// OmO processes whose executable is the installed OmO.exe.
function omoProcesses(appExe) {
  const out = powershell("Get-CimInstance Win32_Process -Filter \"Name='OmO.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress");
  if (out === '') return [];
  return omoProcessesFrom(JSON.parse(out), appExe);
}

// Process start time in ms (UTC), or null when the pid is gone. Used to detect a reused pid in a lock.
function startTimeOf(pid) {
  try {
    return Number(powershell(`[DateTimeOffset]::new((Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`));
  } catch {
    return null;
  }
}

// Child lookup over all processes (one query), used for the owner-tree check.
function processChildren() {
  const rows = [JSON.parse(powershell('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'))].flat();
  return (pid) => rows.filter((r) => r.ParentProcessId === pid).map((r) => r.ProcessId);
}

// PID listening on the port, or null.
function portOwner(port) {
  const out = powershell(`(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`);
  return out === '' ? null : Number(out);
}

// OMO_PROFILE from the spawn environment, else from HKCU\Environment. Read only: never changed or cleared.
export function readOmoProfileWith(env, run = powershell) {
  if (env.OMO_PROFILE) return env.OMO_PROFILE;
  const value = run("(Get-ItemProperty -Path 'HKCU:\\Environment' -Name OMO_PROFILE -ErrorAction SilentlyContinue).OMO_PROFILE");
  return value === '' ? null : value;
}

// Pure: whether the Shift key is in the ModifierKeys output ("None", "Shift" or "Control, Shift").
export function modifierKeysHoldShift(text) {
  return text.split(/[\s,]+/).includes('Shift');
}

// Shift state from its own PowerShell call. It does not go through powershell() or readOmoProfileWith, so it works with OMO_PROFILE set.
const MODIFIER_SCRIPT = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Control]::ModifierKeys';

// `run` takes a PowerShell script and its env and returns stdout; tests pass a spy. The default runs powershell.exe directly.
export function shiftHeldWith(run = (script, env) => execFileSync('powershell.exe', ['-NoProfile', '-Command', script], powershellOptions(env)), env = process.env) {
  return modifierKeysHoldShift(run(MODIFIER_SCRIPT, env));
}

async function answers(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? r.json() : null;
  } catch {
    return null;
  }
}

// Message box without blocking the loader: the box is a separate PowerShell process that the loader does not wait for.
export function defaultMessageBox(text) {
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', 'Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:LOADER_MESSAGE_TEXT, "OmO (모드)") | Out-Null'], {
    env: { ...process.env, LOADER_MESSAGE_TEXT: text },
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  child.unref();
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
  const appExe = readConfigAppExe();
  const appDir = path.dirname(appExe);
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
    omoProcesses: () => omoProcesses(appExe),
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
    // Plain start: OmO.exe with no arguments and the debug-port variable removed. Detached and never waited for.
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
    fingerprint: () => readFingerprint(appDir),
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
      fingerprint: () => readFingerprint(appDir),
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
