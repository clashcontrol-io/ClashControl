'use strict';
// Unit lock for the P6.1 byte-accurate residency ledger (V7_RELEASE_PLAN.md).
// Replaces element-count as the proxy for "how much memory would parking this
// model reclaim" and fixes the memory report's per-proxy vertex sum, which
// double-counts geometry shared by an InstancedMesh group. Every function
// under test is duck-typed against plain object fixtures (no real Three.js
// BufferGeometry needed), matching the extract-and-eval pattern used
// elsewhere in this suite (see local-engine-units.test.js).
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

const block = extract(
  'function _ccGeometryByteSize(g) {',
  '\n  window._ccComputeResidencyLedger = _ccComputeResidencyLedger;'
);

function loadApi() {
  return new Function(`
    ${block}
    return {
      geometryByteSize: _ccGeometryByteSize,
      instancedExtraBytes: _ccInstancedExtraBytes,
      approxPropsBytes: _ccApproxPropsBytes,
      computeResidencyLedger: _ccComputeResidencyLedger,
    };
  `)();
}

// ── Fixtures ────────────────────────────────────────────────────────────────
function geo(uuid, posFloats, idxInts) {
  const attrs = { position: { array: { byteLength: posFloats * 4 } } };
  const out = { uuid, attributes: attrs };
  if (idxInts != null) out.index = { array: { byteLength: idxInts * 4 } };
  return out;
}
function proxyMesh(geometry) { return { geometry }; }
function element(meshes, props) { return { meshes: meshes || [], props: props || null }; }

test('_ccGeometryByteSize sums all attribute arrays + index, ignores missing ones', () => {
  const api = loadApi();
  const g = geo('g1', 300, 100); // 300 floats position + 100 ints index
  assert.equal(api.geometryByteSize(g), 300 * 4 + 100 * 4);
  assert.equal(api.geometryByteSize(null), 0);
  assert.equal(api.geometryByteSize({ attributes: {} }), 0);
});

test('_ccInstancedExtraBytes counts only instanceMatrix/instanceColor, not base geometry', () => {
  const api = loadApi();
  const mesh = {
    instanceMatrix: { array: { byteLength: 1600 } }, // 16 floats * 100 instances * 4B
    instanceColor: { array: { byteLength: 1200 } },  // 3 floats * 100 instances * 4B
  };
  assert.equal(api.instancedExtraBytes(mesh), 1600 + 1200);
  assert.equal(api.instancedExtraBytes({}), 0);
});

test('_ccApproxPropsBytes charges a shared psets/quantities reference only ONCE across elements', () => {
  const api = loadApi();
  const sharedPsets = { Pset_WallCommon: { IsExternal: true, LoadBearing: false } };
  const seen = new Set();
  const b1 = api.approxPropsBytes({ ifcType: 'IfcWall', psets: sharedPsets }, seen);
  const b2 = api.approxPropsBytes({ ifcType: 'IfcWall', psets: sharedPsets }, seen);
  assert.ok(b1 > b2, 'the second element sharing the same canonicalized psets reference must be charged less');
  // b2 should be just the per-element scalar fields, not the psets payload again.
  const scalarOnly = api.approxPropsBytes({ ifcType: 'IfcWall' }, new Set());
  assert.equal(b2, scalarOnly);
});

test('_ccApproxPropsBytes charges two DIFFERENT psets references independently', () => {
  const api = loadApi();
  const seen = new Set();
  const b1 = api.approxPropsBytes({ ifcType: 'IfcWall', psets: { A: 1 } }, seen);
  const b2 = api.approxPropsBytes({ ifcType: 'IfcWall', psets: { B: 2 } }, seen);
  assert.ok(b2 > 0);
  const scalarOnly = api.approxPropsBytes({ ifcType: 'IfcWall' }, new Set());
  assert.ok(b1 > scalarOnly && b2 > scalarOnly, 'distinct references must each be charged their own payload');
});

test('computeResidencyLedger dedups shared geometry within a model (fixes the double-count bug)', () => {
  const api = loadApi();
  const sharedGeo = geo('shared-1', 300, 90);
  const models = [{
    id: 'm1',
    elements: [
      element([proxyMesh(sharedGeo)]),
      element([proxyMesh(sharedGeo)]), // same geometry reference — an instanced group
      element([proxyMesh(sharedGeo)]),
    ],
  }];
  const ledger = api.computeResidencyLedger(models);
  // Un-deduped (the old per-proxy sum) would be 3x geometryByteSize; deduped
  // must be exactly ONE copy.
  assert.equal(ledger.perModel.m1.geoBytes, api.geometryByteSize(sharedGeo));
  assert.equal(ledger.perModel.m1.proxyCount, 3, 'proxy COUNT is still per-instance (that figure is legitimately about object count, not bytes)');
});

test('computeResidencyLedger counts distinct geometries independently', () => {
  const api = loadApi();
  const gA = geo('a', 300, 90), gB = geo('b', 900, 300);
  const models = [{ id: 'm1', elements: [element([proxyMesh(gA)]), element([proxyMesh(gB)])] }];
  const ledger = api.computeResidencyLedger(models);
  assert.equal(ledger.perModel.m1.geoBytes, api.geometryByteSize(gA) + api.geometryByteSize(gB));
});

