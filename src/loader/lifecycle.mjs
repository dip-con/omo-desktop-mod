// Supervision after the mods are attached. When the CDP socket closes it decides: OmO gone -> exit 0; the debug
// endpoint down for ENDPOINT_GRACE_MS while OmO lives -> exit 5; otherwise reconnect (a renderer died or reloaded).
// Clock, probe, pid check, scheduler and reconnect are injected. Nothing here signals a process.
export const EXIT_OMO_GONE = 0;
export const EXIT_ENDPOINT_LOST = 5;
export const POLL_MS = 1000;
export const ENDPOINT_GRACE_MS = 10000;

// first and every value reconnect() resolves to expose `done`, a promise that settles when that socket closes.
// Returns a promise of the exit code.
export function supervise({ omoPid, first, reconnect, probe, isAlive, log = () => {}, now = Date.now, schedule = setTimeout, pollMs = POLL_MS }) {
  return new Promise((resolve) => {
    let failingSince = null;
    let lastReconnect = null;

    async function tick() {
      const up = await probe();
      if (!isAlive(omoPid)) return resolve(EXIT_OMO_GONE);
      if (!up) {
        failingSince ??= now();
        if (now() - failingSince >= ENDPOINT_GRACE_MS) return resolve(EXIT_ENDPOINT_LOST);
        return schedule(tick, pollMs);
      }
      failingSince = null;
      lastReconnect = now();
      log('reconnect');
      try {
        watch(await reconnect());
      } catch (err) {
        log(`reconnect failed: ${err.message}`);
        schedule(tick, pollMs);
      }
    }

    // At most one reconnect per poll interval: a socket that closes right after opening waits instead of looping.
    function watch(handle) {
      handle.done.then(() => {
        const wait = lastReconnect === null ? 0 : lastReconnect + pollMs - now();
        if (wait > 0) schedule(tick, wait);
        else tick();
      });
    }

    watch(first);
  });
}
