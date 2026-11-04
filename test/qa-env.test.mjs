import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildQaEnv, checkQaEnv, spawnQaApp, describeQaEnv, PORT_VAR } from '../loader/qa-env.mjs';

test('exact-name drops: T3CODE_OMO_AGENT_DIR (non-lane value), the agent-dir names and OMO_PROFILE never reach the child env', () => {
  const parent = {
    PATH: 'C:\\Windows',
    KEEP: 'ok',
    T3CODE_OMO_AGENT_DIR: 'C:/Users/alice/elsewhere',
    OMO_CODING_AGENT_DIR: 'C:/x',
    SENPI_CODING_AGENT_DIR: 'C:/y',
    PI_CODING_AGENT_DIR: 'C:/z',
    OMO_PROFILE: 'work',
  };
  const env = buildQaEnv(parent, { osHome: OS_HOME });
  for (const k of ['T3CODE_OMO_AGENT_DIR', 'OMO_CODING_AGENT_DIR', 'SENPI_CODING_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'OMO_PROFILE']) {
    assert.equal(k in env, false, k);
  }
  assert.equal(env.KEEP, 'ok');
  assert.deepEqual(checkQaEnv(env, { osHome: OS_HOME }), []);
});

test('checkQaEnv flags T3CODE_OMO_AGENT_DIR when it is present with a non-lane value', () => {
  const env = { USERPROFILE: OS_HOME, HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\alice', T3CODE_OMO_AGENT_DIR: 'C:/Users/alice/elsewhere' };
  assert.deepEqual(checkQaEnv(env, { osHome: OS_HOME }), ['T3CODE_OMO_AGENT_DIR present']);
});

const OS_HOME = 'C:\\Users\\alice';
const LANE_HOME = 'C:\\Users\\alice\\.omo-lane\\home';
const LANE_PATH_ENTRY = 'C:\\Users\\alice\\.omo-lane\\home\\.herdr\\packages\\standalone\\releases\\x';
const harnessEnv = {
  HOME: LANE_HOME,
  USERPROFILE: LANE_HOME,
  HOMEDRIVE: 'C:',
  HOMEPATH: '\\Users\\alice\\.omo-lane\\home',
  OMO_BIN: 'C:/x/omo.exe',
  OMO_CODING_AGENT_DIR: `${LANE_HOME}\\.omo`,
  OMO_STABLE_AGENT: '1',
  HERDR_HOME: 'C:\\x',
  SENPI_X: '1',
  PI_CODING_AGENT_DIR: 'C:\\y',
  SOMETHING_ELSE: 'see C:/Users/alice/.OMO-LANE/home/x',
  PATH: 'C:\\Windows',
  KEEP: 'ok',
};

// The 24 names of the harness parent environment, with fake values. PATH carries one lane entry.
const HARNESS_24 = {
  OMO_BIN: 'C:/fake/omo.exe',
  OMO_CODING_AGENT_DIR: 'C:/fake/agent',
  OMO_STABLE_AGENT: '1',
  OMO_STABLE_HOME: 'C:/fake/home',
  OMO_STABLE_ROOT: 'C:/fake/root',
  OMO_OPENCODE_SDK_ROOT: 'C:/fake/opencode',
  OMO_CLAUDE_SDK_ROOT: 'C:/fake/claude',
  OMO_HERDR_STATE_DIR: 'C:/fake/herdr-state',
  OMO_HERDR_CONFIG_DIR: 'C:/fake/herdr-config',
  HERDR_HOME: 'C:/fake/herdr',
  HERDR_CONFIG_PATH: 'C:/fake/herdr.toml',
  SENPI_CODING_AGENT_DIR: 'C:/fake/senpi',
  PI_CODING_AGENT_DIR: 'C:/fake/pi',
  PI_GOAL_STORE_FILE: 'C:/fake/goals.json',
  PI_SESSION_FILE: 'C:/fake/session.jsonl',
  HOME: LANE_HOME,
  USERPROFILE: LANE_HOME,
  Path: `C:\\Windows\\system32;${LANE_PATH_ENTRY};C:\\Program Files\\nodejs`,
  APPDATA: 'C:\\Users\\alice\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
  TEMP: 'C:\\Users\\alice\\AppData\\Local\\Temp',
  TMP: 'C:\\Users\\alice\\AppData\\Local\\Temp',
  SystemRoot: 'C:\\Windows',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
};

test('a harness-like parent env is scrubbed and passes the check', () => {
  const env = buildQaEnv(harnessEnv, { osHome: OS_HOME });
  assert.deepEqual(checkQaEnv(env, { osHome: OS_HOME }), []);
  assert.equal(env.USERPROFILE, OS_HOME);
  assert.equal(env.HOMEDRIVE, 'C:');
  assert.equal(env.HOMEPATH, '\\Users\\alice');
  assert.equal(env.HOME, undefined);
  for (const k of ['OMO_BIN', 'OMO_CODING_AGENT_DIR', 'OMO_STABLE_AGENT', 'HERDR_HOME', 'SENPI_X', 'PI_CODING_AGENT_DIR', 'SOMETHING_ELSE']) {
    assert.equal(env[k], undefined, k);
  }
  assert.equal(env.PATH, 'C:\\Windows');
  assert.equal(env.KEEP, 'ok');
  assert.equal(env[PORT_VAR], undefined);
});

test('the port variable is added only for the happy run', () => {
  const env = buildQaEnv(harnessEnv, { osHome: OS_HOME, port: 12345 });
  assert.equal(env[PORT_VAR], '12345');
  assert.notDeepEqual(checkQaEnv(env, { osHome: OS_HOME, allowPort: false }), []);
  assert.deepEqual(checkQaEnv(env, { osHome: OS_HOME, allowPort: true }), []);
});

test('a final env that still carries HOME is reported', () => {
  const env = { ...buildQaEnv(harnessEnv, { osHome: OS_HOME }), HOME: LANE_HOME };
  assert.ok(checkQaEnv(env, { osHome: OS_HOME }).includes('HOME present'));
});

test('a forbidden name or a lane-pointing value in the final env is reported', () => {
  const env = { ...buildQaEnv(harnessEnv, { osHome: OS_HOME }), HERDR_STATE_DIR: 'C:\\x', ODD: 'C:/Users/alice/.omo-lane/y' };
  const problems = checkQaEnv(env, { osHome: OS_HOME });
  assert.ok(problems.includes('HERDR_STATE_DIR present'));
  assert.ok(problems.includes('ODD value mentions an .omo folder'));
});

test('a USERPROFILE that is not the OS home is reported', () => {
  const env = { ...buildQaEnv(harnessEnv, { osHome: OS_HOME }), USERPROFILE: LANE_HOME };
  assert.ok(checkQaEnv(env, { osHome: OS_HOME }).some((p) => p.startsWith('USERPROFILE=')));
});

test('PATH with one lane entry keeps the other entries in order and the key spelling', () => {
  const env = buildQaEnv({ Path: `C:\\A;${LANE_PATH_ENTRY};C:\\B;C:/C` }, { osHome: OS_HOME });
  assert.equal(env.Path, 'C:\\A;C:\\B;C:/C');
  assert.equal(env.PATH, undefined);
  assert.deepEqual(checkQaEnv(env, { osHome: OS_HOME }), []);
});

test('PATH that is entirely lane entries is removed', () => {
  const env = buildQaEnv({ PATH: `${LANE_PATH_ENTRY};C:/Users/alice/.OMO-LANE/bin` }, { osHome: OS_HOME });
  assert.equal(env.PATH, undefined);
  assert.equal(env.Path, undefined);
});

test('a final env whose PATH still has a lane entry is reported', () => {
  const env = { ...buildQaEnv(harnessEnv, { osHome: OS_HOME }), Path: `C:\\Windows;C:/Users/alice/.omo-lane/bin` };
  const problems = checkQaEnv(env, { osHome: OS_HOME });
  assert.deepEqual(problems, ['Path entry mentions an .omo folder']);
});

test('a non-PATH variable with a lane value is removed', () => {
  const env = buildQaEnv({ ODD2: 'x C:/Users/alice/.omo-lane/y', KEEP2: 'fine' }, { osHome: OS_HOME });
  assert.equal(env.ODD2, undefined);
  assert.equal(env.KEEP2, 'fine');
});

test('a 24-name harness parent env yields a PATH-bearing env that passes the check', () => {
  assert.equal(Object.keys(HARNESS_24).length, 24);
  const env = buildQaEnv(HARNESS_24, { osHome: OS_HOME });
  assert.deepEqual(checkQaEnv(env, { osHome: OS_HOME }), []);
  assert.equal(env.Path, `C:\\Windows\\system32;C:\\Program Files\\nodejs`);
  assert.equal(env.APPDATA, HARNESS_24.APPDATA);
  assert.equal(env.LOCALAPPDATA, HARNESS_24.LOCALAPPDATA);
  assert.equal(env.TEMP, HARNESS_24.TEMP);
  assert.equal(env.TMP, HARNESS_24.TMP);
  assert.equal(env.SystemRoot, HARNESS_24.SystemRoot);
  assert.equal(env.PATHEXT, HARNESS_24.PATHEXT);
  assert.equal(env.HOME, undefined);
  assert.equal(env.OMO_BIN, undefined);
});

const fakeSpawnRecorder = () => {
  const calls = [];
  const SENTINEL = { pid: 4242, tag: 'sentinel-child' };
  const spawnFn = (exe, args, options) => {
    calls.push({ exe, args, options });
    return SENTINEL;
  };
  return { calls, SENTINEL, spawnFn };
};

test('spawnQaApp hands the checked object to spawn and returns the child', () => {
  const { calls, SENTINEL, spawnFn } = fakeSpawnRecorder();
  const { child, env } = spawnQaApp(spawnFn, 'C:/fake/OmO.exe', { parentEnv: harnessEnv, osHome: OS_HOME });
  assert.equal(child, SENTINEL);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].exe, 'C:/fake/OmO.exe');
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[0].options.env, env);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.deepEqual(checkQaEnv(calls[0].options.env, { osHome: OS_HOME }), []);
});

