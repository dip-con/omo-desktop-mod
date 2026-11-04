// Tests for the launch.vbs that tools/install.mjs writes (Windows Script Host only). The VBS is run with cscript on an
// install into a temp mods home whose baked OmO.exe is a temp fake-omo.cmd that writes a marker file. No real OmO starts.
// OMO_LAUNCH_NO_BOX suppresses the VBS message box; the box text is checked by the install output, not here.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INSTALLER = path.join(ROOT, 'tools', 'install.mjs');
const WIN_ONLY = process.platform === 'win32' ? false : 'Windows Script Host only';
const tempRoots = [];
after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omo-vbs-${name}-`));
  tempRoots.push(dir);
  return dir;
}

// Installs the repo's loader into a temp mods home with the temp fake app baked into launch.vbs.
function installWithFakeApp() {
  const root = tempDir('install');
  const home = path.join(root, 'app-mods');
  const app = path.join(root, 'fake-omo.cmd');
  fs.writeFileSync(app, '@echo off\r\necho started>>"%~dp0marker.txt"\r\n');
  const r = spawnSync(process.execPath, [INSTALLER, '--source-root', ROOT, '--mods-home', home, '--app-exe', app], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stderr);
  return {
    home,
    vbs: path.join(home, '_loader', 'launch.vbs'),
    boot: path.join(home, '_loader', 'boot.mjs'),
    bootArgs: path.join(home, '_loader', 'boot-args.json'),
    marker: path.join(root, 'marker.txt'),
    root,
  };
}

// Runs the generated VBS under cscript. The box is suppressed; everything else is the real script.
function runVbs(vbs, args = []) {
  return spawnSync('cscript.exe', ['//nologo', vbs, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, OMO_LAUNCH_NO_BOX: '1' },
  });
}

function rewriteNode(vbs, node) {
  const text = fs.readFileSync(vbs, 'utf8').replace(/^node = .*$/m, `node = "${node}"`);
  fs.writeFileSync(vbs, text);
}

// Resolves once the file exists. Subscribes to the directory before checking, so a write in between is not missed.
function awaitFile(file, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(path.dirname(file), () => {
      if (fs.existsSync(file)) finish(null);
    });
    const timer = setTimeout(() => finish(new Error(`${file} not written within ${timeoutMs} ms`)), timeoutMs);
    function finish(err) {
      clearTimeout(timer);
      watcher.close();
      if (err) reject(err);
      else resolve();
    }
    if (fs.existsSync(file)) finish(null);
  });
}

// A stub boot.mjs that records the arguments it was started with, so the VBS hand-off can be checked without a launch.
const STUB_BOOT = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import { fileURLToPath } from 'node:url';",
  "fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'boot-args.json'), JSON.stringify(process.argv.slice(2)));",
  '',
].join('\n');

test('the node launch line waits for nothing (wait argument False), so cscript never blocks on the helper', { skip: WIN_ONLY }, () => {
  const install = installWithFakeApp();
  const launchLine = fs.readFileSync(install.vbs, 'utf8').match(/^\s*sh\.Run .*& flags, 0, (True|False)\s*$/m);
  assert.ok(launchLine, 'the node launch line is present');
  assert.equal(launchLine[1], 'False');
});

test('the direct OmO start is chosen by the Err check after the node launch', { skip: WIN_ONLY }, () => {
  const install = installWithFakeApp();
  const text = fs.readFileSync(install.vbs, 'utf8');
  assert.match(text, /^\s*started = \(Err\.Number = 0\)\s*$/m);
  assert.match(text, /^\s*If started Then WScript\.Quit 0\s*$/m);
  assert.match(text, /^sh\.Run """" & app & """", 1, False\s*$/m);
});

test('a healthy launch leaves no wscript or cscript running from this VBS', { skip: WIN_ONLY }, async () => {
  const install = installWithFakeApp();
  fs.writeFileSync(install.boot, STUB_BOOT);
  const r = runVbs(install.vbs);
  assert.equal(r.status, 0, r.stderr);
  await awaitFile(install.bootArgs);
  const left = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='wscript.exe' OR Name='cscript.exe'" | Where-Object { $_.CommandLine -like '*${install.vbs}*' } | ForEach-Object { $_.ProcessId }`], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(left, '');
});

// The VBS does not wait for node, so the stub's output is awaited by its file, not by the cscript exit.
test('a healthy launch hands off to boot.mjs with the OmO path and no fallback start', { skip: WIN_ONLY }, async () => {
  const install = installWithFakeApp();
  fs.writeFileSync(install.boot, STUB_BOOT);
  const r = runVbs(install.vbs);
  assert.equal(r.status, 0, r.stderr);
  await awaitFile(install.bootArgs);
  assert.deepEqual(JSON.parse(fs.readFileSync(install.bootArgs, 'utf8')), [path.join(install.root, 'fake-omo.cmd')]);
  assert.equal(fs.existsSync(install.marker), false);
});

test('--safe reaches boot.mjs as an argument, and the VBS still starts nothing itself', { skip: WIN_ONLY }, async () => {
  const install = installWithFakeApp();
  fs.writeFileSync(install.boot, STUB_BOOT);
  const r = runVbs(install.vbs, ['--safe']);
  assert.equal(r.status, 0, r.stderr);
  await awaitFile(install.bootArgs);
  const args = JSON.parse(fs.readFileSync(install.bootArgs, 'utf8'));
  assert.equal(args[1], '--safe');
  assert.equal(fs.existsSync(install.marker), false);
});

test('a missing node.exe starts the baked OmO plain once and exits 20', { skip: WIN_ONLY }, async () => {
  const install = installWithFakeApp();
  rewriteNode(install.vbs, path.join(install.root, 'missing', 'node.exe'));
  const r = runVbs(install.vbs);
  assert.equal(r.status, 20, r.stderr);
  await awaitFile(install.marker);
  assert.equal(fs.readFileSync(install.marker, 'utf8').match(/started/g).length, 1);
});

test('a missing boot.mjs starts the baked OmO plain once and exits 20', { skip: WIN_ONLY }, async () => {
  const install = installWithFakeApp();
  fs.rmSync(install.boot);
  const r = runVbs(install.vbs);
  assert.equal(r.status, 20, r.stderr);
  await awaitFile(install.marker);
  assert.equal(fs.readFileSync(install.marker, 'utf8').match(/started/g).length, 1);
});

test('a node that cannot start (not an executable) starts the baked OmO plain once and exits 20', { skip: WIN_ONLY }, async () => {
  const install = installWithFakeApp();
  const bogus = path.join(install.root, 'bogus-node.exe');
  fs.writeFileSync(bogus, 'this is not a program');
  rewriteNode(install.vbs, bogus);
  const r = runVbs(install.vbs);
  assert.equal(r.status, 20, r.stderr);
  await awaitFile(install.marker);
  assert.equal(fs.readFileSync(install.marker, 'utf8').match(/started/g).length, 1);
});
