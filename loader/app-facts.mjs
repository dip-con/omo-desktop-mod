// Pure helpers that shape docs/app-facts.json. No I/O: the in-page measurement code stays in
// tools/probe-app.mjs and passes plain values here.

export const CARD_SELECTOR = '[data-settings-surface="outer"]';
export const NOT_MEASURED_THREAD = 'no existing conversation in the sidebar';
export const NOT_MEASURED_FILE_TREE = 'no file tree open in the measured views';

// One anchor per settings nav item (with its route), then the content region. The settings trigger is
// not an anchor: it is absent under /settings/, so no mod can attach to it.
export function buildAnchors(navPaths, contentSelector, contentRoute = '/settings/') {
  if (!Array.isArray(navPaths)) throw new TypeError('navPaths must be an array');
  const items = navPaths.map((route) => ({ selector: `[data-settings-nav-path="${route}"]`, route }));
  return [...items, { selector: contentSelector, route: contentRoute }];
}

// Gives one section its own timestamp, taken when that section was measured.
export function sectionStamp(measuredAt, name, now = () => new Date().toISOString()) {
  return { ...measuredAt, [name]: now() };
}

export function buildExclusions(counts, view) {
  return Object.entries(counts).map(([selector, count]) => ({ selector, count, view }));
}

// threadView and fileTree are always present; an unmeasured one says so with a reason.
export function assembleExclusions({ homeCounts, threadView = null, fileTree = null }) {
  return {
    exclusionSelectors: buildExclusions(homeCounts, 'empty-state'),
    threadView: threadView ?? { measured: false, reason: NOT_MEASURED_THREAD },
    fileTree: fileTree ?? { measured: false, reason: NOT_MEASURED_FILE_TREE },
  };
}

// Computed style of the settings card; source says whether it was seen in the DOM.
export function buildCardStyle(measured) {
  if (!measured) return { source: 'not observed', selector: CARD_SELECTOR };
  return { source: 'dom', selector: CARD_SELECTOR, ...measured };
}

// Snapshot pointer for this run. The directory comes from this run's client fingerprint and is reported
// only when that snapshot folder exists; provenance is the snapshot run's own record, or null.
export function snapshotFacts(client, folderExists, provenance = null) {
  if (!client || !folderExists) return { snapshotDir: null, snapshotProvenance: null };
  return { snapshotDir: `fixtures/live/${client}/`, snapshotProvenance: provenance };
}
