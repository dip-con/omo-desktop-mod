import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { discover, routeMatches, validateModJson } from '../src/loader/mods.mjs';
import { modJson, tempDir, writeMod } from './fixtures/mods-home.mjs';

test('the contract example mod.json is accepted', () => {
  const raw = {
    id: 'ko', name: 'Korean UI', nameKo: '한글 화면', description: '앱 화면 글자를 한글로 바꿔요', version: '0.3.0', enabled: true, locked: false, order: 20,
    entry: { page: 'page.js', css: 'page.css', host: 'host.mjs' }, settingsPage: { id: 'mods', label: '모드' },
    anchors: [{ selector: '#root', route: '*' }], source: { repo: 'dip-con/omo-desktop-ko-translation', path: 'mods/ko', ref: 'main' },
  };
  const parsed = validateModJson(raw, 'ko');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mod.locked, false);
});

test('unknown fields, v1 keys and escaping paths are refused', () => {
  const cases = [
    [{ ...modJson('a'), testedBuilds: [] }, /unknown field testedBuilds/],
    [{ ...modJson('a'), entry: { page: 'page.js', build: 'x' } }, /entry/],
    [{ ...modJson('a'), entry: { page: '../page.js' } }, /entry/],
    [{ ...modJson('a'), anchors: [{ selector: '#root', route: 'settings' }] }, /route/],
    [{ ...modJson('a'), source: { repo: 'x/y', subdir: 'm' } }, /source/],
    [modJson('b'), /folder name/],
  ];
  for (const [raw, reason] of cases) assert.match(validateModJson(raw, 'a').reason, reason);
});

test('discover returns sorted mods and broken entries, skipping _ and . folders', () => {
  const home = tempDir();
  writeMod(home, modJson('zeta', { order: 1 }));
  writeMod(home, modJson('alpha', { order: 5 }));
  writeMod(home, '{ not json', {}, 'broken');
  writeMod(home, modJson('_loader'));
  fs.mkdirSync(path.join(home, '.staging', 'x'), { recursive: true });
  fs.writeFileSync(path.join(home, 'install.json'), '{}');
  const { mods, broken } = discover(home);
  assert.deepEqual(mods.map((m) => m.id), ['zeta', 'alpha']);
  assert.equal(mods[0].dir, path.join(home, 'zeta'));
  assert.deepEqual(broken, [{ id: 'broken', reason: 'mod.json is not valid JSON' }]);
});

test('discover of a missing home is empty', () => {
  assert.deepEqual(discover(path.join(tempDir(), 'missing')), { mods: [], broken: [] });
});

test('routeMatches: star, prefix and exact-with-subpaths', () => {
  assert.equal(routeMatches('*', '/anything'), true);
  assert.equal(routeMatches('/settings/', '/settings/models'), true);
  assert.equal(routeMatches('/settings/', '/settings'), false);
  assert.equal(routeMatches('/settings', '/settings'), true);
  assert.equal(routeMatches('/settings', '/settings/x'), true);
  assert.equal(routeMatches('/settings', '/settingsx'), false);
});
