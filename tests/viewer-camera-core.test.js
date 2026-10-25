'use strict';
// viewer-camera-core.js dollyStep: the bounded zoom-to-cursor step behind
// the wheel and pinch handlers in makeOrbit (index.html).
// Regression: zooming in far enough left the camera on (or in) a surface,
// where every zoom-out notch moved ~2 cm — zoom out looked broken.
const { test } = require('node:test');
const assert = require('node:assert');
const VC = require('../viewer-camera-core.js');

const NOTCH_IN = Math.exp(-100 * 0.0004);  // one wheel notch (deltaY=100), as in makeOrbit
const NOTCH_OUT = Math.exp(100 * 0.0004);

// Camera looks down -Z at a surface in the plane z=0; the cursor's surface
// hit (the anchor) is the origin. The orbit target sits INSIDE the element,
// behind the surface (what selecting an element does to the target).
function setup(z) {
  return { cam: { x: 0, y: 0, z }, tgt: { x: 0, y: 0, z: -0.4 } };
}
function step(st, factor, opts, anchor) {
  const r = VC.dollyStep(st.cam, st.tgt, anchor || { x: 0, y: 0, z: 0 }, factor, opts);
  st.cam = r.camPos; st.tgt = r.tgt;
  return r;
}

test('200 notches toward a surface keep the camera >= 0.05 m in front of it, never through', () => {
  for (const near of [0.01, 0.001, 0]) {
    const st = setup(10);
    for (let i = 0; i < 200; i++) step(st, NOTCH_IN, { surface: true, sceneDiag: 50, near });
    assert.ok(st.cam.z >= 0.05 - 1e-12, `near=${near}: camera at z=${st.cam.z}`);
    assert.ok(st.cam.z > 0, 'camera crossed the surface');
  }
});

test('standoff is max(10*near, 0.05 m)', () => {
  const st = setup(10);
  for (let i = 0; i < 400; i++) step(st, NOTCH_IN, { surface: true, sceneDiag: 50, near: 0.02, minR: 0 });
  assert.ok(Math.abs(st.cam.z - 0.2) < 1e-9, `expected 0.2, got ${st.cam.z}`);
});

test('after zooming all the way in, 60 notches out restore >= 80% of the start distance', () => {
  const start = 2;
  const st = setup(start);
  for (let i = 0; i < 200; i++) step(st, NOTCH_IN, { surface: true, sceneDiag: 50, near: 0.01 });
  for (let i = 0; i < 60; i++) step(st, NOTCH_OUT, { surface: true, sceneDiag: 50, near: 0.01 });
  assert.ok(st.cam.z >= 0.8 * start, `camera only back at ${st.cam.z} m (start ${start} m)`);
});

test('zoom out escapes even with the camera ON the anchor (no direction to scale along)', () => {
  const st = { cam: { x: 0, y: 0, z: 0 }, tgt: { x: 0, y: 0, z: -1 } };
  const r = step(st, NOTCH_OUT, { sceneDiag: 0 });
  assert.ok(st.cam.z > 0.009, `moved only to z=${st.cam.z}`);
  assert.ok(r.dist > 0.009);
});

test('zoom out from a fallback anchor right in front of the camera is not a 2 cm crawl', () => {
  const st = { cam: { x: 0, y: 0, z: 0.5 }, tgt: { x: 0, y: 0, z: 0 } };
  const before = st.cam.z;
  step(st, NOTCH_OUT, { surface: false, sceneDiag: 100 }, { x: 0, y: 0, z: 0 });
  // floor = 0.01 * 100 = 1 m -> one notch moves >= 4 cm
  assert.ok(st.cam.z - before >= 0.04, `one notch moved ${st.cam.z - before} m`);
});

test('far from surfaces, in then out is exactly reversible and the anchor stays fixed', () => {
  const cam0 = { x: 30, y: 12, z: -7 }, tgt0 = { x: 5, y: 1, z: 2 }, anchor = { x: 1, y: 2, z: 3 };
  let cam = cam0, tgt = tgt0;
  for (let i = 0; i < 25; i++) { const r = VC.dollyStep(cam, tgt, anchor, NOTCH_IN, { surface: true, sceneDiag: 50, near: 0.01 }); cam = r.camPos; tgt = r.tgt; }
  for (let i = 0; i < 25; i++) { const r = VC.dollyStep(cam, tgt, anchor, NOTCH_OUT, { surface: true, sceneDiag: 50, near: 0.01 }); cam = r.camPos; tgt = r.tgt; }
  for (const k of ['x', 'y', 'z']) {
    assert.ok(Math.abs(cam[k] - cam0[k]) < 1e-9, `cam.${k} drifted: ${cam[k]} vs ${cam0[k]}`);
    assert.ok(Math.abs(tgt[k] - tgt0[k]) < 1e-9, `tgt.${k} drifted: ${tgt[k]} vs ${tgt0[k]}`);
  }
  // one far-field step equals the plain multiplicative dolly
  const a = VC.dollyStep(cam0, tgt0, anchor, NOTCH_OUT, { sceneDiag: 50 });
  const b = VC.zoomDollyStep(cam0, tgt0, anchor, NOTCH_OUT);
  assert.deepStrictEqual(a.camPos, b.camPos);
});

test('orbit radius limits: |camera-target| stays within [minR, maxR]', () => {
  let cam = { x: 0, y: 0, z: 4000 }, tgt = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 50; i++) { const r = VC.dollyStep(cam, tgt, { x: 0, y: 0, z: 0 }, NOTCH_OUT, {}); cam = r.camPos; tgt = r.tgt; }
  assert.ok(cam.z <= 5000 + 1e-6);
  cam = { x: 0, y: 0, z: 2 }; tgt = { x: 0, y: 0, z: 1.2 };
  for (let i = 0; i < 100; i++) { const r = VC.dollyStep(cam, tgt, { x: 0, y: 0, z: 0 }, NOTCH_IN, {}); cam = r.camPos; tgt = r.tgt; }
  assert.ok(cam.z - tgt.z >= 0.5 - 1e-9, `r=${cam.z - tgt.z}`);
});
