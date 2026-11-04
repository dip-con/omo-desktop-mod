import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactHtml, residualScan } from '../tools/redact.mjs';

test('the drag-key attribute value is redacted as a whole, folder-name tail included', () => {
  const html = '<div data-sidebar-project-drag-key="abc123:[redacted-path] XY">x</div>';
  const r = redactHtml(html);
  assert.ok(!r.html.includes('XY'));
  assert.ok(r.html.includes('data-sidebar-project-drag-key="[redacted]"'));
  assert.equal(r.counts.dragKey, 1);
});

test('residualScan counts a word directly after a [redacted-path] marker', () => {
  assert.equal(residualScan('<i>[redacted-path] XY</i>').markerWord, 1);
  assert.equal(residualScan('<i>[redacted-path]</i>').markerWord, 0);
});

test('after redaction the drag-key tail leaves no marker word', () => {
  const html = '<div data-sidebar-project-drag-key="abc123:[redacted-path] XY">x</div>';
  assert.equal(residualScan(redactHtml(html).html).markerWord, 0);
});

test('redacts windows and unix local paths', () => {
  const r = redactHtml('<a data-x="C:\\Users\\alice\\.omo\\x">C:/Users/alice/a</a> /Users/alice/b');
  assert.equal(r.counts.path, 3);
  assert.ok(!/Users/.test(r.html));
});

test('keeps app URLs intact (omo:// is not a drive path)', () => {
  const r = redactHtml('<a href="omo://app/settings/general">x</a>');
  assert.equal(r.counts.path, 0);
  assert.ok(r.html.includes('omo://app/settings/general'));
});

test('redacts emails, token-like strings and account attributes', () => {
  const html = '<p>mail a.b\x40example.com</p><span data-user-id="u-123">n</span><img alt="avatar" src="https://x.test/a.png">';
  const r = redactHtml(html);
  assert.equal(r.counts.email, 1);
  assert.equal(r.counts.account, 1);
  assert.equal(r.counts.avatarSrc, 1);
  assert.ok(!r.html.includes('a.b\x40example.com'));
  assert.ok(!r.html.includes('u-123'));
});

test('redacts the conversation title, raw and HTML-escaped', () => {
  const r = redactHtml('<h1>Plan &amp; Plan</h1><title>Plan & Plan</title>', { title: 'Plan & Plan' });
  assert.equal(r.counts.title, 2);
  assert.equal(residualScan(r.html, { title: 'Plan & Plan' }).title, 0);
});

test('residual scan is zero after redaction', () => {
  const html = '<p>C:\\Users\\alice\\x a\x40b.co /Users/alice/y</p>';
  const r = redactHtml(html);
  const hits = residualScan(r.html, { title: '' });
  assert.deepEqual(hits, { cUsersLiteral: 0, userInPath: 0, atEmail: 0, title: 0, project: 0, user: 0, markerWord: 0 });
});

test('a windows path containing a space and Hangul is redacted whole', () => {
  const r = redactHtml('<p data-k="C:\\Users\\alice\\orca\\projects\\내 작업\\x">내 작업</p>', { projectName: '내 작업' });
  assert.equal(r.counts.path, 1);
  assert.equal(r.counts.project, 1);
  assert.ok(!r.html.includes('작업'));
});

test('token-like strings are redacted and counted', () => {
  const html = '<i>eyJhbGciOiJIUzI1NiJ9.abcdefghijkl.mnopqrstuvwx</i><i>sk-abcdefghijklmnopqrst</i><i>' + 'a'.repeat(40) + '</i>';
  const r = redactHtml(html);
  assert.equal(r.counts.token, 3);
  assert.ok(!r.html.includes('abcdefghijklmnopqrst'));
});

test('residual scan flags unredacted identity text', () => {
  const hits = residualScan('<p>USER 내 작업 C:\\Users\\alice\\x by USER</p>', { projectName: '내 작업', userName: 'USER' });
  assert.ok(hits.cUsersLiteral >= 1);
  assert.equal(hits.project, 1);
  assert.equal(hits.user, 2);
});

test('project folder and OS user names are redacted and no longer flagged', () => {
  const opts = { projectName: '내 작업', userName: 'USER' };
  const r = redactHtml('<p>내 작업 by USER</p>', opts);
  assert.equal(r.counts.project, 1);
  assert.equal(r.counts.user, 1);
  assert.deepEqual(residualScan(r.html, opts), { cUsersLiteral: 0, userInPath: 0, atEmail: 0, title: 0, project: 0, user: 0, markerWord: 0 });
});
