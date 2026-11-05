// 설정 > 모드: the page of the built-in modmgr mod. The loader runs this file in its isolated world as
// function (omoMods) { ... } with omoMods = { call(method, args), onTrusted(el, fn), expose(obj) }.
// Part 1 is pure: render(view) returns the whole page as one HTML string with every host value escaped, plus the
// helpers it uses; node tests reach them through omoMods.expose, and without a document the file returns there.
// Part 2 is the page glue: our item and its 모드 group in the app's settings sidebar, the overlay over the settings
// content, the host calls (list, setEnabled, checkUpdates, applyUpdates) and the loader's __reload control message.
// App nodes are read, never moved, changed or cloned.

var MOD = 'modmgr';
var LABEL = '모드 관리';
var GROUP_LABEL = '모드';
// Our place among the mods' nav items: this mod's mod.json order (items sort by it, then by mod id).
var NAV_ORDER = 0;
// The app's settings view: its nav rows, the menu lists they sit in, and the content region our page covers.
var NAV_SELECTOR = '[data-settings-nav-path]';
var MENU_SELECTOR = 'ul[data-sidebar="menu"]';
var GROUP_LABEL_SELECTOR = ':scope > li[data-sidebar="group-label"]';
var CONTENT_SELECTOR = 'html > body > div#root > div:nth-of-type(1) > div > div > div > main > div';
var MODELS_PATH = '/settings/models';
// The settings nav may re-render for a moment; the page closes only once the nav has stayed gone this long.
var NAV_GRACE_MS = 250;
// After [새로 고침] the loader reloads the window within a moment; past this the dialog says it did not happen.
var RELOAD_WAIT_MS = 15000;

var TEXT = {
  crumb: '설정',
  title: '모드',
  listLabel: '모드 목록',
  loading: '모드 목록을 불러오는 중이에요',
  failed: '모드 목록을 불러오지 못했어요',
  retry: '다시 불러오기',
  empty: '켜고 끌 수 있는 모드가 없어요. 모드를 설치하면 여기에 보여요',
  locked: '항상 켜짐',
  pending: '창을 새로 고치면 적용돼요',
  reloadNow: '지금 새로 고침',
  confirmTitle: '창 새로 고침',
  confirm: '진행 중인 답변이 있으면 끊길 수 있어요. 새로 고칠까요?',
  reload: '새로 고침',
  reloading: '새로 고치는 중',
  cancel: '취소',
  updateTitle: '업데이트',
  updateDesc: '설치 원본과 비교해 바뀐 모드를 가져와요',
  updateEmpty: '확인할 모드가 없어요. 설치 기록에 원본이 적힌 모드가 없어요',
  updateRows: '업데이트 확인 결과',
  check: '업데이트 확인',
  checking: '확인하는 중',
  apply: '업데이트 적용',
  applying: '적용하는 중',
  checkingNow: '업데이트를 확인하는 중이에요',
  applyingNow: '업데이트를 적용하는 중이에요',
  allLatest: '모든 모드가 최신이에요',
};

// One plain line per refusal code (mods/modmgr/host.mjs, the bridge and this page).
var ERROR_KO = {
  STALE: '다른 곳에서 바뀌었어요. 다시 불러올게요',
  LOCKED: '항상 켜 두는 모드라 끌 수 없어요',
  UNKNOWN_MOD: '설치된 모드에서 찾지 못했어요',
  BAD_FORMAT: 'mod.json에서 바꿀 켜기 값을 찾지 못했어요',
  BAD_STATE: '로더 상태 파일을 읽지 못했어요',
  BAD_ARGS: '요청 형식이 맞지 않아 처리하지 않았어요',
  UNKNOWN_METHOD: '모드 도우미가 모르는 요청이에요',
  BRIDGE_TIMEOUT: '모드 도우미가 응답하지 않아요',
  HOST_ERROR: '모드 도우미에서 오류가 났어요',
  PAGE_ERROR: '화면에서 오류가 났어요',
  RELOAD_UNAVAILABLE: '새로 고침 요청을 보내지 못했어요. 앱을 다시 켜면 적용돼요',
  RELOAD_TIMEOUT: '창이 새로 고쳐지지 않았어요. 앱을 다시 켜면 적용돼요',
  NO_INSTALL_RECORD: '설치 기록(install.json)을 읽지 못했어요',
};

// One row's status after [업데이트 확인], then after [업데이트 적용].
var UPDATE_STATUS = {
  latest: '최신', changed: '새 버전 있음', checkFailed: '확인 실패: ',
  applied: '적용됨', skipped: '바뀐 게 없어요', applyFailed: '적용 실패: ',
};
// Names for ids without a mod card; any other id shows as itself.
var UPDATE_NAMES = { _loader: '로더' };
// The update module's error texts, first match wins: [pattern, line, keepDetail]. The detail in brackets is the
// match's group 1 when it has one, else the whole text; none when keepDetail is false.
var UPDATE_ERRORS = [
  [/^APPLY_FAILED:\s*([\s\S]*)$/, '파일을 바꾸지 못했어요'],
  [/^no install source recorded for\b/, '설치 원본이 기록돼 있지 않아요', false],
  [/^source folder not found:\s*([\s\S]*)$/, '설치 원본 폴더를 찾지 못했어요'],
  [/^unknown source type\b/, '설치 원본 종류를 알 수 없어요'],
  [/^[\w.-]+\/[\w.-]+@\S+:\s/, '원본 저장소에서 가져오지 못했어요'],
  [/fetch failed|abort|timed? ?out|ENOTFOUND|ECONN|EAI_AGAIN/i, '원본 저장소에 연결하지 못했어요'],
  [/^E[A-Z]+:\s*([\s\S]*)$/, '설치 원본을 읽지 못했어요'],
];

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

