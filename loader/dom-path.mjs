// Structural selector segments for the in-page measurement. Pure: it takes DOM-like nodes and a
// countById callback, so it runs under node:test on a fake tree and is embedded into the page
// with toString(). Keep it self-contained: no module-level references.

// One segment for el: tag, then #id when the id is safe, then :nth-of-type when the id is missing,
// not unique, or absent. A safe id that is unique in the document ends the segment (no index),
// so a sibling inserted before the element does not change the path.
export function segmentOf(el, countById) {
  const SAFE = /^[a-z0-9:_\/.-]{1,40}$/i;
  let s = el.tagName.toLowerCase();
  if (el.id && SAFE.test(el.id)) {
    s += '#' + el.id;
    if (countById(el.id) === 1) return s;
  }
  const p = el.parentElement;
  if (p) {
    const same = Array.from(p.children).filter((c) => c.tagName === el.tagName);
    if (same.length > 1) s += `:nth-of-type(${same.indexOf(el) + 1})`;
  }
  return s;
}

// Path from the document element down to el: one segment per ancestor-or-self, joined with ' > '.
export function pathOf(el, countById) {
  const nodes = [];
  for (let e = el; e && e.nodeType === 1; e = e.parentElement) nodes.unshift(e);
  return nodes.map((e) => segmentOf(e, countById)).join(' > ');
}
