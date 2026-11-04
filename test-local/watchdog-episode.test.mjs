// Local test: one page with an empty #root and a mod that throws after load, so two watchdogs fire ('late failure' and
// 'root empty'). One episode must give exactly one reload, one message box (a fake counter, never a real OS box), one
// pristine notice, and a final document without the mod's root. Served from memory on the fake origin; no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { connect } from '../loader/cdp.mjs';
import { notifyWatchdog } from '../loader/deps.mjs';
import { loadModSources, serveMainWindows } from '../loader/inject.mjs';
import { discoverMods, partitionEnabled } from '../loader/mods.mjs';
import { CHROME_WAIT_MS, killChrome, launchChrome, removeTempDir } from '../tools/chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(here, '..', 'loader');
const ORIGIN = 'https://omo.test';
const BUILD = 'test-build';
const BRIDGE_TIMEOUT_MS = 500;
const RULE = { protocol: 'https:', host: 'omo.test' };
const MOD_ROOT_ID = 'omo-test-mod-root';

// The mod adds its own root to the body, then throws after load: an uncaught error is the 'late failure' trigger.
function writeLateMod(root) {
  const dir = path.join(root, 'late-mod');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({
    id: 'late-mod', name: 'late-mod', nameKo: 'late-mod', version: '0.0.1', enabled: true, order: 1,
    entry: { page: 'page.js', css: 'style.css', host: 'host.mjs' }, contributes: {}, testedBuilds: [BUILD],
    anchors: [{ selector: '#root', route: '*' }],
  }));
  fs.writeFileSync(path.join(dir, 'page.js'),
    `var m = document.createElement('div'); m.id = '${MOD_ROOT_ID}'; document.body.appendChild(m);\nsetTimeout(function () { throw new Error('late failure'); }, 0);`);
  fs.writeFileSync(path.join(dir, 'style.css'), '');
  fs.writeFileSync(path.join(dir, 'host.mjs'), 'export function handle() { throw new Error("unknown method"); }');
}

test('one watchdog episode with two triggers gives one reload, one box and one notice', { timeout: 120000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-watchdog-episode-'));
  const modsRoot = path.join(tmp, 'mods');
  fs.mkdirSync(modsRoot);
  writeLateMod(modsRoot);
  const { active } = partitionEnabled(discoverMods(modsRoot).mods);
  const { loaded, skipped } = loadModSources(active, modsRoot);
  assert.equal(skipped.length, 0);

  const events = [];
  const logs = [];
  const boxes = [];
  const shown = new Set();
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
    if (e.kind === 'watchdog') notifyWatchdog(e, (text) => boxes.push(text), shown);
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
    await waitFor(() => of((e) => e.kind === 'notice' && e.sessionId === loaderSession).length === 1, 'pristine notice');

    const watchdogs = of((e) => e.kind === 'watchdog' && e.sessionId === loaderSession);
    assert.equal(loads.length, 2, 'the initial load and exactly one reload');
    assert.equal(watchdogs.length, 1, 'the second trigger in the same episode is ignored: one watchdog event');
    assert.equal(boxes.length, 1, 'one message box for the episode');
    assert.equal(of((e) => e.kind === 'notice' && e.sessionId === loaderSession).length, 1, 'one pristine notice');
    assert.equal(of((e) => e.kind === 'watchdog-capped').length, 0, 'no loop: the cap is never reached');
    const finalRoot = await tester.send('Runtime.evaluate', { expression: `document.getElementById('${MOD_ROOT_ID}') === null`, returnByValue: true }, { sessionId: pageSession });
    assert.equal(finalRoot.result.value, true, 'the final document has no mod root');
    await tester.send('Target.closeTarget', { targetId });
  } finally {
    if (helper) await helper.stop();
    if (tester) await tester.close();
    await killChrome(proc);
    removeTempDir(tmp);
  }
});
