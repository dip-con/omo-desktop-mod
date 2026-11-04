// Main-window rule. FACTS mainTargetMatchRule: match by protocol and host of the target URL, never by URL.origin
// (the origin of an omo:// URL is the string 'null').
export function mainRuleFromFacts(facts) {
  const url = new URL(facts.mainTarget);
  return { protocol: url.protocol, host: url.host };
}

// True for a page target whose URL has the main rule's protocol and host. Other target types never match.
export function isMainTarget(info, rule) {
  if (info.type !== 'page') return false;
  let url;
  try {
    url = new URL(info.url);
  } catch {
    return false;
  }
  return url.protocol === rule.protocol && url.host === rule.host;
}

export function mainTargets(targets, rule) {
  return targets.filter((t) => isMainTarget(t, rule));
}
