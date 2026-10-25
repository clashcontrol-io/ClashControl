'use strict';
// Clearance (min-distance) speed-ups must not change a single bit.
//
// 1. The leaf loop now skips the 9 edge-edge sub-tests of a triangle pair when
//    _ccEELowerSq proves none of them can beat the running best, and stops once
//    the best distance reaches 0. Compared here against the PREVIOUS traversal
//    (plain double loop, all 15 sub-tests, no early stop — rebuilt in this file
//    from the extracted kernel) on adversarial synthetic meshes: exact ties
//    (parallel faces, mirrored and duplicated triangles), slivers, collinear and
//    repeated-vertex triangles, near-coplanar faces, mm-scale and kilometre-
//    offset coordinates, NaN/Infinity — distance, both closest points and the
//    tie winner, for the JS kernel, the stateless WASM functions and the
//    cached-BVH Engine, unseeded and threshold-seeded.
// 2. _ccEELowerSq is a true lower bound of every edge-edge sub-test (fuzz).
// 3. _ccPairDismissed only dismisses pairs every kernel path answers with
//    "no hit" and Infinity.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const pkgDir = path.join(REPO, 'addons', 'wasm-engine-pkg');

async function loadWasm() {
  const mod = await import(path.join(pkgDir, 'clashcontrol_engine.js'));
  await mod.default({ module_or_path: fs.readFileSync(path.join(pkgDir, 'clashcontrol_engine_bg.wasm')) });
  return mod;
}

// Same extraction as tests/wasm-parity.test.js (kernel region of index.html),
// with element accessors that read {tris} test elements.
function loadKernel() {
  const full = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const startIdx = full.indexOf('var _ttIvalA = new Float64Array(8)');
  const endMarkerIdx = full.indexOf('window._ccJsMeshIntersectRef = {');
  const endIdx = full.indexOf('\n  };\n\n  // ── Point-to-surface distance helpers', endMarkerIdx);
  assert.ok(startIdx !== -1 && endMarkerIdx !== -1 && endIdx !== -1, 'kernel extraction markers moved');
  const body = full.slice(startIdx, endIdx + '\n  };'.length);
  const window = { _ccSafetyMigrations: null };
  return new Function('window', '_DETECT_CHUNK_SIZE', '_getWorldTris', '_getBVH', '_bvhLRU', '_ccFrameBox',
    body + '; return {_triTriDistSq,_segSegDistSq,_aabbAabbDistSq,_buildBVHForTris,_jsMinDistBVH,_jsIntersectBVH,_ccTriBoxInto,_ccEELowerSq,_ccPairDismissed,_ccMinDistSeedSq,ref:window._ccJsMeshIntersectRef};'
  )(window, 80, (el) => el.tris, () => null, new Map(), (el) => el.fbox);
}

