// The "OmO Mods.app" launcher bundle that tools/install.mjs writes. It holds no loader code: its executable is a
// bash script that runs node on <mods-home>/_loader/boot.mjs with the OmO app bundle path and any arguments.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const LAUNCHER_NAME = 'OmO Mods.app';
export const BUNDLE_ID = 'kr.persnal.omo-mods';
export const EXECUTABLE = 'omo-mods';

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A bash double-quoted string: only \ " $ and ` are special inside it.
const bashQuote = (s) => `"${s.replace(/[\\"$`]/g, '\\$&')}"`;

export function infoPlist() {
  const entries = [
    ['CFBundleIdentifier', `<string>${BUNDLE_ID}</string>`],
    ['CFBundleName', '<string>OmO Mods</string>'],
    ['CFBundleDisplayName', '<string>OmO Mods</string>'],
    ['CFBundleExecutable', `<string>${EXECUTABLE}</string>`],
    ['CFBundleIconFile', '<string>icon</string>'],
    ['CFBundlePackageType', '<string>APPL</string>'],
    ['CFBundleInfoDictionaryVersion', '<string>6.0</string>'],
    ['CFBundleShortVersionString', '<string>1.0</string>'],
    ['CFBundleVersion', '<string>1</string>'],
    ['LSUIElement', '<true/>'],
  ];
  const body = entries.map(([k, v]) => `\t<key>${xml(k)}</key>\n\t${v}`).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

export function launcherScript({ node, modsHome, appBundle }) {
  const boot = path.join(modsHome, '_loader', 'boot.mjs');
  return '#!/bin/bash\n# Written by tools/install.mjs. Starts OmO through the mod loader.\n'
    + `exec ${bashQuote(node)} ${bashQuote(boot)} ${bashQuote(appBundle)} "$@"\n`;
}

// True when the folder is a launcher this installer wrote (its Info.plist names our bundle id).
export function isOurLauncher(app) {
  try {
    return fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8').includes(`<string>${BUNDLE_ID}</string>`);
  } catch {
    return false; // missing or unreadable: not ours
  }
}

// Builds the bundle in a staging folder next to `app`, then swaps it in. Returns warnings (codesign is best-effort).
export function writeLauncher({ app, node, modsHome, appBundle }) {
  const stage = path.join(path.dirname(app), `.${path.basename(app)}.staging-${process.pid}`);
  fs.rmSync(stage, { recursive: true, force: true });
  const contents = path.join(stage, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), infoPlist());
  const exe = path.join(contents, 'MacOS', EXECUTABLE);
  fs.writeFileSync(exe, launcherScript({ node, modsHome, appBundle }));
  fs.chmodSync(exe, 0o755);
  const icon = path.join(appBundle, 'Contents', 'Resources', 'icon.icns');
  if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(contents, 'Resources', 'icon.icns'));
  const warnings = [];
  try {
    execFileSync('codesign', ['--force', '--sign', '-', stage], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    warnings.push(`codesign failed (the launcher still works, Gatekeeper may ask once): ${err.message.split('\n')[0]}`);
  }
  fs.rmSync(app, { recursive: true, force: true });
  fs.renameSync(stage, app);
  return warnings;
}
