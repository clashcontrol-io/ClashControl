'use strict';
// REWRITE_UI_PLAN.md Phase 3 — parity + correctness lock for the windowed
// conflict list's pure math (_ccBuildConflictRows/_ccComputeRowOffsets/
// _ccFindRowIndexAtOffset/_ccComputeVisibleRowWindow, index.html). These are
// the functions VirtualList calls when ccUiWindowedConflicts is enabled;
// React/Preact mounting itself isn't exercised here (that's the browser
// smoke's job), but every piece of the mounting DECISION is pure and
// extraction-tested the same way tests/severity-model.test.js locks
// _ccDeterministicSeverity.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generateConflicts } = require('./fixtures/synthetic-conflicts');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('function _groupKeyFor(it, groupKey, modelsById, spatialMap) {');
assert.ok(start !== -1, '_groupKeyFor not found');
const end = src.indexOf('window._ccComputeVisibleRowWindow = _ccComputeVisibleRowWindow;', start);
assert.ok(end !== -1, 'windowing helpers not found');
const endLineEnd = src.indexOf('\n', end) + 1;
const sandbox = new Function(
  'window',
  src.slice(start, endLineEnd) + `
  return {
    groupAndSort: groupAndSort,
    buildConflictRows: _ccBuildConflictRows,
    computeRowOffsets: _ccComputeRowOffsets,
    findRowIndexAtOffset: _ccFindRowIndexAtOffset,
    computeVisibleRowWindow: _ccComputeVisibleRowWindow,
    GROUP_PAGE_SIZE: GROUP_PAGE_SIZE,
  };`
);
const lib = sandbox({});

test('ungrouped: row list is exactly the items array, in order, one row per item', () => {
  const { items } = generateConflicts(37, { seed: 1 });
  const rows = lib.buildConflictRows(items, null, {}, {}, () => false);
  assert.equal(rows.length, items.length);
  rows.forEach((r, i) => {
    assert.equal(r.type, 'item');
    assert.equal(r.item.id, items[i].id);
    assert.equal(r.key, 'i:' + items[i].id);
  });
});

test('grouped: every group gets exactly one header row, always, even when collapsed', () => {
  const { items, models } = generateConflicts(500, { seed: 2 });
  const groups = lib.groupAndSort(items, 'storey', 'none', { models });
  const collapsedAll = {};
  groups.forEach((g) => { collapsedAll[g.label] = true; });
  const rows = lib.buildConflictRows(items, groups, collapsedAll, {}, () => false);
  assert.equal(rows.length, groups.length, 'collapsed groups contribute only their header row');
  rows.forEach((r) => assert.equal(r.type, 'header'));
});

test('grouped: expanded group contributes header + its page-limited items + a "more" row when truncated', () => {
  const { items, models } = generateConflicts(500, { seed: 3, clusterCount: 3 });
  const groups = lib.groupAndSort(items, 'discipline', 'none', { models });
  const rows = lib.buildConflictRows(items, groups, {}, {}, () => false);
  let idx = 0;
  groups.forEach((g) => {
    assert.equal(rows[idx].type, 'header');
    assert.equal(rows[idx].group.label, g.label);
    idx++;
    const limit = Math.min(g.items.length, lib.GROUP_PAGE_SIZE);
    for (let j = 0; j < limit; j++) {
      assert.equal(rows[idx].type, 'item');
      assert.equal(rows[idx].item.id, g.items[j].id);
      idx++;
    }
    if (g.items.length > lib.GROUP_PAGE_SIZE) {
      assert.equal(rows[idx].type, 'more');
      assert.equal(rows[idx].group.label, g.label);
      idx++;
    }
  });
  assert.equal(idx, rows.length);
});

test('cluster groups get a distinct clusterHeader row type (taller default estimate)', () => {
  const { items, models } = generateConflicts(50, { seed: 4 });
  const groups = lib.groupAndSort(items, 'storey', 'none', { models });
  const isCluster = (g) => g === groups[0]; // pretend the first group is a cluster
  const rows = lib.buildConflictRows(items, groups, {}, {}, isCluster);
  assert.equal(rows[0].type, 'clusterHeader');
  assert.equal(rows.filter((r) => r.type === 'header').length, groups.length - 1);
});

test('offsets: prefix sums are monotonically increasing and total matches the last offset', () => {
  const { items, models } = generateConflicts(1000, { seed: 5 });
  const groups = lib.groupAndSort(items, 'status', 'none', { models });
  const rows = lib.buildConflictRows(items, groups, {}, {}, () => false);
  const { offsets, totalHeight } = lib.computeRowOffsets(rows, {});
  assert.equal(offsets[0], 0);
  for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i] > offsets[i - 1]);
  assert.equal(offsets[offsets.length - 1], totalHeight);
});

