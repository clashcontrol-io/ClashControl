'use strict';
// Exact clash oracle — the ground-truth measuring stick for the clash engine.
//
// INDEPENDENT of index.html: no BVH, no collect caps, no epsilons that can
// change an answer, no shared code with the engine. Every input coordinate
// (Float32 or Float64) is a dyadic rational, so a mesh pair is lifted to
// BigInt integers by one common power-of-two scale and every decision below
// is made in exact integer / rational arithmetic:
//
//   * orient3d / plane-side signs, segment-plane crossings, coplanar polygon
//     clipping, point-in-triangle, squared point-triangle and segment-segment
//     distances (rational), exact rational comparisons;
//   * point-in-closed-mesh by ray parity with an integer ray direction and
//     Simulation-of-Simplicity style symbolic perturbation of the query point
//     (q = p + e*v1 + e^2*v2 + ...), so a ray that grazes an edge or vertex
//     is resolved consistently instead of being double/zero counted; a ray
//     that is degenerate even after perturbation (parallel to an edge and
//     through it) is retried with the next direction.
//
// Floating point is used ONLY as a certified filter: a double evaluation is
// trusted when |value| exceeds an error bound 10^3..10^6 times larger than
// the forward-error bound of the expression; anything closer falls through to
// exact BigInt. Two other short-cuts are exact as well: triangle AABB
// disjointness (pure comparisons of the input doubles, no arithmetic) and, for
// the distance pass only, skipping a triangle pair whose (conservatively
// rounded-down) AABB gap already exceeds the exact running minimum. Every
// triangle pair is still visited (O(n*m) loop); set opts.noPrune to evaluate
// every pair's exact distance anyway — tests/engine-oracle.test.js checks the
// two agree.
//
// Categories for an element pair (A, B):
//   'crossing'  — interiors overlap and the surfaces meet (includes a solid
//                 inside another whose surfaces touch, and exact duplicates)
//   'contact'   — surfaces meet, interiors disjoint (flush faces, edge or
//                 vertex touch)
//   'contained' — one closed mesh strictly inside the other, surfaces apart
//   'clearance' — disjoint, exact min distance d > 0 and d <= clearanceWindow
//   'separate'  — disjoint, d > clearanceWindow
// An open (non-watertight) mesh has no interior: against it, 'crossing' means a
// transversal surface crossing or a vertex of it strictly inside the other
// (closed) mesh, and it can only be 'contained' in a closed mesh. Closed = a
// mod-2 cycle: every edge used an even number of times after the odd-use
// edges are split, exactly, at T-junction vertices lying on them.
//
// Completeness note (documented, not hidden): an overlap is certified by one
// of (1) a transversal triangle crossing in the relative interior of both
// triangles, (2) a vertex of one mesh strictly inside the other, (3) a
// symbolically perturbed sample next to an intersection segment/patch found
// inside both. For two closed solids whose interiors overlap but whose
// ENTIRE intersection curve runs exactly along non-flat edges of both meshes
// and has no vertex strictly inside the other, none of these fire and the
// pair would read 'contact'. No fixture in this repo is built that way.
//
// Zero-area triangles carry no surface and are ignored (counted in stats).

const PERT = [[3n, 11n, 29n], [17n, -5n, 7n], [-13n, 19n, 2n]]; // linearly independent
const RAYS = [
  [7919n, 3967n, 1031n], [-2741n, 6131n, 4513n], [5281n, -7477n, 2027n],
  [1009n, 1013n, -7907n], [4093n, -3001n, -5003n], [-6007n, -2111n, 3833n],
];
const FILTER = 1e-10;
// Float filters can be switched off (pure BigInt everywhere) to cross-check them.
let FILTER_ON = true;
function setFloatFilter(on) { FILTER_ON = !!on; }

function absB(x) { return x < 0n ? -x : x; }
function sgnB(x) { return x > 0n ? 1 : x < 0n ? -1 : 0; }
function gcdB(a, b) { a = absB(a); b = absB(b); while (b) { const t = a % b; a = b; b = t; } return a; }

function lsbExp(x) {
  if (!Number.isFinite(x)) throw new Error('oracle: non-finite coordinate ' + x);
  let k = 0, y = x;
  while (!Number.isInteger(y)) { y *= 2; k++; }
  return k;
}
function toBigScaled(x, S) {
  if (x === 0) return 0n;
  const k = lsbExp(x);
  if (k > S) throw new Error('oracle: scale too small');
  // x * 2^k is an integer-valued double: BigInt() of it is exact.
  return BigInt(x * Math.pow(2, k)) << BigInt(S - k);
}
// Exact-ish double of a rational n/d (BigInt), correctly scaled for huge values.
function ratToDouble(n, d) {
  if (n === 0n) return 0;
  const neg = (n < 0n) !== (d < 0n);
  let a = absB(n), b = absB(d);
  const la = a.toString(2).length, lb = b.toString(2).length;
  let shift = 64 - (la - lb); // make quotient ~2^64
  let q;
  if (shift >= 0) q = (a << BigInt(shift)) / b; else q = a / (b << BigInt(-shift));
  const v = Number(q) * Math.pow(2, -shift);
  return neg ? -v : v;
}

