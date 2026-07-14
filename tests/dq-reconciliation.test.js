'use strict';
// Locks flattenDQCounts/diffDQCounts (addons/data-quality.js) - the Wave 5
// "DQ re-run reconciliation" feature. Clash detection has full GUID-identity
// reconciliation (new/persisting/auto-resolved); Data Quality re-runs
// previously just overwrote the prior result with no trend at all. A true
// per-element identity diff would need every check bucket to also return an
// uncapped GlobalId list (today `ex` is deliberately capped for display) -
// this reconciles at the check-count level instead ("was N, now M"), which
// needs no engine-shape change.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function loadEngine() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'addons', 'data-quality.js'), 'utf8');
  const window = {};
  new Function('window', src)(window);
  assert.equal(typeof window._ccFlattenDQCounts, 'function');
  assert.equal(typeof window._ccDiffDQCounts, 'function');
  return window;
}

test('flattenDQCounts prefixes each bucket by engine name, so same-named buckets in different engines never collide', () => {
  const { _ccFlattenDQCounts } = loadEngine();
  const flat = _ccFlattenDQCounts({
    qc: { noMaterial: { label: 'No material assigned', sev: 'warn', count: 5 } },
    ils: { noMaterial: { label: 'Geen materiaal toegewezen', sev: 'warn', count: 2 } },
  });
  assert.equal(flat['qc:noMaterial'].count, 5);
  assert.equal(flat['ils:noMaterial'].count, 2);
});

test('flattenDQCounts skips underscore-prefixed metadata keys (_total, _dist, etc.) and non-count entries', () => {
  const { _ccFlattenDQCounts } = loadEngine();
  const flat = _ccFlattenDQCounts({
    bim: { noFireRating: { label: 'Missing FireRating', sev: 'warn', count: 3 }, _total: 100, _dist: {} },
  });
  assert.deepEqual(Object.keys(flat), ['bim:noFireRating']);
});

test('flattenDQCounts tolerates a missing/null engine result (e.g. accessibility not loaded)', () => {
  const { _ccFlattenDQCounts } = loadEngine();
  assert.doesNotThrow(() => _ccFlattenDQCounts({ qc: null, bim: undefined }));
});

test('diffDQCounts: an increased count is "worse", a decreased count is "better"', () => {
  const { _ccDiffDQCounts } = loadEngine();
  const prev = { 'qc:noMaterial': { count: 2, label: 'No material', sev: 'warn' } };
  const cur = { 'qc:noMaterial': { count: 5, label: 'No material', sev: 'warn' } };
  const r = _ccDiffDQCounts(cur, prev);
  assert.equal(r.worse.length, 1);
  assert.equal(r.worse[0].from, 2);
  assert.equal(r.worse[0].to, 5);
  assert.equal(r.better.length, 0);
});

test('diffDQCounts: an unchanged count contributes to unchangedCount, not worse/better', () => {
  const { _ccDiffDQCounts } = loadEngine();
  const prev = { 'qc:noMaterial': { count: 3, label: 'No material', sev: 'warn' } };
  const cur = { 'qc:noMaterial': { count: 3, label: 'No material', sev: 'warn' } };
  const r = _ccDiffDQCounts(cur, prev);
  assert.equal(r.unchangedCount, 1);
  assert.equal(r.worse.length, 0);
  assert.equal(r.better.length, 0);
});

test('diffDQCounts: a check with no previous entry is compared against 0 (a brand-new check, e.g. RVB just added this session)', () => {
  const { _ccDiffDQCounts } = loadEngine();
  const cur = { 'rvb:projectIncomplete': { count: 1, label: 'IfcProject zonder naam', sev: 'warn' } };
  const r = _ccDiffDQCounts(cur, {});
  assert.equal(r.worse.length, 1);
  assert.equal(r.worse[0].from, 0);
  assert.equal(r.worse[0].to, 1);
});

test('diffDQCounts: worse is sorted by largest increase first, better by largest decrease first', () => {
  const { _ccDiffDQCounts } = loadEngine();
  const prev = { a: { count: 1, label: 'A', sev: 'warn' }, b: { count: 1, label: 'B', sev: 'warn' }, c: { count: 10, label: 'C', sev: 'warn' }, d: { count: 10, label: 'D', sev: 'warn' } };
  const cur = { a: { count: 3, label: 'A', sev: 'warn' }, b: { count: 8, label: 'B', sev: 'warn' }, c: { count: 9, label: 'C', sev: 'warn' }, d: { count: 2, label: 'D', sev: 'warn' } };
  const r = _ccDiffDQCounts(cur, prev);
  assert.deepEqual(r.worse.map((w) => w.key), ['b', 'a'], 'b (+7) must sort before a (+2)');
  assert.deepEqual(r.better.map((b) => b.key), ['d', 'c'], 'd (-8) must sort before c (-1)');
});

test('a full flatten -> diff round trip (the actual DataQualityPanel usage shape)', () => {
  const { _ccFlattenDQCounts, _ccDiffDQCounts } = loadEngine();
  const run1 = _ccFlattenDQCounts({ qc: { noMaterial: { label: 'No material', sev: 'warn', count: 10 } } });
  const run2 = _ccFlattenDQCounts({ qc: { noMaterial: { label: 'No material', sev: 'warn', count: 4 } } });
  const r = _ccDiffDQCounts(run2, run1);
  assert.equal(r.better.length, 1);
  assert.equal(r.better[0].label, 'No material');
});
