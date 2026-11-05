// mods/modmgr/page.js, pure half: the page runs here the way the loader runs it, as function (omoMods) {...}, with no
// document, so it exposes its render helpers and returns before the DOM glue. Also the mod.json of the built-in mod.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const modDir = path.join(here, '..', 'mods', 'modmgr');
const source = fs.readFileSync(path.join(modDir, 'page.js'), 'utf8');

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
  };
  new Function('omoMods', source)(omoMods);
  return { api, calls };
}

const MODS = [
  { id: 'modmgr', name: 'Mods', nameKo: '모드 관리', description: '모드를 켜고 끄는 화면', enabled: true, locked: true, status: '붙음', reasonKo: '', expected: 'a' },
  { id: 'ko', name: 'Korean UI', nameKo: '한글 화면', description: '', enabled: true, locked: false, status: '붙음', reasonKo: '', expected: 'b' },
  { id: 'off', name: 'Off', nameKo: '', description: 'd', enabled: false, locked: false, status: '꺼짐', reasonKo: '', expected: 'c' },
  { id: 'gone', name: 'Gone', nameKo: '사라짐', enabled: true, locked: false, status: '못 붙음', reasonKo: '화면 자리를 찾지 못했어요', expected: 'd' },
  { id: 'broken', name: 'broken', nameKo: 'broken', enabled: null, locked: false, status: '못 붙음', reasonKo: 'mod.json 형식이 맞지 않아요', expected: null },
];

const readyView = (api, extra = {}) => ({
  status: 'ready', cards: api.cardsFrom(MODS), failure: null, busy: null, msg: null, pending: false, confirm: null, pageError: null,
  update: api.emptyUpdate(), ...extra,
});

// The opening tag of the element with this data-k, or null.
const tag = (html, key) => html.match(new RegExp(`<[a-z]+[^>]*data-k="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`))?.[0] ?? null;
const chips = (html) => [...html.matchAll(/<span class="mm-chip" data-tone="(\w+)"[^>]*>(.*?)<\/span>/g)].map((m) => [m[1], m[2]]);

