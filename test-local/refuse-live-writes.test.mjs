import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every probe is a NONEXISTENT child of a live path. A regressed guard can then only create a new file; it can
// never replace a real icon or a real file in the OMO home.
const HOME = os.userInfo().homedir;
const PROBE = '__guard_probe__';
const LIVE_PROBES = [
  path.join(HOME, '.omo', PROBE, 'probe.txt'),
  path.join(HOME, 'Desktop', 'OmO.lnk', 'probe.txt'),
  path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OmO.lnk', 'probe.txt'),
  path.join(HOME, 'AppData', 'Roaming', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'OmO.lnk', 'probe.txt'),
  path.join(HOME, 'Desktop', 'OmO (순정).lnk', 'probe.txt'),
];

for (const target of LIVE_PROBES) {
  test('a write to ' + target + ' is refused as a live-home write', () => {
    // Given: a nonexistent child of a live path
    // When: a test writes to it
    // Then: the guard refuses the write and nothing is created
    assert.throws(() => fs.writeFileSync(target, 'x'), { code: 'LIVE_HOME_WRITE_REFUSED' });
    assert.equal(fs.existsSync(target), false);
  });
}
