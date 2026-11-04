// Local test: the page's #root stays empty and the mod never throws, so the only watchdog trigger is the empty root.
// The loader must reload the page pristine once and show the notice once. Served from memory on the fake origin, like
// crash.test.mjs; no server, no network.
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

// One quiet mod: its page script only marks the document, so a pristine document has no marker.
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

test('an empty #root alone triggers one pristine reload and one notice', { timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-empty-root-'));
  const modsRoot = path.join(tmp, 'mods');
  fs.mkdirSync(modsRoot);
  writeQuietMod(modsRoot);
  const { active } = partitionEnabled(discoverMods(modsRoot).mods);
  const { loaded, skipped } = loadModSources(active, modsRoot);
  assert.equal(skipped.length, 0);

  const events = [];
  const logs = [];
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
      const timer = setTimeout(() => reject(new Error(`timed out: ${label}; events: ${events.map((e) => e.kind).join(',')}; loads: ${loads.length}; loader log: ${logs.join(' | ')}`)), CHROME_WAIT_MS);
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
    await waitFor(() => of((e) => e.kind === 'watchdog' && e.sessionId === loaderSession).length === 1, 'watchdog on the empty root');
    await waitFor(() => of((e) => e.kind === 'notice' && e.sessionId === loaderSession).length === 1, 'watchdog notice');

    const watchdogs = of((e) => e.kind === 'watchdog' && e.sessionId === loaderSession);
    assert.equal(watchdogs.length, 1, 'the empty root reloads the page once');
    assert.equal(watchdogs[0].detail, 'root empty', 'the trigger is the empty root, not a mod error');
    assert.equal(of((e) => e.kind === 'fail').length, 0, 'no mod failed: only the root check fired');
    assert.equal(of((e) => e.kind === 'notice' && e.sessionId === loaderSession).length, 1, 'the notice is shown once');
    // The final document is pristine: the quiet mod's script was removed before the reload.
    const marker = await tester.send('Runtime.evaluate', { expression: "document.documentElement.getAttribute('data-quiet-mod-ran')", returnByValue: true }, { sessionId: pageSession });
    t.diagnostic(JSON.stringify({ watchdogs: watchdogs.length, detail: watchdogs[0].detail }));
    assert.equal(marker.result.value, null, 'the final document is pristine');
    await tester.send('Target.closeTarget', { targetId });
  } finally {
    if (helper) await helper.stop();
    if (tester) await tester.close();
    await killChrome(proc);
    removeTempDir(tmp);
  }
});