// A refusal code as one plain line; a host error carries its message in brackets.
function errorLine(code, detail) {
  var line = has(ERROR_KO, code) ? ERROR_KO[code]
    : /^E[A-Z0-9]+$/.test(String(code)) ? '파일을 읽거나 쓰지 못했어요 (' + code + ')'
      : '처리하지 못했어요 (' + code + ')';
  return code === 'HOST_ERROR' && plain(detail) ? line + ' (' + plain(detail) + ')' : line;
}

// Chip text and tone from the host's status (host.mjs statusOf): 못 붙음 carries its reason.
function statusChip(mod) {
  var status = plain(mod.status);
  var reason = plain(mod.reasonKo);
  if (status === '못 붙음') return { text: reason ? '못 붙음: ' + reason : status, tone: 'danger' };
  if (status === '붙음') return { text: status, tone: 'ok' };
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
      desc: plain(m.description),
      locked: m.locked === true,
      enabled: typeof m.enabled === 'boolean' ? m.enabled : null,
      expected: typeof m.expected === 'string' && m.expected !== '' ? m.expected : null,
      chip: statusChip(m),
    });
  });
  return cards.filter(function (c) { return !c.locked; }).concat(cards.filter(function (c) { return c.locked; }));
}

// A switch needs a known on/off value and the hash setEnabled checks; a locked mod has none.
function switchable(card) {
  return !card.locked && card.enabled !== null && card.expected !== null;
}

// Where our nav item goes when the 모드 group cannot be built, from the app's nav paths in order: after the models
// row, else after the last row. null: the nav is missing, so no item is inserted.
function navPlan(paths) {
  if (!paths || paths.length === 0) return null;
  var i = paths.indexOf(MODELS_PATH);
  return i >= 0 ? { index: i, after: 'models' } : { index: paths.length - 1, after: 'last' };
}

// ---- Rendering ------------------------------------------------------------------------------------------------
// Every element that must keep its identity across repaints carries data-k (unique among its siblings); the page glue
// patches the live DOM to the fresh render by these keys, so a running transition, a live region, focus and scroll stay.

// A line that says what happened: tone info (a status) or danger (an alert), with its icon.
function renderLine(tone, text, key, code) {
  return '<p class="mm-line" data-tone="' + tone + '" role="' + (tone === 'danger' ? 'alert' : 'status') + '" data-k="' + esc(key) + '"'
    + (code ? ' data-code="' + esc(code) + '"' : '') + '>' + icon(tone === 'danger' ? 'alert' : 'refresh') + '<span>' + esc(text) + '</span></p>';
}

// A button whose label and busy label share one slot, so its box keeps its size while a call runs. A waiting button is
// aria-disabled (the click handler skips it) rather than disabled, so focus stays where it is.
function renderButton(act, label, opts) {
  var o = opts || {};
  return '<button type="button" class="mm-btn' + (o.primary ? ' mm-btn-primary' : '') + '" data-act="' + act + '" data-k="' + act + '"'
    + (o.busy ? ' aria-busy="true"' : '') + (o.off ? ' aria-disabled="true"' : '') + '>'
    + (o.busyLabel
      ? '<span class="mm-btn-swap"><span' + (o.busy ? ' data-off' : '') + '>' + label + '</span><span' + (o.busy ? '' : ' data-off') + '>' + o.busyLabel + '</span></span>'
      : label)
    + '</button>';
}

function renderCard(card, view, i) {
  var nameId = 'mm-name-' + i;
  var chipId = 'mm-chip-' + i;
  var busy = view.busy && view.busy.id === card.id;
  var checked = busy ? view.busy.on : card.enabled === true;
  var msg = view.msg && view.msg.id === card.id ? view.msg : null;
  var control = '';
  if (card.locked) {
    control = '<span class="mm-locked">' + icon('lock') + '<span>' + TEXT.locked + '</span></span>';
  } else if (switchable(card)) {
    control = '<button type="button" class="mm-switch" role="switch" aria-checked="' + (checked ? 'true' : 'false') + '"'
      + ' aria-labelledby="' + nameId + '" aria-describedby="' + chipId + '" data-act="toggle" data-id="' + esc(card.id) + '" data-k="sw:' + esc(card.id) + '"'
      + (busy ? ' aria-busy="true"' : '') + (view.busy ? ' aria-disabled="true"' : '') + '>'
      + '<span class="mm-track" aria-hidden="true"><span class="mm-thumb"></span></span></button>';
  }
  return '<article class="mm-card" role="listitem" data-k="card:' + esc(card.id) + '" aria-labelledby="' + nameId + '">'
    + '<div class="mm-card-main">'
    + '<div class="mm-head"><h2 class="mm-name" id="' + nameId + '">' + esc(card.name) + '</h2>'
    + '<span class="mm-chip" data-tone="' + card.chip.tone + '" id="' + chipId + '">' + esc(card.chip.text) + '</span></div>'
    + (card.desc ? '<p class="mm-desc">' + esc(card.desc) + '</p>' : '')
    + (msg ? renderLine(msg.code === 'STALE' ? 'info' : 'danger', errorLine(msg.code, msg.message), 'msg:' + card.id, msg.code) : '')
    + '</div>'
    + (control ? '<div class="mm-card-ctl">' + control + '</div>' : '')
    + '</article>';
}

