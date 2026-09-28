'use strict';
// Quick Start Guide vs the "?" ShortcutsModal used to contradict each other
// (Quick Start: "1 2 3 4 switch side panel tabs", "F fit/find elements",
// "/ opens AI chat"; sheet: 1-5 are render modes, F flips the section (or
// fits with none active), Ctrl+F finds/searches, "/" wasn't listed at all)
// — see MEMORY.md 2026-09-28. Both now read from _ccShortcutSections()/
// _ccShortcutRow(), a single source of truth built from the real keydown
// handlers. This locks that down.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('_ccShortcutSections and _ccShortcutRow are defined once, and ShortcutsModal uses them', () => {
  assert.match(src, /function _ccShortcutSections\(\)/);
  assert.match(src, /function _ccShortcutRow\(key\)/);
  assert.match(src, /var sections = _ccShortcutSections\(\);/);
});

test('the Quick Start Guide keyboard-shortcuts block reads rows via _ccShortcutRow instead of hardcoding its own text', () => {
  const start = src.indexOf('Keyboard shortcuts</div>');
  assert.ok(start !== -1);
  const end = src.indexOf('</div>\n            </div>\n          </div>', start);
  const block = src.slice(start, end === -1 ? start + 3000 : end);
  const calls = block.match(/_ccShortcutRow\('[^']+'\)/g) || [];
  assert.ok(calls.length >= 8, 'expected the Quick Start shortcuts block to pull at least 8 rows via _ccShortcutRow, found ' + calls.length);
  // The old, since-fixed contradictions must not be present verbatim any more.
  assert.doesNotMatch(block, /Switch side panel tabs/);
  assert.doesNotMatch(block, />Find elements</);
});

test('every key _ccShortcutRow is called with in the Quick Start block resolves to a real row (not silently empty)', () => {
  const start = src.indexOf('Keyboard shortcuts</div>');
  const end = src.indexOf('</div>\n            </div>\n          </div>', start);
  const block = src.slice(start, end === -1 ? start + 3000 : end);
  const keys = Array.from(block.matchAll(/_ccShortcutRow\('([^']+)'\)/g)).map((m) => m[1]);
  assert.ok(keys.length > 0);
  // Pull the row keys defined in _ccShortcutSections so we can check each
  // Quick Start lookup key actually exists there.
  const secStart = src.indexOf('function _ccShortcutSections() {');
  const secEnd = src.indexOf('\n  }\n  // Looks up a single row', secStart);
  const secBody = src.slice(secStart, secEnd);
  const definedKeys = new Set(Array.from(secBody.matchAll(/\[\s*'([^']+)',/g)).map((m) => m[1]));
  for (const key of keys) {
    assert.ok(definedKeys.has(key), 'Quick Start references shortcut key "' + key + '" which is not a row in _ccShortcutSections()');
  }
});