test('offsets: a measured height cache overrides the type default for that row only', () => {
  const { items } = generateConflicts(5, { seed: 6 });
  const rows = lib.buildConflictRows(items, null, {}, {}, () => false);
  const cache = {}; cache[rows[2].key] = 500;
  const { offsets } = lib.computeRowOffsets(rows, cache);
  const withoutCache = lib.computeRowOffsets(rows, {}).offsets;
  assert.equal(offsets[3] - offsets[2], 500);
  assert.notEqual(offsets[3], withoutCache[3]);
  // Rows before the measured one are unaffected.
  assert.equal(offsets[1], withoutCache[1]);
});

test('findRowIndexAtOffset matches a naive linear scan across many probe points', () => {
  const { items, models } = generateConflicts(3000, { seed: 8 });
  const groups = lib.groupAndSort(items, 'assignee', 'none', { models });
  const rows = lib.buildConflictRows(items, groups, {}, {}, () => false);
  const { offsets, totalHeight } = lib.computeRowOffsets(rows, {});
  function naive(y) {
    for (let i = 0; i < rows.length; i++) if (offsets[i + 1] > y) return i;
    return rows.length - 1;
  }
  for (let p = 0; p <= 20; p++) {
    const y = Math.floor((totalHeight * p) / 20);
    assert.equal(lib.findRowIndexAtOffset(offsets, y), naive(y), `mismatch at y=${y}`);
  }
});

test('visible window always contains the exact item a caller scrolled to', () => {
  const { items } = generateConflicts(20000, { seed: 11 });
  const rows = lib.buildConflictRows(items, null, {}, {}, () => false);
  const { offsets } = lib.computeRowOffsets(rows, {});
  [0, 1, 9999, 10000, 19999].forEach((targetIdx) => {
    const targetOffset = offsets[targetIdx];
    const { startIdx, endIdx } = lib.computeVisibleRowWindow(rows, offsets, targetOffset, 700, 600);
    assert.ok(targetIdx >= startIdx && targetIdx < endIdx, `row ${targetIdx} not in window [${startIdx},${endIdx})`);
  });
});

test('empty row list yields an empty window without throwing', () => {
  const { offsets } = lib.computeRowOffsets([], {});
  const win = lib.computeVisibleRowWindow([], offsets, 0, 700, 600);
  assert.deepEqual(win, { startIdx: 0, endIdx: 0 });
});

test('parity: windowed row order for expanded groups matches the legacy flatItems order exactly', () => {
  // This is the "candidate and legacy produce the same ordered visible IDs"
  // gate from REWRITE_UI_PLAN.md — reproduces VirtualList's own flatItems
  // construction (groups -> respect collapsed/limits -> flatten) and checks
  // it against the item rows _ccBuildConflictRows produces for the same
  // (groups, collapsed, groupLimits) state.
  const { items, models } = generateConflicts(4000, { seed: 13 });
  const groups = lib.groupAndSort(items, 'category', 'none', { models });
  const collapsed = {};
  const groupLimits = {};
  groups.forEach((g, i) => { if (i % 4 === 0) collapsed[g.label] = true; });
  groups.forEach((g, i) => { if (i % 5 === 0) groupLimits[g.label] = 17; });

  const legacyFlat = [];
  groups.forEach((g) => {
    if (collapsed[g.label]) return;
    const limit = groupLimits[g.label] || lib.GROUP_PAGE_SIZE;
    g.items.slice(0, limit).forEach((it) => legacyFlat.push(it.id));
  });

  const rows = lib.buildConflictRows(items, groups, collapsed, groupLimits, () => false);
  const windowedFlat = rows.filter((r) => r.type === 'item').map((r) => r.item.id);

  assert.deepEqual(windowedFlat, legacyFlat);
});

test('offsets table is memoized against a real invalidation signal, not recomputed on every render', () => {
  // Prefix-sum offsets are O(rows), i.e. proportional to the FULL result
  // count, not the visible window — recomputing on every scroll-driven
  // re-render (winScrollTop changes on scroll) was real, avoidable CPU work
  // at 50k+ conflicts. heightCacheRef is a mutable ref (can't be a useMemo
  // dependency directly), so winForceTick — the state variable already
  // bumped exactly when a real row-height measurement changes the cache —
  // is the correct dependency instead. This locks the fix; a regression
  // back to a bare `_ccComputeRowOffsets(wRows, heightCacheRef.current)`
  // call with no useMemo wrapper would fail this.
  const start = src.indexOf('function VirtualList(props) {');
  assert.ok(start !== -1, 'VirtualList not found');
  const end = src.indexOf('\n  function ', start + 30);
  const body = src.slice(start, end);
  assert.match(body, /var wOff = useMemo\(function\(\)\{\s*\n\s*return _ccComputeRowOffsets\(wRows, heightCacheRef\.current\);\s*\n\s*\}, \[wRows, winForceTick\]\);/);
});
