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
// slice the source region and evaluate it with stub globals. Widened (from
// just _triTriTest..._bvhTraverseAll) to also cover the true mesh-to-mesh
// min-distance kernel (_closestPtOnTri..._ccJsMeshIntersectRef) added for
// the point-to-triangle/edge-edge rewrite — _meshesIntersect sits between
// the two regions but is never called here, so its unresolved globals
// (window._ccWasmIntersect, _getWorldTris, etc. — lazily referenced only
// when the function body actually runs) are harmless to leave defined.
function loadJsReference() {
  const src = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8').split('\n');
  const startMarker = 'var _ttIvalA = new Float64Array(8)';
  const endMarker = 'window._ccJsMeshIntersectRef = {';
  const full = src.join('\n');
  const startIdx = full.indexOf(startMarker);
  assert.ok(startIdx !== -1, 'could not locate _ttIvalA in index.html — line-range extraction is stale');
  const endMarkerIdx = full.indexOf(endMarker);
  assert.ok(endMarkerIdx !== -1, 'could not locate _ccJsMeshIntersectRef in index.html — extraction is stale');
  const fnEndMarker = '\n  };\n\n  // ── Approximate penetration depth';
  const endIdx = full.indexOf(fnEndMarker, endMarkerIdx);
  assert.ok(endIdx !== -1, 'could not locate end of _ccJsMeshIntersectRef in index.html — extraction is stale');
  const body = full.slice(startIdx, endIdx + '\n  };'.length);

  const window = { _ccSafetyMigrations: null };
  const _getWorldTris = () => [];
  const _getBVH = () => null;
  const _bvhLRU = new Map();
  const _DETECT_CHUNK_SIZE = 80;
  const js = new Function(
    'window', '_DETECT_CHUNK_SIZE', '_getWorldTris', '_getBVH', '_bvhLRU',
    body + '; return {_triTriTest,_buildBVHNode,_bvhTraverseAll,_ccJsMeshIntersectRef:window._ccJsMeshIntersectRef};'
  )(window, _DETECT_CHUNK_SIZE, _getWorldTris, _getBVH, _bvhLRU);
  return js;
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

test('min-distance parity: exact equality across random and structured triangle-mesh cases', async () => {
  const mod = await loadWasm();
  const js = loadJsReference();
  const rnd = mulberry32(99);
  const rndF = (lo, hi) => lo + (hi - lo) * rnd();
  const rndTri = (scale) => new Float32Array(Array.from({ length: 9 }, () => rndF(-scale, scale)));

  function runCmp(name, tA, tB) {
    // trisA/trisB: flat triangle arrays (9 floats/tri) — _meshMinDist's
    // real wire contract (see index.html/_ccJsMeshIntersectRef.minDist and
    // engine/src/lib.rs's mesh_min_distance), not raw point clouds.
    const jResult = js._ccJsMeshIntersectRef.minDist(tA, tB);
    const wResult = Array.from(mod.mesh_min_distance(tA, tB));
    assert.strictEqual(jResult.length, wResult.length, `${name}: result shape must match`);
    for (let i = 0; i < jResult.length; i++) {
      assert.strictEqual(jResult[i], wResult[i], `${name}: value[${i}] must be EXACTLY equal`);
    }
    return jResult[0];
  }

  for (let i = 0; i < 600; i++) {
    const scale = i % 3 === 0 ? 0.01 : i % 3 === 1 ? 1 : 100;
    runCmp('rand-md' + i, rndTri(scale), rndTri(scale));
  }

  // structured cases, incl. the specific shapes the task calls out
  runCmp('touching-tris', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([0, 0, 0, -1, 0, 0, 0, -1, 0]));
  runCmp('parallel-faces', new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]), new Float32Array([0, 0, 0.3, 2, 0, 0.3, 0, 2, 0.3]));
  // the verified bug: a small device sitting mid-face above a large slab —
  // no vertex of either triangle is near a vertex of the other, so the old
  // vertex-to-vertex spatial hash reported this as far/Infinity instead of
  // the true 0.1m surface distance.
  const slab = new Float32Array([-5, -5, 0, 5, -5, 0, -5, 5, 0]);
  const device = new Float32Array([-0.1, -0.1, 0.1, 0.1, -0.1, 0.1, -0.1, 0.1, 0.1]);
  const slabDist = runCmp('device-above-slab-center', slab, device);
  assert.ok(Math.abs(slabDist - 0.1) < 1e-6, `device-above-slab-center: distance should be ~0.1 (f32 rounding), got ${slabDist}`);
  // edge-edge crossing bars: two thin triangles crossing like a plus sign,
  // offset in Z — the closest points are both interior to an edge of each
  // triangle (not at any vertex), so only the edge-edge sub-test finds it.
  const barA = new Float32Array([-1, 0, 0, 1, 0, 0, 0, 0.001, 0]);
  const barB = new Float32Array([0, -1, 0.05, 0, 1, 0.05, 0.001, 0, 0.05]);
  runCmp('edge-edge-crossing-bars', barA, barB);
  runCmp('far-apart', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([1000, 1000, 1000, 1001, 1000, 1000, 1000, 1001, 1000]));
  runCmp('empty-a', new Float32Array([]), new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  runCmp('empty-b', new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([]));
});