// The traversal as it was before the edge-edge skip: every triangle pair of
// every visited leaf pair, all 15 sub-tests, strict update, no early stop.
function oldMinDist(K, tA, tB, seedSq) {
  if (!tA.length || !tB.length) return [Infinity];
  const bA = K._buildBVHForTris(tA), bB = K._buildBVHForTris(tB);
  const seeded = seedSq > 0 && seedSq !== Infinity;
  const best = [seeded ? seedSq : Infinity], oA = [0, 0, 0], oB = [0, 0, 0];
  const pa = new Float64Array(3), pb = new Float64Array(3);
  (function trav(nA, nB) {
    if (K._aabbAabbDistSq(nA, nB) >= best[0]) return;
    const aL = nA.lo !== undefined, bL = nB.lo !== undefined;
    if (aL && bL) {
      for (let i = nA.lo; i < nA.hi; i++) for (let j = nB.lo; j < nB.hi; j++) {
        const d = K._triTriDistSq(tA, nA.idx[i] * 9, tB, nB.idx[j] * 9, pa, pb, false);
        if (d < best[0]) { best[0] = d; oA[0] = pa[0]; oA[1] = pa[1]; oA[2] = pa[2]; oB[0] = pb[0]; oB[1] = pb[1]; oB[2] = pb[2]; }
      }
      return;
    }
    if (bL || (!aL && (nA.cnt || 1) >= (nB.cnt || 1))) { trav(nA.left, nB); trav(nA.right, nB); }
    else { trav(nA, nB.left); trav(nA, nB.right); }
  })(bA.root, bB.root);
  if (seeded && best[0] === seedSq) return [Infinity];
  return [Math.sqrt(best[0]), oA[0], oA[1], oA[2], oB[0], oB[1], oB[2]];
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

// Closed prism: profile (CCW 2-D points) extruded `depth` with a vertex ring
// every `ring` along the axis, then mapped by xf (local [x,y,z] -> world).
function prism(pts, depth, ring, xf) {
  const rings = Math.max(1, Math.ceil(depth / ring)), n = pts.length, V = [], T = [];
  for (let r = 0; r <= rings; r++) for (const [x, y] of pts) V.push([x, y, depth * r / rings]);
  for (let r = 0; r < rings; r++) for (let i = 0; i < n; i++) { const b0 = r * n + i, b1 = r * n + (i + 1) % n; T.push([b0, b1, b1 + n], [b0, b1 + n, b0 + n]); }
  for (let i = 1; i < n - 1; i++) { T.push([0, i + 1, i]); T.push([rings * n, rings * n + i, rings * n + i + 1]); }
  const out = new Float32Array(T.length * 9);
  let k = 0;
  for (const t of T) for (const vi of t) { const p = xf(V[vi]); out[k++] = p[0]; out[k++] = p[1]; out[k++] = p[2]; }
  return out;
}
const circ = (r, n) => Array.from({ length: n }, (_, i) => [r * Math.cos(2 * Math.PI * i / n), r * Math.sin(2 * Math.PI * i / n)]);
const rect = (w, h) => [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
const alongX = (x0, y0, z0) => (p) => [p[2] + x0, p[0] + y0, p[1] + z0];
const alongY = (x0, y0, z0) => (p) => [-p[0] + x0, p[2] + y0, p[1] + z0];
const vert = (x0, y0, z0, tilt) => (p) => [p[0] + x0, p[1] + y0 + Math.sin(tilt) * p[2], Math.cos(tilt) * p[2] + z0];

// Adversarial near-miss pairs (synthetic only).
function* nearMissPairs(seed, n) {
  const R = mulberry32(seed), r = (a, b) => a + (b - a) * R();
  const offs = [[0, 0, 0], [1e5, -3e4, 50], [2.5e6, 1e6, -10], [-7e3, 4e2, 1e3]];
  for (let i = 0; i < n; i++) {
    const O = offs[i % offs.length], kind = i % 9, g = [0, 1e-5, 1e-4, 0.001, 0.02, 0.05, 0.0999, 0.15][Math.floor(R() * 8)];
    let A, B;
    if (kind === 0) { // beam + parallel pipe: equal distances all along the length
      A = prism(rect(0.3, 0.5), 2.6, r(0.05, 0.3), alongX(O[0], O[1], O[2] + 2.6));
      const rr = r(0.03, 0.1);
      B = prism(circ(rr, 8 + Math.floor(R() * 32)), 2.2, r(0.05, 0.3), alongX(O[0] + 0.2, O[1], O[2] + 2.6 - 0.25 - g - rr));
    } else if (kind === 1) { // exactly parallel box faces (massive ties)
      A = prism(rect(1, 1), 1, 0.25, alongX(O[0], O[1], O[2]));
      B = prism(rect(1, 1), 1, 0.25, alongX(O[0], O[1] + 1 + g, O[2]));
    } else if (kind === 2) { // mirror-symmetric ties
      A = prism(rect(0.2, 0.2), 2, 0.1, alongX(O[0], O[1], O[2]));
      B = prism(rect(0.6, 0.2), 2, 0.1, alongX(O[0], O[1], O[2] - 0.2 - g));
    } else if (kind === 3) { // tilted riser beside a column
      A = prism(rect(0.4, 0.4), 3, 0.2, vert(O[0], O[1], O[2], 0));
      const rr = r(0.02, 0.06);
      B = prism(circ(rr, 16), 2.5, 0.1, vert(O[0], O[1] + 0.2 + g + rr + 0.03, O[2] + 0.2, -r(0.001, 0.03)));
    } else if (kind === 4) { // soups: collinear, repeated-vertex and sliver triangles
      const mk = (cx) => {
        const t = [], m = 20 + Math.floor(R() * 40);
        for (let k = 0; k < m; k++) {
          const p = [cx + r(-0.3, 0.3), r(-0.3, 0.3), r(-0.3, 0.3)].map((v, j) => v + O[j]);
          const u = [r(-0.2, 0.2), r(-0.2, 0.2), r(-0.2, 0.2)], s = R();
          let q, w;
          if (s < 0.2) { q = p.map((v, j) => v + u[j]); w = p.map((v, j) => v + 2 * u[j]); }
          else if (s < 0.3) { q = p.slice(); w = p.map((v, j) => v + u[j]); }
          else if (s < 0.5) { q = p.map((v, j) => v + u[j]); w = p.map((v, j) => v + u[j] * 1.0000001 + (j === 0 ? 1e-7 : 0)); }
          else { q = p.map((v, j) => v + u[j]); w = p.map((v) => v + r(-0.2, 0.2)); }
          t.push(...p, ...q, ...w);
        }
        return new Float32Array(t);
      };
      A = mk(0); B = mk(0.55 + g);
    } else if (kind === 5) { // near-coplanar faces at tiny angles (Moller snap territory)
      const ang = r(1e-8, 1e-5);
      A = new Float32Array([0, 0, 0, 5, 0, 0, 0, 5, 0, 5, 0, 0, 5, 5, 0, 0, 5, 0].map((v, k) => v + O[k % 3]));
      B = new Float32Array([0.5, 0.5, g, 4, 0.5, g + 3.5 * ang, 0.5, 4, g, 6, 0, g, 9, 0, g + 3 * ang, 6, 3, g].map((v, k) => v + O[k % 3]));
    } else if (kind === 6) { // mm-scale objects
      const s = 1e-3;
      A = prism(rect(s, s), s * 4, s, alongX(O[0], O[1], O[2]));
      B = prism(circ(s / 3, 12), s * 3, s / 2, alongX(O[0] + s / 2, O[1] + s / 2 + s / 3 + g * 1e-2, O[2]));
    } else if (kind === 7) { // duct crossing under a beam: touching / overlapping / gap
      A = prism(rect(0.3, 0.5), 2.6, 0.13, alongX(O[0], O[1], O[2] + 2.6));
      B = prism(rect(0.4, 0.25), 2.4, 0.13, alongY(O[0] + 1.3, O[1] - 1.2, O[2] + 2.6 - 0.25 - 0.125 - (R() < 0.3 ? -0.01 : g)));
    } else { // every triangle twice (exact duplicate ties inside one mesh)
      const base = prism(rect(0.3, 0.3), 1, 0.2, alongX(O[0], O[1], O[2]));
      A = new Float32Array(base.length * 2); A.set(base); A.set(base, base.length);
      B = prism(circ(0.05, 12), 1, 0.2, alongX(O[0] + 0.1, O[1] + 0.15 + 0.05 + g, O[2]));
    }
    yield ['kind' + kind + '#' + i + ' gap ' + g, A, B];
  }
}

const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, Number(b[i])));

