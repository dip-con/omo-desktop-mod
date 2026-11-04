// Tests for the shared loopback listener used by test servers. A scripted fake server reports the ports it is given.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listenOnLoopback } from './helpers/listen-loopback.mjs';

// listen() reports the next scripted port (the last one repeats); close() records which port was released.
function scriptedServer(ports) {
  const listens = [];
  const closed = [];
  let current = null;
  return {
    listens,
    closed,
    once() {},
    listen(port, host, cb) {
      current = ports[Math.min(listens.length, ports.length - 1)];
      listens.push({ port, host });
      cb();
    },
    address: () => ({ port: current }),
    close(cb) {
      closed.push(current);
      cb();
    },
  };
}

test('listenOnLoopback releases a blocked port and resolves the next one', async () => {
  // Given: the OS hands out a blocked port first
  const server = scriptedServer([6665, 7000]);
  // When
  const port = await listenOnLoopback(server);
  // Then: the free port is returned, the blocked one was released, and every bind used the loopback host
  assert.equal(port, 7000);
  assert.deepEqual(server.closed, [6665]);
  assert.deepEqual(server.listens, [{ port: 0, host: '127.0.0.1' }, { port: 0, host: '127.0.0.1' }]);
});

test('listenOnLoopback keeps a free first port without a retry', async () => {
  // Given: the OS hands out a free port first
  const server = scriptedServer([7000]);
  // When
  const port = await listenOnLoopback(server);
  // Then
  assert.equal(port, 7000);
  assert.equal(server.listens.length, 1);
  assert.deepEqual(server.closed, []);
});
