// Content-region selection over plain structural data: no text, no class names.
// One run is { mutations, liveMutations, targets, navKeys, navRootKey }:
//   targets     one ancestor chain per live mutation, outermost first; each node is {key, tag, id}
//   navKeys     keys of the nodes that contain at least one settings nav item
//   navRootKey  key of the lowest node that contains every nav item
export const MIN_COVERAGE = 0.6;

const isShell = (n) => n.tag === 'html' || n.tag === 'body' || n.id === 'root';

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// The deepest node shared by every chain (all chains start at the same root), or null.
function commonAncestor(targets) {
  let lca = null;
  const first = targets[0];
  for (let i = 0; i < first.length; i++) {
    const cand = first[i];
    if (!targets.every((ch) => ch[i] && ch[i].key === cand.key)) break;
    lca = cand;
  }
  return lca;
}

export function chooseRegion({ targets = [], navKeys = [], navRootKey = null }) {
  const total = targets.length;
  const nav = new Set(navKeys);
  const leafCounts = new Map();
  for (const ch of targets) {
    const last = ch[ch.length - 1];
    if (last) leafCounts.set(last.key, (leafCounts.get(last.key) ?? 0) + 1);
  }
  const groups = [...leafCounts]
    .sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))
    .slice(0, 10)
    .map(([path, count]) => ({ path, count }));
  const lca = total > 0 ? commonAncestor(targets) : null;
  const lcaContainsNav = lca ? nav.has(lca.key) : false;
  const base = { navRootPath: navRootKey, lcaPath: lca ? lca.key : null, lcaContainsNav, groups };

  // (a) every live mutation sits under one node that holds no nav item and is not the app shell.
  if (lca && !isShell(lca) && !lcaContainsNav) {
    return { ...base, method: 'lca', ancestor: lca, coverage: { covered: total, total }, droppedNavPaths: [] };
  }

  // (b) otherwise the non-nav node covering the most live mutations (ties: deepest), if it covers enough.
  const counts = new Map();
  const depth = new Map();
  const info = new Map();
  const dropped = new Set();
  for (const ch of targets) {
    ch.forEach((n, i) => {
      if (isShell(n)) return;
      if (nav.has(n.key)) { dropped.add(n.key); return; }
      info.set(n.key, n);
      depth.set(n.key, i);
      counts.set(n.key, (counts.get(n.key) ?? 0) + 1);
    });
  }
  let best = null;
  for (const [key, covered] of counts) {
    const d = depth.get(key);
    if (!best || covered > best.covered || (covered === best.covered && d > best.depth)) best = { key, covered, depth: d };
  }
  const accepted = best !== null && best.covered / total >= MIN_COVERAGE;
  return {
    ...base,
    method: 'densest-non-nav',
    ancestor: accepted ? info.get(best.key) : null,
    coverage: { covered: best ? best.covered : 0, total },
    droppedNavPaths: [...dropped].sort(byText).slice(0, 10),
  };
}

// Combines the runs: the value is kept only when at least two runs found a region and all of them agree.
// Runs that found one region but disagree (or only one found it) mark the result unstable.
export function measureContentRuns(runs = []) {
  const per = runs.map((run) => ({ run, region: chooseRegion(run) }));
  const summaries = per.map(({ run, region }) => ({
    mutations: run.mutations ?? null,
    liveMutations: run.liveMutations ?? null,
    method: region.method,
    ancestor: region.ancestor ? region.ancestor.key : null,
    coverage: region.coverage,
    navRootPath: region.navRootPath,
    lcaPath: region.lcaPath,
    lcaContainsNav: region.lcaContainsNav,
    droppedNavPaths: region.droppedNavPaths,
    groups: region.groups,
  }));
  const found = per.filter((p) => p.region.ancestor);
  const keys = found.map((p) => p.region.ancestor.key);
  const agreed = found.length >= 2 && keys.every((k) => k === keys[0]);
  const pick = agreed ? found[0] : null;
  const first = per.length > 0 ? per[0].run : {};
  return {
    ancestor: pick ? pick.region.ancestor.key : null,
    ancestorTag: pick ? pick.region.ancestor.tag : null,
    ancestorId: pick ? pick.region.ancestor.id ?? null : null,
    unstable: found.length > 0 && !agreed,
    method: pick ? pick.region.method : null,
    mutations: pick ? pick.run.mutations : first.mutations ?? null,
    liveMutations: pick ? pick.run.liveMutations : first.liveMutations ?? null,
    coverage: pick ? pick.region.coverage : null,
    runs: summaries,
  };
}
