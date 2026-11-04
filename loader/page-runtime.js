// Page side of the loader bundle. It runs only in the isolated world 'omo-mods'. Not standalone: the bundle
// (loader/inject.mjs buildBundle) declares CONFIG, routeMatches and evaluateMod in the same scope above this text.
(function () {
  var ROUTE_WAIT_MS = 5000;
  var seq = 0;
  var pending = new Map();
  var ran = {};
  var currentPath = null;
  var stopWait = null;
  window.__omoMods = true;

  function send(payload) {
    window.__omoModsCall(JSON.stringify(payload));
  }

  function banner(text, state) {
    if (window.omoMods.banner) window.omoMods.banner(text, state);
  }

  // Bridge call from a mod: resolves with the host's value, or rejects on error or after CONFIG.bridgeTimeoutMs.
  function call(mod, method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var timer = setTimeout(function () {
        pending.delete(id);
        banner('모드 도우미 연결 끊김', 'bridge-lost');
        reject(new Error('BRIDGE_TIMEOUT'));
      }, CONFIG.bridgeTimeoutMs);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      send({ id: id, mod: mod, method: method, args: args });
    });
  }

  // Called by the loader through Runtime.evaluate with the request id and a JSON reply.
  window.__omoModsReply = function (id, json) {
    var p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    var msg = JSON.parse(json);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(new Error(msg.error));
  };

  // A handler that runs only for a real user click: scripted element.click() has isTrusted false.
  function onTrusted(el, fn) {
    el.addEventListener('click', function (ev) {
      if (ev.isTrusted) fn(ev);
    });
  }

  window.omoMods = {
    call: call,
    onTrusted: onTrusted,
    omoProfile: CONFIG.omoProfile,
    forMod: function (id) {
      var order = null;
      CONFIG.mods.forEach(function (m) {
        if (m.id === id) order = m.order;
      });
      return {
        call: function (method, args) {
          return call(id, method, args);
        },
        onTrusted: onTrusted,
        // The mod's mod.json order: a page sorts its nav item among the other mods' items by it, then by id.
        order: order,
      };
    },
  };

  function watchdog(detail) {
    send({ id: 0, mod: '*', method: '__watchdog', args: [String(detail)] });
  }

  // Errors from mod code (the isolated world) after load: the loader detaches all mods and reloads the page.
  window.addEventListener('error', function (e) {
    watchdog(e && e.message);
  });
  window.addEventListener('unhandledrejection', function (e) {
    watchdog(e && e.reason && e.reason.message);
  });

  // Boot is done when the shell reports done, or when the shell has been removed after the document loaded.
  function bootDone() {
    if (document.querySelector('#boot-shell[data-boot-shell-state="done"]')) return true;
    return !document.querySelector('#boot-shell') && document.readyState === 'complete';
  }

  function ready(fn) {
    if (bootDone()) return fn();
    var check = function () {
      if (!bootDone()) return;
      mo.disconnect();
      window.removeEventListener('load', check);
      fn();
    };
    var mo = new MutationObserver(check);
    mo.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-boot-shell-state'] });
    window.addEventListener('load', check);
  }

  function present(selector) {
    return document.querySelector(selector) !== null;
  }

  // Every anchor that applies to this path is present.
  function settled(path) {
    return CONFIG.mods.every(function (m) {
      return m.anchors.every(function (a) {
        return !routeMatches(a.route, path) || present(a.selector);
      });
    });
  }

  // Hide or show a mod's own style and roots. Only the mod's own elements are touched.
  function setVisible(id, visible) {
    var style = document.querySelector('style[data-omo-mod="' + id + '"]');
    if (style) style.disabled = !visible;
    var roots = document.querySelectorAll('[data-omo-mod-root="' + id + '"]');
    for (var i = 0; i < roots.length; i += 1) roots[i].hidden = !visible;
  }

  function run(m) {
    try {
      var style = document.createElement('style');
      style.setAttribute('data-omo-mod', m.id);
      style.textContent = m.css;
      document.head.appendChild(style);
      m.run(window.omoMods.forMod(m.id));
      ran[m.id] = 'ok';
    } catch (err) {
      ran[m.id] = 'failed';
      send({ id: 0, mod: m.id, method: '__fail', args: [String(err && err.message)] });
    }
  }

  function apply(path) {
    var states = CONFIG.mods.map(function (m) {
      return evaluateMod(m, { pathname: path, buildKey: CONFIG.buildKey, present: present });
    });
    CONFIG.mods.forEach(function (m, i) {
      if (states[i].attached && ran[m.id] === undefined) run(m);
      if (ran[m.id] === 'failed') states[i] = { id: m.id, attached: false, reason: 'MOD_ERROR' };
      setVisible(m.id, states[i].attached && ran[m.id] === 'ok');
    });
    send({ id: 0, mod: '*', method: '__plan', args: [states, path] });
    if (window.omoMods.clearIssues) window.omoMods.clearIssues();
    CONFIG.reported.forEach(function (r) {
      if (window.omoMods.addIssue) window.omoMods.addIssue(r.reason, r.name);
    });
    states.forEach(function (s, i) {
      if (s.reason && window.omoMods.addIssue) window.omoMods.addIssue(s.reason, CONFIG.mods[i].name);
    });
    if (CONFIG.omoProfile && window.omoMods.addIssue) window.omoMods.addIssue('OMO_PROFILE_SET', 'profile');
    if (window.omoMods.notice) window.omoMods.notice(states.filter(function (s) { return s.attached; }).length);
    var root = document.getElementById('root');
    if (!root || root.childElementCount === 0) watchdog('root empty');
  }

  // Applies now when every anchor for this path is present; otherwise waits up to ROUTE_WAIT_MS, then applies.
  function schedule() {
    var path = location.pathname;
    if (stopWait) stopWait();
    currentPath = path;
    if (settled(path)) return apply(path);
    var obs = null;
    var timer = null;
    var finished = false;
    var cancel = function () {
      finished = true;
      clearTimeout(timer);
      if (obs) obs.disconnect();
    };
    stopWait = cancel;
    var finish = function () {
      if (finished) return;
      cancel();
      stopWait = null;
      apply(path);
    };
    obs = new MutationObserver(function () {
      if (settled(path)) finish();
    });
    obs.observe(document, { subtree: true, childList: true, attributes: true });
    timer = setTimeout(finish, ROUTE_WAIT_MS);
  }

  function checkRoute() {
    if (location.pathname !== currentPath) schedule();
  }

  // Route changes: popstate and hashchange are events; a pushState shows up as the DOM change that follows it.
  window.addEventListener('popstate', checkRoute);
  window.addEventListener('hashchange', checkRoute);

  // The bundle calls start() after notice.js has defined its functions.
  window.omoMods.start = function () {
    ready(function () {
      currentPath = location.pathname;
      schedule();
      new MutationObserver(checkRoute).observe(document, { subtree: true, childList: true, attributes: true });
    });
  };
})();