// Placeholders in the loaded cards' own boxes (name line, description line, switch), so nothing moves when the list arrives.
function renderLoading() {
  var line = function (box, size) {
    return '<span class="' + box + ' mm-skel-line"><span class="mm-skel-bar mm-skel-' + size + '"></span>&nbsp;</span>';
  };
  var card = '<div class="mm-card" aria-hidden="true"><div class="mm-card-main"><div class="mm-head">' + line('mm-name', 'm') + '</div>'
    + line('mm-desc', 'l') + '</div><div class="mm-card-ctl"><span class="mm-skel-switch"></span></div></div>';
  return '<p class="mm-sr" role="status">' + TEXT.loading + '</p><div class="mm-list" aria-busy="true" data-k="loading">' + card + card + card + '</div>';
}

function renderFailure(view) {
  var f = view.failure || { code: 'HOST_ERROR' };
  return '<div class="mm-failed" data-k="failed" data-code="' + esc(f.code) + '"><h2 class="mm-failed-title">' + TEXT.failed + '</h2>'
    + '<p>' + esc(errorLine(f.code, f.message)) + '</p>' + renderButton('reload-list', TEXT.retry) + '</div>';
}

function renderList(view) {
  var html = '<div class="mm-list" role="list" aria-label="' + TEXT.listLabel + '" data-k="list">'
    + view.cards.map(function (card, i) { return renderCard(card, view, i); }).join('') + '</div>';
  if (!view.cards.some(switchable)) html += '<p class="mm-hint" data-k="empty">' + TEXT.empty + '</p>';
  return html;
}

// The reload notice sits under the cards, so the row that was just switched does not move.
function renderPending(view) {
  if (!view.pending) return '';
  return '<div class="mm-notice" data-k="notice">' + icon('refresh') + '<p class="mm-notice-text" role="status">' + TEXT.pending + '</p>'
    + renderButton('reload-ask', TEXT.reloadNow, { primary: true }) + '</div>';
}

// The confirm dialog over our page only. data-enter marks the first paint: the scrim is inserted at its start values
// and transitions in once the glue has committed them.
function renderConfirm(view) {
  var c = view.confirm;
  var busy = c.status === 'busy';
  return '<div class="mm-scrim" data-k="scrim"' + (c.enter ? ' data-enter' : '') + '>'
    + '<div class="mm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="mm-dialog-title" aria-describedby="mm-dialog-desc" tabindex="-1"'
    + ' data-k="dialog" data-status="' + c.status + '">'
    + '<h2 class="mm-dialog-title" id="mm-dialog-title">' + TEXT.confirmTitle + '</h2>'
    + '<p class="mm-dialog-desc" id="mm-dialog-desc">' + TEXT.confirm + '</p>'
    + (c.error ? renderLine('danger', errorLine(c.error), 'dialog-error', c.error) : '')
    + '<div class="mm-dialog-actions">'
    + renderButton('reload-yes', TEXT.reload, { primary: true, busyLabel: TEXT.reloading, busy: busy, off: busy })
    + renderButton('reload-no', TEXT.cancel, { off: busy })
    + '</div></div></div>';
}

// ---- Update card ----------------------------------------------------------------------------------------------
// Its state is view.update: phase idle | checked | applied, busy null | 'check' | 'apply', the rows of the last check,
// the refusal of a failed call, and the result of the last apply. The two flows take their page hooks as `io`, so node
// tests drive them without a document: io.request(method, args) is the always-resolving host call, io.paint() repaints,
// io.live() says whether this page open is still the one that started the call, io.guard(fn) wraps the continuation,
// and io.applied(ids) follows an apply that changed something.

function emptyUpdate() {
  return { phase: 'idle', busy: null, items: [], error: null, result: null };
}

// An update module error text as one plain line.
function updateErrorLine(text) {
  var s = plain(text);
  for (var i = 0; i < UPDATE_ERRORS.length; i += 1) {
    var m = UPDATE_ERRORS[i][0].exec(s);
    if (!m) continue;
    var detail = UPDATE_ERRORS[i][2] === false ? '' : m[1] !== undefined ? m[1].trim() : s;
    return UPDATE_ERRORS[i][1] + (detail ? ' (' + detail + ')' : '');
  }
  return s ? '처리하지 못했어요 (' + s + ')' : errorLine('HOST_ERROR');
}

