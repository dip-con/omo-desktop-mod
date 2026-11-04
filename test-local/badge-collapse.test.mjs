// Local test: the watchdog notice shows the badge, and the badge collapses by itself about 5 s later. The test waits on
// the collapsed attribute with a MutationObserver inside the page, bounded by its own ceiling, so no fixed sleep is used.
// Served from memory on the fake origin, like empty-root.test.mjs; no server, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { connect } from '../loader/cdp.mjs';
import { loadModSources, serveMainWindows } from '../loader/inject.mjs';
import { discoverMods, partitionEnabled } from '../loader/mods.mjs';
import { CHROME_WAIT_MS, killChrome, launchChrome, removeTempDir } from '../tools/chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(here, '..', 'loader');
const ORIGIN = 'https://omo.test';
const BUILD = 'test-build';
const BRIDGE_TIMEOUT_MS = 500;
const RULE = { protocol: 'https:', host: 'omo.test' };
const COLLAPSE_CEILING_MS = 15000;

// The page's own script waits for the badge to carry data-collapsed="true"; it resolves false at the ceiling.
const AWAIT_COLLAPSE = `new Promise((resolve) => {
  const badge = document.getElementById('omo-mods-badge');
  if (!badge) return resolve('no-badge');
  const done = (value) => { observer.disconnect(); clearTimeout(timer); resolve(value); };
  const check = () => { if (badge.getAttribute('data-collapsed') === 'true') done(true); };
  const observer = new MutationObserver(check);
  const timer = setTimeout(() => done(false), ${COLLAPSE_CEILING_MS});
  observer.observe(badge, { attributes: true, attributeFilter: ['data-collapsed'] });
  check();
})`;

// One quiet mod, so the empty root is the only watchdog trigger (same fixture as empty-root.test.mjs).
function writeQuietMod(root) {
  const dir = path.join(root, 'quiet-mod');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({
    id: 'quiet-mod', name: 'quiet-mod', nameKo: 'quiet-mod', version: '0.0.1', enabled: true, order: 1,
    entry: { page: 'page.js', css: 'style.css', host: 'host.mjs' }, contributes: {}, testedBuilds: [BUILD],
    anchors: [{ selector: '#root', route: '*' }],
  }));
  fs.writeFileSync(path.join(dir, 'page.js'), "document.documentElement.setAttribute('data-quiet-mod-ran', '1');");
  fs.writeFileSync(path.join(dir, 'style.css'), '');
  fs.writeFileSync(path.join(dir, 'host.mjs'), 'export function handle() { throw new Error("unknown method"); }');
}

test('the watchdog notice badge collapses by itself after about 5 s', { timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-badge-collapse-'));
  const modsRoot = path.join(tmp, 'mods');
  fs.mkdirSync(modsRoot);
  writeQuietMod(modsRoot);
  const { active } = partitionEnabled(discoverMods(modsRoot).mods);
  const { loaded, skipped } = loadModSources(active, modsRoot);
  assert.equal(skipped.length, 0);

  const events = [];
  const logs = [];
  const waiters = [];
  const wake = () => {
    for (const w of [...waiters]) {
      if (w.check()) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };
  // Subscribes through the predicate before the action; a bounded wait rejects with the loader log for diagnosis.
  const waitFor = (check, label) =>
    new Promise((resolve, reject) => {
      if (check()) return resolve();
      const timer = setTimeout(() => reject(new Error(`timed out: ${label}; events: ${events.map((e) => e.kind).join(',')}; loader log: ${logs.join(' | ')}`)), CHROME_WAIT_MS);
      waiters.push({ check, resolve: () => { clearTimeout(timer); resolve(); } });
    });
  const onEvent = (e) => {
    events.push(e);
    wake();
  };
  const of = (pred) => events.filter(pred);
  const attachedFor = (targetId) => of((e) => e.kind === 'attached' && e.targetId === targetId);

  const { proc, wsUrl } = await launchChrome(path.join(tmp, 'profile'));
  let tester;
  let helper;
  try {
    const browserWs = await wsUrl;
    tester = await connect(browserWs);
    tester.on('Fetch.requestPaused', (params, sessionId) => {
      const body = new URL(params.request.url).pathname === '/empty-root'
        ? '<!doctype html><html><body><div id="root"></div></body></html>'
        : undefined;
      const reply = body === undefined
        ? { requestId: params.requestId, responseCode: 404, body: '' }
        : { requestId: params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(body).toString('base64') };
      tester.send('Fetch.fulfillRequest', reply, { sessionId }).catch(() => {});
    });

    helper = await serveMainWindows({
      wsUrl: browserWs, rule: RULE, buildKey: BUILD, loaderDir: LOADER, bridgeTimeoutMs: BRIDGE_TIMEOUT_MS,
      ownerOk: async () => true, onEvent, log: (line) => logs.push(line), resolveMods: () => ({ loaded, reported: [] }),
    });

    const { targetId } = await tester.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId: pageSession } = await tester.send('Target.attachToTarget', { targetId, flatten: true });
    await tester.send('Page.enable', {}, { sessionId: pageSession });
    await tester.send('Fetch.enable', { patterns: [{ urlPattern: `${ORIGIN}/*` }] }, { sessionId: pageSession });
    await tester.send('Page.navigate', { url: `${ORIGIN}/empty-root` }, { sessionId: pageSession });

    await waitFor(() => attachedFor(targetId).length === 1, 'attach');
    const loaderSession = attachedFor(targetId)[0].sessionId;
    await waitFor(() => of((e) => e.kind === 'notice' && e.sessionId === loaderSession).length === 1, 'watchdog notice');

    // Right after the notice the badge is shown and not yet collapsed, so the wait below cannot pass vacuously.
    const before = await tester.send('Runtime.evaluate', {
      expression: "(() => { const b = document.getElementById('omo-mods-badge'); return b ? b.getAttribute('data-collapsed') : 'no-badge'; })()",
      returnByValue: true,
    }, { sessionId: pageSession });
    assert.equal(before.result.value, null, 'the badge is not collapsed right after the notice');

    const collapsed = await tester.send('Runtime.evaluate', { expression: AWAIT_COLLAPSE, awaitPromise: true, returnByValue: true }, { sessionId: pageSession });
    assert.equal(collapsed.result.value, true, `the badge collapsed within ${COLLAPSE_CEILING_MS} ms`);
    await tester.send('Target.closeTarget', { targetId });
  } finally {
    if (helper) await helper.stop();
    if (tester) await tester.close();
    await killChrome(proc);
    removeTempDir(tmp);
  }
});
