// occlusion-core.js: the conservative CPU occlusion buffer behind the
// occlusionCulling flag (docs/OCCLUSION_CULLING.md). The property that
// matters is one-sided: whenever testRect() says "hidden", every point of
// the rect must really be covered by occluder geometry that is nearer than
// the candidate. Checked here against brute-force supersampling on random
// screen-space scenes, plus a few hand-built cases (seams, outlines, holes).
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../occlusion-core.js');
const { mulberry32 } = require('./fixtures/generate-office-ifc.js');

// Occluder from screen-space vertices [x,y,z, ...] (+ index).
function occluder(verts, index, opts) {
  opts = opts || {};
  const pos = new Float32Array(verts);
  const n = pos.length / 3;
  const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n), pv = new Uint8Array(n);
  for (let i = 0; i < n; i++) { px[i] = pos[i * 3]; py[i] = pos[i * 3 + 1]; pz[i] = pos[i * 3 + 2]; pv[i] = 1; }
  const triCount = (index ? index.length : n) / 3;
  return {
    px, py, pz, pv, index: index || null, first: 0, triCount, vertBase: 0,
    mate: core.buildAdjacency(pos, index || null, 0, triCount),
    cull: opts.cull || 0, m: opts.m != null ? opts.m : 1 / 16, dz: 0,
    _tris: Array.from({ length: triCount }, (_, t) => [0, 1, 2].map((j) => { const v = index ? index[t * 3 + j] : t * 3 + j; return [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]; })),
  };
}

// Regular grid mesh (shared vertices, 2 triangles per quad) on a depth plane.
function grid(x0, y0, x1, y1, nx, ny, z0, gx, gy, rot) {
  const verts = [], index = [];
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, c = Math.cos(rot || 0), s = Math.sin(rot || 0);
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
    const x = x0 + (x1 - x0) * i / nx, y = y0 + (y1 - y0) * j / ny;
    const rx = cx + (x - cx) * c - (y - cy) * s, ry = cy + (x - cx) * s + (y - cy) * c;
    verts.push(rx, ry, z0 + gx * (rx - cx) + gy * (ry - cy));
  }
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = j * (nx + 1) + i, b = a + 1, d = a + nx + 1, e = d + 1;
    index.push(a, b, e, a, e, d);
  }
  return { verts, index };
}

function inTri(p, t) {
  const [a, b, c] = t;
  const s1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const s2 = (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0]);
  const s3 = (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0]);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}
function depthAt(p, t) {
  const [a, b, c] = t;
  const A = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  const l1 = ((p[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (p[1] - a[1])) / A;
  const l2 = ((b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1])) / A;
  return a[2] + l1 * (b[2] - a[2]) + l2 * (c[2] - a[2]);
}
// nearest occluder depth at p over all (non-degenerate) triangles, Infinity if uncovered
function nearest(p, occs) {
  let best = Infinity;
  for (const o of occs) for (const t of o._tris) {
    const A = (t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[2][0] - t[0][0]) * (t[1][1] - t[0][1]);
    if (Math.abs(A) < 1e-9) continue;
    if (o.cull === 1 && A <= 0) continue;
    if (o.cull === 2 && A >= 0) continue;
    if (inTri(p, t)) { const d = depthAt(p, t); if (d < best) best = d; }
  }
  return best;
}

// Every supersample of a culled rect (clamped to screen) must be covered nearer.
function assertSound(buf, occs, rect, zmin, eps, W, H, step) {
  const x0 = Math.max(0, rect[0]), y0 = Math.max(0, rect[1]), x1 = Math.min(W, rect[2]), y1 = Math.min(H, rect[3]);
  for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
    const d = nearest([x, y], occs);
    assert.ok(d < zmin - eps * 0.5, `culled rect ${rect} z=${zmin} has uncovered/too-far sample at ${x},${y} (occluder depth ${d})`);
  }
}

test('adjacency pairs shared edges by position bits, not by index', () => {
  // two triangles forming a quad, vertices duplicated (flat-shaded export)
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]);
  const mate = core.buildAdjacency(pos, null, 0, 2);
  // edge 2 of tri 0 is (1,1)->(0,0); edge 0 of tri 1 is (0,0)->(1,1)
  assert.equal(mate[2], 3);
  assert.equal(mate[3], 2);
  assert.equal(mate[0], -1);
  assert.equal(mate[4], -1);
});

test('a quad split into two triangles covers its interior, diagonal seam included', () => {
  const W = 200, H = 100;
  const buf = core.createBuffer();
  buf.begin(W, H, 4);
  const g = grid(-10, -10, 210, 110, 1, 1, 0.5, 0, 0);
  buf.rasterizeOccluder(occluder(g.verts, g.index));
  buf.finalize();
  // a box straddling the diagonal, behind the quad
  assert.equal(buf.testRect(40, 20, 160, 80, 0.6, 1e-6), true);
  // in front of it
  assert.equal(buf.testRect(40, 20, 160, 80, 0.4, 1e-6), false);
});

