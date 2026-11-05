// Small file helpers: tolerant JSON read, atomic JSON write, deterministic directory hash.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALWAYS_SKIPPED = new Set(['node_modules', 'test', 'tests']);

// Parsed JSON, or fallback when the file is missing or not valid JSON.
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Writes next to the target and renames, so a reader never sees a half-written file.
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function listFiles(root, dir, skip, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(root, full, skip, out);
    else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

// sha256 over the sorted relative paths and contents. Dot names, node_modules, test and tests are skipped,
// plus any extra names in skip.
export function sha256Dir(dir, { skip = [] } = {}) {
  const skipped = new Set([...ALWAYS_SKIPPED, ...skip]);
  const hash = crypto.createHash('sha256');
  for (const rel of listFiles(dir, dir, skipped, []).sort()) {
    hash.update(`${rel}\0`);
    hash.update(fs.readFileSync(path.join(dir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
