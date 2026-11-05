// Test helpers: temp trees, a fake GitHub (commit api + codeload tarballs built with the real tar), a fake OmO bundle.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const tempDir = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omo-mods-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return root;
}

export const modJson = (id, extra = {}) => ({
  id, name: id, version: '1.0.0', enabled: true, anchors: [{ selector: '#root', route: '*' }], entry: { page: 'page.js' }, ...extra,
});

// repos: {"owner/name": {sha, files}}. Returns {fetch, calls}; files can be swapped by mutating repos.
export function fakeGithub(scratch, repos) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const api = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/commits\/(.+)$/);
    const tar = url.match(/^https:\/\/codeload\.github\.com\/([^/]+\/[^/]+)\/tar\.gz\/(.+)$/);
    const repo = repos[(api ?? tar)?.[1]];
    if (!repo) return new Response('not found', { status: 404 });
    if (api) return new Response(`${repo.sha}\n`, { status: 200 });
    if (tar[2] !== repo.sha && tar[2] !== 'main') return new Response('no such ref', { status: 404 });
    const work = fs.mkdtempSync(path.join(scratch, 'tar-'));
    const top = `${tar[1].split('/')[1]}-${repo.sha}`;
    writeTree(path.join(work, top), repo.files);
    execFileSync('tar', ['-czf', path.join(work, 'out.tgz'), '-C', work, top]);
    return new Response(fs.readFileSync(path.join(work, 'out.tgz')), { status: 200 });
  };
  return { fetch, calls };
}

export const sha = (c) => c.repeat(40);

export function fakeApp(root) {
  return writeTree(path.join(root, 'OmO.app'), {
    'Contents/MacOS/OmO': '#!/bin/sh\n',
    'Contents/Resources/icon.icns': 'icns',
  });
}

// A loader repo with src/ and mods/modmgr, as install expects it.
export function loaderRepo(root, extra = {}) {
  return writeTree(path.join(root, 'loader-repo'), {
    'src/core/paths.mjs': 'export const x = 1;\n',
    'src/loader/launch.mjs': 'export const main = () => 0;\n',
    'src/update/update.mjs': 'export const check = () => null;\n',
    'src/test/skip.mjs': 'skipped\n',
    'mods/modmgr/mod.json': modJson('modmgr', { locked: true }),
    'mods/modmgr/page.js': '1;\n',
    ...extra,
  });
}
