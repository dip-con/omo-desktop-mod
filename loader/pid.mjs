// Liveness of a pid. Signal 0 delivers nothing: it only asks whether the pid exists. The loader never sends a real
// signal. EPERM means the process exists but is not ours, so it counts as alive. kill is injectable for tests; the
// default can only ever send signal 0.
export function pidAlive(pid, kill = (p) => process.kill(p, 0)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
