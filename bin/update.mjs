#!/usr/bin/env node
// node bin/update.mjs [--check] [--mod <id>]... [--mods-home <dir>]
// Without --check the changed ids are applied. Prints JSON, exit 1 on any error.
import path from 'node:path';
import { modsHome } from '../src/core/paths.mjs';
import { apply, check } from '../src/update/update.mjs';

function parseArgs(argv) {
  const opts = { check: false, ids: [], modsHome: modsHome() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} 다음에 값이 필요해요`);
      return argv[i];
    };
    if (arg === '--check') opts.check = true;
    else if (arg === '--mod') opts.ids.push(value());
    else if (arg === '--mods-home') opts.modsHome = path.resolve(value());
    else throw new Error(`알 수 없는 옵션이에요: ${arg}`);
  }
  return opts;
}

let answer;
try {
  const opts = parseArgs(process.argv.slice(2));
  answer = opts.check ? await check(opts) : await apply(opts);
} catch (error) {
  answer = { ok: false, error: error.message };
}
console.log(JSON.stringify(answer, null, 2));
const failed = !answer.ok || (answer.items ?? []).some((item) => item.error) || (answer.errors ?? []).length > 0;
process.exitCode = failed ? 1 : 0;
