// The update card of 설정 > 모드 (mods/modmgr/page.js): runUpdateCheck and runUpdateApply driven without a document,
// with a scripted host (v2 update replies: items {id, source, installed, latest, changed, error}, apply {ids}).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'mods', 'modmgr', 'page.js'), 'utf8');

const MODS = [
  { id: 'modmgr', nameKo: '모드 관리', enabled: true, locked: true, status: '붙음', reasonKo: '', expected: 'a' },
  { id: 'ko', nameKo: '한글 화면', enabled: true, locked: false, status: '붙음', reasonKo: '', expected: 'b' },
];

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
  };
  new Function('omoMods', source)(omoMods);
  const view = { status: 'ready', cards: api.cardsFrom(MODS), failure: null, busy: null, msg: null, pending: false, confirm: null, pageError: null, update: api.emptyUpdate() };
  const applied = [];
  let paints = 0;
  const io = { request: api.request, paint: () => { paints += 1; }, guard: (fn) => fn, live: () => true, applied: (ids) => applied.push(ids) };
  return { api, calls, view, io, applied, paints: () => paints };
}

const button = (html, act) => html.match(new RegExp(`<button[^>]*data-act="${act}"[^>]*>`))?.[0] ?? null;
// [tone, text] of the status chip in the row of this id, or null.
function row(html, id) {
  const li = html.match(new RegExp(`<li class="mm-update-row" data-k="row:${id}">(.*?)</li>`));
  return li ? li[1].match(/<span class="mm-chip" data-tone="(\w+)">(.*?)<\/span>/).slice(1) : null;
}
const item = (id, changed, error = null) => ({ id, source: { type: 'github' }, installed: 'x', latest: changed ? 'y' : 'x', changed, error });

test('before a check: the card has the title and [업데이트 확인] only, in every list state', () => {
  const { api, view } = loadPage();
  const html = api.render(view);
  assert.ok(html.includes('id="mm-update-title">업데이트</h2>'));
  const check = button(html, 'update-check');
  assert.ok(check && !check.includes('aria-disabled') && !check.includes('aria-busy'));
  assert.equal(button(html, 'update-apply'), null);
  assert.ok(!html.includes('data-k="rows"') && !html.includes('data-k="update-empty"'));
  assert.equal(api.updateStatusText(view.update), '');
  for (const state of [{ status: 'loading' }, { status: 'failed', failure: { code: 'BAD_STATE' } }, { pending: true }]) {
    assert.ok(api.render({ ...view, ...state }).includes('data-k="update"'));
  }
});

test('[업데이트 확인] calls checkUpdates once; both buttons wait meanwhile; each row shows its status', async () => {
  const { api, calls, view, io, paints } = loadPage([{
    ok: true,
    items: [item('ko', true), item('modmgr', false), { id: '_loader', source: null, installed: null, latest: null, changed: false, error: 'no install source recorded for _loader' }],
  }]);
  const pending = api.runUpdateCheck(view, io);
  assert.deepEqual(calls, [['checkUpdates', []]]);
  let html = api.render(view);
  assert.match(button(html, 'update-check'), /aria-disabled="true"/);
  assert.match(button(html, 'update-check'), /aria-busy="true"/);
  assert.equal(api.updateStatusText(view.update), '업데이트를 확인하는 중이에요');
  assert.equal(api.runUpdateCheck(view, io), null);
  assert.equal(calls.length, 1);
  await pending;
  assert.equal(paints(), 2);
  html = api.render(view);
  assert.deepEqual(row(html, 'ko'), ['warn', '새 버전 있음']);
  assert.deepEqual(row(html, 'modmgr'), ['ok', '최신']);
  assert.deepEqual(row(html, '_loader'), ['danger', '확인 실패: 설치 원본이 기록돼 있지 않아요']);
  assert.ok(html.includes('<span class="mm-update-mod">한글 화면</span><span class="mm-update-id">ko</span>'));
  assert.ok(html.includes('<span class="mm-update-mod">로더</span><span class="mm-update-id">_loader</span>'));
  const apply = button(html, 'update-apply');
  assert.ok(apply && apply.includes('mm-btn-primary') && !apply.includes('aria-disabled'));
  assert.ok(!button(html, 'update-check').includes('aria-disabled'));
  assert.equal(api.updateStatusText(view.update), '새 버전이 있는 모드 1개, 확인 실패 1개');
  assert.deepEqual(api.changedIds(view.update), ['ko']);
});

test('[업데이트 적용] sends the changed ids, shows each result, and hands the applied ids to the page', async () => {
  const { api, calls, view, io, applied } = loadPage([
    { ok: true, items: [item('ko', true), item('modmgr', true), item('_loader', false)] },
    { ok: true, applied: ['ko'], skipped: [{ id: 'modmgr', reason: 'UNCHANGED' }], errors: [{ id: 'ko', message: 'dip-con/omo-desktop-mod@main: HTTP 403 from https://api.github.com/x' }] },
  ]);
  await api.runUpdateCheck(view, io);
  const pending = api.runUpdateApply(view, io);
  assert.deepEqual(calls[1], ['applyUpdates', [{ ids: ['ko', 'modmgr'] }]]);
  let html = api.render(view);
  assert.match(button(html, 'update-apply'), /aria-busy="true"/);
  assert.match(button(html, 'update-apply'), /aria-disabled="true"/);
  assert.match(button(html, 'update-check'), /aria-disabled="true"/);
  assert.equal(api.runUpdateApply(view, io), null);
  await pending;
  html = api.render(view);
  assert.deepEqual(row(html, 'ko'), ['ok', '적용됨']);
  assert.deepEqual(row(html, 'modmgr'), ['off', '바뀐 게 없어요']);
  assert.deepEqual(row(html, '_loader'), ['ok', '최신']);
  assert.ok(html.includes('한글 화면: 원본 저장소에서 가져오지 못했어요 (dip-con/omo-desktop-mod@main: HTTP 403 from https://api.github.com/x)'));
  assert.equal(button(html, 'update-apply'), null);
  assert.ok(!button(html, 'update-check').includes('aria-disabled'));
  assert.deepEqual(applied, [['ko']]);
  assert.equal(calls.length, 2);
  assert.equal(api.updateStatusText(view.update), '적용한 모드 1개, 실패 1개');
});

