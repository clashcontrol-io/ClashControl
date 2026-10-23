// @ts-check
// Viewer picking + measure snapping, as pure functions.
//
// No THREE, no DOM: index.html passes in raycast hits (three.js objects are
// read duck-typed: matrixWorld.elements, getMatrixAt, geometry.attributes /
// index with getX/getY/getZ or plain arrays), the active clip planes
// ({normal:{x,y,z}, constant}) and a projection callback; node:test drives it
// with plain arrays (tests/viewer-pick-core.test.js). See docs/INTERNALS.md
// §21.29.
//
// - hitMatrix(hit): full world matrix of the hit element — matrixWorld times
//   the InstancedMesh instance matrix or the BatchedMesh batch-instance
//   matrix (same rule as _ccHitWorldNormal in index.html). Without the batch
//   matrix the vertices of a batched element land at its geometry's local
//   origin and no vertex/edge is ever near the cursor.
// - firstVisibleHit(hits, opts): first hit that is on a visible object (and
//   visible ancestors), not ghosted and not cut away by a clip plane.
// - snap(opts): vertex > midpoint > edge > face near the cursor, from the
//   FEATURE edges (boundary or crease > 20 deg) of the hit element's
//   triangles near the hit point — never triangulation diagonals of a flat
//   face, never points cut away by a clip plane.
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccViewerPick = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var CLIP_TOL = 0.01;           // same as the click pick / orbit pick filters
  var CREASE_COS = Math.cos(20 * Math.PI / 180);

  function identity() { return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]; }

  // Column-major 4x4 product a*b (three.js Matrix4 element order).
  function mul(a, b) {
    var o = new Array(16);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3];
      }
    }
    return o;
  }

  // Minimal Matrix4 stand-in: three's InstancedMesh/BatchedMesh.getMatrixAt
  // only call target.fromArray(array, offset).
  function tmpMatrix() {
    var m = { elements: identity(), fromArray: function(/** @type {ArrayLike<number>} */ arr, /** @type {number} */ off) {
      off = off || 0;
      for (var i = 0; i < 16; i++) m.elements[i] = arr[off+i];
      return m;
    } };
    return m;
  }

  /** @returns {number[]} column-major world matrix of the hit element */
  function hitMatrix(hit) {
    var o = hit && hit.object;
    var base = (o && o.matrixWorld && o.matrixWorld.elements) ? Array.prototype.slice.call(o.matrixWorld.elements, 0, 16) : identity();
    if (!o || typeof o.getMatrixAt !== 'function') return base;
    var id = null;
    if (o.isInstancedMesh && hit.instanceId != null) id = hit.instanceId;
    else if ((o.isBatchedMesh || (o.userData && o.userData._isCCBatch)) && hit.batchId != null) id = hit.batchId;
    if (id == null) return base;
    var t = tmpMatrix();
    try { o.getMatrixAt(id, t); } catch (_) { return base; }
    return mul(base, t.elements);
  }

  function transformPoint(m, x, y, z) {
    return {
      x: m[0]*x + m[4]*y + m[8]*z + m[12],
      y: m[1]*x + m[5]*y + m[9]*z + m[13],
      z: m[2]*x + m[6]*y + m[10]*z + m[14]
    };
  }

  function planeDistance(pl, p) {
    var n = pl.normal;
    return n.x*p.x + n.y*p.y + n.z*p.z + pl.constant;
  }

  function isClipped(p, planes, tol) {
    if (!planes || !planes.length) return false;
    var t = tol != null ? tol : CLIP_TOL;
    for (var i = 0; i < planes.length; i++) if (planeDistance(planes[i], p) < -t) return true;
    return false;
  }

  // opts: {planes, isGhost(material), tol}
  function isHitVisible(hit, opts) {
    opts = opts || {};
    var o = hit && hit.object;
    if (!o) return false;
    for (var a = o; a; a = a.parent) if (a.visible === false) return false;
    if (typeof opts.isGhost === 'function' && opts.isGhost(o.material)) return false;
    if (hit.point && isClipped(hit.point, opts.planes, opts.tol)) return false;
    return true;
  }

  function firstVisibleHit(hits, opts) {
    if (!hits) return null;
    for (var i = 0; i < hits.length; i++) if (isHitVisible(hits[i], opts)) return hits[i];
    return null;
  }

  function _get(attr, i, c) {
    if (c === 0 && typeof attr.getX === 'function') return attr.getX(i);
    if (c === 1 && typeof attr.getY === 'function') return attr.getY(i);
    if (c === 2 && typeof attr.getZ === 'function') return attr.getZ(i);
    return attr.array[i * (attr.itemSize || 3) + c];
  }
  function _idx(index, i) {
    return typeof index.getX === 'function' ? index.getX(i) : index.array[i];
  }

  // Triangle range of the hit ELEMENT inside its geometry (a BatchedMesh
  // holds many elements; only the batch instance's geometry range counts).
  function elementTriangles(hit) {
    var o = hit && hit.object, g = o && o.geometry;
    var pos = g && g.attributes && g.attributes.position;
    if (!pos) return null;
    var index = g.index || null;
    var total = index ? index.count : pos.count;
    var start = 0, count = total;
    if ((o.isBatchedMesh || (o.userData && o.userData._isCCBatch)) && hit.batchId != null) {
      var gid = null;
      try { gid = typeof o.getGeometryIdAt === 'function' ? o.getGeometryIdAt(hit.batchId) : null; } catch (_) {}
      if (gid == null && o.userData && o.userData.batchGeomIds) gid = o.userData.batchGeomIds[hit.batchId];
      if (gid == null || typeof o.getGeometryRangeAt !== 'function') return null;
      var rg = o.getGeometryRangeAt(gid, {});
      start = rg.start; count = rg.count;
    } else if (g.drawRange) {
      start = g.drawRange.start || 0;
      count = Math.min(g.drawRange.count, total - start);
    }
    return { pos: pos, index: index, triStart: Math.floor(start / 3), triCount: Math.floor(count / 3) };
  }

  function _qkey(p) {
    return Math.round(p.x * 1e4) + ',' + Math.round(p.y * 1e4) + ',' + Math.round(p.z * 1e4);
  }

  // opts: {hit, matrix?, cursor:{x,y}, project(p)->{x,y,w}|null, tolPx=12,
  //        maxTris=20000, worldRadius?, planes?, isOccluded?(p)->bool,
  //        maxOcclusionChecks=3}
  // Returns {point:{x,y,z}, type:'vertex'|'midpoint'|'edge'|'face', distPx}.
  function snap(opts) {
    var hit = opts.hit;
    if (!hit || !hit.point) return null;
    var hp = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
    var face = { point: hp, type: 'face', distPx: 0 };
    var tr = elementTriangles(hit);
    if (!tr || !tr.triCount || typeof opts.project !== 'function') return face;
    var tri = tr;
    var m = opts.matrix || hitMatrix(hit);
    var tol = opts.tolPx || 12;
    var maxTris = opts.maxTris || 20000;
    var R = opts.worldRadius > 0 ? opts.worldRadius : Infinity;
    var planes = opts.planes;
    var cur = opts.cursor;

    // Cap work on huge elements: a window of triangles around the hit face
    // (index-adjacent triangles are spatially adjacent in tessellations).
    var t0 = tri.triStart, t1 = tri.triStart + tri.triCount;
    if (tri.triCount > maxTris) {
      var fi = hit.faceIndex != null ? hit.faceIndex : t0;
      t0 = Math.max(tri.triStart, Math.min(fi - (maxTris >> 1), t1 - maxTris));
      t1 = t0 + maxTris;
    }

    var edges = Object.create(null), edgeList = [];
    function vert(i) {
      var vi = tri.index ? _idx(tri.index, i) : i;
      return transformPoint(m, _get(tri.pos, vi, 0), _get(tri.pos, vi, 1), _get(tri.pos, vi, 2));
    }
    for (var t = t0; t < t1; t++) {
      var a = vert(t*3), b = vert(t*3+1), c = vert(t*3+2);
      if (R !== Infinity) {
        // Broad phase: triangle AABB vs sphere(hit point, R).
        var dx = Math.max(Math.min(a.x, b.x, c.x) - hp.x, 0, hp.x - Math.max(a.x, b.x, c.x));
        var dy = Math.max(Math.min(a.y, b.y, c.y) - hp.y, 0, hp.y - Math.max(a.y, b.y, c.y));
        var dz = Math.max(Math.min(a.z, b.z, c.z) - hp.z, 0, hp.z - Math.max(a.z, b.z, c.z));
        if (dx*dx + dy*dy + dz*dz > R*R) continue;
      }
      var ux = b.x-a.x, uy = b.y-a.y, uz = b.z-a.z, vx = c.x-a.x, vy = c.y-a.y, vz = c.z-a.z;
      var nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
      var nl = Math.sqrt(nx*nx + ny*ny + nz*nz);
      if (nl < 1e-12) continue; // degenerate sliver
      var n = { x: nx/nl, y: ny/nl, z: nz/nl };
      var vs = [a, b, c];
      for (var k = 0; k < 3; k++) {
        var p = vs[k], q = vs[(k+1) % 3];
        var kp = _qkey(p), kq = _qkey(q);
        var key = kp < kq ? kp + '|' + kq : kq + '|' + kp;
        var e = edges[key];
        if (!e) { e = edges[key] = { a: p, b: q, n: n, count: 1, crease: false }; edgeList.push(e); }
        else {
          e.count++;
          if (Math.abs(e.n.x*n.x + e.n.y*n.y + e.n.z*n.z) < CREASE_COS) e.crease = true;
        }
      }
    }

    var cands = [], seen = Object.create(null);
    function consider(p, type, rank) {
      // A corner is the endpoint of several feature edges: consider it once
      // (duplicates would also burn the occlusion-check budget).
      var sk = type + _qkey(p);
      if (seen[sk]) return;
      seen[sk] = true;
      if (isClipped(p, planes)) return;
      var s = opts.project(p);
      if (!s) return;
      var d = Math.hypot(s.x - cur.x, s.y - cur.y);
      var lim = type === 'midpoint' ? tol * 0.5 : tol;
      if (d > lim) return;
      cands.push({ point: p, type: type, rank: rank, distPx: d, w: s.w != null ? s.w : 0 });
    }
    for (var j = 0; j < edgeList.length; j++) {
      var ed = edgeList[j];
      // Feature edge: boundary (one triangle), non-manifold or crease. A
      // diagonal shared by two coplanar triangles is not an edge anyone sees.
      if (!(ed.count === 1 || ed.count > 2 || ed.crease)) continue;
      var A = ed.a, B = ed.b;
      consider(A, 'vertex', 0);
      consider(B, 'vertex', 0);
      consider({ x: (A.x+B.x)/2, y: (A.y+B.y)/2, z: (A.z+B.z)/2 }, 'midpoint', 1);
      var sa = opts.project(A), sb = opts.project(B);
      if (!sa || !sb) continue;
      var ex = sb.x - sa.x, ey = sb.y - sa.y, el2 = ex*ex + ey*ey;
      var ts = el2 > 1e-9 ? Math.max(0, Math.min(1, ((cur.x - sa.x)*ex + (cur.y - sa.y)*ey) / el2)) : 0;
      // Screen-space parameter -> world parameter (perspective-correct when
      // the projection reports view depth w).
      var tw = ts;
      if (sa.w > 0 && sb.w > 0) tw = (ts / sb.w) / ((1 - ts) / sa.w + ts / sb.w);
      consider({ x: A.x + (B.x-A.x)*tw, y: A.y + (B.y-A.y)*tw, z: A.z + (B.z-A.z)*tw }, 'edge', 2);
    }
    if (!cands.length) return face;
    cands.sort(function(p, q) {
      if (p.rank !== q.rank) return p.rank - q.rank;
      if (Math.abs(p.distPx - q.distPx) > 1) return p.distPx - q.distPx;
      return p.w - q.w; // same spot on screen: the nearer one
    });
    var checks = opts.maxOcclusionChecks != null ? opts.maxOcclusionChecks : 3;
    for (var ci = 0; ci < cands.length; ci++) {
      var cd = cands[ci];
      if (typeof opts.isOccluded === 'function') {
        if (checks-- <= 0) break;
        if (opts.isOccluded(cd.point)) continue;
      }
      return { point: cd.point, type: cd.type, distPx: cd.distPx };
    }
    return face;
  }

  return {
    hitMatrix: hitMatrix,
    transformPoint: transformPoint,
    isClipped: isClipped,
    isHitVisible: isHitVisible,
    firstVisibleHit: firstVisibleHit,
    elementTriangles: elementTriangles,
    snap: snap
  };
}));
