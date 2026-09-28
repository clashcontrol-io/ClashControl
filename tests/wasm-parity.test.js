'use strict';
// Differential parity suite: the WASM narrow-phase engine (committed
// addons/wasm-engine-pkg/) must be bit-identical to the JS reference
// (_triTriTest / _buildBVHNode / _bvhTraverseAll / _meshMinDist's spatial
// hash, extracted from index.html) on hit/no-hit, every raw point
// coordinate, depth, and min-distance results. See CLAUDE.md task notes and
// engine/src/{tri_tri,bvh,spatial_hash}.rs doc comments for the contract.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const pkgDir = path.join(REPO, 'addons', 'wasm-engine-pkg');

async function loadWasm() {
  const mod = await import(path.join(pkgDir, 'clashcontrol_engine.js'));
  await mod.default(fs.readFileSync(path.join(pkgDir, 'clashcontrol_engine_bg.wasm')));
  return mod;
}

// Extract the JS reference the same way tests elsewhere in this repo do:
// slice the source region and evaluate it with stub globals.
function loadJsReference() {
  const src = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8').split('\n');
  // _triTriTest .. _bvhTraverseAll (matches the region other scratch tooling
  // in this repo uses; re-verified against current line numbers below).
  const startMarker = 'var _ttIvalA = new Float64Array(8)';
  const endMarker = 'function _bvhTraverseAll(nA, trisA, nB, trisB, pts, maxPts, maxDepth, earlyExit)';
  const full = src.join('\n');
  const startIdx = full.indexOf(startMarker);
  assert.ok(startIdx !== -1, 'could not locate _ttIvalA in index.html — line-range extraction is stale');
  const fnEndMarker = '\n  }\n\n  // Scratch buffers reused across pairs';
  const endIdx = full.indexOf(fnEndMarker, full.indexOf(endMarker));
  assert.ok(endIdx !== -1, 'could not locate end of _bvhTraverseAll in index.html — extraction is stale');
  const body = full.slice(startIdx, endIdx + '\n  }'.length);

  const window = { _ccSafetyMigrations: null };
  const _getWorldTris = () => [];
  const _bvhLRU = new Map();
  const _DETECT_CHUNK_SIZE = 80;
  const js = new Function(
    'window', '_DETECT_CHUNK_SIZE', '_getWorldTris', '_bvhLRU',
    body + '; return {_triTriTest,_buildBVHNode,_bvhTraverseAll};'
  )(window, _DETECT_CHUNK_SIZE, _getWorldTris, _bvhLRU);
  return js;
}

// Extract _meshMinDist's spatial-hash logic (via _SpatialHash), with
// _getWorldVerts stubbed to identity (the real function reads it internally
// but this suite calls _meshMinDist with raw vertex arrays directly).
function loadJsMinDistReference() {
  const src = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const startIdx = src.indexOf('function _SpatialHash(cellSize)');
  assert.ok(startIdx !== -1, '_SpatialHash not found in index.html');
  const afterMeshMinDist = src.indexOf('\n  function _meshMinDist', startIdx);
  assert.ok(afterMeshMinDist !== -1, '_meshMinDist not found in index.html');
  const bodyEnd = src.indexOf('\n  }\n', src.indexOf('return Math.sqrt(minSq);', afterMeshMinDist));
  const body = src.slice(startIdx, bodyEnd + '\n  }'.length);
  const _getWorldVerts = (el) => el;
  const window = {}; // _meshMinDist checks window._ccWasmMinDist; empty means "JS path"
  return new Function('_getWorldVerts', 'window', body + '; return _meshMinDist;')(_getWorldVerts, window);
}

function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function jsIntersectRaw(js, tA, tB) {
  const mk = (t) => {
    const n = t.length / 9;
    const idx = new Int32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    return js._buildBVHNode(t, idx, 0, n);
  };
  const rA = mk(tA);
  const rB = mk(tB);
  const pts = [];
  const d = [0];
  js._bvhTraverseAll(rA, tA, rB, tB, pts, 24, d, false);
  return { pts, depth: d[0] };
}

function wasmIntersectRaw(mod, tA, tB) {
  const raw = mod.mesh_intersect_raw(tA, tB);
  if (!raw.length) return { pts: [], depth: 0 };
  const depth = raw[raw.length - 1];
  const pts = Array.from(raw.slice(0, raw.length - 1));
  return { pts, depth };
}

