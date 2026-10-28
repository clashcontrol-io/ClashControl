'use strict';
// Pure orbit-navigation math (viewer-camera-core.js, used by makeOrbit in
// index.html). These functions operate on plain {x,y,z} objects with no
// THREE.js dependency, specifically so they can be exercised here without a
// browser. Bugs these fix:
//   1) view jump when the orbit pivot moves off the camera's view ray
//   3) zoom-to-cursor drift / non-reversibility
//   4) pan speed not matching true pixel-to-world scale
const { test } = require('node:test');
const assert = require('node:assert');

const VC = require('../viewer-camera-core.js');
const M = {
  _ccRotateAroundAxis: VC.rotateAroundAxis,
  _ccOrbitDragStep: VC.orbitDragStep,
  _ccZoomDollyStep: VC.zoomDollyStep,
  _ccPanWorldPerPixel: VC.panWorldPerPixel,
};

function norm(v) {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x/l, y: v.y/l, z: v.z/l };
}
function angleBetween(a, b) {
  const na = norm(a), nb = norm(b);
  const dot = na.x*nb.x + na.y*nb.y + na.z*nb.z;
  return Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
}

test('orbit drag: rotating the true forward vector around a pivot reproduces the classic small-angle drag', () => {
  // Camera level with the target (phi = pi/2, "equator") so a pure yaw's
  // effect on the view-direction angle equals the raw yaw angle exactly
  // (at other elevations it scales by sin(phi)).
  const phi = Math.PI/2, theta = Math.PI/4, r = 60;
  const camPos = { x: r*Math.sin(phi)*Math.sin(theta), y: r*Math.cos(phi), z: r*Math.sin(phi)*Math.cos(theta) };
  const tgt = { x: 0, y: 0, z: 0 };
  const forward = norm({ x: tgt.x-camPos.x, y: tgt.y-camPos.y, z: tgt.z-camPos.z });
  const stepped = M._ccOrbitDragStep(camPos, forward, tgt, 2, 0, 0.007); // pivot === target, 2px horizontal drag
  const deg = angleBetween(forward, stepped.forward);
  // Expected ~ 2px * 0.007 rad = 0.014 rad = 0.80 deg
  assert.ok(Math.abs(deg - 0.8) < 0.05, `expected ~0.80deg, got ${deg}`);
});

test('orbit drag: pivot shifted off the view ray does NOT snap the view on the very next drag (regression for the 18 deg jump bug)', () => {
  // Simulates _shiftPivotTo: camera stays put, but `target` (used by the OLD
  // buggy code as a stand-in for view direction) sits well off the camera's
  // actual current forward direction — an off-centre element click. The fix
  // rotates the camera's TRUE forward vector, not that stale target, so a
  // small drag right after the pivot shift must still be small-angle.
  const camPos = { x: -0.65*1834, y: 1.5, z: -0.65*1834 };
  const actualForward = norm({ x: -camPos.x, y: -camPos.y, z: -camPos.z }); // camera still looking roughly at the origin
  const pivot = { x: 595, y: 1.5, z: 0 }; // fresh raycast pivot under the cursor at drag-mousedown
  // Old code measured an 18.03deg jump here; the forward-vector fix must keep it tiny.
  const stepped = M._ccOrbitDragStep(camPos, actualForward, pivot, 2, 0, 0.007);
  const deg = angleBetween(actualForward, stepped.forward);
  assert.ok(deg < 1, `expected a small-angle change (~0.8deg), got ${deg}deg (old bug measured 18.03deg)`);
});

test('orbit drag: rotating around an arbitrary external pivot preserves camera-to-pivot distance', () => {
  const camPos = { x: 10, y: 5, z: 0 };
  const forward = norm({ x: -10, y: -5, z: 0 });
  const pivot = { x: 3, y: 1, z: -2 }; // arbitrary point under the cursor, not on the view ray
  const beforeDist = Math.hypot(camPos.x-pivot.x, camPos.y-pivot.y, camPos.z-pivot.z);
  const stepped = M._ccOrbitDragStep(camPos, forward, pivot, 5, 3, 0.007);
  const afterDist = Math.hypot(stepped.camPos.x-pivot.x, stepped.camPos.y-pivot.y, stepped.camPos.z-pivot.z);
  assert.ok(Math.abs(afterDist - beforeDist) < 1e-9, `camera-pivot distance should be preserved, ${beforeDist} vs ${afterDist}`);
  // forward stays a unit vector
  assert.ok(Math.abs(Math.hypot(stepped.forward.x, stepped.forward.y, stepped.forward.z) - 1) < 1e-9);
});

