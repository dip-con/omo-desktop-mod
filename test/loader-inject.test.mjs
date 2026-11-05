import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { BINDING, WORLD, attach, buildBundle, isMainTarget, parseRequest, readMods } from '../src/loader/inject.mjs';
import { fakeCdp } from './fixtures/fake-cdp.mjs';
import { modJson, tempDir, writeMod } from './fixtures/mods-home.mjs';

const MAIN = { targetId: 't1', type: 'page', url: 'omo://app/index.html' };
const HOST = `let calls = 0; export async function handle(method, args, ctx) { calls += 1; return { method, args, ctx, calls, gen: import.meta.url.split('gen=')[1] }; }`;

function home() {
  const h = tempDir();
  writeMod(h, modJson('ko', { entry: { page: 'page.js', css: 'page.css', host: 'host.mjs' } }), { 'page.js': 'omoMods.expose({ ok: true });', 'page.css': 'a{}', 'host.mjs': HOST });
  writeMod(h, modJson('off', { enabled: false }));
  writeMod(h, modJson('bad'), { 'page.js': 'function (' });
  writeMod(h, { ...modJson('fmt'), extra: 1 });
  return h;
}

function opts(h, events, extra = {}) {
  return { modsHome: h, stateDir: '/state', ownerOk: async () => true, onEvent: (e) => events.push(e), log: () => {}, ...extra };
}

const bindingCall = (cdp, payload) => cdp.emit('Runtime.bindingCalled', { name: BINDING, payload: JSON.stringify(payload), executionContextId: 7 }, 's-t1');
const replies = (cdp) => cdp.calls('Runtime.evaluate').map((c) => c.params.expression).filter((e) => e.startsWith('window.__omoModsReply'));
const replyBody = (expr) => JSON.parse(JSON.parse(expr.slice(expr.indexOf(', ') + 2, -1)));

test('isMainTarget matches omo://app pages only', () => {
  assert.equal(isMainTarget(MAIN), true);
  assert.equal(isMainTarget({ ...MAIN, type: 'iframe' }), false);
  assert.equal(isMainTarget({ ...MAIN, url: 'https://app/' }), false);
  assert.equal(isMainTarget({ ...MAIN, url: 'not a url' }), false);
});

test('readMods loads active mods and reports disabled, bad files and bad format', () => {
  const { loaded, reported } = readMods(home());
  assert.deepEqual(loaded.map((m) => m.id), ['ko']);
  assert.equal(loaded[0].css, 'a{}');
  assert.deepEqual(reported.map((r) => [r.id, r.reason]).sort(), [['bad', 'BAD_FILES'], ['fmt', 'BAD_FORMAT'], ['off', 'DISABLED']]);
});

test('buildBundle compiles and embeds config, routeMatches and the runtime', () => {
  const bundle = buildBundle(readMods(home()).loaded, { bridgeTimeoutMs: 5 });
  new vm.Script(bundle);
  assert.match(bundle, /if \(window\.__omoMods\) return;/);
  assert.match(bundle, /bridgeTimeoutMs: 5/);
  assert.match(bundle, /function routeMatches/);
  assert.match(bundle, /__omoModsReply/);
});

test('parseRequest accepts calls to known mods and reserved controls only', () => {
  const known = new Set(['ko']);
  assert.equal(parseRequest(JSON.stringify({ id: 1, mod: 'ko', method: 'translate', args: [] }), known).ok, true);
  assert.equal(parseRequest(JSON.stringify({ id: 0, mod: '*', method: '__plan', args: [] }), known).control, true);
  assert.equal(parseRequest(JSON.stringify({ id: 0, mod: '*', method: 'evil', args: [] }), known).reason, 'control');
  assert.equal(parseRequest(JSON.stringify({ id: 1, mod: 'other', method: 'x', args: [] }), known).reason, 'unknown mod');
  assert.equal(parseRequest(JSON.stringify({ id: 1, mod: 'ko', method: '../x', args: [] }), known).reason, 'method');
  assert.equal(parseRequest('{', known).reason, 'json');
  assert.equal(parseRequest('x'.repeat(70000), known).reason, 'size');
});

test('attach registers the bundle in the isolated world with the binding, for main windows only', async () => {
  const cdp = fakeCdp({ 'Target.getTargets': { targetInfos: [MAIN, { targetId: 't2', type: 'page', url: 'devtools://x' }] } });
  const events = [];
  await attach(cdp, opts(home(), events));
  assert.deepEqual(cdp.calls('Target.attachToTarget').map((c) => c.params.targetId), ['t1']);
  assert.deepEqual(cdp.calls('Runtime.addBinding')[0].params, { name: BINDING, executionContextName: WORLD });
  assert.equal(cdp.calls('Page.addScriptToEvaluateOnNewDocument')[0].params.worldName, WORLD);
  assert.deepEqual(events.map((e) => e.kind), ['attached']);
});

