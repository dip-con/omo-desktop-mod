// Pure redaction helpers for captured app DOM. No I/O.
// redactHtml replaces conversation titles, local paths, account identity and token-like strings
// with fixed markers and returns per-category counts. residualScan counts what is still visible.

const MARK = {
  path: '[redacted-path]',
  email: '[redacted-email]',
  token: '[redacted-token]',
  account: '[redacted]',
  title: '[redacted-title]',
};

// A path segment may contain one space followed by a non-space character ("내 작업"); Hangul is not excluded.
const SEG = String.raw`[^\\/\s"'<>&]`;
const WIN_PATH = new RegExp(String.raw`(?<![A-Za-z])[A-Za-z]:[\\/]+(?:(?:${SEG}|\s(?=${SEG}))+[\\/]*)*`, 'gu');
const standalone = (name) => new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
const UNIX_PATH = /\/(?:Users|home)\/[^\s"'<>&]*/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const TOKENS = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:sk|pk|ghp|gho|xox[abp])[-_][A-Za-z0-9_-]{16,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
];
const ACCOUNT_ATTR = /(\s(?:data-)?(?:user|account|email|avatar|token|session|profile)[-\w]*\s*=\s*)("[^"]*"|'[^']*')/gi;
const AVATAR_IMG = /<img\b[^>]*>/gi;

// The sidebar drag key carries the project folder name after a [redacted-path] marker: redact the whole value.
const DRAG_KEY = /(\sdata-sidebar-project-drag-key\s*=\s*)("[^"]*"|'[^']*')/gi;

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function redactHtml(html, { title = '', projectName = '', userName = '' } = {}) {
  const counts = { path: 0, email: 0, token: 0, account: 0, avatarSrc: 0, title: 0, project: 0, user: 0, dragKey: 0 };
  let out = html;
  const bump = (k) => () => {
    counts[k] += 1;
    return MARK[k] ?? '[redacted]';
  };
  out = out.replace(DRAG_KEY, (_m, lead) => {
    counts.dragKey += 1;
    return `${lead}"${MARK.account}"`;
  });
  out = out.replace(WIN_PATH, bump('path'));
  out = out.replace(UNIX_PATH, bump('path'));
  if (projectName) out = out.replace(standalone(projectName), bump('project'));
  if (userName) out = out.replace(standalone(userName), bump('user'));
  out = out.replace(EMAIL, bump('email'));
  for (const re of TOKENS) out = out.replace(re, bump('token'));
  out = out.replace(ACCOUNT_ATTR, (_m, lead) => {
    counts.account += 1;
    return `${lead}"${MARK.account}"`;
  });
  out = out.replace(AVATAR_IMG, (tag) => {
    if (!/avatar|profile|user/i.test(tag)) return tag;
    return tag.replace(/\ssrc\s*=\s*("[^"]*"|'[^']*')/gi, () => {
      counts.avatarSrc += 1;
      return ` src="${MARK.account}"`;
    });
  });
  const t = title.trim();
  if (t.length >= 2) {
    for (const needle of [t, escapeHtml(t)]) {
      const parts = out.split(needle);
      if (parts.length > 1) {
        counts.title += parts.length - 1;
        out = parts.join(MARK.title);
      }
    }
  }
  return { html: out, counts };
}

// Counts what would still reveal identity after redaction. Every value must be 0.
export function residualScan(html, { title = '', projectName = '', userName = '' } = {}) {
  const t = title.trim();
  const hits = {
    cUsersLiteral: (html.match(/C:[\\/]+Users/gi) ?? []).length,
    userInPath: (html.match(/Users[\\/]+USER(?![A-Za-z])/g) ?? []).length,
    atEmail: (html.match(EMAIL) ?? []).length,
    title: 0,
    project: projectName ? (html.match(standalone(projectName)) ?? []).length : 0,
    user: userName ? (html.match(standalone(userName)) ?? []).length : 0,
    markerWord: (html.match(/\[redacted-path\]\s*[\p{L}\p{N}]/gu) ?? []).length,
  };
  if (t.length >= 2) {
    hits.title = html.split(t).length - 1;
    if (escapeHtml(t) !== t) hits.title += html.split(escapeHtml(t)).length - 1;
  }
  return hits;
}
