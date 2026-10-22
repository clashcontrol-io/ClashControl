// @ts-check
// Conservative CPU occlusion buffer (docs/OCCLUSION_CULLING.md).
//
// Pure math, no THREE, no DOM: index.html projects geometry and calls in
// here; node:test drives it directly (tests/occlusion-core.test.js).
//
// What it proves: a candidate is reported hidden only if EVERY point of its
// screen rectangle is covered by one occluder whose nearest drawn surface
// there is in front of the candidate's nearest point by more than the depth
// margin. No point sampling: coverage is a statement about whole cells
// (k x k pixel squares), so MSAA sample positions do not matter.
//
// Coverage of a cell by one occluder (mesh = union of its triangles):
//   the cell's square, grown by `m` px, touches none of the occluder's
//   BOUNDARY edges, and the cell centre lies inside one of its triangles.
//   A connected square that does not meet the union's boundary is wholly
//   inside or wholly outside, and the centre decides which. An edge is
//   interior (not boundary) when the two triangles that share it (same
//   vertex positions, bit for bit, so the GPU rasterises them watertight)
//   both draw and lie on opposite sides of it on screen. Everything else is
//   boundary: mesh outlines, T-junctions, non-manifold edges, edges next to
//   culled/back-facing/clipped/sliver triangles. `m` covers GPU vertex
//   snapping and float error, so the GPU's own outline sits inside it.
//
// Depth bound of a covered cell: max over the robust triangles touching the
// grown cell of their (screen-affine) NDC depth there, plus `dz`. The GPU's
// nearest fragment at any sample in the cell is at or in front of it.
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccOcclusionCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  /**
   * Half-edge adjacency for a triangle range. mate[3t+e] is the half-edge of
   * the one other triangle sharing edge e of triangle t (positions compared
   * bit for bit), or -1 when the edge is open, degenerate or shared by 3+
   * triangles (all treated as boundary).
   * @param {Float32Array} pos packed xyz
   * @param {ArrayLike<number>|null} index absolute vertex indices, or null (non-indexed)
   * @param {number} first first index (indexed) or first vertex (non-indexed)
   * @param {number} triCount
   */
  function buildAdjacency(pos, index, first, triCount) {
    var bits = new Uint32Array(pos.buffer, pos.byteOffset, pos.length);
    var n = triCount * 3;
    var vid = new Int32Array(n);
    var canon = new Map();
    var next = 0;
    for (var k = 0; k < n; k++) {
      var vi = index ? index[first + k] : first + k;
      var key = bits[vi * 3] + ',' + bits[vi * 3 + 1] + ',' + bits[vi * 3 + 2];
      var c = canon.get(key);
      if (c === undefined) { c = next++; canon.set(key, c); }
      vid[k] = c;
    }
    var mate = new Int32Array(n).fill(-1);
    var seen = new Map(); // edge key -> first half-edge, or -2 once a third shows up
    for (var t = 0; t < triCount; t++) {
      for (var e = 0; e < 3; e++) {
        var h = t * 3 + e;
        var a = vid[h], b = vid[t * 3 + (e + 1) % 3];
        if (a === b) continue;
        var ek = a < b ? a * next + b : b * next + a;
        var prev = seen.get(ek);
        if (prev === undefined) { seen.set(ek, h); continue; }
        if (prev === -2) continue;
        if (mate[prev] === -1 && (prev / 3 | 0) !== t) { mate[prev] = h; mate[h] = prev; continue; }
        // third triangle on this edge: non-manifold, open both earlier ones
        if (mate[prev] >= 0) mate[mate[prev]] = -1;
        mate[prev] = -1;
        seen.set(ek, -2);
      }
    }
    return mate;
  }

  /** @param {number} n */
  function f64(n) { return new Float64Array(n); }

  function createBuffer() {
    var cols = 0, rows = 0, k = 1;
    var zc = f64(0);                 // level-0 coverage depth (Infinity = not covered)
    /** @type {Float64Array[]} */ var levels = [];
    /** @type {number[]} */ var lw = [], lh = [];
    var stIn = new Int32Array(0), stB = new Int32Array(0), stD = new Int32Array(0);
    var dmax = f64(0);
    var inList = new Int32Array(0);
    var gen = 0;
    /** @type {Int32Array|null} */ var owner = null;   // debug: which occluder set each cell
    // 8x8-cell tiles: running max of zc, kept current while occluders are
    // added so later (farther) occluders that are already hidden can be skipped
    var TS = 3, tcols = 0, trows = 0, tileMax = f64(0), tileSt = new Int32Array(0), tileList = new Int32Array(0);
    // per-occluder triangle scratch
    var tOk = new Uint8Array(0);

    /** @param {number} w @param {number} h @param {number} cell */
    function begin(w, h, cell) {
      k = cell;
      var c = Math.max(1, Math.ceil(w / k)), r = Math.max(1, Math.ceil(h / k));
      if (c !== cols || r !== rows) {
        cols = c; rows = r;
        var N = cols * rows;
        zc = f64(N); dmax = f64(N);
        stIn = new Int32Array(N); stB = new Int32Array(N); stD = new Int32Array(N);
        inList = new Int32Array(N);
        gen = 0;
        tcols = Math.ceil(cols / 8); trows = Math.ceil(rows / 8);
        tileMax = f64(tcols * trows); tileSt = new Int32Array(tcols * trows); tileList = new Int32Array(tcols * trows);
        levels = []; lw = []; lh = [];
        var W = cols, H = rows;
        while (true) {
          levels.push(levels.length ? f64(W * H) : zc);
          lw.push(W); lh.push(H);
          if (W === 1 && H === 1) break;
          W = Math.ceil(W / 2); H = Math.ceil(H / 2);
        }
      }
      zc.fill(Infinity);
      if (owner) { if (owner.length !== zc.length) owner = new Int32Array(zc.length); owner.fill(-1); }
      tileMax.fill(Infinity);
    }

    // x-extent / max z of triangle (x0..z2) intersected with the closed band
    // [ylo, yhi]. Writes into band[0..2]; returns false when empty.
    var band = f64(3);
    /** @param {number[]|Float64Array} T @param {number} ylo @param {number} yhi */
    function clipBand(T, ylo, yhi) {
      var xmn = Infinity, xmx = -Infinity, zmx = -Infinity;
      for (var e = 0; e < 3; e++) {
        var px = T[e * 3], py = T[e * 3 + 1], pz = T[e * 3 + 2];
        var q = ((e + 1) % 3) * 3;
        var qx = T[q], qy = T[q + 1], qz = T[q + 2];
        if (py >= ylo && py <= yhi) {
          if (px < xmn) xmn = px; if (px > xmx) xmx = px; if (pz > zmx) zmx = pz;
        }
        if (py !== qy) {
          for (var s = 0; s < 2; s++) {
            var yb = s ? yhi : ylo;
            if ((py - yb) * (qy - yb) < 0) {
              var t = (yb - py) / (qy - py);
              var x = px + t * (qx - px), z = pz + t * (qz - pz);
              if (x < xmn) xmn = x; if (x > xmx) xmx = x; if (z > zmx) zmx = z;
            }
          }
        }
      }
      if (xmn > xmx) return false;
      band[0] = xmn; band[1] = xmx; band[2] = zmx;
      return true;
    }

    /** @param {number} ax @param {number} ay @param {number} bx @param {number} by @param {number} m */
    function markSegment(ax, ay, bx, by, m) {
      var ymn = ay < by ? ay : by, ymx = ay < by ? by : ay;
      var r0 = Math.floor((ymn - m) / k) - 1, r1 = Math.floor((ymx + m) / k);
      if (r0 < 0) r0 = 0; if (r1 > rows - 1) r1 = rows - 1;
      for (var r = r0; r <= r1; r++) {
        var lo = r * k - m, hi = (r + 1) * k + m;
        var xa, xb;
        if (ay === by) { xa = ax < bx ? ax : bx; xb = ax < bx ? bx : ax; }
        else {
          var t0 = (lo - ay) / (by - ay), t1 = (hi - ay) / (by - ay);
          if (t0 > t1) { var tt = t0; t0 = t1; t1 = tt; }
          if (t0 < 0) t0 = 0; if (t1 > 1) t1 = 1;
          if (t0 > t1) continue;
          var x0 = ax + t0 * (bx - ax), x1 = ax + t1 * (bx - ax);
          xa = x0 < x1 ? x0 : x1; xb = x0 < x1 ? x1 : x0;
        }
        var c0 = Math.floor((xa - m) / k) - 1, c1 = Math.floor((xb + m) / k);
        if (c0 < 0) c0 = 0; if (c1 > cols - 1) c1 = cols - 1;
        var base = r * cols;
        for (var c = c0; c <= c1; c++) stB[base + c] = gen;
      }
    }

    var T = f64(9);
    var vi = new Int32Array(3);
    /**
     * Rasterise one occluder (one draw: same material, same transform).
     * @param {{px:Float64Array, py:Float64Array, pz:Float64Array, pv:Uint8Array,
     *   index:ArrayLike<number>|null, first:number, triCount:number, vertBase:number,
     *   mate:Int32Array, cull:number, m:number, dz:number, id?:number}} o
     *   px/py window px (y up), pz NDC z, pv 1 = vertex projects inside near/far,
     *   indexed by (vertex index - vertBase). cull: 0 none, 1 drop back faces
     *   (front = CCW on screen), 2 drop front faces.
     * @returns {number} cells this occluder covered
     */
    function rasterizeOccluder(o) {
      var triCount = o.triCount, m = o.m, idx = o.index, first = o.first, vb = o.vertBase;
      var px = o.px, py = o.py, pz = o.pz, pv = o.pv, mate = o.mate;
      if (tOk.length < triCount) tOk = new Uint8Array(Math.max(triCount, tOk.length * 2));
      gen++;
      var minAlt = 4 * m;
      // pass 1: which triangles draw robustly (GPU and CPU agree on coverage)
      for (var t = 0; t < triCount; t++) {
        var i0 = (idx ? idx[first + t * 3] : first + t * 3) - vb;
        var i1 = (idx ? idx[first + t * 3 + 1] : first + t * 3 + 1) - vb;
        var i2 = (idx ? idx[first + t * 3 + 2] : first + t * 3 + 2) - vb;
        var ok = 0;
        if (pv[i0] && pv[i1] && pv[i2]) {
          var x0 = px[i0], y0 = py[i0], x1 = px[i1], y1 = py[i1], x2 = px[i2], y2 = py[i2];
          var A = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
          if (!(o.cull === 1 && A <= 0) && !(o.cull === 2 && A >= 0)) {
            var l0 = (x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0);
            var l1 = (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1);
            var l2 = (x0 - x2) * (x0 - x2) + (y0 - y2) * (y0 - y2);
            var L = Math.sqrt(Math.max(l0, l1, l2));
            if (L > 0 && Math.abs(A) / L >= minAlt) ok = 1;
          }
        }
        tOk[t] = ok;
      }
      var nIn = 0;
      for (t = 0; t < triCount; t++) {
        if (!tOk[t]) continue;
        for (var j = 0; j < 3; j++) {
          var v = (idx ? idx[first + t * 3 + j] : first + t * 3 + j) - vb;
          vi[j] = v;
          T[j * 3] = px[v]; T[j * 3 + 1] = py[v]; T[j * 3 + 2] = pz[v];
        }
        var ax = T[0], ay = T[1], az = T[2], bx = T[3], by = T[4], bz = T[5], cx = T[6], cy = T[7], cz = T[8];
        var A2 = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
        var gx = ((bz - az) * (cy - ay) - (cz - az) * (by - ay)) / A2;
        var gy = ((bx - ax) * (cz - az) - (cx - ax) * (bz - az)) / A2;
        var zv = az > bz ? az : bz; if (cz > zv) zv = cz;
        var ymn = Math.min(ay, by, cy), ymx = Math.max(ay, by, cy);
        var r0 = Math.floor((ymn - m) / k) - 1, r1 = Math.floor((ymx + m) / k);
        if (r0 < 0) r0 = 0; if (r1 > rows - 1) r1 = rows - 1;
        for (var r = r0; r <= r1; r++) {
          // depth: every cell whose m-grown square meets the triangle
          if (clipBand(T, r * k - m, (r + 1) * k + m)) {
            var bz2 = band[2] < zv ? band[2] : zv;
            var c0 = Math.floor((band[0] - m) / k) - 1, c1 = Math.floor((band[1] + m) / k);
            if (c0 < 0) c0 = 0; if (c1 > cols - 1) c1 = cols - 1;
            var ylo = r * k - m, yhi = (r + 1) * k + m;
            // plane max over the grown cell is at a corner: pick per sign of gradient
            var yTerm = az + gy * ((gy > 0 ? yhi : ylo) - ay);
            var base = r * cols;
            for (var c = c0; c <= c1; c++) {
              var xc = gx > 0 ? (c + 1) * k + m : c * k - m;
              var pzv = yTerm + gx * (xc - ax);
              var d = pzv < bz2 ? pzv : bz2;
              var ci = base + c;
              if (stD[ci] !== gen) { stD[ci] = gen; dmax[ci] = d; }
              else if (d > dmax[ci]) dmax[ci] = d;
            }
          }
          // inside: cell centres in the (closed) triangle
          var yc = (r + 0.5) * k;
          if (yc >= ymn && yc <= ymx && clipBand(T, yc, yc)) {
            // lenient by far less than m: a centre just outside one triangle is
            // either inside its interior-edge neighbour or within m of a
            // boundary edge (and so rejected by the boundary stamp below)
            var xa = band[0] - 1e-7, xb = band[1] + 1e-7;
            var i0c = Math.ceil(xa / k - 0.5), i1c = Math.floor(xb / k - 0.5);
            if (i0c < 0) i0c = 0; if (i1c > cols - 1) i1c = cols - 1;
            var base2 = r * cols;
            for (var cc = i0c; cc <= i1c; cc++) {
              var ii = base2 + cc;
              if (stIn[ii] !== gen) { stIn[ii] = gen; inList[nIn++] = ii; }
            }
          }
        }
        // boundary edges
        for (var e = 0; e < 3; e++) {
          var h = t * 3 + e;
          var pa = vi[e], pb = vi[(e + 1) % 3], pc = vi[(e + 2) % 3];
          var interior = false;
          var mh = mate[h];
          if (mh >= 0) {
            var t2 = (mh / 3) | 0;
            if (tOk[t2]) {
              var oc = (idx ? idx[first + t2 * 3 + (mh % 3 + 2) % 3] : first + t2 * 3 + (mh % 3 + 2) % 3) - vb;
              var exx = px[pb] - px[pa], eyy = py[pb] - py[pa];
              var s1 = exx * (py[pc] - py[pa]) - eyy * (px[pc] - px[pa]);
              var s2 = exx * (py[oc] - py[pa]) - eyy * (px[oc] - px[pa]);
              interior = (s1 > 0 && s2 < 0) || (s1 < 0 && s2 > 0);
            }
          }
          if (!interior) markSegment(px[pa], py[pa], px[pb], py[pb], m);
        }
      }
      var covered = 0, nT = 0;
      for (var q = 0; q < nIn; q++) {
        var cIdx = inList[q];
        if (stB[cIdx] === gen || stD[cIdx] !== gen) continue;
        var zz = dmax[cIdx] + o.dz;
        if (zz < zc[cIdx]) {
          zc[cIdx] = zz;
          if (owner) owner[cIdx] = o.id == null ? -1 : o.id;
          var tI = ((cIdx / cols | 0) >> TS) * tcols + ((cIdx % cols) >> TS);
          if (tileSt[tI] !== gen) { tileSt[tI] = gen; tileList[nT++] = tI; }
        }
        covered++;
      }
      for (var tq = 0; tq < nT; tq++) {
        var tt = tileList[tq], ty = (tt / tcols | 0) << TS, tx = (tt % tcols) << TS, mx = -Infinity;
        var yE = Math.min(rows, ty + 8), xE = Math.min(cols, tx + 8);
        for (var yy = ty; yy < yE; yy++) for (var xx = tx; xx < xE; xx++) { var zv2 = zc[yy * cols + xx]; if (zv2 > mx) mx = zv2; }
        tileMax[tt] = mx;
      }
      return covered;
    }

    /**
     * Already hidden by what has been rasterised so far (call between
     * rasterizeOccluder calls; same contract as testRect). Lets the caller
     * skip occluders that cannot add coverage.
     * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {number} zmin @param {number} eps
     */
    function hiddenSoFar(x0, y0, x1, y1, zmin, eps) {
      var c0 = Math.floor(x0 / k), c1 = Math.floor(x1 / k), r0 = Math.floor(y0 / k), r1 = Math.floor(y1 / k);
      if (c1 < 0 || r1 < 0 || c0 > cols - 1 || r0 > rows - 1) return false;
      if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0; if (c1 > cols - 1) c1 = cols - 1; if (r1 > rows - 1) r1 = rows - 1;
      var lim = zmin - eps;
      if (!(lim > -Infinity)) return false;
      for (var ty = r0 >> TS; ty <= r1 >> TS; ty++) {
        for (var tx = c0 >> TS; tx <= c1 >> TS; tx++) {
          if (tileMax[ty * tcols + tx] < lim) continue;
          var ya = Math.max(r0, ty << TS), yb = Math.min(r1, (ty << TS) + 7), xa = Math.max(c0, tx << TS), xb = Math.min(c1, (tx << TS) + 7);
          for (var y = ya; y <= yb; y++) for (var x = xa; x <= xb; x++) if (!(zc[y * cols + x] < lim)) return false;
        }
      }
      return true;
    }

    function finalize() {
      for (var L = 1; L < levels.length; L++) {
        var src = levels[L - 1], dst = levels[L], sw = lw[L - 1], sh = lh[L - 1], W = lw[L], H = lh[L];
        for (var y = 0; y < H; y++) {
          for (var x = 0; x < W; x++) {
            var sx = x * 2, sy = y * 2;
            var v = src[sy * sw + sx];
            if (sx + 1 < sw && src[sy * sw + sx + 1] > v) v = src[sy * sw + sx + 1];
            if (sy + 1 < sh) {
              if (src[(sy + 1) * sw + sx] > v) v = src[(sy + 1) * sw + sx];
              if (sx + 1 < sw && src[(sy + 1) * sw + sx + 1] > v) v = src[(sy + 1) * sw + sx + 1];
            }
            dst[y * W + x] = v;
          }
        }
      }
    }

    /**
     * @param {number} L level @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1
     *   level-0 cell range (inclusive) @param {number} lim covered depth must be < lim
     */
    function _cov(L, x0, y0, x1, y1, lim) {
      var a = x0 >> L, b = x1 >> L, c = y0 >> L, d = y1 >> L, W = lw[L], lv = levels[L];
      for (var y = c; y <= d; y++) {
        for (var x = a; x <= b; x++) {
          if (lv[y * W + x] < lim) continue;
          if (L === 0) return false;
          var cx0 = x << L, cx1 = ((x + 1) << L) - 1, cy0 = y << L, cy1 = ((y + 1) << L) - 1;
          if (!_cov(L - 1, cx0 > x0 ? cx0 : x0, cy0 > y0 ? cy0 : y0, cx1 < x1 ? cx1 : x1, cy1 < y1 ? cy1 : y1, lim)) return false;
        }
      }
      return true;
    }

    /**
     * True when the window-px rect [x0,x1]x[y0,y1] is covered everywhere by
     * occluders nearer than zmin - eps (NDC). Off-screen parts are ignored;
     * a rect entirely off-screen is never reported hidden.
     * @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 @param {number} zmin @param {number} eps
     */
    function testRect(x0, y0, x1, y1, zmin, eps) {
      var c0 = Math.floor(x0 / k), c1 = Math.floor(x1 / k), r0 = Math.floor(y0 / k), r1 = Math.floor(y1 / k);
      if (c1 < 0 || r1 < 0 || c0 > cols - 1 || r0 > rows - 1) return false;
      if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0; if (c1 > cols - 1) c1 = cols - 1; if (r1 > rows - 1) r1 = rows - 1;
      var lim = zmin - eps;
      if (!(lim > -Infinity)) return false;
      // start where the rect spans at most ~2 texels per axis
      var span = Math.max(c1 - c0, r1 - r0), L = 0;
      while ((span >> L) > 1 && L < levels.length - 1) L++;
      return _cov(L, c0, r0, c1, r1, lim);
    }

    return {
      begin: begin, rasterizeOccluder: rasterizeOccluder, hiddenSoFar: hiddenSoFar, finalize: finalize, testRect: testRect,
      get cols() { return cols; }, get rows() { return rows; }, get cell() { return k; },
      /** level-0 coverage depths (Infinity = uncovered); read-only view for tests/diagnostics */
      get depth() { return zc; },
      /** debug: track the occluder id (o.id) that set each covered cell */
      trackOwners: function(/** @type {boolean} */ on) { owner = on ? new Int32Array(zc.length).fill(-1) : null; },
      get owner() { return owner; }
    };
  }

  /**
   * Window-space rect + nearest NDC depth of a view-space AABB.
   * P: camera projectionMatrix.elements (column-major). persp: perspective
   * (else orthographic). Returns false when the box reaches the near plane
   * or behind it (never cull those).
   * @param {ArrayLike<number>} P @param {boolean} persp @param {number} W @param {number} H
   * @param {ArrayLike<number>} b view-space [minx,miny,minz,maxx,maxy,maxz]
   * @param {Float64Array} out [x0,y0,x1,y1,zminNdc]
   */
  function projectViewBox(P, persp, W, H, b, out) {
    var zFar = b[2], zNear = b[5]; // view space looks down -z: maxz is nearest
    if (persp) {
      if (!(zNear < 0)) return false;
      var zn = -P[10] - P[14] / zNear;
      if (!(zn > -1)) return false;
      var xmn = Infinity, xmx = -Infinity, ymn = Infinity, ymx = -Infinity;
      for (var i = 0; i < 2; i++) {
        var iw = 1 / -(i ? zNear : zFar);
        var ax = b[0] * iw, bx = b[3] * iw, ay = b[1] * iw, by = b[4] * iw;
        if (ax < xmn) xmn = ax; if (bx > xmx) xmx = bx; if (ay < ymn) ymn = ay; if (by > ymx) ymx = by;
      }
      // x_ndc = P0 * x/(-z) - P8 (P8/P9 = off-centre terms)
      var nx0 = P[0] * xmn - P[8], nx1 = P[0] * xmx - P[8], ny0 = P[5] * ymn - P[9], ny1 = P[5] * ymx - P[9];
      out[0] = (nx0 + 1) * 0.5 * W; out[2] = (nx1 + 1) * 0.5 * W;
      out[1] = (ny0 + 1) * 0.5 * H; out[3] = (ny1 + 1) * 0.5 * H;
      out[4] = zn;
      return true;
    }
    var za = P[10] * zNear + P[14], zb = P[10] * zFar + P[14];
    var zmin = za < zb ? za : zb;
    if (!(zmin > -1)) return false;
    var ox0 = P[0] * b[0] + P[12], ox1 = P[0] * b[3] + P[12], oy0 = P[5] * b[1] + P[13], oy1 = P[5] * b[4] + P[13];
    out[0] = (Math.min(ox0, ox1) + 1) * 0.5 * W; out[2] = (Math.max(ox0, ox1) + 1) * 0.5 * W;
    out[1] = (Math.min(oy0, oy1) + 1) * 0.5 * H; out[3] = (Math.max(oy0, oy1) + 1) * 0.5 * H;
    out[4] = zmin;
    return true;
  }

  return { buildAdjacency: buildAdjacency, createBuffer: createBuffer, projectViewBox: projectViewBox };
}));
