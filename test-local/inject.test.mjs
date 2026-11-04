// Local test: one headless Chrome opens the snapshot pages as the main window, the loader injects test mods
// over CDP, and the test checks the injection rules. The pages are served from memory through CDP Fetch on a fake
// origin (https://omo.test), so history.pushState works as it does on omo://app. No server, no network.
// Needs Chrome at the path below; never touches the app.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { connect } from '../loader/cdp.mjs';
import { loadModSources, serveMainWindows } from '../loader/inject.mjs';
import { discoverMods, partitionEnabled } from '../loader/mods.mjs';
import { killChrome, launchChrome, removeTempDir } from '../tools/chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const LOADER = path.join(REPO, 'loader');
const FACTS = JSON.parse(fs.readFileSync(path.join(REPO, 'docs', 'app-facts.json'), 'utf8'));
if (!FACTS.snapshotDir) throw new Error('docs/app-facts.json has no snapshotDir; run tools/probe-app.mjs before this test');
const SNAPSHOT = path.join(REPO, FACTS.snapshotDir);
const ORIGIN = 'https://omo.test';
const BUILD = 'test-build';
const WAIT_MS = 20000;
const BRIDGE_TIMEOUT_MS = 500;
// The test rule: the fake origin's protocol and host (the production rule is omo://app, covered by test/target.test.mjs).
const RULE = { protocol: 'https:', host: 'omo.test' };
const ROOT = (id) => `document.querySelectorAll('[data-omo-mod-root="${id}"]').length`;
const CLICK = { poke: [60, 25], ping: [60, 65], hang: [60, 105] };

// Fixture mods: probe (root, three buttons, bridge calls), broken (sync throw), settings and route (anchors), off (disabled),
// late (an uncaught error after load, used only by the watchdog scenario), bad (unreadable mod.json).
function writeFixtureMods(root) {
  const mk = (id, mod, files) => {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, 'mod.json'), JSON.stringify({
      id, name: id, nameKo: id, version: '0.0.1', enabled: true, order: 1, entry: { page: 'page.js', css: 'style.css', host: 'host.mjs' },
      contributes: {}, testedBuilds: [BUILD], anchors: [{ selector: '#root', route: '*' }], ...mod,
    }));
    const defaults = { 'style.css': '', 'host.mjs': 'export function handle() { throw new Error("unknown method"); }' };
    for (const [name, text] of Object.entries({ ...defaults, ...files })) fs.writeFileSync(path.join(root, id, name), text);
  };
  const rootEl = (id) => `var rootEl = document.createElement('div'); rootEl.setAttribute('data-omo-mod-root', '${id}'); document.body.appendChild(rootEl);`;
  const button = (id, top, label, fn) =>
    `var b${top} = document.createElement('button'); b${top}.id = '${id}'; b${top}.textContent = '${label}';` +
    ` b${top}.style.cssText = 'position:fixed;left:10px;top:${top}px;width:100px;height:30px;z-index:2147483600';` +
    ` rootEl.appendChild(b${top}); omoMods.onTrusted(b${top}, function () { ${fn} });`;
  mk('probe-mod', {}, {
    'page.js': [rootEl('probe-mod'), button('omo-test-button', 10, 'poke', "omoMods.call('poke', []);"),
      button('omo-ping-button', 50, 'ping', "omoMods.call('count', []);"), button('omo-hang-button', 90, 'hang', "omoMods.call('hang', []).catch(function () {});")].join('\n'),
    'style.css': '#omo-test-button { outline: none; }',
    'host.mjs': [
      'let pokes = 0;',
      'export function handle(method) {',
      "  if (method === 'poke') { pokes += 1; return pokes; }",
      "  if (method === 'count') return pokes;",
      "  if (method === 'hang') return new Promise(function () {});",
      "  throw new Error('unknown method');",
      '}',
    ].join('\n'),
  });
  mk('broken-mod', {}, { 'page.js': "throw new Error('deliberate test failure');" });
  mk('settings-mod', { anchors: [{ selector: '[data-settings-nav-path="/settings/general"]', route: '/settings/general' }] }, { 'page.js': rootEl('settings-mod') });
  mk('route-mod', { anchors: [{ selector: '[data-omo-missing-anchor]', route: '/settings/models' }] }, { 'page.js': rootEl('route-mod') });
  mk('off-mod', { enabled: false }, { 'page.js': rootEl('off-mod') });
  mk('late-mod', {}, { 'page.js': "setTimeout(function () { throw new Error('late failure'); }, 0);" });
  fs.mkdirSync(path.join(root, 'bad-mod'));
  fs.writeFileSync(path.join(root, 'bad-mod', 'mod.json'), '{ "id": "bad-mod", "enabled": "yes" }');
}

