// Local test: a route change whose anchor renders after the change, inside the loader's anchor wait. The loader must wait
// for the anchor and then attach the mod; a wait of zero would plan ANCHOR_MISSING before the anchor appears. Served from
// memory on the fake origin, like crash.test.mjs; no server, no network.
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

// One mod anchored on /settings/models; its page script does nothing, the test is about attaching.
function writeWaitMod(root) {
  const dir = path.join(root, 'wait-mod');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), JSON.stringify({
    id: 'wait-mod', name: 'wait-mod', nameKo: 'wait-mod', version: '0.0.1', enabled: true, order: 1,
    entry: { page: 'page.js', css: 'style.css', host: 'host.mjs' }, contributes: {}, testedBuilds: [BUILD],
    anchors: [{ selector: '[data-late-anchor]', route: '/settings/models' }],
  }));
  fs.writeFileSync(path.join(dir, 'page.js'), 'void 0;');
  fs.writeFileSync(path.join(dir, 'style.css'), '');
  fs.writeFileSync(path.join(dir, 'host.mjs'), 'export function handle() { throw new Error("unknown method"); }');
}

test('an anchor that renders inside the wait after a route change still attaches the mod', { timeout: 120000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-route-wait-'));
  const modsRoot = path.join(tmp, 'mods');
  fs.mkdirSync(modsRoot);
  writeWaitMod(modsRoot);
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
      const timer = setTimeout(() => reject(new Error(`timed out: ${label}; events: ${events.map((e) => e.kind).join(',')}; loader log: ${logs.join(' | ')}`)), CHROME_WAIT_MS);
      waiters.push({ check, resolve: () => { clearTimeout(timer); resolve(); } });
    });
  const onEvent = (e) => {
    events.push(e);
    wake();
  };
  const attachedFor = (targetId) => events.filter((e) => e.kind === 'attached' && e.targetId === targetId);
  const planAt = (sessionId, pathname) => events.find((e) => e.kind === 'plan' && e.sessionId === sessionId && e.pathname === pathname);

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
      const body = new URL(params.request.url).pathname === '/route'
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
    await tester.send('Fetch.enable', { patterns: [{ urlPattern: `${ORIGIN}/*` }] }, { sessionId: pageSession });
    await tester.send('Page.navigate', { url: `${ORIGIN}/route` }, { sessionId: pageSession });

    await waitFor(() => attachedFor(targetId).length === 1, 'attach');
    const loaderSession = attachedFor(targetId)[0].sessionId;
    await waitFor(() => loads.includes(pageSession), 'page load');

    // Subscribe to the route's plan first. The route change starts the anchor wait without planning anything.
    const planned = waitFor(() => planAt(loaderSession, '/settings/models') !== undefined, 'route /settings/models plan');
    await tester.send('Runtime.evaluate', {
      expression: "history.pushState({}, '', '/settings/models'); document.body.appendChild(document.createElement('i')); true",
      returnByValue: true,
    }, { sessionId: pageSession });
    assert.equal(planAt(loaderSession, '/settings/models'), undefined, 'the loader waits for the anchor: no plan before it renders');

    // The anchor renders while the loader is still inside its wait.
    await tester.send('Runtime.evaluate', {
      expression: "(function () { var a = document.createElement('b'); a.setAttribute('data-late-anchor', ''); document.getElementById('root').appendChild(a); return true; })()",
      returnByValue: true,
    }, { sessionId: pageSession });
    await planned;
    const plan = planAt(loaderSession, '/settings/models');
    t.diagnostic(JSON.stringify({ states: plan.states }));
    assert.deepEqual(plan.states.find((s) => s.id === 'wait-mod'), { id: 'wait-mod', attached: true, reason: null }, 'the mod attaches when its anchor renders within the wait');
    await tester.send('Target.closeTarget', { targetId });
  } finally {
    if (helper) await helper.stop();
    if (tester) await tester.close();
    await killChrome(proc);
    removeTempDir(tmp);
  }
});
