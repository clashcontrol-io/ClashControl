'use strict';
// viewer-pick-core.js: hit matrices (Mesh / InstancedMesh / BatchedMesh),
// the first-visible-hit filter and the measure snap (vertex > midpoint >
// edge > face). Plain arrays stand in for three.js objects.
// Regressions: batched elements never snapped (batch matrix ignored, so the
// candidates sat at the geometry's local origin -> always "Surface"); only
// the hit triangle's own 3 vertices were candidates (no edges); hover
// snapped to geometry cut away by a section plane.
const { test } = require('node:test');
const assert = require('node:assert');
const VP = require('../viewer-pick-core.js');

const I = () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const T = (x, y, z) => [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];

// Axis-aligned box triangles (two per face, outward winding), half-size h.
function boxTris(cx, cy, cz, h) {
  const v = (sx, sy, sz) => [cx + sx*h, cy + sy*h, cz + sz*h];
  const faces = [
    [v(-1,-1, 1), v( 1,-1, 1), v( 1, 1, 1), v(-1, 1, 1)], // +z
    [v( 1,-1,-1), v(-1,-1,-1), v(-1, 1,-1), v( 1, 1,-1)], // -z
    [v( 1,-1, 1), v( 1,-1,-1), v( 1, 1,-1), v( 1, 1, 1)], // +x
    [v(-1,-1,-1), v(-1,-1, 1), v(-1, 1, 1), v(-1, 1,-1)], // -x
    [v(-1, 1, 1), v( 1, 1, 1), v( 1, 1,-1), v(-1, 1,-1)], // +y
    [v(-1,-1,-1), v( 1,-1,-1), v( 1,-1, 1), v(-1,-1, 1)], // -y
  ];
  const out = [];
  for (const [a, b, c, d] of faces) out.push(...a, ...b, ...c, ...a, ...c, ...d);
  return out;
}
function geometry(positions) {
  const n = positions.length / 3;
  return { attributes: { position: { array: Float32Array.from(positions), itemSize: 3, count: n } },
    index: { array: Uint32Array.from({ length: n }, (_, i) => i), count: n } };
}

// Camera at (10,0,10) looking down -Z, 800x600 px, focal 600 px.
const project = (p) => {
  const w = 10 - p.z;
  if (w <= 0) return null;
  return { x: 400 + 600 * (p.x - 10) / w, y: 300 - 600 * p.y / w, w };
};
const unprojectAtZ = (sx, sy, z) => { const w = 10 - z; return { x: 10 + (sx - 400) * w / 600, y: (300 - sy) * w / 600, z }; };
// Only the box's front face (z=1) is visible from this camera.
const isOccluded = (p) => p.z < 1 - 1e-6;

// A BatchedMesh with two geometries: #0 a decoy box, #1 a 2 m box modelled
// around its LOCAL origin; batch instance 1 places it at x=10.
function batchedObject() {
  const pos = boxTris(-50, 0, 0, 3).concat(boxTris(0, 0, 0, 1));
  return {
    isMesh: true, isBatchedMesh: true, visible: true, parent: null,
    userData: { _isCCBatch: true, batchGeomIds: [0, 1] },
    matrixWorld: { elements: I() },
    geometry: geometry(pos),
    getMatrixAt(id, m) { return m.fromArray(id === 1 ? T(10, 0, 0) : T(0, 0, 0), 0); },
    getGeometryIdAt(id) { return id; },
    getGeometryRangeAt(gid, target) { target.start = gid * 36; target.count = 36; return target; },
  };
}
function batchedHit(sx, sy) {
  return { object: batchedObject(), batchId: 1, faceIndex: 12, point: unprojectAtZ(sx, sy, 1), distance: 9 };
}

test('hitMatrix composes matrixWorld with the BatchedMesh batch-instance matrix', () => {
  const hit = { object: Object.assign(batchedObject(), { matrixWorld: { elements: T(1, 2, 3) } }), batchId: 1 };
  const m = VP.hitMatrix(hit);
  assert.deepStrictEqual([m[12], m[13], m[14]], [11, 2, 3]);
});

test('hitMatrix composes the InstancedMesh instance matrix; plain Mesh uses matrixWorld', () => {
  const inst = { isInstancedMesh: true, matrixWorld: { elements: T(0, 1, 0) }, getMatrixAt(id, m) { return m.fromArray(T(id, 0, 0), 0); } };
  const m = VP.hitMatrix({ object: inst, instanceId: 4 });
  assert.deepStrictEqual([m[12], m[13], m[14]], [4, 1, 0]);
  const plain = { matrixWorld: { elements: T(7, 0, 0) } };
  assert.strictEqual(VP.hitMatrix({ object: plain })[12], 7);
});

test('batched element: snaps to its world-space corner vertex near the cursor', () => {
  // Front top-left corner (9,1,1) projects to (333.3, 233.3); cursor 5 px inside.
  const r = VP.snap({ hit: batchedHit(338.3, 238.3), cursor: { x: 338.3, y: 238.3 }, project, isOccluded });
  assert.strictEqual(r.type, 'vertex');
  assert.ok(Math.hypot(r.point.x - 9, r.point.y - 1, r.point.z - 1) < 1e-6, JSON.stringify(r.point));
});

