'use strict';
// Locks the CW-1a real (approximate) penetration-depth estimator
// (index.html, _rayTriHit through _estimatePenetrationDepthM) against
// analytic solids with hand-computed expected answers. This replaces what
// used to be a per-triangle-pair SAT chord length (unreliable: long for
// shallow grazes between big triangles, short on finely tessellated deep
// overlaps) with vertex-inside-mesh (3-axis ray-parity majority vote) +
// true closest-point-on-surface (Ericson's algorithm), maxed over both
// sides. Extracted the same way tests/ifc-units.test.js pulls a slice out
// of the inline script.
//
// _estimatePenetrationDepthM calls the real _getBVH/_getWorldVerts, which
// are THREE.js-backed — but both check an el._bvhCache/el._wvCache field
// FIRST and return immediately if it's already populated (the normal case
// once a detection run has warmed the cache). Pre-populating those fields
// with hand-built analytic geometry exercises the exact same code path
// production uses, with zero THREE.js mocking.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('function _getWorldVerts(el) {');
assert.ok(start !== -1, '_getWorldVerts not found');
const fnStart = src.indexOf('function _estimatePenetrationDepthM(elA, elB) {', start);
assert.ok(fnStart !== -1, '_estimatePenetrationDepthM not found');
const retLine = src.indexOf('return found ? best : null;', fnStart);
assert.ok(retLine !== -1, '_estimatePenetrationDepthM body not found');
const closeIdx = src.indexOf('\n  }', retLine) + '\n  }'.length;
const _window = {};
new Function('window', src.slice(start, closeIdx) + `
  window._ccT_rayTriHit = _rayTriHit;
  window._ccT_pointInMeshBVH = _pointInMeshBVH;
  window._ccT_closestPtTriDistSq = _closestPtTriDistSq;
  window._ccT_closestDistToBVH = _closestDistToBVH;
  window._ccT_buildBVHNode = _buildBVHNode;
  window._ccT_estimatePenetrationDepthM = _estimatePenetrationDepthM;
`)(_window);

const _rayTriHit = _window._ccT_rayTriHit;
const _pointInMeshBVH = _window._ccT_pointInMeshBVH;
const _closestPtTriDistSq = _window._ccT_closestPtTriDistSq;
const _closestDistToBVH = _window._ccT_closestDistToBVH;
const _buildBVHNode = _window._ccT_buildBVHNode;
const _estimatePenetrationDepthM = _window._ccT_estimatePenetrationDepthM;
[_rayTriHit, _pointInMeshBVH, _closestPtTriDistSq, _closestDistToBVH, _buildBVHNode, _estimatePenetrationDepthM]
  .forEach((fn) => assert.equal(typeof fn, 'function'));

// ── Analytic solid builders ──────────────────────────────────────
// Axis-aligned box as a 12-triangle soup (2 per face), flat Float32Array,
// 9 floats/triangle — the exact same layout _getWorldTris produces.
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
function boxVerts(x0, y0, z0, x1, y1, z1) {
  var out = [];
  [x0, x1].forEach(function (x) { [y0, y1].forEach(function (y) { [z0, z1].forEach(function (z) { out.push(x, y, z); }); }); });
  return new Float32Array(out);
}
function buildBVH(tris) {
  var n = tris.length / 9;
  var indices = new Int32Array(n);
  for (var i = 0; i < n; i++) indices[i] = i;
  return { tris: tris, root: _buildBVHNode(tris, indices, 0, n) };
}
// A "prepared" element: pre-populated caches short-circuit _getWorldVerts/
// _getBVH before they ever touch THREE.js.
function preparedEl(x0, y0, z0, x1, y1, z1) {
  var tris = boxTris(x0, y0, z0, x1, y1, z1);
  return { _wvCache: boxVerts(x0, y0, z0, x1, y1, z1), _bvhCache: buildBVH(tris) };
}