describe('modmgr page: cards', () => {
  it('orders switchable mods before locked ones, keeps host order inside, and skips malformed entries', () => {
    const { api } = loadPage();
    const cards = api.cardsFrom([...MODS, { nameKo: 'no id' }, { id: '' }, { id: 'ko', nameKo: 'duplicate' }, null, 'x']);
    assert.deepEqual(cards.map((c) => c.id), ['ko', 'off', 'gone', 'broken', 'modmgr']);
    assert.deepEqual(cards.map((c) => c.name), ['한글 화면', 'Off', '사라짐', 'broken', '모드 관리']);
    assert.deepEqual(cards.map(api.switchable), [true, true, true, false, false]);
    assert.deepEqual(cards.map((c) => c.chip), [
      { text: '붙음', tone: 'ok' },
      { text: '꺼짐', tone: 'off' },
      { text: '못 붙음: 화면 자리를 찾지 못했어요', tone: 'danger' },
      { text: '못 붙음: mod.json 형식이 맞지 않아요', tone: 'danger' },
      { text: '붙음', tone: 'ok' },
    ]);
    assert.deepEqual(api.statusChip({ status: '아직 확인 전' }), { text: '아직 확인 전', tone: 'off' });
    assert.deepEqual(api.statusChip({}), { text: '아직 확인 전', tone: 'off' });
    assert.deepEqual(api.cardsFrom(undefined), []);
  });

  it('renders a switch for each switchable mod, 항상 켜짐 for a locked one, and no switch for a broken one', () => {
    const { api } = loadPage();
    const html = api.render(readyView(api));
    assert.ok(html.indexOf('data-k="card:ko"') < html.indexOf('data-k="card:modmgr"'));
    assert.match(tag(html, 'sw:ko'), /role="switch" aria-checked="true"/);
    assert.match(tag(html, 'sw:off'), /aria-checked="false"/);
    assert.ok(!tag(html, 'sw:ko').includes('aria-disabled'));
    assert.equal(tag(html, 'sw:modmgr'), null);
    assert.equal(tag(html, 'sw:broken'), null);
    assert.ok(html.includes('항상 켜짐'));
    assert.ok(html.includes('aria-label="모드 목록"'));
    assert.ok(!html.includes('data-k="empty"'));
    assert.ok(!html.includes('data-k="notice"'));
    assert.ok(html.includes('<h1 class="mm-title" id="mm-title">모드</h1>'));
    assert.ok(html.indexOf('data-k="update"') > html.indexOf('data-k="list"'));
  });

  it('while a switch writes, every switch waits and the busy one already shows its new value', () => {
    const { api } = loadPage();
    const html = api.render(readyView(api, { busy: { id: 'ko', on: false } }));
    assert.match(tag(html, 'sw:ko'), /aria-checked="false"/);
    assert.match(tag(html, 'sw:ko'), /aria-busy="true"/);
    assert.match(tag(html, 'sw:ko'), /aria-disabled="true"/);
    assert.match(tag(html, 'sw:off'), /aria-disabled="true"/);
    assert.ok(!tag(html, 'sw:off').includes('aria-busy'));
  });

  it('shows a refusal under its card: STALE as a status line, anything else as an alert, escaped', () => {
    const { api } = loadPage();
    const stale = api.render(readyView(api, { msg: { id: 'ko', code: 'STALE' } }));
    assert.match(tag(stale, 'msg:ko'), /data-tone="info" role="status"/);
    assert.ok(stale.includes(api.ERROR_KO.STALE));
    const failed = api.render(readyView(api, { msg: { id: 'off', code: 'HOST_ERROR', message: '<b>boom</b>' } }));
    assert.match(tag(failed, 'msg:off'), /data-tone="danger" role="alert"[^>]*data-code="HOST_ERROR"/);
    assert.ok(failed.includes('모드 도우미에서 오류가 났어요 (&lt;b&gt;boom&lt;/b&gt;)'));
    assert.ok(!failed.includes('<b>'));
    assert.equal(api.errorLine('ENOENT'), '파일을 읽거나 쓰지 못했어요 (ENOENT)');
    assert.equal(api.errorLine('WHATEVER'), '처리하지 못했어요 (WHATEVER)');
    assert.equal(api.errorLine('LOCKED', 'ignored detail'), api.ERROR_KO.LOCKED);
  });

  it('renders the loading placeholders, the failure block with [다시 불러오기], the empty hint and the reload notice', () => {
    const { api } = loadPage();
    const loading = api.render(readyView(api, { status: 'loading', cards: [] }));
    assert.ok(loading.includes('data-k="loading"') && loading.includes(api.TEXT.loading));
    assert.ok(loading.includes('data-k="update"'));
    const failed = api.render(readyView(api, { status: 'failed', cards: [], failure: { code: 'BAD_STATE' } }));
    assert.match(tag(failed, 'failed'), /data-code="BAD_STATE"/);
    assert.ok(failed.includes(api.ERROR_KO.BAD_STATE) && failed.includes('다시 불러오기'));
    assert.ok(tag(failed, 'reload-list'));
    const lockedOnly = api.render(readyView(api, { cards: api.cardsFrom([MODS[0]]) }));
    assert.ok(lockedOnly.includes('data-k="empty"') && lockedOnly.includes(api.TEXT.empty));
    const pending = api.render(readyView(api, { pending: true }));
    assert.ok(pending.includes(api.TEXT.pending));
    assert.match(tag(pending, 'reload-ask'), /mm-btn-primary/);
    assert.ok(pending.indexOf('data-k="update"') < pending.indexOf('data-k="notice"'));
    const errored = api.render(readyView(api, { pageError: '화면에서 오류가 났어요: x' }));
    assert.match(tag(errored, 'page-error'), /role="alert"/);
  });

  it('renders the confirm dialog with its two buttons, busy and error states, and the first-paint enter mark', () => {
    const { api } = loadPage();
    const ready = api.render(readyView(api, { pending: true, confirm: { status: 'ready', error: null, enter: true } }));
    assert.match(tag(ready, 'scrim'), /data-enter/);
    assert.match(tag(ready, 'dialog'), /role="alertdialog" aria-modal="true"/);
    assert.ok(ready.includes(api.TEXT.confirm));
    assert.ok(!tag(ready, 'reload-yes').includes('aria-disabled') && !tag(ready, 'reload-no').includes('aria-disabled'));
    const busy = api.render(readyView(api, { pending: true, confirm: { status: 'busy', error: null, enter: false } }));
    assert.ok(!tag(busy, 'scrim').includes('data-enter'));
    assert.match(tag(busy, 'reload-yes'), /aria-busy="true"/);
    assert.match(tag(busy, 'reload-no'), /aria-disabled="true"/);
    assert.ok(busy.includes('새로 고치는 중'));
    const failed = api.render(readyView(api, { pending: true, confirm: { status: 'ready', error: 'RELOAD_TIMEOUT', enter: false } }));
    assert.match(tag(failed, 'dialog-error'), /data-code="RELOAD_TIMEOUT"/);
    assert.ok(failed.includes(api.ERROR_KO.RELOAD_TIMEOUT));
  });

  it('escapes every host value and never emits the markup inside it', () => {
    const { api } = loadPage();
    const html = api.render(readyView(api, {
      cards: api.cardsFrom([{ id: 'x"><img src=x onerror=alert(1)>', nameKo: '<script>1</script>', description: '"quoted" & <b>', enabled: true, locked: false, status: '못 붙음', reasonKo: '<i>', expected: 'e' }]),
    }));
    assert.ok(!html.includes('<script>') && !html.includes('<img') && !html.includes('<b>') && !html.includes('<i>'));
    assert.ok(html.includes('&lt;script&gt;1&lt;/script&gt;'));
    assert.ok(html.includes('data-id="x&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"'));
    assert.equal(api.esc('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
    assert.equal(api.esc(null), '');
  });

  it('places the nav item after the models row, else after the last row, and nowhere without a nav', () => {
    const { api } = loadPage();
    assert.deepEqual(api.navPlan(['/settings/general', '/settings/models', '/settings/about']), { index: 1, after: 'models' });
    assert.deepEqual(api.navPlan(['/settings/general', '/settings/about']), { index: 1, after: 'last' });
    assert.equal(api.navPlan([]), null);
    assert.equal(api.navPlan(null), null);
  });

  it('request() always resolves: a refusal passes through, a rejection becomes HOST_ERROR or BRIDGE_TIMEOUT', async () => {
    const { api } = loadPage([{ ok: false, code: 'LOCKED' }, new Error('BRIDGE_TIMEOUT'), new Error('HOST_LOAD: x'), 'junk']);
    assert.deepEqual(await api.request('list', []), { ok: false, code: 'LOCKED' });
    assert.deepEqual(await api.request('list', []), { ok: false, code: 'BRIDGE_TIMEOUT', message: 'BRIDGE_TIMEOUT' });
    assert.deepEqual(await api.request('list', []), { ok: false, code: 'HOST_ERROR', message: 'HOST_LOAD: x' });
    assert.equal((await api.request('list', [])).code, 'HOST_ERROR');
  });
});

describe('modmgr mod.json', () => {
  it('is a locked v2 built-in with the three entry files beside it', async () => {
    const mod = JSON.parse(fs.readFileSync(path.join(modDir, 'mod.json'), 'utf8'));
    assert.deepEqual(Object.keys(mod).sort(), ['anchors', 'description', 'enabled', 'entry', 'id', 'locked', 'name', 'nameKo', 'order', 'settingsPage', 'source', 'version']);
    assert.deepEqual([mod.id, mod.enabled, mod.locked, mod.order, mod.nameKo, mod.settingsPage], ['modmgr', true, true, 0, '모드 관리', { id: 'mods', label: '모드' }]);
    assert.deepEqual(mod.entry, { page: 'page.js', css: 'page.css', host: 'host.mjs' });
    assert.deepEqual(mod.source, { repo: 'dip-con/omo-desktop-mod', path: 'mods/modmgr', ref: 'main' });
    for (const file of Object.values(mod.entry)) assert.ok(fs.existsSync(path.join(modDir, file)), file);
    assert.ok(!('testedBuilds' in mod) && !('contributes' in mod) && !('descriptionKo' in mod));
    const loader = await import('../src/loader/mods.mjs').catch(() => null);
    if (loader) assert.deepEqual(loader.validateModJson(mod, 'modmgr').ok, true);
  });

  it('page.js parses as the loader runs it and has no document work before expose', () => {
    assert.doesNotThrow(() => new Function('omoMods', source));
    const { api } = loadPage();
    assert.equal(typeof api.render, 'function');
  });
});
