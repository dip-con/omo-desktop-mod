// TCP ports that Node's built-in WebSocket and fetch refuse (the Fetch standard's "bad ports" list). A connection to one
// of them fails with 'bad port' before any packet is sent, so the debug port must never be one of them.
// Runtime-verified on Node v24.19.0: every listed port that could be bound refused the connection (local runtime check).
export const BLOCKED_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111,
  113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548,
  554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665,
  6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

export function isBlockedPort(port) {
  return BLOCKED_PORTS.has(port);
}
