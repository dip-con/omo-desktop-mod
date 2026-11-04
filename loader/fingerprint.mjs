// Build fingerprint of the installed app, computed the same way as the app-facts probe (read-only).
// The app.asar header is read in memory: bytes 12-15 hold the header JSON length, bytes 16.. hold the JSON,
// and file data starts at 8 + UInt32LE(4).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
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

// { appVersion, client, runtime: {omoRef, omoSha}, plugin } for the install at appDir.
export function readFingerprint(appDir) {
  const pkg = JSON.parse(readAsarEntry(path.join(appDir, 'resources', 'app.asar'), 'package.json').toString('utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'resources', 'omo-runtime', 'win32-x64', 'bundle-manifest.json'), 'utf8'));
  return {
    appVersion: pkg.version,
    client: sha256Hex(fs.readFileSync(path.join(appDir, 'resources', 'omo-server', 'client', 'index.html'))),
    runtime: { omoRef: manifest.omoRef, omoSha: manifest.resolvedShas.omo },
    plugin: sha256Hex(fs.readFileSync(path.join(appDir, 'resources', 'omo-runtime', 'win32-x64', 'plugin', 'extensions', 'omo.js'))),
  };
}

// The key that mod.json testedBuilds lists: a hash of the four values in a fixed order.
export function buildKey(fp) {
  const canonical = JSON.stringify([fp.appVersion, fp.client, fp.runtime.omoRef, fp.runtime.omoSha, fp.plugin]);
  return sha256Hex(Buffer.from(canonical, 'utf8'));
}
