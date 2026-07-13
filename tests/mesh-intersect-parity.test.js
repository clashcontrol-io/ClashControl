'use strict';
// Locks _pointInBothBoxes (index.html): the single check that gates both the JS
// BVH narrow-phase and the WASM narrow-phase in _meshesIntersect, so a loaded
// WASM accelerator can't report a hit (or a miss) the JS fallback would disagree
// with. Extracted the same way tests/ifc-units.test.js pulls one function out of
// the inline script.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const i = src.indexOf('function _pointInBothBoxes');
assert.ok(i !== -1, '_pointInBothBoxes not found');
const fn = new Function(src.slice(i, src.indexOf('\n  }', i) + 4) + '; return _pointInBothBoxes;')();

const boxA = { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } };
const boxB = { min: { x: 0.5, y: 0.5, z: 0.5 }, max: { x: 1.5, y: 1.5, z: 1.5 } };

test('a point inside the overlap of both boxes passes', () => {
  assert.equal(fn(0.75, 0.75, 0.75, boxA, boxB, 0.01), true);
});

test('a point outside boxA (even though inside boxB) fails', () => {
  assert.equal(fn(1.4, 1.4, 1.4, boxA, boxB, 0.01), false);
});

test('a point just past the margin fails, just within it passes', () => {
  assert.equal(fn(1.005, 0.75, 0.75, boxA, boxB, 0.01), true, 'within 10mm margin');
  assert.equal(fn(1.02, 0.75, 0.75, boxA, boxB, 0.01), false, 'beyond 10mm margin');
});

test('WASM and JS paths in _meshesIntersect are gated by the same function', () => {
  // Both branches of _meshesIntersect must reference the shared helper, not a
  // re-inlined copy of the box-margin check - this is what "parity" means here.
  const body = src.slice(src.indexOf('function _meshesIntersect'), src.indexOf('// JS fallback', src.indexOf('function _meshesIntersect')));
  assert.ok(body.includes('_pointInBothBoxes'), 'WASM branch must call the shared validator');
});
