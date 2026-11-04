// modmgr host shortcuts(): the three OmO.lnk icons, read only, one state per row, cached until an
// icon file changes. Windows only; every folder is a temp folder handed in as shortcutDirs, so no real icon is read.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createModmgrHost, defaultShortcutDirs } from '../mods/modmgr/host.mjs';
import { readLinks, writeLink } from '../mods/modmgr/host/lnk.mjs';

const WIN_ONLY = process.platform === 'win32' ? false : 'Windows .lnk shortcuts only';
const WSCRIPT = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe');
const NOTEPAD = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe');
const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

const link = (p, target, args) => writeLink({ path: p, create: true, target, args, workDir: path.dirname(target), iconPath: target, iconIndex: 0, description: null, aumid: null });
const facts = (files) => files.filter((f) => fs.existsSync(f)).map((f) => [f, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'), fs.statSync(f).mtimeMs]);

// Desktop OmO.lnk -> the mod launcher, start menu OmO.lnk -> OmO.exe (plain), taskbar OmO.lnk -> notepad (foreign),
// no other icon is read.
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-modmgr-icons-'));
  roots.push(root);
  const dirs = { desktop: path.join(root, 'Desktop'), startMenu: path.join(root, 'Start Menu'), taskbar: path.join(root, 'TaskBar'), appDir: path.join(root, 'omo') };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dirs.appDir, 'OmO.exe'), 'fixture exe');
  await link(path.join(dirs.desktop, 'OmO.lnk'), WSCRIPT, `"${path.join(root, 'app-mods', '_loader', 'launch.vbs')}"`);
  await link(path.join(dirs.startMenu, 'OmO.lnk'), path.join(dirs.appDir, 'OmO.exe'), '');
  await link(path.join(dirs.taskbar, 'OmO.lnk'), NOTEPAD, '');
  const files = [dirs.desktop, dirs.startMenu, dirs.taskbar].map((d) => path.join(d, 'OmO.lnk'));
  return { root, dirs, files };
}

describe('modmgr host shortcuts()', { skip: WIN_ONLY }, () => {
  it('answers the three icons read only, one state per row, and is no longer an unknown method', async () => {
    const { dirs, files } = await fixture();
    const before = facts(files);
    const host = createModmgrHost({ modsRoot: path.join(dirs.desktop, 'no-mods'), stateFile: path.join(dirs.desktop, 'state.json'), shortcutDirs: dirs });
    const answer = await host.handle('shortcuts', []);
    assert.equal(answer.ok, true);
    const rows = Object.fromEntries(answer.shortcuts.map((r) => [r.label, r]));
    assert.deepEqual(answer.shortcuts.map((r) => [r.label, r.kind]), [
      ['desktop', 'mod'], ['startmenu', 'plain'], ['taskbar', 'other'],
    ]);
    assert.equal(rows.taskbar.error, null);
    assert.equal(rows.taskbar.target.toLowerCase(), NOTEPAD.toLowerCase());
    assert.deepEqual(facts(files), before, 'sha256 and mtime of every icon file unchanged');
  });

  it('reads once while the files stay the same, shares a read in flight, and reads again after an icon changes', async () => {
    const { dirs } = await fixture();
    let reads = 0;
    const counting = (paths) => {
      reads += 1;
      return readLinks(paths);
    };
    const host = createModmgrHost({ modsRoot: dirs.desktop, stateFile: path.join(dirs.desktop, 'state.json'), shortcutDirs: dirs, readLinks: counting });
    const [a, b] = await Promise.all([host.shortcuts(), host.shortcuts()]);
    const c = await host.shortcuts();
    assert.equal(reads, 1);
    assert.equal(a, b);
    assert.equal(c, a);
    const changed = path.join(dirs.startMenu, 'OmO.lnk');
    const t = new Date(fs.statSync(changed).mtimeMs + 60000);
    fs.utimesSync(changed, t, t);
    await host.shortcuts();
    assert.equal(reads, 2);
  });

  it('a read that fails as a whole leaves each present row in its error state, the missing ones missing, and is not cached', async () => {
    const { dirs } = await fixture();
    let reads = 0;
    const broken = async () => {
      reads += 1;
      throw new Error('PowerShell did not finish');
    };
    const host = createModmgrHost({ modsRoot: dirs.desktop, stateFile: path.join(dirs.desktop, 'state.json'), shortcutDirs: dirs, readLinks: broken });
    const answer = await host.handle('shortcuts', []);
    assert.equal(answer.ok, true);
    assert.deepEqual(answer.shortcuts.map((r) => r.kind), ['other', 'other', 'other']);
    assert.match(answer.shortcuts[0].error, /^READ_FAILED: /);
    await host.shortcuts();
    assert.equal(reads, 2);
  });

  it('list answers at once while shortcuts is still reading', async () => {
    const { dirs } = await fixture();
    let release;
    const held = (paths) => new Promise((resolve) => {
      release = () => resolve(readLinks(paths));
    });
    const host = createModmgrHost({ modsRoot: dirs.desktop, stateFile: path.join(dirs.desktop, 'state.json'), shortcutDirs: dirs, readLinks: held });
    const pending = host.handle('shortcuts', []);
    assert.equal(host.handle('list', []).ok, true);
    release();
    assert.equal((await pending).ok, true);
  });

  it('builds the default locations from the account home, as tools/install.mjs does', () => {
    const d = defaultShortcutDirs('C:\\Users\\someone');
    assert.equal(d.desktop, path.join('C:\\Users\\someone', 'Desktop'));
    assert.match(d.startMenu, /AppData[\\/]Roaming[\\/]Microsoft[\\/]Windows[\\/]Start Menu[\\/]Programs$/);
    assert.match(d.taskbar, /Quick Launch[\\/]User Pinned[\\/]TaskBar$/);
    assert.equal(d.appDir, path.join('C:\\Users\\someone', 'AppData', 'Local', 'Programs', 'omo'));
  });
});
