import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fetchTree, latestCommit } from '../src/update/github.mjs';
import { fakeGithub, sha, tempDir } from './fixtures-update/fake.mjs';

test('latestCommit returns the sha the ref points to', async (t) => {
  const gh = fakeGithub(tempDir(t), { 'o/r': { sha: sha('a'), files: {} } });
  assert.equal(await latestCommit({ repo: 'o/r', ref: 'main', fetch: gh.fetch }), sha('a'));
  assert.equal(gh.calls[0], 'https://api.github.com/repos/o/r/commits/main');
});

test('latestCommit rejects HTTP errors and non-sha bodies', async () => {
  await assert.rejects(latestCommit({ repo: 'o/r', fetch: async () => new Response('x', { status: 403 }) }), /HTTP 403/);
  await assert.rejects(latestCommit({ repo: 'o/r', fetch: async () => new Response('<html>') }), /not a commit sha/);
});

test('fetchTree extracts one folder and reuses a cached download', async (t) => {
  const dir = tempDir(t);
  const gh = fakeGithub(dir, { 'o/r': { sha: sha('b'), files: { 'mods/x/mod.json': '{}', 'mods/y/a.txt': 'y' } } });
  const cache = new Map();
  const x = await fetchTree({ repo: 'o/r', ref: sha('b'), path: 'mods/x', fetch: gh.fetch, tmpDir: dir, cache });
  const y = await fetchTree({ repo: 'o/r', ref: sha('b'), path: 'mods/y', fetch: gh.fetch, tmpDir: dir, cache });
  assert.deepEqual(fs.readdirSync(x), ['mod.json']);
  assert.equal(fs.readFileSync(path.join(y, 'a.txt'), 'utf8'), 'y');
  assert.equal(gh.calls.length, 1);
});

test('fetchTree refuses missing and escaping folders', async (t) => {
  const dir = tempDir(t);
  const gh = fakeGithub(dir, { 'o/r': { sha: sha('c'), files: { 'a.txt': 'a' } } });
  await assert.rejects(fetchTree({ repo: 'o/r', ref: sha('c'), path: 'nope', fetch: gh.fetch, tmpDir: dir }), /folder not found/);
  await assert.rejects(fetchTree({ repo: 'o/r', ref: sha('c'), path: '../..', fetch: gh.fetch, tmpDir: dir }), /folder not found/);
});