test('nothing to apply: no [업데이트 적용] and no call; an empty check says so', async () => {
  const latest = loadPage([{ ok: true, items: [item('ko', false)] }]);
  await latest.api.runUpdateCheck(latest.view, latest.io);
  assert.equal(latest.api.runUpdateApply(latest.view, latest.io), null);
  assert.equal(latest.calls.length, 1);
  assert.equal(button(latest.api.render(latest.view), 'update-apply'), null);
  assert.equal(latest.api.updateStatusText(latest.view.update), '모든 모드가 최신이에요');
  const empty = loadPage([{ ok: true, items: [] }]);
  await empty.api.runUpdateCheck(empty.view, empty.io);
  assert.ok(empty.api.render(empty.view).includes('data-k="update-empty">' + empty.api.TEXT.updateEmpty));
  assert.equal(empty.api.updateStatusText(empty.view.update), empty.api.TEXT.updateEmpty);
});

test('a refusal, a bridge failure and an apply error become lines in the card, escaped; nothing throws', async () => {
  const { api, calls, view, io, applied } = loadPage([
    { ok: false, code: 'NO_INSTALL_RECORD', message: '/x/install.json not found or invalid' },
    new Error('BRIDGE_TIMEOUT'),
    { ok: true, items: [item('ko', true)] },
    { ok: true, applied: [], skipped: [], errors: [{ id: 'ko', message: 'APPLY_FAILED: <img src=x onerror=alert(1)>' }] },
  ]);
  await api.runUpdateCheck(view, io);
  let html = api.render(view);
  assert.ok(html.includes('data-k="update-error"') && html.includes('data-code="NO_INSTALL_RECORD"'));
  assert.ok(html.includes(api.ERROR_KO.NO_INSTALL_RECORD));
  assert.ok(!html.includes('data-k="update-empty"'));
  assert.equal(api.updateStatusText(view.update), api.ERROR_KO.NO_INSTALL_RECORD);
  await api.runUpdateCheck(view, io);
  html = api.render(view);
  assert.ok(html.includes('data-code="BRIDGE_TIMEOUT"') && html.includes(api.ERROR_KO.BRIDGE_TIMEOUT));
  await api.runUpdateCheck(view, io);
  await api.runUpdateApply(view, io);
  html = api.render(view);
  assert.ok(!html.includes('data-k="update-error"'));
  assert.deepEqual(row(html, 'ko'), ['danger', '적용 실패: 파일을 바꾸지 못했어요 (&lt;img src=x onerror=alert(1)&gt;)']);
  assert.ok(!html.includes('<img'));
  assert.equal(button(html, 'update-apply'), null);
  assert.deepEqual(applied, []);
  assert.equal(calls.length, 4);
});

test('a host error on apply keeps the checked rows and shows the message', async () => {
  const { api, view, io } = loadPage([{ ok: true, items: [item('ko', true)] }, new Error('HOST_LOAD: cannot import')]);
  await api.runUpdateCheck(view, io);
  await api.runUpdateApply(view, io);
  const html = api.render(view);
  assert.equal(view.update.phase, 'checked');
  assert.deepEqual(row(html, 'ko'), ['warn', '새 버전 있음']);
  assert.ok(html.includes('모드 도우미에서 오류가 났어요 (HOST_LOAD: cannot import)'));
  assert.ok(button(html, 'update-apply'));
});

test('update error texts of the v2 update module read as Korean lines', () => {
  const { api } = loadPage();
  assert.equal(api.updateErrorLine('APPLY_FAILED: EACCES: permission denied'), '파일을 바꾸지 못했어요 (EACCES: permission denied)');
  assert.equal(api.updateErrorLine('no install source recorded for ko'), '설치 원본이 기록돼 있지 않아요');
  assert.equal(api.updateErrorLine('source folder not found: /tmp/x'), '설치 원본 폴더를 찾지 못했어요 (/tmp/x)');
  assert.equal(api.updateErrorLine('owner/repo@main: not a commit sha: abc'), '원본 저장소에서 가져오지 못했어요 (owner/repo@main: not a commit sha: abc)');
  assert.equal(api.updateErrorLine('fetch failed'), '원본 저장소에 연결하지 못했어요 (fetch failed)');
  assert.equal(api.updateErrorLine('The operation was aborted due to timeout'), '원본 저장소에 연결하지 못했어요 (The operation was aborted due to timeout)');
  assert.equal(api.updateErrorLine("ENOENT: no such file or directory, scandir '/x'"), "설치 원본을 읽지 못했어요 (no such file or directory, scandir '/x')");
  assert.equal(api.updateErrorLine('something else'), '처리하지 못했어요 (something else)');
  assert.equal(api.updateErrorLine(''), api.ERROR_KO.HOST_ERROR);
});

test('a reply that arrives after the page closed changes nothing', async () => {
  const { api, view, io } = loadPage([{ ok: true, items: [item('ko', true)] }]);
  io.live = () => false;
  await api.runUpdateCheck(view, io);
  assert.equal(view.update.phase, 'idle');
  assert.deepEqual(view.update.items, []);
  assert.equal(view.update.busy, 'check');
});
