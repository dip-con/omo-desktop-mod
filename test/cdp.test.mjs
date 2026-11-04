// Tests for loader/cdp.mjs against a loopback WebSocket server (test/helpers/ws-server.mjs).
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { connect } from '../loader/cdp.mjs';
import { listenOnLoopback } from './helpers/listen-loopback.mjs';
import { startWsServer } from './helpers/ws-server.mjs';

// Every test starts its own server and closes it, so tests do not share sockets.
async function withServer(onMessage, body) {
  const server = await startWsServer(onMessage);
  try {
    await body(server);
  } finally {
    await server.close();
  }
}

test('send resolves each request with its own response when two are in flight', async () => {
  // Given: a server that answers each request with its method and params echoed back
  await withServer((text, conn) => {
    const msg = JSON.parse(text);
    // Reply in reverse order so correlation, not arrival order, decides the result.
    setImmediate(() => conn.send(JSON.stringify({ id: msg.id, result: { method: msg.method, params: msg.params } })));
  }, async (server) => {
    const cdp = await connect(server.url);
    // When: two requests are sent before either answer arrives
    const [a, b] = await Promise.all([
      cdp.send('Test.alpha', { n: 1 }),
      cdp.send('Test.beta', { n: 2 }),
    ]);
    // Then: each promise carries the answer to its own request
    assert.deepEqual(a, { method: 'Test.alpha', params: { n: 1 } });
    assert.deepEqual(b, { method: 'Test.beta', params: { n: 2 } });
    cdp.close();
  });
});

test('a protocol error reply rejects with the method name and the message', async () => {
  // Given: a server that rejects every request
  await withServer((text, conn) => {
    const msg = JSON.parse(text);
    conn.send(JSON.stringify({ id: msg.id, error: { message: 'No target with given id' } }));
  }, async (server) => {
    const cdp = await connect(server.url);
    // When/Then: the call rejects and the error names the method
    await assert.rejects(cdp.send('Target.attachToTarget', {}), (err) => {
      assert.equal(err.message, 'Target.attachToTarget: No target with given id');
      return true;
    });
    cdp.close();
  });
});

test('an event is delivered to its listener with its params and session id', async () => {
  // Given: a server that pushes an event tagged with a session id after the first request
  await withServer((text, conn) => {
    const msg = JSON.parse(text);
    conn.send(JSON.stringify({ id: msg.id, result: {} }));
    conn.send(JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 7 }, sessionId: 'S1' }));
  }, async (server) => {
    const cdp = await connect(server.url);
    // When: a listener is subscribed before the request that triggers the event
    const received = new Promise((resolve) => cdp.on('Page.loadEventFired', (params, sessionId) => resolve({ params, sessionId })));
    await cdp.send('Page.enable', {}, { sessionId: 'S1' });
    // Then: the listener receives the params and the session id
    assert.deepEqual(await received, { params: { timestamp: 7 }, sessionId: 'S1' });
    cdp.close();
  });
});

test('send includes the session id in the frame only when one is given', async () => {
  // Given: a server that records every frame it receives
  const frames = [];
  await withServer((text, conn) => {
    const msg = JSON.parse(text);
    frames.push(msg);
    conn.send(JSON.stringify({ id: msg.id, result: {} }));
  }, async (server) => {
    const cdp = await connect(server.url);
    // When: one request with a session and one without
    await cdp.send('Runtime.enable');
    await cdp.send('Runtime.enable', {}, { sessionId: 'S9' });
    // Then: only the second frame carries the sessionId key
    assert.equal('sessionId' in frames[0], false);
    assert.equal(frames[1].sessionId, 'S9');
    cdp.close();
  });
});

test('a request with no answer rejects after its timeout', async () => {
  // Given: a server that never answers the method
  await withServer(() => {}, async (server) => {
    const cdp = await connect(server.url);
    // When/Then: the call rejects with the timeout message, not a hang
    await assert.rejects(cdp.send('Test.never', {}, { timeoutMs: 50 }), /Test\.never timed out after 50ms/);
    cdp.close();
  });
});

test('connect rejects after its open deadline when the endpoint accepts TCP but never completes the handshake', { timeout: 10000 }, async () => {
  // Given: a loopback TCP server that accepts sockets and never writes a byte
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  const port = await listenOnLoopback(server);
  // A bounded guard: if connect never settles, the outcome is this message instead of a hang.
  let deadline;
  const noAnswer = new Promise((resolve) => {
    deadline = setTimeout(() => resolve('no settle within 5000ms'), 5000);
  });
  try {
    // When: connect is given a 50 ms open deadline
    const outcome = await Promise.race([
      connect(`ws://127.0.0.1:${port}/`, { openTimeoutMs: 50 }).then(() => 'resolved', (err) => err),
      noAnswer,
    ]);
    clearTimeout(deadline);
    // Then: it rejects with the deadline error
    assert.ok(outcome instanceof Error, String(outcome));
    assert.match(outcome.message, /timed out after 50ms/);
  } finally {
    clearTimeout(deadline);
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('closing the socket rejects pending requests and fires the close listener', async () => {
  // Given: a server that drops the connection on receiving a request
  let dropNow;
  const dropped = new Promise((resolve) => {
    dropNow = resolve;
  });
  await withServer(() => dropNow(), async (server) => {
    const cdp = await connect(server.url);
    const closed = new Promise((resolve) => cdp.on('close', resolve));
    // When: the request is in flight when the server drops the socket
    const pendingCall = cdp.send('Test.hang', {}, { timeoutMs: 5000 });
    await dropped;
    server.dropAll();
    // Then: the pending call rejects and the close listener runs
    await assert.rejects(pendingCall, /cdp socket closed/);
    await closed;
  });
});
