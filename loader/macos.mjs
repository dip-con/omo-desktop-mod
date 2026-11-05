// macOS system queries for the loader: processes from ps, the port owner from lsof, OMO_PROFILE from launchd, the
// Shift state and the message box from osascript. Every query is read only; nothing here starts or signals OmO.
import { execFileSync, spawn } from 'node:child_process';
import { sameExe } from './launch.mjs';

const BOX_TITLE = 'OmO (모드)';

const QUERY_TIMEOUT_MS = 15000;

// Options for every system query. A query that hangs is killed after the timeout and throws, the same way a non-zero
// exit does, so each caller already handles it. LC_ALL=C keeps ps dates in one English format.
export function queryOptions(env = {}) {
  return { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', ...env }, timeout: QUERY_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] };
}

function query(file, args) {
  return execFileSync(file, args, queryOptions()).trim();
}

// Pure: rows of `ps -axo pid=,ppid=,comm=` as {pid, ppid, exePath}. On macOS comm is the full executable path.
export function parsePsRows(text) {
  return text
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), exePath: m[3] }));
}

// Pure: the ps rows whose executable is appExe.
export function omoProcessesFrom(text, appExe) {
  return parsePsRows(text).filter((r) => sameExe(r.exePath, appExe));
}

// Pure: which OmO processes count as running. With OMO_DESKTOP_HOME set (an isolated instance), only the pid this
// loader recorded in its state counts, and only while it is alive; other OmO processes on the machine are ignored.
export function selectOmoProcesses({ env, state, appExe, isAlive, listAll }) {
  if (env.OMO_DESKTOP_HOME) {
    const pid = state?.omoPid;
    return Number.isInteger(pid) && isAlive(pid) ? [{ pid, ppid: null, exePath: appExe }] : [];
  }
  return listAll();
}

export function omoProcesses(appExe) {
  return omoProcessesFrom(query('ps', ['-axo', 'pid=,ppid=,comm=']), appExe);
}

// Process start time in ms, or null when the pid is gone. Used to detect a reused pid in a lock.
export function startTimeOf(pid) {
  try {
    const ms = Date.parse(query('ps', ['-o', 'lstart=', '-p', String(Number(pid))]));
    return Number.isNaN(ms) ? null : ms;
  } catch {
    return null;
  }
}

// Child lookup over all processes (one query), used for the owner-tree check.
// Pure: a children-of lookup over the rows of `ps -axo pid=,ppid=`.
export function childrenFrom(text) {
  const rows = text
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s*$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]) }));
  return (pid) => rows.filter((r) => r.ppid === pid).map((r) => r.pid);
}

export function processChildren() {
  return childrenFrom(query('ps', ['-axo', 'pid=,ppid=']));
}

// PID listening on the port, or null. lsof exits 1 when nothing listens.
export function portOwner(port) {
  try {
    const first = query('lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t']).split('\n')[0];
    return first ? Number(first) : null;
  } catch {
    return null;
  }
}

// OMO_PROFILE from the spawn environment, else from the launchd user environment. Read only: never set or unset.
// `run(file, args)` returns stdout; tests pass a spy.
export function readOmoProfileWith(env, run = query) {
  if (env.OMO_PROFILE) return env.OMO_PROFILE;
  const value = run('launchctl', ['getenv', 'OMO_PROFILE']);
  return value === '' ? null : value;
}

// NSEventModifierFlagShift.
const SHIFT_FLAG = 0x20000;

// Pure: whether the NSEvent.modifierFlags number printed by osascript has the Shift bit.
export function modifierFlagsHoldShift(text) {
  const flags = Number(String(text).trim());
  return Number.isInteger(flags) && (flags & SHIFT_FLAG) !== 0;
}

export const MODIFIER_SCRIPT = "ObjC.import('AppKit'); $.NSEvent.modifierFlags";

// Shift state from its own osascript call, independent of readOmoProfileWith. `run(file, args, env)` returns stdout.
export function shiftHeldWith(run = (file, args, env) => execFileSync(file, args, queryOptions(env)), env = process.env) {
  return modifierFlagsHoldShift(run('osascript', ['-l', 'JavaScript', '-e', MODIFIER_SCRIPT], env));
}

// The osascript arguments of a dialog: the text and title travel as argv, so nothing is quoted into the script.
export function dialogArgs(text, title = BOX_TITLE) {
  return ['-e', 'on run argv', '-e', 'display dialog (item 1 of argv) with title (item 2 of argv) buttons {"확인"} default button 1', '-e', 'end run', text, title];
}

// Message box without blocking the loader: the dialog is a separate osascript process that the loader does not wait for.
export function defaultMessageBox(text) {
  const child = spawn('osascript', dialogArgs(text), { stdio: 'ignore', detached: true });
  child.on('error', () => {});
  child.unref();
}

