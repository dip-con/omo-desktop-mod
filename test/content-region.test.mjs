import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseRegion, measureContentRuns } from '../loader/content-region.mjs';

const N = (key, tag = 'div', id = null) => ({ key, tag, id });
const HTML = N('html', 'html');
const BODY = N('html > body', 'body');
const ROOT = N('html > body > div#root', 'div', 'root');
const chain = (...nodes) => [HTML, BODY, ROOT, ...nodes];
const leaf = (k) => N(`leaf-${k}`, 'p');

test('lca: all live mutations under one non-nav node -> method lca', () => {
  const C = N('C');
  const targets = [1, 2, 3].map((i) => chain(C, leaf(i)));
  const r = chooseRegion({ targets, navKeys: ['shell'], navRootKey: 'shell' });
  assert.equal(r.method, 'lca');
  assert.equal(r.ancestor.key, 'C');
  assert.deepEqual(r.coverage, { covered: 3, total: 3 });
});

test('lca contains nav -> densest non-nav region is chosen and the nav node is recorded as dropped', () => {
  const S = N('S');
  const C = N('C');
  const O = N('O');
  const targets = [
    chain(S, C, leaf(1)),
    chain(S, C, leaf(2)),
    chain(S, C, leaf(3)),
    chain(S, leaf(4)),
    chain(O, leaf(5)),
  ];
  const r = chooseRegion({ targets, navKeys: ['S'], navRootKey: 'S' });
  assert.equal(r.method, 'densest-non-nav');
  assert.equal(r.lcaContainsNav, false);
  assert.equal(r.ancestor.key, 'C');
  assert.deepEqual(r.coverage, { covered: 3, total: 5 });
  assert.deepEqual(r.droppedNavPaths, ['S']);
});

test('coverage below 60% -> ancestor is null', () => {
  const X = N('X');
  const Y = N('Y');
  const Z = N('Z');
  const NAV = N('navshell');
  const targets = [chain(X, leaf(1)), chain(X, leaf(2)), chain(Y, leaf(3)), chain(Z, leaf(4)), chain(NAV, leaf(5))];
  const r = chooseRegion({ targets, navKeys: ['navshell'], navRootKey: 'navshell' });
  assert.equal(r.method, 'densest-non-nav');
  assert.equal(r.ancestor, null);
  assert.deepEqual(r.coverage, { covered: 2, total: 5 });
});

test('ties in coverage go to the deepest node', () => {
  const A = N('A');
  const B = N('B');
  const NAV = N('navshell');
  const targets = [1, 2, 3, 4].map((i) => chain(A, B, leaf(i)));
  targets.push(chain(NAV, leaf(5)));
  const r = chooseRegion({ targets, navKeys: ['navshell'], navRootKey: 'navshell' });
  assert.equal(r.ancestor.key, 'B');
  assert.deepEqual(r.coverage, { covered: 4, total: 5 });
});

test('html, body and #root are never chosen', () => {
  const targets = [1, 2, 3, 4, 5].map((i) => chain(N(`X${i}`), leaf(i)));
  const r = chooseRegion({ targets, navKeys: [], navRootKey: 'html > body > div#root' });
  assert.equal(r.ancestor, null);
  assert.notEqual(r.method, 'lca');
});

const lcaRun = (key) => ({
  mutations: 5,
  liveMutations: 5,
  targets: [1, 2, 3, 4, 5].map((i) => chain(N(key), leaf(i))),
  navKeys: [],
  navRootKey: 'shell',
});
const emptyRun = { mutations: 0, liveMutations: 0, targets: [], navKeys: [], navRootKey: 'shell' };

test('runs agree -> the common region is the value, not unstable', () => {
  const m = measureContentRuns([lcaRun('C'), lcaRun('C'), lcaRun('C')]);
  assert.equal(m.ancestor, 'C');
  assert.equal(m.unstable, false);
});

test('one null of three runs still agrees on the value', () => {
  const m = measureContentRuns([lcaRun('C'), emptyRun, lcaRun('C')]);
  assert.equal(m.ancestor, 'C');
  assert.equal(m.unstable, false);
});

test('two null runs -> null and unstable', () => {
  const m = measureContentRuns([lcaRun('C'), emptyRun, emptyRun]);
  assert.equal(m.ancestor, null);
  assert.equal(m.unstable, true);
});

test('runs that disagree -> null and unstable', () => {
  const m = measureContentRuns([lcaRun('C1'), lcaRun('C2'), lcaRun('C1')]);
  assert.equal(m.ancestor, null);
  assert.equal(m.unstable, true);
});

test('no run finds a region -> null, not unstable (not measured)', () => {
  const m = measureContentRuns([emptyRun, emptyRun, emptyRun]);
  assert.equal(m.ancestor, null);
  assert.equal(m.unstable, false);
  assert.equal(m.runs.length, 3);
});