test('two separate meshes that only abut never cover the seam between them', () => {
  const W = 200, H = 100;
  const buf = core.createBuffer();
  buf.begin(W, H, 4);
  const a = grid(-10, -10, 100, 110, 1, 1, 0.5, 0, 0);
  const b = grid(100, -10, 210, 110, 1, 1, 0.5, 0, 0);
  buf.rasterizeOccluder(occluder(a.verts, a.index));
  buf.rasterizeOccluder(occluder(b.verts, b.index));
  buf.finalize();
  assert.equal(buf.testRect(80, 20, 120, 80, 0.6, 1e-6), false, 'seam between two draws is not provably watertight');
  assert.equal(buf.testRect(20, 20, 80, 80, 0.6, 1e-6), true);
  assert.equal(buf.testRect(120, 20, 180, 80, 0.6, 1e-6), true);
});

test('a hole in an occluder (wall opening) is never covered', () => {
  const W = 200, H = 100;
  // frame around a hole [80,120]x[30,70]: 4 quads sharing the hole corners
  const v = [-10, -10, 0.5, 210, -10, 0.5, 210, 110, 0.5, -10, 110, 0.5, 80, 30, 0.5, 120, 30, 0.5, 120, 70, 0.5, 80, 70, 0.5];
  const idx = [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  const buf = core.createBuffer();
  buf.begin(W, H, 4);
  buf.rasterizeOccluder(occluder(v, idx));
  buf.finalize();
  assert.equal(buf.testRect(90, 40, 110, 60, 0.9, 1e-6), false);
  assert.equal(buf.testRect(70, 40, 90, 60, 0.9, 1e-6), false);
  assert.equal(buf.testRect(10, 10, 60, 90, 0.9, 1e-6), true);
});

test('back-face culled occluders contribute nothing', () => {
  const W = 100, H = 100;
  const g = grid(-10, -10, 110, 110, 2, 2, 0.5, 0, 0);
  const flipped = [];
  for (let i = 0; i < g.index.length; i += 3) flipped.push(g.index[i], g.index[i + 2], g.index[i + 1]);
  const buf = core.createBuffer();
  buf.begin(W, H, 4);
  buf.rasterizeOccluder(occluder(g.verts, flipped, { cull: 1 }));
  buf.finalize();
  assert.equal(buf.testRect(20, 20, 80, 80, 0.9, 1e-6), false);
  buf.begin(W, H, 4);
  buf.rasterizeOccluder(occluder(g.verts, g.index, { cull: 1 }));
  buf.finalize();
  assert.equal(buf.testRect(20, 20, 80, 80, 0.9, 1e-6), true);
});

test('random scenes: every rect reported hidden is really covered nearer (brute force)', () => {
  const rnd = mulberry32(20261007);
  const W = 160, H = 96;
  let culled = 0, tested = 0;
  for (let scene = 0; scene < 40; scene++) {
    const buf = core.createBuffer();
    const cell = 2 + Math.floor(rnd() * 6);
    buf.begin(W, H, cell);
    const occs = [];
    const nOcc = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < nOcc; i++) {
      const x0 = rnd() * W - 40, y0 = rnd() * H - 30;
      const g = grid(x0, y0, x0 + 30 + rnd() * 140, y0 + 20 + rnd() * 90, 1 + Math.floor(rnd() * 4), 1 + Math.floor(rnd() * 4),
        0.2 + rnd() * 0.6, (rnd() - 0.5) * 0.004, (rnd() - 0.5) * 0.004, (rnd() - 0.5) * 1.2);
      const o = occluder(g.verts, g.index, { cull: rnd() < 0.3 ? 1 : 0 });
      occs.push(o);
      buf.rasterizeOccluder(o);
    }
    // plus a random triangle soup occluder (mostly boundary edges)
    const soup = [];
    for (let i = 0; i < 6; i++) { const cx = rnd() * W, cy = rnd() * H, z = 0.3 + rnd() * 0.5; for (let j = 0; j < 3; j++) soup.push(cx + (rnd() - 0.5) * 80, cy + (rnd() - 0.5) * 80, z); }
    const so = occluder(soup, null);
    occs.push(so);
    buf.rasterizeOccluder(so);
    buf.finalize();
    for (let c = 0; c < 120; c++) {
      const x = rnd() * W - 10, y = rnd() * H - 10, w = 1 + rnd() * 50, h = 1 + rnd() * 40, z = 0.2 + rnd() * 0.9;
      const rect = [x, y, x + w, y + h];
      tested++;
      const hidden = buf.testRect(rect[0], rect[1], rect[2], rect[3], z, 1e-6);
      assert.equal(buf.hiddenSoFar(rect[0], rect[1], rect[2], rect[3], z, 1e-6), hidden, 'tile-max early test agrees with the pyramid test');
      if (hidden) {
        culled++;
        assertSound(buf, occs, rect, z, 1e-6, W, H, 0.37);
      }
    }
  }
  assert.ok(culled > tested * 0.05, `test is vacuous: only ${culled}/${tested} rects culled`);
});

