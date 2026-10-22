'use strict';
// Clash-engine ACCURACY vs ground truth (not engine-vs-engine parity).
//
// tests/_oracle-exact.js is an independent exact oracle (BigInt / rational
// arithmetic, brute force over every triangle pair, symbolic perturbation for
// point-in-mesh). This file
//   1. proves the oracle self-consistent (designed analytic categories and
//      distances, symmetry, exact scale/permutation/mirror invariance, prune
//      vs no-prune, and seeded random AABB pairs against closed-form truth);
//   2. runs the JS reference engine extracted from index.html (the same
//      kernels tests/wasm-parity.test.js extracts, plus the penetration-depth
//      estimator) on analytic fixtures + seeded random mesh pairs and scores it
//      against the oracle: precision/recall per category, distance error,
//      penetration error, NaN outputs.
//
// It PASSES today: engine disagreements are RECORDED, not failed on — except
// that any disagreement on an analytic fixture that is NOT listed in
// KNOWN_DISCREPANCIES below fails (so new regressions are caught), and a
// listed one that starts agreeing is reported as "fixed" so the table can be
// tightened. When the engine is fixed, delete its rows: they become strict.
//
// Report: JSON at $CC_ORACLE_REPORT (default: <os.tmpdir()>/cc-engine-oracle-report.json)
// plus console tables.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const O = require('./_oracle-exact.js');

const REPO = path.join(__dirname, '..');
const TOL_M = 0.05;                  // default clash rules: maxGap 50 mm
const TOL_RAT = [1, 20];             // 50 mm as an exact rational (metres)
const DIST_EPS_M = 1e-6;             // |engine − exact| above 1 µm counts as a distance error

// ════════════════════════════════════════════════════════════════════════════
// KNOWN CURRENT ENGINE DISCREPANCIES — the to-do list for the engine fix job.
// fixture name -> metrics on which the engine currently disagrees with ground
// truth. Metrics:
//   hard     — kernel+pipeline HARD verdict vs truth "interiors overlap"
//              (crossing ∪ contained)
//   final    — default-rules outcome (hard + 50 mm clearance): expected 'hard'
//              for crossing/contained, 'soft' for contact or clearance <= 50 mm
//              (exact), 'none' otherwise
//   distance — engine min distance vs exact (> 1 µm off; 0 expected when the
//              surfaces meet or one is contained)
//   nan      — engine produced a NaN anywhere
// Delete a row (or a metric) once the engine is fixed: it then becomes a strict
// assertion.
// ════════════════════════════════════════════════════════════════════════════
const KNOWN_DISCREPANCIES = {
  // [E1] Containment is not a hard clash: no triangle pair crosses, so the
  // tri-tri kernel misses; only the soft path's containment fix sees it
  // (reported as a 0 mm clearance clash, or nothing in a hard-only run).
  'pipe-inside-column': ['hard', 'final'],
  'tiny-cube-inside-huge-slab': ['hard', 'final'],
  'open-plate-inside-box': ['hard', 'final'],
  // [E2] rules.minOverlapVolM3 (1e-5 m³ AABB-overlap volume) drops real
  // penetrations of small/thin elements and every zero-thickness element.
  'anchor-rod-2mm-through-slab': ['hard', 'final'],
  'tiny-cube-10mm-into-huge-slab': ['hard', 'final'],
  'open-plate-through-box': ['hard', 'final'],
  // [E3] _triTriTest 0/0: a triangle with an edge lying exactly in the other
  // triangle's plane (common in axis-aligned BIM: faces sharing a plane)
  // yields a NaN interval, the NaN point array is truthy, and _triTriDistSq
  // returns distance 0 for elements that are metres apart.
  'shared-plane-diagonal-gap-500mm': ['final', 'distance', 'nan'],
  'duct-above-wall-flush-side-30mm': ['distance', 'nan'],
  'far-100km-gap-49.9mm-x': ['distance', 'nan'],
  'far-100km-gap-50.1mm-x': ['distance', 'nan'],
  // [E4] The kernel reports touching faces as a hit; "touch is not a clash"
  // is only enforced by the AABB-overlap-volume filter, which is 0 only for
  // axis-aligned contact. A face contact on a rotated plane becomes HARD.
  'rotated-30deg-face-contact': ['hard', 'final'],
  // [E5] The containment fix's ray-parity test runs on open meshes too: a
  // box inside an open shell reads "inside" -> distance 0 instead of 0.4 m.
  'box-inside-open-box': ['final', 'distance'],
};

// ── Engine extraction (same technique as tests/wasm-parity.test.js) ─────────
function loadEngine() {
  const full = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const startMarker = 'var _ttIvalA = new Float64Array(8)';
  const endMarker = 'function _flushGeoCache(models)';
  const s = full.indexOf(startMarker), e = full.indexOf(endMarker);
  assert.ok(s !== -1 && e > s, 'engine extraction markers not found in index.html — update loadEngine()');
  const body = full.slice(s, e);
  const window = { _ccSafetyMigrations: null };
  const _getWorldTris = (el) => el._triCache;
  const _getWorldVerts = (el) => el._verts;
  return new Function('window', '_DETECT_CHUNK_SIZE', '_getWorldTris', '_getWorldVerts',
    body + '; return {_triTriTest,_buildBVHForTris,_bvhTraverseAll,_jsIntersectBVH,_jsMinDistBVH,_estimatePenetrationDepthM,_MI_MARGIN};'
  )(window, 80, _getWorldTris, _getWorldVerts);
}

