// Loader side of the page injection: builds the bundle, attaches to every OmO main window over one CDP connection,
// registers the bundle in the isolated world 'omo-mods', serves the __omoModsCall bridge and hands the watchdog its
// reports. Mods and host modules are read again on every __reload.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { discover, routeMatches } from './mods.mjs';
import { createWatchdog } from './watchdog.mjs';

export const BINDING = '__omoModsCall';
export const WORLD = 'omo-mods';
export const BRIDGE_TIMEOUT_MS = 30000;
const RUNTIME_FILE = fileURLToPath(new URL('../runtime/page.js', import.meta.url));
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const CONTROL = new Set(['__plan', '__fail', '__watchdog', '__reload']);
const MAX_PAYLOAD = 65536;
const J = (v) => JSON.stringify(v);

// Bumped by every __reload: a host module is imported again under a new URL, so an updated host takes effect.
let generation = 0;

// The OmO main window: a page target whose URL has protocol omo: and host app (URL.origin of omo:// is 'null').
export function isMainTarget(info) {
  if (info.type !== 'page') return false;
  try {
    const url = new URL(info.url);
    return url.protocol === 'omo:' && url.host === 'app';
  } catch {
    return false;
  }
}

// Active mods (enabled or locked) with their page source and css. Returns { loaded, reported } where reported lists
// every mod that will not run: [{ id, name, attached: false, reason }] with BAD_FORMAT, DISABLED or BAD_FILES.
export function readMods(modsHome) {
  const { mods, broken } = discover(modsHome);
  const reported = broken.map((b) => ({ id: b.id, name: b.id, attached: false, reason: 'BAD_FORMAT' }));
  const loaded = [];
  for (const m of mods) {
    if (!m.enabled && !m.locked) {
      reported.push({ id: m.id, name: m.nameKo, attached: false, reason: 'DISABLED' });
      continue;
    }
    try {
      const pageSrc = fs.readFileSync(path.join(m.dir, m.entry.page), 'utf8');
      new vm.Script(`(function (omoMods) {\n${pageSrc}\n})`);
      const css = m.entry.css ? fs.readFileSync(path.join(m.dir, m.entry.css), 'utf8') : '';
      loaded.push({ ...m, pageSrc, css, hostFile: m.entry.host ? path.join(m.dir, m.entry.host) : null });
    } catch {
      reported.push({ id: m.id, name: m.nameKo, attached: false, reason: 'BAD_FILES' });
    }
  }
  return { loaded, reported };
}

// One script for the isolated world: guard, CONFIG, routeMatches (single source in mods.mjs), then the page runtime.
// ctx: { reported, bridgeTimeoutMs, noticeOnly }. noticeOnly shows the badge and its issues, with no mods and no bridge.
export function buildBundle(mods, { reported = [], bridgeTimeoutMs = BRIDGE_TIMEOUT_MS, noticeOnly = false } = {}) {
  const entries = mods.map((m) => `{id:${J(m.id)},name:${J(m.nameKo)},order:${J(m.order)},anchors:${J(m.anchors)},css:${J(m.css)},run:function (omoMods) {\n${m.pageSrc}\n}}`);
  return [
    '(function () {',
    'if (window.__omoMods) return;',
    `var CONFIG = { noticeOnly: ${J(noticeOnly)}, bridgeTimeoutMs: ${Number(bridgeTimeoutMs)}, reported: ${J(reported)}, mods: [${entries.join(',')}] };`,
    `var routeMatches = ${routeMatches.toString()};`,
    fs.readFileSync(RUNTIME_FILE, 'utf8'),
    '})();',
  ].join('\n');
}

// Boundary check of one bridge request. Control messages use id 0 and a reserved method name.
export function parseRequest(payload, knownMods) {
  const bad = (reason) => ({ ok: false, reason });
  if (typeof payload !== 'string' || payload.length > MAX_PAYLOAD) return bad('size');
  let msg;
  try {
    msg = JSON.parse(payload);
  } catch {
    return bad('json');
  }
  if (typeof msg !== 'object' || msg === null || !Number.isInteger(msg.id) || msg.id < 0) return bad('id');
  if (typeof msg.mod !== 'string' || typeof msg.method !== 'string' || !Array.isArray(msg.args)) return bad('shape');
  if (msg.id === 0) return CONTROL.has(msg.method) ? { ok: true, control: true, ...msg } : bad('control');
  if (!METHOD_PATTERN.test(msg.method)) return bad('method');
  if (!knownMods.has(msg.mod)) return bad('unknown mod');
  return { ok: true, control: false, ...msg };
}

