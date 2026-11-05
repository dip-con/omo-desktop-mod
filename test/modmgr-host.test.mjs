// modmgr host on macOS: the state file default, the status text, and the update methods delegating to update.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createModmgrHost, defaultStateFile } from '../mods/modmgr/host.mjs';

const roots = [];
after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

const mod = (id, enabled) => ({
  id, name: id, nameKo: id, version: '1.0.0', enabled, order: 1, entry: { page: 'page.js' }, contributes: {},
  testedBuilds: [], anchors: [{ selector: '#root', route: '*' }],
});

// A mods root with one mod (installed from a source folder) and a loader state file that still carries UNKNOWN_BUILD.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omo-modmgr-host-'));
  roots.push(root);
  const modsRoot = path.join(root, 'mods');
  const source = path.join(root, 'src', 'demo');
  for (const dir of [path.join(modsRoot, 'demo'), source]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mod.json'), `${JSON.stringify(mod('demo', true), null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'page.js'), 'v1\n');
  }
  fs.mkdirSync(path.join(modsRoot, '_loader'));
  fs.writeFileSync(path.join(modsRoot, '_loader', 'install-manifest.json'), JSON.stringify({ sources: { demo: { repoRoot: path.join(root, 'src'), subdir: 'demo', remote: null, commit: null } } }));
  const stateFile = path.join(root, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ mods: [{ id: 'demo', attached: true, reason: 'UNKNOWN_BUILD' }] }));
  return { modsRoot, source, host: createModmgrHost({ modsRoot, stateFile }) };
}

describe('modmgr host (macOS)', () => {
  it('keeps the loader state under ~/Library/Application Support unless LOADER_STATE_DIR is set', () => {
    const saved = process.env.LOADER_STATE_DIR;
    try {
      delete process.env.LOADER_STATE_DIR;
      assert.equal(defaultStateFile(), path.join(os.homedir(), 'Library', 'Application Support', 'omo-app-mods', 'state.json'));
      process.env.LOADER_STATE_DIR = '/tmp/x';
      assert.equal(defaultStateFile(), path.join('/tmp/x', 'state.json'));
    } finally {
      if (saved === undefined) delete process.env.LOADER_STATE_DIR;
      else process.env.LOADER_STATE_DIR = saved;
    }
  });

  it('shows an attached mod as attached, with no build text, and no longer answers shortcuts', () => {
    const { host } = fixture();
    const answer = host.handle('list', []);
    assert.equal(answer.ok, true);
    assert.deepEqual(answer.mods.map((m) => [m.id, m.status, m.reasonKo]), [['demo', '붙음', '']]);
    assert.equal(host.handle('shortcuts', []).code, 'UNKNOWN_METHOD');
  });

  it('checkUpdates and applyUpdates go through update.mjs for its mods folder', async () => {
    const { modsRoot, source, host } = fixture();
    const unchanged = await host.handle('checkUpdates', []);
    assert.deepEqual(unchanged.items.map((i) => [i.id, i.changed, i.error]), [['demo', false, null]]);
    fs.writeFileSync(path.join(source, 'page.js'), 'v2\n');
    assert.equal((await host.handle('checkUpdates', [])).items[0].changed, true);
    const applied = await host.handle('applyUpdates', [{ ids: ['demo'], pull: false }]);
    assert.deepEqual(applied.applied, ['demo']);
    assert.equal(fs.readFileSync(path.join(modsRoot, 'demo', 'page.js'), 'utf8'), 'v2\n');
    assert.equal((await host.handle('applyUpdates', [{ ids: 'demo' }])).code, 'BAD_ARGS');
  });
});
