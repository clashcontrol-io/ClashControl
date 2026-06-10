'use strict';
// Locks the committed WASM artifact (addons/wasm-engine-pkg/) to the contract
// addons/wasm-engine.js and the core clash loop rely on. If the pkg is ever
// rebuilt, these must still hold.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pkgDir = path.join(__dirname, '..', 'addons', 'wasm-engine-pkg');

async function loadWasm() {
  const mod = await import(path.join(pkgDir, 'clashcontrol_engine.js'));
  await mod.default(fs.readFileSync(path.join(pkgDir, 'clashcontrol_engine_bg.wasm')));
  return mod;
}

test('wasm pkg: exports exist and a piercing pair is detected with depth', async () => {
  const mod = await loadWasm();
  for (const fn of ['mesh_intersect', 'mesh_min_distance', 'batch_intersect']) {
    assert.equal(typeof mod[fn], 'function', fn + ' export missing');
  }
  const triA = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const pierce = new Float32Array([0.2, 0.2, -1, 0.3, 0.2, 1, 0.2, 0.3, 1]);
  const far = new Float32Array([5, 5, 5, 6, 5, 5, 5, 6, 5]);
  const hit = mod.mesh_intersect(triA, pierce, 1e-6);
  assert.ok(hit.length >= 4 && hit[3] > 0, 'piercing pair must hit with positive depth');
  assert.equal(mod.mesh_intersect(triA, far, 1e-6).length, 0, 'distant pair must miss');
});

test('wasm pkg: degenerate input is safe, never throws', async () => {
  const mod = await loadWasm();
  const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bad = [
    new Float32Array(0),
    new Float32Array(7), // not a multiple of 9
    new Float32Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]),
    new Float32Array([Infinity, 0, 0, 1, 0, 0, 0, 1, 0]),
    new Float32Array(9), // zero-area
  ];
  for (const b of bad) {
    assert.doesNotThrow(() => mod.mesh_intersect(b, tri, 1e-6));
    assert.doesNotThrow(() => mod.mesh_min_distance(b, tri, 1));
  }
});

test('wasm pkg: min_distance returns the metric distance and Infinity beyond threshold', async () => {
  const mod = await loadWasm();
  const a = new Float32Array([0, 0, 0]);
  const b = new Float32Array([3, 4, 0]); // 3-4-5
  const near = mod.mesh_min_distance(a, b, 10);
  assert.ok(Math.abs(near[0] - 5) < 1e-5, 'expected 5, got ' + near[0]);
  const beyond = mod.mesh_min_distance(a, b, 0.5);
  assert.ok(beyond.length === 0 || beyond[0] === Infinity, 'beyond threshold must be Infinity/empty');
});
