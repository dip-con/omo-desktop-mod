import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopRecordFor } from '../loader/stop-select.mjs';
import {
  isUnder,
  runWithLaunchedApp,
  selectStopTargets,
  assertNoOwnerProcess,
  confirmStopTarget,
  choosePort,
  classifyProbeResults,
} from '../loader/stop-select.mjs';

const APP_DIR = 'C:/Users/alice/AppData/Local/Programs/omo';
const LAUNCH = 1_000_000;

const proc = (pid, exePath, createdMs, ppid = 1) => ({
  pid,
  ppid,
  exePath,
  commandLine: `"${exePath}" --fake`,
  createdMs,
});

test('a pre-existing owner process is never selected', () => {
  const list = [
    proc(10, `${APP_DIR}/OmO.exe`, LAUNCH - 5000),
    proc(11, `${APP_DIR}/resources/omo-runtime/helper.exe`, LAUNCH + 10), // reused pid, same pid as pre-launch
  ];
  const picked = selectStopTargets(list, { launchTimeMs: LAUNCH, appDir: APP_DIR, preLaunchPids: [10, 11] });
  assert.deepEqual(picked, []);
});

test('a detached runtime supervisor child created after launch is selected', () => {
  const supervisor = proc(42, `${APP_DIR}/resources/omo-runtime/win32-x64/supervisor.exe`, LAUNCH + 800, 999);
  const picked = selectStopTargets([supervisor], { launchTimeMs: LAUNCH, appDir: APP_DIR, preLaunchPids: [] });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].pid, 42);
  assert.equal(picked[0].ppid, 999);
  assert.equal(picked[0].commandLine, supervisor.commandLine);
  assert.equal(picked[0].createdMs, LAUNCH + 800);
});

test('a process outside appDir is never selected', () => {
  const list = [proc(50, 'C:/Windows/System32/notepad.exe', LAUNCH + 1)];
  assert.deepEqual(selectStopTargets(list, { launchTimeMs: LAUNCH, appDir: APP_DIR, preLaunchPids: [] }), []);
});

test('a process created before launch is never selected', () => {
  const list = [proc(60, `${APP_DIR}/OmO.exe`, LAUNCH - 1)];
  assert.deepEqual(selectStopTargets(list, { launchTimeMs: LAUNCH, appDir: APP_DIR, preLaunchPids: [] }), []);
});

test('a sibling directory that starts with the appDir name is not matched', () => {
  assert.equal(isUnder(`${APP_DIR}-x/OmO.exe`, APP_DIR), false);
  assert.equal(isUnder(`${APP_DIR.toUpperCase()}\\OmO.exe`, APP_DIR), true);
  const list = [proc(70, `${APP_DIR}-x/tool.exe`, LAUNCH + 1)];
  assert.deepEqual(selectStopTargets(list, { launchTimeMs: LAUNCH, appDir: APP_DIR, preLaunchPids: [] }), []);
});

test('stopRecordFor: no fresh row means gone before stop, not a mismatch', () => {
  const planned = { pid: 7, exePath: 'C:/x/omo/app.exe', createdMs: 1 };
  assert.deepEqual(stopRecordFor(undefined, planned), { confirmed: false, goneBeforeStop: true });
});

test('stopRecordFor: a fresh row with a different creation time is a real mismatch', () => {
  const planned = { pid: 7, exePath: 'C:/x/omo/app.exe', createdMs: 1 };
  const fresh = { pid: 7, exePath: 'C:/x/omo/app.exe', createdMs: 2 };
  assert.deepEqual(stopRecordFor(fresh, planned), { confirmed: false, goneBeforeStop: false });
});

test('stopRecordFor: the same process is confirmed and not gone', () => {
  const planned = { pid: 7, exePath: 'C:/x/omo/app.exe', createdMs: 1 };
  assert.deepEqual(stopRecordFor({ ...planned }, planned), { confirmed: true, goneBeforeStop: false });
});

test('confirmStopTarget rejects a reused PID with a different creation time or path', () => {
  const planned = proc(80, `${APP_DIR}/helper.exe`, LAUNCH + 100);
  assert.equal(confirmStopTarget({ ...planned }, planned), true);
  assert.equal(confirmStopTarget({ ...planned, createdMs: LAUNCH + 999 }, planned), false);
  assert.equal(confirmStopTarget({ ...planned, exePath: 'C:/Other/helper.exe' }, planned), false);
  assert.equal(confirmStopTarget(null, planned), false);
});

