// Tests for pickLoopbackPort's blocked-port handling. Fake servers hand out scripted ports; nothing binds a socket.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickLoopbackPort } from '../loader/launch.mjs';

// Each created server reports the next scripted port (the last one repeats) and records whether it was closed.
function scriptedServers(ports) {
  const created = [];
  const createServer = () => {
    const port = ports[Math.min(created.length, ports.length - 1)];
    const rec = { port, closed: false };
    created.push(rec);
    return {
      once() {},
      listen(_port, _host, cb) {
        cb();
      },
      address: () => ({ port: rec.port }),
      close(cb) {
        rec.closed = true;
        cb();
      },
    };
  };
  return { createServer, created };
}

test('pickLoopbackPort skips blocked ports, closes their servers, and resolves the first free port', async () => {
  // Given: the OS hands out two blocked ports before a free one
  const { createServer, created } = scriptedServers([6665, 6666, 7000]);
  // When
  const port = await pickLoopbackPort({ createServer });
  // Then: the free port is returned and both blocked servers were closed
  assert.equal(port, 7000);
  assert.deepEqual(created.map((s) => s.closed), [true, true, true]);
});

test('pickLoopbackPort returns a free first port with a single server', async () => {
  // Given: the OS hands out a free port first
  const { createServer, created } = scriptedServers([7000]);
  // When
  const port = await pickLoopbackPort({ createServer });
  // Then: no retry happened
  assert.equal(port, 7000);
  assert.equal(created.length, 1);
});

test('pickLoopbackPort rejects after the bounded attempts when every port is blocked', async () => {
  // Given: the OS only ever hands out a blocked port
  const { createServer, created } = scriptedServers([6665]);
  // When / Then: the call rejects, and every server it opened was closed
  await assert.rejects(pickLoopbackPort({ createServer }), /no unblocked loopback port/);
  assert.equal(created.length, 50, 'it retried exactly the bounded number of attempts');
  assert.ok(created.every((s) => s.closed), 'no server was left listening');
});
