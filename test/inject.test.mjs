// Unit tests for the bridge request check and the bundle contract in loader/inject.mjs (no browser).
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { BINDING, buildBundle, parseRequest, serveMainWindows } from '../loader/inject.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const LOADER = path.join(here, '..', 'loader');
const KNOWN = new Set(['probe-mod']);
const req = (obj) => JSON.stringify(obj);

test('a well-formed host call is accepted for a known mod', () => {
  const out = parseRequest(req({ id: 3, mod: 'probe-mod', method: 'poke', args: [1, 'x'] }), KNOWN);
  assert.equal(out.ok, true);
  assert.equal(out.control, false);
  assert.equal(out.mod, 'probe-mod');
});

test('payloads that are not text, not JSON, or not an object are refused', () => {
  assert.equal(parseRequest(42, KNOWN).reason, 'size');
  assert.equal(parseRequest('{not json', KNOWN).reason, 'json');
  assert.equal(parseRequest('null', KNOWN).reason, 'id');
});

test('an oversized payload is refused before parsing', () => {
  assert.equal(parseRequest('x'.repeat(70000), KNOWN).reason, 'size');
});

test('a negative, fractional or missing id is refused', () => {
  assert.equal(parseRequest(req({ id: -1, mod: 'probe-mod', method: 'poke', args: [] }), KNOWN).reason, 'id');
  assert.equal(parseRequest(req({ id: 1.5, mod: 'probe-mod', method: 'poke', args: [] }), KNOWN).reason, 'id');
  assert.equal(parseRequest(req({ mod: 'probe-mod', method: 'poke', args: [] }), KNOWN).reason, 'id');
});

test('an unknown mod and a bad method name are refused', () => {
  assert.equal(parseRequest(req({ id: 2, mod: 'other-mod', method: 'poke', args: [] }), KNOWN).reason, 'unknown mod');
  assert.equal(parseRequest(req({ id: 2, mod: 'probe-mod', method: '__proto__', args: [] }), KNOWN).reason, 'method');
  assert.equal(parseRequest(req({ id: 2, mod: 'probe-mod', method: 'a'.repeat(80), args: [] }), KNOWN).reason, 'method');
});

test('args must be an array', () => {
  assert.equal(parseRequest(req({ id: 2, mod: 'probe-mod', method: 'poke', args: {} }), KNOWN).reason, 'args');
});

test('control messages use id 0 and only the reserved method names', () => {
  const plan = parseRequest(req({ id: 0, mod: '*', method: '__plan', args: [[], '/'] }), KNOWN);
  assert.equal(plan.ok, true);
  assert.equal(plan.control, true);
  assert.equal(parseRequest(req({ id: 0, mod: '*', method: 'poke', args: [] }), KNOWN).reason, 'control');
  assert.equal(parseRequest(req({ id: 0, mod: '*', method: '__unknown', args: [] }), KNOWN).reason, 'control');
});

test('the bundle carries the double-injection guard and the reported entries for the notice', () => {
  // Given: one mod, one entry reported as DISABLED and one as a format error
  const bundle = buildBundle({
    mods: [{ id: 'probe-mod', nameKo: '탐침', anchors: [{ selector: '#root', route: '*' }], testedBuilds: ['k'], css: '', pageSrc: '' }],
    buildKey: 'k',
    loaderDir: LOADER,
    reported: [
      { id: 'off-mod', name: 'off-mod', attached: false, reason: 'DISABLED' },
      { id: 'bad-mod', name: 'bad-mod', attached: false, reason: 'BAD_FORMAT' },
    ],
    omoProfile: 'work',
    bridgeTimeoutMs: 500,
  });
  // Then: the guard is the first statement, and the config carries the reported reasons and the timeout
  assert.equal(bundle.includes('if (window.__omoMods) return;'), true);
  assert.equal(bundle.includes('"reason":"DISABLED"'), true);
  assert.equal(bundle.includes('"reason":"BAD_FORMAT"'), true);
  assert.equal(bundle.includes('bridgeTimeoutMs: 500'), true);
  assert.equal(bundle.includes('omoProfile: "work"'), true);
});

