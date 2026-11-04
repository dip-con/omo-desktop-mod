// Binds a server to an ephemeral loopback port that Node's WebSocket and fetch do not refuse (loader/ports.mjs).
// A blocked port is closed and another one is asked for, bounded, so a test never talks to a port the runtime refuses.
import { isBlockedPort } from '../../loader/ports.mjs';

const ATTEMPTS = 50;

// Resolves with the bound port. The server object is reused across attempts, which Node allows after close().
export async function listenOnLoopback(server) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    if (!isBlockedPort(port)) return port;
    await new Promise((resolve) => server.close(resolve));
  }
  throw new Error(`no unblocked loopback port after ${ATTEMPTS} attempts`);
}
