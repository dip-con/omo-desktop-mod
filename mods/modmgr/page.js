// Mods page: Settings > 모드. The loader runs this file in its isolated world as function (omoMods) { ... }
// (loader/README.md "Page API"). The first half is pure: render(view) returns the page as an HTML string with every
// value escaped, plus the helpers it uses; node tests can reach them through omoMods.expose. The second half is the
// page glue: the 모드 nav group and our item in it, the overlay over the FACTS content region, the host calls (list,
// setEnabled, shortcuts) and the loader's __reload control message. Mods do not import each other, so the nav item,
// overlay and repaint glue repeats the pattern of the other settings-page mods.

var MOD = 'modmgr';
// Settings > 모드 > 모드 관리: the group this mod builds for every mod's nav item, and its own item (mod.json nameKo).
var GROUP_LABEL = '모드';
var LABEL = '모드 관리';
// FACTS contentSelector (docs/app-facts.json): the region the other mod pages cover too.
var CONTENT_SELECTOR = 'html > body > div#root > div:nth-of-type(1) > div > div > div > main > div';
var NAV_SELECTOR = '[data-settings-nav-path]';
var MODELS_PATH = '/settings/models';
// The app's settings nav is a row of ul[data-sidebar=menu] lists (App, OmO, Workspace, About), each opened by a
// li[data-sidebar=group-label]; the sidebar footer holds one more list, with no label and no settings item.
var MENU_SELECTOR = 'ul[data-sidebar="menu"]';
var GROUP_LABEL_SELECTOR = ':scope > li[data-sidebar="group-label"]';
var NAV_MISSING_TEXT = '설정 메뉴 자리를 못 찾음';
// After [새로 고침] the loader reloads the window within a moment; if the page is still here after this, it says so.
var RELOAD_WAIT_MS = 15000;

var PENDING_TEXT = '창을 새로 고치면 적용돼요';
var CONFIRM_TEXT = '진행 중인 답변이 있으면 끊길 수 있어요. 새로 고칠까요?';

// One plain line per refusal code (mods/modmgr/host.mjs, the bridge and this page).
var ERROR_KO = {
  STALE: '다른 곳에서 바뀌었어요. 다시 불러올게요',
  LOCKED: '항상 켜 두는 모드라 끌 수 없어요',
  UNKNOWN_MOD: '설치된 모드에서 찾지 못했어요',
  BAD_FORMAT: 'mod.json에서 바꿀 켜기 값을 찾지 못했어요',
  BAD_STATE: '로더 상태 파일을 읽지 못했어요',
  BACKUP_FAILED: '백업이 원본과 달라 바꾸지 않았어요',
  VERIFY_FAILED: '쓴 내용이 다르게 읽혀 원래대로 되돌렸어요',
  BAD_ARGS: '요청 형식이 맞지 않아 처리하지 않았어요',
  UNKNOWN_METHOD: '모드 도우미가 모르는 요청이에요',
  BRIDGE_TIMEOUT: '모드 도우미가 응답하지 않아요',
  HOST_ERROR: '모드 도우미에서 오류가 났어요',
  PAGE_ERROR: '화면에서 오류가 났어요',
  RELOAD_UNAVAILABLE: '새로 고침 요청을 보내지 못했어요. 앱을 다시 켜면 적용돼요',
  RELOAD_TIMEOUT: '창이 새로 고쳐지지 않았어요. 앱을 다시 켜면 적용돼요',
};

