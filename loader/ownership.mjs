// Pure decisions for the owner check, the stale-lock check, and the exit/reattach rule. The OS calls (process list,
// start times, pid alive, clock) are passed in, so tests run on fakes. Nothing here kills a process.

// The port's owner must be the process the loader started, or a descendant of it (treeOf lists the children).
export function ownerAllowed({ ownerPid, spawnedPid, childrenOf }) {
  if (ownerPid === null || spawnedPid === null) return false;
  if (ownerPid === spawnedPid) return true;
  const stack = [...(childrenOf(spawnedPid) ?? [])];
  const seen = new Set();
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === ownerPid) return true;
    if (seen.has(pid)) continue;
    seen.add(pid);
    stack.push(...(childrenOf(pid) ?? []));
  }
  return false;
}

// A lock is stale when its owner pid is dead, or when the pid now belongs to a process that started after the lock
// was written (the pid was reused). A lock without a startedAt (legacy plain pid) is judged by liveness only.
export function lockIsStale({ lock, pidAlive, startTimeOf }) {
  if (!pidAlive(lock.pid)) return true;
  if (lock.startedAt === null) return false;
  const started = startTimeOf(lock.pid);
  return started !== null && started > lock.startedAt;
}

// Exit and reattach rule (times in ms). Exit: OmO is gone with its socket closed, or the socket is closed and the
// debug endpoint has failed for 10 s. Reattach: the socket is closed while OmO is alive (only a renderer died).
// The decision never includes a kill: the loader never closes OmO.
export function exitDecision({ now, wsClosed, versionFailingSince, omoAlive }) {
  if (!wsClosed) return 'keep';
  if (!omoAlive) return 'exit';
  if (versionFailingSince !== null && now - versionFailingSince >= 10000) return 'exit';
  return 'reattach';
}