test('computeResidencyLedger adds BVH world-vert/world-tri cache bytes per element', () => {
  const api = loadApi();
  const el = element([proxyMesh(geo('g', 300, 90))]);
  el._wvCache = { byteLength: 1200 };
  el._triCache = { byteLength: 3600 };
  const ledger = api.computeResidencyLedger([{ id: 'm1', elements: [el] }]);
  assert.ok(ledger.perModel.m1.bvhBytes >= 1200 + 3600, 'must include at least the raw cache array bytes');
});

test('computeResidencyLedger adds an approximate BVH tree-node overhead only when _bvhCache exists', () => {
  const api = loadApi();
  const withTree = element([proxyMesh(geo('g', 300, 90))]);
  withTree._triCache = { byteLength: 3600 }; // 100 triangles (9 floats * 4B each)
  withTree._bvhCache = { tris: withTree._triCache, root: {} };
  const withoutTree = element([proxyMesh(geo('g2', 300, 90))]);
  withoutTree._triCache = { byteLength: 3600 };
  const withLedger = api.computeResidencyLedger([{ id: 'm1', elements: [withTree] }]);
  const withoutLedger = api.computeResidencyLedger([{ id: 'm2', elements: [withoutTree] }]);
  assert.ok(withLedger.perModel.m1.bvhBytes > withoutLedger.perModel.m2.bvhBytes,
    'an element with a built BVH tree must be charged more than one with only cached triangles');
});

test('computeResidencyLedger counts BatchedMesh geometry once per model, and InstancedMesh only its incremental arrays', () => {
  const api = loadApi();
  const batchGeo = geo('batch-1', 3000, 900);
  const models = [{
    id: 'm1',
    elements: [],
    meshes: [
      { userData: { _isCCBatch: true }, geometry: batchGeo },
      { isInstancedMesh: true, instanceMatrix: { array: { byteLength: 1600 } } },
    ],
  }];
  const ledger = api.computeResidencyLedger(models);
  assert.equal(ledger.perModel.m1.batchBytes, api.geometryByteSize(batchGeo));
  assert.equal(ledger.perModel.m1.instBytes, 1600);
});

test('computeResidencyLedger totalBytes sums every model, and reclaimableBytes sums every category', () => {
  const api = loadApi();
  const models = [
    { id: 'm1', elements: [element([proxyMesh(geo('g1', 300, 90))])] },
    { id: 'm2', elements: [element([proxyMesh(geo('g2', 600, 180))])] },
  ];
  const ledger = api.computeResidencyLedger(models);
  const expectedTotal = ledger.perModel.m1.reclaimableBytes + ledger.perModel.m2.reclaimableBytes;
  assert.equal(ledger.totalBytes, expectedTotal);
  const pm = ledger.perModel.m1;
  assert.equal(pm.reclaimableBytes, pm.geoBytes + pm.batchBytes + pm.instBytes + pm.bvhBytes + pm.propBytes);
});

test('computeResidencyLedger handles an empty/missing models array without throwing', () => {
  const api = loadApi();
  assert.deepEqual(api.computeResidencyLedger([]), { perModel: {}, totalBytes: 0 });
  assert.deepEqual(api.computeResidencyLedger(undefined), { perModel: {}, totalBytes: 0 });
});

test('computeResidencyLedger is exposed on window._ccComputeResidencyLedger', () => {
  assert.match(source, /window\._ccComputeResidencyLedger = _ccComputeResidencyLedger/);
});

test('the ClashControl public namespace exposes a residencyLedger() alias', () => {
  assert.match(source, /residencyLedger:\s*function\(\)\{ var st = window\._ccLatestState/);
});

// ── Auto-park now sorts by reclaimable bytes, not element count ─────────────
test('_ccAutoParkPass sorts hidden models by ledger reclaimableBytes, not element count', () => {
  const idx = source.indexOf('function _ccAutoParkPass()');
  assert.ok(idx !== -1);
  const body = source.slice(idx, source.indexOf('\n  }', idx) + 400);
  assert.match(body, /_ccComputeResidencyLedger\(hidden\)/);
  assert.match(body, /reclaimableBytes/);
  assert.doesNotMatch(body, /\(b\.elements\|\|\[\]\)\.length\) - \(\(a\.elements/, 'must no longer sort by element count');
});

// ── Hysteresis / cooldown ────────────────────────────────────────────────────
test('auto-park has a cooldown after the last park-or-restore action, to avoid thrashing at the pressure boundary', () => {
  const idx = source.indexOf('function _ccAutoParkPass()');
  const body = source.slice(idx, source.indexOf('\n  }', idx) + 400);
  assert.match(body, /Date\.now\(\) - _AUTOPARK_LAST_ACTION_MS < _AUTOPARK_COOLDOWN_MS\) return/);
});

test('restoring a parked model resets the auto-park cooldown (a just-restored model is not immediately re-parked)', () => {
  const idx = source.indexOf('window._ccRestoreParkedModel = function(id) {');
  assert.ok(idx !== -1);
  const body = source.slice(idx, idx + 400);
  assert.match(body, /_ccAutoParkNoteAction\(\)/);
});
