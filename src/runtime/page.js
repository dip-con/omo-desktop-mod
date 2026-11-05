// In-page runtime. Runs only in the isolated world 'omo-mods', string-injected by src/loader/inject.mjs buildBundle,
// which declares CONFIG and routeMatches in the same scope above this text. Each mod's page runs as
// function (omoMods) { ... } with omoMods = { call(method, args), onTrusted(el, fn), expose(obj), reload(), order }.
// Control messages to the loader (id 0): __plan(states, pathname), __fail(err), __watchdog(detail), __reload.
(function () {
  var ROUTE_WAIT_MS = 5000;
  var REASON_TEXT = {
    ANCHOR_MISSING: '자리를 못 찾아 {name}을(를) 껐어요',
    DISABLED: '{name}은(는) 꺼 둔 모드예요',
    BAD_FORMAT: '{name}의 mod.json 형식이 틀려 건너뛰었어요',
    BAD_FILES: '{name}의 파일을 읽지 못해 건너뛰었어요',
    MOD_ERROR: '{name}에서 오류가 나서 멈췄어요',
    HOST_FAILED: '{name}의 도우미 부분이 실패했어요',
    WATCHDOG: '화면이 비어 모든 모드를 떼고 다시 열었어요',
  };
  var seq = 0;
  var pending = new Map();
  var ran = {};
  var exposed = {};
  var currentPath = null;
  var stopWait = null;
  var badge = null;
  var collapseTimer = null;
  var issues = [];
  window.__omoMods = true;

  function send(payload) {
    window.__omoModsCall(JSON.stringify(payload));
  }

  function control(mod, method, args) {
    send({ id: 0, mod: mod, method: method, args: args });
  }

  // Badge at the bottom right, appended to body (never inside #root): count, then a short label after 5 s.
  function ensureBadge() {
    if (badge) return badge;
    badge = document.createElement('div');
    badge.id = 'omo-mods-badge';
    badge.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483000;padding:6px 10px;border-radius:8px;background:#222;color:#fff;font:12px sans-serif;cursor:pointer';
    badge.addEventListener('click', function () {
      badge.setAttribute('data-expanded', 'true');
      badge.textContent = issues.length ? issues.join(' / ') : '문제 없음';
    });
    document.body.appendChild(badge);
    return badge;
  }

  function notice(text) {
    var el = ensureBadge();
    el.textContent = text;
    el.removeAttribute('data-collapsed');
    el.setAttribute('data-issues', String(issues.length));
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = setTimeout(function () {
      collapseTimer = null;
      if (el.getAttribute('data-expanded') === 'true') return;
      el.setAttribute('data-collapsed', 'true');
      el.textContent = '모드';
    }, 5000);
  }

  function setIssues(states) {
    issues = [];
    states.forEach(function (s) {
      if (s.reason) issues.push((REASON_TEXT[s.reason] || s.reason).replace('{name}', s.name));
    });
  }

  // Bridge call: resolves with the host's value, rejects on its error or after CONFIG.bridgeTimeoutMs.
  function call(mod, method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      var timer = setTimeout(function () {
        pending.delete(id);
        notice('모드 도우미 연결이 끊겼어요');
        reject(new Error('BRIDGE_TIMEOUT'));
      }, CONFIG.bridgeTimeoutMs);
      pending.set(id, { resolve: resolve, reject: reject, timer: timer });
      send({ id: id, mod: mod, method: method, args: args || [] });
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

  // A handler for real user clicks only: a scripted element.click() has isTrusted false.
  function onTrusted(el, fn) {
    el.addEventListener('click', function (ev) {
      if (ev.isTrusted) fn(ev);
    });
  }

  function apiFor(m) {
    return {
      call: function (method, args) {
        return call(m.id, method, args);
      },
      onTrusted: onTrusted,
      expose: function (obj) {
        exposed[m.id] = obj;
      },
      reload: function () {
        control(m.id, '__reload', []);
      },
      order: m.order,
    };
  }

  window.omoMods = { exposed: exposed };

  if (CONFIG.noticeOnly) {
    setIssues(CONFIG.reported);
    notice('모드 0개 켜짐');
    return;
  }

  function watchdog(detail) {
    control('*', '__watchdog', [String(detail)]);
  }

  // Errors in this isolated world come from mod code: the loader removes all mods and reloads the page.
  window.addEventListener('error', function (e) {
    watchdog(e && e.message);
  });
  window.addEventListener('unhandledrejection', function (e) {
    watchdog(e && e.reason && e.reason.message);
  });

  function present(selector) {
    return document.querySelector(selector) !== null;
  }

  function evaluate(m, path) {
    var missing = m.anchors.some(function (a) {
      return routeMatches(a.route, path) && !present(a.selector);
    });
    return { id: m.id, name: m.name, attached: !missing, reason: missing ? 'ANCHOR_MISSING' : null };
  }

  function settled(path) {
    return CONFIG.mods.every(function (m) {
      return evaluate(m, path).attached;
    });
  }

  // Shows or hides only the mod's own style and roots.
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
      m.run(apiFor(m));
      ran[m.id] = 'ok';
    } catch (err) {
      ran[m.id] = 'failed';
      control(m.id, '__fail', [String(err && err.message)]);
    }
  }

  function apply(path) {
    var states = CONFIG.mods.map(function (m) {
      var s = evaluate(m, path);
      if (s.attached && ran[m.id] === undefined) run(m);
      if (ran[m.id] === 'failed') s = { id: m.id, name: m.name, attached: false, reason: 'MOD_ERROR' };
      setVisible(m.id, s.attached);
      return s;
    });
    control('*', '__plan', [states.map(function (s) {
      return { id: s.id, attached: s.attached, reason: s.reason };
    }), path]);
    setIssues(states.concat(CONFIG.reported));
    notice('모드 ' + states.filter(function (s) { return s.attached; }).length + '개 켜짐');
    var root = document.getElementById('root');
    if (!root || root.childElementCount === 0) watchdog('root empty');
  }

  // Applies when every anchor for this path is present, or after ROUTE_WAIT_MS at the latest.
  function schedule() {
    var path = location.pathname;
    if (stopWait) stopWait();
    stopWait = null;
    currentPath = path;
    if (settled(path)) return apply(path);
    var obs = new MutationObserver(function () {
      if (settled(path)) finish();
    });
    var timer = setTimeout(finish, ROUTE_WAIT_MS);
    function cancel() {
      clearTimeout(timer);
      obs.disconnect();
    }
    function finish() {
      cancel();
      stopWait = null;
      apply(path);
    }
    stopWait = cancel;
    obs.observe(document, { subtree: true, childList: true, attributes: true });
  }

  function checkRoute() {
    if (location.pathname !== currentPath) schedule();
  }

  // Boot is done when the app's boot shell reports done, or is gone after the document loaded; an earlier empty
  // #root is the boot screen, not a broken page.
  function bootDone() {
    if (document.querySelector('#boot-shell[data-boot-shell-state="done"]')) return true;
    return !document.querySelector('#boot-shell') && document.readyState === 'complete';
  }

  // Route changes arrive as events or as the DOM change after pushState.
  function start() {
    schedule();
    window.addEventListener('popstate', checkRoute);
    window.addEventListener('hashchange', checkRoute);
    new MutationObserver(checkRoute).observe(document, { subtree: true, childList: true });
  }
  if (bootDone()) return start();
  var bootObs = new MutationObserver(waitBoot);
  function waitBoot() {
    if (!bootDone()) return;
    bootObs.disconnect();
    window.removeEventListener('load', waitBoot);
    start();
  }
  bootObs.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-boot-shell-state'] });
  window.addEventListener('load', waitBoot);
})();