test('min distance: JS / WASM / Engine equal the previous traversal bit for bit (seeded and unseeded)', async () => {
  const K = loadKernel();
  const mod = await loadWasm();
  const eng = new mod.Engine();
  let n = 0, finite = 0;
  for (const [name, A, B] of nearMissPairs(7, 180)) {
    eng.register(1, A); eng.register(2, B);
    for (const T of [0, 0.0001, 0.01, 0.05, 0.1, 0.2]) {
      const seed = T ? K._ccMinDistSeedSq(T) : undefined;
      const want = oldMinDist(K, A, B, seed);
      const got = {
        js: K.ref.minDist(A, B, seed),
        wasm: Array.from(seed ? mod.mesh_min_distance_within(A, B, seed) : mod.mesh_min_distance(A, B)),
        engine: Array.from(seed ? eng.min_distance_within(1, 2, seed) : eng.min_distance(1, 2)),
      };
      for (const k of Object.keys(got)) assert.ok(same(got[k], want), `${name} T=${T} ${k}: ${got[k]} vs previous ${want}`);
      for (const [a, b] of [[B, A]]) { // argument order swapped
        const w2 = oldMinDist(K, a, b, seed);
        assert.ok(same(K.ref.minDist(a, b, seed), w2), `${name} T=${T} swapped js`);
        assert.ok(same(Array.from(seed ? mod.mesh_min_distance_within(a, b, seed) : mod.mesh_min_distance(a, b)), w2), `${name} T=${T} swapped wasm`);
      }
      if (want[0] !== Infinity) finite++;
      n++;
    }
  }
  assert.ok(n === 180 * 6 && finite > 400, `coverage: ${n} cases, ${finite} finite`);
  eng.free();
});

