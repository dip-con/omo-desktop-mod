// Session bookkeeping of serveMainWindows on a fake CDP connection: targetDestroyed, Inspector.detached each drop the affected session (a renderer crash keeps it: see watchdog.test.mjs), and a later target attaches as a fresh session.
// The fake answers the calls the attach makes; events are emitted by the test, and work is awaited by settle().
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { serveMainWindows } from '../loader/inject.mjs';

const LOADER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'loader');
const RULE = { protocol: 'https:', host: 'omo.test' };
const page = (targetId) => ({ targetId, type: 'page', url: 'https://omo.test/settings/general' });
// Resolves after the attach chains that are already queued: they only await resolved promises.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function fakeCdp(targetInfos) {
  const listeners = new Map();
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
    send: (method) => answer(method),
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

async function start() {
  const cdp = fakeCdp([page('T1')]);
  const helper = await serveMainWindows({
    wsUrl: 'ws://fake',
    openCdp: async () => cdp,
    rule: RULE,
    resolveMods: () => ({ loaded: [], reported: [] }),
    buildKey: 'test',
    loaderDir: LOADER,
    ownerOk: async () => true,
    onEvent: () => {},
    log: () => {},
  });
  assert.equal(helper.sessionOf('T1'), 'S1');
  return { cdp, helper };
}

test('Target.targetDestroyed drops the session, and the same target id attaches again as a fresh session', async () => {
  const { cdp, helper } = await start();
  cdp.emit('Target.targetDestroyed', { targetId: 'T1' });
  assert.equal(helper.sessionOf('T1'), null);
  cdp.emit('Target.targetCreated', { targetInfo: page('T1') });
  await settle();
  assert.equal(helper.sessionOf('T1'), 'S2');
});

test('Inspector.detached drops the session that detached, and a new attach gets a fresh session', async () => {
  const { cdp, helper } = await start();
  cdp.emit('Inspector.detached', {}, 'S1');
  assert.equal(helper.sessionOf('T1'), null);
  cdp.emit('Target.targetCreated', { targetInfo: page('T1') });
  await settle();
  assert.equal(helper.sessionOf('T1'), 'S2');
});

