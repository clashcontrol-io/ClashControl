'use strict';
// CLAUDE.md Item 6: the "Parallel axis rejection (IFC-based, zero false
// negatives)" narrow-phase shortcut in _processCandidate was deleted
// 2026-09-07 -- its "zero false negatives" claim was false. It bounded the
// two elements' combined cross-section radius as (d1+d2)/4, where the true
// circumscribed cross-section radius for two parallel elements is
// 0.5*sqrt(d1^2+d2^2) -- for the counterexample below, 0.55m vs the true
// 1.005m -- so a real 0.1 m^3 overlap was rejected before the intersection
// kernel ever ran. It also omitted the clearance margin entirely, so it
// produced false negatives on soft/clearance runs too.
//
// This locks two things:
//   1. The shortcut's source is actually gone (a structural check -- if it
//      ever comes back verbatim, or a lookalike reappears, this fails).
//   2. The counterexample geometry, run through the REAL intersection
//      kernel (_meshesIntersect -- the exact function _processCandidate
//      calls immediately after where the deleted block used to sit),
//      genuinely reports an intersection now that nothing gates it first.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('the parallel-axis rejection shortcut is gone from index.html', () => {
  assert.doesNotMatch(src, /Parallel axis rejection/);
  // The specific broken radius formula -- if this text ever reappears
  // (even under a different comment), it needs the Wave 2 conservative-
  // bound fixture work, not a casual reintroduction.
  assert.doesNotMatch(src, /\(dimsA\[0\]\+dimsA\[1\]\)\/4/);
  assert.doesNotMatch(src, /\(dimsB\[0\]\+dimsB\[1\]\)\/4/);
});

// ── Extract the real intersection kernel (same pattern as
// tests/penetration-depth.test.js: pre-populate el._triCache so
// _getWorldTris/_getBVH short-circuit before ever touching
// _ccGetElementGeometry or real THREE.js objects). ──────────────────────────
const start = src.indexOf('function _getWorldVerts(el) {');
assert.ok(start !== -1, '_getWorldVerts not found');
const fnStart = src.indexOf('function _meshesIntersect(elA, elB) {', start);
assert.ok(fnStart !== -1, '_meshesIntersect not found');
const retLine = src.indexOf('return _jsIntersectBVH(_getBVH(elA), _getBVH(elB), elA.box, elB.box);', fnStart);
assert.ok(retLine !== -1, '_meshesIntersect body not found');
const closeIdx = src.indexOf('\n  }', retLine) + '\n  }'.length;
const _window = {};
new Function('window', src.slice(start, closeIdx) + `
  window._ccT_meshesIntersect = _meshesIntersect;
`)(_window);
const _meshesIntersect = _window._ccT_meshesIntersect;
assert.equal(typeof _meshesIntersect, 'function');

// Axis-aligned box as a 12-triangle soup, 9 floats/triangle -- the exact
// layout _getWorldTris produces (copied from tests/penetration-depth.test.js;
// duplicated rather than shared, matching this repo's existing test-helper
// convention).
function boxTris(x0, y0, z0, x1, y1, z1) {
  var v = {
    a: [x0, y0, z0], b: [x1, y0, z0], c: [x1, y1, z0], d: [x0, y1, z0],
    e: [x0, y0, z1], f: [x1, y0, z1], g: [x1, y1, z1], h: [x0, y1, z1],
  };
  var faces = [
    ['a', 'b', 'c'], ['a', 'c', 'd'], // z0
    ['e', 'g', 'f'], ['e', 'h', 'g'], // z1
    ['a', 'b', 'f'], ['a', 'f', 'e'], // y0
    ['d', 'c', 'g'], ['d', 'g', 'h'], // y1
    ['a', 'd', 'h'], ['a', 'h', 'e'], // x0
    ['b', 'c', 'g'], ['b', 'g', 'f'], // x1
  ];
  var out = [];
  faces.forEach(function (f) { f.forEach(function (k) { out.push(v[k][0], v[k][1], v[k][2]); }); });
  return new Float32Array(out);
}

