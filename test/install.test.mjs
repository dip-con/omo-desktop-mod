import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_USER_MODEL_ID, writeLink } from '../mods/modmgr/host/lnk.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INSTALLER = path.join(ROOT, 'tools', 'install.mjs');
const APP_EXE = path.join(os.userInfo().homedir, 'AppData', 'Local', 'Programs', 'omo', 'OmO.exe');
const WIN_ONLY = process.platform === 'win32' ? false : 'Windows .lnk shortcuts only';
const WSCRIPT = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');

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

// A fixture source tree: loader, docs/app-facts.json and one mod. No app text is copied in.
function fixtureSource({ anchors = ['#root'] } = {}) {
  const root = tempDir('src');
  write(path.join(root, 'loader', 'launch.mjs'), '// fixture loader\n');
  write(path.join(root, 'docs', 'app-facts.json'), '{"mainTarget": "fixture"}\n');
  write(path.join(root, 'mods', 'sample', 'mod.json'), JSON.stringify({ id: 'sample', enabled: true, anchors }, null, 2));
  write(path.join(root, 'mods', 'sample', 'host', 'host.mjs'), '// fixture host\n');
  return root;
}

function runCli(args) {
  const r = spawnSync(process.execPath, [INSTALLER, ...args], { encoding: 'utf8', windowsHide: true });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

function cliArgs(source, home, extra = []) {
  return ['--source-root', source, '--mods-home', home, ...extra];
}

// A real-looking icon that launches the mod launcher, or one that starts OmO.exe. Both are written in temp folders.
async function modIcon(file, home) {
  await writeLink({
    path: file,
    create: true,
    target: WSCRIPT,
    args: `"${path.join(home, '_loader', 'launch.vbs')}"`,
    workDir: path.join(home, '_loader'),
    iconPath: APP_EXE,
    iconIndex: 0,
    description: null,
    aumid: APP_USER_MODEL_ID,
  });
}

async function plainAt(file, exe) {
  await writeLink({
    path: file,
    create: true,
    target: exe,
    args: '',
    workDir: path.dirname(exe),
    iconPath: exe,
    iconIndex: 0,
    description: null,
    aumid: APP_USER_MODEL_ID,
  });
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function plainIcon(file) {
  await writeLink({
    path: file,
    create: true,
    target: APP_EXE,
    args: '',
    workDir: path.dirname(APP_EXE),
    iconPath: APP_EXE,
    iconIndex: 0,
    description: null,
    aumid: APP_USER_MODEL_ID,
  });
}

describe('tools/install.mjs', () => {
  it('installs an external mod and uninstalls its recorded files', () => {
    const source = fixtureSource();
    const home = path.join(tempDir('home'), 'app-mods');
    const realHome = tempDir('real');
    const external = tempDir('external');
    write(path.join(external, 'mod.json'), JSON.stringify({ id: 'external', anchors: ['#root'] }));
    write(path.join(external, 'host', 'index.mjs'), '// external\n');
    const args = cliArgs(source, home, ['--real-home', realHome]);
    const result = runCli([...args, '--mod', external]);
    assert.equal(result.status, 0, result.err);
    const manifest = JSON.parse(fs.readFileSync(path.join(home, '_loader', 'install-manifest.json'), 'utf8'));
    assert.ok(manifest.files.includes(path.join('external', 'host', 'index.mjs')));
    assert.equal(fs.readFileSync(path.join(home, 'external', 'host', 'index.mjs'), 'utf8'), '// external\n');
    const removed = runCli([...args, '--uninstall']);
    assert.equal(removed.status, 0, removed.err);
    assert.equal(fs.existsSync(path.join(home, 'external', 'host', 'index.mjs')), false);
  });

  it('rejects an external mod without mod.json without writing', () => {
    const home = path.join(tempDir('home'), 'app-mods');
    const r = runCli(cliArgs(fixtureSource(), home, ['--mod', tempDir('external')]));
    assert.equal(r.status, 1);
    assert.match(r.err, /mod\.json not found/);
    assert.equal(fs.existsSync(home), false);
  });

  it('rejects an unsafe external mod id without writing', () => {
    const home = path.join(tempDir('home'), 'app-mods');
    const external = tempDir('external');
    write(path.join(external, 'mod.json'), JSON.stringify({ id: '../escape', anchors: ['#root'] }));
    const r = runCli(cliArgs(fixtureSource(), home, ['--mod', external]));
    assert.equal(r.status, 1);
    assert.match(r.err, /unsafe mod id/);
    assert.equal(fs.existsSync(home), false);
  });

  it('refuses an existing foreign external mod folder', () => {
    const home = path.join(tempDir('home'), 'app-mods');
    const external = tempDir('external');
    write(path.join(external, 'mod.json'), JSON.stringify({ id: 'external', anchors: ['#root'] }));
    const foreign = path.join(home, 'external', 'foreign.txt');
    write(foreign, 'keep');
    const r = runCli(cliArgs(fixtureSource(), home, ['--mod', external]));
    assert.equal(r.status, 1);
    assert.match(r.err, /refusing to overwrite folder/);
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(home, '_loader')), false);
  });

  it('installs when the source has no mods directory', () => {
    const source = fixtureSource();
    fs.rmSync(path.join(source, 'mods'), { recursive: true });
    const home = path.join(tempDir('home'), 'app-mods');
    const r = runCli(cliArgs(source, home));
    assert.equal(r.status, 0, r.err);
    assert.ok(fs.existsSync(path.join(home, '_loader', 'launch.mjs')));
  });

  it('installs the loader and mods and records no shortcuts', () => {
    const home = path.join(tempDir('home'), 'app-mods');
    const r = runCli(cliArgs(fixtureSource(), home));
    assert.equal(r.status, 0, r.err);

    const loaderDir = path.join(home, '_loader');
    assert.ok(fs.existsSync(path.join(loaderDir, 'launch.mjs')));
    assert.ok(fs.existsSync(path.join(loaderDir, 'app-facts.json')));
    assert.ok(fs.existsSync(path.join(home, 'sample', 'host', 'host.mjs')));
    const config = JSON.parse(fs.readFileSync(path.join(loaderDir, 'config.json'), 'utf8'));
    assert.equal(config.node, process.execPath);
    assert.equal(config.appExe, APP_EXE);

    const vbs = fs.readFileSync(path.join(loaderDir, 'launch.vbs'), 'utf8');
    assert.ok(vbs.includes(`node = "${process.execPath}"\r\n`));
    assert.ok(vbs.includes(`boot = "${path.join(loaderDir, 'boot.mjs')}"\r\n`));
    assert.ok(vbs.includes(`app = "${APP_EXE}"\r\n`));

    const manifest = JSON.parse(fs.readFileSync(path.join(loaderDir, 'install-manifest.json'), 'utf8'));
    assert.deepEqual(manifest.shortcuts, []);
  });

  it('refuses the removed --shortcut-dirs flag and writes nothing', () => {
    const home = path.join(tempDir('home'), 'app-mods');
    const r = runCli(cliArgs(fixtureSource(), home, ['--shortcut-dirs', tempDir('desk')]));
    assert.equal(r.status, 1);
    assert.equal(fs.existsSync(home), false);
  });

  it('keeps a user-changed enabled flag on reinstall', () => {
    const source = fixtureSource();
    const home = path.join(tempDir('home'), 'app-mods');
    assert.equal(runCli(cliArgs(source, home)).status, 0);
    const modFile = path.join(home, 'sample', 'mod.json');
    fs.writeFileSync(modFile, JSON.stringify({ id: 'sample', enabled: false, anchors: ['#root'] }));
    assert.equal(runCli(cliArgs(source, home)).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(modFile, 'utf8')).enabled, false);
  });

  it('uninstall removes exactly the managed files when no real icon launches the mod', { skip: WIN_ONLY }, async () => {
    const home = path.join(tempDir('home'), 'app-mods');
    const realHome = tempDir('real');
    fs.mkdirSync(path.join(realHome, 'Desktop'));
    await plainIcon(path.join(realHome, 'Desktop', 'OmO.lnk'));
    const args = cliArgs(fixtureSource(), home, ['--real-home', realHome]);
    assert.equal(runCli(args).status, 0);
    assert.equal(runCli([...args, '--uninstall']).status, 0);
    assert.equal(fs.existsSync(path.join(home, '_loader', 'launch.vbs')), false);
    assert.equal(fs.existsSync(path.join(home, 'sample', 'host', 'host.mjs')), false);
    assert.equal(fs.existsSync(path.join(home, '_loader', 'install-manifest.json')), false);
    assert.equal(fs.existsSync(path.join(realHome, 'Desktop', 'OmO.lnk')), true);
  });

  it('uninstall refuses while a real icon still launches the mod and removes nothing', { skip: WIN_ONLY }, async () => {
    const home = path.join(tempDir('home'), 'app-mods');
    const realHome = tempDir('real');
    fs.mkdirSync(path.join(realHome, 'Desktop'));
    const args = cliArgs(fixtureSource(), home, ['--real-home', realHome]);
    assert.equal(runCli(args).status, 0);
    await modIcon(path.join(realHome, 'Desktop', 'OmO.lnk'), home);
    const r = runCli([...args, '--uninstall']);
    assert.equal(r.status, 1);
    assert.ok(r.err.includes('ICONS_STILL_RETARGETED'), r.err);
    assert.equal(fs.existsSync(path.join(home, '_loader', 'launch.vbs')), true);
    assert.equal(fs.existsSync(path.join(home, '_loader', 'install-manifest.json')), true);
  });

  it('refuses a mod whose anchors are empty and writes nothing', () => {
    const home = path.join(tempDir('home'), 'app-mods');
    const r = runCli(cliArgs(fixtureSource({ anchors: [] }), home));
    assert.equal(r.status, 1);
    assert.equal(fs.existsSync(home), false);
  });

  it('refuses when docs/app-facts.json is missing and writes nothing', () => {
    const source = fixtureSource();
    fs.rmSync(path.join(source, 'docs', 'app-facts.json'));
    const home = path.join(tempDir('home'), 'app-mods');
    const r = runCli(cliArgs(source, home));
    assert.equal(r.status, 1);
    assert.equal(fs.existsSync(home), false);
  });

  it('refuses a foreign _loader/launch.mjs and leaves it byte-identical', () => {
    const home = path.join(tempDir('home'), 'app-mods');
    const foreign = path.join(home, '_loader', 'launch.mjs');
    write(foreign, 'foreign launcher\n');
    const r = runCli(cliArgs(fixtureSource(), home));
    assert.equal(r.status, 1);
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign launcher\n');
    assert.equal(fs.existsSync(path.join(home, '_loader', 'config.json')), false);
  });

  it('--with-icons retargets the real icons with a backup, and --uninstall puts their bytes back', { skip: WIN_ONLY }, async () => {
    // Given: three plain real icons under a temp profile. When: install --with-icons, then --uninstall. Then: the icons are
    // retargeted with one backup record, and after uninstall their bytes match the pre-install bytes.
    const home = path.join(tempDir('home'), 'app-mods');
    const realHome = tempDir('real');
    const exe = path.join(tempDir('app'), 'OmO.exe');
    fs.writeFileSync(exe, 'fixture exe');
    const dirs = [
      path.join(realHome, 'Desktop'),
      path.join(realHome, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      path.join(realHome, 'AppData', 'Roaming', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar'),
    ];
    for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
    const icons = dirs.map((dir) => path.join(dir, 'OmO.lnk'));
    for (const file of icons) await plainAt(file, exe);
    const before = icons.map(sha256);
    const args = cliArgs(fixtureSource(), home, ['--real-home', realHome, '--app-exe', exe]);

    const installed = runCli([...args, '--with-icons']);
    assert.equal(installed.status, 0, installed.err);
    assert.notDeepEqual(icons.map(sha256), before);
    assert.equal(fs.readdirSync(path.join(home, 'backup')).length, 1);

    const removed = runCli([...args, '--uninstall']);
    assert.equal(removed.status, 0, removed.err);
    assert.deepEqual(icons.map(sha256), before);
    assert.equal(fs.existsSync(path.join(home, '_loader', 'install-manifest.json')), false);
  });

  it('--with-icons --dry-run writes no file and retargets no icon', () => {
    const home = path.join(tempDir('home'), 'app-mods');
    const r = runCli(cliArgs(fixtureSource(), home, ['--with-icons', '--dry-run', '--real-home', tempDir('real')]));
    assert.equal(r.status, 0, r.err);
    assert.equal(fs.existsSync(home), false);
  });

  it('dry-run prints the plan and writes nothing', () => {
    const home = path.join(tempDir('home'), 'app-mods');
    const r = runCli(cliArgs(fixtureSource(), home, ['--dry-run']));
    assert.equal(r.status, 0, r.err);
    assert.equal(fs.existsSync(home), false);
  });
});