// ── Mesh preparation ────────────────────────────────────────────────────────
function prepareMesh(tris, opts) {
  if (tris && tris._oracleMesh) return tris;
  opts = opts || {};
  const nT = Math.floor(tris.length / 9);
  const key = new Map();
  const verts = [];
  const vexp = [];
  const vi = new Int32Array(nT * 3);
  let S = 0;
  for (let t = 0; t < nT; t++) {
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      const x = +tris[o], y = +tris[o + 1], z = +tris[o + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error('oracle: non-finite vertex');
      const kk = (x === 0 ? 0 : x) + ',' + (y === 0 ? 0 : y) + ',' + (z === 0 ? 0 : z);
      let idx = key.get(kk);
      if (idx === undefined) {
        idx = verts.length / 3;
        verts.push(x === 0 ? 0 : x, y === 0 ? 0 : y, z === 0 ? 0 : z);
        const e = Math.max(lsbExp(x), lsbExp(y), lsbExp(z));
        vexp.push(e);
        if (e > S) S = e;
        key.set(kk, idx);
      }
      vi[t * 3 + k] = idx;
    }
  }
  // Edge-manifold closedness: every undirected edge used exactly twice.
  const edges = new Map();
  for (let t = 0; t < nT; t++) {
    const a = vi[t * 3], b = vi[t * 3 + 1], c = vi[t * 3 + 2];
    if (a === b || b === c || a === c) continue;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const ek = p < q ? p * 4294967296 + q : q * 4294967296 + p;
      edges.set(ek, (edges.get(ek) || 0) + 1);
    }
  }
  let edgeManifold = nT > 0;
  for (const c of edges.values()) if (c !== 2) { edgeManifold = false; break; }
  // Mod-2 cycle (exactly when ray parity is defined): every edge used an even
  // number of times once each odd-use edge is split, in exact arithmetic, at
  // the odd-use edge endpoints lying on it (T-junctions).
  let mod2Closed = edgeManifold;
  if (!edgeManifold && nT > 0) {
    const odd = [];
    for (const [ek, c] of edges) if (c & 1) odd.push([Math.floor(ek / 4294967296), ek % 4294967296]);
    const big = (i) => [0, 1, 2].map((a) => toBigScaled(verts[i * 3 + a], S));
    const ends = [...new Set(odd.flat())], B = new Map(ends.map((i) => [i, big(i)]));
    const sub = new Map();
    for (const [p, q] of odd) {
      const P = B.get(p), Q = B.get(q), d = [Q[0] - P[0], Q[1] - P[1], Q[2] - P[2]];
      const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      const on = [];
      for (const r of ends) {
        if (r === p || r === q) continue;
        const R = B.get(r), w = [R[0] - P[0], R[1] - P[1], R[2] - P[2]];
        if (d[1] * w[2] - d[2] * w[1] !== 0n || d[2] * w[0] - d[0] * w[2] !== 0n || d[0] * w[1] - d[1] * w[0] !== 0n) continue;
        const t = d[0] * w[0] + d[1] * w[1] + d[2] * w[2];
        if (t > 0n && t < dd) on.push([t, r]);
      }
      on.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
      const chain = [p, ...on.map((x) => x[1]), q];
      for (let k = 0; k + 1 < chain.length; k++) {
        const a = chain[k], b = chain[k + 1], sk = a < b ? a + ',' + b : b + ',' + a;
        sub.set(sk, (sub.get(sk) || 0) ^ 1);
      }
    }
    mod2Closed = true;
    for (const v of sub.values()) if (v) { mod2Closed = false; break; }
  }
  const V = new Float64Array(verts);
  const bb = new Float64Array(nT * 6);
  for (let t = 0; t < nT; t++) {
    let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    for (let k = 0; k < 3; k++) {
      const i = vi[t * 3 + k] * 3;
      const x = V[i], y = V[i + 1], z = V[i + 2];
      if (x < mnx) mnx = x; if (x > mxx) mxx = x;
      if (y < mny) mny = y; if (y > mxy) mxy = y;
      if (z < mnz) mnz = z; if (z > mxz) mxz = z;
    }
    bb.set([mnx, mny, mnz, mxx, mxy, mxz], t * 6);
  }
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < V.length; i += 3) for (let a = 0; a < 3; a++) {
    if (V[i + a] < mn[a]) mn[a] = V[i + a];
    if (V[i + a] > mx[a]) mx[a] = V[i + a];
  }
  return {
    _oracleMesh: true, nT, nV: V.length / 3, V, vexp, vi, S, bb, box: { mn, mx },
    edgeManifold, mod2Closed, closed: opts.assumeClosed === true ? true : opts.assumeClosed === false ? false : mod2Closed,
    _big: null, _bigS: -1, _N: null, _deg: null,
  };
}
function bigOf(M, S) {
  if (M._bigS === S) return M._big;
  const B = new Array(M.V.length);
  for (let i = 0; i < M.nV; i++) {
    for (let a = 0; a < 3; a++) {
      const x = M.V[i * 3 + a];
      B[i * 3 + a] = x === 0 ? 0n : toBigScaled(x, S);
    }
  }
  M._big = B; M._bigS = S;
  // exact normals + degeneracy at this scale
  const N = new Array(M.nT * 3);
  const deg = new Uint8Array(M.nT);
  for (let t = 0; t < M.nT; t++) {
    const a = M.vi[t * 3] * 3, b = M.vi[t * 3 + 1] * 3, c = M.vi[t * 3 + 2] * 3;
    const ux = B[b] - B[a], uy = B[b + 1] - B[a + 1], uz = B[b + 2] - B[a + 2];
    const wx = B[c] - B[a], wy = B[c + 1] - B[a + 1], wz = B[c + 2] - B[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    N[t * 3] = nx; N[t * 3 + 1] = ny; N[t * 3 + 2] = nz;
    deg[t] = (nx === 0n && ny === 0n && nz === 0n) ? 1 : 0;
  }
  M._N = N; M._deg = deg;
  return B;
}

// ── Filtered predicates ─────────────────────────────────────────────────────
// sign of n_T · (p − a) where n_T = (b−a)×(c−a); p a vertex of mesh P.
function sideSignVV(M, t, P, ip) {
  const V = M.V, i0 = M.vi[t * 3] * 3, i1 = M.vi[t * 3 + 1] * 3, i2 = M.vi[t * 3 + 2] * 3;
  const ax = V[i0], ay = V[i0 + 1], az = V[i0 + 2];
  const ux = V[i1] - ax, uy = V[i1 + 1] - ay, uz = V[i1 + 2] - az;
  const wx = V[i2] - ax, wy = V[i2 + 1] - ay, wz = V[i2 + 2] - az;
  const pv = P.V, j = ip * 3;
  const px = pv[j] - ax, py = pv[j + 1] - ay, pz = pv[j + 2] - az;
  const v = (uy * wz - uz * wy) * px + (uz * wx - ux * wz) * py + (ux * wy - uy * wx) * pz;
  const perm = (Math.abs(uy * wz) + Math.abs(uz * wy)) * Math.abs(px) + (Math.abs(uz * wx) + Math.abs(ux * wz)) * Math.abs(py) +
    (Math.abs(ux * wy) + Math.abs(uy * wx)) * Math.abs(pz);
  const e = 1e-12 * perm;
  if (FILTER_ON && v > e) return 1;
  if (FILTER_ON && v < -e) return -1;
  return sgnB(sideExactVV(M, t, P, ip));
}
function sideExactVV(M, t, P, ip) {
  const B = M._big, PB = P._big, a = M.vi[t * 3] * 3, j = ip * 3;
  return M._N[t * 3] * (PB[j] - B[a]) + M._N[t * 3 + 1] * (PB[j + 1] - B[a + 1]) + M._N[t * 3 + 2] * (PB[j + 2] - B[a + 2]);
}

// Rational point {X,Y,Z,D}, D > 0.
function rp(X, Y, Z, D) {
  if (D < 0n) { X = -X; Y = -Y; Z = -Z; D = -D; }
  return { X, Y, Z, D };
}
function rpReduce(p) {
  let g = gcdB(gcdB(gcdB(p.X, p.Y), p.Z), p.D);
  if (g > 1n) return { X: p.X / g, Y: p.Y / g, Z: p.Z / g, D: p.D / g };
  return p;
}
function rpAvg(pts) {
  let X = 0n, Y = 0n, Z = 0n, D = 1n;
  for (const p of pts) {
    X = X * p.D + p.X * D; Y = Y * p.D + p.Y * D; Z = Z * p.D + p.Z * D; D = D * p.D;
    const r = rpReduce({ X, Y, Z, D }); X = r.X; Y = r.Y; Z = r.Z; D = r.D;
  }
  return rpReduce(rp(X, Y, Z, D * BigInt(pts.length)));
}
function rpEq(p, q) { return p.X * q.D === q.X * p.D && p.Y * q.D === q.Y * p.D && p.Z * q.D === q.Z * p.D; }
function vertRP(M, i) { const B = M._big; return { X: B[i * 3], Y: B[i * 3 + 1], Z: B[i * 3 + 2], D: 1n }; }

// sign of ((vj−vi) × (p − vi)) · n  for rational p (point-in-triangle in plane)
function edgeSideRP(B, i, j, n, p) {
  const ex = B[j] - B[i], ey = B[j + 1] - B[i + 1], ez = B[j + 2] - B[i + 2];
  const qx = p.X - B[i] * p.D, qy = p.Y - B[i + 1] * p.D, qz = p.Z - B[i + 2] * p.D;
  const cx = ey * qz - ez * qy, cy = ez * qx - ex * qz, cz = ex * qy - ey * qx;
  return sgnB(cx * n[0] + cy * n[1] + cz * n[2]);
}
function triIdx(M, t) { return [M.vi[t * 3] * 3, M.vi[t * 3 + 1] * 3, M.vi[t * 3 + 2] * 3]; }
function triN(M, t) { return [M._N[t * 3], M._N[t * 3 + 1], M._N[t * 3 + 2]]; }
function inRelint(M, t, p) {
  const [a, b, c] = triIdx(M, t), n = triN(M, t), B = M._big;
  return edgeSideRP(B, a, b, n, p) > 0 && edgeSideRP(B, b, c, n, p) > 0 && edgeSideRP(B, c, a, n, p) > 0;
}

// ── Exact triangle-triangle intersection ────────────────────────────────────
// Returns null if the CLOSED triangles are disjoint, else
// { coplanar, zeroLen, area, mid, proper }.
function triTri(A, t, Bm, u) {
  // plane of u vs vertices of t
  const s0 = sideSignVV(Bm, u, A, A.vi[t * 3]), s1 = sideSignVV(Bm, u, A, A.vi[t * 3 + 1]), s2 = sideSignVV(Bm, u, A, A.vi[t * 3 + 2]);
  if ((s0 > 0 && s1 > 0 && s2 > 0) || (s0 < 0 && s1 < 0 && s2 < 0)) return null;
  const r0 = sideSignVV(A, t, Bm, Bm.vi[u * 3]), r1 = sideSignVV(A, t, Bm, Bm.vi[u * 3 + 1]), r2 = sideSignVV(A, t, Bm, Bm.vi[u * 3 + 2]);
  if ((r0 > 0 && r1 > 0 && r2 > 0) || (r0 < 0 && r1 < 0 && r2 < 0)) return null;
  if (s0 === 0 && s1 === 0 && s2 === 0) return coplanarTriTri(A, t, Bm, u);
  // Non-coplanar. Exact plane values.
  const segT = planeCut(A, t, Bm, u);
  const segU = planeCut(Bm, u, A, t);
  const nT = triN(A, t), nU = triN(Bm, u);
  const Dx = nT[1] * nU[2] - nT[2] * nU[1], Dy = nT[2] * nU[0] - nT[0] * nU[2], Dz = nT[0] * nU[1] - nT[1] * nU[0];
  const par = (p) => [Dx * p.X + Dy * p.Y + Dz * p.Z, p.D];
  const lt = (a, b) => a[0] * b[1] < b[0] * a[1];
  function span(pts) {
    let lo = pts[0], hi = pts[0], plo = par(lo), phi = plo;
    for (let i = 1; i < pts.length; i++) {
      const pp = par(pts[i]);
      if (lt(pp, plo)) { lo = pts[i]; plo = pp; }
      if (lt(phi, pp)) { hi = pts[i]; phi = pp; }
    }
    return { lo, hi, plo, phi };
  }
  const a = span(segT), b = span(segU);
  // overlap of the two collinear spans: [max of lows, min of highs]
  const loP = lt(a.plo, b.plo) ? b.lo : a.lo, loV = lt(a.plo, b.plo) ? b.plo : a.plo;
  const hiP = lt(a.phi, b.phi) ? a.hi : b.hi, hiV = lt(a.phi, b.phi) ? a.phi : b.phi;
  if (lt(hiV, loV)) return null;
  const zeroLen = !lt(loV, hiV);
  const mid = zeroLen ? rpReduce(loP) : rpAvg([loP, hiP]);
  const proper = !zeroLen && inRelint(A, t, mid) && inRelint(Bm, u, mid);
  return { coplanar: false, zeroLen, area: false, mid, proper, nT, nU };
}
// Points of triangle t (mesh M) lying on the plane of triangle u (mesh Q).
function planeCut(M, t, Q, u) {
  const vals = [], pts = [];
  for (let k = 0; k < 3; k++) vals.push(sideExactVV(Q, u, M, M.vi[t * 3 + k]));
  const B = M._big;
  const out = [];
  for (let k = 0; k < 3; k++) {
    const i = M.vi[t * 3 + k] * 3;
    pts.push(i);
    if (vals[k] === 0n) out.push({ X: B[i], Y: B[i + 1], Z: B[i + 2], D: 1n });
  }
  for (let k = 0; k < 3; k++) {
    const l = (k + 1) % 3;
    const vk = vals[k], vl = vals[l];
    if ((vk > 0n && vl < 0n) || (vk < 0n && vl > 0n)) {
      const i = pts[k], j = pts[l];
      // p = (vl*Pk − vk*Pl)/(vl − vk)
      out.push(rpReduce(rp(vl * B[i] - vk * B[j], vl * B[i + 1] - vk * B[j + 1], vl * B[i + 2] - vk * B[j + 2], vl - vk)));
    }
  }
  return out;
}
function coplanarTriTri(A, t, Bm, u) {
  const n = triN(Bm, u);
  const BA = A._big, BB = Bm._big;
  let poly = triIdx(A, t).map((i) => ({ X: BA[i], Y: BA[i + 1], Z: BA[i + 2], D: 1n }));
  const [u0, u1, u2] = triIdx(Bm, u);
  for (const [i, j] of [[u0, u1], [u1, u2], [u2, u0]]) {
    if (!poly.length) break;
    const ex = BB[j] - BB[i], ey = BB[j + 1] - BB[i + 1], ez = BB[j + 2] - BB[i + 2];
    const sv = (p) => { // numerator of ((vj−vi)×(p−vi))·n, same sign as value
      const qx = p.X - BB[i] * p.D, qy = p.Y - BB[i + 1] * p.D, qz = p.Z - BB[i + 2] * p.D;
      return (ey * qz - ez * qy) * n[0] + (ez * qx - ex * qz) * n[1] + (ex * qy - ey * qx) * n[2];
    };
    const out = [];
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k], q = poly[(k + 1) % poly.length];
      const sp = sv(p), sq = sv(q);
      if (sp >= 0n) out.push(p);
      if ((sp > 0n && sq < 0n) || (sp < 0n && sq > 0n)) {
        // value(p) = sp/Dp ; new = (Sp*Q − Sq*P)/(Sp*Dq − Sq*Dp)
        out.push(rpReduce(rp(sp * q.X - sq * p.X, sp * q.Y - sq * p.Y, sp * q.Z - sq * p.Z, sp * q.D - sq * p.D)));
      }
    }
    poly = out;
  }
  if (!poly.length) return null;
  // dedupe
  const uniq = [];
  for (const p of poly) if (!uniq.some((q) => rpEq(p, q))) uniq.push(p);
  let area = false;
  if (uniq.length >= 3) {
    const p0 = uniq[0];
    for (let k = 1; k < uniq.length - 1 && !area; k++) {
      for (let l = k + 1; l < uniq.length && !area; l++) {
        const p1 = uniq[k], p2 = uniq[l];
        const ax = p1.X * p0.D - p0.X * p1.D, ay = p1.Y * p0.D - p0.Y * p1.D, az = p1.Z * p0.D - p0.Z * p1.D;
        const bx = p2.X * p0.D - p0.X * p2.D, by = p2.Y * p0.D - p0.Y * p2.D, bz = p2.Z * p0.D - p0.Z * p2.D;
        const c = (ay * bz - az * by) * n[0] + (az * bx - ax * bz) * n[1] + (ax * by - ay * bx) * n[2];
        if (c !== 0n) area = true;
      }
    }
  }
  const mid = rpAvg(uniq);
  return { coplanar: true, zeroLen: uniq.length === 1, area, mid, proper: false, nT: triN(A, t), nU: n };
}

