// Tests for loader/target.mjs against the /json/list sample recorded in docs/app-facts.json.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { isMainTarget, mainRuleFromFacts, mainTargets } from '../loader/target.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const facts = JSON.parse(fs.readFileSync(path.join(here, '..', 'docs', 'app-facts.json'), 'utf8'));
const rule = mainRuleFromFacts(facts);

test('the main rule is the protocol and host of the FACTS mainTarget', () => {
  // Given/When/Then: omo://app gives protocol omo: and host app
  assert.deepEqual(rule, { protocol: 'omo:', host: 'app' });
});

test('the recorded app page target matches the main rule', () => {
  // Given: the target list as recorded in FACTS
  const recorded = facts.targetsSeen;
  // When
  const matched = mainTargets(recorded, rule);
  // Then: exactly the app page is the main window
  assert.equal(matched.length, 1);
  assert.equal(matched[0].url, 'omo://app/');
});

test('a non-app page with the same origin text does not match', () => {
  // Given: pages whose URL origin would be 'null' or whose host differs
  const others = [
    { type: 'page', url: 'omo://app.evil/' },
    { type: 'page', url: 'devtools://devtools/bundled/inspector.html' },
    { type: 'page', url: 'data:text/html,<p>x</p>' },
  ];
  // When/Then: none of them is the main window
  for (const t of others) assert.equal(isMainTarget(t, rule), false, t.url);
});

test('only page targets match, even when the URL matches', () => {
  // Given: a service worker and a frame that carry the app URL
  // When/Then: the type is what excludes them
  assert.equal(isMainTarget({ type: 'service_worker', url: 'omo://app/' }, rule), false);
  assert.equal(isMainTarget({ type: 'iframe', url: 'omo://app/' }, rule), false);
});

test('a malformed URL does not match and does not throw', () => {
  // Given/When/Then
  assert.equal(isMainTarget({ type: 'page', url: 'not a url' }, rule), false);
});
