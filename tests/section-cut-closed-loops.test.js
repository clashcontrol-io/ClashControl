'use strict';
// Exercises the real section-cut pipeline shipped in index.html
// (_cutElementAtPlane + _chainSegments) by extracting that exact source
// block and running it in a vm sandbox -- not a reimplementation, so a
// regression in the real code fails this test.
//
// Root-cause coverage: _cutElementAtPlane used to build "face boundary
// loops" by walking a crease-edge graph keyed on raw vertex-buffer
// *indices*. That broke on:
//   - non-indexed / duplicated-vertex geometry (web-ifc output is often
//     non-indexed), where every triangle edge looks "unshared" even when
//     two triangles are at the exact same world position;
//   - any vertex where more than 2 crease edges meet (every corner of a
//     box), where the greedy walk isn't a simple loop and breaks;
//   - a vertex sitting exactly on the cut plane, dropping/duplicating a
//     crossing.
// The fixed implementation intersects the cut plane per-triangle (a
// standard, index-independent technique) and relies on _chainSegments'
// position-keyed walk to weld the resulting segment soup into closed
// loops.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

function extractBlock(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start !== -1, `start marker not found: ${startMarker}`);
  const end = html.indexOf(endMarker, start);
  assert.ok(end !== -1, `end marker not found: ${endMarker}`);
  return html.slice(start, end);
}

function loadSectionCut() {
  const src = extractBlock(
    '  function _cutElementAtPlane(el, cutY) {',
    '  function generate2DOutlines(models, elevation, cutHeight, viewDepth) {'
  );
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'section-cut.js' });
  return sandbox.window;
}

// ---- Synthetic mesh helpers -------------------------------------------

const IDENTITY = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];

function makeMesh(triangles, opts) {
  opts = opts || {};
  const matrixEl = opts.matrix || IDENTITY;
  const flat = [];
  triangles.forEach(tri => tri.forEach(pt => flat.push(pt[0], pt[1], pt[2])));
  const nV = flat.length / 3;
  const position = {
    count: nV,
    getX: i => flat[i * 3],
    getY: i => flat[i * 3 + 1],
    getZ: i => flat[i * 3 + 2],
  };
  let index = null;
  if (opts.indexed) {
    // Weld identical positions into a shared index buffer (as a normal
    // indexed BufferGeometry would), so callers can pass the same
    // triangle-soup data and get an indexed mesh to test against.
    const map = new Map();
    const uniq = [];
    const idx = [];
    for (let i = 0; i < nV; i++) {
      const key = [flat[i*3], flat[i*3+1], flat[i*3+2]].join(',');
      let id = map.get(key);
      if (id === undefined) { id = uniq.length / 3; uniq.push(flat[i*3], flat[i*3+1], flat[i*3+2]); map.set(key, id); }
      idx.push(id);
    }
    index = { count: idx.length, getX: i => idx[i] };
    const uniqCount = uniq.length / 3;
    return {
      updateWorldMatrix() {},
      matrixWorld: { elements: matrixEl },
      geometry: {
        index,
        attributes: {
          position: {
            count: uniqCount,
            getX: i => uniq[i * 3],
            getY: i => uniq[i * 3 + 1],
            getZ: i => uniq[i * 3 + 2],
          },
        },
      },
    };
  }
  return {
    updateWorldMatrix() {},
    matrixWorld: { elements: matrixEl },
    geometry: { index: null, attributes: { position } },
  };
}

// Axis-aligned box [x0,x1] x [y0,y1] x [z0,z1] as 12 triangles (2 per face),
// non-indexed (each triangle owns its own 3 vertex instances) -- the shape
// that broke the old crease-walk the worst.
function boxTriangles(x0, x1, y0, y1, z0, z1) {
  const c = (x, y, z) => [x, y, z];
  const V = {
    '000': c(x0,y0,z0), '100': c(x1,y0,z0), '010': c(x0,y1,z0), '110': c(x1,y1,z0),
    '001': c(x0,y0,z1), '101': c(x1,y0,z1), '011': c(x0,y1,z1), '111': c(x1,y1,z1),
  };
  function quad(a, b, cc, d) { return [[V[a],V[b],V[cc]], [V[a],V[cc],V[d]]]; }
  const tris = [];
  tris.push(...quad('000','100','110','010')); // bottom (y0)
  tris.push(...quad('001','011','111','101')); // top (y1)
  tris.push(...quad('000','010','011','001')); // -x
  tris.push(...quad('100','101','111','110')); // +x
  tris.push(...quad('000','001','101','100')); // -z
  tris.push(...quad('010','110','111','011')); // +z
  return tris;
}

