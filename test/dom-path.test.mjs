import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentOf, pathOf } from '../loader/dom-path.mjs';

const node = (tag, id = null) => ({ nodeType: 1, tagName: tag.toUpperCase(), id, parentElement: null, children: [] });
const append = (parent, child) => {
  child.parentElement = parent;
  parent.children.push(child);
  return child;
};
const all = (n) => [n, ...n.children.flatMap(all)];
const countIn = (root) => (id) => all(root).filter((n) => n.id === id).length;

// html > body > [ (optional) sprite div, div#root > div > main > div (content) ]
function appTree({ sprite }) {
  const html = node('html');
  const body = append(html, node('body'));
  if (sprite) append(body, node('div', 't3code-pierre-file-icon-sprite'));
  const root = append(body, node('div', 'root'));
  const shell = append(root, node('div'));
  const main = append(shell, node('main'));
  const content = append(main, node('div'));
  return { html, root, content };
}

test('a sprite div before #root does not change the content path', () => {
  const withSprite = appTree({ sprite: true });
  const without = appTree({ sprite: false });
  const a = pathOf(withSprite.content, countIn(withSprite.html));
  const b = pathOf(without.content, countIn(without.html));
  assert.equal(a, b);
  assert.equal(a, 'html > body > div#root > div > main > div');
});

test('a unique safe id is emitted without a positional index, even among same-tag siblings', () => {
  const t = appTree({ sprite: true });
  assert.equal(segmentOf(t.root, countIn(t.html)), 'div#root');
});

test('a non-unique id keeps the positional index', () => {
  const html = node('html');
  const body = append(html, node('body'));
  const first = append(body, node('div', 'dup'));
  const second = append(body, node('div', 'dup'));
  const count = countIn(html);
  assert.equal(segmentOf(first, count), 'div#dup:nth-of-type(1)');
  assert.equal(segmentOf(second, count), 'div#dup:nth-of-type(2)');
});

test('an element without an id keeps the index when it has same-tag siblings', () => {
  const html = node('html');
  const body = append(html, node('body'));
  append(body, node('p'));
  append(body, node('div'));
  const second = append(body, node('div'));
  assert.equal(segmentOf(second, countIn(html)), 'div:nth-of-type(2)');
});
