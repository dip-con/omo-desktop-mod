// Tests for loader/ports.mjs. Pure table checks: no sockets, no clock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isBlockedPort } from '../loader/ports.mjs';

test('isBlockedPort blocks the 6665-6669 range and 10080, which Node WebSocket and fetch refuse', () => {
  // Given: the ports named by the runtime check
  const blocked = [6665, 6666, 6667, 6668, 6669, 10080];
  // When / Then
  for (const port of blocked) assert.equal(isBlockedPort(port), true, `port ${port}`);
});

test('isBlockedPort allows the neighbours of the blocked range and an ephemeral port', () => {
  // Given: ports adjacent to the blocked range and one from the dynamic range
  const allowed = [6664, 6670, 49152];
  // When / Then
  for (const port of allowed) assert.equal(isBlockedPort(port), false, `port ${port}`);
});