function f32(a) { return a instanceof Float32Array ? a : Float32Array.from(a); }
function aabb(t) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3) for (let k = 0; k < 3; k++) { if (t[i + k] < mn[k]) mn[k] = t[i + k]; if (t[i + k] > mx[k]) mx[k] = t[i + k]; }
  return { min: { x: mn[0], y: mn[1], z: mn[2] }, max: { x: mx[0], y: mx[1], z: mx[2] } };
}
function uniqVerts(t) {
  const seen = new Set(), out = [];
  for (let i = 0; i < t.length; i += 3) { const k = t[i] + ',' + t[i + 1] + ',' + t[i + 2]; if (!seen.has(k)) { seen.add(k); out.push(t[i], t[i + 1], t[i + 2]); } }
  return new Float32Array(out);
}
function overlapVol(a, b) {
  const ox = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
  const oy = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
  const oz = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
  return (ox > 0 && oy > 0 && oz > 0) ? ox * oy * oz : 0;
}
// Mirrors _processCandidate's decision for one pair (index.html, "L1+L2" block):
// hard = kernel hit && AABB overlap >= minOverlapVolM3; soft only when not hard.
function runEngine(js, trisA, trisB) {
  const tA = f32(trisA), tB = f32(trisB);
  const boxA = aabb(tA), boxB = aabb(tB);
  const bA = js._buildBVHForTris(tA), bB = js._buildBVHForTris(tB);
  const raw = []; const dep = [0];
  js._bvhTraverseAll(bA.root, bA.tris, bB.root, bB.tris, raw, 24, dep, false);
  const hit = js._jsIntersectBVH(bA, bB, boxA, boxB);
  const out = [0, 0, 0, 0, 0, 0];
  const dist = js._jsMinDistBVH(bA, bB, out);
  let pen = null;
  if (hit) {
    const elA = { _triCache: tA, _verts: uniqVerts(tA) }, elB = { _triCache: tB, _verts: uniqVerts(tB) };
    try { pen = js._estimatePenetrationDepthM(elA, elB); } catch (e) { pen = 'throw:' + e.message; }
  }
  const vol = overlapVol(boxA, boxB);
  // the depth the app stores on a hard clash (clash.distance = -depth mm):
  // estimator, else the tri-pair chord, else the smallest AABB overlap extent
  let appDepthM = null;
  if (hit) {
    const mm = typeof pen === 'number' ? Math.round(pen * 1000) : Math.round(hit[3] * 1000);
    if (mm > 0) appDepthM = mm / 1000;
    else {
      const ox = Math.min(boxA.max.x, boxB.max.x) - Math.max(boxA.min.x, boxB.min.x);
      const oy = Math.min(boxA.max.y, boxB.max.y) - Math.max(boxA.min.y, boxB.min.y);
      const oz = Math.min(boxA.max.z, boxB.max.z) - Math.max(boxA.min.z, boxB.min.z);
      appDepthM = Math.max(1, Math.round(Math.min(ox, oy, oz) * 1000)) / 1000;
    }
  }
  // user-visible outputs (distance, closest pair, hit point/depth, penetration)
  const nan = [dist, ...out, ...(hit ? hit : []), ...(typeof pen === 'number' ? [pen] : [])].some((v) => Number.isNaN(v));
  // NaN inside the raw tri-tri point list (later dropped by the box filter, but
  // it still makes the probe pass report "hit" and costs a collect pass)
  const nanRaw = raw.some((v) => Number.isNaN(v)) || Number.isNaN(dep[0]);
  return { rawHit: raw.length > 0, kernelHit: !!hit, hitPt: hit || null, dist, pen, appDepthM, overlapVol: vol, nan, nanRaw, rawPts: raw.length / 3 };
}
function engineOutcome(e, rules) {
  const hard = !!(rules.hard && e.kernelHit && !(rules.minOverlapVolM3 > 0 && e.overlapVol < rules.minOverlapVolM3));
  const gap = (rules.maxGap || 0) / 1000, minGap = (rules.minGap || 0) / 1000;
  const wantsSoft = !rules.hard || (rules.maxGap || 0) > 0;
  const soft = !hard && gap > 0 && wantsSoft && e.dist <= gap && e.dist >= minGap;
  return hard ? 'hard' : soft ? 'soft' : 'none';
}
const RULES_DEFAULT = { hard: true, maxGap: 50, minGap: 0, minOverlapVolM3: 1e-5 };
const RULES_HARD = { hard: true, maxGap: 0, minGap: 0, minOverlapVolM3: 1e-5 };
const RULES_CLEAR = { hard: false, maxGap: 50, minGap: 0, minOverlapVolM3: 1e-5 };
function truthOutcome(o, rules) {
  const overlap = o.category === 'crossing' || o.category === 'contained';
  if (rules.hard && overlap) return 'hard';
  const within = o.distance === 0 || O.cmpDistToRational(o, TOL_RAT[0], TOL_RAT[1]) <= 0;
  const wantsSoft = !rules.hard || (rules.maxGap || 0) > 0;
  if (wantsSoft && (rules.maxGap || 0) > 0 && within) return 'soft';
  return 'none';
}