function boxElement(min, max, axis) {
  return {
    box: { min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } },
    props: { axis: axis },
    _triCache: boxTris(min[0], min[1], min[2], max[0], max[1], max[2]),
  };
}

// The review's exact counterexample: both boxes declare axis [1,0,0]
// (long, thin, parallel elements -- e.g. two beams), and their AABBs
// overlap by exactly 2m x 0.25m x 0.2m = 0.1 m^3.
const elA = boxElement([-5, -1, -0.1], [5, 1, 0.1], [1, 0, 0]);
const elB = boxElement([3, 0.75, -0.1], [13, 2.75, 0.1], [1, 0, 0]);

test('overlap sanity: the fixture really does describe a 0.1 m^3 AABB overlap', () => {
  const ox = Math.min(elA.box.max.x, elB.box.max.x) - Math.max(elA.box.min.x, elB.box.min.x);
  const oy = Math.min(elA.box.max.y, elB.box.max.y) - Math.max(elA.box.min.y, elB.box.min.y);
  const oz = Math.min(elA.box.max.z, elB.box.max.z) - Math.max(elA.box.min.z, elB.box.min.z);
  assert.ok(ox > 0 && oy > 0 && oz > 0, 'AABBs must actually overlap');
  assert.ok(Math.abs(ox * oy * oz - 0.1) < 1e-9, 'expected exactly 0.1 m^3 of AABB overlap');
});

test('the deleted shortcut (replicated here ONLY to prove the fixture exercises the bug) would have wrongly rejected this pair', () => {
  // This is a verbatim copy of the removed logic -- kept here as a fixed
  // point of comparison, NOT restored to index.html.
  function oldShortcutWouldReject(a, b) {
    var axisA = a.props.axis, axisB = b.props.axis;
    var dot = axisA[0] * axisB[0] + axisA[1] * axisB[1] + axisA[2] * axisB[2];
    if (Math.abs(dot) <= 0.95) return false;
    var cA = { x: (a.box.min.x + a.box.max.x) / 2, y: (a.box.min.y + a.box.max.y) / 2, z: (a.box.min.z + a.box.max.z) / 2 };
    var cB = { x: (b.box.min.x + b.box.max.x) / 2, y: (b.box.min.y + b.box.max.y) / 2, z: (b.box.min.z + b.box.max.z) / 2 };
    var ccx = cB.x - cA.x, ccy = cB.y - cA.y, ccz = cB.z - cA.z;
    var ccLen = Math.sqrt(ccx * ccx + ccy * ccy + ccz * ccz);
    if (ccLen <= 1e-6) return false;
    ccx /= ccLen; ccy /= ccLen; ccz /= ccLen;
    var ccDot = Math.abs(ccx * axisA[0] + ccy * axisA[1] + ccz * axisA[2]);
    if (ccDot <= 0.85) return false;
    var perpDist = ccLen * Math.sqrt(1 - ccDot * ccDot);
    var dimsA = [a.box.max.x - a.box.min.x, a.box.max.y - a.box.min.y, a.box.max.z - a.box.min.z].sort(function (x, y) { return x - y; });
    var dimsB = [b.box.max.x - b.box.min.x, b.box.max.y - b.box.min.y, b.box.max.z - b.box.min.z].sort(function (x, y) { return x - y; });
    var radA = (dimsA[0] + dimsA[1]) / 4;
    var radB = (dimsB[0] + dimsB[1]) / 4;
    return perpDist > radA + radB;
  }
  assert.equal(oldShortcutWouldReject(elA, elB), true,
    'fixture must reproduce the review-verified counterexample, or this test proves nothing');
});

test('the real intersection kernel finds the overlap -- the pair is no longer rejected before reaching it', () => {
  const result = _meshesIntersect(elA, elB);
  assert.notEqual(result, false, 'two boxes with a genuine 0.1 m^3 overlap must be reported as intersecting');
  assert.ok(Array.isArray(result), 'a real hit returns [x, y, z, depth]');
});
