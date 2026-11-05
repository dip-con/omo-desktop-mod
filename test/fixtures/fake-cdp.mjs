// A scripted CDP connection: records every send, answers from `answers` (method -> result or fn(params, opts)),
// and lets the test fire events with emit(event, params, sessionId).
export function fakeCdp(answers = {}) {
  const sent = [];
  const listeners = new Map();
  const defaults = {
    'Target.attachToTarget': ({ targetId }) => ({ sessionId: `s-${targetId}` }),
    'Page.getFrameTree': () => ({ frameTree: { frame: { id: 'frame-1' } } }),
    'Page.createIsolatedWorld': () => ({ executionContextId: 7 }),
    'Page.addScriptToEvaluateOnNewDocument': () => ({ identifier: `script-${sent.length}` }),
    'Runtime.evaluate': () => ({ result: {} }),
    'Target.getTargets': () => ({ targetInfos: [] }),
  };
  return {
    sent,
    async send(method, params = {}, opts = {}) {
      sent.push({ method, params, sessionId: opts.sessionId ?? null });
      const answer = answers[method] ?? defaults[method];
      return typeof answer === 'function' ? answer(params, opts) : (answer ?? {});
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    async emit(event, params, sessionId) {
      await Promise.all((listeners.get(event) ?? []).map((fn) => fn(params, sessionId)));
    },
    close() {},
    calls: (method) => sent.filter((s) => s.method === method),
  };
}
