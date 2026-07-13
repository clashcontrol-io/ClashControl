'use strict';
// Locks _ccCopyToClipboard (index.html) and its wiring into the Details
// inspector's GlobalId/Express ID rows (Wave 4 "copyable IDs" item) - these
// were shown as plain text with no way to copy the full value, e.g. to paste
// into a BCF issue search or another tool.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractCopyFn() {
  const start = src.indexOf('function _ccCopyToClipboard(text, label) {');
  assert.ok(start !== -1, '_ccCopyToClipboard not found');
  const end = src.indexOf('\n  }', start) + '\n  }'.length;
  return src.slice(start, end);
}

test('writes the exact value to the clipboard and shows a toast naming the field', async () => {
  const toasts = [];
  const writes = [];
  const fnSrc = extractCopyFn();
  const fakeNavigator = { clipboard: { writeText: (v) => { writes.push(v); return Promise.resolve().then(() => {}); } } };
  const fakeWindow = { _ccToast: (m) => toasts.push(m) };
  const fn = new Function('navigator', 'window', 'document', fnSrc + '; return _ccCopyToClipboard;')(fakeNavigator, fakeWindow, {});
  fn('1A2B3C4D-0000-0000-0000-000000000000', 'GlobalId');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(writes, ['1A2B3C4D-0000-0000-0000-000000000000']);
  assert.deepEqual(toasts, ['GlobalId copied to clipboard']);
});

test('coerces a numeric expressId to a string before copying', async () => {
  const toasts = [];
  const writes = [];
  const fnSrc = extractCopyFn();
  const fakeNavigator = { clipboard: { writeText: (v) => { writes.push(v); return Promise.resolve(); } } };
  const fakeWindow = { _ccToast: (m) => toasts.push(m) };
  const fn = new Function('navigator', 'window', 'document', fnSrc + '; return _ccCopyToClipboard;')(fakeNavigator, fakeWindow, {});
  fn(482910, 'Express ID');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(writes, ['482910']);
  assert.equal(typeof writes[0], 'string');
});

test('never throws when navigator.clipboard is unavailable and no execCommand fallback exists either', () => {
  const fnSrc = extractCopyFn();
  const fakeWindow = { _ccToast: () => {} };
  const fn = new Function('navigator', 'window', 'document', fnSrc + '; return _ccCopyToClipboard;')({}, fakeWindow, {});
  assert.doesNotThrow(() => fn('x', 'GlobalId'));
});

test('the Details inspector wires GlobalId and Express ID rows through _copyBtn/_ccCopyToClipboard', () => {
  const start = src.indexOf('function renderDetails() {');
  assert.ok(start !== -1);
  const end = src.indexOf('\n    }', start);
  const fnSrc = src.slice(start, end);
  assert.ok(/_copyBtn\(ep\.globalId,'GlobalId'\)/.test(fnSrc), 'the full (non-truncated) GlobalId row must be copyable');
  assert.ok(/_copyBtn\(ep\.expressId,'Express ID'\)/.test(fnSrc), 'the Express ID row must be copyable');
  // Present-mode's truncated GlobalId row must ALSO copy the FULL id, not the
  // truncated display text.
  assert.ok(/ep\.globalId\.slice\(0,16\)[\s\S]{0,80}_copyBtn\(ep\.globalId,'GlobalId'\)/.test(fnSrc),
    'the truncated Present-mode GlobalId must still copy the untruncated value');
});
