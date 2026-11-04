import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnchors,
  sectionStamp,
  assembleExclusions,
  buildCardStyle,
  snapshotFacts,
  CARD_SELECTOR,
  NOT_MEASURED_THREAD,
} from '../loader/app-facts.mjs';

test('buildAnchors: one anchor per settings nav item, each with its route, then the content region', () => {
  const anchors = buildAnchors(['/settings/general', '/settings/about'], '[data-settings-content]', '/settings/general');
  assert.ok(Array.isArray(anchors));
  assert.deepEqual(anchors[0], { selector: '[data-settings-nav-path="/settings/general"]', route: '/settings/general' });
  assert.deepEqual(anchors[1], { selector: '[data-settings-nav-path="/settings/about"]', route: '/settings/about' });
  assert.equal(anchors.length, 3);
});

test('buildAnchors: the settings trigger is not an anchor; the content region gets /settings/ by default', () => {
  const anchors = buildAnchors(['/settings/general'], '[data-settings-content]');
  assert.deepEqual(anchors, [
    { selector: '[data-settings-nav-path="/settings/general"]', route: '/settings/general' },
    { selector: '[data-settings-content]', route: '/settings/' },
  ]);
  assert.ok(!anchors.some((a) => a.selector.includes('data-settings-trigger')));
  assert.ok(!anchors.some((a) => a.route === '*'));
});

test('buildAnchors: rejects a non-array nav list', () => {
  assert.throws(() => buildAnchors({ count: 2 }, 'y'), TypeError);
});

test('sectionStamp: each section gets its own time, taken at its own call', () => {
  const ticks = ['2026-11-01T16:00:00.000Z', '2026-11-01T16:05:00.000Z', '2026-11-01T16:09:00.000Z'];
  let i = 0;
  const now = () => ticks[i++];
  let m = sectionStamp({}, 'settingsNav', now);
  m = sectionStamp(m, 'cardStyle', now);
  m = sectionStamp(m, 'exclusions', now);
  assert.deepEqual(m, {
    settingsNav: ticks[0],
    cardStyle: ticks[1],
    exclusions: ticks[2],
  });
});

test('sectionStamp: does not mutate the input record', () => {
  const before = { settingsNav: '2026-11-01T16:00:00.000Z' };
  const after = sectionStamp(before, 'cardStyle', () => '2026-11-01T16:05:00.000Z');
  assert.deepEqual(before, { settingsNav: '2026-11-01T16:00:00.000Z' });
  assert.equal(after.cardStyle, '2026-11-01T16:05:00.000Z');
});

test('assembleExclusions: threadView is always present and says it was not measured', () => {
  const out = assembleExclusions({ homeCounts: { pre: 0, code: 0 } });
  assert.ok('threadView' in out);
  assert.deepEqual(out.threadView, { measured: false, reason: NOT_MEASURED_THREAD });
  assert.equal(out.fileTree.measured, false);
});

test('assembleExclusions: one entry per candidate with its selector, count and view', () => {
  const out = assembleExclusions({ homeCounts: { pre: 2, '.ProseMirror': 0 } });
  assert.deepEqual(out.exclusionSelectors, [
    { selector: 'pre', count: 2, view: 'empty-state' },
    { selector: '.ProseMirror', count: 0, view: 'empty-state' },
  ]);
});

test('buildCardStyle: a measured card keeps its selector and computed values', () => {
  const card = buildCardStyle({ background: 'rgba(0, 0, 0, 0)', borderRadius: '12px' });
  assert.equal(card.source, 'dom');
  assert.equal(card.selector, CARD_SELECTOR);
  assert.equal(card.borderRadius, '12px');
});

test('buildCardStyle: a card that was not seen is labelled, not filled with guesses', () => {
  assert.deepEqual(buildCardStyle(null), { source: 'not observed', selector: CARD_SELECTOR });
});

test('snapshotFacts: the directory follows this run client fingerprint, never a fixed value', () => {
  assert.deepEqual(snapshotFacts('abc123', true, { capturedIn: 'run X' }), {
    snapshotDir: 'fixtures/live/abc123/',
    snapshotProvenance: { capturedIn: 'run X' },
  });
  assert.equal(snapshotFacts('zzz999', true).snapshotDir, 'fixtures/live/zzz999/');
  assert.ok(!JSON.stringify(snapshotFacts('zzz999', true)).includes('84dcc28a'));
});

test('snapshotFacts: no folder or no client means no snapshot pointer and no provenance', () => {
  assert.deepEqual(snapshotFacts('abc123', false, { capturedIn: 'run X' }), { snapshotDir: null, snapshotProvenance: null });
  assert.deepEqual(snapshotFacts(null, true), { snapshotDir: null, snapshotProvenance: null });
});
