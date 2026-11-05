// Real operating-system dependencies for launch.mjs, plus the small pure helpers they use (tested directly).
// macOS only. Nothing here quits or signals OmO.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appInfo } from '../core/app.mjs';
import { connect as connectCdp } from '../core/cdp.mjs';
import { readJson, writeJsonAtomic } from '../core/fsx.mjs';
import { APP_BUNDLE, appExe, modsHome as modsHomeOf, stateDir as stateDirOf } from '../core/paths.mjs';
import { dialog, isAlive, listProcesses, portOwner, shiftHeld } from '../core/proc.mjs';
import { attach } from './inject.mjs';
import { PORT_VAR } from './launch.mjs';
import { supervise } from './lifecycle.mjs';

export const LOG_KEEP = 10;
export const WAIT_FOR_PORT_MS = 60000;
const LOOPBACK = '127.0.0.1';
const WATCHDOG_TEXT = '화면이 비어 있거나 모드 오류가 나서 모드를 떼고 원래 화면으로 다시 열었어요.';
// src/ in a checkout, _loader/ when installed: config.json beside core/ and loader/ may name the app bundle.
const LOADER_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function appBundleFrom(loaderRoot) {
  const app = readJson(path.join(loaderRoot, 'config.json'), {})?.app;
  return typeof app === 'string' && app !== '' ? app : APP_BUNDLE;
}

// Main OmO processes: any bundle's Contents/MacOS/OmO executable (helpers live under Frameworks).
export const omoMains = (procs) => procs.filter((p) => p.exe.endsWith('/Contents/MacOS/OmO'));

// True when pid is one of roots or a descendant of one (ppid chain in procs).
export function inTree(pid, roots, procs) {
  const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
  const seen = new Set();
  for (let cur = pid; Number.isInteger(cur) && cur > 1 && !seen.has(cur); cur = parent.get(cur)) {
    if (roots.includes(cur)) return true;
    seen.add(cur);
  }
  return false;
}

// One log per launch, named by UTC time so names sort by age; the oldest beyond `keep` are removed.
export function openLog(logDir, iso, keep = LOG_KEEP) {
  fs.mkdirSync(logDir, { recursive: true });
  const old = fs.readdirSync(logDir).filter((n) => n.startsWith('launch-')).sort();
  for (const name of old.slice(0, Math.max(0, old.length - (keep - 1)))) fs.rmSync(path.join(logDir, name), { force: true });
  const file = path.join(logDir, `launch-${iso.replace(/[:.]/g, '-')}.log`);
  return (line) => fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
}

// The state.json mods list after one inject event. hostFailed: Set of mod ids whose host failed since the last reload.
export function nextMods(mods, ev, hostFailed) {
  const mark = (id, reason) => mods.map((m) => (m.id === id ? { ...m, attached: false, reason } : m));
  const shape = (m) => ({ id: m.id, attached: m.attached, reason: m.reason ?? null });
  switch (ev.kind) {
    case 'plan':
      return [...ev.states, ...ev.reported].map((m) => shape(hostFailed.has(m.id) ? { ...m, attached: false, reason: 'HOST_FAILED' } : m));
    case 'host-failed':
      return mark(ev.mod, 'HOST_FAILED');
    case 'fail':
      return mark(ev.mod, 'MOD_ERROR');
    case 'watchdog':
      return mods.map((m) => (m.attached ? { ...m, attached: false, reason: 'WATCHDOG' } : m));
    case 'reloaded':
      return ev.reported.map(shape);
    default:
      return mods;
  }
}

export async function portAnswers(port) {
  try {
    const r = await fetch(`http://${LOOPBACK}:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// An ephemeral loopback port (macOS ephemeral ports lie above every port fetch/WebSocket refuse).
export function pickPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function realDeps({ planOnly = false, env = process.env } = {}) {
  const appBundle = appBundleFrom(LOADER_ROOT);
  const exe = appExe(appBundle);
  const stateDir = stateDirOf(env);
  const modsHome = modsHomeOf(env);
  const stateFile = path.join(stateDir, 'state.json');
  const log = openLog(path.join(stateDir, 'logs'), new Date().toISOString());
  const readState = () => readJson(stateFile, null);
  const writeState = (patch) => writeJsonAtomic(stateFile, { ...readState(), ...patch });
  const detached = (args, childEnv) => {
    const child = spawn(exe, args, { env: childEnv, detached: true, stdio: 'ignore' });
    child.on('error', (err) => log(`spawn failed: ${err.message}`));
    child.unref();
    return child.pid;
  };
  const hostFailed = new Set();
  const watchdogShown = new Set();
  const watchdogCounts = new Map();

  async function connect({ port }) {
    const info = await portAnswers(port);
    if (!info) throw new Error(`port ${port} does not answer`);
    const cdp = await connectCdp(info.webSocketDebuggerUrl);
    const done = new Promise((resolve) => cdp.on('close', resolve));
    const onEvent = (ev) => {
      log(`event ${ev.kind}${ev.mod ? ` ${ev.mod}` : ''}${ev.detail ? `: ${ev.detail}` : ''}`);
      if (ev.kind === 'host-failed') hostFailed.add(ev.mod);
      if (ev.kind === 'reloaded') hostFailed.clear();
      writeState({ mods: nextMods(readState()?.mods ?? [], ev, hostFailed) });
      if (ev.kind === 'watchdog' && !watchdogShown.has(ev.sessionId)) {
        watchdogShown.add(ev.sessionId);
        dialog(WATCHDOG_TEXT);
      }
    };
    const ownerOk = async () => {
      const procs = listProcesses();
      return inTree(portOwner(port), omoMains(procs).map((p) => p.pid), procs);
    };
    try {
      await attach(cdp, { modsHome, stateDir, ownerOk, onEvent, log, watchdogCounts });
    } catch (err) {
      cdp.close();
      throw err;
    }
    return { done };
  }

  return {
    appBundle,
    pid: process.pid,
    lockFile: path.join(stateDir, 'loader.lock'),
    log,
    report: (obj) => console.log(JSON.stringify(obj)),
    dialog: planOnly ? (text) => log(`plan-only dialog: ${text}`) : dialog,
    isAlive,
    now: Date.now,
    shiftHeld,
    appInfo: () => appInfo(appBundle),
    readState,
    writeState,
    omoProcesses: () => omoMains(listProcesses()),
    probe: async (state, processes) => {
      const port = state?.port;
      const answers = Number.isInteger(port) && processes.length > 0 ? (await portAnswers(port)) !== null : false;
      const procs = answers ? listProcesses() : [];
      return { appExists: fs.existsSync(exe), portAnswers: answers, ownerInTree: answers && inTree(portOwner(port), processes.map((p) => p.pid), procs) };
    },
    pickPort,
    spawnApp: (port) => detached([`--remote-debugging-address=${LOOPBACK}`], { ...env, [PORT_VAR]: String(port) }),
    plainStart: () => {
      const plainEnv = { ...env };
      delete plainEnv[PORT_VAR];
      detached([], plainEnv);
    },
    waitForPort: async (port) => {
      const deadline = Date.now() + WAIT_FOR_PORT_MS;
      while (Date.now() < deadline) {
        if (await portAnswers(port)) return true;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return false;
    },
    portAnswers: async (port) => (await portAnswers(port)) !== null,
    connect,
    supervise,
  };
}
