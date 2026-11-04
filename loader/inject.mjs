// Loader side of the page injection. Attaches to every main-window page over CDP, runs the bundle in the isolated
// world 'omo-mods', serves the bridge, and reports each mod's plan. Process-level work lives in deps.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { connect } from './cdp.mjs';
import { evaluateMod, routeMatches } from './mods.mjs';
import { isMainTarget } from './target.mjs';

export const BINDING = '__omoModsCall';
export const WORLD = 'omo-mods';
export const BRIDGE_TIMEOUT_MS = 30000;
// Watchdog reloads per target before the loader stops reloading and only shows the notice.
export const MAX_WATCHDOG_RELOADS = 3;
const METHOD_PATTERN = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const CONTROL_METHODS = new Set(['__plan', '__fail', '__watchdog', '__reload']);
const MAX_PAYLOAD = 65536;
const J = (v) => JSON.stringify(v);

// Reads each mod's page and css. A mod whose files are missing or whose page does not compile is left out.
export function loadModSources(mods, modsRoot) {
  const loaded = [];
  const skipped = [];
  for (const m of mods) {
    const dir = path.join(modsRoot, m.id);
    try {
      const pageSrc = fs.readFileSync(path.join(dir, m.entry.page), 'utf8');
      new vm.Script(`(function (omoMods) {\n${pageSrc}\n})`);
      const css = m.entry.css ? fs.readFileSync(path.join(dir, m.entry.css), 'utf8') : '';
      loaded.push({ ...m, pageSrc, css, hostFile: m.entry.host ? path.join(dir, m.entry.host) : null });
    } catch (err) {
      skipped.push({ id: m.id, reason: `files do not load: ${err.message}` });
    }
  }
  return { loaded, skipped };
}