test('min-distance parity: intersecting/contained meshes must report EXACTLY 0 in both engines', async () => {
  // Verified bug (CLAUDE.md task notes): _triTriDistSq's 15-subtest
  // point/edge distance is only valid for NON-intersecting triangles — when
  // one triangle actually pierces the other, or one mesh is fully enclosed
  // in the other with no crossing triangle pair at all, the old code
  // reported a small but nonzero gap instead of the true 0. Both the
  // tri-tri intersection short-circuit AND the point-in-mesh containment
  // fix must be exercised here, in both the JS reference and WASM.
  const mod = await loadWasm();
  const js = loadJsReference();

  function runCmp(name, tA, tB) {
    const jResult = js._ccJsMeshIntersectRef.minDist(tA, tB);
    const wResult = Array.from(mod.mesh_min_distance(tA, tB));
    assert.strictEqual(jResult.length, wResult.length, `${name}: result shape must match`);
    for (let i = 0; i < jResult.length; i++) {
      assert.strictEqual(jResult[i], wResult[i], `${name}: value[${i}] must be EXACTLY equal`);
    }
    assert.strictEqual(jResult[0], 0, `${name}: JS distance must be exactly 0, got ${jResult[0]}`);
    assert.strictEqual(wResult[0], 0, `${name}: WASM distance must be exactly 0, got ${wResult[0]}`);
  }

  // Two triangles that actually cross (edge of one pierces the face of the
  // other) — the classic "surface-crossing" case.
  runCmp('crossing-triangles', new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), new Float32Array([0, 0, -1, 0, 0, 1, 0, 2, 0]));
  runCmp('crossing-triangles (reversed)', new Float32Array([0, 0, -1, 0, 0, 1, 0, 2, 0]), new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]));

  // Duct-through-column: a long thin box (duct) crossing straight through a
  // squat box (column) — mirrors the real repro (Return duct through
  // Column 5/3, etc.) at mesh scale, not single-triangle scale.
  const duct = box(-1, 21, 2.4, 2.6, -0.1, 0.1);
  const column = box(9, 11, -1, 5, -1, 1);
  runCmp('duct-through-column', duct, column);
  runCmp('duct-through-column (reversed)', column, duct);

  // Fully contained: a small box entirely inside a bigger one, with no
  // face of the small box crossing a face of the big one at all — the
  // containment fix (point-in-mesh), not the tri-tri short-circuit, is
  // what must catch this.
  const bigBox = box(-5, 5, -5, 5, -5, 5);
  const smallBoxInside = box(-1, 1, -1, 1, -1, 1);
  runCmp('fully-contained-box', bigBox, smallBoxInside);
  runCmp('fully-contained-box (reversed)', smallBoxInside, bigBox);
});

