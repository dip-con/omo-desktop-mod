import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOT_RUNNING_TEXT } from '../loader/launch.mjs';
import { APP_USER_MODEL_ID, writeLink } from '../mods/modmgr/host/lnk.mjs';
import { withDefaults } from '../tools/shortcuts.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOOL = path.join(ROOT, 'tools', 'shortcuts.mjs');
const WIN_ONLY = process.platform === 'win32' ? false : 'Windows .lnk shortcuts only';
const WSCRIPT = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');
const NOTEPAD = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe');

const tempRoots = [];
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

// Every folder is a fresh temp folder; the tool is never given a real one.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-shortcuts-'));
  tempRoots.push(root);
  const dirs = {
    root,
    desktopDir: path.join(root, 'Desktop'),
    startMenuDir: path.join(root, 'Start Menu'),
    taskbarDir: path.join(root, 'Taskbar'),
    modsHome: path.join(root, 'app-mods'),
    appDir: path.join(root, 'omo-app'),
    backupDir: path.join(root, 'backup'),
  };
  for (const dir of [dirs.desktopDir, dirs.startMenuDir, dirs.taskbarDir, path.join(dirs.modsHome, '_loader'), dirs.appDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(dirs.modsHome, '_loader', 'launch.vbs'), 'fixture\r\n');
  fs.writeFileSync(path.join(dirs.appDir, 'OmO.exe'), 'fixture exe');
  return dirs;
}

const appExe = (d) => path.join(d.appDir, 'OmO.exe');

function icons(d) {
  return {
    desktop: path.join(d.desktopDir, 'OmO.lnk'),
    startmenu: path.join(d.startMenuDir, 'OmO.lnk'),
    taskbar: path.join(d.taskbarDir, 'OmO.lnk'),
  };
}

const pure = (d) => path.join(d.desktopDir, 'OmO (순정).lnk');

// Every 'OmO (순정)' file in the three icon folders. apply makes exactly one, the desktop one.
function pureFiles(d) {
  return [d.desktopDir, d.startMenuDir, d.taskbarDir]
    .flatMap((dir) => fs.readdirSync(dir).filter((name) => name.includes('순정')).map((name) => path.join(dir, name)));
}

// A plain OmO.lnk as the installer leaves it: target OmO.exe, the app AUMID. target and aumid can be overridden.
async function plainIcon(file, d, { target = appExe(d), aumid = APP_USER_MODEL_ID } = {}) {
  await writeLink({
    path: file,
    create: true,
    target,
    args: '',
    workDir: d.appDir,
    iconPath: appExe(d),
    iconIndex: 0,
    description: null,
    aumid,
  });
}

async function plainSet(d) {
  const files = icons(d);
  for (const file of Object.values(files)) await plainIcon(file, d);
  return files;
}

const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);
// Every file directly in the given folders, by path, with its sha256.
const tree = (dirs) => Object.fromEntries(dirs.flatMap((dir) => fs.readdirSync(dir).map((name) => path.join(dir, name))).map((f) => [f, sha(f)]));

function flags(d, extra = []) {
  return [
    '--desktop-dir', d.desktopDir,
    '--start-menu-dir', d.startMenuDir,
    '--taskbar-dir', d.taskbarDir,
    '--mods-home', d.modsHome,
    '--app-dir', d.appDir,
    ...extra,
  ];
}

