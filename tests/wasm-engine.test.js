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
  for (const fn of ['mesh_intersect', 'mesh_min_distance', 'batch_intersect', 'mesh_intersect_raw', 'batch_intersect_raw', 'sweep_and_prune']) {
    assert.equal(typeof mod[fn], 'function', fn + ' export missing');
  }
  // cached-BVH engine (addons/wasm-engine.js `_ccWasmEngine` builds on this)
  assert.equal(typeof mod.Engine, 'function', 'Engine class export missing');
  for (const m of ['register', 'unregister', 'clear', 'intersect', 'min_distance', 'has', 'len']) {
    assert.equal(typeof mod.Engine.prototype[m], 'function', 'Engine.' + m + ' missing');
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
    assert.doesNotThrow(() => mod.mesh_min_distance(b, tri));
  }
});

test('wasm pkg: min_distance is a true triangle-mesh distance (point-to-triangle + edge-edge), no threshold cutoff', async () => {
  // mesh_min_distance takes TRIANGLE arrays (9 floats/tri), not raw points —
  // see engine/src/lib.rs and index.html's _meshMinDist doc comments. There
  // is no threshold-cutoff concept any more (the real minimum is always
  // computed via BVH); callers compare the returned distance to their own
  // gap threshold.
  const mod = await loadWasm();
  const a = new Float32Array([0, 0, 0, 3, 0, 0, 0, 4, 0]);
  const b = new Float32Array([0, 4, 0, 6, 4, 0, 0, 8, 0]);
  const touching = mod.mesh_min_distance(a, b); // shares vertex (0,4,0) -> 0
  assert.ok(Math.abs(touching[0]) < 1e-5, 'expected ~0 (shared vertex), got ' + touching[0]);

  // The verified bug this kernel fixes: a small device sitting mid-face
  // 0.1m above a large slab's center. No vertex of either triangle is near
  // a vertex of the other — the OLD vertex-to-vertex spatial hash reported
  // this as far/Infinity.
  const slab = new Float32Array([-5, -5, 0, 5, -5, 0, -5, 5, 0]);
  const device = new Float32Array([-0.1, -0.1, 0.1, 0.1, -0.1, 0.1, -0.1, 0.1, 0.1]);
  const clearance = mod.mesh_min_distance(slab, device);
  assert.ok(Math.abs(clearance[0] - 0.1) < 1e-5, 'expected ~0.1, got ' + clearance[0]);
});
