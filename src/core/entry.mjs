// True when the module is the script node was started with. Both sides go through realpath because
// macOS temp dirs are symlinks (/var -> /private/var).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isEntry(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(fileURLToPath(importMetaUrl)) === fs.realpathSync(argv1);
  } catch {
    return false;
  }
}