test('assertNoOwnerProcess throws with exitCode 4 when an owner process exists before launch', () => {
  const owner = proc(90, `${APP_DIR}/OmO.exe`, LAUNCH - 9000);
  assert.throws(
    () => assertNoOwnerProcess([owner], { appDir: APP_DIR }),
    (err) => err.exitCode === 4 && err.processes.length === 1 && err.processes[0].pid === 90,
  );
  const other = proc(91, 'C:/Windows/System32/cmd.exe', LAUNCH - 9000);
  assert.doesNotThrow(() => assertNoOwnerProcess([other], { appDir: APP_DIR }));
  assert.doesNotThrow(() => assertNoOwnerProcess([], { appDir: APP_DIR }));
});

test('choosePort uses the happy-run port and rejects a different --port', () => {
  assert.equal(choosePort({ port: 12161 }, []), 12161);
  assert.equal(choosePort({ port: 12161 }, ['--port', '12161']), 12161);
  assert.throws(() => choosePort({ port: 12161 }, ['--port', '9999']), /differs/);
  assert.throws(() => choosePort(null, []), /no usable port/);
});

test('classifyProbeResults: all refused is true, a single open probe makes it false', () => {
  const refused = { ok: false, code: 'ECONNREFUSED' };
  assert.deepEqual(classifyProbeResults([refused, refused]), { allRefused: true, anyOpen: false });
  assert.deepEqual(classifyProbeResults([refused, { ok: true }, refused]), { allRefused: false, anyOpen: true });
  assert.deepEqual(classifyProbeResults([{ ok: false, code: 'ETIMEDOUT' }]), { allRefused: false, anyOpen: false });
  assert.deepEqual(classifyProbeResults([]), { allRefused: false, anyOpen: false });
});

test('runWithLaunchedApp: success stops once after body and returns the body result', async () => {
  const events = [];
  const result = await runWithLaunchedApp({
    launch: async () => { events.push('launch'); return { pid: 7 }; },
    stop: async (l) => { events.push(`stop:${l.pid}`); },
    body: async () => { events.push('body'); return 'ok'; },
  });
  assert.equal(result, 'ok');
  assert.deepEqual(events, ['launch', 'body', 'stop:7']);
});

test('runWithLaunchedApp: a body error stops once and the same error is rethrown', async () => {
  const boom = new Error('body failed');
  let stops = 0;
  await assert.rejects(
    runWithLaunchedApp({ launch: async () => ({}), stop: async () => { stops += 1; }, body: async () => { throw boom; } }),
    (e) => e === boom,
  );
  assert.equal(stops, 1);
});

test('runWithLaunchedApp: a launch error stops nothing and propagates', async () => {
  const boom = new Error('launch failed');
  let stops = 0;
  await assert.rejects(
    runWithLaunchedApp({ launch: async () => { throw boom; }, stop: async () => { stops += 1; }, body: async () => 'x' }),
    (e) => e === boom,
  );
  assert.equal(stops, 0);
});

test('runWithLaunchedApp: a stop error after an ok body propagates', async () => {
  const stopErr = new Error('stop failed');
  await assert.rejects(
    runWithLaunchedApp({ launch: async () => ({}), stop: async () => { throw stopErr; }, body: async () => 'x' }),
    (e) => e === stopErr,
  );
});

test('runWithLaunchedApp: when body and stop both fail, an AggregateError keeps both', async () => {
  const bodyErr = new Error('body failed');
  const stopErr = new Error('stop failed');
  await assert.rejects(
    runWithLaunchedApp({ launch: async () => ({}), stop: async () => { throw stopErr; }, body: async () => { throw bodyErr; } }),
    (e) => e instanceof AggregateError && e.errors[0] === bodyErr && e.errors[1] === stopErr,
  );
});

test('runWithLaunchedApp: the wrapper settles only after stop has finished', async () => {
  let stopped = false;
  await runWithLaunchedApp({
    launch: async () => ({}),
    stop: async () => { await Promise.resolve(); stopped = true; },
    body: async () => 'x',
  });
  assert.equal(stopped, true);
});
