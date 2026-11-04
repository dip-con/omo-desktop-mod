// The watchdog message box: one per target, however many watchdogs the target has.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notifyWatchdog } from '../loader/deps.mjs';

test('the watchdog message box shows once per target, across its watchdogs', () => {
  const boxes = [];
  const box = (text) => boxes.push(text);
  const shown = new Set();
  for (const ev of [
    { kind: 'watchdog', sessionId: 'S1', reloads: 1 },
    { kind: 'watchdog', sessionId: 'S1', reloads: 2 },
    { kind: 'watchdog-capped', sessionId: 'S1', reloads: 4 },
  ]) notifyWatchdog(ev, box, shown);
  notifyWatchdog({ kind: 'watchdog', sessionId: 'S2', reloads: 1 }, box, shown);
  assert.equal(boxes.length, 2);
});
