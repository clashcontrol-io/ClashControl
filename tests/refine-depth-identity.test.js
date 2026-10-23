'use strict';
// Penetration depth (_estimatePenetrationDepthM) now caches each mesh's
// projection extents on the box axes and on its own face axes
// (_ccOwnExtents), and _ccFaceAxes groups normals by a packed numeric key
// instead of an 'x,y,z' string. Both are pure speed changes: this suite runs
// the previous implementations (verbatim below) side by side with the
// current ones on many element pairs — boxes, rotated prisms, dense tubes,
// coincident/duplicate meshes, far-from-origin coordinates, repeated pairs
// (warm caches) — and asserts the depth and the axis lists are identical
// (Object.is, so even the sign of zero must match).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('  var _CC_CONTACT_TOL_REL');
const end = src.indexOf('  function _ccLineInterval(');
assert.ok(start !== -1 && end > start, 'refinement markers are stale');
const depthStart = src.indexOf('  function _ccProjExtent(');
const depthEnd = src.indexOf('  // Decide one candidate pair from the kernel answers');
assert.ok(depthStart !== -1 && depthEnd > depthStart, 'depth markers are stale');
const cur = new Function('_getWorldTris', src.slice(start, end) + src.slice(depthStart, depthEnd) +
  '; return { _ccMeshTopo, _ccFaceAxes, _estimatePenetrationDepthM };')((el) => el.tris);

// ── previous implementations (reference) ──
function refFaceAxes(topo) {
  const tris = topo.tris, n = (tris.length / 9) | 0, acc = new Map();
  for (let f = 0; f < n; f++) {
    const o = f * 9;
    const ux = tris[o+3]-tris[o], uy = tris[o+4]-tris[o+1], uz = tris[o+5]-tris[o+2];
    const wx = tris[o+6]-tris[o], wy = tris[o+7]-tris[o+1], wz = tris[o+8]-tris[o+2];
    let nx = uy*wz-uz*wy, ny = uz*wx-ux*wz, nz = ux*wy-uy*wx;
    const l = Math.sqrt(nx*nx+ny*ny+nz*nz);
    if (!(l > 0)) continue;
    nx /= l; ny /= l; nz /= l;
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    const s = (ax >= ay && ax >= az) ? nx : (ay >= az ? ny : nz);
    if (s < 0) { nx = -nx; ny = -ny; nz = -nz; }
    const k = Math.round(nx*1e5) + ',' + Math.round(ny*1e5) + ',' + Math.round(nz*1e5);
    const c = acc.get(k);
    if (c) c[3] += l; else acc.set(k, [nx, ny, nz, l]);
  }
  const list = Array.from(acc.values());
  list.sort((p, q) => q[3] - p[3]);
  return list.slice(0, 32);
}
function refDepth(tA, tB) {
  if (!tA.nv || !tB.nv) return null;
  const axes = [[1,0,0],[0,1,0],[0,0,1]].concat(refFaceAxes(tA), refFaceAxes(tB));
  const vA = tA.verts, vB = tB.verts; let best = Infinity;
  for (let a = 0; a < axes.length; a++) {
    const ux = axes[a][0], uy = axes[a][1], uz = axes[a][2];
    let mnA = Infinity, mxA = -Infinity, mnB = Infinity, mxB = -Infinity, i, d;
    for (i = 0; i < vA.length; i += 3) { d = ux*vA[i]+uy*vA[i+1]+uz*vA[i+2]; if (d < mnA) mnA = d; if (d > mxA) mxA = d; }
    for (i = 0; i < vB.length; i += 3) { d = ux*vB[i]+uy*vB[i+1]+uz*vB[i+2]; if (d < mnB) mnB = d; if (d > mxB) mxB = d; }
    const ov = Math.min(mxA - mnB, mxB - mnA);
    if (ov < best) best = ov;
  }
  return best > 0 ? best : 0;
}

function rng(seed) {
  let a = seed | 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// closed prism of an n-gon (radius r) along a random direction, ring every `step`
function prism(r, n, len, step, rnd, off) {
  const d = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5], dl = Math.hypot(...d); d.forEach((v, i) => { d[i] = v / dl; });
  const u = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = [d[1]*u[2]-d[2]*u[1], d[2]*u[0]-d[0]*u[2], d[0]*u[1]-d[1]*u[0]], l1 = Math.hypot(...e1); e1.forEach((v, i) => { e1[i] = v / l1; });
  const e2 = [d[1]*e1[2]-d[2]*e1[1], d[2]*e1[0]-d[0]*e1[2], d[0]*e1[1]-d[1]*e1[0]];
  const rings = Math.max(1, Math.ceil(len / step)), P = (ri, k) => {
    const a = 2 * Math.PI * k / n, c = Math.cos(a) * r, s = Math.sin(a) * r, z = len * ri / rings;
    return [0, 1, 2].map((j) => off[j] + c * e1[j] + s * e2[j] + z * d[j]);
  };
  const t = [];
  for (let ri = 0; ri < rings; ri++) for (let k = 0; k < n; k++) {
    const a = P(ri, k), b = P(ri, (k + 1) % n), c = P(ri + 1, (k + 1) % n), q = P(ri + 1, k);
    t.push(...a, ...b, ...c, ...a, ...c, ...q);
  }
  for (const ri of [0, rings]) for (let k = 1; k < n - 1; k++) t.push(...P(ri, 0), ...P(ri, k), ...P(ri, k + 1));
  return new Float32Array(t);
}

test('cached-extent depth and numeric-key face axes equal the previous implementations', () => {
  const rnd = rng(2026);
  const els = [];
  for (let i = 0; i < 40; i++) {
    const far = i % 7 === 0 ? 150000 : 0;
    const off = [far + rnd() * 2, rnd() * 2, rnd() * 2];
    const n = [3, 4, 6, 8, 32][i % 5], step = [0.05, 0.3, 5][i % 3];
    els.push({ tris: prism(0.05 + rnd() * 0.6, n, 0.5 + rnd() * 3, step, rnd, off) });
  }
  els.push({ tris: els[3].tris.slice() }); // exact duplicate geometry (own == other axes)
  els.push({ tris: new Float32Array(0) });
  let pairs = 0;
  for (let rep = 0; rep < 2; rep++) for (let a = 0; a < els.length; a++) for (let b = 0; b < els.length; b++) {
    if (a === b || (a + b + rep) % 3) continue;
    const got = cur._estimatePenetrationDepthM(els[a], els[b]);
    const want = refDepth(cur._ccMeshTopo(els[a]), cur._ccMeshTopo(els[b]));
    assert.ok(Object.is(got, want), `pair ${a}/${b} rep ${rep}: ${got} vs ${want}`);
    pairs++;
  }
  assert.ok(pairs > 300);
  for (const el of els) {
    const t = cur._ccMeshTopo(el);
    assert.deepStrictEqual(cur._ccFaceAxes(t), refFaceAxes(t));
  }
});
