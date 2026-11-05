import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { dialogArgs, flagsHoldShift, isAlive, listProcesses, parsePs, portOwner } from '../src/core/proc.mjs';

test('parsePs reads pid, ppid and an executable path containing spaces', () => {
  const rows = parsePs('  1     0 /sbin/launchd\n 42     1 /Applications/Omo Mods.app/Contents/MacOS/OmO \ngarbage\n');
  assert.deepEqual(rows, [
    { pid: 1, ppid: 0, exe: '/sbin/launchd' },
    { pid: 42, ppid: 1, exe: '/Applications/Omo Mods.app/Contents/MacOS/OmO' },
  ]);
});

test('listProcesses sees this process and isAlive agrees', () => {
  assert.ok(listProcesses().some((p) => p.pid === process.pid && p.ppid === process.ppid));
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(0), false);
  assert.equal(isAlive(2 ** 22 + 12345), false);
});

test('portOwner finds a listening loopback port and returns null for a free one', async () => {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    assert.equal(portOwner(port), process.pid);
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.equal(portOwner(port), null);
});

test('flagsHoldShift checks the Shift bit only', () => {
  assert.equal(flagsHoldShift('131072\n'), true);
  assert.equal(flagsHoldShift('256'), false);
  assert.equal(flagsHoldShift('oops'), false);
});

test('dialogArgs passes text as argv, not inside the script', () => {
  const args = dialogArgs('a "quoted" 문장');
  assert.equal(args.at(-2), 'a "quoted" 문장');
  assert.ok(args.filter((a, i) => args[i - 1] === '-e').every((s) => !s.includes('quoted')));
});
