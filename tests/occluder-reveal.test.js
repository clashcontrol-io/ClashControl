'use strict';
// Locks _ccResolveOccluderHits / _ccApplyOccluderHide / _ccRevealOccluders
// (index.html) - the Wave 2.2 "occluder-reveal toggle" pure logic. The one
// impure entry point, _ccHideOccluders (constructs a real THREE.Raycaster
// against the live scene), is deliberately NOT covered here - it has no
// logic of its own beyond gluing these three functions to real camera/
// scene state, and this repo has no browser-driven test harness that
// exercises live Three.js scene mutation (unlike tests/browser/smoke.mjs's
// web-ifc/detection path). Everything that COULD be subtly wrong - hit
// resolution across all three mesh types, exclusion, dedup, native
// hide/reveal per type - is pure and tested here with plain-object stand-ins
// for THREE.Mesh/InstancedMesh/BatchedMesh, no real Three.js needed.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFn(name) {
  const header = 'function ' + name + '(';
  const start = src.indexOf('      ' + header);
  assert.ok(start !== -1, name + ' not found');
  const end = src.indexOf('\n      }', start) + '\n      }'.length;
  return src.slice(start, end);
}

const bundle = [
  extractFn('_ccResolveOccluderHits'),
  extractFn('_ccApplyOccluderHide'),
  extractFn('_ccRevealOccluders'),
].join('\n');

function load(overrides) {
  const invalidateCalls = [];
  const THREE = { Matrix4: function () { this._fake = true; } };
  const sandbox = Object.assign({
    THREE: THREE,
    invalidate: function () { invalidateCalls.push(1); },
    _INST_HIDE_MX: { _hideMx: true },
  }, overrides);
  const fn = new Function(...Object.keys(sandbox), bundle + '; return { _ccResolveOccluderHits, _ccApplyOccluderHide, _ccRevealOccluders };')(...Object.values(sandbox));
  fn._invalidateCalls = invalidateCalls;
  return fn;
}

function meshHit(expressId, visible) {
  return { object: { isMesh: true, uuid: 'mesh-' + expressId, userData: { expressId: expressId }, visible: visible !== false }, instanceId: null, batchId: null };
}
function instancedHit(instanceId, exprIds, uuid) {
  const object = {
    isInstancedMesh: true, uuid: uuid || 'inst-1', userData: { instanceExprIds: exprIds },
    instanceMatrix: { needsUpdate: false },
    _matrices: {},
    getMatrixAt(idx, out) { out._capturedIdx = idx; this._matrices[idx] = out; },
    setMatrixAt(idx, mx) { this._matrices['set:' + idx] = mx; },
  };
  return { object: object, instanceId: instanceId, batchId: null };
}
function batchHit(batchId, exprIds, uuid) {
  const visCalls = [];
  const object = {
    isMesh: false, uuid: uuid || 'batch-1', userData: { _isCCBatch: true, batchExprIds: exprIds },
    setVisibleAt(idx, v) { visCalls.push([idx, v]); },
    _visCalls: visCalls,
  };
  return { object: object, instanceId: null, batchId: batchId };
}

test('resolves a regular mesh hit to its expressId, kind "mesh"', () => {
  const { _ccResolveOccluderHits } = load();
  const out = _ccResolveOccluderHits([meshHit(5)], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'mesh');
  assert.equal(out[0].eid, 5);
});

test('resolves an InstancedMesh hit via instanceExprIds[instanceId], kind "instanced"', () => {
  const { _ccResolveOccluderHits } = load();
  const out = _ccResolveOccluderHits([instancedHit(1, [10, 20, 30])], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'instanced');
  assert.equal(out[0].eid, 20);
  assert.equal(out[0].idx, 1);
});

test('resolves a BatchedMesh hit via batchExprIds[batchId], kind "batch"', () => {
  const { _ccResolveOccluderHits } = load();
  const out = _ccResolveOccluderHits([batchHit(0, [100, 200])], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'batch');
  assert.equal(out[0].eid, 100);
});

test('excludes the clash pair\'s own elements (the belt-and-suspenders safety net alongside raycaster.far)', () => {
  const { _ccResolveOccluderHits } = load();
  const out = _ccResolveOccluderHits([meshHit(5), meshHit(6), instancedHit(1, [10, 20])], [5, 20]);
  assert.deepEqual(out.map((o) => o.eid).sort(), [6]);
});

test('deduplicates repeated hits against the same object+index (a ray can cross one mesh twice)', () => {
  const { _ccResolveOccluderHits } = load();
  const out = _ccResolveOccluderHits([meshHit(5), meshHit(5)], []);
  assert.equal(out.length, 1);
});

test('a hit with no resolvable expressId (untagged geometry) is silently skipped, not a crash', () => {
  const { _ccResolveOccluderHits } = load();
  const stray = { object: { isMesh: true, uuid: 'x', userData: {} }, instanceId: null, batchId: null };
  assert.doesNotThrow(() => _ccResolveOccluderHits([stray, meshHit(5)], []));
  assert.equal(_ccResolveOccluderHits([stray, meshHit(5)], []).length, 1);
});

