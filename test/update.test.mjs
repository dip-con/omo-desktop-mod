// loader/update.mjs: installed folders are compared with their git work tree sources and swapped in from them.
// Every repository and mods home is a temp folder; the git repositories are real (`git init`).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyUpdates, checkUpdates, defaultIo } from '../loader/update.mjs';

const UPDATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'loader', 'update.mjs');
const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (file) => fs.readFileSync(file, 'utf8');
const modJson = (enabled) => `${JSON.stringify({ id: 'ko', name: 'Korean', nameKo: '한국어', version: '1.0.0', enabled, order: 1, entry: { page: 'page.js' }, contributes: {}, anchors: [{ selector: '#root', route: '*' }] }, null, 2)}\n`;

// A repository with mods/ko and loader/, and a mods home installed from it (ko switched off by the user).
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-update-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(path.join(repo, 'mods', 'ko', 'mod.json'), modJson(true));
  write(path.join(repo, 'mods', 'ko', 'page.js'), 'page v1\n');
  write(path.join(repo, 'mods', 'ko', 'old.js'), 'removed later\n');
  write(path.join(repo, 'mods', 'ko', 'tests', 'x.test.js'), 'not installed\n');
  write(path.join(repo, 'loader', 'boot.mjs'), 'boot v1\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'v1');
  const modsHome = path.join(root, 'mods');
  write(path.join(modsHome, 'ko', 'mod.json'), modJson(false));
  write(path.join(modsHome, 'ko', 'page.js'), 'page v1\n');
  write(path.join(modsHome, 'ko', 'old.js'), 'removed later\n');
  write(path.join(modsHome, '_loader', 'boot.mjs'), 'boot v1\n');
  write(path.join(modsHome, '_loader', 'config.json'), '{"appBundle":"/x"}\n');
  write(path.join(modsHome, '_loader', 'backups', 'b', 'ko-mod.json'), 'backup\n');
  write(path.join(modsHome, '_loader', 'logs', 'loader.log'), 'log\n');
  const manifest = {
    files: ['_loader/boot.mjs', '_loader/config.json', 'ko/mod.json', 'ko/page.js', 'ko/old.js'],
    sources: {
      _loader: { repoRoot: repo, subdir: 'loader', remote: null, commit: null },
      ko: { repoRoot: repo, subdir: 'mods/ko', remote: null, commit: null },
    },
  };
  write(path.join(modsHome, '_loader', 'install-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, repo, modsHome };
}
const manifestOf = (modsHome) => JSON.parse(read(path.join(modsHome, '_loader', 'install-manifest.json')));
const itemOf = (answer, id) => answer.items.find((item) => item.id === id);

describe('checkUpdates', () => {
  it('reports no change when the installed copy matches its source, whatever the enabled switch says', () => {
    const { modsHome } = fixture();
    const answer = checkUpdates({ modsHome });
    assert.equal(answer.ok, true);
    for (const id of ['_loader', 'ko']) {
      const item = itemOf(answer, id);
      assert.equal(item.error, null);
      assert.equal(item.changed, false);
      assert.equal(item.installedHash, item.sourceHash);
    }
  });

  it('reports a change after a source file is edited', () => {
    const { repo, modsHome } = fixture();
    write(path.join(repo, 'mods', 'ko', 'page.js'), 'page v2\n');
    const ko = itemOf(checkUpdates({ modsHome }), 'ko');
    assert.equal(ko.changed, true);
    assert.notEqual(ko.installedHash, ko.sourceHash);
    assert.equal(itemOf(checkUpdates({ modsHome }), '_loader').changed, false);
  });

  it('answers a missing source as an error entry instead of throwing', () => {
    const { root, modsHome } = fixture();
    const manifest = manifestOf(modsHome);
    manifest.sources.ko.repoRoot = path.join(root, 'gone');
    const answer = checkUpdates({ modsHome, manifest });
    assert.match(itemOf(answer, 'ko').error, /^SOURCE_MISSING/);
    assert.equal(itemOf(answer, 'ko').changed, false);
    assert.match(itemOf(checkUpdates({ modsHome, ids: ['nope'] }), 'nope').error, /^NO_SOURCE/);
    assert.equal(checkUpdates({ modsHome: path.join(root, 'empty') }).code, 'NO_MANIFEST');
  });
});

describe('applyUpdates', () => {
  it('copies the changed source in, keeps the enabled switch, and records the commit and files', () => {
    const { repo, modsHome } = fixture();
    write(path.join(repo, 'mods', 'ko', 'page.js'), 'page v2\n');
    fs.rmSync(path.join(repo, 'mods', 'ko', 'old.js'));
    git(repo, 'commit', '-q', '-am', 'v2');
    const result = applyUpdates({ modsHome });
    assert.deepEqual(result, { ok: true, applied: ['ko'], skipped: [{ id: '_loader', reason: 'UNCHANGED' }], errors: [] });
    assert.equal(read(path.join(modsHome, 'ko', 'page.js')), 'page v2\n');
    assert.equal(fs.existsSync(path.join(modsHome, 'ko', 'old.js')), false);
    assert.equal(fs.existsSync(path.join(modsHome, 'ko', 'tests')), false);
    assert.equal(JSON.parse(read(path.join(modsHome, 'ko', 'mod.json'))).enabled, false);
    assert.equal(fs.existsSync(path.join(modsHome, '.update-staging')), false);
    const manifest = manifestOf(modsHome);
    assert.equal(manifest.sources.ko.commit, git(repo, 'rev-parse', 'HEAD'));
    assert.deepEqual(manifest.files.filter((f) => f.startsWith('ko/')).sort(), ['ko/mod.json', 'ko/page.js']);
    assert.equal(itemOf(checkUpdates({ modsHome }), 'ko').changed, false);
  });

  it('updates _loader but keeps its config, manifest, backups and logs', () => {
    const { repo, modsHome } = fixture();
    write(path.join(repo, 'loader', 'boot.mjs'), 'boot v2\n');
    write(path.join(repo, 'loader', 'update.mjs'), 'new file\n');
    const loader = path.join(modsHome, '_loader');
    const kept = ['config.json', 'backups/b/ko-mod.json', 'logs/loader.log'].map((rel) => [rel, read(path.join(loader, rel))]);
    const result = applyUpdates({ modsHome, ids: ['_loader'] });
    assert.deepEqual(result.applied, ['_loader']);
    assert.equal(read(path.join(loader, 'boot.mjs')), 'boot v2\n');
    assert.equal(read(path.join(loader, 'update.mjs')), 'new file\n');
    for (const [rel, text] of kept) assert.equal(read(path.join(loader, rel)), text, rel);
    assert.ok(manifestOf(modsHome).files.includes('_loader/config.json'));
    assert.ok(manifestOf(modsHome).files.includes('_loader/update.mjs'));
  });

  it('puts the old folder back when the swap fails', () => {
    const { repo, modsHome } = fixture();
    write(path.join(repo, 'mods', 'ko', 'page.js'), 'page v2\n');
    const target = path.join(modsHome, 'ko');
    const stagedIn = (from, to) => to === target && from.includes('.update-staging') && !path.basename(from).includes('-old-');
    const failingFs = { ...fs, renameSync: (from, to) => (stagedIn(from, to) ? (() => { throw new Error('disk full'); })() : fs.renameSync(from, to)) };
    const result = applyUpdates({ modsHome, ids: ['ko'], io: { ...defaultIo, fs: failingFs } });
    assert.equal(result.applied.length, 0);
    assert.match(result.errors[0].message, /APPLY_FAILED: disk full/);
    assert.equal(read(path.join(target, 'page.js')), 'page v1\n');
    assert.equal(fs.existsSync(path.join(modsHome, '.update-staging')), false);
  });

  it('pulls a clean work tree with an upstream first, and leaves a dirty one alone', () => {
    const { root, repo, modsHome } = fixture();
    const origin = path.join(root, 'origin.git');
    git(root, 'clone', '-q', '--bare', repo, origin);
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'fetch', '-q', 'origin');
    git(repo, 'branch', '-q', '--set-upstream-to=origin/main');
    const other = path.join(root, 'other');
    git(root, 'clone', '-q', origin, other);
    write(path.join(other, 'mods', 'ko', 'page.js'), 'page pulled\n');
    git(other, 'commit', '-q', '-am', 'upstream change');
    git(other, 'push', '-q', 'origin', 'main');

    write(path.join(repo, 'scratch.txt'), 'dirty\n');
    const dirty = applyUpdates({ modsHome, pull: true });
    assert.deepEqual(dirty.errors, []);
    assert.equal(read(path.join(modsHome, 'ko', 'page.js')), 'page v1\n');

    fs.rmSync(path.join(repo, 'scratch.txt'));
    const clean = applyUpdates({ modsHome, pull: true });
    assert.deepEqual(clean.errors, []);
    assert.deepEqual(clean.applied, ['ko']);
    assert.equal(read(path.join(modsHome, 'ko', 'page.js')), 'page pulled\n');
    assert.equal(manifestOf(modsHome).sources.ko.commit, git(other, 'rev-parse', 'HEAD'));
  });

  it('reports a missing source as an error and still applies the others', () => {
    const { root, repo, modsHome } = fixture();
    write(path.join(repo, 'loader', 'boot.mjs'), 'boot v2\n');
    const manifest = manifestOf(modsHome);
    manifest.sources.ko.repoRoot = path.join(root, 'gone');
    write(path.join(modsHome, '_loader', 'install-manifest.json'), JSON.stringify(manifest));
    const result = applyUpdates({ modsHome });
    assert.deepEqual(result.applied, ['_loader']);
    assert.deepEqual(result.errors.map((e) => e.id), ['ko']);
  });
});

describe('update.mjs CLI', () => {
  it('runs from an installed _loader, finds its mods home, and prints the check as JSON', () => {
    const { repo, modsHome } = fixture();
    fs.copyFileSync(UPDATE_FILE, path.join(modsHome, '_loader', 'update.mjs'));
    write(path.join(repo, 'loader', 'update.mjs'), read(UPDATE_FILE));
    const run = spawnSync(process.execPath, [path.join(modsHome, '_loader', 'update.mjs'), '--check', '--mod', 'ko'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const answer = JSON.parse(run.stdout);
    assert.deepEqual(answer.items.map((item) => [item.id, item.changed]), [['ko', false]]);
    const bad = spawnSync(process.execPath, [path.join(modsHome, '_loader', 'update.mjs'), '--check', '--mod', 'nope'], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
  });
});
