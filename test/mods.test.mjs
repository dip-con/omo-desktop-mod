// Tests for loader/mods.mjs. Every mods folder is a fresh temp directory removed after the test.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { discoverMods, evaluateMod, modsRootFor, parseModJson, partitionEnabled, routeMatches } from '../loader/mods.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function withTempDir(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-mods-test-'));
  try {
    return body(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function validMod(id, overrides = {}) {
  return {
    id,
    name: `${id} name`,
    nameKo: `${id} 이름`,
    version: '0.1.0',
    enabled: true,
    order: 10,
    entry: { page: 'page.js', css: 'style.css' },
    contributes: {},
    testedBuilds: ['build-a'],
    anchors: [{ selector: '#root', route: '*' }],
    ...overrides,
  };
}

function writeMod(modsRoot, folder, raw) {
  fs.mkdirSync(path.join(modsRoot, folder), { recursive: true });
  fs.writeFileSync(path.join(modsRoot, folder, 'mod.json'), typeof raw === 'string' ? raw : JSON.stringify(raw));
}

test('installed loader finds mods beside its _loader folder, dev loader finds REPO/mods', () => {
  // Given: an installed loader folder and a development loader folder
  const installed = path.join('/Users/alice', '.omo', 'app-mods', '_loader');
  const dev = path.join('/src', 'repo', 'loader');
  // When/Then: the mods root is the parent of _loader, or REPO/mods in development
  assert.equal(modsRootFor(installed), path.join('/Users/alice', '.omo', 'app-mods'));
  assert.equal(modsRootFor(dev), path.join('/src', 'repo', 'mods'));
});

test('discovery returns valid mods sorted by order and skips _loader', () => {
  withTempDir((root) => {
    // Given: two valid mods, out of order, and a _loader folder with a mod.json inside it
    writeMod(root, 'late', validMod('late', { order: 20 }));
    writeMod(root, 'early', validMod('early', { order: 5 }));
    writeMod(root, '_loader', validMod('_loader'));
    // When
    const { mods, skipped } = discoverMods(root);
    // Then: the valid mods come back in order, nothing is skipped, _loader is ignored
    assert.deepEqual(mods.map((m) => m.id), ['early', 'late']);
    assert.deepEqual(skipped, []);
  });
});

test('equal orders sort by id, and a mod without an integer order is skipped', () => {
  withTempDir((root) => {
    // Given: two mods with the same order, one with a lower order, and two whose order is not an integer
    writeMod(root, 'zeta', validMod('zeta', { order: 10 }));
    writeMod(root, 'alpha', validMod('alpha', { order: 10 }));
    writeMod(root, 'manager', validMod('manager', { order: 0 }));
    writeMod(root, 'fraction', validMod('fraction', { order: 1.5 }));
    const missing = validMod('missing');
    delete missing.order;
    writeMod(root, 'missing', missing);
    // When
    const { mods, skipped } = discoverMods(root);
    // Then: by order, then by id; the two without an integer order are skipped with that reason
    assert.deepEqual(mods.map((m) => m.id), ['manager', 'alpha', 'zeta']);
    assert.deepEqual(skipped.map((s) => [s.id, s.reason]).sort(), [['fraction', 'order must be an integer'], ['missing', 'order must be an integer']]);
  });
});

test('the repository mods all load, the mod manager first with order 0', () => {
  // Given/When: the mods folder of this repository
  const { mods, skipped } = discoverMods(path.join(REPO, 'mods'));
  // Then: nothing is skipped, modmgr leads with order 0 and the orders never go down
  assert.deepEqual(skipped, []);
  assert.deepEqual([mods[0].id, mods[0].order], ['modmgr', 0]);
  mods.slice(1).forEach((m, i) => assert.ok(mods[i].order <= m.order, `${mods[i].id} before ${m.id}`));
});

test('a mod with a broken format is skipped and its name and reason are reported', () => {
  withTempDir((root) => {
    // Given: a mod whose id does not match its folder, and one whose mod.json is not JSON
    writeMod(root, 'alpha', validMod('beta'));
    writeMod(root, 'gamma', '{ not json');
    // When
    const { mods, skipped } = discoverMods(root);
    // Then: nothing is loaded and each skipped entry names the mod and says why
    assert.deepEqual(mods, []);
    assert.equal(skipped.length, 2);
    assert.equal(skipped.find((s) => s.id === 'alpha').reason.includes('must equal folder name'), true);
    assert.equal(skipped.find((s) => s.id === 'gamma').reason.includes('not valid JSON'), true);
  });
});

test('entry paths must stay inside the mod folder', () => {
  // Given: an entry page that climbs out of the mod folder
  const raw = validMod('escape', { entry: { page: '../../secret.js' } });
  // When/Then
  assert.equal(parseModJson(raw, 'escape').ok, false);
});

test('an anchor route must be * or start with a slash', () => {
  // Given: an anchor with a bare route name
  const raw = validMod('route', { anchors: [{ selector: '#root', route: 'settings' }] });
  // When/Then
  assert.equal(parseModJson(raw, 'route').ok, false);
});

test('a valid mod.json passes and keeps its anchors and tested builds', () => {
  // Given: a mod with a settings anchor and a tested build
  const raw = validMod('settings-mod', {
    anchors: [{ selector: '[data-settings-nav-path="/settings/general"]', route: '/settings/general' }],
    testedBuilds: ['build-a', 'build-b'],
  });
  // When
  const parsed = parseModJson(raw, 'settings-mod');
  // Then
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.mod.testedBuilds, ['build-a', 'build-b']);
  assert.equal(parsed.mod.anchors[0].route, '/settings/general');
});

test('route matching: * matches all, a trailing slash is a prefix, otherwise an exact path or sub-path', () => {
  // Given/When/Then
  assert.equal(routeMatches('*', '/anything'), true);
  assert.equal(routeMatches('/settings/', '/settings/general'), true);
  assert.equal(routeMatches('/settings/general', '/settings/general'), true);
  assert.equal(routeMatches('/settings/general', '/settings/generalX'), false);
  assert.equal(routeMatches('/settings/general', '/'), false);
});

test('a missing anchor switches the mod off even when its build is tested', () => {
  // Given: a settings anchor that is not on the page, and a build the mod was tested on
  const mod = parseModJson(validMod('sample', {
    anchors: [{ selector: '[data-settings-nav-path="/settings/general"]', route: '/settings/general' }],
    testedBuilds: ['build-a'],
  }), 'sample').mod;
  // When
  const result = evaluateMod(mod, { pathname: '/settings/general', buildKey: 'build-a', present: () => false });
  // Then: the mod is off and the reason is ANCHOR_MISSING
  assert.deepEqual(result, { id: 'sample', attached: false, reason: 'ANCHOR_MISSING' });
});

test('an anchor for another route is not checked on this page', () => {
  // Given: a settings-only anchor, evaluated on the home page where it is absent
  const mod = parseModJson(validMod('sample', {
    anchors: [{ selector: '[data-settings-nav-path="/settings/general"]', route: '/settings/general' }],
  }), 'sample').mod;
  // When
  const result = evaluateMod(mod, { pathname: '/', buildKey: 'build-a', present: () => false });
  // Then: it attaches, since no applicable anchor is missing
  assert.equal(result.attached, true);
});

test('all anchors present attaches with no reason on any build, listed in testedBuilds or not', () => {
  // Given: one mod that lists build-a, and one without testedBuilds at all
  const listed = parseModJson(validMod('ko', { testedBuilds: ['build-a'] }), 'ko').mod;
  const bare = validMod('bare');
  delete bare.testedBuilds;
  const unlisted = parseModJson(bare, 'bare').mod;
  // When/Then: the build key plays no part
  for (const buildKey of ['build-a', 'build-z', undefined]) {
    assert.deepEqual(evaluateMod(listed, { pathname: '/', buildKey, present: () => true }), { id: 'ko', attached: true, reason: null });
    assert.deepEqual(evaluateMod(unlisted, { pathname: '/', buildKey, present: () => true }), { id: 'bare', attached: true, reason: null });
  }
});

test('testedBuilds is optional, but must be a string array when present', () => {
  const bare = validMod('bare');
  delete bare.testedBuilds;
  assert.equal(parseModJson(bare, 'bare').ok, true);
  assert.equal(parseModJson(validMod('num', { testedBuilds: [1] }), 'num').ok, false);
  assert.equal(parseModJson(validMod('str', { testedBuilds: 'build-a' }), 'str').ok, false);
});

test('update is optional, and needs a repo string and an optional subdir string', () => {
  assert.equal(parseModJson(validMod('u1', { update: { repo: 'https://example.com/ko.git', subdir: 'mods/ko' } }), 'u1').ok, true);
  assert.equal(parseModJson(validMod('u2', { update: { repo: '/src/ko' } }), 'u2').ok, true);
  assert.equal(parseModJson(validMod('u3', { update: { subdir: 'mods/ko' } }), 'u3').ok, false);
  assert.equal(parseModJson(validMod('u4', { update: { repo: '/src/ko', subdir: 3 } }), 'u4').ok, false);
  assert.equal(parseModJson(validMod('u5', { update: 'https://example.com/ko.git' }), 'u5').ok, false);
});

test('a locked mod stays active when enabled is false, and an unlocked one is switched off', () => {
  // Given: two mods that are both switched off, one of them locked
  const locked = parseModJson(validMod('modmgr', { enabled: false, locked: true }), 'modmgr').mod;
  const plain = parseModJson(validMod('plain', { enabled: false }), 'plain').mod;
  // When
  const { active, disabled } = partitionEnabled([locked, plain]);
  // Then
  assert.deepEqual(active.map((m) => m.id), ['modmgr']);
  assert.deepEqual(disabled.map((m) => m.id), ['plain']);
});

test('locked must be a boolean and descriptionKo a string when present', () => {
  // Given/When/Then
  assert.equal(parseModJson(validMod('lk', { locked: 'yes' }), 'lk').ok, false);
  assert.equal(parseModJson(validMod('dk', { descriptionKo: 3 }), 'dk').ok, false);
  assert.equal(parseModJson(validMod('okk', { locked: true, descriptionKo: '설명' }), 'okk').mod.descriptionKo, '설명');
});
