'use strict';
// Locks that NavigatorPanel actually surfaces the "Compare selected (2)"
// view when exactly two elements are multi-selected (Shift-click), and that
// PropDiffView is exposed for the pattern to be reused elsewhere later.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('the Compare section only renders when multiSel.length === 2', () => {
  const panelStart = src.indexOf('function NavigatorPanel(props) {');
  assert.ok(panelStart !== -1);
  const compareStart = src.indexOf('multiSel.length===2', panelStart);
  assert.ok(compareStart !== -1, 'Compare selected (2) block not found in NavigatorPanel');
  const nearby = src.slice(compareStart, compareStart + 700);
  assert.ok(/Compare selected \(2\)/.test(nearby));
  assert.ok(/<\$\{PropDiffView\}/.test(nearby));
});

test('the Compare view resolves both sides via _lookupElProps against s.models', () => {
  const panelStart = src.indexOf('function NavigatorPanel(props) {');
  const compareStart = src.indexOf('multiSel.length===2', panelStart);
  const nearby = src.slice(compareStart, compareStart + 700);
  assert.ok(/_lookupElProps\(s\.models, multiSel\[0\]\.modelId, multiSel\[0\]\.expressId\)/.test(nearby));
  assert.ok(/_lookupElProps\(s\.models, multiSel\[1\]\.modelId, multiSel\[1\]\.expressId\)/.test(nearby));
});

test('PropDiffView and _diffElementProps are defined and _ccDiffElementProps is exposed on window', () => {
  assert.ok(src.indexOf('function PropDiffView(props) {') !== -1);
  assert.ok(src.indexOf('window._ccDiffElementProps = _diffElementProps;') !== -1);
});
