// Watchdog bookkeeping on a fake CDP connection: a renderer crash keeps the session, and reloads stop at the cap.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { BINDING, serveMainWindows } from '../loader/inject.mjs';

const LOADER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'loader');
const RULE = { protocol: 'https:', host: 'omo.test' };
const page = (targetId) => ({ targetId, type: 'page', url: 'https://omo.test/settings/general' });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeCdp(targetInfos) {
  const listeners = new Map();
  const calls = [];
  let nextSession = 1;
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
  return {
    calls,
    send: (method) => {
      calls.push(method);
      return answer(method);
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

async function start(maxReloads) {
  const cdp = fakeCdp([page('T1')]);
  const events = [];
  const helper = await serveMainWindows({
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
  const watchdog = () => {
    cdp.emit('Runtime.bindingCalled', { name: BINDING, payload: JSON.stringify({ id: 0, mod: '*', method: '__watchdog', args: ['x'] }), executionContextId: 7 }, 'S1');
    return settle();
  };
  // The reloaded document commits (main frame navigation) before it loads, as Chromium does.
  const loaded = () => {
    cdp.emit('Page.frameNavigated', { frame: { id: 'F', url: 'https://omo.test/settings/general' } }, 'S1');
    cdp.emit('Page.loadEventFired', {}, 'S1');
    return settle();
  };
  return { cdp, helper, events, watchdog, loaded };
}

test('a renderer crash keeps the session, so a later attach of the same target does not create a second one', async () => {
  const { cdp, helper } = await start();
  cdp.emit('Inspector.targetCrashed', {}, 'S1');
  cdp.emit('Target.targetInfoChanged', { targetInfo: page('T1') });
  await settle();
  assert.equal(helper.sessionOf('T1'), 'S1');
  assert.equal(cdp.calls.filter((m) => m === 'Target.attachToTarget').length, 1);
});

test('after a renderer crash the watchdog still acts on the same session and reports the crash', async () => {
  const { cdp, events, watchdog } = await start();
  cdp.emit('Inspector.targetCrashed', {}, 'S1');
  await watchdog();
  assert.ok(events.some((e) => e.kind === 'watchdog' && e.sessionId === 'S1' && e.crashed === true));
  assert.equal(cdp.calls.filter((m) => m === 'Page.reload').length, 1);
});

test('watchdog reloads stop at the cap: the third watchdog removes nothing new, reloads nothing, and reports the cap', async () => {
  const { cdp, events, watchdog, loaded } = await start(2);
  await watchdog();
  await loaded();
  await watchdog();
  await loaded();
  await watchdog();
  assert.equal(cdp.calls.filter((m) => m === 'Page.reload').length, 2);
  assert.ok(events.some((e) => e.kind === 'watchdog-capped' && e.reloads === 3));
});

test('the notice waits for the reloaded document: an old document load before the reload commits does not show it', async () => {
  const { cdp, events, watchdog, loaded } = await start();
  await watchdog();
  cdp.emit('Page.loadEventFired', {}, 'S1');
  await settle();
  assert.equal(events.filter((e) => e.kind === 'notice').length, 0, 'the old document load shows no notice');
  cdp.emit('Page.frameNavigated', { frame: { id: 'F', url: 'https://omo.test/settings/general' } }, 'S1');
  await loaded();
  assert.equal(events.filter((e) => e.kind === 'notice').length, 1, 'the reloaded document shows the notice once');
});
