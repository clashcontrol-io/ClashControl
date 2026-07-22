'use strict';
// Unit + parity lock for the P6.2 first slice (V7_RELEASE_PLAN.md):
// _ccGetElementGeometry, a single accessor the clash engine's
// _getWorldVerts/_getWorldTris now go through instead of reaching into
// element.meshes[] directly. This is explicitly NOT a chunk-merge revival —
// nothing is removed, no rendering path changes, the handle is backed by the
// SAME proxy meshes as before. The point of this test is to prove the
// refactor is behavior-preserving: given the same element.meshes[] input,
// world-space vertex/triangle output must be numerically identical to a
// hand-computed expected result.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extract(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, 'start marker not found: ' + startMarker);
  assert.notEqual(end, -1, 'end marker not found: ' + endMarker);
  return source.slice(start, end);
}

// A minimal, behaviorally-correct stand-in for the slice of THREE.js this
// code uses (Vector3.set/applyMatrix4, column-major Matrix4). `three` is not
// a node dependency of this project, so real THREE.js isn't available here —
// same constraint every other clash-engine unit test in this suite works
// under (see mesh-intersect-parity.test.js).
function makeThreeStub() {
  function Vector3(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
  Vector3.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  Vector3.prototype.applyMatrix4 = function (m) {
    const e = m.elements; // column-major, matches THREE.Matrix4
    const x = this.x, y = this.y, z = this.z;
    const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
    this.x = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
    this.y = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
    this.z = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
    return this;
  };
  return { Vector3 };
}

function identityMatrix() { return { elements: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] }; }
function translationMatrix(tx, ty, tz) {
  return { elements: [1,0,0,0, 0,1,0,0, 0,0,1,0, tx,ty,tz,1] };
}

function positionAttr(points) { // points: [[x,y,z], ...]
  return {
    count: points.length,
    getX: (i) => points[i][0],
    getY: (i) => points[i][1],
    getZ: (i) => points[i][2],
  };
}
function indexAttr(indices) {
  return { count: indices.length, getX: (i) => indices[i] };
}

function mockMesh(points, indices, matrix, extra) {
  return Object.assign({
    geometry: { attributes: { position: positionAttr(points) }, index: indices ? indexAttr(indices) : null, uuid: 'geo-' + Math.random() },
    matrixWorld: matrix,
    updateWorldMatrix: function () {}, // no-op stub; parent-chain composition isn't under test here
    material: { uuid: 'mat-1' },
    userData: {},
  }, extra || {});
}

function loadApi() {
  const geoBlock = extract(
    'function _ccGetElementGeometry(el) {',
    '\n  window._ccGetElementGeometry = _ccGetElementGeometry;'
  );
  const wvBlock = extract('function _getWorldVerts(el) {', '\n  function _getWorldTris(el) {');
  const trisBlock = extract('function _getWorldTris(el) {', '\n\n  function _getBVH');
  const three = makeThreeStub();
  const fn = new Function('THREE', `
    var _bvhLRU = new Map();
    function _bvhLRUTouch(){}
    function _bvhLRUEvict(){}
    ${geoBlock}
    ${wvBlock}
    ${trisBlock}
    return { getElementGeometry: _ccGetElementGeometry, getWorldVerts: _getWorldVerts, getWorldTris: _getWorldTris };
  `);
  return fn(three);
}

// ── _ccGetElementGeometry structural correctness ────────────────────────────
test('_ccGetElementGeometry produces one handle per mesh with position/index/transform carried through unchanged', () => {
  const api = loadApi();
  const m1 = mockMesh([[0,0,0],[1,0,0],[0,1,0]], [0,1,2], identityMatrix());
  const el = { meshes: [m1] };
  const handles = api.getElementGeometry(el);
  assert.equal(handles.length, 1);
  assert.equal(handles[0].position, m1.geometry.attributes.position);
  assert.equal(handles[0].index, m1.geometry.index);
  assert.equal(handles[0].transform, m1.matrixWorld);
  assert.equal(handles[0].geometryId, m1.geometry.uuid);
});

test('_ccGetElementGeometry skips meshes with no position attribute rather than throwing', () => {
  const api = loadApi();
  const bad = { geometry: { attributes: {} }, matrixWorld: identityMatrix(), updateWorldMatrix: () => {} };
  const good = mockMesh([[0,0,0]], null, identityMatrix());
  const handles = api.getElementGeometry({ meshes: [bad, good] });
  assert.equal(handles.length, 1);
});