test('projectViewBox: perspective rect contains the projected corners, depth is the nearest corner', () => {
  // three.js PerspectiveCamera(55, 2, 0.01, 10000).projectionMatrix
  const fov = 55 * Math.PI / 180, aspect = 2, n = 0.01, f = 10000;
  const t = 1 / Math.tan(fov / 2);
  const P = new Float64Array(16);
  P[0] = t / aspect; P[5] = t; P[10] = -(f + n) / (f - n); P[11] = -1; P[14] = -2 * f * n / (f - n);
  const W = 400, H = 200, out = new Float64Array(5);
  const box = [-1, -0.5, -12, 2, 1, -5];
  assert.equal(core.projectViewBox(P, true, W, H, box, out), true);
  for (const x of [box[0], box[3]]) for (const y of [box[1], box[4]]) for (const z of [box[2], box[5]]) {
    const w = -z, sx = (P[0] * x / w + 1) * 0.5 * W, sy = (P[5] * y / w + 1) * 0.5 * H, sz = (P[10] * z + P[14]) / w;
    assert.ok(sx >= out[0] - 1e-9 && sx <= out[2] + 1e-9 && sy >= out[1] - 1e-9 && sy <= out[3] + 1e-9);
    assert.ok(sz >= out[4] - 1e-12);
  }
  assert.equal(core.projectViewBox(P, true, W, H, [-1, -1, -5, 1, 1, 0.5], out), false, 'box through the camera is never culled');
});

// ── per-device verdict (runtime verification) ──
test('verdict key: GPU string, app version and core hash all separate verdicts', () => {
  const k = core.verdictKey('ANGLE (Vendor, GPU X)', '7.6.4');
  assert.match(k, /^gpu=ANGLE \(Vendor, GPU X\)\|app=7\.6\.4\|core=[0-9a-f]{8}$/);
  assert.notEqual(k, core.verdictKey('ANGLE (Vendor, GPU Y)', '7.6.4'));
  assert.notEqual(k, core.verdictKey('ANGLE (Vendor, GPU X)', '7.6.5'), 'a new app version must not reuse a verdict');
  assert.notEqual(k, core.verdictKey('ANGLE (Vendor, GPU X)', '7.6.4', 'deadbeef'), 'a changed core must not reuse a verdict');
  assert.equal(k, core.verdictKey('ANGLE  (Vendor,   GPU X) ', '7.6.4'), 'whitespace in the GPU string is normalised');
  assert.match(core.CORE_HASH, /^[0-9a-f]{8}$/);
});

test('verdict storage: round trip, only verified/refused count, malformed input is no verdict', () => {
  const k = core.verdictKey('gpu', '1.0.0');
  let raw = null;
  assert.equal(core.readVerdict(raw, k), null);
  raw = core.writeVerdict(raw, k, { state: 'refused', why: 'pixel-mismatch', at: 5 });
  assert.deepEqual(core.readVerdict(raw, k), { state: 'refused', why: 'pixel-mismatch', at: 5 });
  raw = core.writeVerdict(raw, k, { state: 'verified', why: '', at: 6 });
  assert.equal(core.readVerdict(raw, k).state, 'verified');
  assert.equal(core.readVerdict(raw, core.verdictKey('gpu', '1.0.1')), null, 'version bump -> pending again');
  assert.equal(core.readVerdict('{not json', k), null);
  assert.equal(core.readVerdict('[1,2]', k), null);
  assert.equal(core.readVerdict(JSON.stringify({ [k]: { state: 'pending' } }), k), null);
  assert.equal(core.readVerdict(JSON.stringify({ [k]: { state: 'verified', why: 3 } }), k).why, '');
});

test('verdict storage keeps only the newest entries', () => {
  let raw = null;
  for (let i = 0; i < 12; i++) raw = core.writeVerdict(raw, core.verdictKey('gpu' + i, '1'), { state: 'verified', at: i + 1 }, 8);
  const all = JSON.parse(raw);
  assert.equal(Object.keys(all).length, 8);
  assert.equal(core.readVerdict(raw, core.verdictKey('gpu0', '1')), null);
  assert.equal(core.readVerdict(raw, core.verdictKey('gpu11', '1')).state, 'verified');
});

test('firstDifference: exact comparison, any single change is found', () => {
  const a = new Float32Array([0, 1, 2, 3]), b = new Float32Array(a);
  assert.equal(core.firstDifference(a, b), -1);
  b[2] = 2.0000002; assert.equal(core.firstDifference(a, b), 2);
  assert.equal(core.firstDifference(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), 0);
  assert.equal(core.firstDifference(new Float32Array([NaN]), new Float32Array([NaN])), -1);
});
