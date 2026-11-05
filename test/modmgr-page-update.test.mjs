// The update card of Settings > 모드 (mods/modmgr/page.js). The page runs here the way the loader runs it, as
// function (omoMods) {...}, with no document: it exposes its pure half and returns before the DOM glue. omoMods.call
// records the host methods the two flows ask for and answers them from a scripted list of replies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'mods', 'modmgr', 'page.js'), 'utf8');

const MODS = [
  { id: 'modmgr', nameKo: '모드 관리', enabled: true, locked: true, status: '붙음', reasonKo: '', expected: 'a' },
  { id: 'ko', nameKo: '한국어 번역', enabled: true, locked: false, status: '붙음', reasonKo: '', expected: 'b' },
];

// Loads the page with a host that answers each call from `replies`, in order; an Error in the list rejects the call.
function loadPage(replies = []) {
  const calls = [];
  let api = null;
  const omoMods = {
    expose: (value) => { api = value; },
    call: (method, args) => {
      calls.push([method, args]);
      const reply = replies.shift();
      return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
    },
    onTrusted: () => {},
    order: 0,
  };
  new Function('omoMods', source)(omoMods);
  const view = {
    status: 'ready', cards: api.cardsFrom(MODS), failure: null, busy: null, msg: null, pending: false, confirm: null, pageError: null,
    update: api.emptyUpdate(),
  };
  const applied = [];
  const io = { request: api.request, paint: () => {}, guard: (fn) => fn, live: () => true, applied: (ids) => applied.push(ids) };
  return { api, calls, view, io, applied };
}

// The opening tag of the button with this data-act, or null when the page does not show it.
const button = (html, act) => html.match(new RegExp(`<button[^>]*data-act="${act}"[^>]*>`))?.[0] ?? null;
// [tone, text] of the status chip in the row of this id, or null.
function row(html, id) {
  const li = html.match(new RegExp(`<li class="mm-update-row" data-mm-update-row="${id}">(.*?)</li>`));
  return li ? li[1].match(/<span class="mm-chip" data-tone="(\w+)">(.*?)<\/span>/).slice(1) : null;
}

test('before a check: the card under the list has the title and [업데이트 확인] only, in every list state', () => {
  const { api, view } = loadPage();
  const html = api.render(view);
  assert.ok(html.includes('id="mm-update-title">업데이트</h2>'));
  const check = button(html, 'update-check');
  assert.ok(check);
  assert.ok(!check.includes('aria-disabled') && !check.includes('aria-busy'));
  assert.equal(button(html, 'update-apply'), null);
  assert.ok(html.indexOf('data-mm-update ') > html.indexOf('aria-label="모드 목록"'));
  const withNotice = api.render({ ...view, pending: true });
  assert.ok(withNotice.indexOf('data-mm-update ') < withNotice.indexOf('data-mm-notice'));
  assert.ok(api.render({ ...view, status: 'loading' }).includes('data-mm-update '));
  assert.ok(api.render({ ...view, status: 'failed', failure: { code: 'BAD_STATE' } }).includes('data-mm-update '));
});

test('[업데이트 확인] calls checkUpdates once; both buttons wait meanwhile; each row shows its status', async () => {
  const { api, calls, view, io } = loadPage([{
    ok: true,
    items: [
      { id: 'ko', source: {}, installedHash: 'a', sourceHash: 'b', changed: true, error: null },
      { id: 'modmgr', source: {}, installedHash: 'c', sourceHash: 'c', changed: false, error: null },
      { id: '_loader', source: null, installedHash: null, sourceHash: null, changed: false, error: 'SOURCE_MISSING: /src/loader not found' },
    ],
  }]);
  const pending = api.runUpdateCheck(view, io);
  assert.deepEqual(calls, [['checkUpdates', []]]);
  let html = api.render(view);
  assert.ok(button(html, 'update-check').includes('aria-disabled="true"'));
  assert.ok(button(html, 'update-check').includes('aria-busy="true"'));
  assert.equal(api.updateStatusText(view.update), '업데이트를 확인하는 중이에요');
  // A second press while it runs does nothing.
  assert.equal(api.runUpdateCheck(view, io), null);
  assert.equal(calls.length, 1);
  await pending;
  html = api.render(view);
  assert.deepEqual(row(html, 'ko'), ['warn', '새 버전 있음']);
  assert.deepEqual(row(html, 'modmgr'), ['ok', '최신']);
  assert.deepEqual(row(html, '_loader'), ['danger', '확인 실패: 설치 원본 폴더를 찾지 못했어요 (/src/loader not found)']);
  assert.ok(html.includes('<span class="mm-update-mod">한국어 번역</span><span class="mm-update-id">ko</span>'));
  assert.ok(html.includes('<span class="mm-update-mod">로더</span><span class="mm-update-id">_loader</span>'));
  const apply = button(html, 'update-apply');
  assert.ok(apply);
  assert.ok(apply.includes('mm-btn-primary') && !apply.includes('aria-disabled'));
  assert.ok(!button(html, 'update-check').includes('aria-disabled'));
  assert.equal(api.updateStatusText(view.update), '새 버전이 있는 모드 1개, 확인 실패 1개');
});