test('spawnQaApp without a port spawns with no port variable', () => {
  const { calls, spawnFn } = fakeSpawnRecorder();
  spawnQaApp(spawnFn, 'C:/fake/OmO.exe', { parentEnv: harnessEnv, osHome: OS_HOME });
  assert.equal(calls[0].options.env[PORT_VAR], undefined);
});

test('spawnQaApp with a port spawns with the port variable only for that run', () => {
  const { calls, spawnFn } = fakeSpawnRecorder();
  spawnQaApp(spawnFn, 'C:/fake/OmO.exe', { parentEnv: harnessEnv, osHome: OS_HOME, port: 5555 });
  assert.equal(calls[0].options.env[PORT_VAR], '5555');
});

test('spawnQaApp refuses a lane osHome: exitCode 4, violation list, spawn not called', () => {
  const { calls, spawnFn } = fakeSpawnRecorder();
  assert.throws(
    () => spawnQaApp(spawnFn, 'C:/fake/OmO.exe', { parentEnv: harnessEnv, osHome: 'C:/Users/alice/.omo-lane/home' }),
    (err) => {
      assert.equal(err.exitCode, 4);
      assert.ok(err.violations.some((p) => p.includes('an .omo folder')));
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('spawnQaApp refuses a port with allowPort false: violation list, spawn not called', () => {
  const { calls, spawnFn } = fakeSpawnRecorder();
  assert.throws(
    () => spawnQaApp(spawnFn, 'C:/fake/OmO.exe', { parentEnv: harnessEnv, osHome: OS_HOME, port: 5555, allowPort: false }),
    (err) => {
      assert.equal(err.exitCode, 4);
      assert.ok(err.violations.includes(`${PORT_VAR} present without a happy-run flag`));
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('describeQaEnv: a clean child env has no dropped names and PATH present', () => {
  const d = describeQaEnv(buildQaEnv({ PATH: 'C:/bin', SystemRoot: 'C:/Windows' }, { osHome: OS_HOME, port: 9222 }));
  assert.deepEqual(d.droppedPresent, []);
  assert.equal(d.pathPresent, true);
  assert.equal(d.USERPROFILE, OS_HOME);
  assert.equal(d.portVar, '9222');
});

test('describeQaEnv: lists dropped variable names and never their values', () => {
  const env = { PATH: 'C:/bin', HOME: LANE_HOME, OMO_PROFILE: 'secret-token-1', SENPI_X: 'secret-token-2', STABLE: `${LANE_HOME}\\x` };
  const d = describeQaEnv(env);
  assert.deepEqual(d.droppedPresent, ['HOME', 'OMO_PROFILE', 'SENPI_X', 'STABLE']);
  const text = JSON.stringify(d);
  assert.ok(!text.includes('secret-token-1'));
  assert.ok(!text.includes('secret-token-2'));
});

test('describeQaEnv: a mixed-case Path key counts as PATH; no PATH key gives false', () => {
  assert.equal(describeQaEnv({ Path: 'C:/bin' }).pathPresent, true);
  assert.equal(describeQaEnv({ SystemRoot: 'C:/Windows' }).pathPresent, false);
});
