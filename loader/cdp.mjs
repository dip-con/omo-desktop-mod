// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket (Node >= 24, no dependencies).
// Requests are correlated by message id; events are delivered to on(event, fn).

// The open handshake has a deadline: an endpoint that accepts TCP but never completes the upgrade is closed and
// rejected after openTimeoutMs, so the caller never waits forever.
export async function connect(wsUrl, { openTimeoutMs = 10000 } = {}) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Reject before close(): closing a connecting socket fires its error listener synchronously.
      reject(new Error(`cdp connect timed out after ${openTimeoutMs}ms: ${wsUrl}`));
      ws.close();
    }, openTimeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`cdp connect failed: ${wsUrl}`));
    }, { once: true });
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }
    for (const fn of listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
  });

  ws.addEventListener('close', () => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('cdp socket closed'));
    }
    pending.clear();
    for (const fn of listeners.get('close') ?? []) fn();
  });

  return {
    send(method, params = {}, { timeoutMs = 15000, sessionId } = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      });
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    close() {
      ws.close();
    },
  };
}
