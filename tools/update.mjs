// Repository entry for the update check/apply of an installed mods home (default ~/.omo/app-mods).
// Same flags and JSON answer as <mods-home>/_loader/update.mjs: [--check] [--pull] [--mod <id>]... [--mods-home <dir>].
import os from 'node:os';
import path from 'node:path';
import { main } from '../loader/update.mjs';

process.exitCode = main(process.argv.slice(2), { modsHome: path.join(os.homedir(), '.omo', 'app-mods') });
