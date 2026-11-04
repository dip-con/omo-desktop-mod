import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('package manifest', () => {
  it('uses ESM module type', () => {
    assert.equal(pkg.type, 'module');
  });

  it('has no runtime dependencies', () => {
    assert.ok(!('dependencies' in pkg), 'dependencies key must be absent');
    assert.ok(!('devDependencies' in pkg), 'devDependencies key must be absent');
  });
});
