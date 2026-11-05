import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readJson } from '../src/core/fsx.mjs';
import { install } from '../src/install/install.mjs';
import { apply, check } from '../src/update/update.mjs';
import { fakeApp, fakeGithub, loaderRepo, modJson, sha, tempDir, writeTree } from './fixtures-update/fake.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function installed(t, { fetch, mods } = {}) {
  const root = tempDir(t);
  const opts = { modsHome: path.join(root, 'mods'), appsDir: path.join(root, 'apps'), app: fakeApp(root), loader: loaderRepo(root) };
  const ko = writeTree(path.join(root, 'src-ko'), { 'mod.json': modJson('ko'), 'page.js': 'v1;\n' });
  await install({ ...opts, mods: mods ?? [ko], fetch });
  return { root, ...opts, ko };
}

test('check reports unchanged local sources', async (t) => {
  const { modsHome } = await installed(t);
  const result = await check({ modsHome });
  assert.equal(result.ok, true);
  assert.deepEqual(result.items.map((i) => [i.id, i.changed, i.installed === i.latest]), [
    ['_loader', false, true], ['modmgr', false, true], ['ko', false, true],
  ]);
});

test('apply swaps a changed mod in, keeps enabled and foreign files', async (t) => {
  const { modsHome, ko } = await installed(t);
  const koJson = path.join(modsHome, 'ko/mod.json');
  fs.writeFileSync(koJson, JSON.stringify({ ...readJson(koJson), enabled: false }));
  writeTree(modsHome, { 'ko/user.txt': 'mine' });
  writeTree(ko, { 'page.js': 'v2;\n', 'extra.js': 'new' });
  fs.rmSync(path.join(ko, 'mod.json'));
  writeTree(ko, { 'mod.json': modJson('ko', { version: '2.0.0' }) });

  const checked = await check({ modsHome, ids: ['ko'] });
  assert.equal(checked.items[0].changed, true);
  const result = await apply({ modsHome });
  assert.deepEqual(result.applied, ['ko']);
  assert.deepEqual(result.skipped.map((s) => s.id), ['_loader', 'modmgr']);
  assert.equal(fs.readFileSync(path.join(modsHome, 'ko/page.js'), 'utf8'), 'v2;\n');
  assert.equal(readJson(koJson).enabled, false);
  assert.equal(readJson(koJson).version, '2.0.0');
  assert.equal(fs.readFileSync(path.join(modsHome, 'ko/user.txt'), 'utf8'), 'mine');
  assert.equal(fs.existsSync(path.join(modsHome, '.staging')), false);
  const record = readJson(path.join(modsHome, 'install.json'));
  assert.deepEqual(record.files.ko, ['extra.js', 'mod.json', 'page.js']);
  assert.equal(record.sources.ko.hash, checked.items[0].latest);
  assert.equal((await check({ modsHome, ids: ['ko'] })).items[0].changed, false);
});

test('apply of _loader keeps config.json and drops removed source files', async (t) => {
  const { modsHome, loader } = await installed(t);
  const config = readJson(path.join(modsHome, '_loader/config.json'));
  fs.rmSync(path.join(loader, 'src/update/update.mjs'));
  writeTree(loader, { 'src/core/paths.mjs': 'export const x = 2;\n' });
  const result = await apply({ modsHome, ids: ['_loader'] });
  assert.deepEqual(result.applied, ['_loader']);
  assert.deepEqual(readJson(path.join(modsHome, '_loader/config.json')), config);
  assert.equal(fs.existsSync(path.join(modsHome, '_loader/update/update.mjs')), false);
  assert.ok(readJson(path.join(modsHome, 'install.json')).files._loader.includes('config.json'));
});

test('a missing source is an error and leaves the installed folder alone', async (t) => {
  const { modsHome, ko } = await installed(t);
  fs.rmSync(ko, { recursive: true });
  const result = await apply({ modsHome, ids: ['ko'] });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].id, 'ko');
  assert.equal(fs.readFileSync(path.join(modsHome, 'ko/page.js'), 'utf8'), 'v1;\n');
});

test('github sources compare commits and apply the new tree', async (t) => {
  const repos = { 'o/mods': { sha: sha('a'), files: { 'mods/ko/mod.json': modJson('ko'), 'mods/ko/page.js': 'a' } } };
  const scratch = tempDir(t);
  const gh = fakeGithub(scratch, repos);
  const { modsHome } = await installed(t, { fetch: gh.fetch, mods: ['github:o/mods/mods/ko#main'] });
  assert.equal((await check({ modsHome, ids: ['ko'], fetch: gh.fetch })).items[0].changed, false);
  repos['o/mods'] = { sha: sha('b'), files: { 'mods/ko/mod.json': modJson('ko'), 'mods/ko/page.js': 'b' } };
  const item = (await check({ modsHome, ids: ['ko'], fetch: gh.fetch })).items[0];
  assert.deepEqual([item.installed, item.latest, item.changed], [sha('a'), sha('b'), true]);
  assert.deepEqual((await apply({ modsHome, ids: ['ko'], fetch: gh.fetch })).applied, ['ko']);
  assert.equal(fs.readFileSync(path.join(modsHome, 'ko/page.js'), 'utf8'), 'b');
  assert.equal(readJson(path.join(modsHome, 'install.json')).sources.ko.commit, sha('b'));
});

test('without install.json check and apply fail cleanly', async (t) => {
  const modsHome = tempDir(t);
  assert.equal((await check({ modsHome })).ok, false);
  assert.equal((await apply({ modsHome })).ok, false);
  const unknown = await check({ modsHome: (await installed(t)).modsHome, ids: ['nope'] });
  assert.match(unknown.items[0].error, /no install source/);
});

test('bin/update.mjs --check prints JSON and exits 1 on errors', async (t) => {
  const { modsHome } = await installed(t);
  const bin = path.join(REPO, 'bin/update.mjs');
  const ok = await promisify(execFile)(process.execPath, [bin, '--check', '--mods-home', modsHome]);
  assert.equal(JSON.parse(ok.stdout).ok, true);
  await assert.rejects(promisify(execFile)(process.execPath, [bin, '--check', '--mod', 'nope', '--mods-home', modsHome]), (error) => {
    assert.equal(error.code, 1);
    return true;
  });
});
