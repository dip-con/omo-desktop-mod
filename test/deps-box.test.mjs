// The watchdog box is keyed by target, not by the reload number: a target whose first watchdog reports reloads 2 still gets its box.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notifyWatchdog } from '../loader/deps.mjs';

test('a target whose first watchdog reports a later reload number still gets exactly one box', () => {
  const boxes = [];
  const shown = new Set();
  const box = (t) => boxes.push(t);
  notifyWatchdog({ kind: 'watchdog', sessionId: 'Q1', reloads: 2 }, box, shown);
  notifyWatchdog({ kind: 'watchdog', sessionId: 'Q1', reloads: 3 }, box, shown);
  assert.equal(boxes.length, 1);
});
