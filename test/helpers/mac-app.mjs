// Builds a fake OmO.app bundle with the files the fingerprint reads. Test-only: always under a temp folder.
import fs from 'node:fs';
import path from 'node:path';
import { makeAsar } from './asar.mjs';

export function makeMacBundle(bundle, { version = '9.9.9', clientHtml = '<html>a</html>', arch = process.arch } = {}) {
  const res = path.join(bundle, 'Contents', 'Resources');
  const runtime = path.join(res, 'omo-runtime', `darwin-${arch}`);
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(res, 'omo-server', 'client'), { recursive: true });
  fs.mkdirSync(path.join(runtime, 'plugin', 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(res, 'app.asar'), makeAsar({ 'package.json': Buffer.from(JSON.stringify({ version })) }));
  fs.writeFileSync(path.join(res, 'omo-server', 'client', 'index.html'), clientHtml);
  fs.writeFileSync(path.join(runtime, 'bundle-manifest.json'), JSON.stringify({ omoRef: 'v1', resolvedShas: { omo: 'abc' } }));
  fs.writeFileSync(path.join(runtime, 'plugin', 'extensions', 'omo.js'), 'plugin');
  return bundle;
}
