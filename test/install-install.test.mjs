import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readJson } from '../src/core/fsx.mjs';
import { install, uninstall } from '../src/install/install.mjs';
import { BUNDLE_ID, LAUNCHER_NAME } from '../src/install/launcher.mjs';
import { fakeApp, fakeGithub, loaderRepo, modJson, sha, tempDir, writeTree } from './fixtures-update/fake.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function setup(t) {
  const root = tempDir(t);
  const opts = {
    modsHome: path.join(root, 'mods'), appsDir: path.join(root, 'apps'), app: fakeApp(root),
    loader: loaderRepo(root), node: '/usr/local/bin/node',
  };
  const mod = writeTree(path.join(root, 'src-ko'), { 'mod.json': modJson('ko'), 'page.js': 'ko;\n', 'test/t.mjs': 'x' });
  return { root, opts, mod };
}

test('install writes loader, modmgr, mods, install.json and the launcher', async (t) => {
  const { opts, mod } = setup(t);
  const result = await install({ ...opts, mods: [mod] });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(path.join(opts.modsHome, '_loader/loader/launch.mjs'), 'utf8'), 'export const main = () => 0;\n');
  assert.equal(fs.existsSync(path.join(opts.modsHome, '_loader/test')), false);
  assert.equal(fs.existsSync(path.join(opts.modsHome, 'ko/test')), false);
  assert.deepEqual(readJson(path.join(opts.modsHome, '_loader/config.json')), { app: opts.app, node: opts.node });
  const record = readJson(path.join(opts.modsHome, 'install.json'));
  assert.equal(record.version, 2);
  assert.deepEqual(Object.keys(record.sources).sort(), ['_loader', 'ko', 'modmgr']);
  assert.equal(record.sources.ko.type, 'local');
  assert.match(record.sources.ko.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(record.files.ko, ['mod.json', 'page.js']);
  assert.ok(record.files._loader.includes('config.json'));
  const app = path.join(opts.appsDir, LAUNCHER_NAME);
  assert.match(fs.readFileSync(path.join(app, 'Contents/Info.plist'), 'utf8'), new RegExp(BUNDLE_ID.replace(/\./g, '\\.')));
  assert.match(fs.readFileSync(path.join(app, 'Contents/MacOS/omo-mods'), 'utf8'), /exec "\/usr\/local\/bin\/node" ".*\/_loader\/loader\/launch\.mjs" "\$@"/);
  assert.equal(fs.readFileSync(path.join(app, 'Contents/Resources/icon.icns'), 'utf8'), 'icns');
});

test('dry run writes nothing', async (t) => {
  const { opts, mod } = setup(t);
  const result = await install({ ...opts, mods: [mod], dryRun: true });
  assert.ok(result.write.includes(path.join(opts.modsHome, 'ko', 'page.js')));
  assert.equal(fs.existsSync(opts.modsHome), false);
  assert.equal(fs.existsSync(opts.appsDir), false);
});

test('reinstall keeps enabled, drops removed mods, never touches foreign files', async (t) => {
  const { root, opts, mod } = setup(t);
  const other = writeTree(path.join(root, 'src-other'), { 'mod.json': modJson('other'), 'a.js': 'a' });
  await install({ ...opts, mods: [mod, other] });
  const koJson = path.join(opts.modsHome, 'ko/mod.json');
  fs.writeFileSync(koJson, JSON.stringify({ ...readJson(koJson), enabled: false }));
  writeTree(opts.modsHome, { 'other/user-notes.txt': 'mine', 'ko/user.txt': 'mine' });
  await install({ ...opts, mods: [mod] });
  assert.equal(readJson(koJson).enabled, false);
  assert.equal(fs.existsSync(path.join(opts.modsHome, 'other/a.js')), false);
  assert.equal(fs.readFileSync(path.join(opts.modsHome, 'other/user-notes.txt'), 'utf8'), 'mine');
  assert.deepEqual(Object.keys(readJson(path.join(opts.modsHome, 'install.json')).sources).sort(), ['_loader', 'ko', 'modmgr']);
  uninstall(opts);
  assert.equal(fs.existsSync(path.join(opts.modsHome, 'install.json')), false);
  assert.equal(fs.existsSync(path.join(opts.appsDir, LAUNCHER_NAME)), false);
  assert.equal(fs.readFileSync(path.join(opts.modsHome, 'ko/user.txt'), 'utf8'), 'mine');
  assert.equal(fs.existsSync(path.join(opts.modsHome, '_loader')), false);
});

test('a foreign file in the way stops the install before any write', async (t) => {
  const { opts, mod } = setup(t);
  writeTree(opts.modsHome, { 'ko/page.js': 'someone else' });
  await assert.rejects(install({ ...opts, mods: [mod] }), /덮어쓰지 않았어요/);
  assert.equal(fs.existsSync(path.join(opts.modsHome, '_loader')), false);
  assert.equal(fs.readFileSync(path.join(opts.modsHome, 'ko/page.js'), 'utf8'), 'someone else');
});

test('a foreign launcher is not overwritten', async (t) => {
  const { opts } = setup(t);
  writeTree(opts.appsDir, { [`${LAUNCHER_NAME}/Contents/Info.plist`]: '<plist/>' });
  await assert.rejects(install(opts), /덮어쓰지 않았어요/);
});

test('github specs are fetched and recorded with their commit', async (t) => {
  const { root, opts } = setup(t);
  const gh = fakeGithub(root, {
    'dip-con/omo-desktop-mod': { sha: sha('1'), files: { 'src/core/a.mjs': 'a', 'mods/modmgr/mod.json': modJson('modmgr') } },
    'o/mods': { sha: sha('2'), files: { 'mods/ko/mod.json': modJson('ko'), 'mods/ko/page.js': 'gh' } },
  });
  await install({ ...opts, loader: 'github:dip-con/omo-desktop-mod#main', mods: ['github:o/mods/mods/ko'], fetch: gh.fetch });
  const { sources } = readJson(path.join(opts.modsHome, 'install.json'));
  assert.deepEqual(sources._loader, { type: 'github', repo: 'dip-con/omo-desktop-mod', ref: 'main', path: 'src', commit: sha('1') });
  assert.deepEqual(sources.ko, { type: 'github', repo: 'o/mods', ref: 'main', path: 'mods/ko', commit: sha('2') });
  assert.equal(fs.readFileSync(path.join(opts.modsHome, 'ko/page.js'), 'utf8'), 'gh');
});

test('a duplicate mod id is refused', async (t) => {
  const { opts, mod } = setup(t);
  await assert.rejects(install({ ...opts, mods: [mod, mod] }), /duplicate or reserved/);
});

test('bin/install.mjs --dry-run prints a plan and writes nothing', async (t) => {
  const { root, mod } = setup(t);
  const out = execFileSync(process.execPath, [path.join(REPO, 'bin/install.mjs'), '--mods-home', path.join(root, 'm'),
    '--apps-dir', path.join(root, 'a'), '--app', path.join(root, 'OmO.app'), '--loader', path.join(root, 'loader-repo'),
    '--mod', mod, '--dry-run'], { encoding: 'utf8' });
  assert.equal(JSON.parse(out).dryRun, true);
  assert.equal(fs.existsSync(path.join(root, 'm')), false);
  assert.equal(fs.existsSync(path.join(root, 'a')), false);
});
