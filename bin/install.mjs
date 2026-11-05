#!/usr/bin/env node
// node bin/install.mjs [--mod <spec>]... [--mods-home <dir>] [--apps-dir <dir>] [--app <bundle>] [--loader <spec>]
//                      [--dry-run] [--uninstall]
// <spec> is "github:<owner>/<repo>/<path>[#ref]" or a local folder. --loader names the loader repo (default: this
// checkout; install.sh passes github:dip-con/omo-desktop-mod#main). Prints a JSON summary, exit 1 on failure.
import os from 'node:os';
import path from 'node:path';
import { APP_BUNDLE, modsHome } from '../src/core/paths.mjs';
import { install, uninstall } from '../src/install/install.mjs';

function parseArgs(argv) {
  const opts = {
    mods: [], modsHome: modsHome(), appsDir: path.join(os.homedir(), 'Applications'), app: APP_BUNDLE,
    loader: undefined, dryRun: false, uninstall: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error(`${arg} 다음에 값이 필요해요`);
      return argv[i];
    };
    if (arg === '--mod') opts.mods.push(value());
    else if (arg === '--mods-home') opts.modsHome = path.resolve(value());
    else if (arg === '--apps-dir') opts.appsDir = path.resolve(value());
    else if (arg === '--app') opts.app = path.resolve(value());
    else if (arg === '--loader') opts.loader = value();
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--uninstall') opts.uninstall = true;
    else throw new Error(`알 수 없는 옵션이에요: ${arg}`);
  }
  return opts;
}

try {
  const opts = parseArgs(process.argv.slice(2));
  const result = opts.uninstall ? uninstall(opts) : await install(opts);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`OmO Mods 설치에 실패했어요: ${error.message}`);
  process.exitCode = 1;
}
