// Launch-log rotation: the prune keeps exactly the newest LOG_KEEP files of a temp state dir.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { LOG_KEEP, pruneLogs } from '../loader/deps.mjs';

test('prune keeps exactly the newest ten of twelve launch logs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-logs-'));
  try {
    const names = Array.from({ length: 12 }, (_, i) => `launch-2026-11-02T00-00-${String(i).padStart(2, '0')}-000Z.log`);
    for (const name of names) fs.writeFileSync(path.join(dir, name), '');
    pruneLogs(dir, LOG_KEEP);
    assert.equal(LOG_KEEP, 10);
    assert.deepEqual(fs.readdirSync(dir).sort(), names.slice(2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