test('min distance: exact-tie winners, NaN/Infinity coordinates and the 0-distance stop', async () => {
  const K = loadKernel();
  const mod = await loadWasm();
  const check = (name, A, B) => {
    for (const seed of [undefined, K._ccMinDistSeedSq(0.05), K._ccMinDistSeedSq(1)]) {
      const want = oldMinDist(K, A, B, seed);
      assert.ok(same(K.ref.minDist(A, B, seed), want), name + ' js');
      assert.ok(same(Array.from(seed ? mod.mesh_min_distance_within(A, B, seed) : mod.mesh_min_distance(A, B)), want), name + ' wasm');
    }
  };
  // 1. Many equal-distance triangle pairs in different leaves: two identical
  //    finely split slabs 30 mm apart — every face triangle is a candidate
  //    winner; the first one in traversal order must win.
  const slab = (z) => { const t = []; for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) t.push(i, j, z, i + 1, j, z, i + 1, j + 1, z, i, j, z, i + 1, j + 1, z, i, j + 1, z); return new Float32Array(t.map((v, k) => (k % 3 === 2 ? v : v * 0.25))); };
  check('stacked slabs (ties everywhere)', slab(0), slab(0.03));
  // 2. Vertex test and edge-edge test tie inside one triangle pair (parallel
  //    edges): the vertex test comes first and must stay the winner.
  check('parallel edges tie', new Float32Array([0, 0, 0, 1, 0, 0, 0, -1, 0]), new Float32Array([0.25, 0.02, 0, 0.75, 0.02, 0, 0.5, 1, 0]));
  check('crossed edges (edge-edge is the strict winner)', new Float32Array([-1, 0, 0, 1, 0, 0, 0, 0.001, -1]), new Float32Array([0, -1, 0.04, 0, 1, 0.04, 0.001, 0, 1]));
  // 3. Same triangle listed twice in both meshes (identical values, different ids).
  const t1 = [0, 0, 0, 1, 0, 0, 0, 1, 0], t2 = [0, 0, 0.02, 1, 0, 0.02, 0, 1, 0.02];
  check('duplicated triangles', new Float32Array([...t1, ...t1, ...t1]), new Float32Array([...t2, ...t2]));
  // 4. Touching / crossing meshes: the running best reaches 0 in a leaf and
  //    the rest of that leaf is not evaluated.
  check('crossing', new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0, 5, 5, 5, 6, 5, 5, 5, 6, 5]), new Float32Array([0, 0, -1, 0, 0, 1, 0, 2, 0, 0.1, 0.1, -1, 0.1, 0.1, 1, 0.1, 2, 0]));
  // 5. Non-finite coordinates: the bound must give up, results stay identical.
  const bad = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, NaN, 0, 0, 1, 0, 0, 0, 1, 0, Infinity, 0, 0, 1, 2, 0, 0, 1, 0, 0, 0, 0, -Infinity, 1, 1, 1, 1, 1]);
  check('NaN / Infinity triangles', bad, new Float32Array([0, 0, 0.05, 1, 0, 0.05, 0, 1, 0.05, 3, 3, 3, 4, 3, 3, 3, 4, 3]));
  // 6. Huge and tiny scales (bound returns 0 below 1e-200 / above 1e300).
  check('tiny scale', new Float32Array([0, 0, 0, 1e-30, 0, 0, 0, 1e-30, 0]), new Float32Array([2e-30, 2e-30, 1e-31, 3e-30, 2e-30, 1e-31, 2e-30, 3e-30, 1e-31]));
  check('huge offset', new Float32Array([1e7, 1e7, 0, 1e7 + 1, 1e7, 0, 1e7, 1e7 + 1, 0]), new Float32Array([1e7 + 3, 1e7, 0.5, 1e7 + 4, 1e7, 0.5, 1e7 + 3, 1e7 + 1, 0.5]));
});