test('orbit drag: soft polar clamp keeps the view direction within [minPhi, maxPhi] of vertical', () => {
  const camPos = { x: 0, y: 0, z: 60 };
  const forward = norm({ x: 0, y: 0.001, z: -1 }); // nearly horizontal, about to be pushed toward looking straight up
  const stepped = M._ccOrbitDragStep(camPos, forward, camPos, 0, -50000, 0.007, 0.05, Math.PI-0.05);
  const phi = Math.acos(Math.max(-1, Math.min(1, -stepped.forward.y)));
  assert.ok(phi >= 0.05 - 1e-6 && phi <= Math.PI - 0.05 + 1e-6, `phi ${phi} should be clamped within bounds`);
});

test('zoom dolly: the anchor point never moves (stays fixed on screen)', () => {
  const camPos = { x: 100, y: 50, z: 0 };
  const tgt = { x: 0, y: 0, z: 0 };
  const anchor = { x: 20, y: 5, z: -3 };
  const stepped = M._ccZoomDollyStep(camPos, tgt, anchor, 0.7);
  // anchor is a fixed point of the transform: anchor + (anchor-anchor)*f == anchor
  assert.ok(Math.abs(stepped.camPos.x - (anchor.x + (camPos.x-anchor.x)*0.7)) < 1e-9);
});

test('zoom dolly: exactly reversible — factor then 1/factor returns to the exact start', () => {
  const camPos = { x: 137.5, y: -42.1, z: 8.25 };
  const tgt = { x: 3.3, y: 1.1, z: -9.9 };
  const anchor = { x: 12.4, y: 0.7, z: 5.5 };
  const factor = Math.exp(0.37);
  const step1 = M._ccZoomDollyStep(camPos, tgt, anchor, factor);
  const step2 = M._ccZoomDollyStep(step1.camPos, step1.tgt, anchor, 1/factor);
  assert.ok(Math.abs(step2.camPos.x - camPos.x) < 1e-9 && Math.abs(step2.camPos.y - camPos.y) < 1e-9 && Math.abs(step2.camPos.z - camPos.z) < 1e-9,
    `camPos should return exactly: ${JSON.stringify(step2.camPos)} vs ${JSON.stringify(camPos)}`);
  assert.ok(Math.abs(step2.tgt.x - tgt.x) < 1e-9 && Math.abs(step2.tgt.y - tgt.y) < 1e-9 && Math.abs(step2.tgt.z - tgt.z) < 1e-9,
    `tgt should return exactly: ${JSON.stringify(step2.tgt)} vs ${JSON.stringify(tgt)}`);
});

test('zoom dolly: camera-target distance scales by exactly `factor`', () => {
  const camPos = { x: 0, y: 0, z: 1834.26 };
  const tgt = { x: 0, y: 0, z: 0 };
  const anchor = { x: 200, y: 0, z: 0 };
  const factor = 0.6634;
  const before = Math.hypot(camPos.x-tgt.x, camPos.y-tgt.y, camPos.z-tgt.z);
  const stepped = M._ccZoomDollyStep(camPos, tgt, anchor, factor);
  const after = Math.hypot(stepped.camPos.x-stepped.tgt.x, stepped.camPos.y-stepped.tgt.y, stepped.camPos.z-stepped.tgt.z);
  assert.ok(Math.abs(after - before*factor) < 1e-9, `${after} vs ${before*factor}`);
});

test('pan scale: world-units-per-pixel grows linearly with depth and matches the standard perspective-FOV formula', () => {
  const depth = 100, viewportH = 900, fovDeg = 55;
  const wpp = M._ccPanWorldPerPixel(depth, viewportH, fovDeg);
  const expected = 2 * depth * Math.tan((fovDeg*Math.PI/180)/2) / viewportH;
  assert.ok(Math.abs(wpp - expected) < 1e-9);
  // Doubling depth doubles the world-units-per-pixel (so a drag at 2x the
  // distance covers 2x the world distance for the same pixel delta — this is
  // what makes the grabbed point track the cursor regardless of zoom level).
  const wpp2 = M._ccPanWorldPerPixel(depth*2, viewportH, fovDeg);
  assert.ok(Math.abs(wpp2 - wpp*2) < 1e-9);
});

