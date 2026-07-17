'use strict';
// REWRITE_UI_PLAN.md Phase 8 — wiring lock for the CAMERA cluster retrofit.
// Real end-to-end behavior (no overlap at any desktop width, the group
// genuinely collapsing under a forced squeeze, the "More" popover rendering
// with real content, and clicking an overflowed item through the popover
// actually changing camera mode) was verified in a real browser — this
// locks the structural wiring node:test can check without a DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const safety = readFileSync(join(__dirname, '..', 'safety-migrations.js'), 'utf8');

test('ccUiToolbarV2 flag exists and defaults off', () => {
  assert.match(safety, /ccUiToolbarV2: Object\.freeze\({ fallback: 'legacy', defaultEnabled: false }\)/);
});

test('CAMERA cluster renders ResponsiveToolGroup behind the flag, flat buttons otherwise', () => {
  const start = html.indexOf('function TopToolbar(props) {');
  const end = html.indexOf('\n  function ModeToolbar', start);
  assert.ok(start !== -1 && end !== -1, 'TopToolbar not found');
  const body = html.slice(start, end);
  assert.match(body, /toolbarV2On\s*\?\s*html`<\$\{ResponsiveToolGroup\}/);
  assert.match(body, /renderCameraItem\('orbit'\)\}\$\{renderCameraItem\('walk'\)\}\$\{renderCameraItem\('plan'\)\}\$\{renderCameraItem\('ortho'\)\}/);
});

test('both paths render through the same renderCameraItem — cannot drift out of sync', () => {
  const start = html.indexOf('function TopToolbar(props) {');
  const end = html.indexOf('\n  function ModeToolbar', start);
  const body = html.slice(start, end);
  // The flag-on branch passes renderCameraItem to ResponsiveToolGroup; the
  // flag-off branch calls it directly for all four ids. Both reference the
  // single function defined once in this component — no duplicated button
  // definitions to drift apart.
  const defCount = (body.match(/function renderCameraItem\(id\)\{/g) || []).length;
  assert.equal(defCount, 1, 'renderCameraItem must be defined exactly once');
  const useCount = (body.match(/renderCameraItem\(/g) || []).length;
  assert.ok(useCount >= 5, 'expected the definition plus 4 call sites (or the ResponsiveToolGroup prop), got ' + useCount);
});

test('ResponsiveToolGroup floors its box at a constant derived from items, not from the current fit decision', () => {
  const start = html.indexOf('function ResponsiveToolGroup(props) {');
  const end = html.indexOf('\n  // TopToolbar\'s CAMERA cluster', start);
  assert.ok(start !== -1 && end !== -1, 'ResponsiveToolGroup not found');
  const body = html.slice(start, end);
  assert.match(body, /var maxItemWidth = items\.reduce\(/);
  assert.match(body, /var worstCaseFloor = maxItemWidth \+ moreButtonWidth;/);
  assert.match(body, /minWidth:worstCaseFloor/);
  // Regression guard: the floor must NOT be computed from `fit.visible` /
  // `fit.overflow` — that was the exact closed loop that shipped and had to
  // be re-fixed (see tests/responsive-toolbar.test.js's header comment).
  assert.doesNotMatch(body, /fit\.visible\.reduce/);
});

test('the popover anchors via position:fixed + a measured rect, not position:absolute', () => {
  // Regression guard for the OTHER real bug this integration could hit: the
  // toolbar row sets overflow-y:hidden and the group sets overflow:hidden
  // (needed for shrinking) — either would clip a position:absolute popover.
  // Every other popover in this file (Measure, Home view) already uses the
  // fixed + getBoundingClientRect pattern for exactly this reason.
  const start = html.indexOf('function ResponsiveToolGroup(props) {');
  const end = html.indexOf('\n  // TopToolbar\'s CAMERA cluster', start);
  const body = html.slice(start, end);
  assert.match(body, /var popRect = moreOpen && moreBtnRef\.current \? moreBtnRef\.current\.getBoundingClientRect\(\) : null;/);
  assert.match(body, /position:'fixed',top:\(popRect\.bottom\+6\)\+'px'/);
});

test('CC_CAMERA_ITEMS covers exactly the four camera buttons renderCameraItem knows about', () => {
  assert.match(html, /var CC_CAMERA_ITEMS = \[\{id:'orbit',width:36\},\{id:'walk',width:36\},\{id:'plan',width:36\},\{id:'ortho',width:36\}\];/);
});
