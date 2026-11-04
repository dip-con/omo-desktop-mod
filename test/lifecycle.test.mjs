// Supervision after OmO is up (loader/lifecycle.mjs). Every clock, probe, pid check and socket is a fake the test
// controls; the timer queue runs only when the test advances the fake clock. No real sleeps, no wall clock.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { EXIT_ENDPOINT_LOST, EXIT_OMO_GONE, watchApp } from '../loader/lifecycle.mjs';

const LOADER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'loader');

function world({ omoAlive, endpointUp }) {
  const clock = { t: 0 };
  const queue = [];
  const events = [];
  const s = { omoAlive, endpointUp, reconnects: 0, reconnectFails: false };
  const sockets = [];
  const socket = () => {
    let close;
    const done = new Promise((resolve) => {
      close = resolve;
    });
    const handle = { done, close };
    sockets.push(handle);
    return handle;
  };
  const h = watchApp({
    omoPid: 4242,
    first: socket(),
    reconnect: async () => {
      s.reconnects += 1;
      if (s.reconnectFails) throw new Error('endpoint refused');
      return socket();
    },
    probeVersion: async () => (s.endpointUp ? { webSocketDebuggerUrl: 'ws://127.0.0.1:1/x' } : null),
    pidAlive: () => s.omoAlive,
    now: () => clock.t,
    schedule: (fn, ms) => queue.push({ at: clock.t + ms, fn }),
    emit: (ev) => events.push(ev),
    pollMs: 100,
  });
  // Runs every queued timer due by the new time, in order, awaiting each one.
  const advance = async (ms) => {
    const end = clock.t + ms;
    for (;;) {
      const due = queue.filter((q) => q.at <= end).sort((a, b) => a.at - b.at);
      if (due.length === 0) break;
      const next = due[0];
      queue.splice(queue.indexOf(next), 1);
      clock.t = next.at;
      await next.fn();
    }
    clock.t = end;
    await h.idle();
  };
  const loseSocket = async (i) => {
    sockets[i].close();
    await h.idle();
  };
  return { h, s, sockets, events, queue, advance, loseSocket };
}

test('socket closed and OmO gone: the helper ends with the OmO-gone code', async () => {
  const w = world({ omoAlive: false, endpointUp: false });
  await w.loseSocket(0);
  assert.ok(w.events.some((e) => e.kind === 'exit' && e.code === EXIT_OMO_GONE));
  assert.equal(await w.h.exitCode, EXIT_OMO_GONE);
});

test('socket closed, OmO alive, endpoint failing: no exit at 9.9 s, exit with the endpoint-lost code at 10 s', async () => {
  const w = world({ omoAlive: true, endpointUp: false });
  await w.loseSocket(0);
  await w.advance(9900);
  assert.equal(w.events.filter((e) => e.kind === 'exit').length, 0);
  assert.equal(w.queue.length, 1, 'still polling');
  await w.advance(100);
  assert.ok(w.events.some((e) => e.kind === 'exit' && e.code === EXIT_ENDPOINT_LOST));
  assert.equal(await w.h.exitCode, EXIT_ENDPOINT_LOST);
});

test('socket closed, OmO alive, endpoint answering: re-attaches once per loss and schedules nothing', async () => {
  const w = world({ omoAlive: true, endpointUp: true });
  await w.loseSocket(0);
  assert.equal(w.s.reconnects, 1);
  assert.equal(w.queue.length, 0, 'no polling loop after a successful re-attach');
  assert.ok(w.events.some((e) => e.kind === 'reattach'));
  await w.advance(100);
  await w.loseSocket(1);
  assert.equal(w.s.reconnects, 2);
  assert.equal(w.queue.length, 0);
});

test('endpoint answers but the re-attach fails: the helper stays and retries on the schedule', async () => {
  const w = world({ omoAlive: true, endpointUp: true });
  w.s.reconnectFails = true;
  await w.loseSocket(0);
  assert.equal(w.events.filter((e) => e.kind === 'exit').length, 0);
  assert.ok(w.events.some((e) => e.kind === 'reattach-failed'));
  assert.equal(w.queue.length, 1);
});

test('a socket that closes as soon as it opens is reattached at most once per poll interval', async () => {
  // Given: OmO alive and the endpoint answering; the first loss reattaches at once
  const w = world({ omoAlive: true, endpointUp: true });
  await w.loseSocket(0);
  assert.equal(w.s.reconnects, 1);
  // When: the new socket closes at the same fake instant it opened
  w.sockets[1].close();
  await w.h.idle();
  // Then: no second reattach until one poll interval (100 ms fake) has passed
  assert.equal(w.s.reconnects, 1);
  await w.advance(100);
  assert.equal(w.s.reconnects, 2);
  w.sockets[2].close();
  await w.h.idle();
  assert.equal(w.s.reconnects, 2);
  await w.advance(100);
  assert.equal(w.s.reconnects, 3);
});

// Only the liveness probe may signal a process: process.kill(<pid>, 0) in pid.mjs. Every other kill fails this test, in any
// spelling: process.kill(...), .kill(...), ['kill'](...), PowerShell .Kill(), taskkill, Stop-Process, CIM Terminate.
const SIGNAL_0 = /process\.kill\(\s*[A-Za-z_$][\w$]*\s*,\s*0\s*\)/g;
const KILL_CALL = /(?:\.|\[\s*['"`])kill\b|taskkill|stop-process|-MethodName\s*['"]?terminate|\.terminate\s*\(/gi;
test('loader code signals no process except the signal-0 liveness probe in pid.mjs', () => {
  const hits = [];
  for (const name of fs.readdirSync(LOADER).filter((n) => /\.(mjs|js)$/.test(n))) {
    const text = fs.readFileSync(path.join(LOADER, name), 'utf8');
    const kills = text.match(KILL_CALL)?.length ?? 0;
    const probes = name === 'pid.mjs' ? (text.match(SIGNAL_0)?.length ?? 0) : 0;
    if (kills !== probes) hits.push(`${name}: kill call`);
  }
  assert.deepEqual(hits, []);
});