function box(x0, x1, y0, y1, z0, z1, sub = 1) {
  const t = [];
  const quad = (P) => {
    for (let i = 0; i < sub; i++) {
      for (let j = 0; j < sub; j++) {
        const f = (u, v) => P(u / sub, v / sub);
        t.push(...f(i, j), ...f(i + 1, j), ...f(i + 1, j + 1), ...f(i, j), ...f(i + 1, j + 1), ...f(i, j + 1));
      }
    }
  };
  const L = (a, b, u) => a + (b - a) * u;
  quad((u, v) => [L(x0, x1, u), L(y0, y1, v), z0]);
  quad((u, v) => [L(x0, x1, u), L(y0, y1, v), z1]);
  quad((u, v) => [L(x0, x1, u), y0, L(z0, z1, v)]);
  quad((u, v) => [L(x0, x1, u), y1, L(z0, z1, v)]);
  quad((u, v) => [x0, L(y0, y1, u), L(z0, z1, v)]);
  quad((u, v) => [x1, L(y0, y1, u), L(z0, z1, v)]);
  return new Float32Array(t);
}

function cyl(x0, x1, cy, cz, r, seg, rings) {
  const t = [];
  for (let k = 0; k < rings; k++) {
    const xa = x0 + (x1 - x0) * (k / rings);
    const xb = x0 + (x1 - x0) * ((k + 1) / rings);
    for (let s = 0; s < seg; s++) {
      const a = (2 * Math.PI * s) / seg;
      const b = (2 * Math.PI * (s + 1)) / seg;
      const p = (x, ang) => [x, cy + r * Math.cos(ang), cz + r * Math.sin(ang)];
      t.push(...p(xa, a), ...p(xb, a), ...p(xb, b), ...p(xa, a), ...p(xb, b), ...p(xa, b));
    }
  }
  return new Float32Array(t);
}

function assertIntersectParity(js, mod, name, tA, tB) {
  const j = jsIntersectRaw(js, tA, tB);
  const w = wasmIntersectRaw(mod, tA, tB);
  assert.strictEqual(j.pts.length > 0, w.pts.length > 0, `${name}: hit/no-hit must match`);
  if (j.pts.length === 0) return;
  assert.strictEqual(j.pts.length, w.pts.length, `${name}: point count must match`);
  for (let i = 0; i < j.pts.length; i++) {
    assert.strictEqual(j.pts[i], w.pts[i], `${name}: point coord [${i}] must be EXACTLY equal`);
  }
  assert.strictEqual(j.depth, w.depth, `${name}: depth must be EXACTLY equal`);
}

test('duct x wall (verified bug repro) and argument-order swap', async () => {
  const mod = await loadWasm();
  const js = loadJsReference();
  const duct = box(-1, 21, 2.5, 2.9, -6.9, -6.1);
  const wall = box(9.925, 10.075, 0, 3.2, -11.85, -0.15);
  assertIntersectParity(js, mod, 'duct-wall', duct, wall);
  assertIntersectParity(js, mod, 'duct-wall-reversed', wall, duct);
});

test('box x box crossings in structured orientations', async () => {
  const mod = await loadWasm();
  const js = loadJsReference();
  const cases = [
    ['axis-aligned overlap', box(0, 2, 0, 2, 0, 2), box(1, 3, 1, 3, 1, 3)],
    ['edge touch', box(0, 1, 0, 1, 0, 1), box(1, 2, 0, 1, 0, 1)],
    ['fully contained', box(0, 5, 0, 5, 0, 5), box(1, 2, 1, 2, 1, 2)],
    ['disjoint', box(0, 1, 0, 1, 0, 1), box(10, 11, 10, 11, 10, 11)],
    ['thin sliver crossing', box(-10, 10, -0.01, 0.01, -0.01, 0.01), box(-0.01, 0.01, -10, 10, -0.01, 0.01)],
  ];
  for (const [name, a, b] of cases) {
    assertIntersectParity(js, mod, name, a, b);
    assertIntersectParity(js, mod, name + ' (reversed)', b, a);
  }
});

test('long thin duct through a wall, and cylinders, at various subdivisions', async () => {
  const mod = await loadWasm();
  const js = loadJsReference();
  assertIntersectParity(js, mod, 'duct sub4 x wall sub4', box(-1, 21, 2.5, 2.9, -6.9, -6.1, 4), box(9.925, 10.075, 0, 3.2, -11.85, -0.15, 4));
  assertIntersectParity(js, mod, 'cylinder x cylinder', cyl(-1, 21, 6.5, 2.7, 0.3, 24, 8), cyl(-1, 21, 6.6, 2.8, 0.3, 24, 8));
  assertIntersectParity(js, mod, 'cylinder x wall', cyl(-1, 21, 6.5, 2.7, 0.05, 24, 4), box(9.925, 10.075, 0, 3.2, -11.85, -0.15, 4));
});

