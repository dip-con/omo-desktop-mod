// "OmO Mods.app": a tiny bundle whose executable is a bash script running node on the installed loader.
// It holds no loader code. Built in a staging folder next to the target, then swapped in.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { appResources } from '../core/paths.mjs';

const run = promisify(execFile);
export const LAUNCHER_NAME = 'OmO Mods.app';
export const BUNDLE_ID = 'kr.dipcon.omo-mods';
const EXECUTABLE = 'omo-mods';

export const launcherPath = (appsDir) => path.join(appsDir, LAUNCHER_NAME);

const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Inside bash double quotes only \ " $ and ` are special.
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
    ['CFBundleShortVersionString', '<string>2.0</string>'],
    ['CFBundleVersion', '<string>2</string>'],
    ['LSUIElement', '<true/>'],
  ];
  const body = entries.map(([k, v]) => `\t<key>${xml(k)}</key>\n\t${v}`).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + `<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

export function launcherScript({ node, modsHome }) {
  const launch = path.join(modsHome, '_loader', 'loader', 'launch.mjs');
  return `#!/bin/bash\n# Written by the OmO Mods installer.\nexec ${bashQuote(node)} ${bashQuote(launch)} "$@"\n`;
}

// True when the bundle is one this installer wrote (its Info.plist names our bundle id).
export function isOurLauncher(app) {
  try {
    return fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8').includes(`<string>${BUNDLE_ID}</string>`);
  } catch {
    return false; // missing or unreadable: not ours
  }
}

function appIcon(bundle) {
  const dir = appResources(bundle);
  if (fs.existsSync(path.join(dir, 'icon.icns'))) return path.join(dir, 'icon.icns');
  const any = fs.existsSync(dir) ? fs.readdirSync(dir).find((name) => name.endsWith('.icns')) : undefined;
  return any ? path.join(dir, any) : null;
}

// Writes appsDir/OmO Mods.app. Returns warnings (missing icon, failed ad-hoc codesign).
export async function writeLauncher({ appsDir, node, modsHome, app }) {
  const target = launcherPath(appsDir);
  const stage = path.join(appsDir, `.${LAUNCHER_NAME}.staging-${process.pid}`);
  const warnings = [];
  fs.rmSync(stage, { recursive: true, force: true });
  const contents = path.join(stage, 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(contents, 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(contents, 'Info.plist'), infoPlist());
  const exe = path.join(contents, 'MacOS', EXECUTABLE);
  fs.writeFileSync(exe, launcherScript({ node, modsHome }));
  fs.chmodSync(exe, 0o755);
  const icon = appIcon(app);
  if (icon) fs.copyFileSync(icon, path.join(contents, 'Resources', 'icon.icns'));
  else warnings.push(`OmO 아이콘을 찾지 못했어요: ${appResources(app)}`);
  try {
    await run('codesign', ['--force', '--sign', '-', stage], { timeout: 30_000, env: { ...process.env, LC_ALL: 'C' } });
  } catch (error) {
    warnings.push(`codesign에 실패했어요(실행에는 문제없어요): ${String(error.message).split('\n')[0]}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(stage, target);
  return warnings;
}