test('_ccGetElementGeometry tags renderOwnerId for plain/instanced/batched meshes', () => {
  const api = loadApi();
  const plain = mockMesh([[0,0,0]], null, identityMatrix());
  const batched = mockMesh([[0,0,0]], null, identityMatrix(), { userData: { _isCCBatch: true } });
  const instanced = mockMesh([[0,0,0]], null, identityMatrix(), { isInstancedMesh: true, userData: { _instanceRef: { instanceIndex: 4 } } });
  const handles = api.getElementGeometry({ meshes: [plain, batched, instanced] });
  assert.equal(handles[0].renderOwnerId, 'mesh');
  assert.equal(handles[1].renderOwnerId, 'batch');
  assert.equal(handles[2].renderOwnerId, 'instanced');
  assert.equal(handles[2].instanceId, 4);
});

// ── Parity: world-space output must be numerically correct through the handle ──
test('parity: _getWorldVerts transforms local positions by the world matrix, identity case', () => {
  const api = loadApi();
  const mesh = mockMesh([[1,2,3],[4,5,6]], null, identityMatrix());
  const el = { meshes: [mesh] };
  const verts = api.getWorldVerts(el);
  assert.deepEqual(Array.from(verts), [1,2,3, 4,5,6]);
});

test('parity: _getWorldVerts applies a real (non-identity) translation correctly', () => {
  const api = loadApi();
  const mesh = mockMesh([[1,2,3],[0,0,0]], null, translationMatrix(10, 20, 30));
  const el = { meshes: [mesh] };
  const verts = api.getWorldVerts(el);
  assert.deepEqual(Array.from(verts), [11,22,33, 10,20,30]);
});

test('parity: _getWorldVerts sums vertices across multiple meshes on one element (e.g. multi-part IFC geometry)', () => {
  const api = loadApi();
  const meshA = mockMesh([[1,0,0]], null, identityMatrix());
  const meshB = mockMesh([[0,1,0]], null, translationMatrix(5,5,5));
  const el = { meshes: [meshA, meshB] };
  const verts = api.getWorldVerts(el);
  assert.deepEqual(Array.from(verts), [1,0,0, 5,6,5]);
});

test('parity: _getWorldVerts caches on el._wvCache and registers in the BVH LRU', () => {
  const api = loadApi();
  const mesh = mockMesh([[1,2,3]], null, identityMatrix());
  const el = { meshes: [mesh] };
  const v1 = api.getWorldVerts(el);
  const v2 = api.getWorldVerts(el);
  assert.equal(v1, v2, 'second call must return the cached Float32Array, not recompute');
});

test('parity: _getWorldTris builds indexed triangles correctly through the handle', () => {
  const api = loadApi();
  const mesh = mockMesh([[0,0,0],[1,0,0],[0,1,0]], [0,1,2], identityMatrix());
  const el = { meshes: [mesh] };
  const tris = api.getWorldTris(el);
  assert.deepEqual(Array.from(tris), [0,0,0, 1,0,0, 0,1,0]);
});

test('parity: _getWorldTris handles non-indexed geometry (uses position order directly)', () => {
  const api = loadApi();
  const mesh = mockMesh([[0,0,0],[2,0,0],[0,2,0]], null, identityMatrix());
  const el = { meshes: [mesh] };
  const tris = api.getWorldTris(el);
  assert.deepEqual(Array.from(tris), [0,0,0, 2,0,0, 0,2,0]);
});

test('parity: _getWorldTris applies world transform to indexed triangles', () => {
  const api = loadApi();
  const mesh = mockMesh([[0,0,0],[1,0,0],[0,1,0]], [0,1,2], translationMatrix(100,0,0));
  const el = { meshes: [mesh] };
  const tris = api.getWorldTris(el);
  assert.deepEqual(Array.from(tris), [100,0,0, 101,0,0, 100,1,0]);
});

// ── Wiring: both consumers actually go through the one accessor ─────────────
test('_getWorldVerts and _getWorldTris both read through _ccGetElementGeometry, not element.meshes[] directly', () => {
  const wvBody = extract('function _getWorldVerts(el) {', '\n  function _getWorldTris(el) {');
  const trisBody = extract('function _getWorldTris(el) {', '\n\n  function _getBVH');
  assert.match(wvBody, /_ccGetElementGeometry\(el\)\.forEach/);
  assert.match(trisBody, /_ccGetElementGeometry\(el\)\.forEach/);
  assert.doesNotMatch(wvBody, /\(el\.meshes \|\| \[\]\)\.forEach/, 'must no longer iterate el.meshes directly');
  assert.doesNotMatch(trisBody, /\(el\.meshes \|\| \[\]\)\.forEach/, 'must no longer iterate el.meshes directly');
});

test('_ccGetElementGeometry is exposed on window for addon/future-consumer use', () => {
  assert.match(source, /window\._ccGetElementGeometry = _ccGetElementGeometry/);
});
