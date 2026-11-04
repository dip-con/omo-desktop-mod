// Supervision after OmO is up. It runs only when the browser socket closes, and decides with exitDecision whether the
// helper ends or reconnects once per loss. Clock, probe, pid check, scheduler and reconnect are injected, so the tests
// drive this same function with fakes. Nothing here signals a process: the helper never closes OmO.
import { exitDecision } from './ownership.mjs';

export const EXIT_OMO_GONE = 0;
export const EXIT_ENDPOINT_LOST = 5;
export const POLL_MS = 1000;

// `first` and every handle returned by reconnect() expose `done`, which resolves when that browser socket closes.
// Returns { exitCode: Promise<number>, idle } where idle() resolves once the work queued so far has settled.
export function watchApp({ omoPid, first, reconnect, probeVersion, pidAlive, now, schedule, emit, pollMs = POLL_MS }) {
  let versionFailingSince = null;
  let stopped = false;
  let lastReattach = null;
  let inflight = Promise.resolve();
  let resolveExit;
  const exitCode = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const finish = (code, reason) => {
    stopped = true;
    emit({ kind: 'exit', code, reason });
    resolveExit(code);
  };
  const later = () => schedule(() => (inflight = tick()), pollMs);
  // At most one reattach per poll interval: a socket that closes as soon as it opens waits instead of looping.
  const onLost = (handle) =>
    handle.done.then(() => {
      versionFailingSince = null;
      const wait = lastReattach === null ? 0 : lastReattach + pollMs - now();
      if (wait > 0) schedule(() => (inflight = tick()), wait);
      else inflight = tick();
    });

  async function tick() {
    if (stopped) return;
    const info = await probeVersion();
    const omoAlive = pidAlive(omoPid);
    if (info) versionFailingSince = null;
    else if (versionFailingSince === null) versionFailingSince = now();
    const decision = exitDecision({ now: now(), wsClosed: true, versionFailingSince, omoAlive });
    if (decision === 'exit') {
      if (omoAlive) return finish(EXIT_ENDPOINT_LOST, 'ENDPOINT_LOST');
      return finish(EXIT_OMO_GONE, 'OMO_GONE');
    }
    if (!info) return later();
    lastReattach = now();
    emit({ kind: 'reattach' });
    try {
      onLost(await reconnect());
    } catch (err) {
      emit({ kind: 'reattach-failed', message: err.message });
      later();
    }
  }

  onLost(first);
  return { exitCode, idle: () => new Promise((resolve) => setImmediate(resolve)).then(() => inflight) };
}
