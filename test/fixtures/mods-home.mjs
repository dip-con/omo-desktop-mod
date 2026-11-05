// Builds a temp mods home with mod folders: writeMod(home, json, files) writes <home>/<id>/mod.json plus files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempDir(prefix = 'omo-mods-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function modJson(id, extra = {}) {
  return { id, name: id, nameKo: `${id} 모드`, version: '1.0.0', enabled: true, order: 10, entry: { page: 'page.js' }, anchors: [{ selector: '#root', route: '*' }], ...extra };
}

export function writeMod(home, json, files = { 'page.js': '' }, id = json.id) {
  const dir = path.join(home, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mod.json'), typeof json === 'string' ? json : JSON.stringify(json));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
