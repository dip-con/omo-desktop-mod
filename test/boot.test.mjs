// Tests for loader/boot.mjs failOpen, the fallback that runs when launch.mjs cannot start. Every effect is a fake.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOX_TITLE as bootBoxTitle, failOpen, PLAIN_START_TEXT as bootPlainStartText } from '../loader/boot.mjs';
import { PORT_VAR } from '../loader/launch.mjs';
import { BOX_TITLE, PLAIN_START_TEXT } from '../loader/messages.mjs';

test('the fallback starts OmO plain once, with no arguments and without the debug-port variable, and exits 20', async () => {
  const spawned = [];
  const boxes = [];
  const env = { PATH: 'C:\\Windows', [PORT_VAR]: '41234', OMO_PROFILE: 'work' };
  const code = await failOpen('C:/app/OmO.exe', {
    env,
    spawn: (exe, args, opts) => {
      spawned.push({ exe, args, opts });
      return { on() {}, unref() {} };
    },
    messageBox: () => boxes.push(1),
    onError: () => {},
  });
  assert.equal(code, 20);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].exe, 'C:/app/OmO.exe');
  assert.deepEqual(spawned[0].args, []);
  assert.equal(PORT_VAR in spawned[0].opts.env, false);
  assert.equal(spawned[0].opts.env.OMO_PROFILE, 'work');
  assert.equal(boxes.length, 1);
});

// The fallback imports nothing, so its copies of the two texts are pinned to messages.mjs here, code point for code point.
const codePoints = (text) => [...text.normalize('NFC')].map((ch) => ch.codePointAt(0));

test('the fallback texts in boot.mjs match messages.mjs code point for code point', () => {
  assert.deepEqual(codePoints(bootPlainStartText), codePoints(PLAIN_START_TEXT));
  assert.deepEqual(codePoints(bootBoxTitle), codePoints(BOX_TITLE));
  assert.equal(codePoints(PLAIN_START_TEXT).length, 51);
  assert.equal(codePoints(BOX_TITLE).length, 8);
});

test('a fallback after a start that already happened starts nothing, shows nothing and exits 6', async () => {
  const spawned = [];
  const boxes = [];
  const code = await failOpen('C:/app/OmO.exe', {
    started: true,
    env: { PATH: 'C:\\Windows' },
    spawn: (exe, args, opts) => {
      spawned.push({ exe, args, opts });
      return { on() {}, unref() {} };
    },
    messageBox: () => boxes.push(1),
    onError: () => {},
  });
  assert.equal(code, 6);
  assert.equal(spawned.length, 0);
  assert.equal(boxes.length, 0);
});
