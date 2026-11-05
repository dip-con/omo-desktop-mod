// mods/modmgr/host.mjs: handle(method, args, ctx) over a temp mods home and a temp state dir. The loader's update
// module is a fake under <modsHome>/_loader/update/update.mjs that records its calls and answers from `replies`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import { handle, REASON_KO } from '../mods/modmgr/host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REAL_MOD_DIR = path.join(here, '..', 'mods', 'modmgr');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

const FAKE_UPDATE = `export const calls = [];
export const replies = { check: null, apply: null };
const answer = (name, opts) => { calls.push([name, opts]); if (replies[name] instanceof Error) throw replies[name]; return replies[name]; };
export async function check(opts) { return answer('check', opts); }
export async function apply(opts) { return answer('apply', opts); }
`;

const modJson = (id, extra = {}) => ({
  id, name: id.toUpperCase(), nameKo: `${id} 한글`, description: `${id} 설명`, version: '1.0.0', enabled: true, order: 10,
  entry: { page: 'page.js' }, anchors: [{ selector: '#root', route: '*' }], ...extra,
});

function writeMod(modsHome, id, value, pretty = 2) {
  fs.mkdirSync(path.join(modsHome, id), { recursive: true });
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, pretty)}\n`;
  fs.writeFileSync(path.join(modsHome, id, 'mod.json'), text);
  return text;
}

// A mods home with the locked modmgr, two switchable mods, one disabled mod, two broken folders and the fake update
// module; a state dir whose state.json reports demo attached and gone not attached.
async function fixture({ state = { mods: [{ id: 'demo', attached: true, reason: null }, { id: 'modmgr', attached: true }, { id: 'gone', attached: false, reason: 'ANCHOR_MISSING' }] }, fake = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-modmgr-host-'));
  roots.push(root);
  const modsHome = path.join(root, 'mods');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  writeMod(modsHome, 'modmgr', modJson('modmgr', { locked: true, order: 0 }));
  writeMod(modsHome, 'demo', modJson('demo', { order: 20 }));
  writeMod(modsHome, 'gone', modJson('gone', { order: 5 }));
  writeMod(modsHome, 'off', modJson('off', { enabled: false, order: 30 }));
  writeMod(modsHome, 'broken', '{ not json\n');
  writeMod(modsHome, 'other', modJson('mismatch'));
  fs.mkdirSync(path.join(modsHome, '.staging', 'x'), { recursive: true });
  fs.mkdirSync(path.join(modsHome, '_loader', 'update'), { recursive: true });
  if (state !== null) fs.writeFileSync(path.join(stateDir, 'state.json'), typeof state === 'string' ? state : JSON.stringify(state));
  let update = null;
  if (fake) {
    const file = path.join(modsHome, '_loader', 'update', 'update.mjs');
    fs.writeFileSync(file, FAKE_UPDATE);
    update = await import(pathToFileURL(file).href);
  }
  const ctx = { modId: 'modmgr', modDir: path.join(modsHome, 'modmgr'), stateDir, modsHome };
  return { root, modsHome, stateDir, ctx, update, call: (method, ...args) => handle(method, args, ctx) };
}

describe('modmgr host: list', () => {
  it('lists every mod.json with its status, sorted by order then id, broken folders last', async () => {
    const { call, modsHome } = await fixture();
    const r = await call('list');
    assert.equal(r.ok, true);
    assert.deepEqual(r.mods.map((m) => [m.id, m.status, m.reasonKo, m.enabled, m.locked]), [
      ['modmgr', '붙음', '', true, true],
      ['gone', '못 붙음', REASON_KO.ANCHOR_MISSING, true, false],
      ['demo', '붙음', '', true, false],
      ['off', '꺼짐', '', false, false],
      ['broken', '못 붙음', REASON_KO.BAD_FORMAT, null, false],
      ['other', '못 붙음', REASON_KO.BAD_FORMAT, null, false],
    ]);
    const demo = r.mods.find((m) => m.id === 'demo');
    assert.deepEqual([demo.name, demo.nameKo, demo.description, demo.version], ['DEMO', 'demo 한글', 'demo 설명', '1.0.0']);
    assert.equal(demo.expected, sha256(fs.readFileSync(path.join(modsHome, 'demo', 'mod.json'))));
    assert.equal(r.mods.find((m) => m.id === 'broken').expected, null);
    assert.ok(!r.mods.some((m) => m.id.startsWith('_') || m.id.startsWith('.')));
  });

  it('shows 아직 확인 전 before the loader wrote a state, an unknown reason as itself, and refuses a corrupt state', async () => {
    const fresh = await fixture({ state: null });
    assert.deepEqual((await fresh.call('list')).mods.map((m) => m.status), ['아직 확인 전', '아직 확인 전', '아직 확인 전', '꺼짐', '못 붙음', '못 붙음']);
    const odd = await fixture({ state: { mods: [{ id: 'demo', attached: false, reason: 'SOMETHING_NEW' }, { id: 'off', attached: true }, 'junk'] } });
    const rows = (await odd.call('list')).mods;
    assert.deepEqual([rows.find((m) => m.id === 'demo').reasonKo, rows.find((m) => m.id === 'off').status], ['SOMETHING_NEW', '꺼짐']);
    const corrupt = await fixture({ state: '{"mods": [' });
    assert.equal((await corrupt.call('list')).code, 'BAD_STATE');
  });
});

describe('modmgr host: setEnabled', () => {
  it('changes only the enabled token, keeps every other byte, and returns the new hash', async () => {
    const { call, modsHome } = await fixture();
    const text = writeMod(modsHome, 'demo', '{\n\t"id": "demo",\n\t"name": "Demo", "enabled" :true,\n\t"version": "1.0.0", "order": 1,\n\t"entry": {"page": "page.js"}, "anchors": []\n}\n');
    const expected = sha256(Buffer.from(text));
    const r = await call('setEnabled', { id: 'demo', on: false, expected });
    const written = fs.readFileSync(path.join(modsHome, 'demo', 'mod.json'), 'utf8');
    assert.deepEqual(r, { ok: true, id: 'demo', enabled: false, changed: true, expected: sha256(Buffer.from(written)) });
    assert.equal(written, text.replace('"enabled" :true', '"enabled" :false'));
    assert.deepEqual(await call('setEnabled', { id: 'demo', on: false, expected: r.expected }), { ok: true, id: 'demo', enabled: false, changed: false, expected: r.expected });
    assert.equal((await call('setEnabled', { id: 'demo', on: true, expected })).code, 'STALE');
    assert.equal(fs.readFileSync(path.join(modsHome, 'demo', 'mod.json'), 'utf8'), written);
    assert.deepEqual(fs.readdirSync(path.join(modsHome, 'demo')), ['mod.json']);
  });

  it('refuses a locked mod, an unknown or unsafe id, bad arguments and a mod.json without a boolean enabled', async () => {
    const { call, modsHome } = await fixture();
    const hashOf = (id) => sha256(fs.readFileSync(path.join(modsHome, id, 'mod.json')));
    assert.equal((await call('setEnabled', { id: 'modmgr', on: false, expected: hashOf('modmgr') })).code, 'LOCKED');
    assert.equal((await call('setEnabled', { id: 'nope', on: true, expected: 'x' })).code, 'UNKNOWN_MOD');
    assert.equal((await call('setEnabled', { id: '../demo', on: true, expected: hashOf('demo') })).code, 'UNKNOWN_MOD');
    assert.equal((await call('setEnabled', { id: 'demo', on: 'true', expected: hashOf('demo') })).code, 'BAD_ARGS');
    assert.equal((await call('setEnabled')).code, 'BAD_ARGS');
    assert.equal((await call('setEnabled', { id: 'broken', on: true, expected: hashOf('broken') })).code, 'BAD_FORMAT');
    writeMod(modsHome, 'odd', modJson('odd', { enabled: 'yes' }));
    assert.equal((await call('setEnabled', { id: 'odd', on: true, expected: hashOf('odd') })).code, 'BAD_FORMAT');
    assert.equal(fs.readFileSync(path.join(modsHome, 'modmgr', 'mod.json'), 'utf8').includes('"enabled": true'), true);
  });
});

describe('modmgr host: updates', () => {
  it('checkUpdates asks the loader update module for this mods home and passes the items through', async () => {
    const { call, update, modsHome } = await fixture();
    const items = [
      { id: 'ko', source: { type: 'github' }, installed: 'a', latest: 'b', changed: true, error: null },
      { id: '_loader', source: null, installed: null, latest: null, changed: false, error: 'no install source recorded for _loader' },
    ];
    update.replies.check = { ok: false, items };
    assert.deepEqual(await call('checkUpdates'), { ok: true, items });
    assert.deepEqual(update.calls, [['check', { modsHome }]]);
    update.replies.check = { ok: false, items: [], error: `${modsHome}/install.json not found or invalid` };
    assert.deepEqual(await call('checkUpdates'), { ok: false, code: 'NO_INSTALL_RECORD', message: `${modsHome}/install.json not found or invalid` });
    update.replies.check = new Error('boom');
    assert.deepEqual(await call('checkUpdates'), { ok: false, code: 'HOST_ERROR', message: 'boom' });
  });

  it('applyUpdates needs a non-empty id list, passes it through, and turns a missing record into a refusal', async () => {
    const { call, update, modsHome } = await fixture();
    for (const bad of [undefined, {}, { ids: [] }, { ids: 'ko' }, { ids: ['ko', 3] }, { ids: [''] }]) {
      assert.equal((await call('applyUpdates', bad)).code, 'BAD_ARGS', JSON.stringify(bad));
    }
    assert.equal(update.calls.length, 0);
    update.replies.apply = { ok: false, applied: ['ko'], skipped: [{ id: 'modmgr', reason: 'UNCHANGED' }], errors: [{ id: 'x', message: 'APPLY_FAILED: EACCES' }] };
    assert.deepEqual(await call('applyUpdates', { ids: ['ko', 'modmgr', 'x'] }), {
      ok: true, applied: ['ko'], skipped: [{ id: 'modmgr', reason: 'UNCHANGED' }], errors: [{ id: 'x', message: 'APPLY_FAILED: EACCES' }],
    });
    assert.deepEqual(update.calls, [['apply', { modsHome, ids: ['ko', 'modmgr', 'x'] }]]);
    update.replies.apply = { ok: false, applied: [], skipped: [], errors: [{ id: null, message: 'install.json not found' }] };
    assert.deepEqual(await call('applyUpdates', { ids: ['ko'] }), { ok: false, code: 'NO_INSTALL_RECORD', message: 'install.json not found' });
  });

  it('without an installed loader the repository module beside the mod is used; with neither the call is a HOST_ERROR', async () => {
    const { ctx, modsHome } = await fixture({ fake: false });
    fs.rmSync(path.join(modsHome, '_loader'), { recursive: true, force: true });
    const missing = await handle('checkUpdates', [], ctx);
    assert.equal(missing.code, 'HOST_ERROR');
    assert.match(missing.message, /update module not found/);
    // The repository's src/update/update.mjs, through ../../src relative to the real mod folder, with no install.json.
    const real = await handle('checkUpdates', [], { ...ctx, modDir: REAL_MOD_DIR });
    assert.equal(real.code, 'NO_INSTALL_RECORD');
  });
});

describe('modmgr host: handle', () => {
  it('refuses unknown methods, non-array args and a context without the folders', async () => {
    const { ctx } = await fixture();
    assert.equal((await handle('shortcuts', [], ctx)).code, 'UNKNOWN_METHOD');
    assert.equal((await handle('__reload', [], ctx)).code, 'UNKNOWN_METHOD');
    assert.equal((await handle('list', 'x', ctx)).code, 'BAD_ARGS');
    assert.equal((await handle('list', [])).code, 'HOST_ERROR');
    assert.equal((await handle('list', [], { modsHome: ctx.modsHome })).code, 'HOST_ERROR');
  });
});