test('>=2000 seeded-random triangle pairs incl. near-degenerate and coplanar, exact equality', async () => {
  const mod = await loadWasm();
  const js = loadJsReference();
  const rnd = mulberry32(1337);
  const rndF = (lo, hi) => lo + (hi - lo) * rnd();
  const rndTri = (scale) => new Float32Array(Array.from({ length: 9 }, () => rndF(-scale, scale)));

  let n = 0;
  for (let i = 0; i < 2400; i++) {
    const scale = i % 3 === 0 ? 0.001 : i % 3 === 1 ? 1 : 1000;
    assertIntersectParity(js, mod, 'rand' + i, rndTri(scale), rndTri(scale));
    n++;
  }
  for (let i = 0; i < 300; i++) {
    // near-degenerate: two vertices almost coincident
    const a = new Float32Array([0, 0, 0, rndF(-1e-7, 1e-7), rndF(-1e-7, 1e-7), 0, rndF(0, 1), rndF(0, 1), 0]);
    assertIntersectParity(js, mod, 'near-degen' + i, a, rndTri(1));
    n++;
  }
  for (let i = 0; i < 300; i++) {
    // exactly coplanar pairs in a random plane through the origin
    const nx = rndF(-1, 1), ny = rndF(-1, 1), nz = rndF(-1, 1);
    const len = Math.hypot(nx, ny, nz) || 1;
    const ux = nx / len, uy = ny / len, uz = nz / len;
    // two arbitrary in-plane basis vectors
    const ax = uy - uz, ay = uz - ux, az = ux - uy;
    const bx = uy * az - uz * ay, by = uz * ax - ux * az, bz = ux * ay - uy * ax;
    const pt = (s, t) => [s * ax + t * bx, s * ay + t * by, s * az + t * bz];
    const a = new Float32Array([...pt(0, 0), ...pt(1, 0), ...pt(0, 1)]);
    const b = new Float32Array([...pt(rndF(-1, 1), rndF(-1, 1)), ...pt(rndF(-1, 1), rndF(-1, 1)), ...pt(rndF(-1, 1), rndF(-1, 1))]);
    assertIntersectParity(js, mod, 'coplanar' + i, a, b);
    n++;
  }
  assert.ok(n >= 2000, `expected >=2000 cases, ran ${n}`);
});

test('min-distance parity: exact equality across random and structured cases', async () => {
  const mod = await loadWasm();
  const meshMinDist = loadJsMinDistReference();
  const rnd = mulberry32(99);
  const rndF = (lo, hi) => lo + (hi - lo) * rnd();

  function runCmp(name, vA, vB, threshold) {
    const outPair = new Float64Array(6);
    const jDist = meshMinDist(vA, vB, threshold, outPair);
    // _meshMinDist (with outPair always passed, as index.html's one call
    // site does) always returns a real distance/Infinity AND leaves outPair
    // populated (zero-initialized if nothing was found) — WASM's 7-element
    // shape mirrors this exactly, so compare like-for-like (7 elements).
    const jResult = [jDist, outPair[0], outPair[1], outPair[2], outPair[3], outPair[4], outPair[5]];
    const wResult = Array.from(mod.mesh_min_distance(vA, vB, threshold));
    assert.strictEqual(jResult.length, wResult.length, `${name}: result shape must match`);
    for (let i = 0; i < jResult.length; i++) {
      assert.strictEqual(jResult[i], wResult[i], `${name}: value[${i}] must be EXACTLY equal`);
    }
  }

  for (let i = 0; i < 600; i++) {
    const n = 3 * (2 + Math.floor(rnd() * 8));
    const vA = new Float32Array(Array.from({ length: n }, () => rndF(-2, 2)));
    const vB = new Float32Array(Array.from({ length: n }, () => rndF(-2, 2)));
    const th = rndF(0.01, 3);
    runCmp('rand-md' + i, vA, vB, th);
  }
  // structured: exact 3-4-5, zero threshold (falls back to 0.05 cell), single-vertex
  runCmp('3-4-5', new Float32Array([0, 0, 0]), new Float32Array([3, 4, 0]), 10);
  runCmp('zero-threshold', new Float32Array([0, 0, 0]), new Float32Array([0.01, 0, 0]), 0);
  runCmp('far-beyond-threshold', new Float32Array([0, 0, 0]), new Float32Array([1000, 1000, 1000]), 1);
});
