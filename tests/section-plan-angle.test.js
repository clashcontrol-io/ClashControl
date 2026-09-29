// section-clipping.js dominantPlanAngle: the building's plan grid angle,
// used so axis section planes / the whole-model section box cut parallel to
// the walls of a building that is rotated in plan.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { dominantPlanAngle } = require('../section-clipping.js');
const DEG = Math.PI / 180;

// Rectangle footprint rotated by `a` about +Y (Three.js: +X -> (cos,0,-sin)),
// sides w x d, as horizontal edge vectors [dx, dz, len].
function rectSegs(a, w, d) {
  const ex = [Math.cos(a), -Math.sin(a)], ez = [Math.sin(a), Math.cos(a)];
  return [ex[0] * w, ex[1] * w, w, ez[0] * d, ez[1] * d, d, -ex[0] * w, -ex[1] * w, w, -ez[0] * d, -ez[1] * d, d];
}

for (const deg of [0, 7, 23.5, -31, 44, -12.25]) {
  test(`recovers a building rotated ${deg} deg`, () => {
    const r = dominantPlanAngle(rectSegs(deg * DEG, 40, 18));
    assert.ok(Math.abs(r.angle - (Math.abs(deg) < 0.25 ? 0 : deg * DEG)) < 1e-9, `${r.angle / DEG}`);
    assert.ok(r.confidence > 0.99);
  });
}

test('90 deg-equivalent orientations fold to the same angle', () => {
  const a = dominantPlanAngle(rectSegs(20 * DEG, 30, 10)).angle;
  const b = dominantPlanAngle(rectSegs(110 * DEG, 30, 10)).angle;
  assert.ok(Math.abs(a - b) < 1e-9);
});

test('dominant grid wins over minority noise', () => {
  const segs = rectSegs(15 * DEG, 50, 25);
  for (let i = 0; i < 40; i++) { const t = i * 2.3; segs.push(Math.cos(t), Math.sin(t), 1); } // 40 m of scattered edges
  const r = dominantPlanAngle(segs);
  assert.ok(Math.abs(r.angle - 15 * DEG) < 0.2 * DEG, `${r.angle / DEG}`);
});

test('no evidence / isotropic geometry -> world axes', () => {
  assert.deepStrictEqual(dominantPlanAngle([]), { angle: 0, confidence: 0 });
  const segs = [];
  for (let i = 0; i < 360; i++) segs.push(Math.cos(i * DEG), Math.sin(i * DEG), 1); // a circle
  assert.strictEqual(dominantPlanAngle(segs).angle, 0);
});

test('near-world-aligned models snap to exactly 0 (unchanged behaviour)', () => {
  assert.strictEqual(dominantPlanAngle(rectSegs(0.1 * DEG, 20, 20)).angle, 0);
});