test('_ccEELowerSq never exceeds any edge-edge sub-test (fuzz incl. offsets, slivers, touching boxes)', () => {
  const K = loadKernel();
  const R = mulberry32(31), r = (a, b) => a + (b - a) * R();
  const bA = new Float64Array(7), bB = new Float64Array(7), oa = new Float64Array(3), ob = new Float64Array(3);
  let used = 0;
  for (let it = 0; it < 60000; it++) {
    const scale = [1e-3, 1, 30, 1e4][it % 4], off = [0, 1e3, 1e5, 3e6][(it >> 2) % 4], gap = [0, 1e-9, 1e-6, 1e-3, 0.05][(it >> 4) % 5] * scale;
    const tri = (dx) => {
      const p = [r(-1, 1), r(-1, 1), r(-1, 1)].map((v) => v * scale), t = [];
      for (let v = 0; v < 3; v++) for (let c = 0; c < 3; c++) t.push(off + (c === 0 ? dx : 0) + p[c] + (R() < 0.15 ? 0 : r(-1, 1) * scale * (R() < 0.2 ? 1e-6 : 1)));
      return t;
    };
    const ta = tri(0), tb0 = tri(0);
    // shift B so the boxes are `gap` apart along x
    const maxA = Math.max(Math.fround(ta[0]), Math.fround(ta[3]), Math.fround(ta[6])), minB = Math.min(Math.fround(tb0[0]), Math.fround(tb0[3]), Math.fround(tb0[6]));
    const tb = tb0.map((v, k) => (k % 3 === 0 ? v + (maxA - minB) + gap : v));
    const A = new Float32Array(ta), B = new Float32Array(tb);
    K._ccTriBoxInto(A, 0, bA, 0); K._ccTriBoxInto(B, 0, bB, 0);
    const lb = K._ccEELowerSq(bA, 0, bB, 0);
    if (lb > 0) used++;
    const V = (T, i) => [T[3 * i], T[3 * i + 1], T[3 * i + 2]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const d = K._segSegDistSq(...V(A, i), ...V(A, (i + 1) % 3), ...V(B, j), ...V(B, (j + 1) % 3), oa, ob);
      assert.ok(!(d < lb), `iteration ${it}: edge-edge ${d} below bound ${lb}`);
    }
  }
  assert.ok(used > 20000, 'bound informative in ' + used + ' cases');
});

test('_ccPairDismissed: every dismissed pair is "no hit" + Infinity on every kernel path', async () => {
  const K = loadKernel();
  const mod = await loadWasm();
  const el = (tris) => {
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let i = 0; i < tris.length; i += 3) { mnx = Math.min(mnx, tris[i]); mxx = Math.max(mxx, tris[i]); mny = Math.min(mny, tris[i + 1]); mxy = Math.max(mxy, tris[i + 1]); mnz = Math.min(mnz, tris[i + 2]); mxz = Math.max(mxz, tris[i + 2]); }
    return { tris, fbox: { min: { x: mnx, y: mny, z: mnz }, max: { x: mxx, y: mxy, z: mxz } } };
  };
  const R = mulberry32(5);
  let dismissed = 0, kept = 0;
  for (let it = 0; it < 400; it++) {
    const O = [[0, 0, 0], [1e5, 2e4, 30]][it % 2];
    const A = prism(rect(0.3, 0.5), 2, 0.25, alongX(O[0], O[1], O[2]));
    // B placed around A's box corner region: per axis within ~0.12 m, diagonally farther
    const dx = (R() - 0.5) * 0.3, dy = 0.15 + 0.05 + R() * 0.12 * (R() < 0.5 ? 1 : 0), dz = 0.25 + 0.05 + R() * 0.12 * (R() < 0.5 ? 1 : 0);
    const B = prism(circ(0.05, 12), 1.5, 0.25, alongX(O[0] + 2 + dx, O[1] + dy, O[2] + dz));
    const eA = el(A), eB = el(B);
    for (const T of [0, 0.0001, 0.02, 0.05, 0.1]) {
      const seed = T ? K._ccMinDistSeedSq(T) : 0;
      if (!K._ccPairDismissed(eA, eB, seed)) { kept++; continue; }
      dismissed++;
      assert.strictEqual(K._jsIntersectBVH(K._buildBVHForTris(A), K._buildBVHForTris(B), eA.fbox, eB.fbox), false, 'js hard');
      assert.strictEqual(mod.mesh_intersect_raw(A, B).length, 0, 'wasm hard');
      if (seed) {
        assert.deepStrictEqual(K.ref.minDist(A, B, seed), [Infinity], 'js min distance');
        assert.deepStrictEqual(Array.from(mod.mesh_min_distance_within(A, B, seed)), [Infinity], 'wasm min distance');
        assert.ok(!(oldMinDist(K, A, B)[0] < T), 'the unseeded distance is beyond the tolerance');
      }
    }
  }
  assert.ok(dismissed > 200 && kept > 200, `both outcomes covered (${dismissed} dismissed, ${kept} kept)`);
  // never for empty or non-finite meshes
  assert.strictEqual(K._ccPairDismissed(el(new Float32Array(0)), el(new Float32Array([5, 5, 5, 6, 5, 5, 5, 6, 5])), 0), false);
  assert.strictEqual(K._ccPairDismissed(el(new Float32Array([0, 0, 0, Infinity, 0, 0, 0, 1, 0])), el(new Float32Array([5, 5, 5, 6, 5, 5, 5, 6, 5])), 0), false);
});
