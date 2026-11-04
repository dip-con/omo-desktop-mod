// Watchdog episodes on a fake CDP connection: one reload per episode, the notice only after the reloaded document
// commits, one message box per target, and the reload cap across episodes. The fake answers only the calls the loader
// makes; events are emitted by the test, and work is awaited with settle(), which waits for queued microtasks only.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BINDING, serveMainWindows } from '../loader/inject.mjs';
import { notifyWatchdog } from '../loader/deps.mjs';

const LOADER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'loader');
const RULE = { protocol: 'https:', host: 'omo.test' };
const page = (targetId) => ({ targetId, type: 'page', url: 'https://omo.test/settings/general' });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeCdp(targetInfos, { holdRemoval = false } = {}) {
  const listeners = new Map();
  const calls = [];
  let nextSession = 1;
  let release = null;
  const answer = async (method) => {
    switch (method) {
      case 'Target.getTargets':
        return { targetInfos };
      case 'Target.attachToTarget':
        return { sessionId: `S${nextSession++}` };
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'F' } } };
      case 'Page.createIsolatedWorld':
        return { executionContextId: 7 };
      case 'Page.addScriptToEvaluateOnNewDocument':
        return { identifier: 'ID' };
      case 'Runtime.evaluate':
        return { result: {} };
      default:
        return {};
    }
  };
  const cdp = {
    calls,
    send: (method) => {
      calls.push(method);
      if (holdRemoval && method === 'Page.removeScriptToEvaluateOnNewDocument') {
        return new Promise((resolve) => {
          release = () => resolve({});
        });
      }
      return answer(method);
    },
    release: () => release?.(),
    on: (event, fn) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
    },
    emit: (event, params, sessionId) => {
      for (const fn of listeners.get(event) ?? []) fn(params ?? {}, sessionId);
    },
    close: () => {},
  };
  return cdp;
}

async function start({ maxReloads = 3, holdRemoval = false } = {}) {
  const cdp = fakeCdp([page('T1')], { holdRemoval });
  const events = [];
  await serveMainWindows({
    wsUrl: 'ws://fake',
    openCdp: async () => cdp,
    rule: RULE,
    resolveMods: () => ({ loaded: [], reported: [] }),
    buildKey: 'test',
    loaderDir: LOADER,
    ownerOk: async () => true,
    onEvent: (e) => events.push(e),
    log: () => {},
    maxReloads,
  });
  return {
    cdp,
    events,
    fire: () => cdp.emit('Runtime.bindingCalled', { name: BINDING, payload: JSON.stringify({ id: 0, mod: '*', method: '__watchdog', args: ['late failure'] }), executionContextId: 7 }, 'S1'),
    commit: (parentId) => cdp.emit('Page.frameNavigated', { frame: { id: parentId ? 'SUB' : 'F', ...(parentId ? { parentId } : {}), url: 'https://omo.test/settings/general' } }, 'S1'),
    load: () => cdp.emit('Page.loadEventFired', {}, 'S1'),
  };
}

const count = (events, pred) => events.filter(pred).length;
const reloads = (cdp) => cdp.calls.filter((m) => m === 'Page.reload').length;
const notices = (events) => count(events, (e) => e.kind === 'notice');

test('a second watchdog while the script removal is pending does not start a second reload', async () => {
  const { cdp, events, fire, commit, load } = await start({ holdRemoval: true });
  fire();
  fire();
  cdp.release();
  await settle();
  assert.equal(reloads(cdp), 1);
  assert.equal(count(events, (e) => e.kind === 'watchdog'), 1);
  commit();
  load();
  await settle();
  assert.equal(notices(events), 1);
});

test('a second watchdog after the old document loads and before the reload commits does not start a second reload', async () => {
  const { cdp, events, fire, commit, load } = await start();
  fire();
  await settle();
  load();
  await settle();
  assert.equal(notices(events), 0, 'the old document load shows no notice');
  fire();
  await settle();
  assert.equal(reloads(cdp), 1);
  commit();
  load();
  await settle();
  assert.equal(notices(events), 1);
});

test('a subframe navigation in the reload window does not count as the commit of the reloaded document', async () => {
  const { events, fire, commit, load } = await start();
  fire();
  await settle();
  commit('F');
  load();
  await settle();
  assert.equal(notices(events), 0);
  commit();
  load();
  await settle();
  assert.equal(notices(events), 1);
});

test('the reload cap holds across later episodes that start after the reloaded document committed', async () => {
  const { cdp, events, fire, commit, load } = await start({ maxReloads: 3 });
  for (let i = 0; i < 3; i += 1) {
    fire();
    await settle();
    commit();
    load();
    await settle();
  }
  assert.equal(reloads(cdp), 3);
  fire();
  await settle();
  assert.equal(reloads(cdp), 3);
  assert.ok(events.some((e) => e.kind === 'watchdog-capped' && e.reloads === 4));
});

test('one message box per target across both orderings', async () => {
  const boxes = [];
  const shown = new Set();
  const { cdp, events, fire, commit, load } = await start({ holdRemoval: true });
  fire();
  fire();
  cdp.release();
  await settle();
  commit();
  load();
  await settle();
  for (const e of events) notifyWatchdog(e, (t) => boxes.push(t), shown);
  assert.equal(boxes.length, 1);
});