// ── _rayTriHit ────────────────────────────────────────────────────
test('_rayTriHit: ray through triangle centroid hits at the expected t', () => {
  var tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]); // right triangle in z=0 plane
  var t = _rayTriHit(0.2, 0.2, -5, 0, 0, 1, tri, 0); // shoot +Z from below centroid-ish point
  assert.ok(t > 4.9 && t < 5.1, 'expected t≈5, got ' + t);
});
test('_rayTriHit: ray outside the triangle footprint misses', () => {
  var tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  var t = _rayTriHit(5, 5, -5, 0, 0, 1, tri, 0);
  assert.equal(t, -1);
});
test('_rayTriHit: ray parallel to the triangle plane misses (near-zero determinant)', () => {
  var tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]); // z=0 plane
  var t = _rayTriHit(0.2, 0.2, 0, 1, 0, 0, tri, 0); // ray travels within the plane
  assert.equal(t, -1);
});

// ── _pointInMeshBVH ───────────────────────────────────────────────
test('REGRESSION: _pointInMeshBVH: center of a unit cube is inside', () => {
  // This exact input caught a real bug during development: boxTris splits
  // each face into 2 triangles along a diagonal, and a ray cast from the
  // cube's exact center along a pure axis (1,0,0)/(0,1,0)/(0,0,1) exits
  // precisely along the +X/+Y/+Z face's diagonal - landing squarely on the
  // shared edge between that face's two triangles, on all 3 axes
  // simultaneously (the cube and the query point are both fully symmetric).
  // _rayTriHit's inclusive edge tolerance means BOTH triangles sharing that
  // edge counted it as a hit, doubling one true crossing into two - flipping
  // odd parity to even on every axis at once, so even the 3-axis majority
  // vote couldn't save it: _pointInMeshBVH returned false for the single
  // most obviously-inside point a unit cube has. Fixed by casting along
  // fixed small off-axis tilts (_PEN_RAY_DIRS) instead of pure axes -
  // exactly axis-aligned rays are the worst choice for this codebase's
  // geometry anyway, since IFC building elements are overwhelmingly
  // axis-aligned (walls, slabs, beams), which is exactly what maximizes the
  // odds of a dead-on edge graze.
  var bvh = buildBVH(boxTris(0, 0, 0, 1, 1, 1));
  assert.equal(_pointInMeshBVH(0.5, 0.5, 0.5, bvh), true);
});
test('_pointInMeshBVH: point far outside a unit cube is outside', () => {
  var bvh = buildBVH(boxTris(0, 0, 0, 1, 1, 1));
  assert.equal(_pointInMeshBVH(10, 10, 10, bvh), false);
  assert.equal(_pointInMeshBVH(-5, 0.5, 0.5, bvh), false);
});
test('_pointInMeshBVH: points just inside vs just outside each face', () => {
  var bvh = buildBVH(boxTris(0, 0, 0, 1, 1, 1));
  assert.equal(_pointInMeshBVH(0.99, 0.5, 0.5, bvh), true);
  assert.equal(_pointInMeshBVH(1.01, 0.5, 0.5, bvh), false);
  assert.equal(_pointInMeshBVH(0.5, 0.5, 0.01, bvh), true);
  assert.equal(_pointInMeshBVH(0.5, 0.5, -0.01, bvh), false);
});

// ── _closestPtTriDistSq ───────────────────────────────────────────
test('_closestPtTriDistSq: point directly above the face interior', () => {
  var tri = new Float32Array([0, 0, 0, 4, 0, 0, 0, 4, 0]); // right triangle, legs along x/y
  var d2 = _closestPtTriDistSq(1, 1, 3, tri, 0); // above a point inside the triangle
  assert.ok(Math.abs(Math.sqrt(d2) - 3) < 1e-4);
});
test('_closestPtTriDistSq: point beyond a vertex snaps to that vertex', () => {
  var tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  var d2 = _closestPtTriDistSq(-3, -4, 0, tri, 0); // way past vertex (0,0,0), in-plane
  assert.ok(Math.abs(Math.sqrt(d2) - 5) < 1e-4); // 3-4-5 triangle to the origin vertex
});
test('_closestPtTriDistSq: point beside an edge snaps to the edge, not a vertex', () => {
  var tri = new Float32Array([0, 0, 0, 10, 0, 0, 5, 10, 0]); // wide triangle, base on x-axis
  var d2 = _closestPtTriDistSq(5, -2, 0, tri, 0); // straight below the base's midpoint
  assert.ok(Math.abs(Math.sqrt(d2) - 2) < 1e-4);
});

