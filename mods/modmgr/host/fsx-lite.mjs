// sha256 and atomicWriteText for the mods host. A mod does not import another mod, so the copy lives here.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { basename, dirname, join } from 'node:path';

const RETRY_DELAYS_MS = [10, 20, 40, 80, 160];
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY']);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// Writes a temp file beside the target, fsyncs it, then renames it over the target. EPERM and EBUSY are retried.
// A failed write removes its temp file and leaves the target as it was.
export function atomicWriteText(file, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const temporary = join(dirname(file), `${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fs.openSync(temporary, 'wx');
    fs.writeSync(fd, bytes, 0, bytes.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  for (let retries = 0; ; retries += 1) {
    try {
      fs.renameSync(temporary, file);
      return;
    } catch (error) {
      if (!RETRYABLE_CODES.has(error?.code) || retries >= RETRY_DELAYS_MS.length) {
        fs.rmSync(temporary, { force: true });
        throw error;
      }
      sleepSync(RETRY_DELAYS_MS[retries]);
    }
  }
}
