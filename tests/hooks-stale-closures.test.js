// react-hooks/exhaustive-deps cleanup (2026-09-29). Mount-only listeners must not
// run mount-time closures, the global shortcut effect must re-subscribe on every
// state field it reads, and every remaining lint suppression must say why.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('every exhaustive-deps suppression carries a specific reason', () => {
  const lines = html.split('\n').filter((l) => l.includes('eslint-disable-next-line react-hooks/exhaustive-deps'));
  assert.ok(lines.length > 50, 'expected the documented suppressions, got ' + lines.length);
  for (const l of lines) {
    const m = l.match(/exhaustive-deps -- (.+)$/);
    assert.ok(m && m[1].trim().length >= 15, 'suppression without a reason: ' + l.trim());
  }
});

test('mount-only listeners go through refs, not mount-time closures', () => {
  assert.match(html, /maybeScopeRef\.current = maybeScopeThenProcess;/);
  assert.match(html, /maybeScopeRef\.current\(f\);/);
  assert.match(html, /redrawRef\.current = redraw;[\s\S]{0,400}redrawRef\.current\(\);/);
  assert.match(html, /sendRef\.current = send;[\s\S]{0,400}sendRef\.current\(text\);/);
});

test('view cube reads the current theme (themeRef) in hover repaint', () => {
  assert.match(html, /var themeRef = useRef\(theme\); themeRef\.current = theme;/);
  assert.match(html, /var light = themeRef\.current==='light';/);
  assert.match(html, /faceClr\(\)\[FACES\[fi\]\.label\]/);
});

test('global shortcut effect re-subscribes on selection and walk-placing changes', () => {
  assert.match(html, /s\.clashes, s\.issues, s\.selected, s\.walkPlacing\]\);/);
});

test('VirtualList does not mint a fresh models array every render', () => {
  assert.match(html, /models=props\.models\|\|_VL_NO_MODELS;/);
});