// Rows from a checkUpdates reply; an entry without a string id is skipped, as in cardsFrom.
function updateItemsFrom(items) {
  var seen = {};
  var rows = [];
  (Array.isArray(items) ? items : []).forEach(function (it) {
    if (!isObject(it) || typeof it.id !== 'string' || it.id === '' || has(seen, it.id)) return;
    seen[it.id] = true;
    rows.push({ id: it.id, changed: it.changed === true, error: plain(it.error) || null });
  });
  return rows;
}

// The ids [업데이트 적용] sends: the rows with a new version and no check error.
function changedIds(update) {
  return update.items.filter(function (it) { return it.changed && it.error === null; }).map(function (it) { return it.id; });
}

function entryById(list, id) {
  for (var i = 0; i < list.length; i += 1) if (list[i].id === id) return list[i];
  return null;
}

// The applyUpdates reply with only the fields the card shows, each checked for its type.
function applyResultFrom(r) {
  var entries = function (list, key) {
    return (Array.isArray(list) ? list : []).filter(function (x) { return isObject(x) && typeof x.id === 'string'; })
      .map(function (x) { return { id: x.id, text: plain(x[key]) }; });
  };
  return {
    applied: (Array.isArray(r.applied) ? r.applied : []).filter(function (x) { return typeof x === 'string'; }),
    skipped: entries(r.skipped, 'reason'),
    errors: entries(r.errors, 'message'),
  };
}

// Chip text and tone of one row: its apply result when it went through [업데이트 적용], else its check result.
function updateRowStatus(row, result) {
  if (result) {
    if (result.applied.indexOf(row.id) >= 0) return { text: UPDATE_STATUS.applied, tone: 'ok' };
    var failed = entryById(result.errors, row.id);
    if (failed) return { text: UPDATE_STATUS.applyFailed + updateErrorLine(failed.text), tone: 'danger' };
    if (entryById(result.skipped, row.id)) return { text: UPDATE_STATUS.skipped, tone: 'off' };
  }
  if (row.error !== null) return { text: UPDATE_STATUS.checkFailed + updateErrorLine(row.error), tone: 'danger' };
  if (row.changed) return { text: UPDATE_STATUS.changed, tone: 'warn' };
  return { text: UPDATE_STATUS.latest, tone: 'ok' };
}

// Apply errors that no row's chip carries: an error for an applied row, or for an id that was not in the check.
function updateExtraErrors(update) {
  var r = update.result;
  if (!r) return [];
  return r.errors.filter(function (e) { return entryById(update.items, e.id) === null || r.applied.indexOf(e.id) >= 0; });
}

// What the card's live region says; '' when there is nothing new.
function updateStatusText(update) {
  if (update.busy === 'check') return TEXT.checkingNow;
  if (update.busy === 'apply') return TEXT.applyingNow;
  if (update.error !== null) return errorLine(update.error.code, update.error.message);
  if (update.phase === 'applied') {
    return '적용한 모드 ' + update.result.applied.length + '개' + (update.result.errors.length ? ', 실패 ' + update.result.errors.length + '개' : '');
  }
  if (update.phase === 'checked') {
    if (update.items.length === 0) return TEXT.updateEmpty;
    var changed = changedIds(update).length;
    var failed = update.items.filter(function (it) { return it.error !== null; }).length;
    return (changed ? '새 버전이 있는 모드 ' + changed + '개' : TEXT.allLatest) + (failed ? ', 확인 실패 ' + failed + '개' : '');
  }
  return '';
}

function refusalOf(r) {
  return r.ok === true ? { code: 'HOST_ERROR', message: '' } : { code: String(r.code || 'HOST_ERROR'), message: r.message };
}

// [업데이트 확인]: one checkUpdates call; its rows replace the last ones. Returns the pending promise, or null while a
// call is running.
function runUpdateCheck(view, io) {
  var u = view.update;
  if (u.busy !== null) return null;
  u.busy = 'check';
  u.error = null;
  io.paint();
  return io.request('checkUpdates', []).then(io.guard(function (r) {
    if (!io.live()) return;
    u.busy = null;
    if (r.ok === true && Array.isArray(r.items)) {
      u.phase = 'checked';
      u.items = updateItemsFrom(r.items);
      u.result = null;
    } else {
      u.error = refusalOf(r);
    }
    io.paint();
  }));
}

// [업데이트 적용]: applyUpdates for the rows with a new version. Returns the pending promise, or null while a call is
// running or when there is nothing to apply.
function runUpdateApply(view, io) {
  var u = view.update;
  var ids = u.phase === 'checked' ? changedIds(u) : [];
  if (u.busy !== null || ids.length === 0) return null;
  u.busy = 'apply';
  u.error = null;
  io.paint();
  return io.request('applyUpdates', [{ ids: ids }]).then(io.guard(function (r) {
    if (!io.live()) return;
    u.busy = null;
    if (r.ok !== true) {
      u.error = refusalOf(r);
      io.paint();
      return;
    }
    u.phase = 'applied';
    u.result = applyResultFrom(r);
    if (u.result.applied.length > 0) io.applied(u.result.applied);
    io.paint();
  }));
}