// ── Shapes (built in float64, stored as Float32 exactly as the engine sees them) ──
function meshFrom(V, F) { const t = []; for (const f of F) for (const i of f) t.push(V[i][0], V[i][1], V[i][2]); return t; }
function boxV(x0, x1, y0, y1, z0, z1) {
  return [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
}
const BOXF = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [2, 3, 7], [2, 7, 6], [1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3]];
function box(x0, x1, y0, y1, z0, z1) { return f32(meshFrom(boxV(x0, x1, y0, y1, z0, z1), BOXF)); }
// closed prism: convex polygon pts [[u,v]] extruded along axis from a0 to a1
function prism(pts, axis, a0, a1) {
  const n = pts.length, V = [];
  const P = (u, v, w) => axis === 'x' ? [w, u, v] : axis === 'y' ? [v, w, u] : [u, v, w];
  for (const [u, v] of pts) V.push(P(u, v, a0));
  for (const [u, v] of pts) V.push(P(u, v, a1));
  const F = [];
  for (let i = 1; i < n - 1; i++) { F.push([0, i + 1, i]); F.push([n, n + i, n + i + 1]); }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; F.push([i, j, n + j]); F.push([i, n + j, n + i]); }
  return f32(meshFrom(V, F));
}
// circle with exact axis points (cos/sin snapped at multiples of 90°)
function circle(cu, cv, r, seg) {
  const out = [];
  for (let s = 0; s < seg; s++) {
    const k4 = (4 * s) / seg;
    let c, sn;
    if (Number.isInteger(k4)) { c = [1, 0, -1, 0][k4]; sn = [0, 1, 0, -1][k4]; } else { const a = (2 * Math.PI * s) / seg; c = Math.cos(a); sn = Math.sin(a); }
    out.push([cu + r * c, cv + r * sn]);
  }
  return out;
}
function cylinder(axis, a0, a1, cu, cv, r, seg) { return prism(circle(cu, cv, r, seg), axis, a0, a1); }
function transform(tris, R, T) {
  const o = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) {
    const x = tris[i], y = tris[i + 1], z = tris[i + 2];
    o[i] = R[0] * x + R[1] * y + R[2] * z + T[0];
    o[i + 1] = R[3] * x + R[4] * y + R[5] * z + T[1];
    o[i + 2] = R[6] * x + R[7] * y + R[8] * z + T[2];
  }
  return o;
}
function rot(ax, ay, az) {
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay), cz = Math.cos(az), sz = Math.sin(az);
  const Rx = [1, 0, 0, 0, cx, -sx, 0, sx, cx], Ry = [cy, 0, sy, 0, 1, 0, -sy, 0, cy], Rz = [cz, -sz, 0, sz, cz, 0, 0, 0, 1];
  const mul = (A, B) => { const C = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C.push(A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]); return C; };
  return mul(Rz, mul(Ry, Rx));
}
const ID = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function concat(...ms) { const n = ms.reduce((s, m) => s + m.length, 0); const o = new Float32Array(n); let k = 0; for (const m of ms) { o.set(m, k); k += m.length; } return o; }
// Wall slab (thickness along x, x0..x1) with a rectangular through-hole; manifold.
function frame(x0, x1, y0, y1, z0, z1, hy0, hy1, hz0, hz1) {
  const V = [];
  const ring = (x) => [[x, y0, z0], [x, y1, z0], [x, y1, z1], [x, y0, z1], [x, hy0, hz0], [x, hy1, hz0], [x, hy1, hz1], [x, hy0, hz1]];
  V.push(...ring(x0), ...ring(x1));
  const F = [];
  for (const base of [0, 8]) for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4; F.push([base + i, base + j, base + 4 + j]); F.push([base + i, base + 4 + j, base + 4 + i]);
  }
  for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; F.push([i, 8 + i, 8 + j]); F.push([i, 8 + j, j]); F.push([4 + i, 12 + i, 12 + j]); F.push([4 + i, 12 + j, 4 + j]); }
  return f32(meshFrom(V, F));
}
// open quad (2 triangles, no thickness) in plane z = z
function plateZ(x0, x1, y0, y1, z) { return f32(meshFrom([[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], [[0, 1, 2], [0, 2, 3]])); }
// box whose +z face is fan-triangulated through a vertex 0.5 µm off its edge (slivers) plus a zero-area triangle
function sliverBox(x0, x1, y0, y1, z0, z1) {
  const V = boxV(x0, x1, y0, y1, z0, z1);
  const mid = [(x0 + x1) / 2, y0 + 5e-7, z1]; V.push(mid); // index 8
  const F = BOXF.filter((f) => !(f[0] === 4 && (f[1] === 5 || f[1] === 6)));
  F.push([4, 5, 8], [5, 6, 8], [6, 7, 8], [7, 4, 8]);
  F.push([4, 4, 5]); // zero-area (repeated vertex)
  return f32(meshFrom(V, F));
}

// ── Analytic fixtures ───────────────────────────────────────────────────────
// expect: designed truth category; dist: exact Float32-input distance where it
// is analytic (m); mtd: analytic minimum translation distance for AABB pairs.
function analyticFixtures() {
  const F = [];
  const add = (name, a, b, expect, extra) => F.push(Object.assign({ name, a, b, expect }, extra || {}));
  const wall = box(4.9, 5.1, -2, 4, 0, 3.2);
  add('duct-through-wall-no-opening', box(-1, 9, 0.6, 1.4, 2.5, 2.9), wall, 'crossing', { mtd: 0.7 });
  add('beam-through-duct', box(0, 10, 0, 0.3, 2.2, 2.7), box(4, 6, -1, 1, 2.4, 2.8), 'crossing', { mtd: 0.3 });
  add('pipe-through-column', cylinder('x', -1, 2, 0.2, 1.5, 0.05, 16), box(0, 0.4, 0, 0.4, 0, 3), 'crossing');
  add('pipe-inside-column', cylinder('z', 0.5, 2.5, 0.2, 0.2, 0.05, 16), box(0, 0.4, 0, 0.4, 0, 3), 'contained');
  add('wall-on-slab-flush', box(0, 5, 0, 0.2, 0, 3), box(-1, 6, -1, 1, -0.25, 0), 'contact');
  add('pipe-resting-on-beam', cylinder('y', -1, 1, 0.5625, 0.15, 0.0625, 16), box(0, 0.3, -2, 2, 0, 0.5), 'contact');
  add('pipe-resting-on-pipe', cylinder('x', -1, 1, 0, 0.1, 0.05, 16), cylinder('y', -1, 1, 0, 0, 0.05, 16), 'contact');
  add('box-edge-touch', box(0, 1, 0, 1, 0, 1), box(1, 2, 1, 2, 0, 1), 'contact');
  add('box-vertex-touch', box(0, 1, 0, 1, 0, 1), box(1, 2, 1, 2, 1, 2), 'contact');
  add('diamond-edge-on-slab', prism([[0, 0], [0.25, 0.25], [0, 0.5], [-0.25, 0.25]], 'x', 0, 2), box(-1, 3, -1, 1, -0.2, 0), 'contact');
  add('pyramid-vertex-on-slab', f32(meshFrom([[0, 0, 0], [-0.2, -0.2, 0.3], [0.2, -0.2, 0.3], [0, 0.2, 0.3]], [[0, 2, 1], [0, 3, 2], [0, 1, 3], [1, 2, 3]])), box(-1, 1, -1, 1, -0.2, 0), 'contact');
  add('slab-under-column-crossing-1mm', box(0, 0.4, 0, 0.4, -0.001, 3), box(-1, 1, -1, 1, -0.25, 0), 'crossing', { mtd: 0.001 });
  // clearance around the 50 mm tolerance (z-gaps; exact Float32 values)
  const g = (v) => Math.fround(v);
  for (const [nm, gap] of [['49.9mm', 0.0499], ['50.0mm', 0.05], ['50.1mm', 0.0501]]) {
    add('gap-' + nm, box(0, 1, 0, 1, -1, 0), box(0, 1, 0, 1, g(gap), 1), 'clearance', { dist: g(gap) });
  }
  // ±1 Float32 ulp around fround(0.05), at two bases
  for (const base of [0, 3]) {
    const t = Math.fround(base + 0.05);
    const ulpDown = (x) => { const f = new Float32Array([x]); const u = new Int32Array(f.buffer); u[0] -= 1; return f[0]; };
    const ulpUp = (x) => { const f = new Float32Array([x]); const u = new Int32Array(f.buffer); u[0] += 1; return f[0]; };
    for (const [tag, z] of [['-1ulp', ulpDown(t)], ['0ulp', t], ['+1ulp', ulpUp(t)]]) {
      add('ulp-gap-base' + base + tag, box(0, 1, 0, 1, base - 1, base), box(0, 1, 0, 1, z, base + 1), 'clearance', { dist: z - base });
    }
  }
  // edge-edge near miss between skew diamond bars (closest points interior to edges)
  add('skew-bars-edge-edge-gap-30mm', prism([[0, 0], [0.1, 0.1], [0, 0.2], [-0.1, 0.1]], 'x', -1, 1),
    prism([[0.23, 0], [0.33, 0.1], [0.43, 0], [0.33, -0.1]], 'y', -1, 1), 'clearance', { dist: g(0.23) - g(0.2) });
  add('parallel-pipes-gap-49.9mm', cylinder('x', 0, 2, 0, 0, 0.05, 16), cylinder('x', 0, 2, g(0.1499), 0, 0.05, 16), 'clearance');
  add('parallel-pipes-gap-50.1mm', cylinder('x', 0, 2, 0, 0, 0.05, 16), cylinder('x', 0, 2, g(0.1501), 0, 0.05, 16), 'clearance');
  add('device-under-slab-midface-100mm', box(-0.1, 0.1, -0.1, 0.1, -0.55, -0.35), box(-5, 5, -5, 5, -0.25, 0), 'clearance', { dist: g(0.35) - g(0.25) });
  // openings (wall with a void)
  add('duct-through-opening-30mm', box(-1, 2, 0.03, 0.83, 0.03, 0.43), frame(0, 0.2, -1, 2, -1, 2, 0, 0.86, 0, 0.46), 'clearance');
  add('duct-through-undersized-opening', box(-1, 2, 0.03, 0.83, 0.03, 0.43), frame(0, 0.2, -1, 2, -1, 2, 0.1, 0.7, 0.1, 0.35), 'crossing');
  // rotated / skewed members
  const R1 = rot(0.3, 0.2, 0.7);
  add('rotated-beam-through-column', transform(box(-2, 2, -0.15, 0.15, -0.25, 0.25), R1, [0.2, 0.2, 1.5]), box(0, 0.4, 0, 0.4, 0, 3), 'crossing');
  add('rotated-beam-near-column', transform(box(-2, 2, -0.15, 0.15, -0.25, 0.25), rot(0, 0, 0.6), [0.2, 2.6, 1.5]), box(0, 0.4, 0, 0.4, 0, 3), 'separate');
  add('sloped-pipe-through-slab', transform(cylinder('x', -1, 1, 0, 0, 0.04, 12), rot(0, 0.5, 0.2), [0, 0, 0]), box(-2, 2, -2, 2, -0.12, 0.12), 'crossing');
  // thin plates vs big slabs; tiny vs huge
  add('steel-plate-1mm-through-slab', box(0, 0.001, 0, 0.3, -0.5, 0.5), box(-5, 5, -5, 5, -0.125, 0.125), 'crossing');
  add('anchor-rod-2mm-through-slab', box(0, 0.002, 0, 0.002, -0.5, 0.5), box(-5, 5, -5, 5, -0.125, 0.125), 'crossing');
  add('plate-flush-on-slab', box(0, 1, 0, 1, 0.125, 0.135), box(-5, 5, -5, 5, -0.125, 0.125), 'contact');
  add('tiny-cube-10mm-into-huge-slab', box(0, 0.01, 0, 0.01, 0.12, 0.13), box(-50, 50, -50, 50, -0.125, 0.125), 'crossing');
  add('tiny-cube-inside-huge-slab', box(0, 0.01, 0, 0.01, 0, 0.01), box(-50, 50, -50, 50, -0.125, 0.125), 'contained');
  // faces that share a plane but are apart: the tri-tri interval step divides 0/0
  add('shared-plane-diagonal-gap-500mm', box(0, 1, 0, 1, 0, 1), box(-1, 0, 0, 1, 1.5, 3), 'separate', { dist: 0.5 });
  add('duct-above-wall-flush-side-30mm', box(0, 0.2, 0, 5, 0, 3), box(0.2, 0.6, 1, 2, g(3.03), 3.4), 'clearance', { dist: g(3.03) - 3 });
  // face contact on a rotated plane (exactly shared Float32 vertices): AABBs overlap
  {
    const A = transform(box(-0.5, 0.5, -0.2, 0.2, 0, 1), rot(0, 0, Math.PI / 6), [0, 0, 0]);
    const v = (i) => [A[i * 3], A[i * 3 + 1], A[i * 3 + 2]];
    // boxV order recovered from BOXF positions: vertex k first appears at tri/corner below
    const corner = {}; BOXF.forEach((f, ti) => f.forEach((k, ci) => { if (!(k in corner)) corner[k] = ti * 3 + ci; }));
    const AV = []; for (let k = 0; k < 8; k++) AV.push(v(corner[k]));
    const off = [AV[1][0] - AV[0][0], AV[1][1] - AV[0][1], AV[1][2] - AV[0][2]];
    const add3 = (p) => [Math.fround(p[0] + off[0]), Math.fround(p[1] + off[1]), Math.fround(p[2] + off[2])];
    const BV = [AV[1], add3(AV[1]), add3(AV[2]), AV[2], AV[5], add3(AV[5]), add3(AV[6]), AV[6]];
    add('rotated-30deg-face-contact', A, f32(meshFrom(BV, BOXF)), 'contact');
  }
  // exact duplicates / shared faces
  add('exact-duplicate-boxes', box(0, 1, 0, 2, 0, 3), box(0, 1, 0, 2, 0, 3), 'crossing');
  add('coincident-face-same-side', box(0, 1, 0, 1, 0, 1), box(0, 1, 0, 1, 0, 2), 'crossing');
  add('inside-touching-face', box(0, 2, 1, 2, 1, 2), box(0, 10, 0, 10, 0, 10), 'crossing');
  // sliver / degenerate triangles
  add('sliver-face-box-crossed', box(0.2, 0.8, 0.2, 0.8, 0.5, 2), sliverBox(0, 1, 0, 1, 0, 1), 'crossing');
  add('sliver-face-box-gap-20mm', box(0.2, 0.8, -0.5, 1.5, g(1.02), 2), sliverBox(0, 1, 0, 1, 0, 1), 'clearance', { dist: g(1.02) - 1 });
  // open meshes
  add('open-plate-through-box', plateZ(-1, 2, -1, 2, 0.5), box(0, 1, 0, 1, 0, 1), 'crossing');
  add('open-plate-inside-box', plateZ(0.2, 0.8, 0.2, 0.8, 0.5), box(0, 1, 0, 1, 0, 1), 'contained');
  add('box-inside-open-box', box(0.4, 0.6, 0.4, 0.6, 0.4, 0.6), f32(meshFrom(boxV(0, 1, 0, 1, 0, 1), BOXF.slice(0, 10))), 'separate');
  // 100 km from origin (Float32 world coordinates — the app has no origin shift)
  const K = 100000;
  add('far-100km-duct-through-wall', box(K - 1, K + 9, K + 0.6, K + 1.4, 2.5, 2.9), box(K + 4.9, K + 5.1, K - 2, K + 4, 0, 3.2), 'crossing', { mtd: 0.7 });
  add('far-100km-wall-on-slab', box(K, K + 5, K, K + 0.2, 0, 3), box(K - 1, K + 6, K - 1, K + 1, -0.25, 0), 'contact');
  add('far-100km-gap-49.9mm-x', box(K, K + 1, 0, 1, 0, 1), box(K + 1.0499, K + 2, 0, 1, 0, 1), 'clearance', { intendedDist: 0.0499, dist: g(K + 1.0499) - (K + 1) });
  add('far-100km-gap-50.1mm-x', box(K, K + 1, 0, 1, 0, 1), box(K + 1.0501, K + 2, 0, 1, 0, 1), 'clearance', { intendedDist: 0.0501, dist: g(K + 1.0501) - (K + 1) });
  return F;
}

// ── Random fixtures ─────────────────────────────────────────────────────────
function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomShape(r) {
  const k = Math.floor(r() * 4);
  const sx = 0.05 + r() * 1.5, sy = 0.05 + r() * 1.5, sz = 0.05 + r() * 1.5;
  if (k === 0) return box(-sx / 2, sx / 2, -sy / 2, sy / 2, -sz / 2, sz / 2);
  if (k === 1) return cylinder('x', -sx, sx, 0, 0, Math.min(sy, sz) / 2, 6 + 2 * Math.floor(r() * 5));
  if (k === 2) return prism([[0, 0], [sx, 0], [sx, sy * 0.3], [sx * 0.2, sy]].map(([u, v]) => [u - sx / 2, v - sy / 2]), 'z', -sz / 2, sz / 2);
  return f32(meshFrom([[-sx, -sy, -sz], [sx, -sy, -sz], [0, sy, -sz], [0, 0, sz]], [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]]));
}
function randomPairs(seed, n) {
  const r = mulberry32(seed), out = [];
  for (let i = 0; i < n; i++) {
    const a = transform(randomShape(r), rot(r() * 6.3, r() * 6.3, r() * 6.3), [0, 0, 0]);
    const bShape = randomShape(r);
    const R = rot(r() * 6.3, r() * 6.3, r() * 6.3);
    // place B along a random direction at a distance chosen to land near the surface of A
    const dir = [r() - 0.5, r() - 0.5, r() - 0.5]; const L = Math.hypot(...dir); dir.forEach((v, j) => { dir[j] = v / L; });
    let lo = 0, hi = 5;
    const at = (s) => transform(bShape, R, dir.map((v) => v * s));
    // bisection on the oracle-free float distance proxy (AABB) to start near contact, then jitter
    for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; const bb = aabb(at(m)), ba = aabb(a); if (overlapVol(ba, bb) > 0) lo = m; else hi = m; }
    const s = hi + (r() - 0.6) * 0.3;
    out.push({ name: `rand-${seed}-${i}`, a, b: at(s) });
  }
  return out;
}
// dyadic random AABB pairs with closed-form truth
function randomAabbPairs(seed, n) {
  const r = mulberry32(seed), out = [];
  const q = (v) => Math.round(v * 256) / 256;
  for (let i = 0; i < n; i++) {
    const A = [], B = [];
    for (let k = 0; k < 3; k++) {
      const a0 = q(r() * 2), a1 = a0 + q(0.0625 + r() * 1.5);
      const mode = r();
      let b0;
      if (mode < 0.25) b0 = a1;                       // touching on this axis
      else if (mode < 0.35) b0 = a0 - q(0.0625 + r());  // overlapping/containing
      else b0 = q(r() * 3);
      const b1 = b0 + q(0.0625 + r() * 1.5);
      A.push(a0, a1); B.push(b0, b1);
    }
    let overlapAll = true, touchAll = true, gap2 = 0, aInB = true, bInA = true;
    for (let k = 0; k < 3; k++) {
      const [a0, a1] = [A[2 * k], A[2 * k + 1]], [b0, b1] = [B[2 * k], B[2 * k + 1]];
      if (!(a0 < b1 && b0 < a1)) overlapAll = false;
      const g = Math.max(b0 - a1, a0 - b1, 0);
      if (g > 0) touchAll = false;
      gap2 += g * g;
      if (!(a0 > b0 && a1 < b1)) aInB = false;
      if (!(b0 > a0 && b1 < a1)) bInA = false;
    }
    const truth = overlapAll ? ((aInB || bInA) ? 'contained' : 'crossing') : touchAll ? 'contact' : 'clearance';
    out.push({ name: `aabb-${seed}-${i}`, a: box(A[0], A[1], A[2], A[3], A[4], A[5]), b: box(B[0], B[1], B[2], B[3], B[4], B[5]), truth, gap2 });
  }
  return out;
}

