import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { APP_BUNDLE, appExe, appResources, modsHome, stateDir } from '../src/core/paths.mjs';

test('bundle paths derive from the bundle folder', () => {
  assert.equal(APP_BUNDLE, '/Applications/OmO.app');
  assert.equal(appExe('/x/OmO.app'), '/x/OmO.app/Contents/MacOS/OmO');
  assert.equal(appResources('/x/OmO.app'), '/x/OmO.app/Contents/Resources');
});

test('modsHome and stateDir prefer env, else home defaults', () => {
  assert.equal(modsHome({ OMO_MODS_HOME: '/m' }), '/m');
  assert.equal(stateDir({ LOADER_STATE_DIR: '/s' }), '/s');
  assert.equal(modsHome({}), path.join(os.homedir(), '.omo', 'app-mods'));
  assert.equal(stateDir({}), path.join(os.homedir(), 'Library', 'Application Support', 'omo-app-mods'));
});