// One script for the isolated world: the guard, the route and evaluation functions copied from mods.mjs (single source),
// the config (mods, reported entries, OMO_PROFILE, bridge timeout), then the page runtime and the notice.
export function buildBundle({ mods, buildKey, loaderDir, reported = [], omoProfile = null, bridgeTimeoutMs = BRIDGE_TIMEOUT_MS }) {
  const runtime = fs.readFileSync(path.join(loaderDir, 'page-runtime.js'), 'utf8');
  const notice = fs.readFileSync(path.join(loaderDir, 'notice.js'), 'utf8');
  const entries = mods.map(
    (m) =>
      `{id:${J(m.id)},name:${J(m.nameKo)},order:${J(m.order)},anchors:${J(m.anchors)},testedBuilds:${J(m.testedBuilds)},css:${J(m.css)},run:function (omoMods) {\n${m.pageSrc}\n}}`,
  );
  return [
    '(function () {',
    'if (window.__omoMods) return;',
    `var CONFIG = { buildKey: ${J(buildKey)}, omoProfile: ${J(omoProfile)}, bridgeTimeoutMs: ${Number(bridgeTimeoutMs)}, reported: ${J(reported)}, mods: [${entries.join(',')}] };`,
    `var routeMatches = ${routeMatches.toString()};`,
    `var evaluateMod = ${evaluateMod.toString()};`,
    runtime,
    notice,
    'window.omoMods.start();',
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
  if (typeof msg.mod !== 'string' || typeof msg.method !== 'string') return bad('shape');
  if (!Array.isArray(msg.args) || J(msg.args).length > MAX_PAYLOAD) return bad('args');
  if (msg.id === 0) {
    if (!CONTROL_METHODS.has(msg.method)) return bad('control');
    return { ok: true, control: true, ...msg };
  }
  if (!METHOD_PATTERN.test(msg.method)) return bad('method');
  if (!knownMods.has(msg.mod)) return bad('unknown mod');
  return { ok: true, control: false, ...msg };
}

// Attaches to the main windows and keeps the bundle in place across reloads and reopened targets.
// onEvent receives { kind, ... }: attached, plan, fail, watchdog, notice, owner-mismatch, binding-lost, call.
// resolveMods() returns { loaded, reported } read from disk. It runs at start and again on every __reload.
export async function serveMainWindows({ wsUrl, rule, resolveMods, omoProfile = null, bridgeTimeoutMs = BRIDGE_TIMEOUT_MS, buildKey, loaderDir, ownerOk, onEvent, log, openCdp = connect, maxReloads = MAX_WATCHDOG_RELOADS }) {
  let loaded;
  let bundle;
  let knownMods;
  const refresh = () => {
    const current = resolveMods();
    loaded = current.loaded;
    bundle = buildBundle({ mods: loaded, buildKey, loaderDir, reported: current.reported, omoProfile, bridgeTimeoutMs });
    knownMods = new Set(loaded.map((m) => m.id));
  };
  refresh();
  const hosts = new Map();
  const sessions = new Map();
  const cdp = await openCdp(wsUrl);
  log('cdp connected');
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  cdp.on('close', () => finish());
  // After the pristine load the notice runs in the isolated world: no mod code, no bridge, no main-world globals.
  // notice.js supplies the badge and the reason text; the shim only creates the object it writes into.
  const notice = fs.readFileSync(path.join(loaderDir, 'notice.js'), 'utf8');
  const noticeScript = `(function () { window.omoMods = window.omoMods || {};\n${notice}\nvar o = window.omoMods; o.clearIssues(); o.addIssue('WATCHDOG', ''); o.notice(0); var b = document.getElementById('omo-mods-badge'); b.setAttribute('data-omo-notice', ''); b.setAttribute('data-reason', 'WATCHDOG'); })();`;
  const showWatchdogNotice = async (sessionId) => {
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, { sessionId });
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD, grantUniveralAccess: false }, { sessionId });
    const ran = await cdp.send('Runtime.evaluate', { expression: noticeScript, contextId: executionContextId }, { sessionId });
    if (ran.exceptionDetails) throw new Error('notice script threw');
  };
  // The notice waits for the reloaded document: the old document's load can arrive after the watchdog and before the reload commits.
  cdp.on('Page.frameNavigated', ({ frame }, sessionId) => {
    if (frame.parentId) return;
    const entry = [...sessions.values()].find((s) => s.sessionId === sessionId);
    if (entry?.noticeDue) entry.committed = true;
  });
  cdp.on('Page.loadEventFired', (_params, sessionId) => {
    const entry = [...sessions.values()].find((s) => s.sessionId === sessionId);
    if (!entry?.noticeDue || !entry.committed) return;
    entry.reloadPending = false;
    entry.noticeDue = false;
    entry.committed = false;
    showWatchdogNotice(sessionId).then(() => onEvent({ kind: 'notice', sessionId }), (err) => log(`notice failed: ${err.message}`));
  });

  // A failure before the host loads is marked, so the loader can report the mod as HOST_FAILED.
  const hostFailure = (message) => Object.assign(new Error(message), { hostFailed: true });
  async function hostHandle(modId, method, args) {
    const mod = loaded.find((m) => m.id === modId);
    if (!mod.hostFile) throw hostFailure('NO_HOST');
    if (!hosts.has(modId)) {
      try {
        hosts.set(modId, await import(pathToFileURL(mod.hostFile).href));
      } catch (err) {
        throw hostFailure(`HOST_LOAD: ${err.message}`);
      }
    }
    const host = hosts.get(modId);
    if (typeof host.handle !== 'function') throw hostFailure('HOST_HAS_NO_HANDLE');
    return host.handle(method, args);
  }

  async function onControl(sessionId, req) {
    if (req.method === '__plan') {
      const [states, pathname] = req.args;
      onEvent({ kind: 'plan', sessionId, states, pathname });
    } else if (req.method === '__fail') {
      onEvent({ kind: 'fail', sessionId, mod: req.mod, detail: String(req.args[0]) });
    } else if (req.method === '__reload') {
      await reloadAll();
    } else {
      const entry = [...sessions.values()].find((s) => s.sessionId === sessionId);
      // A reload is already on its way: a second watchdog is ignored until the reloaded document has loaded.
      if (entry?.reloadPending) return;
      // The number and the pending flag are set before any await, so a second watchdog during removeScript is ignored.
      const reloads = entry ? (entry.reloads = (entry.reloads ?? 0) + 1) : 1;
      if (entry && reloads <= maxReloads) {
        entry.reloadPending = true;
        entry.noticeDue = true;
        entry.committed = false;
      }
      if (entry && entry.identifier !== null) {
        const identifier = entry.identifier;
        entry.identifier = null;
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, { sessionId });
      }
      onEvent({ kind: 'watchdog', sessionId, detail: String(req.args[0] ?? ''), reloads, crashed: entry?.crashed === true });
      if (reloads > maxReloads) {
        onEvent({ kind: 'watchdog-capped', sessionId, reloads });
        await showWatchdogNotice(sessionId).then(() => onEvent({ kind: 'notice', sessionId }), (err) => log(`notice failed: ${err.message}`));
        return;
      }
      await cdp.send('Page.reload', { ignoreCache: false }, { sessionId });
    }
  }

  // Puts the current mods into every attached document: the old script is removed, the new bundle registered, then the
  // page reloads so that bundle runs. A session the watchdog emptied has no script to replace; it is skipped.
  async function reloadAll() {
    refresh();
    onEvent({ kind: 'reloaded' });
    for (const entry of [...sessions.values()]) {
      if (entry.sessionId === null || entry.identifier === null) continue;
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.identifier }, { sessionId: entry.sessionId });
      const added = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bundle, worldName: WORLD }, { sessionId: entry.sessionId });
      entry.identifier = added.identifier;
      await cdp.send('Page.reload', { ignoreCache: false }, { sessionId: entry.sessionId });
    }
  }

  async function onBinding(sessionId, { name, payload, executionContextId }) {
    if (name !== BINDING) return;
    const req = parseRequest(payload, knownMods);
    if (!req.ok) {
      log(`bridge request refused: ${req.reason}`);
      return;
    }
    if (req.control) return onControl(sessionId, req);
    const reply = (body) =>
      cdp
        .send('Runtime.evaluate', { expression: `window.__omoModsReply(${req.id}, ${J(J(body))})`, contextId: executionContextId }, { sessionId })
        .catch(() => onEvent({ kind: 'binding-lost', sessionId, mod: req.mod }));
    try {
      const value = await hostHandle(req.mod, req.method, req.args);
      onEvent({ kind: 'call', sessionId, mod: req.mod, method: req.method });
      await reply({ ok: true, value });
    } catch (err) {
      if (err.hostFailed) onEvent({ kind: 'host-failed', sessionId, mod: req.mod, detail: String(err.message) });
      await reply({ ok: false, error: String(err.message) });
    }
  }

  async function attach(info) {
    if (!isMainTarget(info, rule) || sessions.has(info.targetId)) {
      if (info.type === 'page' && !isMainTarget(info, rule)) log(`page not main: ${info.url}`);
      return;
    }
    const entry = { sessionId: null, identifier: null, contextId: null };
    sessions.set(info.targetId, entry);
    if (!(await ownerOk())) {
      sessions.delete(info.targetId);
      onEvent({ kind: 'owner-mismatch', targetId: info.targetId });
      return;
    }
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
    entry.sessionId = sessionId;
    await cdp.send('Page.enable', {}, { sessionId });
    await cdp.send('Runtime.enable', {}, { sessionId });
    const { frameTree } = await cdp.send('Page.getFrameTree', {}, { sessionId });
    const { executionContextId } = await cdp.send(
      'Page.createIsolatedWorld',
      { frameId: frameTree.frame.id, worldName: WORLD, grantUniveralAccess: false },
      { sessionId },
    );
    entry.contextId = executionContextId;
    await cdp.send('Runtime.addBinding', { name: BINDING, executionContextName: WORLD }, { sessionId });
    const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: bundle, worldName: WORLD }, { sessionId });
    entry.identifier = identifier;
    const ran = await cdp.send('Runtime.evaluate', { expression: bundle, contextId: executionContextId }, { sessionId });
    if (ran.exceptionDetails) log(`bundle threw: ${ran.exceptionDetails.exception?.description ?? ran.exceptionDetails.text}`);
    onEvent({ kind: 'attached', targetId: info.targetId, sessionId });
  }

  const onAttachError = (err) => log(`attach failed: ${err.message}`);
  cdp.on('Target.targetCreated', ({ targetInfo }) => attach(targetInfo).catch(onAttachError));
  cdp.on('Target.targetInfoChanged', ({ targetInfo }) => attach(targetInfo).catch(onAttachError));
  cdp.on('Target.targetDestroyed', ({ targetId }) => sessions.delete(targetId));
  cdp.on('Inspector.detached', (_params, sessionId) => {
    for (const [targetId, s] of sessions) if (s.sessionId === sessionId) sessions.delete(targetId);
  });
  // A renderer crash keeps the session and its document script in Chromium, so the entry stays: the watchdog must act on it.
  cdp.on('Inspector.targetCrashed', (_params, sessionId) => {
    for (const s of sessions.values()) if (s.sessionId === sessionId) s.crashed = true;
  });
  cdp.on('Runtime.bindingCalled', (params, sessionId) => {
    onBinding(sessionId, params).catch((err) => log(`bridge error: ${err.message}`));
  });

  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const { targetInfos } = await cdp.send('Target.getTargets');
  log(`targets: ${targetInfos.map((t) => `${t.type} ${t.url}`).join(', ') || 'none'}`);
  for (const info of targetInfos) await attach(info);
  return {
    done,
    bundle,
    sessionOf: (targetId) => sessions.get(targetId)?.sessionId ?? null,
    contextOf: (targetId) => sessions.get(targetId)?.contextId ?? null,
    // Runs an expression in the isolated world of an attached target, over this helper's own connection.
    evaluateIsolated: async (targetId, expression) => {
      const s = sessions.get(targetId);
      const r = await cdp.send('Runtime.evaluate', { expression, contextId: s.contextId, returnByValue: true }, { sessionId: s.sessionId });
      return r.result.value;
    },
    stop: () => cdp.close(),
  };
}
