'use strict';
// Locks _ccDeterministicSeverity (index.html) — the Wave 1.6 fallback used
// everywhere aiSeverity is read (`c.aiSeverity || _ccDeterministicSeverity(c)`)
// so severity sort/group/color/bulk-actions differentiate the vast majority
// of clashes that never get AI triage, instead of every one of them tying
// at the same default. Vocabulary must match aiSeverity exactly
// (critical/major/minor/info) since callers plug the result straight into
// rank tables and color maps built for that vocabulary.
// Extracted the same way tests/ifc-units.test.js pulls a slice out of the
// inline script - pure logic, no DOM/THREE dependency.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('var _SEV_DISC_WEIGHT = {');
assert.ok(start !== -1, '_SEV_DISC_WEIGHT not found');
const end = src.indexOf('\n  function _clearElCaches', start);
assert.ok(end !== -1, '_ccDeterministicSeverity closing point not found');
const _ccDeterministicSeverity = new Function(src.slice(start, end) + '; return _ccDeterministicSeverity;')();
assert.equal(typeof _ccDeterministicSeverity, 'function');

const VALID = ['critical', 'major', 'minor', 'info'];

function hard(disciplines, depthMm) {
  return { type: 'hard', disciplines: disciplines, distance: -Math.abs(depthMm) };
}
function soft(gapMm) {
  return { type: 'soft', clearanceMm: gapMm };
}

test('returns a value from the exact aiSeverity vocabulary for every input shape', () => {
  const inputs = [
    null, {}, hard(['structural', 'mep'], 30), soft(5), soft(80),
    { type: 'duplicate' }, { type: 'visibility' },
  ];
  inputs.forEach((c) => assert.ok(VALID.includes(_ccDeterministicSeverity(c))));
});

test('null/undefined clash is info', () => {
  assert.equal(_ccDeterministicSeverity(null), 'info');
  assert.equal(_ccDeterministicSeverity(undefined), 'info');
});

test('duplicate clashes are info (data-quality noise, not coordination)', () => {
  assert.equal(_ccDeterministicSeverity({ type: 'duplicate' }), 'info');
});

test('visibility (sight-line) clashes are major', () => {
  assert.equal(_ccDeterministicSeverity({ type: 'visibility' }), 'major');
});

test('soft clashes: a near-touching gap (≤15mm) is major, a wide clearance note is minor', () => {
  assert.equal(_ccDeterministicSeverity(soft(2)), 'major');
  assert.equal(_ccDeterministicSeverity(soft(15)), 'major');
  assert.equal(_ccDeterministicSeverity(soft(16)), 'minor');
  assert.equal(_ccDeterministicSeverity(soft(100)), 'minor');
});

test('soft clash with no clearanceMm data defaults to minor (no signal to escalate on)', () => {
  assert.equal(_ccDeterministicSeverity({ type: 'soft' }), 'minor');
});

test('hard clash under the 10mm floor is minor regardless of discipline (tolerance/rounding territory)', () => {
  assert.equal(_ccDeterministicSeverity(hard(['structural', 'structural'], 5)), 'minor');
  assert.equal(_ccDeterministicSeverity(hard(['architectural', 'architectural'], 0.5)), 'minor');
});

test('hard clash ≥10mm between low-weight disciplines is major, not critical', () => {
  assert.equal(_ccDeterministicSeverity(hard(['architectural', 'architectural'], 15)), 'major');
  assert.equal(_ccDeterministicSeverity(hard(['architectural', 'other'], 40)), 'major');
});

test('hard clash ≥20mm involving structural is critical', () => {
  assert.equal(_ccDeterministicSeverity(hard(['structural', 'mep'], 20)), 'critical');
  assert.equal(_ccDeterministicSeverity(hard(['architectural', 'structural'], 25)), 'critical');
});

test('any hard clash ≥50mm is critical regardless of discipline', () => {
  assert.equal(_ccDeterministicSeverity(hard(['architectural', 'other'], 50)), 'critical');
  assert.equal(_ccDeterministicSeverity(hard(['architectural', 'other'], 200)), 'critical');
});

test('discipline weight uses the MAX of the pair, not an average or the first element', () => {
  // A structural element clashing with an architectural one is exactly as
  // urgent as structural-vs-structural at the same depth - the low-weight
  // side doesn't dilute it.
  const mixed = _ccDeterministicSeverity(hard(['architectural', 'structural'], 20));
  const bothStructural = _ccDeterministicSeverity(hard(['structural', 'structural'], 20));
  assert.equal(mixed, bothStructural);
  assert.equal(mixed, 'critical');
});

test('missing/empty disciplines array does not throw and treats it as low weight', () => {
  assert.equal(_ccDeterministicSeverity({ type: 'hard', distance: -30 }), 'major');
  assert.equal(_ccDeterministicSeverity({ type: 'hard', disciplines: [], distance: -30 }), 'major');
});

test('unknown discipline strings fall back to weight 1, same as architectural/other', () => {
  assert.equal(_ccDeterministicSeverity(hard(['unknown-discipline', 'unknown-discipline'], 20)), 'major');
});
