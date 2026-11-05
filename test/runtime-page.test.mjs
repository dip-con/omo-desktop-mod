import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBundle } from '../src/loader/inject.mjs';
import { fakePage } from './fixtures/fake-page.mjs';

const mod = (id, pageSrc, anchors = [{ selector: '#root', route: '*' }]) => ({ id, nameKo: `${id} 모드`, order: 10, anchors, css: `.${id}{}`, pageSrc });

function page(mods, options = {}, ctx = {}) {
  const p = fakePage(buildBundle(mods, { bridgeTimeoutMs: 30000, ...ctx }), options);
  p.run();
  return p;
}

test('a mod whose anchors are present runs once with its css and the plan is reported', () => {
  const p = page([mod('ko', 'window.koRan = (window.koRan || 0) + 1; omoMods.expose({ hi: 1 });')]);
  assert.equal(p.window.koRan, 1);
  assert.equal(p.styles[0].getAttribute('data-omo-mod'), 'ko');
  assert.deepEqual(p.controls('__plan')[0].args, [[{ id: 'ko', attached: true, reason: null }], '/']);
  assert.equal(p.window.omoMods.exposed.ko.hi, 1);
  assert.equal(p.badge().textContent, '모드 1개 켜짐');
  p.run();
  assert.equal(p.window.koRan, 1);
});

test('a missing anchor waits for the route, then reports ANCHOR_MISSING and hides the mod roots', () => {
  const p = page([mod('mgr', 'window.mgrRan = true;', [{ selector: '#root', route: '*' }, { selector: '.nav', route: '/settings/' }])], { pathname: '/settings/models' });
  assert.equal(p.controls('__plan').length, 0);
  p.runTimers(5000);
  const [states] = p.controls('__plan')[0].args;
  assert.deepEqual(states, [{ id: 'mgr', attached: false, reason: 'ANCHOR_MISSING' }]);
  assert.equal(p.window.mgrRan, undefined);
});

test('a route change re-evaluates anchors and toggles the mod roots', () => {
  const p = page([mod('mgr', '', [{ selector: '.nav', route: '/settings/' }])], { pathname: '/' });
  const root = p.addRoot('mgr');
  p.window.location.pathname = '/settings/x';
  p.mutate();
  p.runTimers(5000);
  assert.equal(root.hidden, true);
  p.setPresent('.nav', true);
  p.window.location.pathname = '/settings/y';
  p.mutate();
  assert.equal(root.hidden, false);
  assert.deepEqual(p.controls('__plan').map((c) => c.args[1]), ['/', '/settings/x', '/settings/y']);
});

test('a throwing mod sends __fail and is reported as MOD_ERROR', () => {
  const p = page([mod('bad', 'throw new Error("boom");')]);
  assert.deepEqual(p.controls('__fail')[0], { id: 0, mod: 'bad', method: '__fail', args: ['boom'] });
  assert.equal(p.controls('__plan')[0].args[0][0].reason, 'MOD_ERROR');
});

test('an empty #root or an uncaught error asks for the watchdog', () => {
  const empty = page([mod('ko', '')], { rootChildren: 0 });
  assert.deepEqual(empty.controls('__watchdog')[0].args, ['root empty']);
  const p = page([mod('ko', '')]);
  p.fire('error', { message: 'mod broke' });
  assert.deepEqual(p.controls('__watchdog')[0].args, ['mod broke']);
});

test('nothing runs before the boot shell is done', () => {
  const p = page([mod('ko', 'window.koRan = true;')], { present: ['#root', '#boot-shell'] });
  assert.equal(p.window.koRan, undefined);
  p.setPresent('#boot-shell', false);
  p.mutate();
  assert.equal(p.window.koRan, true);
});

test('omoMods.call resolves through __omoModsReply and rejects after the bridge timeout', async () => {
  const p = page([mod('ko', 'window.api = omoMods;')]);
  const ok = p.window.api.call('translate', ['Hi']);
  const req = p.sent.find((m) => m.id > 0);
  assert.deepEqual(req, { id: req.id, mod: 'ko', method: 'translate', args: ['Hi'] });
  p.window.__omoModsReply(req.id, JSON.stringify({ ok: true, value: '안녕' }));
  assert.equal(await ok, '안녕');
  const failed = p.window.api.call('x', []);
  p.window.__omoModsReply(req.id + 1, JSON.stringify({ ok: false, error: 'NO_HOST' }));
  await assert.rejects(failed, /NO_HOST/);
  const late = p.window.api.call('slow', []);
  p.runTimers(30000);
  await assert.rejects(late, /BRIDGE_TIMEOUT/);
});

test('onTrusted ignores scripted clicks; reload sends __reload', () => {
  const p = page([mod('ko', 'window.api = omoMods;')]);
  const el = p.document.createElement('button');
  let clicks = 0;
  p.window.api.onTrusted(el, () => (clicks += 1));
  el.dispatch('click', { isTrusted: false });
  el.dispatch('click', { isTrusted: true });
  assert.equal(clicks, 1);
  p.window.api.reload();
  assert.equal(p.controls('__reload')[0].mod, 'ko');
});

test('the notice-only bundle shows the badge without mods, plan or watchdog', () => {
  const p = page([], { rootChildren: 0 }, { noticeOnly: true, reported: [{ id: '*', name: '', attached: false, reason: 'WATCHDOG' }] });
  assert.equal(p.sent.length, 0);
  assert.equal(p.badge().textContent, '모드 0개 켜짐');
  p.badge().dispatch('click', {});
  assert.equal(p.badge().textContent, '화면이 비어 모든 모드를 떼고 다시 열었어요');
});
