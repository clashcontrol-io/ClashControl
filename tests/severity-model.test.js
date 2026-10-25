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
// The model lives in clash-classification-core.js (deterministicSeverity);
// index.html keeps a thin delegate, extracted here and bound to the real core.
const start = src.indexOf('function _ccDeterministicSeverity(c) {');
assert.ok(start !== -1, '_ccDeterministicSeverity not found');
const end = src.indexOf('\n  function _clearElCaches', start);
assert.ok(end !== -1, '_ccDeterministicSeverity closing point not found');
const window = { _ccClashClassificationCore: require('../clash-classification-core') };
const _ccDeterministicSeverity = new Function('window', src.slice(start, end) + '; return _ccDeterministicSeverity;')(window);
assert.equal(typeof _ccDeterministicSeverity, 'function');

const VALID = ['critical', 'major', 'minor', 'info'];

// Box sizes (mm): a 100 mm run through a 300 mm host is extent 'through'
// once the depth reaches 100 mm; without sizes the extent is 'unknown'.
const RUN = { dx: 3000, dy: 100, dz: 100 }, HOST = { dx: 300, dy: 500, dz: 6000 };
function hard(disciplines, depthMm, sized) {
  const c = { type: 'hard', disciplines: disciplines, distance: -Math.abs(depthMm) };
  if (sized) { c.bboxA = RUN; c.bboxB = HOST; }
  return c;
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
  assert.equal(_ccDeterministicSeverity(hard(['structural', 'mep'], 5, true)), 'minor');
  assert.equal(_ccDeterministicSeverity(hard(['architectural', 'architectural'], 0.5)), 'minor');
});

test('pair class x extent: a MEP run through structure is critical, partly into it major', () => {
  assert.equal(_ccDeterministicSeverity(hard(['structural', 'mep'], 120, true)), 'critical');
  assert.equal(_ccDeterministicSeverity(hard(['mep', 'structural'], 120, true)), 'critical', 'symmetric');
  assert.equal(_ccDeterministicSeverity(hard(['structural', 'mep'], 60, true)), 'major');
});

test('depth alone never makes a clash critical: architecture x structure is major at most', () => {
  assert.equal(_ccDeterministicSeverity(hard(['architectural', 'structural'], 120, true)), 'major');
  assert.equal(_ccDeterministicSeverity(hard(['architectural', 'structural'], 60, true)), 'minor');
  assert.equal(_ccDeterministicSeverity(hard(['architectural', 'other'], 2000, true)), 'major');
  assert.equal(_ccDeterministicSeverity(hard(['mep', 'architectural'], 120, true)), 'major');
});

test('critical needs a known extent: without box sizes a deep structural penetration is major', () => {
  assert.equal(_ccDeterministicSeverity(hard(['structural', 'mep'], 400)), 'major');
  assert.equal(_ccDeterministicSeverity(hard(['structural', 'mep'], 20)), 'major');
});

test('missing/empty disciplines array does not throw and treats it as low weight', () => {
  assert.equal(_ccDeterministicSeverity({ type: 'hard', distance: -30 }), 'minor');
  assert.equal(_ccDeterministicSeverity({ type: 'hard', disciplines: [], distance: -60 }), 'major');
});

test('unknown discipline strings fall back to the "other" pair class (major at most)', () => {
  assert.equal(_ccDeterministicSeverity(hard(['unknown-discipline', 'unknown-discipline'], 20)), 'minor');
  assert.equal(_ccDeterministicSeverity(hard(['unknown-discipline', 'unknown-discipline'], 2000, true)), 'major');
});
