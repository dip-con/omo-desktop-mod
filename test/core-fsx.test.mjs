import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readJson, sha256Dir, writeJsonAtomic } from '../src/core/fsx.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'core-fsx-'));

test('readJson returns the fallback for missing and invalid files', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'bad.json'), '{nope');
  assert.deepEqual(readJson(path.join(d, 'missing.json'), { a: 1 }), { a: 1 });
  assert.equal(readJson(path.join(d, 'bad.json')), null);
});

test('writeJsonAtomic creates parents, round-trips and leaves no temp file', () => {
  const d = tmp();
  const file = path.join(d, 'a', 'b', 'x.json');
  writeJsonAtomic(file, { k: ['v'] });
  writeJsonAtomic(file, { k: ['w'] });
  assert.deepEqual(readJson(file), { k: ['w'] });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['x.json']);
});

test('sha256Dir ignores skipped names and depends on paths and contents', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'sub'));
  fs.writeFileSync(path.join(d, 'a.txt'), 'one');
  fs.writeFileSync(path.join(d, 'sub', 'b.txt'), 'two');
  const base = sha256Dir(d);
  for (const dir of ['node_modules', 'test', 'tests', '.git']) {
    fs.mkdirSync(path.join(d, dir));
    fs.writeFileSync(path.join(d, dir, 'z.txt'), 'ignored');
  }
  fs.writeFileSync(path.join(d, '.hidden'), 'ignored');
  assert.equal(sha256Dir(d), base);
  fs.writeFileSync(path.join(d, 'a.txt'), 'changed');
  assert.notEqual(sha256Dir(d), base);
  fs.writeFileSync(path.join(d, 'a.txt'), 'one');
  fs.renameSync(path.join(d, 'sub', 'b.txt'), path.join(d, 'sub', 'c.txt'));
  assert.notEqual(sha256Dir(d), base);
  fs.renameSync(path.join(d, 'sub', 'c.txt'), path.join(d, 'sub', 'b.txt'));
  assert.equal(sha256Dir(d, { skip: ['sub'] }), sha256Dir(d, { skip: ['sub'] }));
  assert.notEqual(sha256Dir(d, { skip: ['sub'] }), base);
});
