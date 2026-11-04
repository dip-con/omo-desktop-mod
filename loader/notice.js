// Notice for the page: a small badge at the bottom right that collapses to a short label 5 s after it shows the
// count, and an issue list (one line per reason code) that opens on click. Appended to body, never inside #root.
(function () {
  var REASON_TEXT = {
    ANCHOR_MISSING: '자리를 못 찾아 {name}을(를) 껐어요',
    UNKNOWN_BUILD: '시험 안 한 버전이지만 자리가 있어 {name}을(를) 켰어요',
    DISABLED: '{name}은(는) 꺼 둔 모드예요',
    BAD_FORMAT: '{name}의 mod.json 형식이 틀려 건너뛰었어요',
    BAD_FILES: '{name}의 파일을 읽지 못해 건너뛰었어요',
    MOD_ERROR: '{name}에서 오류가 나서 멈췄어요',
    WATCHDOG: '화면이 비어 모든 모드를 떼고 다시 열었어요',
    OMO_PROFILE_SET: 'OMO_PROFILE이 설정돼 있어 프로필 저장을 막았어요',
  };
  var issues = [];
  var badge = null;
  var collapseTimer = null;

  function lineFor(reason, name) {
    return (REASON_TEXT[reason] || reason).replace('{name}', name);
  }

  function ensureBadge() {
    if (badge) return badge;
    badge = document.createElement('div');
    badge.id = 'omo-mods-badge';
    badge.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483000;padding:6px 10px;border-radius:8px;background:#222;color:#fff;font:12px sans-serif;cursor:pointer';
    badge.addEventListener('click', function () {
      badge.setAttribute('data-expanded', 'true');
      badge.setAttribute('data-issues', String(issues.length));
      badge.textContent = issues.length ? issues.join(' / ') : '문제 없음';
    });
    document.body.appendChild(badge);
    return badge;
  }

  window.omoMods.banner = function (text, state) {
    var el = ensureBadge();
    el.textContent = text;
    el.setAttribute('data-omo-state', state);
  };

  window.omoMods.notice = function (attachedCount) {
    var el = ensureBadge();
    var label = '모드 ' + attachedCount + '개 켜짐';
    el.textContent = label;
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = setTimeout(function () {
      collapseTimer = null;
      if (el.getAttribute('data-expanded') === 'true') return;
      el.setAttribute('data-collapsed', 'true');
      el.textContent = '모드';
    }, 5000);
  };

  window.omoMods.clearIssues = function () {
    issues = [];
  };

  window.omoMods.addIssue = function (reason, name) {
    issues.push(lineFor(reason, name));
  };
})();
