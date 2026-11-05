// tools/install.mjs on macOS: mods home layout, manifest sources, the "OmO Mods.app" launcher, reinstall and uninstall.
// Everything runs in temp folders with a fake OmO app bundle; the real app and the live mods home are never touched.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INSTALLER = path.join(ROOT, 'tools', 'install.mjs');
const LAUNCHER = 'OmO Mods.app';

const tempRoots = [];
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omo-install-${name}-`));
  tempRoots.push(dir);
  return dir;
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// A fixture source tree: loader, docs/app-facts.json and one bundled mod. With git: an uncommitted work tree with an origin.
function fixtureSource({ withGit = false } = {}) {
  const root = tempDir('src');
  write(path.join(root, 'loader', 'boot.mjs'), '// fixture boot\n');
  write(path.join(root, 'loader', 'README.md'), 'fixture\n');
  write(path.join(root, 'docs', 'app-facts.json'), '{"mainTarget": "fixture"}\n');
  write(path.join(root, 'mods', 'sample', 'mod.json'), JSON.stringify({ id: 'sample', enabled: true, anchors: [{ selector: '#root' }] }, null, 2));
  write(path.join(root, 'mods', 'sample', 'host', 'host.mjs'), '// fixture host\n');
  if (withGit) {
    execFileSync('git', ['-C', root, 'init', '-q']);
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://example.invalid/fixture.git']);
  }
  return root;
}

function fakeApp() {
  const app = path.join(tempDir('app'), 'OmO.app');
  write(path.join(app, 'Contents', 'MacOS', 'OmO'), '#!/bin/sh\nexit 0\n');
  write(path.join(app, 'Contents', 'Resources', 'icon.icns'), 'fake-icon');
  return app;
}

function externalMod(id, extra = {}) {
  const dir = path.join(tempDir('ext'), id);
  write(path.join(dir, 'mod.json'), JSON.stringify({ id, enabled: true, anchors: [{ selector: '#root' }], ...extra }));
  write(path.join(dir, 'page.js'), '// external\n');
  return dir;
}

function setup(opts) {
  const base = tempDir('home');
  const env = { source: fixtureSource(opts), home: path.join(base, 'app-mods'), apps: path.join(base, 'Applications'), app: fakeApp() };
  env.args = ['--source-root', env.source, '--mods-home', env.home, '--apps-dir', env.apps, '--app', env.app];
  env.launcher = path.join(env.apps, LAUNCHER);
  return env;
}

function runCli(args) {
  const r = spawnSync(process.execPath, [INSTALLER, ...args], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function plist(app) {
  return JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }));
}

describe('tools/install.mjs', () => {
  it('installs loader, mods, config and a launcher bundle', () => {
    const env = setup();
    const r = runCli(env.args);
    assert.equal(r.status, 0, r.err);
    assert.equal(fs.readFileSync(path.join(env.home, '_loader', 'boot.mjs'), 'utf8'), '// fixture boot\n');
    assert.ok(fs.existsSync(path.join(env.home, '_loader', 'README.md')));
    assert.ok(fs.existsSync(path.join(env.home, '_loader', 'app-facts.json')));
    assert.ok(fs.existsSync(path.join(env.home, 'sample', 'host', 'host.mjs')));
    const config = readJson(path.join(env.home, '_loader', 'config.json'));
    assert.equal(config.node, process.execPath);
    assert.equal(config.appBundle, env.app);
    assert.ok(!Number.isNaN(Date.parse(config.installedAt)));

    const info = plist(env.launcher);
    assert.equal(info.CFBundleIdentifier, 'kr.persnal.omo-mods');
    assert.equal(info.CFBundleName, 'OmO Mods');
    assert.equal(info.CFBundleExecutable, 'omo-mods');
    assert.equal(info.CFBundleIconFile, 'icon');
    assert.equal(info.LSUIElement, true);
    const exe = path.join(env.launcher, 'Contents', 'MacOS', 'omo-mods');
    assert.equal(fs.statSync(exe).mode & 0o777, 0o755);
    const script = fs.readFileSync(exe, 'utf8');
    assert.ok(script.startsWith('#!/bin/bash\n'));
    assert.ok(script.includes(`exec "${process.execPath}" "${path.join(env.home, '_loader', 'boot.mjs')}" "${env.app}" "$@"\n`));
    assert.equal(fs.readFileSync(path.join(env.launcher, 'Contents', 'Resources', 'icon.icns'), 'utf8'), 'fake-icon');
    assert.equal(readJson(path.join(env.home, '_loader', 'install-manifest.json')).launcher, env.launcher);
  });

  it('records git sources for the loader and bundled mods, and nulls for a plain folder', () => {
    const env = setup({ withGit: true });
    const external = externalMod('extra');
    const r = runCli([...env.args, '--mod', external]);
    assert.equal(r.status, 0, r.err);
    const { sources, files, sha256 } = readJson(path.join(env.home, '_loader', 'install-manifest.json'));
    const repoRoot = fs.realpathSync(env.source);
    assert.deepEqual(sources._loader, { repoRoot, subdir: 'loader', remote: 'https://example.invalid/fixture.git', commit: null });
    assert.deepEqual(sources.sample, { ...sources._loader, subdir: 'mods/sample' });
    assert.deepEqual(sources.extra, { repoRoot: null, subdir: null, remote: null, commit: null });
    assert.ok(files.includes(path.join('extra', 'page.js')));
    assert.match(sha256[path.join('extra', 'page.js')], /^[0-9a-f]{64}$/);
  });

  it('keeps a user-changed enabled flag and removes files the new install no longer plans', () => {
    const env = setup();
    const external = externalMod('extra');
    assert.equal(runCli([...env.args, '--mod', external]).status, 0);
    const installedMod = path.join(env.home, 'extra', 'mod.json');
    write(installedMod, JSON.stringify({ ...readJson(installedMod), enabled: false }));
    fs.rmSync(path.join(env.source, 'mods', 'sample', 'host'), { recursive: true });
    const r = runCli([...env.args, '--mod', external]);
    assert.equal(r.status, 0, r.err);
    assert.equal(readJson(installedMod).enabled, false);
    assert.equal(fs.existsSync(path.join(env.home, 'sample', 'host')), false);
  });

  it('refuses a foreign file or launcher without writing anything', () => {
    const env = setup();
    write(path.join(env.home, '_loader', 'boot.mjs'), 'foreign');
    const r = runCli(env.args);
    assert.equal(r.status, 1);
    assert.match(r.err, /refusing to overwrite/);
    assert.equal(fs.readFileSync(path.join(env.home, '_loader', 'boot.mjs'), 'utf8'), 'foreign');

    const other = setup();
    write(path.join(other.launcher, 'Contents', 'Info.plist'), '<plist/>');
    assert.equal(runCli(other.args).status, 1);
    assert.equal(fs.existsSync(other.home), false);
  });

  it('rejects a mod folder without mod.json or whose id differs from its folder name', () => {
    const env = setup();
    assert.match(runCli([...env.args, '--mod', tempDir('empty')]).err, /mod\.json not found/);
    assert.match(runCli([...env.args, '--mod', externalMod('right', { id: 'wrong' })]).err, /unsafe mod id/);
    assert.equal(fs.existsSync(env.home), false);
  });

  it('--dry-run writes nothing', () => {
    const env = setup();
    const r = runCli([...env.args, '--dry-run']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /nothing written/);
    assert.equal(fs.existsSync(env.home), false);
    assert.equal(fs.existsSync(env.apps), false);
  });

  it('--no-launcher skips the bundle and drops one an earlier install wrote', () => {
    const env = setup();
    assert.equal(runCli(env.args).status, 0);
    const r = runCli([...env.args, '--no-launcher']);
    assert.equal(r.status, 0, r.err);
    assert.equal(fs.existsSync(env.launcher), false);
    assert.equal(readJson(path.join(env.home, '_loader', 'install-manifest.json')).launcher, null);
  });

  it('--uninstall removes the launcher and managed files and leaves user data', () => {
    const env = setup();
    const external = externalMod('extra');
    assert.equal(runCli([...env.args, '--mod', external]).status, 0);
    const userData = path.join(env.home, 'extra', 'user-notes.txt');
    write(userData, 'keep');
    const r = runCli([...env.args, '--uninstall']);
    assert.equal(r.status, 0, r.err);
    assert.equal(fs.existsSync(env.launcher), false);
    assert.equal(fs.existsSync(path.join(env.home, '_loader')), false);
    assert.equal(fs.existsSync(path.join(env.home, 'sample')), false);
    assert.equal(fs.existsSync(path.join(env.home, 'extra', 'page.js')), false);
    assert.equal(fs.readFileSync(userData, 'utf8'), 'keep');
  });
});