test('pan scale: taller viewport (more pixels for the same vertical FOV) means fewer world units per pixel', () => {
  const wppSmall = M._ccPanWorldPerPixel(100, 900, 55);
  const wppTall = M._ccPanWorldPerPixel(100, 1800, 55);
  assert.ok(Math.abs(wppTall - wppSmall/2) < 1e-9);
});

test('rotate-around-axis: 90deg rotation of (1,0,0) around Y axis gives (0,0,-1) (right-handed)', () => {
  const r = M._ccRotateAroundAxis({x:1,y:0,z:0}, 0,1,0, Math.PI/2);
  assert.ok(Math.abs(r.x) < 1e-9 && Math.abs(r.y) < 1e-9 && Math.abs(r.z - (-1)) < 1e-9, JSON.stringify(r));
});

// Rigid-rotation invariants: the camera→pivot distance and the angle between
// the view direction and the pivot ray are unchanged by any orbit step.
function rigidCheck(camPos, forward, pivot, dx, dy) {
  const s = M._ccOrbitDragStep(camPos, forward, pivot, dx, dy, 0.007, 0.05, Math.PI-0.05);
  const toP0 = { x: pivot.x-camPos.x, y: pivot.y-camPos.y, z: pivot.z-camPos.z };
  const toP1 = { x: pivot.x-s.camPos.x, y: pivot.y-s.camPos.y, z: pivot.z-s.camPos.z };
  assert.ok(Math.abs(Math.hypot(toP0.x, toP0.y, toP0.z) - Math.hypot(toP1.x, toP1.y, toP1.z)) < 1e-6, 'camera-pivot distance preserved');
  const cos = (a, b) => { const na = norm(a), nb = norm(b); return na.x*nb.x + na.y*nb.y + na.z*nb.z; };
  assert.ok(Math.abs(cos(forward, toP0) - cos(s.forward, toP1)) < 1e-9, 'pivot keeps its place relative to the view direction');
  return s;
}

test('orbit drag at the pole stays a rigid rotation (no slide / dolly past the clamp)', () => {
  // View-cube top view: phi = 0.0005, below the drag's minPhi of 0.05.
  const phiTop = 0.0005, theta = 0.3, r = 40;
  const pivot = { x: 2, y: 0, z: -1 };
  const camPos = { x: pivot.x + r*Math.sin(phiTop)*Math.sin(theta), y: pivot.y + r*Math.cos(phiTop), z: pivot.z + r*Math.sin(phiTop)*Math.cos(theta) };
  const forward = norm({ x: pivot.x-camPos.x, y: pivot.y-camPos.y, z: pivot.z-camPos.z });
  const offPivot = { x: pivot.x + 5, y: pivot.y, z: pivot.z + 3 }; // cursor-pivot away from screen centre
  for (const [dx, dy] of [[0, 30], [0, -30], [40, 0], [25, 25], [-25, -25]]) {
    rigidCheck(camPos, forward, pivot, dx, dy);
    rigidCheck(camPos, forward, offPivot, dx, dy);
  }
  // Dragging further over the pole does nothing to the pitch (no jump either).
  const s = rigidCheck(camPos, forward, offPivot, 0, 200);
  const phi = Math.acos(Math.max(-1, Math.min(1, -s.forward.y)));
  assert.ok(Math.abs(phi - phiTop) < 1e-6, `phi ${phi} should stay at ${phiTop}`);
  // Dragging away from the pole tilts the view back down.
  const s2 = rigidCheck(camPos, forward, offPivot, 0, -50);
  const phi2 = Math.acos(Math.max(-1, Math.min(1, -s2.forward.y)));
  assert.ok(phi2 > 0.3, `phi ${phi2} should move away from the pole`);
});

test('orbit drag stops exactly at the polar limit while staying rigid', () => {
  const camPos = { x: 0, y: 30, z: 20 };
  const pivot = { x: 4, y: 0, z: 1 };
  const forward = norm({ x: -camPos.x, y: -camPos.y, z: -camPos.z });
  const s = rigidCheck(camPos, forward, pivot, 0, 5000);
  const phi = Math.acos(Math.max(-1, Math.min(1, -s.forward.y)));
  const s2 = rigidCheck(camPos, forward, pivot, 0, -5000);
  const phi2 = Math.acos(Math.max(-1, Math.min(1, -s2.forward.y)));
  assert.ok(Math.abs(Math.min(phi, phi2) - 0.05) < 1e-6 || Math.abs(Math.max(phi, phi2) - (Math.PI-0.05)) < 1e-6);
});
