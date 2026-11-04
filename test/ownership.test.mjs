// Tests for loader/ownership.mjs on fake process tables and a fake clock. No sleeps, no OS calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exitDecision, lockIsStale, ownerAllowed } from '../loader/ownership.mjs';

// childrenOf for a fake tree: 100 -> [200, 300], 200 -> [400]; 900 is unrelated.
const childrenOf = (pid) => ({ 100: [200, 300], 200: [400] })[pid] ?? [];

test('the port owner is the spawned process or one of its descendants', () => {
  assert.equal(ownerAllowed({ ownerPid: 100, spawnedPid: 100, childrenOf }), true);
  assert.equal(ownerAllowed({ ownerPid: 400, spawnedPid: 100, childrenOf }), true);
});

test('any other OmO process is not the owner', () => {
  assert.equal(ownerAllowed({ ownerPid: 900, spawnedPid: 100, childrenOf }), false);
  assert.equal(ownerAllowed({ ownerPid: null, spawnedPid: 100, childrenOf }), false);
});

test('a stale lock whose pid was reused by a later process is stale; a live owner is not', () => {
  const lock = { pid: 5151, startedAt: 1000 };
  // The pid is alive but its process started after the lock was written: reused.
  assert.equal(lockIsStale({ lock, pidAlive: () => true, startTimeOf: () => 2000 }), true);
  // The same process started before the lock: a live owner.
  assert.equal(lockIsStale({ lock, pidAlive: () => true, startTimeOf: () => 500 }), false);
  // Dead pid: stale.
  assert.equal(lockIsStale({ lock, pidAlive: () => false, startTimeOf: () => 500 }), true);
});

test('a legacy lock with no start time is judged by liveness only', () => {
  assert.equal(lockIsStale({ lock: { pid: 7, startedAt: null }, pidAlive: () => true, startTimeOf: () => 9e15 }), false);
});

test('exit rule: OmO gone and socket closed exits at once', () => {
  assert.equal(exitDecision({ now: 0, wsClosed: true, versionFailingSince: null, omoAlive: false }), 'exit');
});

test('exit rule: socket closed and the endpoint failing for 10 s exits; 9.9 s does not', () => {
  assert.equal(exitDecision({ now: 10000, wsClosed: true, versionFailingSince: 0, omoAlive: true }), 'exit');
  assert.equal(exitDecision({ now: 9900, wsClosed: true, versionFailingSince: 0, omoAlive: true }), 'reattach');
});

test('renderer-only death: socket closed while OmO is alive reattaches, and nothing kills', () => {
  assert.equal(exitDecision({ now: 1000, wsClosed: true, versionFailingSince: null, omoAlive: true }), 'reattach');
  assert.equal(exitDecision({ now: 1000, wsClosed: false, versionFailingSince: null, omoAlive: true }), 'keep');
});