function updateName(id, view) {
  var card = entryById(view.cards, id);
  if (card) return card.name;
  return has(UPDATE_NAMES, id) ? UPDATE_NAMES[id] : id;
}

function renderUpdateRow(row, view) {
  var s = updateRowStatus(row, view.update.result);
  var name = updateName(row.id, view);
  return '<li class="mm-update-row" data-k="row:' + esc(row.id) + '"><span class="mm-update-mod">' + esc(name) + '</span>'
    + (name !== row.id ? '<span class="mm-update-id">' + esc(row.id) + '</span>' : '')
    + '<span class="mm-chip" data-tone="' + s.tone + '">' + esc(s.text) + '</span></li>';
}

// The update card under the cards: title and line, the rows of the last check with their status, errors in place, and
// the buttons at the trailing end. [업데이트 적용] shows only while a checked row has a new version.
function renderUpdate(view) {
  var u = view.update;
  var busy = u.busy !== null;
  var ids = u.phase === 'checked' ? changedIds(u) : [];
  var extra = updateExtraErrors(u);
  var rows = u.items.map(function (row) { return renderUpdateRow(row, view); }).join('');
  return '<section class="mm-card mm-update" data-k="update" data-phase="' + u.phase + '" aria-labelledby="mm-update-title">'
    + '<div class="mm-card-main">'
    + '<div class="mm-head"><h2 class="mm-name" id="mm-update-title">' + TEXT.updateTitle + '</h2></div>'
    + '<p class="mm-desc">' + TEXT.updateDesc + '</p>'
    + '<p class="mm-sr" role="status" data-k="update-status">' + esc(updateStatusText(u)) + '</p>'
    + (u.error !== null ? renderLine('danger', errorLine(u.error.code, u.error.message), 'update-error', u.error.code) : '')
    + (u.phase !== 'idle' && u.items.length === 0 && u.error === null ? '<p class="mm-hint" data-k="update-empty">' + TEXT.updateEmpty + '</p>' : '')
    + '</div>'
    + (rows ? '<ul class="mm-update-rows" role="list" aria-label="' + TEXT.updateRows + '" data-k="rows">' + rows + '</ul>' : '')
    + (extra.length
      ? '<div class="mm-update-errors" data-k="update-errors">' + extra.map(function (e, i) {
        return renderLine('danger', updateName(e.id, view) + ': ' + updateErrorLine(e.text), 'extra:' + i + ':' + e.id);
      }).join('') + '</div>'
      : '')
    + '<div class="mm-card-ctl mm-update-actions">'
    + renderButton('update-check', TEXT.check, { busyLabel: TEXT.checking, busy: u.busy === 'check', off: busy })
    + (ids.length ? renderButton('update-apply', TEXT.apply, { primary: true, busyLabel: TEXT.applying, busy: u.busy === 'apply', off: busy }) : '')
    + '</div></section>';
}

// The whole page as one HTML string. Every value that comes from the host goes through esc().
function render(view) {
  var body = view.pageError ? renderLine('danger', view.pageError, 'page-error') : '';
  if (view.status === 'loading') body += renderLoading();
  else if (view.status === 'failed') body += renderFailure(view);
  else body += renderList(view);
  body += (view.update ? renderUpdate(view) : '') + renderPending(view);
  return '<div class="mm-page" data-k="page" tabindex="-1" role="region" aria-labelledby="mm-title">'
    + '<header class="mm-top"><button type="button" class="mm-crumb" data-act="close" data-k="crumb">' + TEXT.crumb + '</button>'
    + '<span class="mm-sep" aria-hidden="true">/</span><h1 class="mm-title" id="mm-title">' + TEXT.title + '</h1></header>'
    + '<div class="mm-scroll" data-k="scroll"><div class="mm-body">' + body + '</div></div>'
    + (view.confirm ? renderConfirm(view) : '') + '</div>';
}

// Host call that always resolves: a refusal or a bridge failure comes back as {ok: false, code, message}.
function request(method, args) {
  return omoMods.call(method, args).then(function (value) {
    return isObject(value) ? value : { ok: false, code: 'HOST_ERROR', message: 'empty reply' };
  }, function (err) {
    var message = String(err && err.message);
    return { ok: false, code: message === 'BRIDGE_TIMEOUT' ? 'BRIDGE_TIMEOUT' : 'HOST_ERROR', message: message };
  });
}

var api = {
  render: render, esc: esc, cardsFrom: cardsFrom, statusChip: statusChip, switchable: switchable, navPlan: navPlan,
  errorLine: errorLine, request: request, emptyUpdate: emptyUpdate, runUpdateCheck: runUpdateCheck, runUpdateApply: runUpdateApply,
  changedIds: changedIds, updateRowStatus: updateRowStatus, updateErrorLine: updateErrorLine, updateStatusText: updateStatusText,
  TEXT: TEXT, ERROR_KO: ERROR_KO, UPDATE_STATUS: UPDATE_STATUS, CONTENT_SELECTOR: CONTENT_SELECTOR,
};
if (omoMods && typeof omoMods.expose === 'function') omoMods.expose(api);
if (typeof document === 'undefined') return;

