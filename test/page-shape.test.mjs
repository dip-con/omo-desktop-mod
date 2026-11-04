import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizePageShape, pageShapeCollector, openSettings, PRESENT_EXPR, CLICK_EXPR } from '../loader/page-shape.mjs';

const raw = (over = {}) => ({
  pathname: '/settings/general',
  titleLength: 12,
  bootShell: 'done',
  counts: { button: 3, a: 1, input: 0, textarea: 0, roleDialog: 0, roleAlertdialog: 0, ariaModal: 0, dialogOpen: 0, img: 2, svg: 9 },
  bodyTextLength: 200,
  dataNames: { 'data-settings-trigger': 1 },
  dataHits: [],
  scanned: 40,
  ...over,
});

test('summary keeps only whitelisted keys; page text never enters it', () => {
  const s = summarizePageShape({ ...raw(), text: 'Quarterly plan with Alice', bodyText: 'secret body' });
  assert.deepEqual(Object.keys(s).sort(), ['bodyTextLength', 'bootShell', 'counts', 'dataAttrNames', 'dataHits', 'dataHitsTruncated', 'pathname', 'redactedValues', 'scanned', 'titleLength']);
  assert.ok(!JSON.stringify(s).includes('Alice'));
  assert.ok(!JSON.stringify(s).includes('secret'));
});

test('pathname keeps the route only (no query or hash)', () => {
  assert.equal(summarizePageShape(raw({ pathname: '/chat/abc?x=1#y' })).pathname, '/chat/abc');
});

test('value filter rejects text-like values', () => {
  const s = summarizePageShape(raw({ dataHits: [{ tag: 'div', attrName: 'data-settings-x', value: 'Quarterly plan 2026' }] }));
  assert.equal(s.dataHits[0].value, null);
});

test('a token-like value is redacted to null and counted', () => {
  const s = summarizePageShape(raw({ dataHits: [{ tag: 'div', attrName: 'data-auth-token', value: 'sk-abcdefghijklmnopqrst' }] }));
  assert.equal(s.dataHits[0].value, null);
  assert.equal(s.redactedValues, 1);
});

test('name histogram: sorted by count then name, capped at 40', () => {
  const dataNames = {};
  for (let i = 0; i < 50; i++) dataNames[`data-n${String(i).padStart(2, '0')}`] = i === 0 ? 9 : 1;
  const s = summarizePageShape(raw({ dataNames }));
  assert.equal(s.dataAttrNames.length, 40);
  assert.deepEqual(s.dataAttrNames[0], { name: 'data-n00', count: 9 });
  assert.equal(s.dataAttrNames[1].name, 'data-n01');
});

test('hits: capped at 20, sorted, and the rest counted as truncated', () => {
  const dataHits = Array.from({ length: 25 }, (_, i) => ({ tag: 'div', attrName: `data-settings-${String(i).padStart(2, '0')}`, value: 'ok' }));
  const s = summarizePageShape(raw({ dataHits }));
  assert.equal(s.dataHits.length, 20);
  assert.equal(s.dataHitsTruncated, 5);
  assert.equal(s.dataHits[0].attrName, 'data-settings-00');
});

test('names that are not data-* attribute names are dropped', () => {
  const s = summarizePageShape(raw({ dataNames: { 'data-ok': 2, 'Quarterly plan': 5 } }));
  assert.deepEqual(s.dataAttrNames, [{ name: 'data-ok', count: 2 }]);
});

test('collector: returns structure and lengths only, never the title or body text', () => {
  const el = (tag, attrs) => ({ tagName: tag.toUpperCase(), attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })) });
  const elements = [el('div', { 'data-settings-trigger': 'open' }), el('p', { 'data-x': 'y' })];
  const boot = { getAttribute: (n) => (n === 'data-boot-shell-state' ? 'done' : null) };
  globalThis.document = {
    title: 'Quarterly plan',
    body: { textContent: 'hello secret' },
    querySelectorAll: (sel) => (sel === '*' ? elements : []),
    querySelector: (sel) => (sel === '#boot-shell' ? boot : null),
  };
  globalThis.location = { pathname: '/settings/general', search: '?q=1', hash: '#h' };
  try {
    const r = pageShapeCollector();
    assert.equal(r.pathname, '/settings/general');
    assert.equal(r.titleLength, 'Quarterly plan'.length);
    assert.equal(r.bodyTextLength, 'hello secret'.length);
    assert.equal(r.bootShell, 'done');
    assert.ok(r.dataHits.some((h) => h.attrName === 'data-settings-trigger' && h.value === 'open'));
    assert.ok(!JSON.stringify(r).includes('hello secret'));
    assert.ok(!JSON.stringify(r).includes('Quarterly plan'));
  } finally {
    delete globalThis.document;
    delete globalThis.location;
  }
});

test('openSettings: trigger present at the first poll -> one click, no failure record', async () => {
  const log = { checks: 0, clicks: 0 };
  const evalIn = async (_cl, expr) => {
    if (expr === PRESENT_EXPR) { log.checks++; return true; }
    if (expr === CLICK_EXPR) { log.clicks++; return true; }
    throw new Error(`unexpected ${expr}`);
  };
  const run = {};
  let t = 0;
  await openSettings({ evalIn, cl: null, record: run, collect: async () => raw(), sleep: async (ms) => { t += ms; }, now: () => t });
  assert.deepEqual([log.checks, log.clicks], [1, 1]);
  assert.equal(run.homeShapeOnFailure, undefined);
});

test('openSettings: trigger present after three polls -> retries in 1 s steps, then one click', async () => {
  const log = { checks: 0, clicks: 0 };
  const evalIn = async (_cl, expr) => {
    if (expr === PRESENT_EXPR) { log.checks++; return log.checks >= 4; }
    if (expr === CLICK_EXPR) { log.clicks++; return true; }
    throw new Error(`unexpected ${expr}`);
  };
  let t = 0;
  await openSettings({ evalIn, cl: null, record: {}, collect: async () => raw(), sleep: async (ms) => { t += ms; }, now: () => t });
  assert.deepEqual([log.checks, log.clicks, t], [4, 1, 3000]);
});

test('openSettings: never present -> throws after 30 s and records the shape on failure', async () => {
  let checks = 0;
  let t = 0;
  const run = {};
  const evalIn = async (_cl, expr) => {
    if (expr === PRESENT_EXPR) { checks++; return false; }
    throw new Error(`clicked unexpectedly: ${expr}`);
  };
  await assert.rejects(
    openSettings({ evalIn, cl: null, record: run, collect: async () => raw(), sleep: async (ms) => { t += ms; }, now: () => t }),
    { message: 'settings trigger absent after 30 s' },
  );
  assert.equal(checks, 31);
  assert.equal(run.homeShapeOnFailure.pathname, '/settings/general');
});
