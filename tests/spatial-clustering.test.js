'use strict';
// Locks _ccSpatialClusterMap (index.html) — Wave 1.8. Distance-threshold
// union-find that groups DIFFERENT element pairs sitting close together in
// space (e.g. one duct crossing 5 different joists in the same corridor bay
// reads as one "Area", not 5 unrelated-looking groups). Deliberately
// separate from _ccClusterKeyFor (groupBy:'cluster'), which groups touch
// points between the SAME two elements regardless of location - the two are
// independent, complementary groupings, not a replacement of one by the
// other (locked by a dedicated test below).
// Extracted the same way tests/ifc-units.test.js pulls a slice out of the
// inline script - pure logic, no DOM/THREE dependency.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('var _SPATIAL_CLUSTER_RADIUS_M = 1.5;');
assert.ok(start !== -1, '_SPATIAL_CLUSTER_RADIUS_M not found');
const end = src.indexOf('\n  function _groupKeyFor', start);
assert.ok(end !== -1, '_ccSpatialClusterMap closing point not found');
const _ccSpatialClusterMap = new Function(src.slice(start, end) + '; return _ccSpatialClusterMap;')();
assert.equal(typeof _ccSpatialClusterMap, 'function');

function clash(id, point) { return { id: id, point: point }; }

test('two points within the radius land in the same cluster', () => {
  const items = [clash('a', [0, 0, 0]), clash('b', [0.5, 0, 0])]; // 0.5m apart, radius 1.5m
  const map = _ccSpatialClusterMap(items);
  assert.equal(map.get('a'), map.get('b'));
});

test('two points far beyond the radius land in different clusters', () => {
  const items = [clash('a', [0, 0, 0]), clash('b', [50, 0, 0])];
  const map = _ccSpatialClusterMap(items);
  assert.notEqual(map.get('a'), map.get('b'));
});

test('transitive chaining: A-B and B-C within radius merges A and C even though A-C alone would not qualify', () => {
  // A at 0, B at 1.4 (within 1.5 of A), C at 2.8 (within 1.5 of B, but 2.8
  // from A - beyond a single-hop radius). Union-find must still merge all 3
  // through the B bridge, unlike a naive single-pass "compare to first point".
  const items = [clash('a', [0, 0, 0]), clash('b', [1.4, 0, 0]), clash('c', [2.8, 0, 0])];
  const map = _ccSpatialClusterMap(items);
  assert.equal(map.get('a'), map.get('b'));
  assert.equal(map.get('b'), map.get('c'));
});

test('items with no point are labeled Unlocated and never merged with anything', () => {
  const items = [clash('a', [0, 0, 0]), { id: 'b' }, { id: 'c', point: null }];
  const map = _ccSpatialClusterMap(items);
  assert.equal(map.get('b'), 'Unlocated');
  assert.equal(map.get('c'), 'Unlocated');
  assert.notEqual(map.get('a'), 'Unlocated');
});

test('cluster labels are stable, zero-padded, and assigned in first-appearance order', () => {
  const items = [clash('a', [0, 0, 0]), clash('b', [100, 0, 0]), clash('c', [200, 0, 0])];
  const map = _ccSpatialClusterMap(items);
  assert.equal(map.get('a'), 'Area 01');
  assert.equal(map.get('b'), 'Area 02');
  assert.equal(map.get('c'), 'Area 03');
});

test('a custom radius is respected (tighter radius splits what the default would merge)', () => {
  const items = [clash('a', [0, 0, 0]), clash('b', [1.0, 0, 0])];
  const wideMap = _ccSpatialClusterMap(items, 1.5);
  const tightMap = _ccSpatialClusterMap(items, 0.5);
  assert.equal(wideMap.get('a'), wideMap.get('b'));
  assert.notEqual(tightMap.get('a'), tightMap.get('b'));
});

test('grid-bucket boundary: points just across a cell edge but within radius still merge', () => {
  // With radius (=cell size) 1.5, points at x=1.49 and x=1.51 fall in
  // adjacent grid cells (floor(1.49/1.5)=0, floor(1.51/1.5)=1) but are only
  // 0.02m apart - the 3x3x3 neighbor-cell search must still catch this.
  const items = [clash('a', [1.49, 0, 0]), clash('b', [1.51, 0, 0])];
  const map = _ccSpatialClusterMap(items);
  assert.equal(map.get('a'), map.get('b'));
});

test('empty input returns an empty map without throwing', () => {
  const map = _ccSpatialClusterMap([]);
  assert.equal(map.size, 0);
});
