import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { connect } from '../src/core/cdp.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(text) {
  const body = Buffer.from(text);
  const head = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  return Buffer.concat([head, body]);
}

// Reads one masked client text frame (payload < 65536).
function readFrame(buf) {
  let len = buf[1] & 127;
  let off = 2;
  if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
  const mask = buf.subarray(off, off + 4);
  const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
  return data.toString();
}

// Tiny CDP endpoint: echoes {id, result:{method, sessionId}} and errors on method "Bad.call".
async function startServer({ upgrade = true, onSilent = () => {} } = {}) {
  const server = http.createServer();
  const sockets = new Set();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    if (!upgrade) return;
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (chunk) => {
      if ((chunk[0] & 15) === 8) return socket.end();
      const msg = JSON.parse(readFrame(chunk));
      if (msg.method === 'Bad.call') socket.write(frame(JSON.stringify({ id: msg.id, error: { message: 'nope' } })));
      else if (msg.method === 'Silent.call') onSilent();
      else {
        socket.write(frame(JSON.stringify({ method: 'Evt.fired', params: { n: 1 }, sessionId: msg.sessionId })));
        socket.write(frame(JSON.stringify({ id: msg.id, result: { method: msg.method, sessionId: msg.sessionId ?? null } })));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const close = async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  };
  return { url: `ws://127.0.0.1:${server.address().port}`, close };
}

test('send correlates replies, forwards sessionId and delivers events', async () => {
  const srv = await startServer();
  const cdp = await connect(srv.url);
  try {
    const event = new Promise((resolve) => cdp.on('Evt.fired', (params, sessionId) => resolve({ params, sessionId })));
    const res = await cdp.send('Runtime.enable', {}, { sessionId: 'S1' });
    assert.deepEqual(res, { method: 'Runtime.enable', sessionId: 'S1' });
    assert.deepEqual(await event, { params: { n: 1 }, sessionId: 'S1' });
    assert.deepEqual(await cdp.send('Page.enable'), { method: 'Page.enable', sessionId: null });
    await assert.rejects(cdp.send('Bad.call'), /Bad\.call: nope/);
  } finally {
    cdp.close();
    await srv.close();
  }
});

test('send times out and close rejects pending requests and fires close', async () => {
  let seen = 0;
  let secondArrived;
  const second = new Promise((resolve) => { secondArrived = resolve; });
  const srv = await startServer({ onSilent: () => { if (++seen === 2) secondArrived(); } });
  const cdp = await connect(srv.url);
  try {
    await assert.rejects(cdp.send('Silent.call', {}, { timeoutMs: 50 }), /timed out after 50ms/);
    const closed = new Promise((resolve) => cdp.on('close', resolve));
    const pending = assert.rejects(cdp.send('Silent.call'), /socket closed/);
    await second;
    cdp.close();
    await pending;
    await closed;
  } finally {
    await srv.close();
  }
});

test('connect rejects on a refused port and on a handshake that never completes', async () => {
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  await assert.rejects(connect(`ws://127.0.0.1:${port}`), /cdp connect failed/);
  const srv = await startServer({ upgrade: false });
  try {
    await assert.rejects(connect(srv.url, { openTimeoutMs: 100 }), /timed out after 100ms/);
  } finally {
    await srv.close();
  }
});