// ── Point in closed mesh (ray parity + symbolic perturbation) ───────────────
// q = p + e*vs[0] + e^2*vs[1] + ...  (p rational, vs BigInt vectors)
// Returns true (inside) / false (outside). Throws if every ray is degenerate.
function lexSign(c0, coeffs) {
  if (c0 !== 0n) return sgnB(c0);
  for (const c of coeffs) if (c !== 0n) return sgnB(c);
  return 0;
}
function pointInMesh(M, p, vs, stats) {
  const B = M._big, V = M.V;
  // p is in scaled-integer units (x 2^S); the filter works in metres like M.V
  const pD = p.D << BigInt(M._bigS);
  const qd = [ratToDouble(p.X, pD), ratToDouble(p.Y, pD), ratToDouble(p.Z, pD)];
  const dq = Math.max(Math.abs(qd[0]), Math.abs(qd[1]), Math.abs(qd[2])) * Math.pow(2, -48) + 1e-300;
  for (let ri = 0; ri < RAYS.length; ri++) {
    const r = RAYS[ri], rd = [Number(r[0]), Number(r[1]), Number(r[2])];
    let count = 0, degenerate = false;
    for (let t = 0; t < M.nT && !degenerate; t++) {
      if (M._deg[t]) continue;
      const [ia, ib, ic] = triIdx(M, t);
      const n = triN(M, t);
      // n·r  (exact integer, small)
      const rn = n[0] * r[0] + n[1] * r[1] + n[2] * r[2];
      if (rn === 0n) continue; // ray parallel to plane; perturbed q is never on the plane
      // side of q: n·(q − a)
      let side;
      {
        const ax = V[ia], ay = V[ia + 1], az = V[ia + 2];
        const ux = V[ib] - ax, uy = V[ib + 1] - ay, uz = V[ib + 2] - az;
        const wx = V[ic] - ax, wy = V[ic + 1] - ay, wz = V[ic + 2] - az;
        const px = qd[0] - ax, py = qd[1] - ay, pz = qd[2] - az;
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
        const v = nx * px + ny * py + nz * pz;
        const anx = Math.abs(uy * wz) + Math.abs(uz * wy), any = Math.abs(uz * wx) + Math.abs(ux * wz), anz = Math.abs(ux * wy) + Math.abs(uy * wx);
        const perm = anx * (Math.abs(px) + dq) + any * (Math.abs(py) + dq) + anz * (Math.abs(pz) + dq);
        const e = FILTER * perm + (anx + any + anz) * dq * 2;
        if (FILTER_ON && v > e) side = 1; else if (FILTER_ON && v < -e) side = -1;
        else {
          stats && stats.exact++;
          const c0 = n[0] * (p.X - B[ia] * p.D) + n[1] * (p.Y - B[ia + 1] * p.D) + n[2] * (p.Z - B[ia + 2] * p.D);
          side = lexSign(c0, vs.map((w) => n[0] * w[0] + n[1] * w[1] + n[2] * w[2]));
          if (side === 0) { degenerate = true; break; }
        }
      }
      if (side === sgnB(rn)) continue; // moving away from the plane
      // line through q along r vs the three edges
      let s = 0, hit = true;
      for (const [i, j] of [[ia, ib], [ib, ic], [ic, ia]]) {
        // e = r·((a−q)×(b−q))
        let es;
        const ax = V[i] - qd[0], ay = V[i + 1] - qd[1], az = V[i + 2] - qd[2];
        const bx = V[j] - qd[0], by = V[j + 1] - qd[1], bz = V[j + 2] - qd[2];
        const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
        const v = rd[0] * cx + rd[1] * cy + rd[2] * cz;
        const aax = Math.abs(ax) + dq, aay = Math.abs(ay) + dq, aaz = Math.abs(az) + dq;
        const abx = Math.abs(bx) + dq, aby = Math.abs(by) + dq, abz = Math.abs(bz) + dq;
        const permI = Math.abs(rd[0]) * (aay * abz + aaz * aby) + Math.abs(rd[1]) * (aaz * abx + aax * abz) + Math.abs(rd[2]) * (aax * aby + aay * abx);
        const permN = Math.abs(rd[0]) * (Math.abs(ay * bz) + Math.abs(az * by)) + Math.abs(rd[1]) * (Math.abs(az * bx) + Math.abs(ax * bz)) + Math.abs(rd[2]) * (Math.abs(ax * by) + Math.abs(ay * bx));
        const e = FILTER * permI + (permI - permN) * 1.0001;
        if (FILTER_ON && v > e) es = 1; else if (FILTER_ON && v < -e) es = -1;
        else {
          stats && stats.exact++;
          // r·(a×b) + r·((b−a)×q)   (scaled by D for the rational part)
          const axb = [B[i + 1] * B[j + 2] - B[i + 2] * B[j + 1], B[i + 2] * B[j] - B[i] * B[j + 2], B[i] * B[j + 1] - B[i + 1] * B[j]];
          const ex = B[j] - B[i], ey = B[j + 1] - B[i + 1], ez = B[j + 2] - B[i + 2];
          const rxe = (w) => r[0] * (ey * w[2] - ez * w[1]) + r[1] * (ez * w[0] - ex * w[2]) + r[2] * (ex * w[1] - ey * w[0]);
          const c0 = p.D * (r[0] * axb[0] + r[1] * axb[1] + r[2] * axb[2]) + rxe([p.X, p.Y, p.Z]);
          es = lexSign(c0, vs.map(rxe));
          if (es === 0) { degenerate = true; break; }
        }
        if (s === 0) s = es; else if (es !== s) { hit = false; break; }
      }
      if (degenerate) break;
      if (hit) count++;
    }
    if (!degenerate) return (count & 1) === 1;
    if (stats) stats.rayRetries++;
  }
  throw new Error('oracle: every ray direction degenerate');
}