// ── Scoring ─────────────────────────────────────────────────────────────────
const CATS = ['crossing', 'contained', 'contact', 'clearance≤tol', 'clearance>tol', 'separate'];
function truthBucket(o) {
  if (o.category === 'clearance' || o.category === 'separate') {
    if (O.cmpDistToRational(o, TOL_RAT[0], TOL_RAT[1]) <= 0) return 'clearance≤tol';
    return o.category === 'clearance' ? 'clearance>tol' : 'separate';
  }
  return o.category;
}
function evaluate(js, fx, opts) {
  const o = O.classifyPair(fx.a, fx.b, opts);
  const e = runEngine(js, fx.a, fx.b);
  const overlap = o.category === 'crossing' || o.category === 'contained';
  const touch = overlap || o.category === 'contact';
  const exactD = touch ? 0 : o.distance;
  const out = {
    name: fx.name, truth: o.category, bucket: truthBucket(o), exactDistM: exactD, certificate: o.certificate,
    closed: [o.closedA, o.closedB],
    engine: { rawHit: e.rawHit, kernelHit: e.kernelHit, dist: e.dist, pen: e.pen, appDepthM: e.appDepthM, overlapVol: e.overlapVol, nan: e.nan, nanRaw: e.nanRaw, rawPts: e.rawPts },
    outcomes: {}, disagree: [],
  };
  for (const [k, rules] of [['default', RULES_DEFAULT], ['hardOnly', RULES_HARD], ['clearance50', RULES_CLEAR]]) {
    out.outcomes[k] = { engine: engineOutcome(e, rules), truth: truthOutcome(o, rules) };
  }
  const engHard = engineOutcome(e, RULES_HARD) === 'hard';
  if (engHard !== overlap) out.disagree.push('hard');
  if (out.outcomes.default.engine !== out.outcomes.default.truth) out.disagree.push('final');
  out.distErrM = Number.isFinite(e.dist) ? Math.abs(e.dist - exactD) : Infinity;
  if (!(out.distErrM <= DIST_EPS_M)) out.disagree.push('distance');
  if (e.nan) out.disagree.push('nan');
  if (fx.mtd != null) out.penErrM = e.appDepthM == null ? null : Math.abs(e.appDepthM - fx.mtd);
  if (fx.mtd != null) out.mtdM = fx.mtd;
  if (fx.intendedDist != null) out.representationErrM = Math.abs(o.distance - fx.intendedDist);
  return { o, e, row: out };
}
function confusion(rows, key) {
  const m = {};
  for (const c of CATS) m[c] = { hard: 0, soft: 0, none: 0 };
  for (const r of rows) m[r.bucket][r.outcomes[key].engine]++;
  return m;
}
function prf(rows, isTruth, isEngine) {
  let tp = 0, fp = 0, fn = 0;
  for (const r of rows) { const t = isTruth(r), e = isEngine(r); if (t && e) tp++; else if (e) fp++; else if (t) fn++; }
  return { tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : 1, recall: tp + fn ? tp / (tp + fn) : 1 };
}
function summarize(rows) {
  const hardE = (r) => r.outcomes.hardOnly.engine === 'hard';
  const kernelE = (r) => r.engine.kernelHit;
  const overlapT = (r) => r.truth === 'crossing' || r.truth === 'contained';
  const inclT = (r) => overlapT(r) || r.truth === 'contact';
  const crossT = (r) => r.truth === 'crossing';
  const softT = (r) => r.outcomes.clearance50.truth === 'soft';
  const softE = (r) => r.outcomes.clearance50.engine === 'soft';
  const dErr = rows.filter((r) => Number.isFinite(r.distErrM)).map((r) => r.distErrM);
  return {
    n: rows.length,
    hard_vs_overlap: prf(rows, overlapT, hardE),
    hard_vs_crossing_contact_contained: prf(rows, inclT, hardE),
    hard_vs_crossing_only: prf(rows, crossT, hardE),
    kernel_vs_overlap: prf(rows, overlapT, kernelE),
    soft_within_50mm_clearanceRun: prf(rows, softT, softE),
    default_run_exact_match: rows.filter((r) => r.outcomes.default.engine === r.outcomes.default.truth).length,
    distance_error_m: { max: dErr.length ? Math.max(...dErr) : 0, mean: dErr.length ? dErr.reduce((s, v) => s + v, 0) / dErr.length : 0, over1um: rows.filter((r) => !(r.distErrM <= DIST_EPS_M)).length },
    nan_outputs: rows.filter((r) => r.engine.nan).length,
    nan_in_raw_kernel_points: rows.filter((r) => r.engine.nanRaw).length,
    confusion_default: confusion(rows, 'default'),
  };
}
function printSummary(label, s) {
  const f = (x) => `P=${x.precision.toFixed(3)} R=${x.recall.toFixed(3)} (tp ${x.tp} fp ${x.fp} fn ${x.fn})`;
  console.log(`\n=== ${label}: ${s.n} pairs ===`);
  console.log(`  HARD vs crossing∪contained            ${f(s.hard_vs_overlap)}`);
  console.log(`  HARD vs crossing∪contact∪contained    ${f(s.hard_vs_crossing_contact_contained)}`);
  console.log(`  HARD vs crossing only                 ${f(s.hard_vs_crossing_only)}`);
  console.log(`  kernel hit vs crossing∪contained      ${f(s.kernel_vs_overlap)}`);
  console.log(`  SOFT (clearance-only run, ≤50 mm)     ${f(s.soft_within_50mm_clearanceRun)}`);
  console.log(`  default run exact outcome match       ${s.default_run_exact_match}/${s.n}`);
  console.log(`  distance error  max ${s.distance_error_m.max.toExponential(3)} m  mean ${s.distance_error_m.mean.toExponential(3)} m  >1µm: ${s.distance_error_m.over1um}`);
  console.log(`  NaN outputs     ${s.nan_outputs} user-visible, ${s.nan_in_raw_kernel_points} pairs with NaN raw tri-tri points (dropped by the box filter)`);
  console.log('  default-run confusion (truth row × engine column):');
  console.log('    ' + 'truth'.padEnd(16) + 'hard'.padStart(7) + 'soft'.padStart(7) + 'none'.padStart(7));
  for (const c of CATS) { const m = s.confusion_default[c]; if (m.hard + m.soft + m.none) console.log('    ' + c.padEnd(16) + String(m.hard).padStart(7) + String(m.soft).padStart(7) + String(m.none).padStart(7)); }
}

