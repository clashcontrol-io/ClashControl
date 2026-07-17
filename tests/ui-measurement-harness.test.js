'use strict';
// REWRITE_UI_PLAN.md Phase 2 — measurement harness. Records, on the untouched
// grouping/sorting logic, how many DOM rows the LEGACY (fully-mounted) path
// would have to mount at 200/2k/10k/50k synthetic conflicts, versus how many
// the ccUiWindowedConflicts row list needs to keep mounted at once. This is
// the "baseline numbers recorded before any UI edit" gate the plan requires
// before Phase 3 is allowed to ship — written as a permanent regression test
// (not a throwaway script) so the ≤250-mounted-rows budget stays enforced.
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
    computeVisibleRowWindow: _ccComputeVisibleRowWindow,
    ROW_HEIGHT: ROW_HEIGHT,
    GROUP_PAGE_SIZE: GROUP_PAGE_SIZE,
  };`
);
const lib = sandbox({});

const SIZES = [200, 2000, 10000, 50000];
const VIEWPORT = 700;

function legacyMountedRowCount(items, groups, collapsed, groupLimits) {
  // Mirrors the legacy render's mounting rule exactly: every group header
  // mounts, and every non-collapsed group mounts min(items, its page limit)
  // rows plus one "show more" row if it's truncated. This is what the
  // now-removed idle-reveal-to-all eventually converged to before Phase 3.
  if (!groups) return items.length;
  let count = 0;
  groups.forEach((g) => {
    count += 1; // header
    if (collapsed[g.label]) return;
    const limit = (groupLimits && groupLimits[g.label]) || lib.GROUP_PAGE_SIZE;
    count += Math.min(g.items.length, limit);
    if (g.items.length > limit) count += 1;
  });
  return count;
}

// Low-cardinality groupBy dimensions (storey/discipline/status/...) already
// get some help from the pre-existing 50-row-per-group page cap — a handful
// of groups times 50 rows stays modest even at 50k items. The dimension that
// actually demonstrates "no virtualization at all" (REWRITE_UI_PLAN.md's own
// diagnosis) is the high-cardinality one: 'cluster'/'nearby', where group
// count scales WITH n (a duct crossing 5 different joists = 5 small groups,
// not one big one) and most groups never hit the per-group cap, so nothing
// bounds the total. Model that shape directly rather than depending on the
// 'cluster' groupBy's extra globals (_ccClusterKeyFor etc., not extracted here).
function manyClusterGroups(items, clusterSize) {
  const groups = [];
  for (let i = 0; i < items.length; i += clusterSize) {
    const slice = items.slice(i, i + clusterSize);
    groups.push({ label: 'Area ' + (i / clusterSize), items: slice });
  }
  return groups;
}

test('baseline: legacy cluster-style grouped mounting is unbounded — grows with result size', () => {
  const results = {};
  for (const n of SIZES) {
    const { items } = generateConflicts(n, { seed: 42 });
    const groups = manyClusterGroups(items, 12); // avg cluster size well under the 50-row page cap
    const mounted = legacyMountedRowCount(items, groups, {}, {});
    results[n] = mounted;
    // Every cluster is under the per-group cap, so nothing trims it: mounted
    // count tracks n almost 1:1 (n items + n/12 headers) — this is the real
    // gap Phase 3 closes ("all group headers are still evaluated and expanded
    // groups can accumulate many rows", REWRITE_UI_PLAN.md).
    assert.ok(mounted > n * 0.9, `expected legacy to mount nearly all of ${n} items, mounted ${mounted}`);
  }
  assert.ok(results[2000] > results[200]);
  assert.ok(results[10000] > results[2000]);
  assert.ok(results[50000] > results[10000]);
});

test('windowed: mounted rows stay bounded regardless of result size (<=250 at 50k)', () => {
  for (const n of SIZES) {
    const { items, models } = generateConflicts(n, { seed: 42 });
    const groups = lib.groupAndSort(items, 'storey', 'none', { models });
    const rows = lib.buildConflictRows(items, groups, {}, {}, () => false);
    const { offsets, totalHeight } = lib.computeRowOffsets(rows, {});
    assert.equal(offsets.length, rows.length + 1);
    assert.equal(offsets[offsets.length - 1], totalHeight);
    const { startIdx, endIdx } = lib.computeVisibleRowWindow(rows, offsets, 0, VIEWPORT, 600);
    const mounted = endIdx - startIdx;
    assert.ok(mounted <= 250, `expected <=250 mounted rows at n=${n}, got ${mounted}`);
    // Sanity floor: window shouldn't be suspiciously tiny either (viewport + overscan
    // covers real content, not an empty slice).
    assert.ok(mounted > 5, `window looks too small at n=${n}: ${mounted}`);
  }
});

test('windowed: scrolling to the middle/end of a 50k list still yields a bounded window', () => {
  const { items, models } = generateConflicts(50000, { seed: 7 });
  const groups = lib.groupAndSort(items, 'storey', 'none', { models });
  const rows = lib.buildConflictRows(items, groups, {}, {}, () => false);
  const { offsets, totalHeight } = lib.computeRowOffsets(rows, {});
  for (const frac of [0, 0.25, 0.5, 0.75, 0.99]) {
    const scrollTop = Math.floor(totalHeight * frac);
    const { startIdx, endIdx } = lib.computeVisibleRowWindow(rows, offsets, scrollTop, VIEWPORT, 600);
    assert.ok(endIdx - startIdx <= 260, `mounted window too large at scrollTop fraction ${frac}`);
    assert.ok(startIdx >= 0 && endIdx <= rows.length);
  }
});

test('windowed: ungrouped 50k conflicts also stay bounded', () => {
  const { items } = generateConflicts(50000, { seed: 3 });
  const rows = lib.buildConflictRows(items, null, {}, {}, () => false);
  assert.equal(rows.length, 50000);
  const { offsets } = lib.computeRowOffsets(rows, {});
  const { startIdx, endIdx } = lib.computeVisibleRowWindow(rows, offsets, offsets[25000], VIEWPORT, 600);
  assert.ok(endIdx - startIdx <= 60, `expected a small fixed-height window, got ${endIdx - startIdx}`);
});

test('filter latency proxy: rebuilding rows + offsets for 50k items stays well under 100ms', () => {
  const { items, models } = generateConflicts(50000, { seed: 9 });
  const groups = lib.groupAndSort(items, 'status', 'none', { models });
  const t0 = process.hrtime.bigint();
  const rows = lib.buildConflictRows(items, groups, {}, {}, () => false);
  lib.computeRowOffsets(rows, {});
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 100, `row-list + offset rebuild took ${ms.toFixed(1)}ms, budget is 100ms`);
});
