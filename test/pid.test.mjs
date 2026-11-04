// pidAlive with a fake kill: the test never signals a real pid.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pidAlive } from '../loader/pid.mjs';

function fakeKill(code) {
  const calls = [];
  const kill = (pid) => {
    calls.push(pid);
    if (code) throw Object.assign(new Error('fake kill'), { code });
  };
  return { kill, calls };
}

test('a pid that does not exist is not alive', () => {
  assert.equal(pidAlive(4242, fakeKill('ESRCH').kill), false);
});

test('a pid that exists but is not ours counts as alive', () => {
  assert.equal(pidAlive(4242, fakeKill('EPERM').kill), true);
});

test('a pid the probe reaches is alive, and the probe gets that pid', () => {
  const f = fakeKill(null);
  assert.equal(pidAlive(4242, f.kill), true);
  assert.deepEqual(f.calls, [4242]);
});

test('an unexpected probe error counts as gone', () => {
  assert.equal(pidAlive(4242, fakeKill('EINVAL').kill), false);
});

test('bad pid values are not alive and never reach the probe', () => {
  for (const bad of [0, -1, 1.5, '4242', null, undefined, NaN]) {
    const f = fakeKill(null);
    assert.equal(pidAlive(bad, f.kill), false);
    assert.deepEqual(f.calls, []);
  }
});