// ── _closestDistToBVH ─────────────────────────────────────────────
test('_closestDistToBVH: distance from a point outside a cube face to its surface', () => {
  var bvh = buildBVH(boxTris(0, 0, 0, 1, 1, 1));
  var d = _closestDistToBVH(1.4, 0.5, 0.5, bvh); // 0.4 beyond the +X face, centered on it
  assert.ok(Math.abs(d - 0.4) < 1e-4);
});
test('_closestDistToBVH: zero at the surface itself', () => {
  var bvh = buildBVH(boxTris(0, 0, 0, 1, 1, 1));
  var d = _closestDistToBVH(1, 0.5, 0.5, bvh);
  assert.ok(d < 1e-4);
});

// ── _estimatePenetrationDepthM — full analytic-solid integration ──
test('two unit cubes offset on all 3 axes: penetration = the smallest overlap dimension (0.3)', () => {
  var A = preparedEl(0, 0, 0, 1, 1, 1);
  var B = preparedEl(0.7, 0.3, 0.3, 1.7, 1.3, 1.3); // overlap box: 0.3 x 0.7 x 0.7
  var depth = _estimatePenetrationDepthM(A, B);
  assert.ok(depth != null, 'expected a numeric depth, got null');
  assert.ok(Math.abs(depth - 0.3) < 1e-3, 'expected ≈0.3, got ' + depth);
});
test('a post penetrating 0.2 into a 0.3-thick slab (not all the way through): depth = distance to the far face (0.1)', () => {
  var slab = preparedEl(-2, -2, 0, 2, 2, 0.3);
  var post = preparedEl(-0.1, -0.1, -1, 0.1, 0.1, 0.2); // reaches 0.2 up into the 0.3-thick slab
  var depth = _estimatePenetrationDepthM(post, slab);
  assert.ok(depth != null, 'expected a numeric depth, got null');
  assert.ok(Math.abs(depth - 0.1) < 1e-3, 'expected ≈0.1, got ' + depth);
});
test('KNOWN LIMITATION, by design: a thin post fully through a slab with no vertex inside either solid returns null', () => {
  // The post's own corners are far above/below the slab (z=-1 and z=1 vs
  // slab z=[0,0.3]); the slab's corners are far outside the post's tiny
  // x/y footprint. The surfaces genuinely cross, but no *vertex* of either
  // mesh lies inside the other, so vertex sampling can't see it — this is
  // exactly the documented fallback trigger (caller must use the
  // chord-length/AABB estimate instead of trusting a false "no penetration").
  var slab = preparedEl(-2, -2, 0, 2, 2, 0.3);
  var post = preparedEl(-0.1, -0.1, -1, 0.1, 0.1, 1);
  assert.equal(_estimatePenetrationDepthM(post, slab), null);
});
test('two disjoint (non-intersecting) cubes: no interior vertices, returns null', () => {
  var A = preparedEl(0, 0, 0, 1, 1, 1);
  var B = preparedEl(5, 5, 5, 6, 6, 6);
  assert.equal(_estimatePenetrationDepthM(A, B), null);
});
test('one cube fully inside another, centered: depth = each corner\'s distance to the nearest outer face', () => {
  // Centered inner cube makes all 8 corners symmetric (every corner's
  // min-distance-to-any-outer-face is the same 4), so the expected value
  // isn't sensitive to which single corner the max picks out — an
  // off-center inner box is a real case too, but its expected value
  // depends on which corner is "most centered" (max of 8 per-corner
  // minimums, not simply "distance to the nearest face overall"), which
  // is easy to get wrong by hand; the symmetric case pins the algorithm
  // down unambiguously.
  var outer = preparedEl(0, 0, 0, 10, 10, 10);
  var inner = preparedEl(4, 4, 4, 6, 6, 6);
  var depth = _estimatePenetrationDepthM(inner, outer);
  assert.ok(depth != null);
  assert.ok(Math.abs(depth - 4) < 1e-3, 'expected ≈4, got ' + depth);
});
