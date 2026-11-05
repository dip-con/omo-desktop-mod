// Watchdog: an uncaught mod error or an empty #root removes the mods bundle from that target and reloads the page
// without mods. After at most maxReloads reloads per target it stops reloading and only shows the notice.
// The notice runs once the reloaded document has loaded, in a fresh isolated world with no mod code.
export const MAX_RELOADS = 3;
const WORLD = 'omo-mods';

// counts: Map<targetId, number>, shared across reconnects so the cap holds for the whole launch.
export function createWatchdog({ cdp, noticeScript, onEvent, log, counts = new Map(), maxReloads = MAX_RELOADS }) {
  const pending = new Map(); // sessionId -> { committed }

  async function runNotice(sessionId) {
    try {
      const { frameTree } = await cdp.send('Page.getFrameTree', {}, { sessionId });
      const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD, grantUniveralAccess: false }, { sessionId });
      const ran = await cdp.send('Runtime.evaluate', { expression: noticeScript, contextId: executionContextId }, { sessionId });
      if (ran.exceptionDetails) throw new Error('notice script threw');
      onEvent({ kind: 'notice', sessionId });
    } catch (err) {
      log(`notice failed: ${err.message}`);
    }
  }

  // The old document's load can arrive after the watchdog and before the reload commits: wait for a main-frame commit.
  cdp.on('Page.frameNavigated', ({ frame }, sessionId) => {
    const p = pending.get(sessionId);
    if (p && !frame.parentId) p.committed = true;
  });
  cdp.on('Page.loadEventFired', (_params, sessionId) => {
    const p = pending.get(sessionId);
    if (!p?.committed) return;
    pending.delete(sessionId);
    return runNotice(sessionId);
  });

  // entry: { targetId, sessionId, identifier } of an attached main window; identifier is the bundle's script id.
  async function trigger(entry, detail) {
    const { sessionId } = entry;
    // A reload is already on its way: a second report is ignored until the reloaded document has loaded.
    if (pending.has(sessionId)) return;
    const reloads = (counts.get(entry.targetId) ?? 0) + 1;
    counts.set(entry.targetId, reloads);
    const capped = reloads > maxReloads;
    if (!capped) pending.set(sessionId, { committed: false });
    if (entry.identifier !== null) {
      const identifier = entry.identifier;
      entry.identifier = null;
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, { sessionId });
    }
    onEvent({ kind: 'watchdog', sessionId, detail: String(detail ?? ''), reloads, capped });
    if (capped) return runNotice(sessionId);
    await cdp.send('Page.reload', { ignoreCache: false }, { sessionId });
  }

  return { trigger };
}