// Is vertex ip of mesh P exactly on the closed surface of M?
function vertexOnSurface(M, P, ip) {
  const pv = P.V, j = ip * 3;
  const x = pv[j], y = pv[j + 1], z = pv[j + 2];
  for (let t = 0; t < M.nT; t++) {
    if (M._deg[t]) continue;
    const o = t * 6, bb = M.bb;
    if (x < bb[o] || x > bb[o + 3] || y < bb[o + 1] || y > bb[o + 4] || z < bb[o + 2] || z > bb[o + 5]) continue;
    if (sideSignVV(M, t, P, ip) !== 0) continue;
    const p = vertRP(P, ip);
    const [a, b, c] = triIdx(M, t), n = triN(M, t);
    if (edgeSideRP(M._big, a, b, n, p) >= 0 && edgeSideRP(M._big, b, c, n, p) >= 0 && edgeSideRP(M._big, c, a, n, p) >= 0) return true;
  }
  return false;
}

// ── Exact squared distances (rationals [num, den], den > 0) ─────────────────
function rlt(a, b) { return a[0] * b[1] < b[0] * a[1]; }
function dot3(ax, ay, az, bx, by, bz) { return ax * bx + ay * by + az * bz; }
function ptSegSq(px, py, pz, ax, ay, az, bx, by, bz) {
  const ex = bx - ax, ey = by - ay, ez = bz - az;
  const wx = px - ax, wy = py - ay, wz = pz - az;
  const tn = dot3(wx, wy, wz, ex, ey, ez), td = dot3(ex, ey, ez, ex, ey, ez);
  if (td === 0n || tn <= 0n) return [dot3(wx, wy, wz, wx, wy, wz), 1n];
  if (tn >= td) { const vx = px - bx, vy = py - by, vz = pz - bz; return [dot3(vx, vy, vz, vx, vy, vz), 1n]; }
  return [dot3(wx, wy, wz, wx, wy, wz) * td - tn * tn, td];
}
function ptTriSq(px, py, pz, B, a, b, c, n) {
  let best = null;
  if (n[0] !== 0n || n[1] !== 0n || n[2] !== 0n) {
    const p = { X: px, Y: py, Z: pz, D: 1n };
    if (edgeSideRP(B, a, b, n, p) >= 0 && edgeSideRP(B, b, c, n, p) >= 0 && edgeSideRP(B, c, a, n, p) >= 0) {
      const h = n[0] * (px - B[a]) + n[1] * (py - B[a + 1]) + n[2] * (pz - B[a + 2]);
      return [h * h, n[0] * n[0] + n[1] * n[1] + n[2] * n[2]];
    }
  }
  for (const [i, j] of [[a, b], [b, c], [c, a]]) {
    const d = ptSegSq(px, py, pz, B[i], B[i + 1], B[i + 2], B[j], B[j + 1], B[j + 2]);
    if (!best || rlt(d, best)) best = d;
  }
  return best;
}
function segSegSq(B1, i1, j1, B2, i2, j2) {
  const p1x = B1[i1], p1y = B1[i1 + 1], p1z = B1[i1 + 2];
  const d1x = B1[j1] - p1x, d1y = B1[j1 + 1] - p1y, d1z = B1[j1 + 2] - p1z;
  const p2x = B2[i2], p2y = B2[i2 + 1], p2z = B2[i2 + 2];
  const d2x = B2[j2] - p2x, d2y = B2[j2 + 1] - p2y, d2z = B2[j2 + 2] - p2z;
  let best = ptSegSq(p1x, p1y, p1z, p2x, p2y, p2z, B2[j2], B2[j2 + 1], B2[j2 + 2]);
  const cand = [
    ptSegSq(B1[j1], B1[j1 + 1], B1[j1 + 2], p2x, p2y, p2z, B2[j2], B2[j2 + 1], B2[j2 + 2]),
    ptSegSq(p2x, p2y, p2z, p1x, p1y, p1z, B1[j1], B1[j1 + 1], B1[j1 + 2]),
    ptSegSq(B2[j2], B2[j2 + 1], B2[j2 + 2], p1x, p1y, p1z, B1[j1], B1[j1 + 1], B1[j1 + 2]),
  ];
  for (const c of cand) if (rlt(c, best)) best = c;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = dot3(d1x, d1y, d1z, d1x, d1y, d1z), e = dot3(d2x, d2y, d2z, d2x, d2y, d2z);
  const b = dot3(d1x, d1y, d1z, d2x, d2y, d2z), c = dot3(d1x, d1y, d1z, rx, ry, rz), f = dot3(d2x, d2y, d2z, rx, ry, rz);
  const den = a * e - b * b;
  if (den > 0n) {
    const sN = b * f - c * e, tN = a * f - b * c; // s = sN/den, t = tN/den
    if (sN > 0n && sN < den && tN > 0n && tN < den) {
      const wx = rx * den + sN * d1x - tN * d2x, wy = ry * den + sN * d1y - tN * d2y, wz = rz * den + sN * d1z - tN * d2z;
      const d = [wx * wx + wy * wy + wz * wz, den * den];
      if (rlt(d, best)) best = d;
    }
  }
  return best;
}
function triTriDistSq(A, t, Bm, u) {
  const BA = A._big, BB = Bm._big;
  const ta = triIdx(A, t), ub = triIdx(Bm, u), nA = triN(A, t), nB = triN(Bm, u);
  let best = null;
  const upd = (d) => { if (!best || rlt(d, best)) best = d; };
  for (const i of ta) upd(ptTriSq(BA[i], BA[i + 1], BA[i + 2], BB, ub[0], ub[1], ub[2], nB));
  for (const j of ub) upd(ptTriSq(BB[j], BB[j + 1], BB[j + 2], BA, ta[0], ta[1], ta[2], nA));
  for (const [i1, j1] of [[ta[0], ta[1]], [ta[1], ta[2]], [ta[2], ta[0]]]) {
    for (const [i2, j2] of [[ub[0], ub[1]], [ub[1], ub[2]], [ub[2], ub[0]]]) upd(segSegSq(BA, i1, j1, BB, i2, j2));
  }
  return best;
}

