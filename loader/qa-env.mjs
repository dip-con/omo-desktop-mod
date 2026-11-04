// Environment for a QA launch of the OmO desktop app. The app and its bundled plugin read HOME before
// os.homedir(), so the launched process must not inherit the owner's terminal lane (HOME, OMO_*,
// HERDR_*, or any value that points into a live app home). buildQaEnv builds the object;
// checkQaEnv inspects the exact object that is handed to child_process.spawn. PATH is the one
// variable that is filtered entry by entry, so the app keeps a realistic PATH.
export const PORT_VAR = 'OMO_DESKTOP_REMOTE_DEBUGGING_PORT';
const FORBIDDEN_PREFIXES = ['OMO_', 'SENPI_', 'PI_', 'HERDR_'];
// Agent-dir names and OMO_PROFILE do not follow the prefix rule (T3CODE_OMO_AGENT_DIR), so they are listed by exact name.
const EXACT_NAMES = ['OMO_CODING_AGENT_DIR', 'SENPI_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'T3CODE_OMO_AGENT_DIR', 'OMO_PROFILE'];
// Any path segment that starts with the OMO prefix: the live-home rule shared with test/helpers/refuse-live-writes.mjs.
const LANE_HOME = new RegExp('[\\\\/]\\.' + 'omo', 'i');
const HOME_KEYS = ['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH'];

const upper = (k) => k.toUpperCase();
const isForbiddenName = (k) => FORBIDDEN_PREFIXES.some((p) => upper(k).startsWith(p)) || EXACT_NAMES.includes(upper(k));
const isLaneValue = (v) => typeof v === 'string' && LANE_HOME.test(v);
const isPathKey = (k) => upper(k) === 'PATH';
const isLaneEntry = (entry) => LANE_HOME.test(entry);

export function buildQaEnv(parentEnv, { osHome, port = null } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (HOME_KEYS.includes(upper(k)) || isForbiddenName(k)) continue;
    if (isPathKey(k)) {
      const kept = v.split(';').filter((entry) => !isLaneEntry(entry)).join(';');
      if (kept !== '') env[k] = kept;
      continue;
    }
    if (isLaneValue(v)) continue;
    env[k] = v;
  }
  env.USERPROFILE = osHome;
  env.HOMEDRIVE = osHome.slice(0, 2);
  env.HOMEPATH = osHome.slice(2);
  if (port) env[PORT_VAR] = String(port);
  return env;
}

// Returns a list of violations; an empty list means the object may be spawned.
export function checkQaEnv(env, { osHome, allowPort = false } = {}) {
  const problems = [];
  if (env.USERPROFILE !== osHome) problems.push(`USERPROFILE=${env.USERPROFILE} != ${osHome}`);
  for (const k of Object.keys(env)) {
    if (upper(k) === 'HOME') problems.push('HOME present');
    else if (isForbiddenName(k) && !(k === PORT_VAR && allowPort)) problems.push(`${k} present`);
    if (isPathKey(k)) {
      for (const entry of String(env[k]).split(';')) {
        if (isLaneEntry(entry)) problems.push(`${k} entry mentions an .omo folder`);
      }
    } else if (isLaneValue(env[k])) {
      problems.push(`${k} value mentions an .omo folder`);
    }
  }
  if (!allowPort && env[PORT_VAR] !== undefined) problems.push(`${PORT_VAR} present without a happy-run flag`);
  return problems;
}

// Pure record of an env for fixtures: the path and port fields, PATH presence, the NAMES buildQaEnv/checkQaEnv would drop or reject, and a key count. No other values.
const isDroppedName = (k, v) =>
  k !== PORT_VAR &&
  (upper(k) === 'HOME' || isForbiddenName(k) || (isPathKey(k) ? String(v).split(';').some(isLaneEntry) : isLaneValue(v)));

export function describeQaEnv(env) {
  return {
    USERPROFILE: env.USERPROFILE ?? null,
    HOME: env.HOME ?? null,
    HOMEDRIVE: env.HOMEDRIVE ?? null,
    HOMEPATH: env.HOMEPATH ?? null,
    portVar: env[PORT_VAR] ?? null,
    pathPresent: Object.keys(env).some(isPathKey),
    droppedPresent: Object.keys(env).filter((k) => isDroppedName(k, env[k])).sort(),
    envKeyCount: Object.keys(env).length,
  };
}

// Builds the QA env, checks that exact object, and spawns the app with it. A failing check throws
// an Error with exitCode 4 and the violation list; spawnFn is not called in that case.
export function spawnQaApp(spawnFn, exe, { parentEnv, osHome, port = null, allowPort = port !== null }) {
  const env = buildQaEnv(parentEnv, { osHome, port });
  const violations = checkQaEnv(env, { osHome, allowPort });
  if (violations.length > 0) {
    const err = new Error(`QA environment check failed: ${violations.join('; ')}`);
    err.exitCode = 4;
    err.violations = violations;
    throw err;
  }
  const child = spawnFn(exe, [], { env, detached: true, stdio: 'ignore' });
  return { child, env };
}
