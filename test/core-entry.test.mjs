import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { isEntry } from '../src/core/entry.mjs';

const entryUrl = pathToFileURL(path.resolve('src/core/entry.mjs')).href;

test('isEntry is true when argv[1] is a symlinked path to the module, false otherwise', () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'core-entry-')));
  const real = path.join(d, 'real.mjs');
  const link = path.join(d, 'link.mjs');
  fs.writeFileSync(real, `import { isEntry } from ${JSON.stringify(entryUrl)};\nconsole.log(isEntry(import.meta.url));\n`);
  fs.symlinkSync(real, link);
  assert.equal(execFileSync(process.execPath, [link], { encoding: 'utf8' }).trim(), 'true');
  assert.equal(isEntry(pathToFileURL(real).href, path.join(d, 'other.mjs')), false);
  assert.equal(isEntry(pathToFileURL(real).href, undefined), false);
});