test('tolerates null/empty hits and excludeEids without throwing', () => {
  const { _ccResolveOccluderHits } = load();
  assert.deepEqual(_ccResolveOccluderHits(null, null), []);
  assert.deepEqual(_ccResolveOccluderHits([], []), []);
  assert.deepEqual(_ccResolveOccluderHits([null, undefined], []), []);
});

test('_ccApplyOccluderHide hides a regular mesh via .visible=false and tracks the previous value', () => {
  const { _ccApplyOccluderHide } = load();
  const h = meshHit(5).object;
  const tracked = _ccApplyOccluderHide([{ object: h, kind: 'mesh', idx: null, eid: 5 }]);
  assert.equal(h.visible, false);
  assert.equal(tracked[0].prevVisible, true);
});

test('_ccApplyOccluderHide hides an InstancedMesh instance via setMatrixAt(_INST_HIDE_MX) and captures the previous matrix', () => {
  const { _ccApplyOccluderHide } = load();
  const h = instancedHit(1, [10, 20]).object;
  const tracked = _ccApplyOccluderHide([{ object: h, kind: 'instanced', idx: 1, eid: 20 }]);
  assert.ok(h._matrices['set:1']._hideMx, 'must have used the shared _INST_HIDE_MX constant, not a fresh matrix');
  assert.equal(h.instanceMatrix.needsUpdate, true);
  assert.equal(tracked[0].idx, 1);
  assert.ok(tracked[0].prevMatrix, 'must have captured the pre-hide matrix via getMatrixAt for later restoration');
});

test('_ccApplyOccluderHide hides a BatchedMesh instance via setVisibleAt(idx,false)', () => {
  const { _ccApplyOccluderHide } = load();
  const h = batchHit(0, [100]).object;
  _ccApplyOccluderHide([{ object: h, kind: 'batch', idx: 0, eid: 100 }]);
  assert.deepEqual(h._visCalls, [[0, false]]);
});

test('_ccApplyOccluderHide calls invalidate() once when something was hidden, not at all when nothing was', () => {
  const withHide = load();
  withHide._ccApplyOccluderHide([{ object: meshHit(5).object, kind: 'mesh', idx: null, eid: 5 }]);
  assert.equal(withHide._invalidateCalls.length, 1);
  const noHide = load();
  noHide._ccApplyOccluderHide([]);
  assert.equal(noHide._invalidateCalls.length, 0);
});

test('_ccRevealOccluders restores a regular mesh\'s visibility exactly', () => {
  const { _ccApplyOccluderHide, _ccRevealOccluders } = load();
  const h = meshHit(5).object;
  const tracked = _ccApplyOccluderHide([{ object: h, kind: 'mesh', idx: null, eid: 5 }]);
  assert.equal(h.visible, false);
  _ccRevealOccluders(tracked);
  assert.equal(h.visible, true);
});

test('_ccRevealOccluders restores an InstancedMesh instance to its captured previous matrix', () => {
  const { _ccApplyOccluderHide, _ccRevealOccluders } = load();
  const h = instancedHit(1, [10, 20]).object;
  const tracked = _ccApplyOccluderHide([{ object: h, kind: 'instanced', idx: 1, eid: 20 }]);
  _ccRevealOccluders(tracked);
  assert.equal(h._matrices['set:1'], tracked[0].prevMatrix, 'must restore the exact captured matrix, not a fresh identity');
});

test('_ccRevealOccluders restores a BatchedMesh instance to visible', () => {
  const { _ccApplyOccluderHide, _ccRevealOccluders } = load();
  const h = batchHit(0, [100]).object;
  const tracked = _ccApplyOccluderHide([{ object: h, kind: 'batch', idx: 0, eid: 100 }]);
  _ccRevealOccluders(tracked);
  assert.deepEqual(h._visCalls, [[0, false], [0, true]]);
});

test('a full hide -> reveal round trip across all three mesh types in one call', () => {
  const { _ccResolveOccluderHits, _ccApplyOccluderHide, _ccRevealOccluders } = load();
  const meshObj = meshHit(1).object;
  const instObj = instancedHit(0, [2], 'inst-x').object;
  const batchObj = batchHit(0, [3], 'batch-x').object;
  const hits = [
    { object: meshObj, instanceId: null, batchId: null },
    { object: instObj, instanceId: 0, batchId: null },
    { object: batchObj, instanceId: null, batchId: 0 },
  ];
  const occluders = _ccResolveOccluderHits(hits, [999]);
  assert.equal(occluders.length, 3);
  const tracked = _ccApplyOccluderHide(occluders);
  assert.equal(meshObj.visible, false);
  assert.ok(instObj._matrices['set:0']._hideMx);
  assert.deepEqual(batchObj._visCalls, [[0, false]]);
  _ccRevealOccluders(tracked);
  assert.equal(meshObj.visible, true);
  assert.equal(instObj._matrices['set:0'], tracked.find((t) => t.kind === 'instanced').prevMatrix);
  assert.deepEqual(batchObj._visCalls, [[0, false], [0, true]]);
});
