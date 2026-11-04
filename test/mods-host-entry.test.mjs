// A mod folder that ships host.mjs must declare it as entry.host; otherwise the loader never loads the host and every
// bridge call fails with NO_HOST (the ko mod's config and translate calls did, in the real app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const modsRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mods');

test('every mod folder with host.mjs declares it as entry.host', () => {
  const offenders = fs.readdirSync(modsRoot)
    .filter((name) => fs.existsSync(path.join(modsRoot, name, 'host.mjs')))
    .filter((name) => JSON.parse(fs.readFileSync(path.join(modsRoot, name, 'mod.json'), 'utf8')).entry?.host !== 'host.mjs');
  assert.deepEqual(offenders, []);
});
