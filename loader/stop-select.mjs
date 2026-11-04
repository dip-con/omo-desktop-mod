// Pure selection logic for the QA app probe. No I/O here: callers pass process records
// ({ pid, ppid, exePath, commandLine, createdMs }) and get decisions back, so tests use fake lists.

const normPath = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// True only when exePath is inside appDir; the trailing separator keeps 'omo-x' out of 'omo'.
export function isUnder(exePath, appDir) {
  if (!exePath) return false;
  return normPath(exePath).startsWith(normPath(appDir) + '/');
}

const baseName = (p) => normPath(p).split('/').pop();

// A process is selected only if it runs from appDir, was created at or after launch, and was not
// running before launch (by pid).
export function selectStopTargets(procList, { launchTimeMs, appDir, preLaunchPids = [] }) {
  const pre = new Set(preLaunchPids);
  return procList
    .filter((p) => isUnder(p.exePath, appDir))
    .filter((p) => p.createdMs >= launchTimeMs)
    .filter((p) => !pre.has(p.pid))
    .map((p) => ({ ...p }));
}

// Throws (exitCode 4) when an owner app is already running before launch: a process under appDir or
// any process whose executable is named OmO.exe.
export function assertNoOwnerProcess(preLaunchList, { appDir }) {
  const owners = preLaunchList.filter((p) => isUnder(p.exePath, appDir) || baseName(p.exePath) === 'omo.exe');
  if (owners.length > 0) {
    const err = new Error(`owner app already running before launch: ${owners.map((p) => p.pid).join(', ')}`);
    err.exitCode = 4;
    err.processes = owners;
    throw err;
  }
}

// Re-checks a planned target against a fresh query right before stopping; a reused PID fails here.
// Stop record for one planned target. No fresh row means the process had already exited (gone before stop);
// a fresh row that does not match is a real identity mismatch and stays unconfirmed.
export function stopRecordFor(freshRecord, plannedRecord) {
  if (!freshRecord) return { confirmed: false, goneBeforeStop: true };
  return { confirmed: confirmStopTarget(freshRecord, plannedRecord), goneBeforeStop: false };
}

export function confirmStopTarget(freshRecord, plannedRecord) {
  if (!freshRecord) return false;
  return (
    freshRecord.pid === plannedRecord.pid &&
    normPath(freshRecord.exePath) === normPath(plannedRecord.exePath) &&
    freshRecord.createdMs === plannedRecord.createdMs
  );
}

// The negative run uses the same port as the happy run. --port must agree with the happy record.
export function choosePort(happyRecord, argv = []) {
  const i = argv.indexOf('--port');
  const argPort = i >= 0 ? Number(argv[i + 1]) : null;
  const happyPort = happyRecord?.port ?? null;
  if (argPort !== null && happyPort !== null && argPort !== happyPort) {
    throw new Error(`--port ${argPort} differs from the happy-run port ${happyPort}`);
  }
  const port = argPort ?? happyPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('no usable port: pass --port or run the happy run first');
  }
  return port;
}

// launch() failing stops nothing. Otherwise stop(launched) runs exactly once after body settles; if body and stop both
// throw, an AggregateError keeps both errors.
export async function runWithLaunchedApp({ launch, stop, body }) {
  const launched = await launch();
  let result;
  try {
    result = await body(launched);
  } catch (bodyErr) {
    try {
      await stop(launched);
    } catch (stopErr) {
      throw new AggregateError([bodyErr, stopErr], 'body and stop both failed');
    }
    throw bodyErr;
  }
  await stop(launched);
  return result;
}

const isRefused = (r) => !r.ok && r.code === 'ECONNREFUSED';

// results: [{ ok, code }] from repeated /json/version probes against the negative port.
export function classifyProbeResults(results) {
  return {
    allRefused: results.length > 0 && results.every(isRefused),
    anyOpen: results.some((r) => r.ok),
  };
}
