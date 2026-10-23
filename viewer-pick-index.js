// @ts-check
// Scene-level pick index: a BVH over the WORLD boxes of every pickable
// thing under the model root (S.mg) — one leaf per Mesh, per InstancedMesh
// instance and per BatchedMesh instance — so hover / click / snap / orbit
// pivot / walk rays cost what is under the cursor, not the whole scene.
//
// Contract: results are IDENTICAL to
//   raycaster.intersectObjects(root.children, true)   (+ the caller's filter)
// — same hits, same fields, same order including ties at equal distance
// (three.js sorts a stable list by distance, so ties keep traversal order:
// depth-first object order, then instance / batch-instance id, then the
// order the object's own raycast pushed them). The exact raycast still runs
// through three.js's own Mesh.raycast on each candidate (InstancedMesh /
// BatchedMesh instances are raycast one at a time by a line-for-line copy of
// r180's InstancedMesh.raycast / BatchedMesh.raycast loop body), so only the
// candidate selection is new. Boxes are padded (relative 1e-6) so a hit can
// never lie outside its leaf box or before its box entry distance.
//
// Query `first`: best-first traversal by box entry distance; stops once the
// next box is entered strictly beyond the nearest accepted hit (equal entry
// distance still runs — a tie may come earlier in three's order).
//
// Sync (checked at every query, cost ~ models + instanced/batched objects):
//   - root.children identity/order (model load / unload / replace / park /
//     restore) — per-model sub-BVHs, only the changed model is rebuilt;
//   - 'childadded' / 'childremoved' on every container inside a model
//     (ghost split-outs, instancing/batching passes) → that model rebuilds;
//   - matrixWorld of the root, of every container and of every mesh that is
//     not baked (matrixAutoUpdate) → rebuild / refit;
//   - InstancedMesh instanceMatrix.version / count, BatchedMesh matrix
//     texture version / instance + geometry counts → refit / rebuild.
//   Visibility, ghosting, isolate, clipping, layers (rooms on layer 3) and
//   BatchedMesh per-instance visibility are read at query time, never baked.
//   Anything else that moves geometry in place calls invalidate().
// Objects with a non-standard raycast (Line, Points, Sprite, a custom
// raycast override, morph targets, …) are kept as "always test" entries,
// raycast on every query exactly like three does (subtree included).
//
// THREE is passed in (create(THREE)); node:test drives it with the real
// three.cjs (tests/viewer-pick-index.test.js). See docs/INTERNALS.md §21.47.
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccViewerPickIndex = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var LEAF = 8;
  var PAD_REL = 1e-6;

  var KIND_MESH = 0, KIND_INST = 1, KIND_BATCH = 2;

  // ── Ray vs AABB (slab test) ─────────────────────────────────────
  // Returns the entry parameter t (>= 0) or -1 on a miss within [0, tMax].
  // `_exitT` holds the exit parameter of the last hit.
  var _exitT = 0;
  function rayBox(b, off, ox, oy, oz, dx, dy, dz, ix, iy, iz, tMax) {
    var tmin = 0, tmax = tMax, t1, t2, tt;
    if (dx !== 0) {
      t1 = (b[off] - ox) * ix; t2 = (b[off + 3] - ox) * ix;
      if (t1 > t2) { tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
    } else if (ox < b[off] || ox > b[off + 3]) return -1;
    if (dy !== 0) {
      t1 = (b[off + 1] - oy) * iy; t2 = (b[off + 4] - oy) * iy;
      if (t1 > t2) { tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
    } else if (oy < b[off + 1] || oy > b[off + 4]) return -1;
    if (dz !== 0) {
      t1 = (b[off + 2] - oz) * iz; t2 = (b[off + 5] - oz) * iz;
      if (t1 > t2) { tt = t1; t1 = t2; t2 = tt; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
    } else if (oz < b[off + 2] || oz > b[off + 5]) return -1;
    if (!(tmin <= tmax)) return -1; // also rejects NaN
    _exitT = tmax;
    return tmin;
  }

  // World AABB of local box (lo, hi) under column-major matrix m, padded,
  // written to out[o..o+5]. Center/extent form = the exact AABB of the 8
  // transformed corners. Non-finite → unbounded (always a candidate).
  function writeWorldBox(out, o, m, lx, ly, lz, hx, hy, hz) {
    var cx = (lx + hx) / 2, cy = (ly + hy) / 2, cz = (lz + hz) / 2;
    var ex = (hx - lx) / 2, ey = (hy - ly) / 2, ez = (hz - lz) / 2;
    var wx = m[0] * cx + m[4] * cy + m[8] * cz + m[12];
    var wy = m[1] * cx + m[5] * cy + m[9] * cz + m[13];
    var wz = m[2] * cx + m[6] * cy + m[10] * cz + m[14];
    var rx = Math.abs(m[0]) * ex + Math.abs(m[4]) * ey + Math.abs(m[8]) * ez;
    var ry = Math.abs(m[1]) * ex + Math.abs(m[5]) * ey + Math.abs(m[9]) * ez;
    var rz = Math.abs(m[2]) * ex + Math.abs(m[6]) * ey + Math.abs(m[10]) * ez;
    var mn = Math.max(Math.abs(wx) + rx, Math.abs(wy) + ry, Math.abs(wz) + rz);
    var pad = PAD_REL * (1 + mn);
    var a = wx - rx - pad, b = wy - ry - pad, c = wz - rz - pad;
    var d = wx + rx + pad, e = wy + ry + pad, f = wz + rz + pad;
    if (!(isFinite(a) && isFinite(b) && isFinite(c) && isFinite(d) && isFinite(e) && isFinite(f))) {
      a = b = c = -Infinity; d = e = f = Infinity;
    }
    // Float32 storage: the pad (1e-6 relative) is far larger than float32
    // rounding (6e-8 relative), so the stored box stays conservative.
    out[o] = a; out[o + 1] = b; out[o + 2] = c; out[o + 3] = d; out[o + 4] = e; out[o + 5] = f;
  }

  // Column-major a*b into out (Float64Array(16)).
  function mul4(out, a, ao, b, bo) {
    for (var c = 0; c < 4; c++) {
      var b0 = b[bo + c * 4], b1 = b[bo + c * 4 + 1], b2 = b[bo + c * 4 + 2], b3 = b[bo + c * 4 + 3];
      out[c * 4] = a[ao] * b0 + a[ao + 4] * b1 + a[ao + 8] * b2 + a[ao + 12] * b3;
      out[c * 4 + 1] = a[ao + 1] * b0 + a[ao + 5] * b1 + a[ao + 9] * b2 + a[ao + 13] * b3;
      out[c * 4 + 2] = a[ao + 2] * b0 + a[ao + 6] * b1 + a[ao + 10] * b2 + a[ao + 14] * b3;
      out[c * 4 + 3] = a[ao + 3] * b0 + a[ao + 7] * b1 + a[ao + 11] * b2 + a[ao + 15] * b3;
    }
    return out;
  }

  function sameMatrix(snap, m) {
    for (var i = 0; i < 16; i++) if (snap[i] !== m[i]) return false;
    return true;
  }

  // Local box of a geometry without touching it (Mesh.raycast computes the
  // bounding SPHERE lazily but uses the bounding box only when it already
  // exists — computing it here would change that path). null = no position.
  var _geoBoxCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function localGeoBox(g) {
    if (!g) return null;
    if (g.boundingBox) {
      var bb = g.boundingBox;
      return [bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z];
    }
    var pos = g.attributes && g.attributes.position;
    if (!pos) return null;
    var c = _geoBoxCache && _geoBoxCache.get(g);
    if (c && c.pos === pos && c.ver === pos.version) return c.box;
    var lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
    for (var i = 0, n = pos.count; i < n; i++) {
      var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (x < lx) lx = x; if (x > hx) hx = x;
      if (y < ly) ly = y; if (y > hy) hy = y;
      if (z < lz) lz = z; if (z > hz) hz = z;
    }
    var box = [lx, ly, lz, hx, hy, hz];
    if (_geoBoxCache) _geoBoxCache.set(g, { pos: pos, ver: pos.version, box: box });
    return box;
  }

  // Stable hit order: distance, then three's traversal order.
  function before(d, t, f, i, k, b) {
    if (d !== b.d) return d < b.d;
    if (t !== b.t) return t < b.t;
    if (f !== b.f) return f < b.f;
    if (i !== b.i) return i < b.i;
    return k < b.k;
  }

  /**
   * @param {any} THREE three.js namespace (r180)
   */
  function create(THREE) {
    var MeshRaycast = THREE.Mesh.prototype.raycast;
    var InstRaycast = THREE.InstancedMesh && THREE.InstancedMesh.prototype.raycast;
    var BatchRaycast = THREE.BatchedMesh && THREE.BatchedMesh.prototype.raycast;
    var NoopRaycast = THREE.Object3D.prototype.raycast;

    // Module-local helpers mirroring three's module-level ones.
    var _iMesh = new THREE.Mesh();
    var _iLocal = new THREE.Matrix4(), _iWorld = new THREE.Matrix4();
    var _iSphere = new THREE.Sphere();
    var _bMesh = new THREE.Mesh();
    var _tmpHits = [];
    var _m4 = new THREE.Matrix4();
    var _box3 = new THREE.Box3();
    var _mw = new Float64Array(16);

    var _root = null, _rootMw = null, _allDirty = true;
    /** @type {any[]} */ var _slots = [];
    var _slotOf = new Map();
    var _stats = { builds: 0, refits: 0, buildMs: 0, lastQueryCandidates: 0, lastQueryNodes: 0 };

    // Heap (min by key) of (slot, id): id >= 0 node, id < 0 entry -(e+1).
    // Min-heap by key of (slot, id): id >= 0 node, id < 0 entry -(e+1).
    // One heap per active query (a predicate may run a nested query, e.g.
    // the walk-mode footprint check), recycled through a small pool.
    function Heap() {
      this.key = new Float64Array(256); this.slot = new Int32Array(256); this.id = new Int32Array(256);
      this.n = 0; this.popSlot = 0; this.popId = 0;
    }
    Heap.prototype.push = function(k, s, id) {
      if (this.n === this.key.length) {
        var nk = new Float64Array(this.n * 2); nk.set(this.key); this.key = nk;
        var ns = new Int32Array(this.n * 2); ns.set(this.slot); this.slot = ns;
        var ni = new Int32Array(this.n * 2); ni.set(this.id); this.id = ni;
      }
      var K = this.key, S = this.slot, I = this.id, i = this.n++;
      while (i > 0) {
        var p = (i - 1) >> 1;
        if (K[p] <= k) break;
        K[i] = K[p]; S[i] = S[p]; I[i] = I[p]; i = p;
      }
      K[i] = k; S[i] = s; I[i] = id;
    };
    Heap.prototype.pop = function() {
      var K = this.key, S = this.slot, I = this.id;
      this.popSlot = S[0]; this.popId = I[0];
      var n = --this.n;
      if (n <= 0) return;
      var k = K[n], s = S[n], id = I[n], i = 0;
      for (;;) {
        var l = 2 * i + 1;
        if (l >= n) break;
        var r = l + 1, c = (r < n && K[r] < K[l]) ? r : l;
        if (K[c] >= k) break;
        K[i] = K[c]; S[i] = S[c]; I[i] = I[c]; i = c;
      }
      K[i] = k; S[i] = s; I[i] = id;
    };
    var _heapPool = [];

    // ── Exact per-candidate raycast (three's own code paths) ─────
    function raycastInstance(im, id, raycaster, out) {
      // InstancedMesh.raycast (r180), one instance.
      if (id >= im.count) return;
      _iMesh.geometry = im.geometry;
      _iMesh.material = im.material;
      if (_iMesh.material === undefined) return;
      if (im.boundingSphere === null) im.computeBoundingSphere();
      _iSphere.copy(im.boundingSphere);
      _iSphere.applyMatrix4(im.matrixWorld);
      if (raycaster.ray.intersectsSphere(_iSphere) === false) return;
      im.getMatrixAt(id, _iLocal);
      _iWorld.multiplyMatrices(im.matrixWorld, _iLocal);
      _iMesh.matrixWorld = _iWorld;
      _tmpHits.length = 0;
      _iMesh.raycast(raycaster, _tmpHits);
      for (var i = 0; i < _tmpHits.length; i++) {
        var h = _tmpHits[i];
        h.instanceId = id;
        h.object = im;
        out.push(h);
      }
      _tmpHits.length = 0;
    }
    function raycastBatchInstance(bm, i, raycaster, out) {
      // BatchedMesh.raycast (r180), one instance.
      var info = bm._instanceInfo[i];
      if (!info || !info.visible || !info.active) return;
      _bMesh.material = bm.material;
      _bMesh.geometry.index = bm.geometry.index;
      _bMesh.geometry.attributes = bm.geometry.attributes;
      if (_bMesh.geometry.boundingBox === null) _bMesh.geometry.boundingBox = new THREE.Box3();
      if (_bMesh.geometry.boundingSphere === null) _bMesh.geometry.boundingSphere = new THREE.Sphere();
      var geometryId = info.geometryIndex;
      var geometryInfo = bm._geometryInfo[geometryId];
      _bMesh.geometry.setDrawRange(geometryInfo.start, geometryInfo.count);
      bm.getMatrixAt(i, _bMesh.matrixWorld).premultiply(bm.matrixWorld);
      bm.getBoundingBoxAt(geometryId, _bMesh.geometry.boundingBox);
      bm.getBoundingSphereAt(geometryId, _bMesh.geometry.boundingSphere);
      _tmpHits.length = 0;
      _bMesh.raycast(raycaster, _tmpHits);
      for (var j = 0; j < _tmpHits.length; j++) {
        var h = _tmpHits[j];
        h.object = bm;
        h.batchId = i;
        out.push(h);
      }
      _tmpHits.length = 0;
      _bMesh.material = null;
      _bMesh.geometry.index = null;
      _bMesh.geometry.attributes = {};
      _bMesh.geometry.setDrawRange(0, Infinity);
    }
    // three's Raycaster intersect(), for "always test" subtrees.
    function intersectRec(o, raycaster, out) {
      var propagate = true;
      if (o.layers.test(raycaster.layers)) {
        if (o.raycast(raycaster, out) === false) propagate = false;
      }
      if (propagate) for (var i = 0, ch = o.children, l = ch.length; i < l; i++) intersectRec(ch[i], raycaster, out);
    }

    // ── Per-model slot build ──────────────────────────────────────
    function boxOfMesh(o, box, off) {
      var lb = localGeoBox(o.geometry);
      if (!lb) return false;
      writeWorldBox(box, off, o.matrixWorld.elements, lb[0], lb[1], lb[2], lb[3], lb[4], lb[5]);
      return true;
    }
    function boxOfInstance(im, i, lb, box, off) {
      mul4(_mw, im.matrixWorld.elements, 0, im.instanceMatrix.array, i * 16);
      writeWorldBox(box, off, _mw, lb[0], lb[1], lb[2], lb[3], lb[4], lb[5]);
    }
    function boxOfBatchInstance(bm, i, box, off) {
      var info = bm._instanceInfo[i];
      var bb = bm.getBoundingBoxAt(info.geometryIndex, _box3);
      bm.getMatrixAt(i, _m4);
      mul4(_mw, bm.matrixWorld.elements, 0, _m4.elements, 0);
      if (!bb) { writeWorldBox(box, off, _mw, NaN, NaN, NaN, NaN, NaN, NaN); return; }
      writeWorldBox(box, off, _mw, bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z);
    }
    function batchVersion(bm) {
      var t = bm._matricesTexture;
      return (t ? t.version : 0) + ':' + bm._instanceInfo.length + ':' + bm._geometryInfo.length;
    }

    function dropSlot(slot) {
      for (var i = 0; i < slot.listened.length; i++) {
        slot.listened[i].removeEventListener('childadded', slot.onChange);
        slot.listened[i].removeEventListener('childremoved', slot.onChange);
      }
      slot.listened = [];
    }

    function newSlot(top) {
      /** @type {any} */
      var slot = { top: top, idx: 0, dirty: true, listened: [], onChange: null,
        n: 0, objs: [], kind: null, inst: null, dfs: null, box: null,
        always: [], nodeBox: null, nodeA: null, nodeB: null, nodeCount: 0, perm: null,
        watchInst: [], watchMat: [] };
      slot.onChange = function() { slot.dirty = true; };
      return slot;
    }

    function buildSlot(slot) {
      var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      dropSlot(slot);
      var objs = [], kind = [], inst = [], dfs = [];
      var always = [], watchInst = [], watchMat = [], listened = [];
      var counter = 0;
      var stack = [slot.top];
      // Iterative pre-order DFS (children in order) = three's traversal.
      while (stack.length) {
        var o = stack.pop();
        var d = counter++;
        var rc = o.raycast;
        if (o.isBatchedMesh && rc === BatchRaycast) {
          var s0 = objs.length;
          for (var bi = 0, bl = o._instanceInfo.length; bi < bl; bi++) {
            if (!o._instanceInfo[bi].active) continue;
            objs.push(o); kind.push(KIND_BATCH); inst.push(bi); dfs.push(d);
          }
          watchInst.push({ obj: o, batch: true, ver: batchVersion(o), s: s0, e: objs.length });
        } else if (o.isInstancedMesh && rc === InstRaycast) {
          var s1 = objs.length;
          if (o.boundingSphere === null) o.computeBoundingSphere(); // what the first full raycast would do
          if (localGeoBox(o.geometry)) {
            for (var ii = 0; ii < o.count; ii++) { objs.push(o); kind.push(KIND_INST); inst.push(ii); dfs.push(d); }
          } else always.push({ obj: o, dfs: d, self: true }); // own raycast only; children are visited below
          watchInst.push({ obj: o, batch: false, ver: o.instanceMatrix.version, count: o.count, geo: o.geometry, s: s1, e: objs.length });
        } else if (o.isMesh && rc === MeshRaycast && !(o.geometry && o.geometry.morphAttributes && o.geometry.morphAttributes.position) && localGeoBox(o.geometry)) {
          objs.push(o); kind.push(KIND_MESH); inst.push(0); dfs.push(d);
          if (o.matrixAutoUpdate) watchMat.push({ obj: o, snap: Array.prototype.slice.call(o.matrixWorld.elements), e: objs.length - 1, geo: o.geometry });
        } else if (rc !== NoopRaycast) {
          // Line / Points / Sprite / custom raycast / morphs / no position:
          // raycast every query, subtree included, exactly like three.
          always.push({ obj: o, dfs: d, self: false });
          continue;
        }
        if (!o.isMesh || o.children.length) {
          // Containers: their children list and transform are watched.
          o.addEventListener('childadded', slot.onChange);
          o.addEventListener('childremoved', slot.onChange);
          listened.push(o);
          if (!o.isMesh) watchMat.push({ obj: o, snap: Array.prototype.slice.call(o.matrixWorld.elements), e: -1 });
        }
        for (var ci = o.children.length - 1; ci >= 0; ci--) stack.push(o.children[ci]);
      }
      var n = objs.length;
      slot.objs = objs;
      slot.kind = Int8Array.from(kind);
      slot.inst = Int32Array.from(inst);
      slot.dfs = Int32Array.from(dfs);
      slot.n = n;
      slot.always = always;
      slot.watchInst = watchInst;
      slot.watchMat = watchMat;
      slot.listened = listened;
      slot.box = new Float32Array(6 * n);
      for (var w = 0; w < watchInst.length; w++) computeObjBoxes(slot, watchInst[w]);
      for (var e = 0; e < n; e++) if (slot.kind[e] === KIND_MESH) boxOfMesh(objs[e], slot.box, e * 6);
      buildBVH(slot);
      slot.dirty = false;
      _stats.builds++;
      var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      _stats.buildMs += t1 - t0;
    }

    function computeObjBoxes(slot, w) {
      var o = w.obj, box = slot.box;
      if (w.batch) {
        for (var e = w.s; e < w.e; e++) boxOfBatchInstance(o, slot.inst[e], box, e * 6);
      } else {
        var lb = localGeoBox(o.geometry);
        if (!lb) return;
        for (var e2 = w.s; e2 < w.e; e2++) boxOfInstance(o, slot.inst[e2], lb, box, e2 * 6);
      }
    }

    // Median-split BVH over centroids (quickselect on the widest axis).
    function buildBVH(slot) {
      var n = slot.n, box = slot.box;
      var cap = Math.max(1, 2 * Math.ceil(n / (LEAF / 2)) + 1);
      var nodeBox = new Float32Array(6 * cap), nodeA = new Int32Array(cap), nodeB = new Int32Array(cap);
      var perm = new Uint32Array(n);
      var cen = new Float64Array(3 * n);
      for (var i = 0; i < n; i++) {
        perm[i] = i;
        var o = i * 6;
        // Unbounded boxes sort as if at the origin.
        cen[i * 3] = isFinite(box[o]) ? (box[o] + box[o + 3]) / 2 : 0;
        cen[i * 3 + 1] = isFinite(box[o + 1]) ? (box[o + 1] + box[o + 4]) / 2 : 0;
        cen[i * 3 + 2] = isFinite(box[o + 2]) ? (box[o + 2] + box[o + 5]) / 2 : 0;
      }
      var count = 0;
      if (n > 0) {
        count = 1;
        var st = [0, 0, n];
        while (st.length) {
          var e = st.pop(), s = st.pop(), ni = st.pop();
          if (e - s <= LEAF) { nodeA[ni] = s; nodeB[ni] = -(e - s); continue; }
          var lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
          for (var j = s; j < e; j++) {
            var c = perm[j] * 3, x = cen[c], y = cen[c + 1], z = cen[c + 2];
            if (x < lx) lx = x; if (x > hx) hx = x;
            if (y < ly) ly = y; if (y > hy) hy = y;
            if (z < lz) lz = z; if (z > hz) hz = z;
          }
          var ax = 0, ext = hx - lx;
          if (hy - ly > ext) { ax = 1; ext = hy - ly; }
          if (hz - lz > ext) { ax = 2; }
          var mid = (s + e) >> 1;
          select(perm, cen, ax, s, e - 1, mid);
          var l = count++, r = count++;
          nodeA[ni] = l; nodeB[ni] = r;
          st.push(r, mid, e, l, s, mid);
        }
      }
      slot.nodeBox = nodeBox; slot.nodeA = nodeA; slot.nodeB = nodeB; slot.nodeCount = count; slot.perm = perm;
      refitBVH(slot);
    }

    function select(perm, cen, ax, lo, hi, k) {
      while (hi > lo) {
        var pv = cen[perm[(lo + hi) >> 1] * 3 + ax];
        var i = lo, j = hi;
        while (i <= j) {
          while (cen[perm[i] * 3 + ax] < pv) i++;
          while (cen[perm[j] * 3 + ax] > pv) j--;
          if (i <= j) { var t = perm[i]; perm[i] = perm[j]; perm[j] = t; i++; j--; }
        }
        if (k <= j) hi = j;
        else if (k >= i) lo = i;
        else return;
      }
    }

    // Children always have larger indices than their parent: one reverse
    // sweep recomputes every node box.
    function refitBVH(slot) {
      var nb = slot.nodeBox, A = slot.nodeA, B = slot.nodeB, box = slot.box, perm = slot.perm;
      for (var ni = slot.nodeCount - 1; ni >= 0; ni--) {
        var lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity, o, k;
        if (B[ni] < 0) {
          for (k = A[ni], o = A[ni] - B[ni]; k < o; k++) {
            var q = perm[k] * 6;
            if (box[q] < lx) lx = box[q]; if (box[q + 1] < ly) ly = box[q + 1]; if (box[q + 2] < lz) lz = box[q + 2];
            if (box[q + 3] > hx) hx = box[q + 3]; if (box[q + 4] > hy) hy = box[q + 4]; if (box[q + 5] > hz) hz = box[q + 5];
          }
        } else {
          for (var cc = 0; cc < 2; cc++) {
            var c6 = (cc ? B[ni] : A[ni]) * 6;
            if (nb[c6] < lx) lx = nb[c6]; if (nb[c6 + 1] < ly) ly = nb[c6 + 1]; if (nb[c6 + 2] < lz) lz = nb[c6 + 2];
            if (nb[c6 + 3] > hx) hx = nb[c6 + 3]; if (nb[c6 + 4] > hy) hy = nb[c6 + 4]; if (nb[c6 + 5] > hz) hz = nb[c6 + 5];
          }
        }
        var n6 = ni * 6;
        nb[n6] = lx; nb[n6 + 1] = ly; nb[n6 + 2] = lz; nb[n6 + 3] = hx; nb[n6 + 4] = hy; nb[n6 + 5] = hz;
      }
    }

    // ── Sync ──────────────────────────────────────────────────────
    function dropAll() {
      for (var i = 0; i < _slots.length; i++) dropSlot(_slots[i]);
      _slots = []; _slotOf = new Map();
    }

    function sync(rootObj) {
      if (rootObj !== _root) { dropAll(); _root = rootObj; _rootMw = null; }
      if (!rootObj) return;
      if (_rootMw && !sameMatrix(_rootMw, rootObj.matrixWorld.elements)) _allDirty = true;
      if (_allDirty) { dropAll(); _allDirty = false; }
      _rootMw = Array.prototype.slice.call(rootObj.matrixWorld.elements);
      var ch = rootObj.children, same = ch.length === _slots.length;
      for (var i = 0; same && i < ch.length; i++) if (_slots[i].top !== ch[i]) same = false;
      if (!same) {
        var next = [], nextOf = new Map();
        for (var j = 0; j < ch.length; j++) {
          var sl = _slotOf.get(ch[j]) || newSlot(ch[j]);
          next.push(sl); nextOf.set(ch[j], sl);
        }
        _slotOf.forEach(function(sl2, top) { if (!nextOf.has(top)) dropSlot(sl2); });
        _slots = next; _slotOf = nextOf;
      }
      for (var k = 0; k < _slots.length; k++) {
        var slot = _slots[k];
        slot.idx = k;
        if (!slot.dirty) checkSlot(slot);
        if (slot.dirty) buildSlot(slot);
      }
    }

    function checkSlot(slot) {
      var refit = false, w, i;
      for (i = 0; i < slot.watchMat.length; i++) {
        w = slot.watchMat[i];
        var same = sameMatrix(w.snap, w.obj.matrixWorld.elements);
        if (w.e < 0) { if (same) continue; slot.dirty = true; return; }
        if (w.obj.geometry !== w.geo) { slot.dirty = true; return; }
        if (same) continue;
        boxOfMesh(w.obj, slot.box, w.e * 6);
        w.snap = Array.prototype.slice.call(w.obj.matrixWorld.elements);
        refit = true;
      }
      for (i = 0; i < slot.watchInst.length; i++) {
        w = slot.watchInst[i];
        var o = w.obj;
        if (w.batch) {
          var v = batchVersion(o);
          if (v === w.ver) continue;
          var parts = v.split(':'), old = String(w.ver).split(':');
          if (parts[1] !== old[1] || parts[2] !== old[2]) { slot.dirty = true; return; }
          w.ver = v;
        } else {
          if (o.count !== w.count || o.geometry !== w.geo) { slot.dirty = true; return; }
          if (o.instanceMatrix.version === w.ver) continue;
          w.ver = o.instanceMatrix.version;
        }
        computeObjBoxes(slot, w);
        refit = true;
      }
      if (refit) { refitBVH(slot); _stats.refits++; }
    }

    // ── Queries ───────────────────────────────────────────────────
    function rayParams(raycaster) {
      var r = raycaster.ray, d = r.direction;
      var dlen = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z);
      if (!(dlen > 0) || !isFinite(dlen)) return null;
      var far = raycaster.far, near = raycaster.near;
      return {
        ox: r.origin.x, oy: r.origin.y, oz: r.origin.z, dx: d.x, dy: d.y, dz: d.z,
        ix: 1 / d.x, iy: 1 / d.y, iz: 1 / d.z, dlen: dlen,
        tMax: far === Infinity ? Infinity : far / dlen, near: near
      };
    }

    function raycastEntry(slot, e, raycaster, out) {
      var o = slot.objs[e], k = slot.kind[e];
      if (k === KIND_MESH) o.raycast(raycaster, out);
      else if (k === KIND_INST) raycastInstance(o, slot.inst[e], raycaster, out);
      else raycastBatchInstance(o, slot.inst[e], raycaster, out);
    }

    // Visit candidate entries in increasing box-entry distance.
    // visit(slot, e, key) returns false to stop; needKey(key) false stops too.
    function traverse(raycaster, rp, needKey, visit) {
      var hp = _heapPool.pop() || new Heap();
      hp.n = 0;
      var nodes = 0, cands = 0;
      try {
        for (var s = 0; s < _slots.length; s++) {
          var sl = _slots[s];
          if (!sl.nodeCount) continue;
          var t = rayBox(sl.nodeBox, 0, rp.ox, rp.oy, rp.oz, rp.dx, rp.dy, rp.dz, rp.ix, rp.iy, rp.iz, rp.tMax);
          if (t < 0 || _exitT * rp.dlen < rp.near) continue;
          hp.push(t * rp.dlen, s, 0);
        }
        while (hp.n > 0) {
          var key = hp.key[0];
          if (!needKey(key)) break;
          hp.pop();
          var ps = hp.popSlot, id = hp.popId, slot = _slots[ps];
          if (id >= 0) {
            nodes++;
            var A = slot.nodeA[id], B = slot.nodeB[id];
            if (B < 0) {
              for (var q = A, qe = A - B; q < qe; q++) {
                var ent = slot.perm[q];
                var te = rayBox(slot.box, ent * 6, rp.ox, rp.oy, rp.oz, rp.dx, rp.dy, rp.dz, rp.ix, rp.iy, rp.iz, rp.tMax);
                if (te < 0 || _exitT * rp.dlen < rp.near) continue;
                hp.push(te * rp.dlen, ps, -(ent + 1));
              }
            } else {
              var tl = rayBox(slot.nodeBox, A * 6, rp.ox, rp.oy, rp.oz, rp.dx, rp.dy, rp.dz, rp.ix, rp.iy, rp.iz, rp.tMax);
              if (tl >= 0 && _exitT * rp.dlen >= rp.near) hp.push(tl * rp.dlen, ps, A);
              var tr = rayBox(slot.nodeBox, B * 6, rp.ox, rp.oy, rp.oz, rp.dx, rp.dy, rp.dz, rp.ix, rp.iy, rp.iz, rp.tMax);
              if (tr >= 0 && _exitT * rp.dlen >= rp.near) hp.push(tr * rp.dlen, ps, B);
            }
          } else {
            cands++;
            if (visit(slot, -id - 1, key) === false) break;
          }
        }
      } finally {
        hp.n = 0;
        _heapPool.push(hp);
      }
      _stats.lastQueryNodes = nodes;
      _stats.lastQueryCandidates = cands;
    }

    /**
     * All hits, identical to raycaster.intersectObjects(root.children, true).
     */
    function intersect(raycaster, rootObj) {
      sync(rootObj);
      var rp = rayParams(raycaster);
      if (!rp) return raycaster.intersectObjects(rootObj.children, true);
      var recs = [], buf = [];
      for (var s = 0; s < _slots.length; s++) {
        var sl = _slots[s];
        for (var a = 0; a < sl.always.length; a++) {
          var al = sl.always[a];
          buf.length = 0;
          if (al.self) { if (al.obj.layers.test(raycaster.layers)) al.obj.raycast(raycaster, buf); }
          else intersectRec(al.obj, raycaster, buf);
          for (var k = 0; k < buf.length; k++) recs.push({ h: buf[k], d: buf[k].distance, t: s, f: al.dfs, i: 0, k: k });
        }
      }
      traverse(raycaster, rp, function() { return true; }, function(slot, e) {
        var o = slot.objs[e];
        if (!o.layers.test(raycaster.layers)) return true;
        buf.length = 0;
        raycastEntry(slot, e, raycaster, buf);
        for (var k2 = 0; k2 < buf.length; k2++) recs.push({ h: buf[k2], d: buf[k2].distance, t: slot.idx, f: slot.dfs[e], i: slot.inst[e], k: k2 });
        return true;
      });
      recs.sort(function(x, y) {
        if (x.d !== y.d) return x.d - y.d;
        if (x.t !== y.t) return x.t - y.t;
        if (x.f !== y.f) return x.f - y.f;
        if (x.i !== y.i) return x.i - y.i;
        return x.k - y.k;
      });
      var out = new Array(recs.length);
      for (var r = 0; r < recs.length; r++) out[r] = recs[r].h;
      return out;
    }

    /**
     * First hit per predicate, in three's order. preds[p] = {accept?(hit),
     * skip?(object)} — skip(o) true means accept() is false for every hit
     * on o (lets whole hidden/ghosted objects be skipped unraycast).
     * Returns an array (one hit or null per predicate).
     */
    function first(raycaster, rootObj, preds) {
      sync(rootObj);
      var P = preds.length, best = new Array(P), p;
      for (p = 0; p < P; p++) best[p] = null;
      var rp = rayParams(raycaster);
      if (!rp) return bruteFirst(raycaster, rootObj, preds);
      var buf = [];
      function consider(h, t, f, i, k, active) {
        for (var q = 0; q < P; q++) {
          if (!active[q]) continue;
          var pr = preds[q];
          if (pr.skip && pr.skip(h.object)) continue;
          if (pr.accept && !pr.accept(h)) continue;
          if (!best[q] || before(h.distance, t, f, i, k, best[q])) best[q] = { h: h, d: h.distance, t: t, f: f, i: i, k: k };
        }
      }
      var allOn = new Array(P);
      for (p = 0; p < P; p++) allOn[p] = true;
      for (var s = 0; s < _slots.length; s++) {
        var sl = _slots[s];
        for (var a = 0; a < sl.always.length; a++) {
          var al = sl.always[a];
          buf.length = 0;
          if (al.self) { if (al.obj.layers.test(raycaster.layers)) al.obj.raycast(raycaster, buf); }
          else intersectRec(al.obj, raycaster, buf);
          for (var k = 0; k < buf.length; k++) consider(buf[k], s, al.dfs, 0, k, allOn);
        }
      }
      var active = new Array(P), skipObj = new Array(P), skipVal = new Array(P);
      traverse(raycaster, rp, function(key) {
        for (var q = 0; q < P; q++) if (!best[q] || key <= best[q].d) return true;
        return false;
      }, function(slot, e, key) {
        var o = slot.objs[e];
        if (!o.layers.test(raycaster.layers)) return true;
        var any = false;
        for (var q = 0; q < P; q++) {
          active[q] = false;
          if (best[q] && key > best[q].d) continue;
          var pr = preds[q];
          if (pr.skip) {
            if (skipObj[q] !== o) { skipObj[q] = o; skipVal[q] = !!pr.skip(o); }
            if (skipVal[q]) continue;
          }
          active[q] = true; any = true;
        }
        if (!any) return true;
        buf.length = 0;
        raycastEntry(slot, e, raycaster, buf);
        for (var k2 = 0; k2 < buf.length; k2++) consider(buf[k2], slot.idx, slot.dfs[e], slot.inst[e], k2, active);
        return true;
      });
      var out = new Array(P);
      for (p = 0; p < P; p++) out[p] = best[p] ? best[p].h : null;
      return out;
    }

    function bruteFirst(raycaster, rootObj, preds) {
      var hits = raycaster.intersectObjects(rootObj.children, true);
      var out = new Array(preds.length);
      for (var p = 0; p < preds.length; p++) {
        out[p] = null;
        var pr = preds[p];
        for (var i = 0; i < hits.length; i++) {
          if (pr.skip && pr.skip(hits[i].object)) continue;
          if (pr.accept && !pr.accept(hits[i])) continue;
          out[p] = hits[i]; break;
        }
      }
      return out;
    }

    /** True when obj is a leaf object the index can isolate (first({skip: o !== obj})). */
    function indexes(obj) {
      for (var i = 0; i < _slots.length; i++) {
        var sl = _slots[i];
        for (var a = 0; a < sl.always.length; a++) {
          var r = sl.always[a].obj;
          for (var x = obj; x; x = x.parent) if (x === r) return false;
        }
      }
      return true;
    }

    return {
      sync: sync,
      intersect: intersect,
      first: first,
      bruteFirst: bruteFirst,
      indexes: indexes,
      invalidate: function() { _allDirty = true; },
      stats: function() {
        var entries = 0, nodes = 0, always = 0;
        for (var i = 0; i < _slots.length; i++) { entries += _slots[i].n; nodes += _slots[i].nodeCount; always += _slots[i].always.length; }
        return { slots: _slots.length, entries: entries, nodes: nodes, always: always,
          builds: _stats.builds, refits: _stats.refits, buildMs: _stats.buildMs,
          lastQueryCandidates: _stats.lastQueryCandidates, lastQueryNodes: _stats.lastQueryNodes };
      },
      dispose: function() { dropAll(); _root = null; }
    };
  }

  return { create: create, rayBox: rayBox, writeWorldBox: writeWorldBox, LEAF: LEAF, PAD_REL: PAD_REL };
}));
