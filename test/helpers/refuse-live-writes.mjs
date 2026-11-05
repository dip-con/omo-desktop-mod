// Refuses filesystem writes into a live home. `npm test` loads it with --import, the QA scripts that start the board
// server import it first, and every Node child of a guarded process loads it through
// NODE_OPTIONS. Reads are never refused. There is no switch to turn it off.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const WIN = process.platform === 'win32';
const realpathNative = fs.realpathSync.native;
// Every <home>/.omo* folder is live. The prefix is assembled from parts so the name stays out of this file.
const OMO_PREFIX = '.' + 'omo';
// The OmO.lnk shortcuts (desktop, start menu, quick launch, and the 'OmO (순정)' ones) under each home. lnk.mjs writes
// them through PowerShell, which the fs guard cannot see; the spawn guard below refuses those too.
const LIVE_ICON_TAILS = [
  ['Desktop', 'OmO.lnk'],
  ['AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OmO.lnk'],
  ['AppData', 'Roaming', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'OmO.lnk'],
  ['Desktop', 'OmO (순정).lnk'],
  ['AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'OmO (순정).lnk'],
];

// Forward slashes, no trailing slash, and on Windows one case.
function slash(p) {
  const s = p.replace(/\\/g, '/').replace(/\/$/, '');
  return WIN ? s.toLowerCase() : s;
}

// The path as written (absolute, `..` resolved) and as it really is (links followed from the nearest existing
// ancestor). Both count: the live stable home holds junctions out to the bun store, and a temp folder can hold one in.
function forms(p) {
  const written = path.resolve(p);
  let cur = written;
  const rest = [];
  for (;;) {
    try {
      return [slash(written), slash(path.join(realpathNative(cur), ...rest.reverse()))];
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return [slash(written)];
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

// os.homedir() follows USERPROFILE; os.userInfo().homedir is the account's own profile folder, so a child started
// under a temp home still guards the real live homes.
const HOMES = new Set([os.homedir(), os.userInfo().homedir]);
const OMO_ROOTS = [...HOMES].flatMap((home) => forms(path.join(home, OMO_PREFIX)));
const LIVE_ICONS = [...HOMES].flatMap((home) => LIVE_ICON_TAILS.map((tail) => path.join(home, ...tail)));
// macOS: the installed app bundle and the loader's default state folder are live as well.
const MAC_LIVE = ['/Applications/OmO.app', ...[...HOMES].map((home) => path.join(home, 'Library', 'Application Support', 'omo-app-mods'))];
const LIVE_ROOTS = [...OMO_ROOTS, ...LIVE_ICONS.map(slash), ...MAC_LIVE.flatMap(forms)];

const within = (inner, outer) => inner === outer || inner.startsWith(outer + '/');

// Live = is, sits inside or contains a live home (the rule of Assert-FixtureRootIsSafe in capture.ps1).
// A form is under an OMO home when its first name under a home starts with the OMO prefix.
function underOmoHome(form) {
  return [...HOMES].some((home) => {
    const base = slash(home) + '/';
    return form.startsWith(base) && form.slice(base.length).split('/')[0].startsWith(OMO_PREFIX);
  });
}

function isLive(p) {
  return forms(p).some((form) => underOmoHome(form) || LIVE_ROOTS.some((root) => within(form, root) || within(root, form)));
}

function toPath(p) {
  if (p instanceof URL) return fileURLToPath(p);
  if (Buffer.isBuffer(p)) return p.toString();
  return String(p);
}

const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
// Missing flags, or the callback in their place, mean 'r'.
function opensForWrite(flags) {
  if (flags === undefined || flags === null || typeof flags === 'function') return false;
  if (typeof flags === 'number') return (flags & WRITE_FLAGS) !== 0;
  return !['r', 'rs', 'sr'].includes(String(flags));
}

// The paths each write call writes, read from its arguments. A hard link or a symlink is a later way in, so its
// existing side counts as well (a relative symlink target is relative to the link's folder).
const WRITTEN = {
  writeFile: (a) => [a[0]],
  appendFile: (a) => [a[0]],
  truncate: (a) => [a[0]],
  open: (a) => (opensForWrite(a[1]) ? [a[0]] : []),
  rename: (a) => [a[0], a[1]],
  copyFile: (a) => [a[1]],
  cp: (a) => [a[1]],
  rm: (a) => [a[0]],
  rmdir: (a) => [a[0]],
  unlink: (a) => [a[0]],
  mkdir: (a) => [a[0]],
  mkdtemp: (a) => [a[0]],
  mkdtempDisposable: (a) => [a[0]],
  link: (a) => [a[0], a[1]],
  symlink: (a) => [path.resolve(path.dirname(toPath(a[1])), toPath(a[0])), a[1]],
  utimes: (a) => [a[0]],
  lutimes: (a) => [a[0]],
  chmod: (a) => [a[0]],
  chown: (a) => [a[0]],
  lchown: (a) => [a[0]],
};

function refuse(p) {
  return Object.assign(new Error(`LIVE_HOME_WRITE_REFUSED: a test or QA script may not write under a live home: ${p}`),
    { code: 'LIVE_HOME_WRITE_REFUSED', path: p });
}

function gate(name, args) {
  for (const target of WRITTEN[name](args)) {
    // A number is a descriptor, opened through this gate.
    if (target === undefined || typeof target === 'number') continue;
    const p = toPath(target);
    if (isLive(p)) throw refuse(p);
  }
}

const guardSync = (name, real) => function (...args) {
  gate(name, args);
  return real.apply(this, args);
};

// A callback API reports its errors through the callback, on a later tick.
const guardCallback = (name, real) => function (...args) {
  try {
    gate(name, args);
  } catch (error) {
    const callback = args.at(-1);
    if (typeof callback !== 'function') throw error;
    process.nextTick(callback, error);
    return undefined;
  }
  return real.apply(this, args);
};

const guardPromise = (name, real) => async function (...args) {
  gate(name, args);
  return real.apply(this, args);
};

for (const name of Object.keys(WRITTEN)) {
  if (typeof fs[name] === 'function') fs[name] = guardCallback(name, fs[name]);
  if (typeof fs[`${name}Sync`] === 'function') fs[`${name}Sync`] = guardSync(name, fs[`${name}Sync`]);
  if (typeof fsp[name] === 'function') fsp[name] = guardPromise(name, fsp[name]);
}
fs.createWriteStream = guardSync('writeFile', fs.createWriteStream);
// lnk.mjs names each .lnk it writes in OMO_LNK_WRITE_PATHS on the spawn env; a spawn that names a live target is refused.
for (const name of ['spawn', 'spawnSync']) {
  const real = childProcess[name];
  childProcess[name] = function (file, args, options) {
    const opts = Array.isArray(args) ? options : args;
    const declared = opts?.env?.OMO_LNK_WRITE_PATHS;
    if (declared !== undefined) {
      for (const p of JSON.parse(declared)) if (isLive(p)) throw refuse(p);
    }
    return real.apply(this, arguments);
  };
}
syncBuiltinESMExports();

// A Node child inherits process.env, so it loads this guard as well, whatever its execArgv and cwd (the URL is
// absolute). A child given an env of its own without this NODE_OPTIONS is not guarded.
const IMPORT_SELF = `--import=${import.meta.url}`;
if (!(process.env.NODE_OPTIONS ?? '').includes(IMPORT_SELF)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${IMPORT_SELF}`.trim();
}
