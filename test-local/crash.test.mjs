// Local test: headless Chrome crashes an app page while a mod is live, then reloads it. The mod arms itself on the first
// load and throws on every load after that, so the crash reload runs the failing script. The loader must keep the one
// session it tracks (Chromium keeps the session and its document script across a renderer crash), reload pristine once
// and show the notice once. Served from memory on the fake origin, like inject.test.mjs; no server, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { connect } from '../loader/cdp.mjs';
import { loadModSources, serveMainWindows, MAX_WATCHDOG_RELOADS } from '../loader/inject.mjs';
import { discoverMods, partitionEnabled } from '../loader/mods.mjs';
import { CHROME_WAIT_MS, killChrome, launchChrome, removeTempDir } from '../tools/chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(here, '..', 'loader');
const ORIGIN = 'https://omo.test';
const BUILD = 'test-build';
const BRIDGE_TIMEOUT_MS = 500;
const RULE = { protocol: 'https:', host: 'omo.test' };

// One mod: arms on the first load, throws an uncaught error after load on every load after that (the watchdog trigger).
function writeCrashMod(root) {
  const dir = path.join(root, 'crash-mod');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({
    id: 'crash-mod', name: 'crash-mod', nameKo: 'crash-mod', version: '0.0.1', enabled: true, order: 1,
    entry: { page: 'page.js', css: 'style.css', host: 'host.mjs' }, contributes: {}, testedBuilds: [BUILD],
    anchors: [{ selector: '#root', route: '*' }],
  }));
  fs.writeFileSync(path.join(dir, 'page.js'), [
    "document.documentElement.setAttribute('data-crash-mod-ran', '1');",
    "var key = 'omo-crash-armed';",
    "if (sessionStorage.getItem(key) === '1') setTimeout(function () { throw new Error('armed mod fails after load'); }, 0);",
    "sessionStorage.setItem(key, '1');",
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'style.css'), '');
  fs.writeFileSync(path.join(dir, 'host.mjs'), 'export function handle() { throw new Error("unknown method"); }');
}

test('a renderer crash keeps one tracked session and the watchdog reload stays bounded and noticed once', { timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-crash-'));
  const modsRoot = path.join(tmp, 'mods');
  fs.mkdirSync(modsRoot);
  writeCrashMod(modsRoot);
  const { active } = partitionEnabled(discoverMods(modsRoot).mods);
  const { loaded, skipped } = loadModSources(active, modsRoot);
  assert.equal(skipped.length, 0);

  const events = [];
  const logs = [];
  const crashed = new Set();
  const loads = [];
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
      const timer = setTimeout(() => reject(new Error(`timed out: ${label}; events: ${events.map((e) => e.kind).join(',')}; loads: ${loads.length}; crashed: ${crashed.size}; loader log: ${logs.join(' | ')}`)), CHROME_WAIT_MS);
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
    tester.on('Page.loadEventFired', (_params, sessionId) => {
      loads.push(sessionId);
      wake();
    });
    tester.on('Inspector.targetCrashed', (_params, sessionId) => {
      crashed.add(sessionId);
      wake();
    });
    tester.on('Fetch.requestPaused', (params, sessionId) => {
      const body = new URL(params.request.url).pathname === '/crash'
        ? '<!doctype html><html><body><div id="root"><p>x</p></div></body></html>'
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
    await tester.send('Inspector.enable', {}, { sessionId: pageSession });
    await tester.send('Fetch.enable', { patterns: [{ urlPattern: `${ORIGIN}/*` }] }, { sessionId: pageSession });
    await tester.send('Page.navigate', { url: `${ORIGIN}/crash` }, { sessionId: pageSession });

    await waitFor(() => attachedFor(targetId).length === 1, 'first attach');
    const loaderSession = attachedFor(targetId)[0].sessionId;
    await waitFor(() => loads.includes(pageSession), 'first load (mod arms)');

    // Crash the renderer. The response can be eaten by the crash, so the call is not awaited; the event is the signal.
    tester.send('Page.crash', {}, { sessionId: pageSession }).catch(() => {});
    await waitFor(() => crashed.has(pageSession), 'Inspector.targetCrashed');
    // Reload fire-and-forget too: the page is crashed, the next load runs the mod, which throws and triggers the watchdog.
    tester.send('Page.reload', {}, { sessionId: pageSession }).catch(() => {});
    await waitFor(() => of((e) => e.kind === 'notice' && e.sessionId === loaderSession).length === 1, 'watchdog notice');

    const attached = attachedFor(targetId).length;
    const watchdogs = of((e) => e.kind === 'watchdog' && e.sessionId === loaderSession);
    const capped = of((e) => e.kind === 'watchdog-capped' && e.sessionId === loaderSession).length;
    const notices = of((e) => e.kind === 'notice' && e.sessionId === loaderSession).length;
    t.diagnostic(JSON.stringify({ attached, watchdogs: watchdogs.length, crashed: watchdogs[0]?.crashed, capped, notices }));
    assert.equal(attached, 1, 'exactly one tracked session per target');
    assert.equal(watchdogs.length, 1, 'the crash reload runs the failing mod once; no watchdog loop');
    assert.equal(watchdogs[0].crashed, true, 'the watchdog comes from the crashed session the loader kept');
    assert.ok(watchdogs.length <= MAX_WATCHDOG_RELOADS, 'watchdog reloads stay within the cap');
    assert.equal(capped, 0);
    assert.equal(notices, 1, 'the notice is shown once per target');
    // The mod runs in the isolated world, but the DOM is shared: a marker on documentElement shows whether its script ran.
    const marker = await tester.send('Runtime.evaluate', { expression: "document.documentElement.getAttribute('data-crash-mod-ran')", returnByValue: true }, { sessionId: pageSession });
    assert.equal(marker.result.value, null, 'the final document is pristine: the mod script was removed');
    await tester.send('Target.closeTarget', { targetId });
  } finally {
    if (helper) await helper.stop();
    if (tester) await tester.close();
    await killChrome(proc);
    removeTempDir(tmp);
  }
});
