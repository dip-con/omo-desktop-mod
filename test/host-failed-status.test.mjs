// A mod whose host call fails before its host loads (no entry.host, or the module cannot load) is reported in status
// with reason HOST_FAILED, and a later plan from the page keeps that reason instead of showing it attached again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wireInject } from '../loader/deps.mjs';

function fakeIo(writes) {
  const captured = {};
  let state = {};
  const io = {
    answers: async () => ({ webSocketDebuggerUrl: 'ws://fake' }),
    readFacts: () => ({ mainTarget: 'omo://app' }),
    discoverMods: () => ({ mods: [], skipped: [] }),
    partitionEnabled: (mods) => ({ active: mods, disabled: [] }),
    loadModSources: (mods) => ({ loaded: mods, skipped: [] }),
    mainRuleFromFacts: () => ({ protocol: 'omo:', host: 'app' }),
    serveMainWindows: async (opts) => {
      captured.onEvent = opts.onEvent;
      return { done: Promise.resolve() };
    },
    ownerAllowed: () => true,
    portOwner: () => null,
    processChildren: () => () => [],
    readState: () => state,
    writeState: (next) => {
      state = next;
      writes.push(next);
    },
    messageBox: () => {},
    log: () => {},
    buildKey: () => 'build',
    fingerprint: () => ({}),
    loaderDir: '.',
    modsRoot: '.',
  };
  return { io, captured, stateOf: () => state };
}

test('a host failure is kept in status when the page later reports its plan', async () => {
  const writes = [];
  const { io, captured, stateOf } = fakeIo(writes);
  const inject = wireInject(io);
  await inject({ port: 1, omoProfile: null });
  captured.onEvent({ kind: 'host-failed', sessionId: 'S1', mod: 'ko', detail: 'NO_HOST' });
  captured.onEvent({
    kind: 'plan',
    sessionId: 'S1',
    pathname: '/',
    states: [
      { id: 'ko', attached: true, reason: null },
      { id: 'sample', attached: true, reason: null },
    ],
  });
  const mods = stateOf().mods;
  assert.deepEqual(
    mods.find((m) => m.id === 'ko'),
    { id: 'ko', attached: false, reason: 'HOST_FAILED' },
  );
  assert.deepEqual(
    mods.find((m) => m.id === 'sample'),
    { id: 'sample', attached: true, reason: null },
  );
});