function rotateY(tris, rad) {
  const s = Math.sin(rad), c = Math.cos(rad);
  return tris.map(tri => tri.map(([x,y,z]) => [x*c + z*s, y, -x*s + z*c]));
}

function chainsAt(win, meshes, cutY, eps) {
  const el = { meshes };
  const segs = win._cutElementAtPlane(el, cutY);
  const chains = win._chainSegments(segs, eps);
  return { segs, chains };
}

function closedChains(chains) {
  return chains.filter(c => c.closed);
}

// Reduces a closed chain's point list to its geometric corners: collapses
// duplicate points and drops points that lie exactly on the straight line
// between their neighbours (e.g. a triangle-diagonal midpoint injected
// where a quad face was split into 2 triangles -- a real vertex in the
// segment soup, but not a "corner" of the polygon this test cares about).
function uniqueCorners(chain, eps) {
  const pts = chain.pts;
  const raw = [];
  for (let i = 0; i < pts.length - 2; i += 2) raw.push([pts[i], pts[i + 1]]);
  const dedup = [];
  for (const p of raw) {
    const last = dedup[dedup.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > eps * 4 || Math.abs(last[1] - p[1]) > eps * 4) dedup.push(p);
  }
  const n = dedup.length;
  const corners = [];
  for (let i = 0; i < n; i++) {
    const a = dedup[(i - 1 + n) % n], b = dedup[i], c = dedup[(i + 1) % n];
    const cross = (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);
    if (Math.abs(cross) > 1e-6) corners.push(b);
  }
  return corners;
}

// ---- Tests ---------------------------------------------------------------

test('axis-aligned box cut -> exactly 1 closed loop of 4 corners', () => {
  const win = loadSectionCut();
  const tris = boxTriangles(0, 2, 0, 3, 0, 1); // 0.3m-ish wall stand-in
  const meshes = [makeMesh(tris, { indexed: false })];
  const { chains } = chainsAt(win, meshes, 1.5, 1e-4);
  const closed = closedChains(chains);
  assert.equal(closed.length, 1, `expected 1 closed loop, got ${chains.length} chains (${closed.length} closed)`);
  const corners = uniqueCorners(closed[0], 1e-4);
  assert.equal(corners.length, 4, `expected 4 distinct corners, got ${corners.length}`);
});

test('indexed (welded) box cut also yields exactly 1 closed rectangle', () => {
  const win = loadSectionCut();
  const tris = boxTriangles(-1, 1, 0, 3, -0.15, 0.15); // thin wall-like slab
  const meshes = [makeMesh(tris, { indexed: true })];
  const { chains } = chainsAt(win, meshes, 1.2, 1e-4);
  const closed = closedChains(chains);
  assert.equal(closed.length, 1);
  assert.equal(uniqueCorners(closed[0], 1e-4).length, 4);
});

test('rotated box cut -> still 1 closed loop of 4 corners', () => {
  const win = loadSectionCut();
  const tris = rotateY(boxTriangles(0, 2, 0, 3, 0, 0.3), Math.PI / 5);
  const meshes = [makeMesh(tris, { indexed: false })];
  const { chains } = chainsAt(win, meshes, 1.5, 1e-4);
  const closed = closedChains(chains);
  assert.equal(closed.length, 1);
  assert.equal(uniqueCorners(closed[0], 1e-4).length, 4);
});

test('L-shaped extrusion cut -> 1 closed loop of 6 corners', () => {
  const win = loadSectionCut();
  // L-shape footprint in XZ, extruded 0 -> 3 in Y:
  //   (0,0) (4,0) (4,2) (2,2) (2,4) (0,4)
  const footprint = [[0,0],[4,0],[4,2],[2,2],[2,4],[0,4]];
  const y0 = 0, y1 = 3;
  const tris = [];
  // Bottom + top caps via fan triangulation (footprint is convex-decomposable this way for a simple L).
  function fan(pts, y, flip) {
    const t = [];
    for (let i = 1; i < pts.length - 1; i++) {
      const a = [pts[0][0], y, pts[0][1]];
      const b = [pts[i][0], y, pts[i][1]];
      const c = [pts[i+1][0], y, pts[i+1][1]];
      t.push(flip ? [a, c, b] : [a, b, c]);
    }
    return t;
  }
  tris.push(...fan(footprint, y0, true));
  tris.push(...fan(footprint, y1, false));
  // Side walls
  for (let i = 0; i < footprint.length; i++) {
    const [x1, z1] = footprint[i];
    const [x2, z2] = footprint[(i + 1) % footprint.length];
    const a = [x1, y0, z1], b = [x2, y0, z2], c = [x2, y1, z2], d = [x1, y1, z1];
    tris.push([a, b, c], [a, c, d]);
  }
  const meshes = [makeMesh(tris, { indexed: false })];
  const { chains } = chainsAt(win, meshes, 1.5, 1e-4);
  const closed = closedChains(chains);
  assert.equal(closed.length, 1, `expected 1 closed loop, got ${closed.length} of ${chains.length} chains`);
  assert.equal(uniqueCorners(closed[0], 1e-4).length, 6);
});