// A browser stand-in just big enough for the bundle to boot and run its mods: the boot shell reports done, every
// anchor is present, and the loader's control messages are collected. Values cross the vm boundary as JSON.
function bootBundle(bundle) {
  const sent = [];
  const seen = [];
  const node = () => ({ style: {}, setAttribute() {}, getAttribute: () => null, addEventListener() {}, appendChild() {} });
  const sandbox = {
    seen,
    setTimeout: () => 0,
    clearTimeout: () => {},
    MutationObserver: class { observe() {} disconnect() {} },
    location: { pathname: '/' },
    addEventListener() {},
    __omoModsCall: (payload) => sent.push(JSON.parse(payload)),
    document: {
      readyState: 'complete',
      head: node(),
      body: node(),
      createElement: node,
      getElementById: (id) => (id === 'root' ? { childElementCount: 1 } : null),
      querySelector: (selector) => (selector === '#root' || selector.startsWith('#boot-shell') ? {} : null),
      querySelectorAll: () => [],
    },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(bundle, sandbox);
  return { sent, seen: seen.map((s) => JSON.parse(s)) };
}

test('each page script gets its own mod.json order as omoMods.order', () => {
  // Given: two mods whose pages record the order they are handed, in loader order
  const mod = (id, order) => ({ id, nameKo: id, order, anchors: [{ selector: '#root', route: '*' }], testedBuilds: ['k'], css: '',
    pageSrc: `seen.push(JSON.stringify([${JSON.stringify(id)}, omoMods.order]));` });
  const bundle = buildBundle({ mods: [mod('first-mod', 0), mod('second-mod', 10)], buildKey: 'k', loaderDir: LOADER });
  // When: the bundle boots on a page where every anchor is present
  const { seen, sent } = bootBundle(bundle);
  // Then: both pages ran, each with its own order, and the plan reports both attached
  assert.deepEqual(seen, [['first-mod', 0], ['second-mod', 10]]);
  const plan = sent.find((m) => m.method === '__plan');
  assert.deepEqual(plan.args[0].map((s) => [s.id, s.attached]), [['first-mod', true], ['second-mod', true]]);
});

// A fake CDP connection for one attached main window. It keeps the document scripts registered by identifier, and
// records the scripts that are registered at the moment each Page.reload runs.
const RULE = { protocol: 'https:', host: 'omo.test' };
const page = (targetId) => ({ targetId, type: 'page', url: 'https://omo.test/settings/general' });
const markedMod = (marker) => ({ id: 'ko', nameKo: '한글', anchors: [{ selector: '#root', route: '*' }], testedBuilds: ['test'], css: '', pageSrc: `var marker = '${marker}';` });

function fakeCdp(targetInfos, onReload) {
  const listeners = new Map();
  const calls = [];
  const registered = new Map();
  const atReload = [];
  let nextId = 1;
  return {
    calls,
    atReload,
    send: async (method, params = {}) => {
      calls.push(method);
      switch (method) {
        case 'Target.getTargets': return { targetInfos };
        case 'Target.attachToTarget': return { sessionId: 'S1' };
        case 'Page.getFrameTree': return { frameTree: { frame: { id: 'F' } } };
        case 'Page.createIsolatedWorld': return { executionContextId: 7 };
        case 'Page.addScriptToEvaluateOnNewDocument': {
          const identifier = `ID${nextId++}`;
          registered.set(identifier, params.source);
          return { identifier };
        }
        case 'Page.removeScriptToEvaluateOnNewDocument':
          registered.delete(params.identifier);
          return {};
        case 'Page.reload':
          atReload.push([...registered.values()]);
          onReload();
          return {};
        case 'Runtime.evaluate': return { result: {} };
        default: return {};
      }
    },
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    emit: (event, params, sessionId) => {
      for (const fn of listeners.get(event) ?? []) fn(params ?? {}, sessionId);
    },
    close: () => {},
  };
}

test('__reload removes the old script, registers the current bundle, then reloads; the new bundle is registered at reload', { timeout: 5000 }, async () => {
  // Given: one attached main window, and a mod whose page changes after the attach
  let current = { loaded: [markedMod('omo-test-marker-v1')], reported: [] };
  let reloaded;
  const reloadSeen = new Promise((resolve) => { reloaded = resolve; });
  const cdp = fakeCdp([page('T1')], () => reloaded());
  await serveMainWindows({
    wsUrl: 'ws://fake',
    openCdp: async () => cdp,
    rule: RULE,
    resolveMods: () => current,
    buildKey: 'test',
    loaderDir: LOADER,
    ownerOk: async () => true,
    onEvent: () => {},
    log: () => {},
  });
  current = { loaded: [markedMod('omo-test-marker-v2')], reported: [] };
  const mark = cdp.calls.length;
  // When: the mod page asks for a reload (a control message with id 0)
  cdp.emit('Runtime.bindingCalled', { name: BINDING, payload: JSON.stringify({ id: 0, mod: '*', method: '__reload', args: [] }), executionContextId: 7 }, 'S1');
  await reloadSeen;
  // Then: remove, add and reload, in that order, and the script registered at reload holds the new mod only
  const sequence = cdp.calls.slice(mark).filter((m) => ['Page.removeScriptToEvaluateOnNewDocument', 'Page.addScriptToEvaluateOnNewDocument', 'Page.reload'].includes(m));
  assert.deepEqual(sequence, ['Page.removeScriptToEvaluateOnNewDocument', 'Page.addScriptToEvaluateOnNewDocument', 'Page.reload']);
  assert.equal(cdp.atReload.length, 1);
  assert.equal(cdp.atReload[0].length, 1);
  assert.ok(cdp.atReload[0][0].includes('omo-test-marker-v2'));
  assert.ok(!cdp.atReload[0][0].includes('omo-test-marker-v1'));
});