// Conservative (rounded-down) squared AABB gap between two triangles.
function aabbGapSqLB(A, t, Bm, u) {
  const a = A.bb, b = Bm.bb, o = t * 6, p = u * 6;
  let s = 0;
  for (let k = 0; k < 3; k++) {
    let g = 0;
    if (b[p + k] > a[o + 3 + k]) g = (b[p + k] - a[o + 3 + k]) - (Math.abs(b[p + k]) + Math.abs(a[o + 3 + k])) * 1e-15;
    else if (a[o + k] > b[p + 3 + k]) g = (a[o + k] - b[p + 3 + k]) - (Math.abs(a[o + k]) + Math.abs(b[p + 3 + k])) * 1e-15;
    if (g > 0) s += g * g;
  }
  return s * (1 - 1e-12);
}

// ── Classification ──────────────────────────────────────────────────────────
function classifyPair(trisA, trisB, opts) {
  opts = opts || {};
  const t0 = Date.now();
  const A = prepareMesh(trisA, { assumeClosed: opts.assumeClosedA !== undefined ? opts.assumeClosedA : opts.assumeClosed });
  const Bm = prepareMesh(trisB, { assumeClosed: opts.assumeClosedB !== undefined ? opts.assumeClosedB : opts.assumeClosed });
  const S = Math.max(A.S, Bm.S);
  bigOf(A, S); bigOf(Bm, S);
  const stats = { triPairsVisited: 0, triPairsAabb: 0, intersectingTriPairs: 0, exact: 0, rayRetries: 0, samples: 0, distPairsExact: 0, degA: 0, degB: 0 };
  for (let t = 0; t < A.nT; t++) if (A._deg[t]) stats.degA++;
  for (let u = 0; u < Bm.nT; u++) if (Bm._deg[u]) stats.degB++;
  const window = opts.clearanceWindow != null ? opts.clearanceWindow : 0.1;
  const res = {
    category: null, distance: null, distSq: null, touching: false, interiorOverlap: false, contained: null,
    certificate: null, closedA: A.closed, closedB: Bm.closed, edgeManifoldA: A.edgeManifold, edgeManifoldB: Bm.edgeManifold, stats,
  };
  // Pass 1: exact surface intersection over every triangle pair.
  const hits = [];
  let proper = false;
  for (let t = 0; t < A.nT; t++) {
    if (A._deg[t]) continue;
    const o = t * 6, a = A.bb;
    for (let u = 0; u < Bm.nT; u++) {
      stats.triPairsVisited++;
      if (Bm._deg[u]) continue;
      const p = u * 6, b = Bm.bb;
      if (a[o] > b[p + 3] || b[p] > a[o + 3] || a[o + 1] > b[p + 4] || b[p + 1] > a[o + 4] || a[o + 2] > b[p + 5] || b[p + 2] > a[o + 5]) continue;
      stats.triPairsAabb++;
      const h = triTri(A, t, Bm, u);
      if (!h) continue;
      stats.intersectingTriPairs++;
      if (h.proper) { proper = true; break; }
      hits.push(h);
    }
    if (proper) break;
  }
  const surfacesMeet = proper || stats.intersectingTriPairs > 0;
  if (surfacesMeet) {
    res.touching = true; res.distance = 0; res.distSq = [0n, 1n];
    if (proper) { res.interiorOverlap = true; res.certificate = 'proper-crossing'; }
    // vertex strictly inside the other (closed) mesh
    if (!res.interiorOverlap) {
      const v = vertexInside(A, Bm, stats) || vertexInside(Bm, A, stats);
      if (v) { res.interiorOverlap = true; res.certificate = 'vertex-inside'; }
    }
    if (!res.interiorOverlap && A.closed && Bm.closed) {
      const seen = new Set();
      outer: for (const h of hits) {
        for (const v of sampleDirs(h)) {
          const k = h.mid.X + ',' + h.mid.Y + ',' + h.mid.Z + ',' + h.mid.D + '|' + v.join(',');
          if (seen.has(k)) continue;
          seen.add(k);
          stats.samples++;
          const vs = [v, ...PERT];
          if (pointInMesh(A, h.mid, vs, stats) && pointInMesh(Bm, h.mid, vs, stats)) {
            res.interiorOverlap = true; res.certificate = 'sample'; break outer;
          }
        }
      }
    }
    res.category = res.interiorOverlap ? 'crossing' : 'contact';
  } else {
    // Disjoint surfaces: containment?
    if (Bm.closed && A.nV && insideBox(A, 0, Bm) && pointInMesh(Bm, vertRP(A, 0), PERT, stats)) res.contained = 'A_in_B';
    else if (A.closed && Bm.nV && insideBox(Bm, 0, A) && pointInMesh(A, vertRP(Bm, 0), PERT, stats)) res.contained = 'B_in_A';
    if (res.contained) {
      res.interiorOverlap = true; res.category = 'contained'; res.distance = 0; res.distSq = [0n, 1n];
    } else {
      const d = exactMinDistSq(A, Bm, opts.noPrune, stats);
      res.distSq = d;
      res.distance = Math.sqrt(ratToDouble(d[0], d[1] << BigInt(2 * S)));
      // exact comparison against the window: d^2 <= w^2  (w as exact double)
      const within = cmpDistSqToMetres(d, S, window) <= 0;
      res.category = within ? 'clearance' : 'separate';
    }
  }
  res.scaleExp = S;
  res.ms = Date.now() - t0;
  return res;
}
function insideBox(P, ip, M) {
  const x = P.V[ip * 3], y = P.V[ip * 3 + 1], z = P.V[ip * 3 + 2];
  return x >= M.box.mn[0] && x <= M.box.mx[0] && y >= M.box.mn[1] && y <= M.box.mx[1] && z >= M.box.mn[2] && z <= M.box.mx[2];
}
function vertexInside(P, M, stats) {
  if (!M.closed) return false;
  for (let i = 0; i < P.nV; i++) {
    if (!insideBox(P, i, M)) continue;
    if (vertexOnSurface(M, P, i)) continue;
    if (pointInMesh(M, vertRP(P, i), PERT, stats)) return true;
  }
  return false;
}
function sampleDirs(h) {
  if (h.coplanar) {
    const n = h.nU;
    return [n, [-n[0], -n[1], -n[2]]];
  }
  const nT = h.nT, nU = h.nU;
  const a = dot3(nT[0], nT[1], nT[2], nT[0], nT[1], nT[2]), b = dot3(nU[0], nU[1], nU[2], nU[0], nU[1], nU[2]);
  const c = dot3(nT[0], nT[1], nT[2], nU[0], nU[1], nU[2]);
  const out = [];
  for (const s1 of [1n, -1n]) for (const s2 of [1n, -1n]) {
    const al = b * s1 - c * s2, be = a * s2 - c * s1;
    out.push([al * nT[0] + be * nU[0], al * nT[1] + be * nU[1], al * nT[2] + be * nU[2]]);
  }
  return out;
}
function exactMinDistSq(A, Bm, noPrune, stats) {
  const order = [];
  for (let t = 0; t < A.nT; t++) {
    if (A._deg[t]) continue;
    for (let u = 0; u < Bm.nT; u++) {
      if (Bm._deg[u]) continue;
      order.push([aabbGapSqLB(A, t, Bm, u), t, u]);
    }
  }
  order.sort((x, y) => x[0] - y[0]);
  let best = null, bestD = Infinity;
  const den2S = (d) => d[1] << BigInt(2 * A._bigS);
  for (const [lb, t, u] of order) {
    if (!noPrune && best && lb > bestD * (1 + 1e-12)) break; // sorted: every later pair is farther
    stats.distPairsExact++;
    const d = triTriDistSq(A, t, Bm, u);
    if (!best || rlt(d, best)) { best = d; bestD = ratToDouble(d[0], den2S(d)); }
  }
  return best || [0n, 1n];
}
// compare exact d (squared, scaled by 2^2S) against a metre value w (double)
function cmpDistSqToMetres(d, S, w) {
  if (w === Infinity) return -1;
  // d0/d1 <=> (w*2^S)^2 ; w is a double -> exact BigInt rational
  const k = lsbExp(w);
  const W = BigInt(w * Math.pow(2, k)); // w = W / 2^k
  // d0/d1 vs W^2 * 2^(2S) / 2^(2k)
  const lhs = d[0] << BigInt(2 * k);
  const rhs = W * W * d[1] << BigInt(2 * S);
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}
// Exact comparison of the pair's min distance with a tolerance given as a
// rational number of metres {num, den} (e.g. 50 mm = 1/20): -1, 0, 1.
function cmpDistToRational(res, num, den) {
  if (!res.distSq) return -1;
  const S = res.scaleExp;
  const [a, b] = res.distSq; // dist^2 = a/b * 2^-2S
  // a/b * 2^-2S  vs  num^2/den^2  ->  a*den^2  vs  num^2*b*2^2S
  const lhs = a * BigInt(den) * BigInt(den), rhs = BigInt(num) * BigInt(num) * b << BigInt(2 * S);
  return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
}

module.exports = {
  classifyPair, prepareMesh, cmpDistToRational, ratToDouble, lsbExp, setFloatFilter,
  _internals: { pointInMesh, bigOf, vertRP, PERT, triTri, exactMinDistSq },
};