const REPORT = { generatedAt: null, tolerance_m: TOL_M, analytic: [], random: [], summaries: {}, knownDiscrepancyStatus: {} };
function writeReport() {
  const p = process.env.CC_ORACLE_REPORT || path.join(os.tmpdir(), 'cc-engine-oracle-report.json');
  REPORT.generatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(REPORT, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
  console.log('\noracle report written to ' + p);
}

// ════════════════════════════════════════════════════════════════════════════
test('oracle self-consistency: designed categories, exact distances, symmetry, invariances', () => {
  const fixtures = analyticFixtures();
  for (const fx of fixtures) {
    const o = O.classifyPair(fx.a, fx.b);
    assert.strictEqual(o.category, fx.expect, `${fx.name}: oracle says ${o.category}, fixture designed as ${fx.expect}`);
    if (fx.dist != null) assert.strictEqual(o.distance, fx.dist, `${fx.name}: exact distance ${o.distance} != analytic ${fx.dist}`);
    const r = O.classifyPair(fx.b, fx.a);
    assert.strictEqual(r.category, o.category, `${fx.name}: asymmetric category`);
    assert.strictEqual(r.distance, o.distance, `${fx.name}: asymmetric distance`);
    // exact transforms: scale by 2, axis cycle, mirror x
    const xf = (t, fn) => { const o2 = new Float64Array(t.length); for (let i = 0; i < t.length; i += 3) fn(t, i, o2); return o2; };
    const s2 = (t) => xf(t, (s, i, d) => { d[i] = s[i] * 2; d[i + 1] = s[i + 1] * 2; d[i + 2] = s[i + 2] * 2; });
    const cyc = (t) => xf(t, (s, i, d) => { d[i] = s[i + 1]; d[i + 1] = s[i + 2]; d[i + 2] = s[i]; });
    const mir = (t) => xf(t, (s, i, d) => { d[i] = -s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; });
    const os2 = O.classifyPair(s2(fx.a), s2(fx.b), { clearanceWindow: 0.2 });
    assert.strictEqual(os2.category === 'separate' ? 'clearance' : os2.category, o.category === 'separate' ? 'clearance' : o.category, `${fx.name}: scale-by-2 changed category`);
    assert.strictEqual(os2.distance, o.distance * 2, `${fx.name}: scale-by-2 distance`);
    assert.strictEqual(O.classifyPair(cyc(fx.a), cyc(fx.b)).category, o.category, `${fx.name}: axis-cycle changed category`);
    assert.strictEqual(O.classifyPair(mir(fx.a), mir(fx.b)).category, o.category, `${fx.name}: mirror changed category`);
    if (o.category === 'clearance' || o.category === 'separate') {
      const np = O.classifyPair(fx.a, fx.b, { noPrune: true });
      assert.strictEqual(np.distance, o.distance, `${fx.name}: pruned and unpruned exact distance differ`);
    }
  }
});

test('oracle float filters agree with pure BigInt evaluation', () => {
  const fixtures = analyticFixtures();
  const withF = fixtures.map((fx) => O.classifyPair(fx.a, fx.b));
  O.setFloatFilter(false);
  try {
    fixtures.forEach((fx, i) => {
      const o = O.classifyPair(fx.a, fx.b);
      assert.strictEqual(o.category, withF[i].category, `${fx.name}: filter on/off category differs`);
      assert.strictEqual(o.distance, withF[i].distance, `${fx.name}: filter on/off distance differs`);
    });
  } finally { O.setFloatFilter(true); }
});

test('oracle vs closed-form truth on seeded random dyadic AABB pairs', () => {
  const pairs = randomAabbPairs(20261022, 150);
  for (const p of pairs) {
    const o = O.classifyPair(p.a, p.b, { clearanceWindow: Infinity });
    assert.strictEqual(o.category, p.truth, `${p.name}: oracle ${o.category} vs closed form ${p.truth}`);
    if (p.truth === 'clearance') assert.strictEqual(o.distance, Math.sqrt(p.gap2), `${p.name}: distance`);
  }
});

test('engine vs exact oracle: analytic fixtures (strict outside the known-discrepancy table)', () => {
  const js = loadEngine();
  const rows = [];
  const unexpected = [], fixed = [];
  for (const fx of analyticFixtures()) {
    const { row } = evaluate(js, fx);
    rows.push(row);
    const known = new Set(KNOWN_DISCREPANCIES[fx.name] || []);
    for (const d of row.disagree) if (!known.has(d)) unexpected.push(`${fx.name}: ${d}`);
    for (const k of known) if (!row.disagree.includes(k)) fixed.push(`${fx.name}: ${k}`);
    REPORT.knownDiscrepancyStatus[fx.name] = { known: [...known], measured: row.disagree };
  }
  REPORT.analytic = rows;
  REPORT.summaries.analytic = summarize(rows);
  printSummary('ANALYTIC fixtures', REPORT.summaries.analytic);
  console.log('\n  per-fixture (truth | exact d | engine kernel/dist/pen | default-run truth→engine | disagreements):');
  for (const r of rows) {
    console.log('   ' + r.name.padEnd(36) + r.truth.padEnd(10) + String(+r.exactDistM.toPrecision(6)).padEnd(12) +
      (r.engine.kernelHit ? 'HIT ' : 'miss') + ' d=' + String(+Number(r.engine.dist).toPrecision(6)).padEnd(11) +
      ' pen=' + String(r.engine.pen == null ? '-' : typeof r.engine.pen === 'number' ? +r.engine.pen.toPrecision(4) : r.engine.pen).padEnd(9) +
      (r.outcomes.default.truth + '→' + r.outcomes.default.engine).padEnd(11) + (r.disagree.join(',') || 'ok') +
      (r.mtdM != null ? `  [MTD ${r.mtdM} m, app depth ${r.engine.appDepthM} m (${typeof r.engine.pen === 'number' ? 'estimator' : 'fallback'}), err ${r.penErrM == null ? 'n/a' : r.penErrM.toFixed(4)} m]` : '') +
      (r.representationErrM != null ? `  [Float32 representation err ${(r.representationErrM * 1000).toFixed(3)} mm]` : ''));
  }
  if (fixed.length) console.log('\n  NOW AGREEING (remove from KNOWN_DISCREPANCIES):\n   ' + fixed.join('\n   '));
  if (unexpected.length) console.log('\n  UNEXPECTED disagreements (not in KNOWN_DISCREPANCIES):\n   ' + unexpected.join('\n   '));
  writeReport();
  assert.deepStrictEqual(unexpected, [], 'engine disagrees with ground truth on fixtures not listed in KNOWN_DISCREPANCIES');
});

test('engine vs exact oracle: seeded random mesh pairs (recorded, not asserted)', () => {
  const js = loadEngine();
  const n = +(process.env.CC_ORACLE_RANDOM || 300);
  const rows = [];
  for (const fx of [...randomPairs(7, n), ...randomAabbPairs(99, Math.round(n / 2))]) {
    const ev = evaluate(js, fx);
    rows.push(ev.row);
    // oracle self-consistency on every random pair: symmetric verdict
    const back = O.classifyPair(fx.b, fx.a);
    assert.strictEqual(back.category, ev.o.category, `${fx.name}: oracle asymmetric`);
    assert.strictEqual(back.distance, ev.o.distance, `${fx.name}: oracle asymmetric distance`);
  }
  REPORT.random = rows.filter((r) => r.disagree.length);
  REPORT.summaries.random = summarize(rows);
  printSummary('RANDOM pairs (seeded)', REPORT.summaries.random);
  const dis = rows.filter((r) => r.disagree.length);
  if (dis.length) {
    console.log(`\n  ${dis.length} random pairs disagree (first 15):`);
    for (const r of dis.slice(0, 15)) console.log(`   ${r.name.padEnd(16)} truth=${r.truth.padEnd(10)} d=${(+r.exactDistM.toPrecision(6))} engine kernel=${r.engine.kernelHit} d=${+Number(r.engine.dist).toPrecision(6)} -> ${r.disagree.join(',')}`);
  }
  writeReport();
  assert.ok(rows.length > 0);
});