// Lucide paths (the app's icon set), 24x24, stroke currentColor.
var ICON_PATHS = {
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  puzzle: '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414'
    + 'L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0'
    + 'L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414'
    + 'L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>',
};

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function icon(name) {
  return '<svg class="mm-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + ICON_PATHS[name] + '</svg>';
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function plain(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function errorLine(code) {
  if (has(ERROR_KO, code)) return ERROR_KO[code];
  if (/^E[A-Z0-9]+$/.test(String(code))) return '파일을 읽거나 쓰지 못했어요 (' + code + ')';
  return '처리하지 못했어요 (' + code + ')';
}

function disabledAttr(off) {
  return off ? ' disabled' : '';
}

// Chip text and tone from the host's status (mods/modmgr/host.mjs statusOf): '못 붙음' carries its reason.
function statusChip(mod) {
  var status = plain(mod.status);
  var reason = plain(mod.reasonKo);
  if (status === '못 붙음') return { text: reason ? '못 붙음: ' + reason : '못 붙음', tone: 'danger' };
  if (status === '붙음') return { text: status, tone: 'ok' };
  if (status.indexOf('붙음:') === 0) return { text: status, tone: 'warn' };
  return { text: status || '아직 확인 전', tone: 'off' };
}

// One card per well-formed list entry, switchable mods first and locked ones after them, each group in host order.
// An entry without a string id is skipped and a missing field shows as absent, so a malformed list cannot break the page.
function cardsFrom(mods) {
  var seen = {};
  var cards = [];
  (Array.isArray(mods) ? mods : []).forEach(function (m) {
    if (!isObject(m) || typeof m.id !== 'string' || m.id === '' || has(seen, m.id)) return;
    seen[m.id] = true;
    cards.push({
      id: m.id,
      name: plain(m.nameKo) || plain(m.name) || m.id,
      desc: plain(m.descriptionKo),
      locked: m.locked === true,
      enabled: typeof m.enabled === 'boolean' ? m.enabled : null,
      expected: typeof m.expected === 'string' && m.expected !== '' ? m.expected : null,
      chip: statusChip(m),
    });
  });
  return cards.filter(function (c) {
    return !c.locked;
  }).concat(cards.filter(function (c) {
    return c.locked;
  }));
}

// A switch needs a known on/off value and the hash setEnabled checks; a locked mod has none.
function switchable(card) {
  return !card.locked && card.enabled !== null && card.expected !== null;
}

// Where the nav item goes when the 모드 group cannot be built, from the app's nav paths in order: after the models
// item, else after the last item. null: the menu is missing, so no item is inserted.
function navPlan(paths) {
  if (!paths || paths.length === 0) return null;
  var i = paths.indexOf(MODELS_PATH);
  return i >= 0 ? { index: i, after: 'models' } : { index: paths.length - 1, after: 'last' };
}

function renderCard(card, view, i) {
  var nameId = 'mm-name-' + i;
  var chipId = 'mm-chip-' + i;
  var busy = view.busy && view.busy.id === card.id;
  var checked = busy ? view.busy.on : card.enabled === true;
  var msg = view.msg && view.msg.id === card.id ? view.msg : null;
  var control = '';
  if (card.locked) {
    control = '<span class="mm-locked" data-mm-locked>' + icon('lock') + '<span>항상 켜짐</span></span>';
  } else if (switchable(card)) {
    control = '<button type="button" class="mm-switch" role="switch" aria-checked="' + (checked ? 'true' : 'false') + '"'
      + ' aria-labelledby="' + nameId + '" aria-describedby="' + chipId + '" data-act="toggle" data-id="' + esc(card.id) + '"'
      + ' data-focus="sw-' + esc(card.id) + '"' + (busy ? ' aria-busy="true"' : '') + (view.busy ? ' aria-disabled="true"' : '') + '>'
      + '<span class="mm-track" aria-hidden="true"><span class="mm-thumb"></span></span></button>';
  }
  return '<article class="mm-card" role="listitem" data-mm-card="' + esc(card.id) + '" data-locked="' + (card.locked ? 'true' : 'false') + '"'
    + ' aria-labelledby="' + nameId + '">'
    + '<div class="mm-card-main">'
    + '<div class="mm-head"><h2 class="mm-name" id="' + nameId + '">' + esc(card.name) + '</h2>'
    + '<span class="mm-chip" data-tone="' + card.chip.tone + '" id="' + chipId + '" data-mm-chip>' + esc(card.chip.text) + '</span></div>'
    + (card.desc ? '<p class="mm-desc">' + esc(card.desc) + '</p>' : '')
    + (msg
      ? '<p class="mm-msg" data-mm-msg="' + esc(msg.code) + '" data-tone="' + (msg.code === 'STALE' ? 'info' : 'danger') + '"'
        + ' role="' + (msg.code === 'STALE' ? 'status' : 'alert') + '">' + icon(msg.code === 'STALE' ? 'refresh' : 'alert')
        + '<span>' + esc(errorLine(msg.code)) + '</span></p>'
      : '')
    + '</div>'
    + (control ? '<div class="mm-card-ctl">' + control + '</div>' : '')
    + '</article>';
}

// Placeholders in the loaded cards' own boxes (name line, description line, switch), so nothing moves when the list arrives.
function renderLoading() {
  var line = function (box, size) {
    return '<span class="' + box + ' mm-skel-line"><span class="mm-skel-bar mm-skel-' + size + '"></span>&nbsp;</span>';
  };
  var card = '<div class="mm-card mm-skel" aria-hidden="true"><div class="mm-card-main"><div class="mm-head">' + line('mm-name', 'm') + '</div>'
    + line('mm-desc', 'l') + '</div><div class="mm-card-ctl"><span class="mm-skel-switch"></span></div></div>';
  return '<p class="mm-sr" role="status">모드 목록을 불러오는 중이에요</p>'
    + '<div class="mm-list" aria-busy="true" data-mm-loading>' + card + card + card + '</div>';
}

function renderFailure(view) {
  var code = view.failure ? view.failure.code : 'HOST_ERROR';
  return '<div class="mm-failed" data-mm-failed="' + esc(code) + '">'
    + '<h2 class="mm-failed-title">모드 목록을 불러오지 못했어요</h2>'
    + '<p>' + esc(errorLine(code)) + '</p>'
    + '<button type="button" class="mm-btn" data-act="reload-list" data-focus="reload-list">다시 불러오기</button></div>';
}

function renderList(view) {
  var html = '<div class="mm-list" role="list" aria-label="모드 목록">' + view.cards.map(function (card, i) {
    return renderCard(card, view, i);
  }).join('') + '</div>';
  if (!view.cards.some(switchable)) html += '<p class="mm-hint" data-mm-empty>켜고 끌 수 있는 모드가 없어요. 모드를 설치하면 여기에 보여요</p>';
  return html;
}

// The reload notice sits under the list, so the row that was just switched does not move.
function renderPending(view) {
  if (!view.pending) return '';
  return '<div class="mm-notice" data-mm-notice>' + icon('refresh')
    + '<p class="mm-notice-text" role="status">' + PENDING_TEXT + '</p>'
    + '<button type="button" class="mm-btn mm-btn-primary" data-act="reload-ask" data-focus="reload-ask">지금 새로 고침</button></div>';
}

function renderConfirm(view) {
  var c = view.confirm;
  var busy = c.status === 'busy';
  return '<div class="mm-scrim" data-mm-scrim' + (c.enter ? ' data-enter' : '') + (c.leaving ? ' data-leave' : '') + '>'
    + '<div class="mm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="mm-dialog-title" aria-describedby="mm-dialog-desc" tabindex="-1"'
    + ' data-mm-dialog data-status="' + c.status + '" data-focus="dialog">'
    + '<h2 class="mm-dialog-title" id="mm-dialog-title">창 새로 고침</h2>'
    + '<p class="mm-dialog-desc" id="mm-dialog-desc">' + CONFIRM_TEXT + '</p>'
    + (c.error
      ? '<p class="mm-error" role="alert" data-mm-error="' + esc(c.error) + '">' + icon('alert') + '<span>' + esc(errorLine(c.error)) + '</span></p>'
      : '')
    + '<div class="mm-dialog-actions">'
    + '<button type="button" class="mm-btn mm-btn-primary" data-act="reload-yes" data-focus="reload-yes"' + (busy ? ' aria-busy="true"' : '')
    + disabledAttr(busy) + '>' + (busy ? '새로 고치는 중' : '새로 고침') + '</button>'
    + '<button type="button" class="mm-btn" data-act="reload-no" data-focus="reload-no"' + disabledAttr(busy) + '>취소</button>'
    + '</div></div></div>';
}

// The whole page as one HTML string. Every value that comes from the host goes through esc().
function render(view) {
  var html = '<div class="mm-page" data-mm-page tabindex="-1" role="region" aria-labelledby="mm-title" data-focus="page">'
    + '<header class="mm-top"><button type="button" class="mm-crumb" data-act="close" data-focus="crumb">설정</button>'
    + '<span class="mm-sep" aria-hidden="true">/</span><h1 class="mm-title" id="mm-title">모드</h1></header>'
    + '<div class="mm-scroll" data-mm-scroll><div class="mm-body">'
    + (view.pageError ? '<p class="mm-error" role="alert" data-mm-page-error>' + icon('alert') + '<span>' + esc(view.pageError) + '</span></p>' : '');
  if (view.status === 'loading') html += renderLoading();
  else if (view.status === 'failed') html += renderFailure(view);
  else html += renderList(view);
  html += renderPending(view) + '</div></div>' + (view.confirm ? renderConfirm(view) : '') + '</div>';
  return html;
}

var api = {
  render: render, esc: esc, navPlan: navPlan, cardsFrom: cardsFrom, statusChip: statusChip, switchable: switchable,
  errorLine: errorLine, CONTENT_SELECTOR: CONTENT_SELECTOR, ERROR_KO: ERROR_KO, NAV_MISSING_TEXT: NAV_MISSING_TEXT,
  PENDING_TEXT: PENDING_TEXT, CONFIRM_TEXT: CONFIRM_TEXT,
};
if (omoMods && typeof omoMods.expose === 'function') omoMods.expose(api);
if (typeof document === 'undefined') return;

// ---------------------------------------------------------------------------------------------------------------
// Page glue. Only our own nodes are created, moved or removed; app nodes are read, never moved, hidden or replaced.

var runtime = window.omoMods || {};
var root = document.createElement('div');
root.className = 'mm-root';
root.setAttribute('data-omo-mod-root', MOD);
root.setAttribute('data-omo-mod', MOD);
document.body.appendChild(root);

var navItem = null;
var navButton = null;
var group = null;
var view = null;
var openPath = null;
var openSeq = 0;
var pendingFocus = null;
var pendingReveal = null;
var noticeEpoch = 0;
var navMissingEpoch = -1;
var syncQueued = false;
var sizeObserver = null;
var observedContent = null;
// A switch changed since this document loaded: the notice stays, also across close and reopen, until the window reloads.
var pendingReload = false;
var reloadTimer = null;
// A node keeps its identity across repaints when this attribute names it (value included) or marks it; other nodes
// are matched by tag, in order, among their siblings without such an attribute.
var KEY_ATTRS = ['data-focus', 'id', 'data-mm-card', 'data-mm-icon', 'data-mm-msg'];
var MARK_ATTRS = ['data-mm-scrim', 'data-mm-notice', 'data-mm-loading', 'data-mm-failed', 'data-mm-empty', 'data-mm-icons', 'data-mm-rollback'];

// A page bug becomes an error line on the page (or in the loader notice when the page is closed) instead of an
// uncaught error, which would make the loader's watchdog detach every mod and reload the app.
function guarded(fn) {
  return function () {
    try {
      return fn.apply(this, arguments);
    } catch (err) {
      var text = errorLine('PAGE_ERROR') + ': ' + String(err && err.message);
      console.error('[modmgr] ' + text);
      if (view) {
        view.pageError = text;
        try {
          paint();
        } catch (again) {
          console.error('[modmgr] ' + String(again && again.message));
        }
      } else if (runtime.addIssue) {
        runtime.addIssue(text, LABEL);
      }
    }
    return undefined;
  };
}

// The settings view is found by its nav in the page as well as by the URL: the app keeps the URL at / while settings are open.
function onSettingsRoute() {
  return document.querySelector(NAV_SELECTOR) !== null || location.pathname === '/settings' || location.pathname.indexOf('/settings/') === 0;
}

function svgFrom(template) {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ['width', 'height', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'].forEach(function (name) {
    if (template.hasAttribute(name)) svg.setAttribute(name, template.getAttribute(name));
  });
  svg.setAttribute('class', String(template.getAttribute('class') || '').replace(/\blucide-[a-z0-9-]+/g, 'lucide-puzzle'));
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICON_PATHS.puzzle;
  return svg;
}

// A new element shaped like the app's row: same className, same attributes for the sidebar CSS, same child structure
// (its icon slot gets our icon, its text slot our label). Built from scratch; nothing is cloned.
function buildNavItem(anchor, holder) {
  var button = document.createElement('button');
  button.type = 'button';
  button.className = anchor.className;
  ['data-sidebar', 'data-size', 'data-slot'].forEach(function (name) {
    if (anchor.hasAttribute(name)) button.setAttribute(name, anchor.getAttribute(name));
  });
  button.setAttribute('data-active', 'false');
  button.setAttribute('aria-label', LABEL);
  button.setAttribute('title', LABEL);
  button.setAttribute('data-omo-mod-nav-button', MOD);
  var labelled = false;
  Array.prototype.forEach.call(anchor.children, function (child) {
    if (String(child.tagName).toLowerCase() === 'svg') {
      button.appendChild(svgFrom(child));
    } else if (!labelled) {
      var part = document.createElement(child.tagName.toLowerCase());
      part.className = child.className;
      part.textContent = LABEL;
      button.appendChild(part);
      labelled = true;
    }
  });
  if (!labelled) button.appendChild(document.createTextNode(LABEL));
  button.addEventListener('click', function (ev) {
    ev.stopPropagation();
  });
  omoMods.onTrusted(button, guarded(function () {
    openPage();
  }));
  var item = button;
  if (holder) {
    item = document.createElement(holder.tagName.toLowerCase());
    item.className = holder.className;
    ['data-sidebar', 'data-slot'].forEach(function (name) {
      if (holder.hasAttribute(name)) item.setAttribute(name, holder.getAttribute(name));
    });
    item.appendChild(button);
  }
  item.setAttribute('data-omo-mod-nav', MOD);
  item.setAttribute('data-omo-mod-root', MOD);
  item.setAttribute('data-omo-mod', MOD);
  item.setAttribute('data-omo-nav-order', String(omoMods.order));
  navButton = button;
  return item;
}

function removeNavItem() {
  if (navItem && navItem.parentNode) navItem.parentNode.removeChild(navItem);
}

// The notice is rebuilt on every route plan (clearIssues, then notice); the line is added again after each rebuild.
function reportNavMissing() {
  if (navMissingEpoch === noticeEpoch || !runtime.addIssue) return;
  navMissingEpoch = noticeEpoch;
  runtime.addIssue(NAV_MISSING_TEXT, LABEL);
}

// The app's last settings list: the last menu list that holds a settings item (the footer's list holds none).
function lastAppList() {
  var lists = document.querySelectorAll(MENU_SELECTOR + ':not([data-omo-mod])');
  for (var i = lists.length - 1; i >= 0; i -= 1) {
    if (lists[i].querySelector(NAV_SELECTOR)) return lists[i];
  }
  return null;
}

// A new list shaped like the app's: the list and its group label take the app's className and sidebar attributes and
// are built from scratch, like the nav item. data-omo-mod-root hides the group with this mod; data-omo-mod keeps the
// ko mod out of it.
function buildGroup(list, label) {
  var ul = document.createElement('ul');
  ul.className = list.className;
  var li = document.createElement('li');
  li.className = label.className;
  ['data-sidebar', 'data-slot'].forEach(function (name) {
    if (list.hasAttribute(name)) ul.setAttribute(name, list.getAttribute(name));
    if (label.hasAttribute(name)) li.setAttribute(name, label.getAttribute(name));
  });
  li.textContent = GROUP_LABEL;
  ul.appendChild(li);
  ul.setAttribute('aria-label', GROUP_LABEL);
  ul.setAttribute('data-omo-mods-nav', '1');
  ul.setAttribute('data-omo-mod-root', MOD);
  ul.setAttribute('data-omo-mod', MOD);
  return ul;
}

function removeGroup() {
  if (group && group.parentNode) group.parentNode.removeChild(group);
}

// The 모드 group goes right after the app's last settings list. Returns it, or null when that list or its label is
// missing: then there is no group and every mod's item stays in the fallback place after the models item.
function syncGroup() {
  var list = lastAppList();
  var label = list ? list.querySelector(GROUP_LABEL_SELECTOR) : null;
  if (!label) {
    removeGroup();
    return null;
  }
  if (!group) group = buildGroup(list, label);
  if (list.nextSibling !== group) list.parentNode.insertBefore(group, list.nextSibling);
  return group;
}

// A mod item's place among the mods' items: its data-omo-nav-order (the mod.json order), then its mod id, the order
// the loader runs the mods in. An item without a number goes after the numbered ones.
function navOrder(el) {
  var n = parseInt(el.getAttribute('data-omo-nav-order'), 10);
  return isNaN(n) ? Infinity : n;
}

function sortsAfter(el, item) {
  var a = navOrder(el);
  var b = navOrder(item);
  return a > b || (a === b && String(el.getAttribute('data-omo-mod-nav')).localeCompare(String(item.getAttribute('data-omo-mod-nav'))) > 0);
}

// The mods' items right after `start` (the group's label, or the app row in the fallback) form one run; ours goes in
// front of the first one that sorts after it, else at the end of the run. Only our own node moves, and only when it is
// not in that place yet: every mod places its item by this same rule, so all agree on one order and an item in place
// writes nothing that would wake the other mods' observers.
function placeItem(start, item) {
  var ref = start.nextSibling;
  while (ref && (ref === item || (ref.nodeType === 1 && ref.hasAttribute('data-omo-mod-nav') && !sortsAfter(ref, item)))) ref = ref.nextSibling;
  if (item.parentNode !== start.parentNode || item.nextSibling !== ref) start.parentNode.insertBefore(item, ref);
}

// Idempotent: when the group and the item already sit in their places, nothing in the DOM changes.
function syncNav() {
  if (!onSettingsRoute()) return;
  var items = document.querySelectorAll(NAV_SELECTOR);
  var plan = navPlan(Array.prototype.map.call(items, function (el) {
    return el.getAttribute('data-settings-nav-path');
  }));
  if (!plan) {
    removeGroup();
    removeNavItem();
    reportNavMissing();
    return;
  }
  var anchor = items[plan.index];
  var holder = anchor.parentElement && anchor.parentElement.tagName === 'LI' ? anchor.parentElement : null;
  var wanted = holder ? 'LI' : 'BUTTON';
  if (!navItem || navItem.tagName !== wanted) {
    removeNavItem();
    navItem = buildNavItem(anchor, holder);
    setNavActive(Boolean(view));
  }
  var shared = syncGroup();
  if (!shared) reportNavMissing();
  placeItem(shared ? shared.querySelector(GROUP_LABEL_SELECTOR) : holder || anchor, navItem);
}

function setNavActive(on) {
  if (!navButton) return;
  navButton.setAttribute('data-active', on ? 'true' : 'false');
  if (on) navButton.setAttribute('aria-current', 'page');
  else navButton.removeAttribute('aria-current');
}

function contentEl() {
  return document.querySelector(CONTENT_SELECTOR);
}

// The overlay covers the visible part of the content region; the app's nodes stay where they are.
function place() {
  var el = contentEl();
  if (!el) {
    close();
    return;
  }
  if (sizeObserver && observedContent !== el) {
    sizeObserver.disconnect();
    sizeObserver.observe(el);
    observedContent = el;
  }
  var r = el.getBoundingClientRect();
  var top = Math.max(r.top, 0);
  var left = Math.max(r.left, 0);
  root.style.top = top + 'px';
  root.style.left = left + 'px';
  root.style.width = Math.max(Math.min(r.right, window.innerWidth) - left, 0) + 'px';
  root.style.height = Math.max(Math.min(r.bottom, window.innerHeight) - top, 0) + 'px';
}

var onResize = guarded(function () {
  if (view) place();
});

var navCheckTimer = null;
var navCheckDue = false;

function sync() {
  syncQueued = false;
  if (view && location.pathname !== openPath) close();
  if (view && !document.querySelector(NAV_SELECTOR)) {
    if (navCheckDue) close();
    else if (navCheckTimer === null) navCheckTimer = setTimeout(guarded(function () {
      navCheckTimer = null;
      navCheckDue = true;
      sync();
    }), 250);
  } else {
    clearTimeout(navCheckTimer);
    navCheckTimer = null;
    navCheckDue = false;
  }
  syncNav();
  if (view) place();
}

function queueSync() {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(guarded(sync));
}

function focusKey(key) {
  var el = root.querySelector('[data-focus="' + CSS.escape(key) + '"]');
  if (!el || el.disabled) el = root.querySelector('[data-mm-dialog]') || root.querySelector('[data-mm-page]');
  if (!el || el === document.activeElement) return;
  el.focus({ preventScroll: true });
}

function nodeKey(node) {
  if (node.nodeType !== 1) return null;
  var i;
  for (i = 0; i < KEY_ATTRS.length; i += 1) {
    if (node.hasAttribute(KEY_ATTRS[i])) return KEY_ATTRS[i] + '=' + node.getAttribute(KEY_ATTRS[i]);
  }
  for (i = 0; i < MARK_ATTRS.length; i += 1) if (node.hasAttribute(MARK_ATTRS[i])) return MARK_ATTRS[i];
  return null;
}

// Brings the live element in line with the same element freshly parsed from render(view).
function patchNode(el, next) {
  var i;
  for (i = el.attributes.length - 1; i >= 0; i -= 1) {
    if (!next.hasAttribute(el.attributes[i].name)) el.removeAttribute(el.attributes[i].name);
  }
  for (i = 0; i < next.attributes.length; i += 1) {
    var a = next.attributes[i];
    if (el.getAttribute(a.name) !== a.value) el.setAttribute(a.name, a.value);
  }
  patchChildren(el, next);
}

// Children of `parent` become those of `next`: a node that shows the same thing stays (so a running transition, a
// live region, focus and scroll positions survive), the rest is removed or inserted.
function patchChildren(parent, next) {
  var olds = Array.prototype.slice.call(parent.childNodes);
  var news = Array.prototype.slice.call(next.childNodes);
  var keyed = {};
  var used = [];
  olds.forEach(function (o) {
    var k = nodeKey(o);
    if (k !== null && !has(keyed, k)) keyed[k] = o;
  });
  var match = news.map(function (n) {
    var k = nodeKey(n);
    var found = null;
    if (k !== null) {
      var o = has(keyed, k) ? keyed[k] : null;
      if (o && o.nodeName === n.nodeName && used.indexOf(o) < 0) found = o;
    } else {
      for (var j = 0; j < olds.length && !found; j += 1) {
        if (used.indexOf(olds[j]) < 0 && nodeKey(olds[j]) === null && olds[j].nodeName === n.nodeName) found = olds[j];
      }
    }
    if (found) used.push(found);
    return found;
  });
  olds.forEach(function (o) {
    if (used.indexOf(o) < 0) parent.removeChild(o);
  });
  news.forEach(function (n, at) {
    var node = match[at] || n;
    if (match[at] && node.nodeType === 1) patchNode(node, n);
    else if (match[at] && node.nodeValue !== n.nodeValue) node.nodeValue = n.nodeValue;
    var here = parent.childNodes[at] || null;
    if (here !== node) parent.insertBefore(node, here);
  });
}

// Repaint from the view: the DOM is patched to render(view), so nodes that stay keep their state.
function paint() {
  if (!view) return;
  view.pending = pendingReload;
  var active = document.activeElement;
  var key = pendingFocus || (active && root.contains(active) ? active.getAttribute('data-focus') : null);
  var scroller = root.querySelector('[data-mm-scroll]');
  var top = scroller ? scroller.scrollTop : 0;
  var fresh = document.createElement('template');
  fresh.innerHTML = render(view);
  patchChildren(root, fresh.content);
  if (view.confirm) view.confirm.enter = false;
  // A dialog that just arrived was inserted at its start values; once those are committed it transitions in.
  var entering = root.querySelector('[data-mm-scrim][data-enter]');
  if (entering) {
    entering.getBoundingClientRect();
    entering.removeAttribute('data-enter');
  }
  var next = root.querySelector('[data-mm-scroll]');
  if (next) next.scrollTop = top;
  pendingFocus = null;
  if (key) focusKey(key);
  var reveal = pendingReveal ? root.querySelector(pendingReveal) : null;
  pendingReveal = null;
  if (reveal) reveal.scrollIntoView({ block: 'nearest' });
}

// Host call that always resolves: a refusal or a bridge failure comes back as {ok: false, code}.
function request(method, args) {
  return omoMods.call(method, args).then(function (value) {
    return isObject(value) ? value : { ok: false, code: 'HOST_ERROR', message: 'empty reply' };
  }, function (err) {
    var code = err && err.message === 'BRIDGE_TIMEOUT' ? 'BRIDGE_TIMEOUT' : 'HOST_ERROR';
    return { ok: false, code: code, message: String(err && err.message) };
  });
}

// Reads the list again; `before` runs on the fresh view just before it is painted.
function loadList(before) {
  var seq = openSeq;
  request('list', []).then(guarded(function (r) {
    if (!view || seq !== openSeq) return;
    if (r.ok === true && Array.isArray(r.mods)) {
      view.status = 'ready';
      view.cards = cardsFrom(r.mods);
      view.failure = null;
    } else {
      view.status = 'failed';
      view.cards = [];
      view.failure = { code: r.ok === true ? 'HOST_ERROR' : String(r.code || 'HOST_ERROR') };
    }
    if (before) before();
    paint();
  }));
}

function openPage() {
  if (view) {
    pendingFocus = 'page';
    paint();
    return;
  }
  openSeq += 1;
  openPath = location.pathname;
  view = { status: 'loading', cards: [], failure: null, busy: null, msg: null, pending: pendingReload, confirm: null, pageError: null };
  root.setAttribute('data-open', '');
  setNavActive(true);
  sizeObserver = new ResizeObserver(onResize);
  observedContent = null;
  place();
  pendingFocus = 'page';
  paint();
  loadList();
}

function close() {
  if (!view) return;
  clearTimeout(navCheckTimer);
  navCheckTimer = null;
  navCheckDue = false;
  clearTimeout(reloadTimer);
  openSeq += 1;
  view = null;
  openPath = null;
  pendingFocus = null;
  root.removeAttribute('data-open');
  root.innerHTML = '';
  root.style.cssText = '';
  setNavActive(false);
  if (sizeObserver) sizeObserver.disconnect();
  sizeObserver = null;
  observedContent = null;
}

function leave() {
  close();
  if (navButton && navButton.isConnected) navButton.focus();
}

function cardById(id) {
  for (var i = 0; i < view.cards.length; i += 1) if (view.cards[i].id === id) return view.cards[i];
  return null;
}

// The switch moves at once; setEnabled writes with the hash the list showed. An edit made elsewhere in between comes
// back as STALE: the switch moves back, the card says so and the list is read again (new hashes); the switches wait
// for that list, since a switch with the old hash could only be refused again.
function toggle(id) {
  if (view.status !== 'ready' || view.busy || view.confirm) return;
  var card = cardById(id);
  if (!card || !switchable(card)) return;
  var seq = openSeq;
  var on = !card.enabled;
  view.busy = { id: id, on: on };
  view.msg = null;
  paint();
  request('setEnabled', [{ id: id, on: on, expected: card.expected }]).then(guarded(function (r) {
    if (!view || seq !== openSeq) return;
    if (r.ok === true) {
      pendingReload = true;
      pendingReveal = '[data-mm-notice]';
      paint();
      loadList(function () {
        view.busy = null;
      });
      return;
    }
    view.msg = { id: id, code: String(r.code || 'HOST_ERROR') };
    if (r.code === 'STALE') {
      view.busy = { id: id, on: card.enabled };
      paint();
      loadList(function () {
        view.busy = null;
      });
      return;
    }
    view.busy = null;
    paint();
  }));
}

function reloadPage() {
  view.status = 'loading';
  view.failure = null;
  paint();
  loadList();
}

// Runs fn once el and its subtree have no running transition or animation left, or el has left the page. Anything
// over 60 s counts as endless and is not waited for. It looks again when they finish and every 250 ms.
function afterMotion(el, fn) {
  var running = el.isConnected ? el.getAnimations({ subtree: true }).filter(function (a) {
    var timing = a.effect && a.effect.getComputedTiming();
    return Boolean(timing) && timing.endTime < 60000 && a.playState !== 'finished';
  }) : [];
  if (running.length === 0) {
    fn();
    return;
  }
  Promise.race([Promise.all(running.map(function (a) {
    return a.finished.then(null, function () {});
  })), new Promise(function (resolve) {
    setTimeout(resolve, 250);
  })]).then(function () {
    afterMotion(el, fn);
  });
}

// [지금 새로 고침] asks first; nothing reloads without the confirmation.
function askReload() {
  if (view.confirm || !pendingReload) return;
  view.confirm = { status: 'ready', error: null, enter: true, leaving: false };
  pendingFocus = 'dialog';
  paint();
}

// The dialog leaves the way it came in (data-leave sets the start values again); the node stays until that ends.
function closeDialog(focus) {
  var c = view.confirm;
  if (!c) return;
  clearTimeout(reloadTimer);
  var done = guarded(function () {
    if (!view || view.confirm !== c) return;
    view.confirm = null;
    pendingFocus = focus;
    paint();
  });
  if (!root.querySelector('[data-mm-scrim]')) {
    done();
    return;
  }
  if (c.leaving) return;
  c.leaving = true;
  paint();
  afterMotion(root.querySelector('[data-mm-scrim]'), done);
}

function cancelReload() {
  var c = view.confirm;
  if (!c || c.status === 'busy' || c.leaving) return;
  closeDialog('reload-ask');
}

// The loader's control message (loader/inject.mjs CONTROL_METHODS): __reload rebuilds the bundle from the
// current mod.json files and reloads the window with it, so the switches take effect in that very reload. It goes
// through the bridge binding with id 0, the same frame page-runtime.js uses for its own control messages.
function confirmReload() {
  var c = view.confirm;
  if (!c || c.status === 'busy' || c.leaving) return;
  var send = window.__omoModsCall;
  c.error = null;
  if (typeof send !== 'function') {
    c.error = 'RELOAD_UNAVAILABLE';
    pendingFocus = 'dialog';
    paint();
    return;
  }
  c.status = 'busy';
  pendingFocus = 'dialog';
  paint();
  try {
    send(JSON.stringify({ id: 0, mod: '*', method: '__reload', args: [] }));
  } catch (err) {
    c.status = 'ready';
    c.error = 'RELOAD_UNAVAILABLE';
    pendingFocus = 'dialog';
    paint();
    return;
  }
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(guarded(function () {
    if (!view || view.confirm !== c || c.status !== 'busy') return;
    c.status = 'ready';
    c.error = 'RELOAD_TIMEOUT';
    pendingFocus = 'dialog';
    paint();
  }), RELOAD_WAIT_MS);
}

function act(name, el) {
  if (name === 'toggle') toggle(el.getAttribute('data-id'));
  else if (name === 'reload-ask') askReload();
  else if (name === 'reload-yes') confirmReload();
  else if (name === 'reload-no') cancelReload();
  else if (name === 'reload-list') reloadPage();
  else if (name === 'close') leave();
}

// One delegated handler for every button on the page. It is registered through omoMods.onTrusted, so a scripted
// element.click() (isTrusted false) never reaches act(): no write and no reload starts without a real user action.
omoMods.onTrusted(root, guarded(function (ev) {
  if (!view) return;
  var t = ev.target;
  if (t.hasAttribute && t.hasAttribute('data-mm-scrim')) {
    cancelReload();
    return;
  }
  var el = t.closest ? t.closest('[data-act]') : null;
  if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && root.contains(el)) act(el.getAttribute('data-act'), el);
}));