test('edge chosen 10 px from an edge mid-span (not its midpoint, not the face)', () => {
  // Front top edge (9..11, 1, 1) projects to y=233.3; cursor 10 px below its middle.
  const sy = 300 - 600 / 9 + 10;
  const r = VP.snap({ hit: batchedHit(400, sy), cursor: { x: 400, y: sy }, project, isOccluded });
  assert.strictEqual(r.type, 'edge');
  assert.ok(Math.hypot(r.point.x - 10, r.point.y - 1, r.point.z - 1) < 1e-6, JSON.stringify(r.point));
});

test('midpoint chosen right next to the middle of an edge', () => {
  const sy = 300 - 600 / 9 + 3;
  const r = VP.snap({ hit: batchedHit(401, sy), cursor: { x: 401, y: sy }, project, isOccluded });
  assert.strictEqual(r.type, 'midpoint');
  assert.ok(Math.hypot(r.point.x - 10, r.point.y - 1, r.point.z - 1) < 1e-6);
});

test('a triangulation diagonal of a flat face is not an edge -> face', () => {
  // Centre of the front face lies on its diagonal.
  const r = VP.snap({ hit: batchedHit(400, 300), cursor: { x: 400, y: 300 }, project, isOccluded });
  assert.strictEqual(r.type, 'face');
});

test('occluded candidates are skipped (back edge projecting closer than the front edge)', () => {
  // Back top edge (z=-1) projects to y=245.5, front top edge to 233.3; cursor at 246.
  const r = VP.snap({ hit: batchedHit(400, 246), cursor: { x: 400, y: 246 }, project, isOccluded });
  assert.ok(r.type === 'face' || r.point.z > 0.999, JSON.stringify(r));
});

test('section-clipped hit is rejected by firstVisibleHit, and clipped corners are never snapped', () => {
  const plane = { normal: { x: 0, y: -1, z: 0 }, constant: 0.5 }; // keeps y <= 0.5
  const clipped = { object: { visible: true }, point: { x: 10, y: 0.9, z: 1 } };
  const kept = { object: { visible: true }, point: { x: 10, y: 0.2, z: 1 } };
  assert.strictEqual(VP.firstVisibleHit([clipped, kept], { planes: [plane] }), kept);
  assert.strictEqual(VP.firstVisibleHit([clipped], { planes: [plane] }), null);
  const r = VP.snap({ hit: batchedHit(338.3, 238.3), cursor: { x: 338.3, y: 238.3 }, project, isOccluded, planes: [plane] });
  assert.ok(r.point.y <= 0.5 + 0.01 || r.type === 'face', JSON.stringify(r));
  assert.notStrictEqual(r.type, 'vertex');
});

test('firstVisibleHit skips hidden objects, hidden ancestors and ghosted materials', () => {
  const ghost = {};
  const hidden = { object: { visible: false }, point: { x: 0, y: 0, z: 0 } };
  const hiddenParent = { object: { visible: true, parent: { visible: false } }, point: { x: 0, y: 0, z: 0 } };
  const ghosted = { object: { visible: true, material: ghost }, point: { x: 0, y: 0, z: 0 } };
  const ok = { object: { visible: true, material: {} }, point: { x: 0, y: 0, z: 0 } };
  assert.strictEqual(VP.firstVisibleHit([hidden, hiddenParent, ghosted, ok], { isGhost: (m) => m === ghost }), ok);
});

test('work is capped on huge elements (window of maxTris around the hit face)', () => {
  const pos = [];
  for (let i = 0; i < 300; i++) pos.push(...boxTris(i * 100, 0, 0, 1));
  pos.push(...boxTris(10, 0, 0, 1));
  const obj = { visible: true, matrixWorld: { elements: I() }, geometry: geometry(pos) };
  const hit = { object: obj, faceIndex: 300 * 12 + 6, point: unprojectAtZ(338.3, 238.3, 1) };
  const r = VP.snap({ hit, cursor: { x: 338.3, y: 238.3 }, project, isOccluded, maxTris: 24 });
  assert.strictEqual(r.type, 'vertex');
});

test('a hidden back corner closer to the cursor does not hide the visible front corner', () => {
  // Back corner (9,1,-1) projects to (345.5, 245.5), 6.4 px from the cursor;
  // front corner (9,1,1) to (333.3, 233.3), 10.9 px. The back one is the
  // endpoint of three feature edges — it must cost one occlusion check, not three.
  const r = VP.snap({ hit: batchedHit(341, 241), cursor: { x: 341, y: 241 }, project, isOccluded });
  assert.strictEqual(r.type, 'vertex');
  assert.ok(Math.hypot(r.point.x - 9, r.point.y - 1, r.point.z - 1) < 1e-6, JSON.stringify(r.point));
});
