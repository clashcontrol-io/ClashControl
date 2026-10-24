'use strict';
// Why the tri-tri kernel has no exact (orient3d) predicates — and the bound
// that keeps that true.
//
// _triTriTest decides near-degenerate cases (a vertex, an edge or a whole
// triangle near the other's plane, a vertex near an edge) with its 1 µm plane
// snap, not exactly. Against the exact BigInt oracle (tests/_oracle-exact.js
// triTri, "proper" = non-coplanar, positive-length intersection) it therefore
// disagrees on many such pairs — but every disagreement is geometrically
// below 1 µm: a reported hit is never more than 1 µm apart in truth, and a
// missed crossing is never more than 1 µm deep. The pair decision works at the
// 0.1 mm contact tolerance (tau) and the oracle scores reported distances below
// 0.1 mm as 0, so no verdict or reported distance can move with exact
// predicates; they would only add cost (measured on 120k fuzzed pairs incl.
// slivers: all disagreements < 15 µm, none asymmetric). This test pins the
// bound and the argument-order symmetry on seeded fuzz far from and near the
// engine origin.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const O = require('./_oracle-exact.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const s = src.indexOf('var _ttIvalA = new Float64Array(8)'), e = src.indexOf('function _flushGeoCache(models)');
assert.ok(s !== -1 && e > s, 'kernel extraction markers not found');
const js = new Function('window', '_DETECT_CHUNK_SIZE', '_getWorldTris', '_getWorldVerts', '_ccFrameBox',
  src.slice(s, e) + '; return {_triTriTest};')({ _ccSafetyMigrations: null }, 80, null, null, null);

function exact(a, b) {
  const A = O.prepareMesh(a, { assumeClosed: false }), B = O.prepareMesh(b, { assumeClosed: false });
  const S = Math.max(A.S, B.S); O._internals.bigOf(A, S); O._internals.bigOf(B, S);
  const r = O._internals.triTri(A, 0, B, 0);
  return !!(r && !r.coplanar && !r.zeroLen);
}
function exactDist(a, b) {
  const r = O.classifyPair(a, b, { assumeClosedA: false, assumeClosedB: false });
  return r.distSq ? Math.sqrt(O.ratToDouble(r.distSq[0], r.distSq[1])) * Math.pow(2, -r.scaleExp) : 0;
}
// straddle depth of P w.r.t. the plane of T (min of the two sides' extents)
function straddle(T, P) {
  const u = [T[3] - T[0], T[4] - T[1], T[5] - T[2]], w = [T[6] - T[0], T[7] - T[1], T[8] - T[2]];
  const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], L = Math.hypot(...n);
  const d = [0, 1, 2].map((k) => (n[0] * (P[k * 3] - T[0]) + n[1] * (P[k * 3 + 1] - T[1]) + n[2] * (P[k * 3 + 2] - T[2])) / L);
  return Math.min(Math.max(...d), -Math.min(...d));
}

test('tri-tri kernel vs exact: disagreements stay below 1 µm and the verdict is symmetric', () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
  const N = 300;
  let disagree = 0, worstFp = 0, worstFn = 0;
  for (const C of [0, 50, 500]) for (let kind = 0; kind < 4; kind++) for (let i = 0; i < N; i++) {
    const c = [C + rnd() * 2, C + rnd(), rnd() * 3];
    const B = new Float32Array(9);
    for (let k = 0; k < 9; k++) B[k] = c[k % 3] + (rnd() - 0.5) * 1.5;
    const u = [B[3] - B[0], B[4] - B[1], B[5] - B[2]], w = [B[6] - B[0], B[7] - B[1], B[8] - B[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]; const L = Math.hypot(...n); n = n.map((x) => x / L);
    const delta = () => (rnd() < 0.5 ? -1 : 1) * Math.pow(10, -3 - rnd() * 8); // 1 mm .. 10 pm
    const inPlane = () => { const p = rnd(), q = rnd() * (1 - p); return [0, 1, 2].map((k) => B[k] + u[k] * p + w[k] * q); };
    const off = (p, d) => p.map((x, k) => x + n[k] * d);
    let a;
    if (kind === 0) a = [...off(inPlane(), delta()), ...off(inPlane(), (rnd() - 0.5) * 0.6), ...off(inPlane(), (rnd() - 0.5) * 0.6)];
    else if (kind === 1) a = [...off(inPlane(), delta()), ...off(inPlane(), delta()), ...off(inPlane(), delta())];
    else if (kind === 2) a = [...off(inPlane(), delta()), ...off(inPlane(), delta()), ...off(inPlane(), (rnd() - 0.5) * 0.6)];
    else { const t = rnd(); a = [...[0, 1, 2].map((k) => B[k] + u[k] * t + (rnd() - 0.5) * Math.pow(10, -3 - rnd() * 8)), ...off(inPlane(), (rnd() - 0.5) * 0.6), ...off(inPlane(), (rnd() - 0.5) * 0.6)]; }
    const A = Float32Array.from(a);
    const k1 = !!js._triTriTest(A, 0, B, 0), k2 = !!js._triTriTest(B, 0, A, 0);
    assert.strictEqual(k1, k2, `argument order changed the verdict (C=${C} kind=${kind} #${i})`);
    const ex = exact(A, B);
    if (k1 === ex) continue;
    disagree++;
    if (k1) worstFp = Math.max(worstFp, exactDist(A, B));
    else worstFn = Math.max(worstFn, Math.max(0, Math.min(straddle(B, A), straddle(A, B))));
  }
  assert.ok(disagree > 0, 'the fuzz must reach the near-degenerate cases');
  assert.ok(worstFp < 1e-6, `a kernel hit ${worstFp} m apart in truth`);
  assert.ok(worstFn < 1e-6, `a missed crossing ${worstFn} m deep`);
});
