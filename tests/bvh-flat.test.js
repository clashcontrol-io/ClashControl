'use strict';
// The hit refinement's JS BVH is taken from the WASM Engine (Engine.bvh_flat
// -> _ccBvhFromFlat) instead of being built a second time, on the main
// thread (_getBVH via window._ccWasmEngine.bvhFlat) and in the narrow-phase
// workers. That is only sound if the imported tree IS the tree
// _buildBVHForTris builds: same node boxes, counts, leaf ranges and the index
// order inside every leaf (traversal order decides tie-breaks). This suite
// registers meshes in the real committed WASM Engine and compares the
// imported tree with the JS-built one node for node, round-trips the flat
// layout, and checks malformed exports are refused (null -> JS build).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
const s = src.indexOf('  function _bvhStableSort(');
const e = src.indexOf('  function _getBVH(el)');
assert.ok(s !== -1 && e > s, 'BVH builder markers are stale');
const js = new Function(src.slice(s, e) + '; return { _buildBVHForTris, _ccBvhFromFlat, _ccBvhFlatten, _ccTrisFinite };')();

async function loadWasm() {
  const pkg = path.join(REPO, 'addons', 'wasm-engine-pkg');
  const mod = await import(pathToFileURL(path.join(pkg, 'clashcontrol_engine.js')).href);
  await mod.default({ module_or_path: fs.readFileSync(path.join(pkg, 'clashcontrol_engine_bg.wasm')) });
  return mod;
}
function rng(seed) {
  let a = seed | 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function soup(n, seed, quant, scale = 10, off = 0) {
  const r = rng(seed), t = new Float32Array(n * 9);
  for (let i = 0; i < t.length; i++) t[i] = (quant ? Math.round(r() * quant) / quant : r()) * scale + off;
  return t;
}
// closed tube along X: ring every `step`, `seg`-gon (the dense prisms real exports look like)
function tube(len, rad, seg, step, x0 = 0) {
  const rings = Math.ceil(len / step), t = [];
  const P = (r, k) => [x0 + len * r / rings, rad * Math.cos(2 * Math.PI * k / seg), rad * Math.sin(2 * Math.PI * k / seg)];
  for (let r = 0; r < rings; r++) for (let k = 0; k < seg; k++) {
    const a = P(r, k), b = P(r, (k + 1) % seg), c = P(r + 1, (k + 1) % seg), d = P(r + 1, k);
    t.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return new Float32Array(t);
}
function sameTree(a, b, where) {
  for (const k of ['mnx', 'mny', 'mnz', 'mxx', 'mxy', 'mxz', 'lo', 'hi', 'cnt']) {
    if (!Object.is(a[k], b[k])) return where + '.' + k + ': ' + a[k] + ' vs ' + b[k];
  }
  if ((a.left === undefined) !== (b.left === undefined)) return where + ' shape';
  if (a.lo !== undefined) {
    for (let i = a.lo; i < a.hi; i++) if (a.idx[i] !== b.idx[i]) return where + ' leaf idx[' + i + ']';
    return null;
  }
  return sameTree(a.left, b.left, where + 'L') || sameTree(a.right, b.right, where + 'R');
}

test('Engine BVH export rebuilds exactly the JS-built tree', async () => {
  const mod = await loadWasm();
  const eng = new mod.Engine();
  const meshes = [
    soup(1, 1, 0), soup(4, 2, 0), soup(5, 3, 0), soup(9, 4, 2), soup(100, 5, 0), soup(1000, 6, 3), soup(5000, 7, 0),
    soup(20000, 8, 16), soup(3000, 9, 0, 0.02, 150000), // tiny element far from the origin (Float32 ties)
    tube(12, 0.05, 32, 0.25), tube(60, 0.1, 32, 0.1, -30), tube(3, 0.4, 8, 3),
  ];
  meshes.forEach((tris, i) => {
    eng.register(i + 1, tris);
    const flat = eng.bvh_flat(i + 1);
    const built = js._buildBVHForTris(tris);
    assert.deepStrictEqual(Array.from(flat), js._ccBvhFlatten(built), 'flat layout, mesh ' + i);
    const imported = js._ccBvhFromFlat(flat, tris);
    assert.ok(imported && imported.tris === tris, 'imported mesh ' + i);
    assert.strictEqual(sameTree(imported.root, built.root, 'root'), null, 'mesh ' + i);
  });
  eng.register(99, new Float32Array(0));
  assert.strictEqual(eng.bvh_flat(99).length, 0);
  assert.strictEqual(js._ccBvhFromFlat(eng.bvh_flat(99), new Float32Array(0)), null);
  assert.strictEqual(eng.bvh_flat(12345), undefined, 'unregistered id is unknown, never an empty tree');
  eng.free();
});

test('malformed or mismatched exports are refused', () => {
  const tris = soup(50, 11, 0);
  const good = js._ccBvhFlatten(js._buildBVHForTris(tris));
  assert.ok(js._ccBvhFromFlat(good, tris));
  assert.strictEqual(js._ccBvhFromFlat(good.slice(0, -1), tris), null, 'truncated');
  assert.strictEqual(js._ccBvhFromFlat(good.concat([0]), tris), null, 'trailing data');
  assert.strictEqual(js._ccBvhFromFlat(good, soup(49, 11, 0)), null, 'other triangle count');
  const bad = good.slice(); bad[6] = bad[6] + 1; // root count off by one
  assert.strictEqual(js._ccBvhFromFlat(bad, tris), null, 'count mismatch');
  assert.strictEqual(js._ccBvhFromFlat(null, tris), null);
});

test('finite check gates the export (NaN / infinities fall back to the JS build)', () => {
  assert.strictEqual(js._ccTrisFinite(soup(10, 1, 0)), true);
  for (const v of [NaN, Infinity, -Infinity]) {
    const t = soup(10, 1, 0); t[17] = v;
    assert.strictEqual(js._ccTrisFinite(t), false, String(v));
  }
});