// Tab stays inside the dialog while it is open.
function trapTab(ev) {
  var dialog = root.querySelector('[data-mm-dialog]');
  if (!dialog) return;
  var items = Array.prototype.filter.call(dialog.querySelectorAll('button'), function (el) {
    return !el.disabled;
  });
  var active = document.activeElement;
  if (items.length === 0) {
    ev.preventDefault();
    dialog.focus();
  } else if (ev.shiftKey && (active === items[0] || active === dialog || !dialog.contains(active))) {
    ev.preventDefault();
    items[items.length - 1].focus();
  } else if (!ev.shiftKey && (active === items[items.length - 1] || !dialog.contains(active))) {
    ev.preventDefault();
    items[0].focus();
  }
}

// Keys reach this handler only while focus is inside our page: Escape closes the dialog, Tab stays in it.
root.addEventListener('keydown', guarded(function (ev) {
  if (!view || !view.confirm) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    ev.stopPropagation();
    cancelReload();
  } else if (ev.key === 'Tab') {
    trapTab(ev);
  }
}));

// Any app settings item, the settings back crumb or another mod's nav item leaves our page, so two mod pages never
// lie over each other.
document.addEventListener('click', guarded(function (ev) {
  var t = ev.target;
  if (!view || !t || !t.closest) return;
  var other = t.closest('[data-omo-mod-nav-button]');
  if (t.closest('[data-settings-nav-path], [data-settings-back]') || (other && other.getAttribute('data-omo-mod-nav-button') !== MOD)) close();
}), true);
window.addEventListener('popstate', guarded(sync));
window.addEventListener('resize', onResize);

new MutationObserver(guarded(function (records) {
  var outside = false;
  for (var i = 0; i < records.length; i += 1) {
    var t = records[i].target;
    if (t.id === 'omo-mods-badge' && /^모드 \d+개 켜짐$/.test(t.textContent)) noticeEpoch += 1;
    if (!root.contains(t)) outside = true;
  }
  if (outside) queueSync();
})).observe(document.documentElement, { childList: true, subtree: true });

queueSync();