// ── Cached-BVH Engine (engine/src/lib.rs `Engine`) ───────────────────
// Engine.intersect / Engine.min_distance must equal the stateless free
// functions AND the JS reference on the same pairs, EXACTLY (===), including
// after register / unregister / re-register cycles and repeated queries.
function eqArr(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function buildEnginePairs() {
  const rnd = mulberry32(1337);
  const rndF = (lo, hi) => lo + (hi - lo) * rnd();
  const rndTri = (scale) => new Float32Array(Array.from({ length: 9 }, () => rndF(-scale, scale)));
  const pairs = [];
  for (let i = 0; i < 2400; i++) {
    const scale = i % 3 === 0 ? 0.001 : i % 3 === 1 ? 1 : 1000;
    pairs.push([rndTri(scale), rndTri(scale)]);
  }
  for (let i = 0; i < 300; i++) {
    const a = new Float32Array([0, 0, 0, rndF(-1e-7, 1e-7), rndF(-1e-7, 1e-7), 0, rndF(0, 1), rndF(0, 1), 0]);
    pairs.push([a, rndTri(1)]);
  }
  for (let i = 0; i < 300; i++) {
    const nx = rndF(-1, 1), ny = rndF(-1, 1), nz = rndF(-1, 1);
    const len = Math.hypot(nx, ny, nz) || 1;
    const ux = nx / len, uy = ny / len, uz = nz / len;
    const ax = uy - uz, ay = uz - ux, az = ux - uy;
    const bx = uy * az - uz * ay, by = uz * ax - ux * az, bz = ux * ay - uy * ax;
    const pt = (s, t) => [s * ax + t * bx, s * ay + t * by, s * az + t * bz];
    const a = new Float32Array([...pt(0, 0), ...pt(1, 0), ...pt(0, 1)]);
    const b = new Float32Array([...pt(rndF(-1, 1), rndF(-1, 1)), ...pt(rndF(-1, 1), rndF(-1, 1)), ...pt(rndF(-1, 1), rndF(-1, 1))]);
    pairs.push([a, b]);
  }
  // multi-triangle meshes so the BVH is really exercised (not single-tri leaves)
  pairs.push([box(-1, 21, 2.5, 2.9, -6.9, -6.1, 4), box(9.925, 10.075, 0, 3.2, -11.85, -0.15, 4)]);
  pairs.push([cyl(-1, 21, 6.5, 2.7, 0.3, 24, 8), cyl(-1, 21, 6.6, 2.8, 0.3, 24, 8)]);
  pairs.push([box(-5, 5, -5, 5, -5, 5, 3), box(-1, 1, -1, 1, -1, 1, 3)]);
  pairs.push([box(-1, 21, 2.4, 2.6, -0.1, 0.1, 2), box(9, 11, -1, 5, -1, 1, 2)]);
  return pairs;
}

test('Engine.intersect === mesh_intersect_raw === JS reference on 3,000+ pairs (exact), incl. repeat + unregister/re-register', async () => {
  const mod = await loadWasm();
  const js = loadJsReference();
  const pairs = buildEnginePairs();
  assert.ok(pairs.length >= 3000, `expected >=3000 pairs, got ${pairs.length}`);
  const eng = new mod.Engine();
  const raw = (r) => Array.from(r);
  let hits = 0;
  const check = (label, i, ia, ib) => {
    const [tA, tB] = pairs[i];
    const free = raw(mod.mesh_intersect_raw(tA, tB));
    const got = eng.intersect(ia, ib);
    assert.ok(got !== undefined, `${label}${i}: registered ids must resolve`);
    assert.ok(eqArr(raw(got), free), `${label}${i}: Engine.intersect must equal the free function exactly`);
    const j = jsIntersectRaw(js, tA, tB);
    assert.strictEqual(j.pts.length > 0, free.length > 0, `${label}${i}: hit/no-hit vs JS reference`);
    if (free.length) {
      hits++;
      assert.ok(eqArr(j.pts, free.slice(0, -1)), `${label}${i}: points vs JS reference`);
      assert.strictEqual(j.depth, free[free.length - 1], `${label}${i}: depth vs JS reference`);
    }
  };
  pairs.forEach(([tA, tB], i) => { eng.register(2 * i, tA); eng.register(2 * i + 1, tB); });
  assert.strictEqual(eng.len(), pairs.length * 2);
  pairs.forEach((_, i) => check('first', i, 2 * i, 2 * i + 1));
  pairs.forEach((_, i) => check('repeat', i, 2 * i, 2 * i + 1)); // cached BVHs reused: must not drift
  // unregister every 3rd pair's B mesh -> unknown id must read undefined, never "no hit"
  for (let i = 0; i < pairs.length; i += 3) {
    assert.strictEqual(eng.unregister(2 * i + 1), true);
    assert.strictEqual(eng.intersect(2 * i, 2 * i + 1), undefined, `pair ${i}: unregistered id must be undefined`);
    assert.strictEqual(eng.unregister(2 * i + 1), false);
  }
  // re-register and requery
  for (let i = 0; i < pairs.length; i += 3) eng.register(2 * i + 1, pairs[i][1]);
  pairs.forEach((_, i) => check('rereg', i, 2 * i, 2 * i + 1));
  // swapped argument order through the engine matches the free function too
  for (let i = 0; i < 300; i++) {
    const [tA, tB] = pairs[i];
    assert.ok(eqArr(Array.from(eng.intersect(2 * i + 1, 2 * i)), Array.from(mod.mesh_intersect_raw(tB, tA))), `swap${i}`);
  }
  // replacing an id's mesh must replace its BVH (no stale tree)
  eng.register(0, pairs[1][0]);
  assert.ok(eqArr(Array.from(eng.intersect(0, 1)), Array.from(mod.mesh_intersect_raw(pairs[1][0], pairs[0][1]))));
  eng.clear();
  assert.strictEqual(eng.len(), 0);
  assert.strictEqual(eng.intersect(0, 1), undefined);
  eng.free();
  assert.ok(hits > 100, `fixture must produce real hits (${hits})`);
});

test('Engine.min_distance === mesh_min_distance === JS reference (exact), incl. repeat + re-register', async () => {
  const mod = await loadWasm();
  const js = loadJsReference();
  const pairs = buildEnginePairs();
  const eng = new mod.Engine();
  const N = 900; // covers all three scale regimes, near-degenerate and coplanar starts, plus the structured meshes below
  const sel = pairs.slice(0, N).concat(pairs.slice(-4));
  sel.forEach(([tA, tB], i) => { eng.register(2 * i, tA); eng.register(2 * i + 1, tB); });
  const run = (label) => sel.forEach(([tA, tB], i) => {
    const free = Array.from(mod.mesh_min_distance(tA, tB));
    const got = eng.min_distance(2 * i, 2 * i + 1);
    assert.ok(got !== undefined && eqArr(Array.from(got), free), `${label}${i}: Engine.min_distance must equal the free function exactly`);
    const jr = js._ccJsMeshIntersectRef.minDist(tA, tB);
    assert.ok(eqArr(jr, free), `${label}${i}: min-distance vs JS reference`);
  });
  run('first');
  run('repeat');
  for (let i = 0; i < sel.length; i += 2) { eng.unregister(2 * i); assert.strictEqual(eng.min_distance(2 * i, 2 * i + 1), undefined); eng.register(2 * i, sel[i][0]); }
  run('rereg');
  // empty / sub-triangle meshes behave like the free functions
  eng.register(900001, new Float32Array(0));
  eng.register(900002, sel[0][0]);
  assert.ok(eqArr(Array.from(eng.min_distance(900001, 900002)), Array.from(mod.mesh_min_distance(new Float32Array(0), sel[0][0]))));
  assert.strictEqual(eng.intersect(900001, 900002).length, 0);
  eng.free();
});
