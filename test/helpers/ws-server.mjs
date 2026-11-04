// Minimal WebSocket server for tests: node:http upgrade, RFC 6455 handshake, text frames only.
// It binds 127.0.0.1 on an ephemeral port and is the only server the tests start.
import crypto from 'node:crypto';
import http from 'node:http';
import { listenOnLoopback } from './listen-loopback.mjs';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeText(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Decodes complete client frames (always masked) from buf. Returns frames and the unread remainder.
function decodeFrames(buf) {
  const frames = [];
  let offset = 0;
  for (;;) {
    if (buf.length - offset < 2) break;
    const opcode = buf[offset] & 0x0f;
    const masked = (buf[offset + 1] & 0x80) !== 0;
    let len = buf[offset + 1] & 0x7f;
    let pos = offset + 2;
    if (len === 126) {
      if (buf.length - pos < 2) break;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (buf.length - pos < 8) break;
      len = Number(buf.readBigUInt64BE(pos));
      pos += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length - pos < maskLen + len) break;
    let payload = buf.subarray(pos + maskLen, pos + maskLen + len);
    if (masked) {
      const mask = buf.subarray(pos, pos + 4);
      payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    }
    frames.push({ opcode, payload });
    offset = pos + maskLen + len;
  }
  return { frames, rest: buf.subarray(offset) };
}

// Starts the server. onMessage(text, socket) runs for each text frame; socket.send(text) replies.
export async function startWsServer(onMessage) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let pending = Buffer.alloc(0);
    const conn = {
      send(text) {
        socket.write(encodeText(text));
      },
      close() {
        socket.end();
      },
    };
    sockets.add(socket);
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      const { frames, rest } = decodeFrames(pending);
      pending = rest;
      for (const f of frames) {
        if (f.opcode === 0x8) socket.end();
        if (f.opcode === 0x1) onMessage(f.payload.toString('utf8'), conn);
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  });
  const port = await listenOnLoopback(server);
  return {
    url: `ws://127.0.0.1:${port}/`,
    dropAll() {
      for (const s of sockets) s.destroy();
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
