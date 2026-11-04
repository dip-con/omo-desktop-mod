// Structural summary of the app's current screen. The in-page collector reads counts, names and
// lengths only; the pure summarizer decides what is kept. No page text enters the summary.
import { redactHtml } from '../tools/redact.mjs';

export const PRESENT_EXPR = "!!document.querySelector('[data-settings-trigger]')";
export const CLICK_EXPR = "document.querySelector('[data-settings-trigger]').click(), true";

const SAFE_VALUE = /^[a-z0-9:_\/.-]{1,40}$/i;
const SAFE_NAME = /^data-[a-z0-9_-]{1,60}$/i;
const COUNT_KEYS = ['button', 'a', 'input', 'textarea', 'roleDialog', 'roleAlertdialog', 'ariaModal', 'dialogOpen', 'img', 'svg'];
const CAP_NAMES = 40;
const CAP_HITS = 20;

// Runs in the page (serialized with toString): no imports, no outer references besides the DOM globals.
export function pageShapeCollector() {
  const NAME_RE = /settings|sidebar|nav|onboard|login|auth|welcome|update|dialog|modal|boot/i;
  const count = (s) => document.querySelectorAll(s).length;
  const all = Array.from(document.querySelectorAll('*')).slice(0, 5000);
  const dataNames = {};
  const dataHits = [];
  for (const el of all) {
    for (const a of Array.from(el.attributes)) {
      if (!a.name.startsWith('data-')) continue;
      dataNames[a.name] = (dataNames[a.name] || 0) + 1;
      if (NAME_RE.test(a.name) && dataHits.length < 200) {
        dataHits.push({ tag: el.tagName.toLowerCase(), attrName: a.name, value: String(a.value).slice(0, 200) });
      }
    }
  }
  const boot = document.querySelector('#boot-shell');
  return {
    pathname: location.pathname,
    titleLength: document.title.length,
    bootShell: boot ? boot.getAttribute('data-boot-shell-state') : null,
    counts: {
      button: count('button'),
      a: count('a'),
      input: count('input'),
      textarea: count('textarea'),
      roleDialog: count('[role="dialog"]'),
      roleAlertdialog: count('[role="alertdialog"]'),
      ariaModal: count('[aria-modal="true"]'),
      dialogOpen: count('dialog[open]'),
      img: count('img'),
      svg: count('svg'),
    },
    bodyTextLength: document.body ? document.body.textContent.length : 0,
    dataNames,
    dataHits,
    scanned: all.length,
  };
}

// A value is kept only if it is a short token-like identifier and redaction would not change it.
export function safeValue(v) {
  if (typeof v !== 'string' || !SAFE_VALUE.test(v)) return { value: null, redacted: false };
  if (redactHtml(v).html !== v) return { value: null, redacted: true };
  return { value: v, redacted: false };
}

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function summarizePageShape(raw) {
  let redactedValues = 0;
  const names = Object.entries(raw.dataNames ?? {})
    .filter(([name]) => SAFE_NAME.test(name))
    .sort((a, b) => b[1] - a[1] || byText(a[0], b[0]))
    .slice(0, CAP_NAMES)
    .map(([name, count]) => ({ name, count }));
  const hits = (raw.dataHits ?? [])
    .filter((h) => SAFE_NAME.test(h.attrName))
    .map((h) => {
      const v = safeValue(h.value);
      if (v.redacted) redactedValues += 1;
      return { tag: String(h.tag), attrName: h.attrName, value: v.value };
    })
    .sort((a, b) => byText(a.tag, b.tag) || byText(a.attrName, b.attrName) || byText(a.value ?? '', b.value ?? ''));
  const counts = {};
  for (const k of COUNT_KEYS) counts[k] = Number.isInteger(raw.counts?.[k]) ? raw.counts[k] : null;
  return {
    pathname: safeValue(String(raw.pathname ?? '').split(/[?#]/)[0]).value,
    titleLength: Number.isInteger(raw.titleLength) ? raw.titleLength : null,
    bootShell: safeValue(raw.bootShell).value,
    counts,
    bodyTextLength: Number.isInteger(raw.bodyTextLength) ? raw.bodyTextLength : null,
    dataAttrNames: names,
    dataHits: hits.slice(0, CAP_HITS),
    dataHitsTruncated: Math.max(0, hits.length - CAP_HITS),
    redactedValues,
    scanned: Number.isInteger(raw.scanned) ? raw.scanned : null,
  };
}

// Polls for the settings trigger (1 s steps, 30 s total), clicks it, or records a fresh shape and throws.
export async function openSettings({
  evalIn,
  cl,
  record,
  collect,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = 30000,
  stepMs = 1000,
}) {
  const end = now() + timeoutMs;
  for (;;) {
    if (await evalIn(cl, PRESENT_EXPR)) {
      await evalIn(cl, CLICK_EXPR);
      return;
    }
    if (now() >= end) break;
    await sleep(stepMs);
  }
  record.homeShapeOnFailure = summarizePageShape(await collect());
  throw new Error(`settings trigger absent after ${timeoutMs / 1000} s`);
}

export const SURFACE_SELECTOR = '[data-settings-surface="outer"]';

// Non-fatal poll for the settings card. Each expression carries its poll index, so no two calls are identical.
export async function pollSurface({
  evalIn,
  cl,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
  timeoutMs = 8000,
  stepMs = 1000,
}) {
  const start = now();
  for (let i = 0; ; i++) {
    const found = await evalIn(cl, `(/* poll ${i} */ !!document.querySelector('${SURFACE_SELECTOR}'))`);
    if (found) return { found: true, polls: i + 1, polledMs: now() - start };
    if (now() - start >= timeoutMs) return { found: false, polls: i + 1, polledMs: now() - start };
    await sleep(stepMs);
  }
}

// Runs in the page: distinct data-settings-* attribute name/value pairs with their counts. No text nodes.
export function settingsSurfaceCollector() {
  const counts = new Map();
  for (const el of Array.from(document.querySelectorAll('*')).slice(0, 5000)) {
    for (const a of Array.from(el.attributes)) {
      if (!a.name.startsWith('data-settings-')) continue;
      const k = JSON.stringify([a.name, String(a.value).slice(0, 200)]);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return {
    pairs: [...counts].map(([k, count]) => {
      const [attrName, value] = JSON.parse(k);
      return { attrName, value, count };
    }),
  };
}

const SAFE_SETTINGS_NAME = /^data-settings-[a-z0-9_-]{1,60}$/i;

// Up to 20 distinct (attrName, value, count); a value that fails the SAFE_VALUE filter becomes null.
export function summarizeSettingsSurface(raw) {
  return (raw?.pairs ?? [])
    .filter((p) => SAFE_SETTINGS_NAME.test(p.attrName))
    .sort((a, b) => b.count - a.count || byText(a.attrName, b.attrName) || byText(a.value, b.value))
    .slice(0, 20)
    .map((p) => ({ attrName: p.attrName, value: safeValue(p.value).value, count: p.count }));
}