test('injection over headless Chrome: reloads, reopen, routes, bridge, watchdog, owner check, boot wait', { timeout: 240000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-inject-'));
  const modsRoot = path.join(tmp, 'mods');
  fs.mkdirSync(modsRoot);
  writeFixtureMods(modsRoot);
  const discovered = discoverMods(modsRoot);
  const { active, disabled } = partitionEnabled(discovered.mods);
  const { loaded: allLoaded, skipped } = loadModSources(active, modsRoot);
  assert.equal(skipped.length, 0);
  const loadedA = allLoaded.filter((m) => m.id !== 'late-mod');
  const loadedB = allLoaded.filter((m) => m.id === 'probe-mod' || m.id === 'late-mod');
  const reported = [
    ...disabled.map((m) => ({ id: m.id, name: m.nameKo, attached: false, reason: 'DISABLED' })),
    ...discovered.skipped.map((s) => ({ id: s.id, name: s.id, attached: false, reason: 'BAD_FORMAT' })),
  ];
  // Pages served from memory: the snapshot for the app paths, small documents for the watchdog and boot-shell pages.
  const pages = {
    '/settings/general': fs.readFileSync(path.join(SNAPSHOT, 'settings-general.html'), 'utf8'),
    '/empty-root': '<!doctype html><html><body><div id="root"></div></body></html>',
    '/boot': '<!doctype html><html><body><div id="boot-shell" data-boot-shell-state="loading"></div><div id="root"><p>x</p></div></body></html>',
  };
  const appUrl = `${ORIGIN}/settings/general`;
  const emptyUrl = `${ORIGIN}/empty-root`;
  const bootUrl = `${ORIGIN}/boot`;

  const events = [];
  const logs = [];
  const waiters = [];
  const loads = [];
  const wdMarks = new Map();
  // Re-checks every waiting predicate. Called on loader events and on page load events, since a load can make a predicate true.
  const settle = () => {
    for (const w of [...waiters]) {
      if (w.check()) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };
  const onEvent = (e) => {
    events.push(e);
    if (e.kind === 'watchdog') wdMarks.set(e.sessionId, loads.length);
    settle();
  };
  const until = (check, label) =>
    new Promise((resolve, reject) => {
      if (check()) return resolve();
      const timer = setTimeout(() => reject(new Error(`timed out: ${label}; loader log: ${logs.join(' | ')}`)), WAIT_MS);
      waiters.push({
        check,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  const count = (pred) => events.filter(pred).length;
  const attachedTo = (targetId) => count((e) => e.kind === 'attached' && e.targetId === targetId) > 0;
  const loaderSessionOf = (targetId) => events.find((e) => e.kind === 'attached' && e.targetId === targetId)?.sessionId;
  const planFor = (sessionId, pathname) => events.filter((e) => e.kind === 'plan' && e.sessionId === sessionId && e.pathname === pathname).pop();
  const planCount = (sessionId) => count((e) => e.kind === 'plan' && e.sessionId === sessionId);

  const { proc, wsUrl } = await launchChrome(path.join(tmp, 'profile'));
  let tester;
  const helpers = [];
  try {
    const browserWs = await wsUrl;
    tester = await connect(browserWs);
    tester.on('Page.loadEventFired', (_params, sessionId) => {
      loads.push(sessionId);
      settle();
    });
    // Answers every request of the fake origin from memory: pages from `pages`, anything else 404.
    tester.on('Fetch.requestPaused', (params, sessionId) => {
      const url = new URL(params.request.url);
      const body = pages[url.pathname];
      const reply = body === undefined
        ? { requestId: params.requestId, responseCode: 404, body: '' }
        : { requestId: params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(body).toString('base64') };
      tester.send('Fetch.fulfillRequest', reply, { sessionId }).catch(() => {});
    });
    const startHelper = async ({ loaded, reported = [], ...opts }) => {
      const h = await serveMainWindows({
        resolveMods: () => ({ loaded, reported }),
        wsUrl: browserWs,
        rule: RULE,
        buildKey: BUILD,
        loaderDir: LOADER,
        bridgeTimeoutMs: BRIDGE_TIMEOUT_MS,
        ownerOk: async () => true,
        onEvent,
        log: (line) => logs.push(line),
        ...opts,
      });
      helpers.push(h);
      return h;
    };
    const sessionFor = async (targetId) => (await tester.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    // A page on the fake origin: create blank, enable Fetch on its session first, then navigate.
    const openPage = async (url) => {
      const { targetId } = await tester.send('Target.createTarget', { url: 'about:blank' });
      const sessionId = await sessionFor(targetId);
      await tester.send('Page.enable', {}, { sessionId });
      await tester.send('Fetch.enable', { patterns: [{ urlPattern: `${ORIGIN}/*` }] }, { sessionId });
      await tester.send('Page.navigate', { url }, { sessionId });
      return { targetId, sessionId };
    };
    const evalMain = async (sessionId, expression) => (await tester.send('Runtime.evaluate', { expression, returnByValue: true }, { sessionId })).result.value;
    const clickAt = async (sessionId, [x, y]) => {
      await tester.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, { sessionId });
      await tester.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, { sessionId });
    };
    const closeAll = async () => {
      for (const t of (await tester.send('Target.getTargets')).targetInfos) {
        if (t.type === 'page' && t.url !== 'about:blank') await tester.send('Target.closeTarget', { targetId: t.targetId });
      }
    };

    // ---- Scenario A: main flow on the settings snapshot ----
    let helper = await startHelper({ loaded: loadedA, reported });
    const other = await tester.send('Target.createTarget', { url: 'data:text/html,<p>other</p>' });
    const app0 = await openPage(appUrl);
    await until(() => attachedTo(app0.targetId), 'first app attach');
    let loaderSession = loaderSessionOf(app0.targetId);
    let appSession = app0.sessionId;
    await until(() => planCount(loaderSession) >= 1, 'first plan');
    const rootsAfterReload = [];
    for (let i = 1; i <= 3; i += 1) {
      await tester.send('Page.reload', {}, { sessionId: appSession });
      await until(() => planCount(loaderSession) >= i + 1, `plan after reload ${i}`);
      rootsAfterReload.push(await evalMain(appSession, ROOT('probe-mod')));
    }
    await tester.send('Target.closeTarget', { targetId: app0.targetId });
    const app1 = await openPage(appUrl);
    await until(() => attachedTo(app1.targetId), 'reopened app attach');
    loaderSession = loaderSessionOf(app1.targetId);
    appSession = app1.sessionId;
    await until(() => planCount(loaderSession) >= 1, 'plan on reopened app');
    const otherSession = await sessionFor(other.targetId);

    assert.deepEqual(rootsAfterReload, [1, 1, 1]);
    assert.equal(await evalMain(appSession, ROOT('probe-mod')), 1);
    assert.equal(await evalMain(appSession, ROOT('settings-mod')), 1);
    assert.equal(await evalMain(appSession, ROOT('off-mod')), 0);
    assert.equal(await evalMain(otherSession, ROOT('probe-mod')), 0);
    assert.equal(await evalMain(appSession, 'typeof window.__omoModsCall'), 'undefined');

    // Scripted click is ignored; a round trip (trusted ping) lands before the poke count is read.
    await evalMain(appSession, "document.getElementById('omo-test-button').click(); true");
    await clickAt(appSession, CLICK.ping);
    await until(() => count((e) => e.kind === 'call' && e.sessionId === loaderSession && e.method === 'count') >= 1, 'ping round trip');
    const host = await import(pathToFileURL(path.join(modsRoot, 'probe-mod', 'host.mjs')).href);
    assert.equal(host.handle('count'), 0);
    await clickAt(appSession, CLICK.poke);
    await until(() => count((e) => e.kind === 'call' && e.sessionId === loaderSession && e.method === 'poke') >= 1, 'trusted poke');
    assert.equal(host.handle('count'), 1);

    // A host call that never answers: the page shows the bridge-lost banner after the bridge timeout.
    await clickAt(appSession, CLICK.hang);
    const bannerState = await tester.send('Runtime.evaluate', {
      awaitPromise: true,
      returnByValue: true,
      expression: `new Promise(function (res) {
        var check = function () {
          var b = document.getElementById('omo-mods-badge');
          if (b && b.getAttribute('data-omo-state') === 'bridge-lost') { res(true); return true; }
          return false;
        };
        if (check()) return;
        var mo = new MutationObserver(function () { if (check()) mo.disconnect(); });
        mo.observe(document.body, { subtree: true, childList: true, attributes: true });
        setTimeout(function () { mo.disconnect(); res(false); }, 5000);
      })`,
    }, { sessionId: appSession });
    assert.equal(bannerState.result.value, true);

    // A broken mod is reported failed and the page root stays; the broken mod alone does not trigger the watchdog.
    assert.ok(count((e) => e.kind === 'fail' && e.mod === 'broken-mod') >= 1);
    assert.ok((await evalMain(appSession, "document.getElementById('root').childElementCount")) > 0);
    assert.equal(count((e) => e.kind === 'watchdog' && e.sessionId === loaderSession), 0);

    // In-page route changes: pushState plus the DOM change that follows it, then the 5 s anchor wait.
    await evalMain(appSession, "history.pushState({}, '', '/settings/general'); document.body.appendChild(document.createElement('i')); true");
    assert.equal(await evalMain(appSession, 'location.pathname'), '/settings/general');
    await until(() => planFor(loaderSession, '/settings/general') !== undefined, 'route /settings/general plan');
    const generalPlan = planFor(loaderSession, '/settings/general');
    assert.deepEqual(generalPlan.states.find((s) => s.id === 'settings-mod'), { id: 'settings-mod', attached: true, reason: null });
    await evalMain(appSession, "history.pushState({}, '', '/settings/models'); document.body.appendChild(document.createElement('i')); true");
    await until(() => planFor(loaderSession, '/settings/models') !== undefined, 'route /settings/models plan');
    const modelsPlan = planFor(loaderSession, '/settings/models');
    assert.equal(modelsPlan.states.find((s) => s.id === 'route-mod').reason, 'ANCHOR_MISSING');
    assert.equal(modelsPlan.states.find((s) => s.id === 'route-mod').attached, false);
    assert.equal(await evalMain(appSession, "document.querySelector('[data-omo-mod-root=\"route-mod\"]').hidden"), true);

    // The double-injection guard: a second run of the bundle adds nothing. Run it on a settled route, where a second
    // instance would apply synchronously and append the probe root before the read; a route waiting on an anchor would not.
    await evalMain(appSession, "history.pushState({}, '', '/settings/general'); document.body.appendChild(document.createElement('i')); true");
    assert.equal(await evalMain(appSession, 'location.pathname'), '/settings/general');
    assert.equal(await evalMain(appSession, ROOT('probe-mod')), 1);
    await helper.evaluateIsolated(app1.targetId, helper.bundle);
    assert.equal(await evalMain(appSession, ROOT('probe-mod')), 1);
    await closeAll();
    helper.stop();

    // ---- Scenario B: watchdog on an empty root and on an uncaught mod error after load ----
    helper = await startHelper({ loaded: loadedB, reported: [] });
    const b1 = await openPage(emptyUrl);
    const b2 = await openPage(appUrl);
    await until(() => attachedTo(b1.targetId) && attachedTo(b2.targetId), 'watchdog targets attach');
    const sb1 = loaderSessionOf(b1.targetId);
    const sb2 = loaderSessionOf(b2.targetId);
    await until(() => count((e) => e.kind === 'watchdog' && e.sessionId === sb1) >= 1, 'watchdog on empty root');
    await until(() => count((e) => e.kind === 'watchdog' && e.sessionId === sb2) >= 1, 'watchdog on late error');
    // The pristine reload: a load event after the watchdog, and no mod roots left on the page.
    const reloadedSince = (loaderSid, tSession) => () => loads.slice(wdMarks.get(loaderSid)).includes(tSession);
    // After the pristine load the loader injects the notice (no mod code): one WATCHDOG marker, no mod roots.
    const notice = `document.querySelectorAll('[data-omo-notice][data-reason="WATCHDOG"]').length`;
    // Opening the badge with a trusted click: the issue list must hold the one WATCHDOG line, and the text must change.
    const expandBadge = async (sid) => {
      const textBefore = await evalMain(sid, "(function () { return document.getElementById('omo-mods-badge').textContent; })()");
      const at = await evalMain(sid, "(function () { var r = document.getElementById('omo-mods-badge').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()");
      assert.equal(await evalMain(sid, `document.elementFromPoint(${at[0]}, ${at[1]}).id`), 'omo-mods-badge');
      await clickAt(sid, at);
      const after = await evalMain(sid, "(function () { var b = document.getElementById('omo-mods-badge'); return { expanded: b.getAttribute('data-expanded'), issues: b.getAttribute('data-issues'), text: b.textContent }; })()");
      assert.equal(after.expanded, 'true');
      assert.equal(after.issues, '1');
      assert.ok(after.text.length > 0 && after.text !== textBefore);
    };
    // Visible notice: attached to body outside #root, with text, and the main world has no loader globals.
    const noticeShown = `(function () { var e = document.querySelector('[data-omo-notice][data-reason="WATCHDOG"]'); return !!e && e.closest('#root') === null && e.textContent.trim().length > 0 && e.textContent.trim() !== 'WATCHDOG' && typeof window.__omoModsCall === 'undefined' && typeof window.omoMods === 'undefined'; })()`;
    await until(reloadedSince(sb1, b1.sessionId), 'pristine reload empty root');
    await until(() => count((e) => e.kind === 'notice' && e.sessionId === sb1) >= 1, 'notice after empty root');
    assert.equal(await evalMain(b1.sessionId, "document.querySelectorAll('[data-omo-mod-root]').length"), 0);
    assert.equal(await evalMain(b1.sessionId, notice), 1);
    assert.equal(await evalMain(b1.sessionId, noticeShown), true);
    await expandBadge(b1.sessionId);
    await until(reloadedSince(sb2, b2.sessionId), 'pristine reload late error');
    await until(() => count((e) => e.kind === 'notice' && e.sessionId === sb2) >= 1, 'notice after late error');
    assert.equal(await evalMain(b2.sessionId, "document.querySelectorAll('[data-omo-mod-root]').length"), 0);
    assert.equal(await evalMain(b2.sessionId, notice), 1);
    assert.equal(await evalMain(b2.sessionId, noticeShown), true);
    await expandBadge(b2.sessionId);
    await closeAll();
    helper.stop();

    // ---- Scenario C: a page whose owner is not the OmO tree is not attached ----
    helper = await startHelper({ loaded: loadedA, reported: [], ownerOk: async () => false });
    const c1 = await openPage(appUrl);
    await until(() => count((e) => e.kind === 'owner-mismatch' && e.targetId === c1.targetId) >= 1, 'owner mismatch');
    assert.equal(count((e) => e.kind === 'attached' && e.targetId === c1.targetId), 0);
    await closeAll();
    helper.stop();

    // ---- Scenario D: mods wait for the boot shell to report done ----
    helper = await startHelper({ loaded: loadedA, reported: [] });
    const d1 = await openPage(bootUrl);
    await until(() => attachedTo(d1.targetId), 'boot attach');
    const sd = loaderSessionOf(d1.targetId);
    const rootIsolated = `!!document.querySelector('[data-omo-mod-root="probe-mod"]')`;
    assert.equal(await helper.evaluateIsolated(d1.targetId, rootIsolated), false);
    await evalMain(d1.sessionId, "document.getElementById('boot-shell').setAttribute('data-boot-shell-state', 'done'); true");
    await until(() => planCount(sd) >= 1, 'plan after boot shell done');
    assert.equal(await helper.evaluateIsolated(d1.targetId, rootIsolated), true);
    await closeAll();
    helper.stop();
    if (process.env.OMO_TEST_DUMP_LOGS === '1') for (const line of logs) console.log(`loader log: ${line}`);
  } finally {
    for (const h of helpers) h.stop();
    if (tester) tester.close();
    await killChrome(proc);
    removeTempDir(tmp);
  }
});
