import test from 'node:test';
import assert from 'node:assert/strict';
import { pollSurface, settingsSurfaceCollector, summarizeSettingsSurface, SURFACE_SELECTOR } from '../loader/page-shape.mjs';

const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
};

test('pollSurface: card present at the first poll -> found, no waiting', async () => {
  const r = await pollSurface({ evalIn: async () => true, cl: null, ...clock() });
  assert.deepEqual(r, { found: true, polls: 1, polledMs: 0 });
});

test('pollSurface: card present after three polls -> found after three 1 s steps', async () => {
  let n = 0;
  const r = await pollSurface({ evalIn: async () => ++n >= 4, cl: null, ...clock() });
  assert.deepEqual(r, { found: true, polls: 4, polledMs: 3000 });
});

test('pollSurface: never present -> not found after 8 s (non-fatal)', async () => {
  const r = await pollSurface({ evalIn: async () => false, cl: null, ...clock() });
  assert.deepEqual(r, { found: false, polls: 9, polledMs: 8000 });
});

test('pollSurface: every poll expression is distinct and names the card selector', async () => {
  const exprs = [];
  let n = 0;
  await pollSurface({ evalIn: async (_cl, expr) => { exprs.push(expr); return ++n >= 3; }, cl: null, ...clock() });
  assert.equal(new Set(exprs).size, exprs.length);
  assert.ok(exprs.every((e) => e.includes(SURFACE_SELECTOR)));
});

test('summary: keeps data-settings names only, sorted by count, capped at 20', () => {
  const pairs = Array.from({ length: 25 }, (_, i) => ({ attrName: `data-settings-a${String(i).padStart(2, '0')}`, value: 'v', count: i }));
  pairs.push({ attrName: 'data-other', value: 'v', count: 99 });
  const s = summarizeSettingsSurface({ pairs });
  assert.equal(s.length, 20);
  assert.equal(s[0].count, 24);
  assert.ok(!s.some((x) => x.attrName === 'data-other'));
});

test('summary: a text-like value becomes null', () => {
  const s = summarizeSettingsSurface({ pairs: [{ attrName: 'data-settings-x', value: 'Quarterly plan 2026', count: 1 }] });
  assert.equal(s[0].value, null);
});

test('collector: counts data-settings-* pairs and leaves out other attributes', () => {
  const el = (attrs) => ({ attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })) });
  globalThis.document = {
    querySelectorAll: (sel) => (sel === '*'
      ? [el({ 'data-settings-surface': 'outer', 'data-settings-x': 'Hello world' }), el({ 'data-settings-surface': 'outer' }), el({ 'data-other': 'z' })]
      : []),
  };
  try {
    const r = settingsSurfaceCollector();
    const surface = r.pairs.find((p) => p.attrName === 'data-settings-surface' && p.value === 'outer');
    assert.equal(surface.count, 2);
    assert.ok(!JSON.stringify(r).includes('data-other'));
  } finally {
    delete globalThis.document;
  }
});
