// Build fingerprint of the installed app bundle, computed the same way as the app-facts probe (read-only).
// The app.asar header is read in memory: bytes 12-15 hold the header JSON length, bytes 16.. hold the JSON,
// and file data starts at 8 + UInt32LE(4).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// <bundle>/Contents/Resources: app.asar, omo-server and omo-runtime live here.
export function appResourcesDir(bundle) {
  return path.join(bundle, 'Contents', 'Resources');
}

// The omo-runtime/darwin-* folder of the bundle: darwin-<this arch> when it exists, else the first darwin-* one, else null.
export function runtimeDir(bundle) {
  const root = path.join(appResourcesDir(bundle), 'omo-runtime');
  const preferred = path.join(root, `darwin-${process.arch}`);
  if (fs.existsSync(preferred)) return preferred;
  try {
    const name = fs.readdirSync(root).sort().find((n) => n.startsWith('darwin-'));
    return name === undefined ? null : path.join(root, name);
  } catch {
    return null;
  }
}

// Reads one root-level entry of an asar archive without extracting anything.
export function readAsarEntry(asarPath, name) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const dataStart = 8 + head.readUInt32LE(4);
    const headerLen = head.readUInt32LE(12);
    const headerBuf = Buffer.alloc(headerLen);
    fs.readSync(fd, headerBuf, 0, headerLen, 16);
    const entry = JSON.parse(headerBuf.toString('utf8')).files[name];
    if (!entry || entry.files !== undefined) throw new Error(`${name} is not a file in ${path.basename(asarPath)}`);
    const data = Buffer.alloc(entry.size);
    fs.readSync(fd, data, 0, entry.size, dataStart + Number(entry.offset));
    return data;
  } finally {
    fs.closeSync(fd);
  }
}

// One part of the fingerprint: its value, or null when its file is missing or unreadable.
function part(read) {
  try {
    return read() ?? null;
  } catch {
    return null;
  }
}

// { appVersion, client, runtime: {omoRef, omoSha}, plugin } for the bundle. Never throws: a missing part is null.
export function readFingerprint(bundle) {
  const res = appResourcesDir(bundle);
  const runtime = runtimeDir(bundle);
  const manifest = runtime === null ? null : part(() => JSON.parse(fs.readFileSync(path.join(runtime, 'bundle-manifest.json'), 'utf8')));
  return {
    appVersion: part(() => JSON.parse(readAsarEntry(path.join(res, 'app.asar'), 'package.json').toString('utf8')).version),
    client: part(() => sha256Hex(fs.readFileSync(path.join(res, 'omo-server', 'client', 'index.html')))),
    runtime: { omoRef: part(() => manifest?.omoRef), omoSha: part(() => manifest?.resolvedShas?.omo) },
    plugin: runtime === null ? null : part(() => sha256Hex(fs.readFileSync(path.join(runtime, 'plugin', 'extensions', 'omo.js')))),
  };
}

// A hash of the five values in a fixed order. It names the build in state and reports; mods no longer depend on it.
export function buildKey(fp) {
  const canonical = JSON.stringify([fp.appVersion, fp.client, fp.runtime.omoRef, fp.runtime.omoSha, fp.plugin]);
  return sha256Hex(Buffer.from(canonical, 'utf8'));
}
