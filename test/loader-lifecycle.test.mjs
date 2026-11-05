import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXIT_ENDPOINT_LOST, EXIT_OMO_GONE, supervise } from '../src/loader/lifecycle.mjs';

// A socket handle whose close the test controls, and a manual clock + scheduler.
const flush = () => new Promise(setImmediate);
function handle() {
  let close;
  return { done: new Promise((r) => (close = r)), close: () => close() };
}
function clock() {
  const queue = [];
  let t = 0;
  return {
    now: () => t,
    schedule: (fn, ms) => queue.push({ fn, at: t + ms }),
    async runNext() {
      await flush();
      const next = queue.shift();
      t = next.at;
      await next.fn();
    },
  };
}

test('socket closed and OmO gone -> exit 0', async () => {
  const first = handle();
  const c = clock();
  const code = supervise({ omoPid: 5, first, reconnect: async () => handle(), probe: async () => false, isAlive: () => false, now: c.now, schedule: c.schedule });
  first.close();
  assert.equal(await code, EXIT_OMO_GONE);
});

test('socket closed while OmO lives and the port answers -> reconnect', async () => {
  const first = handle();
  const second = handle();
  let alive = true;
  const c = clock();
  let reconnects = 0;
  let reconnected;
  const seen = new Promise((r) => (reconnected = r));
  const code = supervise({ omoPid: 5, first, reconnect: async () => (reconnects += 1, reconnected(), second), probe: async () => true, isAlive: () => alive, now: c.now, schedule: c.schedule });
  first.close();
  await seen;
  assert.equal(reconnects, 1);
  alive = false;
  second.close();
  await c.runNext();
  assert.equal(await code, EXIT_OMO_GONE);
});

test('endpoint down for the grace period while OmO lives -> exit 5', async () => {
  const first = handle();
  const c = clock();
  const code = supervise({ omoPid: 5, first, reconnect: async () => handle(), probe: async () => false, isAlive: () => true, now: c.now, schedule: c.schedule });
  first.close();
  let result = null;
  code.then((v) => (result = v));
  for (let i = 0; i < 20 && result === null; i += 1) await c.runNext().then(flush);
  assert.equal(result, EXIT_ENDPOINT_LOST);
});
