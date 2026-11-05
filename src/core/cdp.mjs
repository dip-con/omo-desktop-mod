// Minimal Chrome DevTools Protocol client over Node's built-in WebSocket. Requests are matched by id;
// events go to on(event, fn) as fn(params, sessionId). The pseudo event 'close' fires when the socket closes.
const OPEN_TIMEOUT_MS = 10000;
const SEND_TIMEOUT_MS = 15000;

export async function connect(wsUrl, { openTimeoutMs = OPEN_TIMEOUT_MS } = {}) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
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
    send(method, params = {}, { timeoutMs = SEND_TIMEOUT_MS, sessionId } = {}) {
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