test('[업데이트 적용] sends the changed ids with pull, shows each result, and hands the applied ids to the page', async () => {
  const { api, calls, view, io, applied } = loadPage([
    { ok: true, items: [{ id: 'ko', changed: true, error: null }, { id: 'modmgr', changed: true, error: null }, { id: '_loader', changed: false, error: null }] },
    { ok: true, applied: ['ko'], skipped: [{ id: 'modmgr', reason: 'UNCHANGED' }], errors: [{ id: 'ko', message: 'git pull --ff-only failed: no upstream' }] },
  ]);
  await api.runUpdateCheck(view, io);
  const pending = api.runUpdateApply(view, io);
  assert.deepEqual(calls[1], ['applyUpdates', [{ ids: ['ko', 'modmgr'], pull: true }]]);
  let html = api.render(view);
  assert.ok(button(html, 'update-apply').includes('aria-busy="true"'));
  assert.ok(button(html, 'update-apply').includes('aria-disabled="true"'));
  assert.ok(button(html, 'update-check').includes('aria-disabled="true"'));
  assert.equal(api.runUpdateApply(view, io), null);
  await pending;
  html = api.render(view);
  assert.deepEqual(row(html, 'ko'), ['ok', '적용됨']);
  assert.deepEqual(row(html, 'modmgr'), ['off', '바뀐 게 없어요']);
  assert.deepEqual(row(html, '_loader'), ['ok', '최신']);
  assert.ok(html.includes('한국어 번역: 원본 저장소를 당겨 오지 못했어요 (no upstream)'));
  assert.equal(button(html, 'update-apply'), null);
  assert.ok(!button(html, 'update-check').includes('aria-disabled'));
  assert.deepEqual(applied, [['ko']]);
  assert.equal(calls.length, 2);
  assert.equal(api.updateStatusText(view.update), '적용한 모드 1개, 실패 1개');
});

test('nothing to apply: no [업데이트 적용] and no call', async () => {
  const { api, calls, view, io } = loadPage([{ ok: true, items: [{ id: 'ko', changed: false, error: null }] }]);
  await api.runUpdateCheck(view, io);
  assert.equal(api.runUpdateApply(view, io), null);
  assert.equal(calls.length, 1);
  assert.equal(button(api.render(view), 'update-apply'), null);
  assert.equal(api.updateStatusText(view.update), '모든 모드가 최신이에요');
});

test('an empty check says so', async () => {
  const { api, view, io } = loadPage([{ ok: true, items: [] }]);
  await api.runUpdateCheck(view, io);
  assert.ok(api.render(view).includes('data-mm-update-empty>' + api.UPDATE_EMPTY_TEXT));
});

test('a refusal, a bridge failure and an apply error become lines in the card, escaped; nothing throws', async () => {
  const { api, calls, view, io, applied } = loadPage([
    { ok: false, code: 'NO_MANIFEST', message: 'unreadable' },
    new Error('BRIDGE_TIMEOUT'),
    { ok: true, items: [{ id: 'ko', changed: true, error: null }] },
    { ok: true, applied: [], skipped: [], errors: [{ id: 'ko', message: 'APPLY_FAILED: <img src=x onerror=alert(1)>' }] },
  ]);
  await api.runUpdateCheck(view, io);
  let html = api.render(view);
  assert.ok(html.includes('data-mm-update-error="NO_MANIFEST"'));
  assert.ok(html.includes('설치 기록(install-manifest.json)을 읽지 못했어요'));
  assert.ok(!html.includes('data-mm-update-empty'));
  await api.runUpdateCheck(view, io);
  html = api.render(view);
  assert.ok(html.includes('data-mm-update-error="BRIDGE_TIMEOUT"'));
  assert.ok(html.includes(api.ERROR_KO.BRIDGE_TIMEOUT));
  await api.runUpdateCheck(view, io);
  await api.runUpdateApply(view, io);
  html = api.render(view);
  assert.ok(!html.includes('data-mm-update-error'));
  assert.deepEqual(row(html, 'ko'), ['danger', '적용 실패: 파일을 바꾸지 못했어요 (&lt;img src=x onerror=alert(1)&gt;)']);
  assert.ok(!html.includes('<img'));
  assert.equal(button(html, 'update-apply'), null);
  assert.deepEqual(applied, []);
  assert.equal(calls.length, 4);
});

test('a reply that arrives after the page closed changes nothing', async () => {
  const { api, view, io } = loadPage([{ ok: true, items: [{ id: 'ko', changed: true, error: null }] }]);
  io.live = () => false;
  await api.runUpdateCheck(view, io);
  assert.equal(view.update.phase, 'idle');
  assert.deepEqual(view.update.items, []);
});