// Attaches to every main window on this connection and keeps the bundle in place across reloads and new targets.
// opts: { modsHome, stateDir, ownerOk(): Promise<boolean>, onEvent(ev), log(line), watchdogCounts?, bridgeTimeoutMs? }
// Events: attached, plan, fail, host-failed, watchdog, notice, reloaded, owner-mismatch.
export async function attach(cdp, opts) {
  const { modsHome, stateDir, ownerOk, onEvent, log, bridgeTimeoutMs = BRIDGE_TIMEOUT_MS } = opts;
  let current;
  let bundle;
  let known;
  const hosts = new Map();
  const refresh = () => {
    current = readMods(modsHome);
    bundle = buildBundle(current.loaded, { reported: current.reported, bridgeTimeoutMs });
    known = new Set(current.loaded.map((m) => m.id));
    hosts.clear();
  };
  refresh();
  const sessions = new Map(); // targetId -> { targetId, sessionId, identifier }
  const bySession = (sessionId) => [...sessions.values()].find((s) => s.sessionId === sessionId);
  const noticeScript = buildBundle([], { reported: [{ id: '*', name: '', attached: false, reason: 'WATCHDOG' }], noticeOnly: true });
  const watchdog = createWatchdog({ cdp, noticeScript, onEvent, log, counts: opts.watchdogCounts });

  const hostFailure = (message) => Object.assign(new Error(message), { hostFailed: true });
  async function callHost(modId, method, args) {
    const mod = current.loaded.find((m) => m.id === modId);
    if (!mod.hostFile) throw hostFailure('NO_HOST');
    if (!hosts.has(modId)) {
      try {
        hosts.set(modId, await import(`${pathToFileURL(mod.hostFile).href}?gen=${generation}`));
      } catch (err) {
        throw hostFailure(`HOST_LOAD: ${err.message}`);
      }
    }
    const host = hosts.get(modId);
    if (typeof host.handle !== 'function') throw hostFailure('HOST_HAS_NO_HANDLE');
    return host.handle(method, args, { modId, modDir: mod.dir, stateDir, modsHome });
  }

  // Puts the current mods into every attached document: old script out, new bundle in, then reload.
  // A session the watchdog emptied has no script to replace and stays without mods.
  async function reloadAll() {
    generation += 1;
    refresh();
    onEvent({ kind: 'reloaded', reported: current.reported });
    for (const s of [...sessions.values()]) {
      if (s.identifier === null) continue;
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: s.identifier }, { sessionId: s.sessionId });
      s.identifier = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bundle, worldName: WORLD }, { sessionId: s.sessionId })).identifier;
      await cdp.send('Page.reload', { ignoreCache: false }, { sessionId: s.sessionId });
    }
  }

  async function onControl(sessionId, req) {
    switch (req.method) {
      case '__plan':
        return onEvent({ kind: 'plan', sessionId, states: req.args[0], pathname: req.args[1], reported: current.reported });
      case '__fail':
        return onEvent({ kind: 'fail', sessionId, mod: req.mod, detail: String(req.args[0]) });
      case '__reload':
        return reloadAll();
      case '__watchdog': {
        const entry = bySession(sessionId);
        return entry ? watchdog.trigger(entry, req.args[0]) : undefined;
      }
      default:
        throw new Error(`unreachable control ${req.method}`);
    }
  }

  async function onBinding(sessionId, { name, payload, executionContextId }) {
    if (name !== BINDING) return;
    const req = parseRequest(payload, known);
    if (!req.ok) return log(`bridge request refused: ${req.reason}`);
    if (req.control) return onControl(sessionId, req);
    const reply = (body) => cdp.send('Runtime.evaluate', { expression: `window.__omoModsReply(${req.id}, ${J(J(body))})`, contextId: executionContextId }, { sessionId });
    try {
      await reply({ ok: true, value: await callHost(req.mod, req.method, req.args) });
    } catch (err) {
      if (err.hostFailed) onEvent({ kind: 'host-failed', sessionId, mod: req.mod, detail: err.message });
      await reply({ ok: false, error: String(err.message) });
    }
  }

  async function attachTarget(info) {
    if (!isMainTarget(info) || sessions.has(info.targetId)) return;
    const entry = { targetId: info.targetId, sessionId: null, identifier: null };
    sessions.set(info.targetId, entry);
    if (!(await ownerOk())) {
      sessions.delete(info.targetId);
      return onEvent({ kind: 'owner-mismatch', targetId: info.targetId });
    }
    const send = (method, params = {}) => cdp.send(method, params, { sessionId: entry.sessionId });
    entry.sessionId = (await cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: true })).sessionId;
    await send('Page.enable');
    await send('Runtime.enable');
    const { frameTree } = await send('Page.getFrameTree');
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD, grantUniveralAccess: false });
    await send('Runtime.addBinding', { name: BINDING, executionContextName: WORLD });
    entry.identifier = (await send('Page.addScriptToEvaluateOnNewDocument', { source: bundle, worldName: WORLD })).identifier;
    const ran = await send('Runtime.evaluate', { expression: bundle, contextId: executionContextId });
    if (ran.exceptionDetails) log(`bundle threw: ${ran.exceptionDetails.text}`);
    onEvent({ kind: 'attached', targetId: info.targetId, sessionId: entry.sessionId });
  }

  const attachLogged = (info) => attachTarget(info).catch((err) => log(`attach failed: ${err.message}`));
  cdp.on('Target.targetCreated', ({ targetInfo }) => attachLogged(targetInfo));
  cdp.on('Target.targetInfoChanged', ({ targetInfo }) => attachLogged(targetInfo));
  cdp.on('Target.targetDestroyed', ({ targetId }) => sessions.delete(targetId));
  cdp.on('Inspector.detached', (_params, sessionId) => {
    const entry = bySession(sessionId);
    if (entry) sessions.delete(entry.targetId);
  });
  cdp.on('Runtime.bindingCalled', (params, sessionId) => onBinding(sessionId, params).catch((err) => log(`bridge error: ${err.message}`)));
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const { targetInfos } = await cdp.send('Target.getTargets');
  for (const info of targetInfos) await attachLogged(info);
  return { reloadAll, sessions };
}