test('an owner mismatch attaches nothing', async () => {
  const cdp = fakeCdp({ 'Target.getTargets': { targetInfos: [MAIN] } });
  const events = [];
  await attach(cdp, opts(home(), events, { ownerOk: async () => false }));
  assert.deepEqual(cdp.calls('Target.attachToTarget'), []);
  assert.deepEqual(events.map((e) => e.kind), ['owner-mismatch']);
});

test('host calls get ctx and a reply; __reload re-imports the host under a new generation', async () => {
  const h = home();
  const cdp = fakeCdp({ 'Target.getTargets': { targetInfos: [MAIN] } });
  const events = [];
  await attach(cdp, opts(h, events));
  await bindingCall(cdp, { id: 1, mod: 'ko', method: 'translate', args: ['Hi'] });
  const first = replyBody(replies(cdp)[0]);
  assert.equal(first.ok, true);
  assert.deepEqual(first.value.ctx, { modId: 'ko', modDir: path.join(h, 'ko'), stateDir: '/state', modsHome: h });
  await bindingCall(cdp, { id: 2, mod: 'ko', method: 'translate', args: [] });
  assert.equal(replyBody(replies(cdp)[1]).value.calls, 2);
  await bindingCall(cdp, { id: 0, mod: 'ko', method: '__reload', args: [] });
  assert.equal(cdp.calls('Page.removeScriptToEvaluateOnNewDocument').length, 1);
  assert.equal(cdp.calls('Page.reload').length, 1);
  await bindingCall(cdp, { id: 3, mod: 'ko', method: 'translate', args: [] });
  const after = replyBody(replies(cdp)[2]).value;
  assert.equal(after.calls, 1);
  assert.notEqual(after.gen, first.value.gen);
  assert.ok(events.some((e) => e.kind === 'reloaded'));
});

test('a host that fails to load is reported as host-failed and the call rejects', async () => {
  const h = home();
  fs.writeFileSync(path.join(h, 'ko', 'host.mjs'), 'export const handle = ;');
  const cdp = fakeCdp({ 'Target.getTargets': { targetInfos: [MAIN] } });
  const events = [];
  await attach(cdp, opts(h, events));
  await bindingCall(cdp, { id: 1, mod: 'ko', method: 'x', args: [] });
  assert.equal(replyBody(replies(cdp)[0]).ok, false);
  assert.equal(events.find((e) => e.kind === 'host-failed').mod, 'ko');
});

test('plan control events carry the reported mods', async () => {
  const cdp = fakeCdp({ 'Target.getTargets': { targetInfos: [MAIN] } });
  const events = [];
  await attach(cdp, opts(home(), events));
  await bindingCall(cdp, { id: 0, mod: '*', method: '__plan', args: [[{ id: 'ko', attached: true, reason: null }], '/'] });
  const plan = events.find((e) => e.kind === 'plan');
  assert.equal(plan.pathname, '/');
  assert.equal(plan.reported.length, 3);
});

test('watchdog removes the bundle and reloads, then shows the notice after the reloaded load; capped at 3 per target', async () => {
  const cdp = fakeCdp({ 'Target.getTargets': { targetInfos: [MAIN] } });
  const events = [];
  const counts = new Map();
  await attach(cdp, opts(home(), events, { watchdogCounts: counts }));
  await bindingCall(cdp, { id: 0, mod: '*', method: '__watchdog', args: ['root empty'] });
  await bindingCall(cdp, { id: 0, mod: '*', method: '__watchdog', args: ['again'] });
  assert.equal(cdp.calls('Page.removeScriptToEvaluateOnNewDocument').length, 1);
  assert.equal(cdp.calls('Page.reload').length, 1);
  await cdp.emit('Page.loadEventFired', {}, 's-t1');
  assert.equal(events.filter((e) => e.kind === 'notice').length, 0);
  await cdp.emit('Page.frameNavigated', { frame: { id: 'f' } }, 's-t1');
  await cdp.emit('Page.loadEventFired', {}, 's-t1');
  assert.equal(events.filter((e) => e.kind === 'notice').length, 1);
  const notice = cdp.calls('Runtime.evaluate').at(-1).params.expression;
  assert.match(notice, /noticeOnly: true/);
  counts.set('t1', 3);
  await bindingCall(cdp, { id: 0, mod: '*', method: '__watchdog', args: ['x'] });
  assert.equal(cdp.calls('Page.reload').length, 1);
  assert.equal(events.filter((e) => e.kind === 'notice').length, 2);
  assert.equal(events.filter((e) => e.kind === 'watchdog').at(-1).capped, true);
});
