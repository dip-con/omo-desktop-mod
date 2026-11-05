// Read-only system queries and a non-blocking dialog. Every shell call has a timeout and LC_ALL=C.
// Nothing here starts, quits or signals another process.
import { execFileSync, spawn } from 'node:child_process';

const TIMEOUT_MS = 15000;
const SHIFT_FLAG = 0x20000;
const DIALOG_TITLE = 'OmO Mods';

function run(file, args) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, LC_ALL: 'C' },
  }).trim();
}

// Pure: rows of `ps -axww -o pid=,ppid=,comm=`. On macOS comm is the full executable path.
export function parsePs(text) {
  return text
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), exe: m[3] }));
}

export const listProcesses = () => parsePs(run('ps', ['-axww', '-o', 'pid=,ppid=,comm=']));

// Existence check only (signal 0 delivers nothing). EPERM still means the process exists.
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// PID listening on the TCP port, or null. lsof exits 1 when nothing listens.
export function portOwner(port) {
  try {
    const first = run('lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t']).split('\n')[0];
    return first ? Number(first) : null;
  } catch {
    return null;
  }
}

// Pure: whether the NSEvent.modifierFlags number printed by osascript has the Shift bit.
export function flagsHoldShift(text) {
  const flags = Number(String(text).trim());
  return Number.isInteger(flags) && (flags & SHIFT_FLAG) !== 0;
}

export function shiftHeld() {
  try {
    return flagsHoldShift(run('osascript', ['-l', 'JavaScript', '-e', "ObjC.import('AppKit'); $.NSEvent.modifierFlags"]));
  } catch {
    return false;
  }
}

// osascript arguments: text and title travel as argv, so nothing is quoted into the script.
export function dialogArgs(text, title = DIALOG_TITLE) {
  return [
    '-e', 'on run argv',
    '-e', 'display dialog (item 1 of argv) with title (item 2 of argv) buttons {"확인"} default button 1',
    '-e', 'end run',
    text, title,
  ];
}

// Shows a message box in a detached osascript process and does not wait for it.
export function dialog(text) {
  const child = spawn('osascript', dialogArgs(text), { stdio: 'ignore', detached: true, env: { ...process.env, LC_ALL: 'C' } });
  child.on('error', () => {});
  child.unref();
}
