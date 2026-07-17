'use strict';
// REWRITE_UI_PLAN.md Phase 8 — lock the pure priority-fit algorithm
// (_ccFitToolbarItems, index.html) that ResponsiveToolGroup uses to decide
// which toolbar items stay visible vs. move into the "More" popover.
//
// Follow-up note: the first attempt at wiring this into TopToolbar's CAMERA
// cluster hit a real flexbox shrink/overflow bug and was reverted (see the
// old comment this replaces, and MEMORY.md's Active Work history). That bug
// turned out to be twofold, root-caused and fixed in a follow-up pass with
// real-Chromium `getBoundingClientRect()` verification: (1) the reported
// "overlap" was a getBoundingClientRect() false positive — a clipped-but-
// still-laid-out child reports its full unclipped geometry even though
// overflow:hidden visually clips it — confirmed via an actual screenshot
// showing no visible collision; (2) the REAL bug living under that false
// alarm was that a bare `minWidth:0` let the group's box shrink thinner than
// what its own forced-visible active item + "More" toggle need, clipping
// both away and making the cluster unreachable. See ResponsiveToolGroup's
// `worstCaseFloor` (a constant derived from `items` alone, deliberately NOT
// from the current render's `fit` decision — an interim fix that computed
// it from `fit.visible` created a closed measurement/render feedback loop
// that permanently disabled shrinking). The integration is now live behind
// `ccUiToolbarV2` — see tests/toolbar-v2-wiring.test.js for the wiring lock.
// This file locks the algorithm itself, independent of any DOM layout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('function _ccFitToolbarItems(items, availableWidth, moreButtonWidth, activeId) {');
assert.ok(start !== -1, '_ccFitToolbarItems not found');
const end = src.indexOf('\n  var ROW_HEIGHT = 78;', start);
assert.ok(end !== -1, '_ccFitToolbarItems closing point not found');
const fit = new Function('window', src.slice(start, end) + '; return _ccFitToolbarItems;')({});

function items(n, w) {
  w = w || 36;
  return Array.from({ length: n }, (_, i) => ({ id: 'i' + i, width: w }));
}

test('everything fits: no overflow, no More button width reserved', () => {
  const r = fit(items(4), 1000, 36, null);
  assert.deepEqual(r.visible, ['i0', 'i1', 'i2', 'i3']);
  assert.deepEqual(r.overflow, []);
});

test('exact fit (total width === available): still no overflow', () => {
  const r = fit(items(4, 36), 144, 36, null);
  assert.deepEqual(r.visible, ['i0', 'i1', 'i2', 'i3']);
  assert.deepEqual(r.overflow, []);
});

test('one pixel too narrow: reserves the More button width and overflows the tail', () => {
  const r = fit(items(4, 36), 143, 36, null);
  // budget = 143 - 36 = 107 -> fits i0,i1 (72), not i2 (108 > 107)
  assert.deepEqual(r.visible, ['i0', 'i1']);
  assert.deepEqual(r.overflow, ['i2', 'i3']);
});

test('items fill in priority order (first = highest priority)', () => {
  const r = fit(items(6, 36), 100, 36, null);
  // budget = 100 - 36(More button) = 64 -> only i0 (36) fits; i0+i1 = 72 > 64
  assert.deepEqual(r.visible, ['i0']);
  assert.deepEqual(r.overflow, ['i1', 'i2', 'i3', 'i4', 'i5']);
});

test('the active item is never pushed into overflow, even if it would not otherwise fit', () => {
  const list = items(6, 36);
  const r = fit(list, 100, 36, 'i4'); // i4 is low priority but currently active
  assert.ok(r.visible.includes('i4'), 'active item must stay visible');
  assert.ok(!r.overflow.includes('i4'), 'active item must never be in overflow');
});

test('active item forced visible still keeps trying to fit others within budget', () => {
  const list = items(4, 36);
  const r = fit(list, 100, 36, 'i3');
  // i3 always included (active). Others included while used+width <= budget(64).
  assert.ok(r.visible.includes('i3'));
  assert.ok(r.visible.includes('i0'));
});

test('zero available width: only the active item (if any) stays visible, nothing else', () => {
  const r1 = fit(items(3), 0, 36, null);
  assert.deepEqual(r1.visible, []);
  assert.deepEqual(r1.overflow, ['i0', 'i1', 'i2']);
  const r2 = fit(items(3), 0, 36, 'i1');
  assert.deepEqual(r2.visible, ['i1']);
  assert.deepEqual(r2.overflow, ['i0', 'i2']);
});

test('empty item list never throws and returns empty visible/overflow', () => {
  const r = fit([], 500, 36, null);
  assert.deepEqual(r, { visible: [], overflow: [] });
});

test('negative or missing availableWidth is clamped to zero, not treated as unlimited', () => {
  const r = fit(items(3), -50, 36, null);
  assert.deepEqual(r.visible, []);
  const r2 = fit(items(3), undefined, 36, null);
  assert.deepEqual(r2.visible, []);
});
