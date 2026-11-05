// Facts about an installed OmO.app bundle. Read only; every field is null when it cannot be read.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { appResources } from './paths.mjs';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Null instead of throwing.
function attempt(read) {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
}

function plistVersion(plist) {
  const text = fs.readFileSync(plist, 'utf8');
  const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
  if (m) return m[1];
  return execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, LC_ALL: 'C' },
  }).trim();
}

// omo-runtime/darwin-<arch> when present, else the first darwin-* folder.
function runtimeDir(resources) {
  const root = path.join(resources, 'omo-runtime');
  const preferred = path.join(root, `darwin-${process.arch}`);
  if (fs.existsSync(preferred)) return preferred;
  const name = fs.readdirSync(root).sort().find((n) => n.startsWith('darwin-'));
  return name ? path.join(root, name) : null;
}

export function appInfo(bundle) {
  const resources = appResources(bundle);
  const runtime = attempt(() => runtimeDir(resources));
  const manifest = runtime && attempt(() => JSON.parse(fs.readFileSync(path.join(runtime, 'bundle-manifest.json'), 'utf8')));
  return {
    version: attempt(() => plistVersion(path.join(bundle, 'Contents', 'Info.plist'))),
    client: attempt(() => sha256(fs.readFileSync(path.join(resources, 'omo-server', 'client', 'index.html')))),
    runtime: { ref: manifest?.omoRef ?? null, sha: manifest?.resolvedShas?.omo ?? null },
    plugin: runtime && attempt(() => sha256(fs.readFileSync(path.join(runtime, 'plugin', 'extensions', 'omo.js')))),
  };
}
