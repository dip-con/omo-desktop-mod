// Fixed locations: the app bundle, the mods folder and the loader state folder.
import os from 'node:os';
import path from 'node:path';

export const APP_BUNDLE = '/Applications/OmO.app';

export const appExe = (bundle = APP_BUNDLE) => path.join(bundle, 'Contents', 'MacOS', 'OmO');

export const appResources = (bundle = APP_BUNDLE) => path.join(bundle, 'Contents', 'Resources');

export const modsHome = (env = process.env) => env.OMO_MODS_HOME || path.join(os.homedir(), '.omo', 'app-mods');

export const stateDir = (env = process.env) =>
  env.LOADER_STATE_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'omo-app-mods');