// ---- Page glue ------------------------------------------------------------------------------------------------

var root = document.createElement('div');
root.className = 'mm-root';
root.setAttribute('data-omo-mod-root', MOD);
root.setAttribute('data-omo-mod', MOD);
document.body.appendChild(root);

var view = null; // the open page's state; null while closed
var openSeq = 0; // bumped on every open and close: a reply from an earlier open changes nothing
var openPath = null;
var navItem = null;
var navButton = null;
var group = null;
var pendingFocus = null; // data-k of the element to focus after the next paint
var pendingReveal = null; // data-k of the element to scroll into view after the next paint
// A mod.json changed in this document: the notice stays, across close and reopen, until the window reloads.
var pendingReload = false;
var reloadTimer = null;
var navTimer = null;
var syncQueued = false;
var sizeObserver = null;
var observedContent = null;

// A page bug becomes an error line on the page instead of an uncaught error, which would make the loader's watchdog
// detach every mod and reload the app.
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
      }
    }
    return undefined;
  };
}

// The settings view is open: its nav is in the page, or the URL says so (the app keeps the URL at / for settings).
function onSettingsRoute() {
  return document.querySelector(NAV_SELECTOR) !== null || location.pathname === '/settings' || location.pathname.indexOf('/settings/') === 0;
}

function remove(node) {
  if (node && node.parentNode) node.parentNode.removeChild(node);
}

// Our icon in the shape of the app row's icon: the same svg attributes, our puzzle paths. Nothing is cloned.
function svgLike(template) {
  var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ['width', 'height', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'].forEach(function (name) {
    if (template.hasAttribute(name)) svg.setAttribute(name, template.getAttribute(name));
  });
  svg.setAttribute('class', String(template.getAttribute('class') || '').replace(/\blucide-[a-z0-9-]+/g, 'lucide-puzzle'));
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICON_PATHS.puzzle;
  return svg;
}

// A new row shaped like the app's: the same className and sidebar attributes, the same child structure with our icon
// and our label. `holder` is the app row's li when the rows sit in list items.
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
      button.appendChild(svgLike(child));
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
  omoMods.onTrusted(button, guarded(openPage));
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
  item.setAttribute('data-omo-nav-order', String(NAV_ORDER));
  navButton = button;
  return item;
}

// The app's last settings list: the last menu list that holds a settings row (the sidebar footer's list holds none).
function lastAppList() {
  var lists = document.querySelectorAll(MENU_SELECTOR + ':not([data-omo-mod])');
  for (var i = lists.length - 1; i >= 0; i -= 1) if (lists[i].querySelector(NAV_SELECTOR)) return lists[i];
  return null;
}

