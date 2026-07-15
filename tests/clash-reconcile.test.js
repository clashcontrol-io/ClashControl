'use strict';
// Locks mergeDetectionResults (index.html): a clash persisting across re-runs must
// carry its user-set fields forward, not just AI/status fields. Extracted the same
// way tests/ifc-units.test.js pulls a single function out of the inline script -
// computeClashPair/computeClashIdentityKey/_isDeniedClash are mergeDetectionResults'
// only dependencies and are defined immediately above it, so one slice covers all of
// them; _isDeniedClash's localStorage read is wrapped in try/catch and degrades to
// "nothing is denied" when localStorage doesn't exist, so no DOM stub is needed here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('function computeClashPair');
assert.ok(start !== -1, 'computeClashPair not found');
const end = src.indexOf('function mergeDetectionResults', start);
assert.ok(end !== -1, 'mergeDetectionResults not found');
const closeIdx = src.indexOf('\n  }', end) + 4;
const mergeDetectionResults = new Function(
  'window', src.slice(start, closeIdx) + '; return mergeDetectionResults;'
)({});

function baseClash(overrides) {
  return Object.assign({
    id: 'c1', uniqueIdA: 'uA', uniqueIdB: 'uB', point: [1, 2, 3],
    distance: -10, status: 'open',
  }, overrides);
}

test('first run: no prior clashes, everything is new', () => {
  const { clashes, deltaSummary } = mergeDetectionResults([baseClash()], []);
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0]._delta, 'new');
  assert.equal(deltaSummary.newCount, 1);
  assert.equal(deltaSummary.persisting, 0);
});

test('persisting clash carries assignee and priority forward', () => {
  const prev = [baseClash({ id: 'c1', assignee: 'jane', priority: 'high', status: 'in_progress' })];
  // Same element pair + same point -> same identity key -> "persisting".
  const next = [baseClash({ id: 'c1-new-run-id' })];
  const { clashes } = mergeDetectionResults(next, prev);
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0]._delta, 'persisting');
  assert.equal(clashes[0].assignee, 'jane', 'assignee must survive a re-run');
  assert.equal(clashes[0].priority, 'high', 'priority must survive a re-run');
  assert.equal(clashes[0].status, 'in_progress', 'status carry-over must still work');
  assert.equal(clashes[0].id, 'c1', 'stable id must be reused, not the fresh run id');
});

test('a brand-new clash (no prior match) has no assignee/priority to inherit', () => {
  const prev = [baseClash({ id: 'c1', uniqueIdA: 'uX', uniqueIdB: 'uY', assignee: 'jane', priority: 'high' })];
  const next = [baseClash({ id: 'c2', uniqueIdA: 'uA', uniqueIdB: 'uB' })]; // different pair
  const { clashes } = mergeDetectionResults(next, prev);
  const fresh = clashes.find((c) => c._delta === 'new');
  assert.ok(fresh);
  assert.equal(fresh.assignee, undefined);
  assert.equal(fresh.priority, undefined);
});

test('a clash that stops appearing is auto-resolved, not silently dropped', () => {
  const prev = [baseClash({ id: 'c1', status: 'open' })];
  const { clashes, deltaSummary } = mergeDetectionResults([], prev);
  assert.equal(clashes.length, 1);
  assert.equal(clashes[0]._delta, 'auto_resolved');
  assert.equal(clashes[0].status, 'auto_resolved');
  assert.equal(deltaSummary.autoResolved, 1);
});
