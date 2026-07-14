'use strict';
// Locks _lookupElBox / _ccBoxFinite / _ccSynthesizeViewpoint (index.html) -
// the pure geometry math behind auto-synthesized BCF default viewpoints
// (Wave 3). See bcf-export.test.js for the exportBCF wiring that consumes
// this when an issue has no manually-captured viewpoint.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFn(name) {
  const header = 'function ' + name + '(';
  const start = src.indexOf('  ' + header);
  assert.ok(start !== -1, name + ' not found');
  const end = src.indexOf('\n  }', start) + '\n  }'.length;
  return src.slice(start, end);
}

// _ccSynthesizeViewpoint depends on _lookupElBox and _ccBoxFinite being in
// the same scope - extract all three together, same spirit as bundling
// parseIDSSpec+runIDSSpecs when one calls the other.
const bundle = extractFn('_lookupElBox') + '\n' + extractFn('_ccBoxFinite') + '\n' + extractFn('_ccSynthesizeViewpoint');
const { _lookupElBox, _ccBoxFinite, _ccSynthesizeViewpoint } = (function () {
  return new Function(bundle + '; return { _lookupElBox, _ccBoxFinite, _ccSynthesizeViewpoint };')();
})();

function box(minX, minY, minZ, maxX, maxY, maxZ) { return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }; }
function el(expressId, b) { return { expressId: expressId, box: b }; }
function model(id, elements) { return { id: id, elements: elements }; }

test('_lookupElBox finds an element\'s box by modelId + expressId', () => {
  const models = [model('m1', [el(1, box(0, 0, 0, 1, 1, 1))])];
  assert.deepEqual(_lookupElBox(models, 'm1', 1), box(0, 0, 0, 1, 1, 1));
});

test('_lookupElBox falls back to searching every model when modelId is falsy', () => {
  const models = [model('m1', [el(1, box(0, 0, 0, 1, 1, 1))]), model('m2', [el(2, box(5, 5, 5, 6, 6, 6))])];
  assert.deepEqual(_lookupElBox(models, null, 2), box(5, 5, 5, 6, 6, 6));
});

test('_lookupElBox returns null for a missing expressId, missing box, or missing model', () => {
  const models = [model('m1', [el(1, box(0, 0, 0, 1, 1, 1)), { expressId: 2 }])];
  assert.equal(_lookupElBox(models, 'm1', 999), null);
  assert.equal(_lookupElBox(models, 'm1', 2), null, 'element exists but has no .box');
  assert.equal(_lookupElBox(models, 'no-such-model', 1), null);
  assert.equal(_lookupElBox(models, 'm1', null), null);
});

test('_ccBoxFinite rejects null, missing min/max, and non-finite (Infinity/NaN) coordinates', () => {
  assert.equal(_ccBoxFinite(null), false);
  assert.equal(_ccBoxFinite({}), false);
  assert.equal(_ccBoxFinite(box(0, 0, 0, 1, 1, 1)), true);
  assert.equal(_ccBoxFinite(box(Infinity, 0, 0, -Infinity, 1, 1)), false, 'THREE.Box3\'s default empty state is +/-Infinity');
  assert.equal(_ccBoxFinite(box(NaN, 0, 0, 1, 1, 1)), false);
});

test('synthesizes a camera centered on a single element (elementId/modelId shape - DQ/accessibility issues)', () => {
  const models = [model('m1', [el(1, box(-1, -1, -1, 1, 1, 1))])];
  const it = { modelId: 'm1', elementId: 1 };
  const vp = _ccSynthesizeViewpoint(it, models);
  assert.ok(vp && vp.camera);
  assert.equal(vp.camera.px, vp.camera.py, 'isometric offset must be equal on all 3 axes');
  assert.equal(vp.camera.py, vp.camera.pz);
  assert.ok(vp.camera.px > 0, 'centered on origin, camera must sit on the positive offset side');
});

test('unions both sides\' boxes for a clash pair (elemA/elemB/modelAId/modelBId shape)', () => {
  const models = [model('m1', [el(10, box(0, 0, 0, 1, 1, 1)), el(20, box(5, 5, 5, 6, 6, 6))])];
  const it = { modelAId: 'm1', elemA: 10, modelBId: 'm1', elemB: 20 };
  const vp = _ccSynthesizeViewpoint(it, models);
  assert.ok(vp && vp.camera);
  // Union bbox center is (3,3,3); a bigger maxDim (6) than either box alone
  // pushes the camera further out - just assert it's centered further from
  // origin than a single small box would be, proving the union happened.
  const single = _ccSynthesizeViewpoint({ modelAId: 'm1', elemA: 10 }, models);
  assert.notEqual(vp.camera.px, single.camera.px);
});

test('falls back to whichever single side resolves when only one of elemA/elemB has a box', () => {
  const models = [model('m1', [el(10, box(0, 0, 0, 2, 2, 2))])]; // elemB (20) not in this model at all
  const it = { modelAId: 'm1', elemA: 10, modelBId: 'm1', elemB: 20 };
  const vp = _ccSynthesizeViewpoint(it, models);
  assert.ok(vp && vp.camera, 'must still synthesize from the one side that IS resolvable');
});

test('returns null when nothing resolves - no A/B, no single element, or the referenced element/model is absent', () => {
  assert.equal(_ccSynthesizeViewpoint({}, [model('m1', [])]), null);
  assert.equal(_ccSynthesizeViewpoint({ modelAId: 'm1', elemA: 999 }, [model('m1', [])]), null);
  assert.equal(_ccSynthesizeViewpoint({ modelId: 'no-such', elementId: 1 }, []), null);
});

test('camera direction always points back toward the target (opposite sign from the position offset)', () => {
  const models = [model('m1', [el(1, box(0, 0, 0, 1, 1, 1))])];
  const vp = _ccSynthesizeViewpoint({ modelId: 'm1', elementId: 1 }, models);
  assert.ok(vp.camera.px > 0 && vp.camera.dx < 0);
  assert.ok(vp.camera.py > 0 && vp.camera.dy < 0);
  assert.ok(vp.camera.pz > 0 && vp.camera.dz < 0);
});

test('up vector is Y-up (0,1,0), matching _captureViewpoint\'s real-camera convention', () => {
  const models = [model('m1', [el(1, box(0, 0, 0, 1, 1, 1))])];
  const vp = _ccSynthesizeViewpoint({ modelId: 'm1', elementId: 1 }, models);
  assert.deepEqual([vp.camera.ux, vp.camera.uy, vp.camera.uz], [0, 1, 0]);
});

test('a larger element gets a proportionally larger camera distance, but distance never collapses to ~0 for a tiny/degenerate box', () => {
  const models = [
    model('m1', [el(1, box(0, 0, 0, 0.5, 0.5, 0.5))]),  // small
    model('m2', [el(2, box(0, 0, 0, 10, 10, 10))]),      // large
  ];
  const small = _ccSynthesizeViewpoint({ modelId: 'm1', elementId: 1 }, models);
  const large = _ccSynthesizeViewpoint({ modelId: 'm2', elementId: 2 }, models);
  const distSmall = Math.abs(small.camera.px - 0.25); // offset from small box's center
  const distLarge = Math.abs(large.camera.px - 5);    // offset from large box's center
  assert.ok(distLarge > distSmall, 'a 10m element must pull the camera back further than a 0.5m one');
  assert.ok(distSmall > 0, 'distance must never be zero even for a tiny box');
});