// A new list shaped like the app's, with the 모드 label: list and label take the app's className and sidebar
// attributes. data-omo-mod-root hides it with this mod; data-omo-mod keeps other mods' lookups out of it.
function buildGroup(list, label) {
  var ul = document.createElement('ul');
  var li = document.createElement('li');
  ul.className = list.className;
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

// The 모드 group goes right after the app's last settings list. null when that list or its label is missing: then
// every mod's item stays in the fallback place after the models row.
function syncGroup() {
  var list = lastAppList();
  var label = list ? list.querySelector(GROUP_LABEL_SELECTOR) : null;
  if (!label) {
    remove(group);
    return null;
  }
  if (!group) group = buildGroup(list, label);
  if (list.nextSibling !== group) list.parentNode.insertBefore(group, list.nextSibling);
  return group;
}

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
// not in that place yet, so a page in place writes nothing that would wake the other mods' observers.
function placeItem(start, item) {
  var ref = start.nextSibling;
  while (ref && (ref === item || (ref.nodeType === 1 && ref.hasAttribute('data-omo-mod-nav') && !sortsAfter(ref, item)))) ref = ref.nextSibling;
  if (item.parentNode !== start.parentNode || item.nextSibling !== ref) start.parentNode.insertBefore(item, ref);
}

// Idempotent: when the group and our item already sit in their places, nothing in the DOM changes.
function syncNav() {
  if (!onSettingsRoute()) return;
  var rows = document.querySelectorAll(NAV_SELECTOR);
  var plan = navPlan(Array.prototype.map.call(rows, function (el) { return el.getAttribute('data-settings-nav-path'); }));
  if (!plan) {
    remove(group);
    remove(navItem);
    return;
  }
  var anchor = rows[plan.index];
  var holder = anchor.parentElement && anchor.parentElement.tagName === 'LI' ? anchor.parentElement : null;
  var wanted = holder ? 'LI' : 'BUTTON';
  if (!navItem || navItem.tagName !== wanted) {
    remove(navItem);
    navItem = buildNavItem(anchor, holder);
    setNavActive(Boolean(view));
  }
  var shared = syncGroup();
  placeItem(shared ? shared.querySelector(GROUP_LABEL_SELECTOR) : holder || anchor, navItem);
}

function setNavActive(on) {
  if (!navButton) return;
  navButton.setAttribute('data-active', on ? 'true' : 'false');
  if (on) navButton.setAttribute('aria-current', 'page');
  else navButton.removeAttribute('aria-current');
}

// The overlay covers the visible part of the settings content region; the app's nodes stay where they are.
function place() {
  var el = document.querySelector(CONTENT_SELECTOR);
  if (!el) {
    console.warn('[modmgr] settings content region not found');
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

function sync() {
  syncQueued = false;
  if (view && location.pathname !== openPath) close();
  if (view && !document.querySelector(NAV_SELECTOR)) {
    // The settings view left (or is re-rendering): close once its nav has stayed gone for NAV_GRACE_MS.
    if (navTimer === null) {
      navTimer = setTimeout(guarded(function () {
        navTimer = null;
        if (view && !document.querySelector(NAV_SELECTOR)) close();
      }), NAV_GRACE_MS);
    }
  } else if (navTimer !== null) {
    clearTimeout(navTimer);
    navTimer = null;
  }
  syncNav();
  if (view) place();
}

function queueSync() {
  if (syncQueued) return;
  syncQueued = true;
  requestAnimationFrame(guarded(sync));
}

// ---- Repaint by patching: a node keeps its identity across repaints by its tag and data-k; other nodes match by tag,
// in order, among their unkeyed siblings.
function keyOf(node) {
  return node.nodeType === 1 && node.hasAttribute('data-k') ? node.nodeName + '#' + node.getAttribute('data-k') : null;
}

function patchNode(el, next) {
  var i;
  for (i = el.attributes.length - 1; i >= 0; i -= 1) if (!next.hasAttribute(el.attributes[i].name)) el.removeAttribute(el.attributes[i].name);
  for (i = 0; i < next.attributes.length; i += 1) {
    if (el.getAttribute(next.attributes[i].name) !== next.attributes[i].value) el.setAttribute(next.attributes[i].name, next.attributes[i].value);
  }
  patchChildren(el, next);
}

function patchChildren(parent, next) {
  var olds = Array.prototype.slice.call(parent.childNodes);
  var news = Array.prototype.slice.call(next.childNodes);
  var used = [];
  var picks = news.map(function (n) {
    var k = keyOf(n);
    for (var j = 0; j < olds.length; j += 1) {
      var o = olds[j];
      if (used.indexOf(o) >= 0 || o.nodeName !== n.nodeName || keyOf(o) !== k) continue;
      used.push(o);
      return o;
    }
    return null;
  });
  olds.forEach(function (o) {
    if (used.indexOf(o) < 0) parent.removeChild(o);
  });
  news.forEach(function (n, at) {
    var node = picks[at] || n;
    if (picks[at] && node.nodeType === 1) patchNode(node, n);
    else if (picks[at] && node.nodeValue !== n.nodeValue) node.nodeValue = n.nodeValue;
    if (parent.childNodes[at] !== node) parent.insertBefore(node, parent.childNodes[at] || null);
  });
}

function focusKey(key) {
  var el = root.querySelector('[data-k="' + CSS.escape(key) + '"]');
  if (!el) el = root.querySelector('[data-k="dialog"]') || root.querySelector('[data-k="page"]');
  if (el && el !== document.activeElement) el.focus({ preventScroll: true });
}

// Repaint from the view: the live DOM is patched to render(view), so nodes that stay keep their state.
function paint() {
  if (!view) return;
  view.pending = pendingReload;
  var active = document.activeElement;
  var key = pendingFocus || (active && root.contains(active) ? active.getAttribute('data-k') : null);
  var scroller = root.querySelector('[data-k="scroll"]');
  var top = scroller ? scroller.scrollTop : 0;
  var fresh = document.createElement('template');
  fresh.innerHTML = render(view);
  patchChildren(root, fresh.content);
  if (view.confirm) view.confirm.enter = false;
  // A dialog that just arrived was inserted at its start values; once those are committed it transitions in.
  var entering = root.querySelector('[data-k="scrim"][data-enter]');
  if (entering) {
    entering.getBoundingClientRect();
    entering.removeAttribute('data-enter');
  }
  scroller = root.querySelector('[data-k="scroll"]');
  if (scroller) scroller.scrollTop = top;
  pendingFocus = null;
  if (key) focusKey(key);
  var reveal = pendingReveal ? root.querySelector('[data-k="' + CSS.escape(pendingReveal) + '"]') : null;
  pendingReveal = null;
  if (reveal) reveal.scrollIntoView({ block: 'nearest' });
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
      view.failure = refusalOf(r);
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
  view = { status: 'loading', cards: [], failure: null, busy: null, msg: null, pending: pendingReload, confirm: null, pageError: null, update: emptyUpdate() };
  root.setAttribute('data-open', '');
  setNavActive(true);
  sizeObserver = new ResizeObserver(onResize);
  observedContent = null;
  place();
  if (!view) return;
  pendingFocus = 'page';
  paint();
  loadList();
}

function close() {
  if (!view) return;
  clearTimeout(navTimer);
  clearTimeout(reloadTimer);
  navTimer = null;
  reloadTimer = null;
  openSeq += 1;
  view = null;
  openPath = null;
  pendingFocus = null;
  pendingReveal = null;
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
      pendingReveal = 'notice';
      paint();
      loadList(function () {
        view.busy = null;
      });
      return;
    }
    view.msg = { id: id, code: String(r.code || 'HOST_ERROR'), message: r.message };
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

// The update card's hooks into this page. After an apply that changed something the reload notice comes up, as after
// a switch, and the list is read again (the mod.json files may have changed); a focus on the gone [업데이트 적용] moves
// to [업데이트 확인].
function updateIo() {
  var v = view;
  var seq = openSeq;
  return {
    request: request,
    paint: paint,
    guard: guarded,
    live: function () {
      return view === v && seq === openSeq;
    },
    applied: function () {
      var active = document.activeElement;
      pendingReload = true;
      pendingReveal = 'notice';
      if (active && active.getAttribute('data-k') === 'update-apply') pendingFocus = 'update-check';
      paint();
      loadList();
    },
  };
}

// [지금 새로 고침] asks first; nothing reloads without the confirmation.
function askReload() {
  if (view.confirm || !pendingReload) return;
  view.confirm = { status: 'ready', error: null, enter: true };
  pendingFocus = 'dialog';
  paint();
}

function closeDialog(focus) {
  if (!view.confirm) return;
  clearTimeout(reloadTimer);
  reloadTimer = null;
  view.confirm = null;
  pendingFocus = focus;
  paint();
}

function cancelReload() {
  if (!view.confirm || view.confirm.status === 'busy') return;
  closeDialog('reload-ask');
}

// The loader's __reload control message: it reads the mod.json files again, swaps the bundle in every attached window
// and reloads them, so the switches take effect in that very reload. It travels through the bridge binding with id 0,
// the frame the page runtime uses for its own control messages (or omoMods.reload, when the runtime offers one).
function sendReload() {
  if (typeof omoMods.reload === 'function') {
    omoMods.reload();
    return;
  }
  var send = window.__omoModsCall;
  if (typeof send !== 'function') throw new Error('RELOAD_UNAVAILABLE');
  send(JSON.stringify({ id: 0, mod: '*', method: '__reload', args: [] }));
}

function confirmReload() {
  var c = view.confirm;
  if (!c || c.status === 'busy') return;
  c.error = null;
  pendingFocus = 'dialog';
  try {
    sendReload();
  } catch (err) {
    c.error = 'RELOAD_UNAVAILABLE';
    paint();
    return;
  }
  c.status = 'busy';
  paint();
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(guarded(function () {
    reloadTimer = null;
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
  else if (name === 'close') leave();
  else if (name === 'reload-list') {
    view.status = 'loading';
    view.failure = null;
    paint();
    loadList();
  } else if (name === 'update-check' && !view.confirm) runUpdateCheck(view, updateIo());
  else if (name === 'update-apply' && !view.confirm) runUpdateApply(view, updateIo());
}

// One delegated handler for every button on the page. It is registered through omoMods.onTrusted, so a scripted
// element.click() (isTrusted false) never reaches act(): no write and no reload starts without a real user action.
omoMods.onTrusted(root, guarded(function (ev) {
  if (!view) return;
  var t = ev.target;
  if (t.nodeType === 1 && t.getAttribute('data-k') === 'scrim') {
    cancelReload();
    return;
  }
  var el = t.closest ? t.closest('[data-act]') : null;
  if (el && el.getAttribute('aria-disabled') !== 'true' && root.contains(el)) act(el.getAttribute('data-act'), el);
}));

// Tab stays inside the dialog while it is open.
function trapTab(ev) {
  var dialog = root.querySelector('[data-k="dialog"]');
  var items = dialog.querySelectorAll('button');
  var first = items[0];
  var last = items[items.length - 1];
  var active = document.activeElement;
  if (ev.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (active === last || !dialog.contains(active))) {
    ev.preventDefault();
    first.focus();
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

// Any app settings row, the settings back control or another mod's nav item leaves our page, so two mod pages never
// lie over each other.
document.addEventListener('click', guarded(function (ev) {
  var t = ev.target;
  if (!view || !t || !t.closest) return;
  var other = t.closest('[data-omo-mod-nav-button]');
  if (t.closest('[data-settings-nav-path], [data-settings-back]') || (other && other.getAttribute('data-omo-mod-nav-button') !== MOD)) close();
}), true);
window.addEventListener('popstate', guarded(sync));
window.addEventListener('resize', onResize);

// The app re-renders its settings view on its own schedule: any change outside our page re-syncs the nav and the overlay.
new MutationObserver(guarded(function (records) {
  for (var i = 0; i < records.length; i += 1) {
    if (!root.contains(records[i].target)) {
      queueSync();
      return;
    }
  }
})).observe(document.documentElement, { childList: true, subtree: true });

queueSync();