test('box with a rectangular hole cut -> 2 closed loops', () => {
  const win = loadSectionCut();
  // Outer box 0..6 x 0..3 x 0..1, with a 2x1 rectangular hole through Z
  // centered in X, spanning the full cut height, modeled as a manifold
  // "picture frame" solid extruded along Z.
  const y0 = 0, y1 = 3, z0 = 0, z1 = 1;
  const outer = [[0,0],[6,0],[6,3],[0,3]];
  const inner = [[2,1],[4,1],[4,2],[2,2]]; // hole footprint (reversed winding)
  const tris = [];
  function ring(poly, reverse) {
    const p = reverse ? poly.slice().reverse() : poly;
    const segs = [];
    for (let i = 0; i < p.length; i++) segs.push([p[i], p[(i + 1) % p.length]]);
    return segs;
  }
  // Front (z0) and back (z1) faces: outer ring minus inner ring, as a strip
  // of quads is complex for a general polygon-with-hole, so build the frame
  // directly as 4 rectangular slabs (like 4 walls around a window) union'd,
  // which is exactly the "wall with an opening" shape these tests target.
  function slab(x0,x1,zy0,zy1) {
    // box in X (x0..x1) and Y (zy0..zy1), full Z depth (z0..z1)
    return boxTriangles(x0, x1, zy0, zy1, z0, z1);
  }
  tris.push(...slab(0, 6, 0, 1));   // bottom strip
  tris.push(...slab(0, 6, 2, 3));   // top strip
  tris.push(...slab(0, 2, 1, 2));   // left strip (between top/bottom, left of hole)
  tris.push(...slab(4, 6, 1, 2));   // right strip (between top/bottom, right of hole)
  const meshes = [makeMesh(tris, { indexed: false })];
  const { chains } = chainsAt(win, meshes, 1.5, 1e-4);
  const closed = closedChains(chains);
  assert.equal(closed.length, 2, `expected 2 closed loops (outer + hole), got ${closed.length} of ${chains.length} chains`);
});

test('cut exactly through a vertex/edge does not drop or duplicate crossings', () => {
  const win = loadSectionCut();
  const tris = boxTriangles(0, 2, 0, 3, 0, 1);
  const meshes = [makeMesh(tris, { indexed: false })];
  // Cut exactly at the box's own vertex Y (y1 boundary is at 3, mid box at
  // an existing coordinate isn't a vertex Y by construction here, so pick a
  // cut that lands exactly on y0's own top-face coordinate via a second box
  // stacked so a cut plane passes exactly through shared vertices).
  const stacked = boxTriangles(0, 2, 3, 5, 0, 1); // sits exactly on top, shares y=3
  const both = [makeMesh(tris.concat(stacked), { indexed: false })];
  const { chains } = chainsAt(win, both, 3, 1e-4); // cut exactly at the shared seam y=3
  const closed = closedChains(chains);
  assert.equal(closed.length, 1, `expected exactly 1 closed loop at the exact-vertex cut, got ${closed.length} of ${chains.length}`);
  assert.equal(uniqueCorners(closed[0], 1e-4).length, 4);
});

test('non-indexed mesh with duplicated vertices still welds into a closed loop', () => {
  const win = loadSectionCut();
  // Same box, but deliberately triangulated with independent vertex
  // instances per triangle (the common web-ifc shape) and slightly jittered
  // duplicate coordinates within float precision to simulate real-world
  // vertex duplication noise.
  const tris = boxTriangles(0, 2, 0, 3, 0, 0.3).map(tri =>
    tri.map(([x, y, z]) => [x + 1e-9, y, z - 1e-9])
  );
  const meshes = [makeMesh(tris, { indexed: false })];
  const { chains } = chainsAt(win, meshes, 1.5, 1e-4);
  const closed = closedChains(chains);
  assert.equal(closed.length, 1);
  assert.equal(uniqueCorners(closed[0], 1e-4).length, 4);
});