function cli(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

describe('tools/shortcuts.mjs', { skip: WIN_ONLY }, () => {
  it('apply retargets the three icons and keeps their AUMID', async () => {
    const d = fixture();
    await plainSet(d);
    const r = cli(['apply', ...flags(d, ['--backup-dir', d.backupDir])]);
    assert.equal(r.status, 0, r.err);
    const byLabel = Object.fromEntries(JSON.parse(r.out).shortcuts.map((s) => [s.label, s]));
    for (const label of ['desktop', 'startmenu', 'taskbar']) {
      assert.equal(byLabel[label].kind, 'mod');
      assert.equal(byLabel[label].aumid, APP_USER_MODEL_ID);
      assert.equal(byLabel[label].icon, `${appExe(d)},0`);
    }
    assert.equal(byLabel['desktop-pure'].kind, 'missing');
  });

  it('apply makes no OmO (순정) file in any icon folder', async () => {
    // Given: the three plain icons. When: apply. Then: no 'OmO (순정)' file exists.
    const d = fixture();
    await plainSet(d);
    const r = cli(['apply', ...flags(d, ['--backup-dir', d.backupDir])]);
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(pureFiles(d), []);
  });

  it('status after apply counts three mod icons with the app AUMID and no OmO (순정) file', async () => {
    // Given: an applied set. When: status. Then: 3 'mod' rows with com.omo.desktop; the desktop 'OmO (순정)' row is missing.
    const d = fixture();
    await plainSet(d);
    assert.equal(cli(['apply', ...flags(d, ['--backup-dir', d.backupDir])]).status, 0);
    const r = cli(['status', ...flags(d)]);
    assert.equal(r.status, 0, r.err);
    const rows = JSON.parse(r.out).shortcuts;
    assert.deepEqual(rows.filter((s) => s.kind === 'mod').map((s) => s.aumid), [APP_USER_MODEL_ID, APP_USER_MODEL_ID, APP_USER_MODEL_ID]);
    const pureRows = rows.filter((s) => path.basename(s.path) === 'OmO (순정).lnk');
    assert.deepEqual(pureRows.map((s) => [s.path, s.kind]), [[pure(d), 'missing']]);
  });

  it('a second apply changes no file and makes no second backup', async () => {
    const d = fixture();
    await plainSet(d);
    assert.equal(cli(['apply', ...flags(d, ['--backup-dir', d.backupDir])]).status, 0);
    const folders = [d.desktopDir, d.startMenuDir, d.taskbarDir, d.backupDir];
    const before = tree(folders);
    const r = cli(['apply', ...flags(d, ['--backup-dir', d.backupDir])]);
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(tree(folders), before);
  });

  it('restore returns the three icons byte for byte', async () => {
    const d = fixture();
    const files = Object.values(await plainSet(d));
    const original = files.map(sha);
    assert.equal(cli(['apply', ...flags(d, ['--backup-dir', d.backupDir])]).status, 0);
    const r = cli(['restore', ...flags(d, ['--backup-dir', d.backupDir])]);
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(files.map(sha), original);
    assert.deepEqual(pureFiles(d), []);
  });

  it('restore takes back a manifest of the earlier two-link design, start-menu OmO (순정) included', async () => {
    // Given: an apply whose manifest also lists a start-menu 'OmO (순정).lnk', as the earlier design wrote it.
    const d = fixture();
    const files = Object.values(await plainSet(d));
    const original = files.map(sha);
    assert.equal(cli(['apply', ...flags(d, ['--backup-dir', d.backupDir])]).status, 0);
    const legacy = path.join(d.startMenuDir, 'OmO (순정).lnk');
    await writeLink({ path: legacy, create: true, target: appExe(d), args: '', workDir: d.appDir, iconPath: appExe(d), iconIndex: 0, description: 'OmO (모드 없이)', aumid: null });
    const manifestFile = path.join(d.backupDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const stat = fs.statSync(legacy);
    manifest.entries.push({ label: 'startmenu-pure', path: legacy, kind: 'create', backup: null, sha256: sha(legacy), size: stat.size, mtime: stat.mtime.toISOString() });
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    // When: restore. Then: the three originals are back, and both 'OmO (순정).lnk' and the manifest are gone.
    const r = cli(['restore', ...flags(d, ['--backup-dir', d.backupDir])]);
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(files.map(sha), original);
    assert.deepEqual(pureFiles(d), []);
    assert.equal(fs.existsSync(manifestFile), false);
  });

  it('restore refuses to remove a desktop OmO (순정).lnk that differs from the one the manifest recorded, and changes no file', async () => {
    // Given: an applied set and a manifest that lists the desktop 'OmO (순정).lnk' as an earlier design made it; the
    // file was then replaced by another shortcut of the same name.
    const d = fixture();
    await plainSet(d);
    assert.equal(cli(['apply', ...flags(d, ['--backup-dir', d.backupDir])]).status, 0);
    await writeLink({ path: pure(d), create: true, target: appExe(d), args: '', workDir: d.appDir, iconPath: appExe(d), iconIndex: 0, description: 'OmO (모드 없이)', aumid: null });
    const manifestFile = path.join(d.backupDir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.entries.push({ label: 'desktop-pure', path: pure(d), kind: 'create', backup: null, sha256: sha(pure(d)), size: null, mtime: null });
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.rmSync(pure(d));
    await plainIcon(pure(d), d, { target: NOTEPAD, aumid: null });
    const folders = [d.desktopDir, d.startMenuDir, d.taskbarDir, d.backupDir];
    const before = tree(folders);
    // When
    const r = cli(['restore', ...flags(d, ['--backup-dir', d.backupDir])]);
    // Then: FOREIGN_SHORTCUT, and the foreign file, the three icons, the backups and the manifest keep their bytes
    assert.equal(r.status, 1);
    assert.ok(r.err.includes('FOREIGN_SHORTCUT'), r.err);
    assert.deepEqual(tree(folders), before);
  });

  it('a foreign target refuses before any write', async () => {
    const d = fixture();
    const files = icons(d);
    await plainIcon(files.desktop, d);
    await plainIcon(files.startmenu, d);
    await plainIcon(files.taskbar, d, { target: NOTEPAD });
    const before = [files.desktop, files.startmenu, files.taskbar].map(sha);
    const r = cli(['apply', ...flags(d, ['--backup-dir', d.backupDir])]);
    assert.equal(r.status, 1);
    assert.ok(r.err.includes('FOREIGN_SHORTCUT'), r.err);
    assert.deepEqual([files.desktop, files.startmenu, files.taskbar].map(sha), before);
    assert.equal(fs.existsSync(d.backupDir), false);
    assert.deepEqual(pureFiles(d), []);
  });

  it('a wrong AUMID refuses with UNEXPECTED_AUMID and writes nothing', async () => {
    const d = fixture();
    const files = icons(d);
    await plainIcon(files.desktop, d);
    await plainIcon(files.startmenu, d);
    await plainIcon(files.taskbar, d, { aumid: 'com.other.app' });
    const before = [files.desktop, files.startmenu].map(sha);
    const r = cli(['apply', ...flags(d, ['--backup-dir', d.backupDir])]);
    assert.equal(r.status, 1);
    assert.ok(r.err.includes('UNEXPECTED_AUMID'), r.err);
    assert.deepEqual([files.desktop, files.startmenu].map(sha), before);
  });

  it('dry-run prints the plan and writes nothing', async () => {
    const d = fixture();
    const files = Object.values(await plainSet(d));
    const before = files.map(sha);
    const r = cli(['apply', ...flags(d, ['--backup-dir', d.backupDir, '--dry-run'])]);
    assert.equal(r.status, 0, r.err);
    const { steps } = JSON.parse(r.out);
    assert.ok(steps.some((s) => s.action === 'retarget'));
    assert.equal(steps.length, 3);
    assert.deepEqual(files.map(sha), before);
    assert.equal(fs.existsSync(d.backupDir), false);
    assert.deepEqual(pureFiles(d), []);
  });

  it('an unknown flag exits 2', () => {
    const r = cli(['apply', '--no-such-flag', 'x']);
    assert.equal(r.status, 2);
  });

  it('restore without a manifest refuses', () => {
    const d = fixture();
    const r = cli(['restore', ...flags(d, ['--backup-dir', d.backupDir])]);
    assert.equal(r.status, 1);
    assert.ok(r.err.includes('NO_MANIFEST'), r.err);
  });
  it('no flag is needed: status reports the folders under the account home, not a redirected HOME or USERPROFILE', () => {
    const decoy = fixture().root;
    const r = spawnSync(process.execPath, [TOOL, 'status'], {
      encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, HOME: decoy, USERPROFILE: decoy },
    });
    assert.equal(r.status, 0, r.stderr);
    const home = os.userInfo().homedir.toLowerCase();
    for (const s of JSON.parse(r.stdout).shortcuts) assert.ok(s.path.toLowerCase().startsWith(home), s.path);
  });

  it('withDefaults resolves the mods home and app folder under the account home when no flag is given', () => {
    const decoy = fixture().root;
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = decoy;
    process.env.USERPROFILE = decoy;
    try {
      const d = withDefaults({ command: 'status', dryRun: false, desktopDir: null, startMenuDir: null, taskbarDir: null, modsHome: null, appDir: null, backupDir: null });
      const home = os.userInfo().homedir;
      assert.equal(d.modsHome, path.join(home, '.omo', 'app-mods'));
      assert.equal(d.appDir, path.join(home, 'AppData', 'Local', 'Programs', 'omo'));
    } finally {
      for (const key of ['HOME', 'USERPROFILE']) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

describe('loader/launch.mjs not-running message', () => {
  it('no longer names the removed shortcut', () => {
    assert.equal(NOT_RUNNING_TEXT.includes('OmO (모드)'), false);
  });
});
