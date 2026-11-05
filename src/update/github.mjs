// GitHub access for installs and updates: the commit sha a ref points to, and a folder of a repo at a ref
// (codeload tarball extracted with the system tar). fetch is injectable so tests never touch the network.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const HEADERS = { 'User-Agent': 'omo-mods' };
const TIMEOUT_MS = 30_000;

export class GithubError extends Error {
  constructor(message, { repo, ref }) {
    super(`${repo}@${ref}: ${message}`);
    this.name = 'GithubError';
    this.repo = repo;
    this.ref = ref;
  }
}

async function get(url, { fetch, accept, repo, ref }) {
  const res = await fetch(url, { headers: { ...HEADERS, Accept: accept }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new GithubError(`HTTP ${res.status} from ${url}`, { repo, ref });
  return res;
}

// The 40-hex commit sha `ref` points to in `repo` ("owner/name").
export async function latestCommit({ repo, ref = 'main', fetch = globalThis.fetch }) {
  const url = `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`;
  const res = await get(url, { fetch, accept: 'application/vnd.github.sha', repo, ref });
  const sha = (await res.text()).trim();
  if (!SHA.test(sha)) throw new GithubError(`not a commit sha: ${sha.slice(0, 60)}`, { repo, ref });
  return sha;
}

// Downloads and extracts the repo tarball under tmpDir, returning the extracted repo root.
async function fetchRepo({ repo, ref, fetch, tmpDir }) {
  const res = await get(`https://codeload.github.com/${repo}/tar.gz/${encodeURIComponent(ref)}`, {
    fetch, accept: 'application/gzip', repo, ref,
  });
  const dir = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
  const tarball = path.join(dir, 'repo.tar.gz');
  fs.writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  const out = path.join(dir, 'x');
  fs.mkdirSync(out);
  await run('tar', ['-xzf', tarball, '-C', out], { timeout: TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C' } });
  const tops = fs.readdirSync(out, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (tops.length !== 1) throw new GithubError('tarball has no single top folder', { repo, ref });
  return path.join(out, tops[0].name);
}

// The folder `folder` of `repo` at `ref`, extracted under tmpDir (default: a new os temp dir the caller removes).
// `cache` (a Map) lets one caller reuse a downloaded repo for several folders of the same repo@ref.
export async function fetchTree({ repo, ref = 'main', path: folder = '', fetch = globalThis.fetch, tmpDir, cache }) {
  const key = `${repo}@${ref}`;
  const base = tmpDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'omo-mods-'));
  const pending = cache?.get(key) ?? fetchRepo({ repo, ref, fetch, tmpDir: base });
  cache?.set(key, pending);
  const root = await pending;
  const dir = path.join(root, folder);
  const inside = !path.relative(root, dir).startsWith('..') && !path.isAbsolute(path.relative(root, dir));
  if (!inside || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new GithubError(`folder not found: ${folder}`, { repo, ref });
  }
  return dir;
}
