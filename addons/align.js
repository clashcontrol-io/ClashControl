// ClashControl — point-cloud ↔ IFC alignment addon
// =================================================
//
// Manual 3-point rigid alignment between a loaded point cloud and the
// IFC model. The user picks 3 reference points on the IFC, then the 3
// matching points on the scan; we compute the rigid (rotation +
// translation) transform that maps the scan into the IFC's coordinate
// frame and apply it imperatively to the THREE.Points object.
//
// Why this matters:
//   Point cloud ↔ IFC alignment is the foundational workflow for
//   as-built verification. Without it, you can't compare "what was built"
//   against "what was designed". OpenAEC Foundation's open-pointcloud-
//   studio doesn't ship this yet (as of issue audit) — owning the
//   workflow first inside ClashControl plants a flag.
//
// Why three pairs:
//   Three non-collinear correspondences uniquely determine a rigid
//   transform (rotation + translation) between two coordinate frames.
//   No SVD or iterative solver needed — direct orthonormal-frame
//   construction does the job in closed form. The same code generalises
//   to N>3 later via a Kabsch / Procrustes refit, but the 3-pair MVP
//   ships clean and useful today.
//
// Future phases (NOT in this MVP):
//   - ICP refinement after the manual seed
//   - Deviation heatmap: distance from each scan point to the nearest
//     IFC surface, coloured red→green
//   - Auto-issue creation at deviation hotspots above a threshold
//   - Multi-scan alignment (each scan its own transform)
//
// State on the THREE.Points object:
//   pts.userData.alignment = {
//     applied:    Matrix4 (latest transform applied to .position/.rotation/.scale)
//     pairs:      [{ifc:[x,y,z], scan:[x,y,z]}, ...]
//     timestamp:  ISO string
//   }
// Saved to localStorage keyed by the cloud's file name so it survives a
// reload of the same project.

(function(){
  if (typeof window === 'undefined') return;
  var THREE = window.THREE;
  if (!THREE) {
    // Re-try after Three.js is ready — addon scripts may load before the core.
    var _retry = setInterval(function(){
      if (window.THREE) { clearInterval(_retry); _init(); }
    }, 100);
  } else { _init(); }

  function _init() {
    THREE = window.THREE;

    var _pickActive = false;     // true while in pick mode
    var _targetId   = null;      // splat / point-cloud id we're aligning
    var _ifcPicks   = [];        // [Vector3, Vector3, Vector3]
    var _scanPicks  = [];        // [Vector3, Vector3, Vector3]
    var _markers    = [];        // helper meshes shown in the scene
    var _phase      = 'ifc';     // 'ifc' or 'scan' — which side we're picking next
    var _onChange   = [];        // listeners for status changes
    var STORAGE_KEY_PREFIX = 'cc_align_';

    // ── State helpers ─────────────────────────────────────────────
    function _scene() { var S3 = window._ccState3d; return S3 && S3.scene ? S3.scene : null; }
    function _invalidate(n) { if (typeof window._ccInvalidate === 'function') window._ccInvalidate(n||2); }
    function _toast(msg) { if (window._ccToast) try { window._ccToast(msg); } catch(_){} }
    function _emit(state) { _onChange.forEach(function(cb){ try { cb(state); } catch(_){} }); }
    function _status() {
      return {
        active: _pickActive,
        targetId: _targetId,
        phase: _phase,
        ifcPickCount: _ifcPicks.length,
        scanPickCount: _scanPicks.length,
        needed: 3
      };
    }

    // Lookup the target THREE.Points or SplatMesh by id (refId for point
    // clouds set by addons/pointcloud.js, _ccSplatId for splats set by
    // addons/splat.js, or a Three uuid for either).
    function _findTarget(id) {
      var sc = _scene(); if (!sc) return null;
      var refs = sc.getObjectByName('cc-reference-layers');
      if (refs) {
        for (var i = 0; i < refs.children.length; i++) {
          var o = refs.children[i];
          if (o.userData && (o.userData.refId === id || o.userData._ccLayerId === id) || o.uuid === id) return o;
        }
      }
      var splats = sc.getObjectByName('cc-splat-layers');
      if (splats) {
        for (var j = 0; j < splats.children.length; j++) {
          var s = splats.children[j];
          if (s.userData && (s.userData._ccSplatId === id) || s.uuid === id) return s;
        }
      }
      return null;
    }

    // ── 3-pair rigid transform (closed-form, no SVD) ──────────────
    // Maps the source triangle (srcA, srcB, srcC) onto the destination
    // triangle (dstA, dstB, dstC) by:
    //   1. Centering both triangles on their centroids.
    //   2. Building an orthonormal frame per triangle:
    //        x = (B-A) normalised
    //        n = (B-A) × (C-A) normalised  (triangle normal)
    //        y = n × x                     (in-plane, perpendicular to x)
    //   3. Source basis Mp and destination basis Md each have these
    //      three columns. Both are orthonormal, so R = Md · Mp^T
    //      (Mp transposed = Mp inverted for orthonormal matrices).
    //   4. t = dst_centroid − R · src_centroid.
    //
    // Returns a Matrix4 representing the composed rigid transform that,
    // when applied to a point in the source frame, produces its
    // corresponding point in the destination frame.
    function _rigidFromThreePairs(srcA, srcB, srcC, dstA, dstB, dstC) {
      var sc = new THREE.Vector3().add(srcA).add(srcB).add(srcC).multiplyScalar(1/3);
      var dc = new THREE.Vector3().add(dstA).add(dstB).add(dstC).multiplyScalar(1/3);

      function frame(p, q, r) {
        var ex = new THREE.Vector3().subVectors(q, p).normalize();
        var pq = new THREE.Vector3().subVectors(q, p);
        var pr = new THREE.Vector3().subVectors(r, p);
        var en = new THREE.Vector3().crossVectors(pq, pr).normalize();
        var ey = new THREE.Vector3().crossVectors(en, ex).normalize();
        return { ex: ex, ey: ey, en: en };
      }
      var sF = frame(srcA, srcB, srcC);
      var dF = frame(dstA, dstB, dstC);

      // Source basis matrix: columns are sF.ex, sF.ey, sF.en
      var Mp = new THREE.Matrix4().makeBasis(sF.ex, sF.ey, sF.en);
      var Md = new THREE.Matrix4().makeBasis(dF.ex, dF.ey, dF.en);
      // R = Md · Mp^T  (Mp orthonormal → transpose = inverse)
      var R = new THREE.Matrix4().multiplyMatrices(Md, Mp.clone().transpose());

      // t = dc − R · sc
      var t = sc.clone().applyMatrix4(R).negate().add(dc);

      var T = R.clone();
      T.setPosition(t);
      return T;
    }

    // Residual check: how well does the computed transform fit the input
    // pairs? Returns max distance (metres) between transformed source
    // points and the destination points. >0.05 m → user picks were noisy.
    function _residual(M, pairs) {
      var worst = 0;
      for (var i = 0; i < pairs.length; i++) {
        var p = new THREE.Vector3().fromArray(pairs[i].ifc).applyMatrix4(M);
        var q = new THREE.Vector3().fromArray(pairs[i].scan);
        var d = p.distanceTo(q);
        if (d > worst) worst = d;
      }
      return worst;
    }

    // ── Pick-marker helpers ───────────────────────────────────────
    var _markerMatIFC  = null, _markerMatScan = null;
    function _markerMat(kind) {
      if (kind === 'ifc') {
        if (!_markerMatIFC) _markerMatIFC = new THREE.MeshBasicMaterial({color:0x22c55e, depthTest:false, transparent:true, opacity:0.95});
        return _markerMatIFC;
      }
      if (!_markerMatScan) _markerMatScan = new THREE.MeshBasicMaterial({color:0xf59e0b, depthTest:false, transparent:true, opacity:0.95});
      return _markerMatScan;
    }
    function _placeMarker(pos, kind, label) {
      var sc = _scene(); if (!sc) return null;
      var geo = new THREE.SphereGeometry(0.08, 12, 12);
      var m = new THREE.Mesh(geo, _markerMat(kind));
      m.position.copy(pos);
      m.renderOrder = 999;
      m.userData._alignMarker = true;
      sc.add(m);
      _markers.push(m);
      _invalidate(3);
      return m;
    }
    function _clearMarkers() {
      var sc = _scene(); if (!sc) return;
      _markers.forEach(function(m){
        sc.remove(m);
        if (m.geometry) m.geometry.dispose();
      });
      _markers = [];
      _invalidate(2);
    }

    // ── Pick mode handler ─────────────────────────────────────────
    // Pointer events are captured on the renderer canvas. We expect the
    // core picker to publish hit points via _ccLastPick, but if not
    // available we raycast ourselves against the loaded models.
    var _onCanvasClick = null;
    function _attachPicker() {
      var S3 = window._ccState3d;
      if (!S3 || !S3.renderer || !S3.camera || !S3.scene) {
        _toast('Viewer not ready for alignment yet');
        return false;
      }
      var dom = S3.renderer.domElement;
      var rc  = new THREE.Raycaster();
      var pt  = new THREE.Vector2();

      _onCanvasClick = function(ev) {
        if (!_pickActive) return;
        var r = dom.getBoundingClientRect();
        pt.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
        pt.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
        rc.setFromCamera(pt, S3.camera);

        var hit = null;
        if (_phase === 'ifc') {
          // Hit-test the model group only (IFC meshes live under S.mg).
          var mg = S3.mg;
          if (mg) {
            var hits = rc.intersectObjects(mg.children, true);
            // Skip alignment markers we placed earlier
            for (var i = 0; i < hits.length; i++) {
              if (hits[i].object.userData && hits[i].object.userData._alignMarker) continue;
              hit = hits[i].point.clone();
              break;
            }
          }
        } else {
          // Hit-test the point cloud target. THREE.Points raycasting needs
          // the params.Points.threshold set to a sensible radius — the
          // default 1 is too large for scaled cloud rendering.
          var tgt = _findTarget(_targetId);
          if (!tgt) { _toast('Scan target not found'); _cancel(); return; }
          // Configure Points raycaster threshold based on the cloud's
          // bbox diagonal so we stay snappy on small + large scans.
          var bb = tgt.geometry && tgt.geometry.boundingBox;
          var diag = bb ? bb.getSize(new THREE.Vector3()).length() : 10;
          rc.params.Points = rc.params.Points || {};
          rc.params.Points.threshold = Math.max(0.05, diag * 0.005);
          var pHits = rc.intersectObject(tgt, false);
          if (pHits.length) hit = pHits[0].point.clone();
        }

        if (!hit) { _toast('No surface under the cursor — try again'); return; }

        ev.preventDefault();
        ev.stopPropagation();

        if (_phase === 'ifc') {
          _ifcPicks.push(hit);
          _placeMarker(hit, 'ifc');
          _phase = 'scan';
          _toast('IFC point ' + _ifcPicks.length + '/3 captured — now click the matching point on the scan');
        } else {
          _scanPicks.push(hit);
          _placeMarker(hit, 'scan');
          if (_ifcPicks.length < 3) {
            _phase = 'ifc';
            _toast('Pair ' + _scanPicks.length + '/3 captured — pick the next IFC reference');
          } else {
            _toast('All 3 pairs captured — computing alignment…');
            _finishAlignment();
            return;
          }
        }
        _emit(_status());
      };

      dom.addEventListener('click', _onCanvasClick, true);
      return true;
    }
    function _detachPicker() {
      var S3 = window._ccState3d;
      if (S3 && S3.renderer && _onCanvasClick) {
        S3.renderer.domElement.removeEventListener('click', _onCanvasClick, true);
      }
      _onCanvasClick = null;
    }

    // ── Public API: start / cancel / clear ───────────────────────
    window._ccAlignStart = function(targetId) {
      if (_pickActive) { _toast('Alignment already in progress'); return false; }
      var tgt = _findTarget(targetId);
      if (!tgt) { _toast('Pick a loaded scan first'); return false; }
      _targetId = targetId;
      _ifcPicks = []; _scanPicks = []; _phase = 'ifc';
      _pickActive = true;
      if (!_attachPicker()) { _pickActive = false; return false; }
      _toast('Alignment: pick reference point 1/3 on the IFC');
      _emit(_status());
      return true;
    };
    function _cancel() {
      _pickActive = false;
      _detachPicker();
      _clearMarkers();
      _ifcPicks = []; _scanPicks = []; _phase = 'ifc'; _targetId = null;
      _emit(_status());
    }
    window._ccAlignCancel = _cancel;

    // ── Deviation heatmap (Phase 2 follow-up to alignment) ───────
    // For each scan point we compute the distance to the nearest IFC
    // element bounding box and recolour the cloud red→amber→green by
    // that distance. Triangle-accurate distance is more expensive and
    // lands in a later phase; bbox-distance already gives a useful
    // first pass — "this region of the scan is or isn't close to any
    // design geometry" — which is the visual the OpenAEC demo wants.
    //
    // Spatial acceleration: bin IFC elements into a uniform grid by
    // their bbox centre. For each scan point we probe the cell and
    // its 26 neighbours. Cell size = median element size so each cell
    // holds a roughly constant element count.
    //
    // Public API:
    //   _ccDeviationCompute(targetId, opts)  → Promise<{stats}>
    //     opts.greenAt  metres at and below which a point is green   (default 0.02)
    //     opts.redAt    metres at and above which a point is red     (default 0.10)
    //   _ccDeviationClear(targetId)
    var _deviationOriginal = {}; // targetId → original color attribute (for restore)
    var COLOR_GOOD = [0.13, 0.77, 0.37];  // green
    var COLOR_WARN = [0.96, 0.62, 0.04];  // amber
    var COLOR_BAD  = [0.93, 0.27, 0.27];  // red

    function _interpColor(t) {
      // 0 → green, 0.5 → amber, 1 → red
      if (t < 0.5) {
        var k = t * 2;
        return [
          COLOR_GOOD[0]*(1-k) + COLOR_WARN[0]*k,
          COLOR_GOOD[1]*(1-k) + COLOR_WARN[1]*k,
          COLOR_GOOD[2]*(1-k) + COLOR_WARN[2]*k
        ];
      }
      var k2 = (t - 0.5) * 2;
      return [
        COLOR_WARN[0]*(1-k2) + COLOR_BAD[0]*k2,
        COLOR_WARN[1]*(1-k2) + COLOR_BAD[1]*k2,
        COLOR_WARN[2]*(1-k2) + COLOR_BAD[2]*k2
      ];
    }

    function _collectIfcBoxes() {
      var s = window._ccLatestState;
      if (!s || !s.models || !s.models.length) return null;
      var boxes = []; // {cx,cy,cz,hx,hy,hz,size}
      var diagSum = 0, diagN = 0;
      s.models.forEach(function(m){
        if (m.visible === false) return;
        (m.elements || []).forEach(function(el){
          if (!el.box) return;
          var bmin = el.box.min, bmax = el.box.max;
          var hx = (bmax.x - bmin.x) * 0.5;
          var hy = (bmax.y - bmin.y) * 0.5;
          var hz = (bmax.z - bmin.z) * 0.5;
          var size = Math.max(hx, hy, hz);
          if (!isFinite(size) || size <= 0) return;
          boxes.push({
            cx: (bmin.x + bmax.x) * 0.5,
            cy: (bmin.y + bmax.y) * 0.5,
            cz: (bmin.z + bmax.z) * 0.5,
            hx: hx, hy: hy, hz: hz
          });
          diagSum += Math.sqrt(hx*hx + hy*hy + hz*hz);
          diagN++;
        });
      });
      if (!boxes.length) return null;
      var meanDiag = diagSum / diagN;
      return { boxes: boxes, meanDiag: meanDiag };
    }

    // Distance from a point to an AABB defined by centre + half-extents.
    // Standard separating-axis formulation: clamp per axis, return the
    // Euclidean distance of the residual.
    function _pointToBoxDistance(px, py, pz, b) {
      var dx = Math.max(0, Math.abs(px - b.cx) - b.hx);
      var dy = Math.max(0, Math.abs(py - b.cy) - b.hy);
      var dz = Math.max(0, Math.abs(pz - b.cz) - b.hz);
      return Math.sqrt(dx*dx + dy*dy + dz*dz);
    }

    function _buildGrid(boxes, cellSize) {
      var grid = Object.create(null);
      for (var i = 0; i < boxes.length; i++) {
        var b = boxes[i];
        var gx = Math.floor(b.cx / cellSize);
        var gy = Math.floor(b.cy / cellSize);
        var gz = Math.floor(b.cz / cellSize);
        var k = gx + ',' + gy + ',' + gz;
        (grid[k] || (grid[k] = [])).push(b);
      }
      return grid;
    }

    window._ccDeviationCompute = function(targetId, opts) {
      opts = opts || {};
      var greenAt = opts.greenAt != null ? opts.greenAt : 0.02; // ≤ 2 cm → green
      var redAt   = opts.redAt   != null ? opts.redAt   : 0.10; // ≥ 10 cm → red
      var tgt = _findTarget(targetId);
      if (!tgt || !tgt.geometry) return Promise.reject(new Error('Scan target not found'));
      var ifc = _collectIfcBoxes();
      if (!ifc) return Promise.reject(new Error('No IFC elements loaded — cannot compute deviation'));

      var geom = tgt.geometry;
      var pos = geom.getAttribute('position');
      if (!pos) return Promise.reject(new Error('Scan has no positions'));
      var N = pos.count;

      // Stash the original colour attribute so _ccDeviationClear can
      // restore it. If the scan had no colours we just delete on clear.
      var origCol = geom.getAttribute('color');
      _deviationOriginal[targetId] = origCol ? origCol.clone() : null;

      // Build the spatial grid sized to the median element diagonal so
      // each cell holds O(1) candidate elements on average.
      var cellSize = Math.max(0.5, ifc.meanDiag * 2);
      var grid = _buildGrid(ifc.boxes, cellSize);

      // Transform the scan's local positions into world coords so the
      // deviation matches the user's eye — the cloud may have been
      // aligned/translated and its local frame differs from IFC space.
      tgt.updateMatrixWorld(true);
      var M = tgt.matrixWorld;
      var v = new THREE.Vector3();

      // Output colour buffer
      var col = new Float32Array(N * 3);

      // Stats
      var minD = Infinity, maxD = 0, sumD = 0;
      var nGreen = 0, nAmber = 0, nRed = 0;

      // Time-slice the work so we don't lock the UI on big scans.
      var batchSize = 100000;
      var i = 0;
      return new Promise(function(resolve) {
        function _step() {
          var end = Math.min(N, i + batchSize);
          for (; i < end; i++) {
            v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(M);
            var px = v.x, py = v.y, pz = v.z;
            var gx = Math.floor(px / cellSize);
            var gy = Math.floor(py / cellSize);
            var gz = Math.floor(pz / cellSize);
            // Probe the 3×3×3 cell neighbourhood
            var best = Infinity;
            for (var ox = -1; ox <= 1; ox++) for (var oy = -1; oy <= 1; oy++) for (var oz = -1; oz <= 1; oz++) {
              var k = (gx+ox) + ',' + (gy+oy) + ',' + (gz+oz);
              var bucket = grid[k];
              if (!bucket) continue;
              for (var j = 0; j < bucket.length; j++) {
                var d = _pointToBoxDistance(px, py, pz, bucket[j]);
                if (d < best) best = d;
                if (best === 0) break;
              }
              if (best === 0) break;
            }
            if (best === Infinity) best = redAt; // no nearby element — count as worst
            if (best < minD) minD = best;
            if (best > maxD) maxD = best;
            sumD += best;
            // Map distance to colour
            var t;
            if (best <= greenAt) { t = 0; nGreen++; }
            else if (best >= redAt) { t = 1; nRed++; }
            else { t = (best - greenAt) / (redAt - greenAt); nAmber++; }
            var c = _interpColor(t);
            col[i*3] = c[0]; col[i*3+1] = c[1]; col[i*3+2] = c[2];
          }
          if (i < N) {
            // Yield to the event loop so the UI stays responsive.
            setTimeout(_step, 0);
            return;
          }
          // Done — install the colour attribute and switch the material
          // to vertex colours.
          geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
          if (tgt.material) {
            tgt.material.vertexColors = true;
            tgt.material.color = new THREE.Color(0xffffff); // let vertex colours win
            tgt.material.needsUpdate = true;
          }
          _invalidate(3);
          var stats = {
            min: minD, max: maxD, mean: sumD / N,
            greenCount: nGreen, amberCount: nAmber, redCount: nRed,
            total: N, greenAt: greenAt, redAt: redAt
          };
          if (tgt.userData) tgt.userData.deviation = stats;
          _toast('Deviation: min ' + minD.toFixed(3) + ' m · mean ' + (sumD/N).toFixed(3) + ' m · max ' + maxD.toFixed(3) + ' m');
          resolve(stats);
        }
        _step();
      });
    };

    window._ccDeviationClear = function(targetId) {
      var tgt = _findTarget(targetId);
      if (!tgt || !tgt.geometry) return false;
      var orig = _deviationOriginal[targetId];
      if (orig) {
        tgt.geometry.setAttribute('color', orig);
        if (tgt.material) { tgt.material.vertexColors = true; tgt.material.needsUpdate = true; }
      } else {
        tgt.geometry.deleteAttribute('color');
        if (tgt.material) { tgt.material.vertexColors = false; tgt.material.color = new THREE.Color(0x9ec5fe); tgt.material.needsUpdate = true; }
      }
      delete _deviationOriginal[targetId];
      if (tgt.userData) tgt.userData.deviation = null;
      _invalidate(3);
      return true;
    };

    // ── ICP refinement (Phase 2 follow-up to the 3-pair manual seed) ──
    // After the manual alignment lands the scan in roughly the right
    // place, ICP nudges it toward the IFC iteratively. For each scan
    // sample point we find the closest IFC element centroid (cheap
    // approximation), then recompute a rigid transform from the
    // correspondence set and apply it. Repeat until the transform
    // stops changing or we hit the iteration cap.
    //
    // SVD-free approach: instead of a general Kabsch we pick the 3
    // best correspondence pairs (smallest residuals from the previous
    // iteration) per round and re-use the closed-form 3-pair solver
    // from above. Converges to the same local optimum that a full
    // Kabsch reaches in practice while keeping the code dependency-
    // free and easy to audit.
    //
    // Public:
    //   _ccAlignRefineICP(targetId, opts) → Promise<{iterations, residual}>
    //     opts.maxIter   default 20
    //     opts.sampleN   how many scan points to use   (default 2000)
    //     opts.tol       transform-change tolerance    (default 1e-4)
    function _sampleScanPoints(tgt, N) {
      var geom = tgt.geometry;
      var pos = geom.getAttribute('position');
      if (!pos) return [];
      tgt.updateMatrixWorld(true);
      var M = tgt.matrixWorld;
      var total = pos.count;
      var step = Math.max(1, Math.floor(total / N));
      var pts = [];
      var v = new THREE.Vector3();
      for (var i = 0; i < total; i += step) {
        v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(M);
        pts.push(v.clone());
      }
      return pts;
    }
    // Closest IFC element centroid via the same spatial grid the
    // deviation heatmap uses. Returns the world-space centre of the
    // element bbox — a coarse correspondence but good enough as an
    // ICP target when the scan is already close to the IFC.
    function _closestIfcCentroid(p, grid, cellSize) {
      var gx = Math.floor(p.x / cellSize);
      var gy = Math.floor(p.y / cellSize);
      var gz = Math.floor(p.z / cellSize);
      var best = null, bestD = Infinity;
      for (var ox = -1; ox <= 1; ox++) for (var oy = -1; oy <= 1; oy++) for (var oz = -1; oz <= 1; oz++) {
        var bucket = grid[(gx+ox) + ',' + (gy+oy) + ',' + (gz+oz)];
        if (!bucket) continue;
        for (var k = 0; k < bucket.length; k++) {
          var b = bucket[k];
          var dx = p.x - b.cx, dy = p.y - b.cy, dz = p.z - b.cz;
          var d2 = dx*dx + dy*dy + dz*dz;
          if (d2 < bestD) { bestD = d2; best = b; }
        }
      }
      return best ? { v: new THREE.Vector3(best.cx, best.cy, best.cz), d: Math.sqrt(bestD) } : null;
    }
    window._ccAlignRefineICP = function(targetId, opts) {
      opts = opts || {};
      var maxIter = opts.maxIter != null ? opts.maxIter : 20;
      var sampleN = opts.sampleN != null ? opts.sampleN : 2000;
      var tol     = opts.tol     != null ? opts.tol     : 1e-4;

      var tgt = _findTarget(targetId);
      if (!tgt) return Promise.reject(new Error('Scan target not found'));
      var ifc = _collectIfcBoxes();
      if (!ifc) return Promise.reject(new Error('No IFC elements loaded'));
      var cellSize = Math.max(0.5, ifc.meanDiag * 2);
      var grid = _buildGrid(ifc.boxes, cellSize);
      var scanPts = _sampleScanPoints(tgt, sampleN);
      if (scanPts.length < 3) return Promise.reject(new Error('Scan has too few points'));

      var iter = 0;
      var prevWorst = Infinity;
      var lastResidual = Infinity;

      return new Promise(function(resolve, reject) {
        function _icpStep() {
          // 1. Correspondence: nearest IFC centroid per sampled point.
          var pairs = [];
          for (var i = 0; i < scanPts.length; i++) {
            var nn = _closestIfcCentroid(scanPts[i], grid, cellSize);
            if (nn) pairs.push({ scan: scanPts[i], ifc: nn.v, d: nn.d });
          }
          if (pairs.length < 3) {
            reject(new Error('Not enough correspondences — manual seed may be too far off'));
            return;
          }
          // 2. Take the 3 cleanest pairs that span a non-degenerate
          //    triangle. Sort by distance, then pick the first three
          //    whose triangle isn't near-collinear.
          pairs.sort(function(a, b){ return a.d - b.d; });
          var picked = [];
          for (var pi = 0; pi < pairs.length && picked.length < 3; pi++) {
            var cand = pairs[pi];
            if (picked.length === 0) { picked.push(cand); continue; }
            if (picked.length === 1) {
              var dist01 = picked[0].scan.distanceTo(cand.scan);
              if (dist01 > 0.5) picked.push(cand);  // metres — far enough to define a baseline
              continue;
            }
            if (picked.length === 2) {
              // Reject near-collinear triples — cross product magnitude.
              var e1 = new THREE.Vector3().subVectors(picked[1].scan, picked[0].scan);
              var e2 = new THREE.Vector3().subVectors(cand.scan,    picked[0].scan);
              var area = e1.cross(e2).length();
              if (area > 0.1) picked.push(cand);
            }
          }
          if (picked.length < 3) {
            // Fall back to first three regardless of geometry.
            picked = pairs.slice(0, 3);
          }
          // 3. Compute the 3-pair transform mapping scan → ifc.
          var M = _rigidFromThreePairs(
            picked[0].scan, picked[1].scan, picked[2].scan,
            picked[0].ifc,  picked[1].ifc,  picked[2].ifc
          );
          // 4. Apply to the scan sample points (so the next iteration
          //    works on the updated positions).
          for (var spi = 0; spi < scanPts.length; spi++) scanPts[spi].applyMatrix4(M);
          // 5. Also compose into the target's transform.
          var Mt = new THREE.Matrix4().multiplyMatrices(M, tgt.matrix);
          var p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
          Mt.decompose(p, q, s);
          tgt.position.copy(p); tgt.quaternion.copy(q); tgt.scale.copy(s);
          tgt.updateMatrix(); tgt.updateMatrixWorld(true);
          // 6. Convergence check — worst pair distance + transform delta.
          var worst = 0, sumSq = 0;
          for (var rpi = 0; rpi < pairs.length; rpi++) {
            var dT = pairs[rpi].scan.distanceTo(pairs[rpi].ifc);
            if (dT > worst) worst = dT;
            sumSq += dT * dT;
          }
          var rmse = Math.sqrt(sumSq / pairs.length);
          var delta = Math.abs(prevWorst - worst);
          prevWorst = worst;
          lastResidual = rmse;
          iter++;
          if (iter < maxIter && delta > tol) {
            setTimeout(_icpStep, 0); // yield
            return;
          }
          // Done — persist the updated alignment.
          var finalM = new THREE.Matrix4()
            .makeRotationFromQuaternion(tgt.quaternion)
            .setPosition(tgt.position);
          if (tgt.userData) {
            tgt.userData.alignment = Object.assign(tgt.userData.alignment || {}, {
              applied:   Array.from(finalM.elements),
              icpRMSE:   rmse,
              icpIters:  iter,
              timestamp: new Date().toISOString()
            });
            try {
              var key = STORAGE_KEY_PREFIX + (tgt.name || targetId);
              localStorage.setItem(key, JSON.stringify(tgt.userData.alignment));
            } catch(_){}
          }
          _invalidate(3);
          _toast('ICP done · ' + iter + ' iter · RMSE ' + rmse.toFixed(3) + ' m');
          resolve({ iterations: iter, residual: rmse });
        }
        _icpStep();
      });
    };

    // ── Auto-issue at deviation hotspots ───────────────────────────
    // After the deviation heatmap is computed, walk the scan points,
    // gather the ones marked "red" (distance ≥ redAt), bin them into
    // a spatial hash, and connected-component-cluster the occupied
    // cells. Each cluster above a minimum point count becomes an
    // issue anchored on the cluster centroid.
    //
    // Public:
    //   _ccDeviationCreateIssues(targetId, opts) → Promise<{count, clusters}>
    //     opts.cellSize    spatial grid cell, metres        (default 0.5)
    //     opts.minPoints   skip clusters smaller than this   (default 50)
    //     opts.tolerance   redAt override (defaults to deviation.redAt)
    window._ccDeviationCreateIssues = function(targetId, opts) {
      opts = opts || {};
      var tgt = _findTarget(targetId);
      if (!tgt || !tgt.geometry) return Promise.reject(new Error('Scan target not found'));
      var dev = tgt.userData && tgt.userData.deviation;
      if (!dev) return Promise.reject(new Error('Compute the deviation map first'));
      var cellSize  = opts.cellSize  != null ? opts.cellSize  : 0.5;
      var minPoints = opts.minPoints != null ? opts.minPoints : 50;
      var tolerance = opts.tolerance != null ? opts.tolerance : dev.redAt;

      var geom = tgt.geometry;
      var pos = geom.getAttribute('position');
      if (!pos) return Promise.reject(new Error('Scan has no positions'));
      var N = pos.count;
      tgt.updateMatrixWorld(true);
      var M = tgt.matrixWorld;

      // We need the per-point distance again. Re-run a cheap version of
      // the bbox-distance scan — the heatmap already proved the spatial
      // structure works, so we reuse it.
      var ifc = _collectIfcBoxes();
      if (!ifc) return Promise.reject(new Error('No IFC elements'));
      var gridCell = Math.max(0.5, ifc.meanDiag * 2);
      var grid = _buildGrid(ifc.boxes, gridCell);

      // Bin red points into a sparse hash by cluster cellSize. Each cell
      // accumulates count + position sum + max-distance.
      var v = new THREE.Vector3();
      var cells = Object.create(null);
      function _cellKey(gx, gy, gz) { return gx + ',' + gy + ',' + gz; }

      var batchSize = 100000;
      var idx = 0;
      return new Promise(function(resolve) {
        function _scan() {
          var end = Math.min(N, idx + batchSize);
          for (; idx < end; idx++) {
            v.set(pos.getX(idx), pos.getY(idx), pos.getZ(idx)).applyMatrix4(M);
            // Re-derive distance to nearest IFC bbox.
            var gx0 = Math.floor(v.x / gridCell);
            var gy0 = Math.floor(v.y / gridCell);
            var gz0 = Math.floor(v.z / gridCell);
            var best = Infinity;
            for (var ox = -1; ox <= 1; ox++) for (var oy = -1; oy <= 1; oy++) for (var oz = -1; oz <= 1; oz++) {
              var bucket = grid[(gx0+ox) + ',' + (gy0+oy) + ',' + (gz0+oz)];
              if (!bucket) continue;
              for (var j = 0; j < bucket.length; j++) {
                var b = bucket[j];
                var dx = Math.max(0, Math.abs(v.x - b.cx) - b.hx);
                var dy = Math.max(0, Math.abs(v.y - b.cy) - b.hy);
                var dz = Math.max(0, Math.abs(v.z - b.cz) - b.hz);
                var d = Math.sqrt(dx*dx + dy*dy + dz*dz);
                if (d < best) best = d;
                if (best === 0) break;
              }
              if (best === 0) break;
            }
            if (best < tolerance) continue;
            var cgx = Math.floor(v.x / cellSize);
            var cgy = Math.floor(v.y / cellSize);
            var cgz = Math.floor(v.z / cellSize);
            var key = _cellKey(cgx, cgy, cgz);
            var c = cells[key];
            if (!c) { c = cells[key] = {gx:cgx, gy:cgy, gz:cgz, n:0, sx:0, sy:0, sz:0, maxD:0}; }
            c.n++; c.sx += v.x; c.sy += v.y; c.sz += v.z;
            if (best > c.maxD) c.maxD = best;
          }
          if (idx < N) { setTimeout(_scan, 0); return; }
          // Connected-component clustering on the cell graph (6-neighbour).
          var visited = Object.create(null);
          var clusters = [];
          Object.keys(cells).forEach(function(key){
            if (visited[key]) return;
            var stack = [key];
            var members = [];
            while (stack.length) {
              var k = stack.pop();
              if (visited[k]) continue;
              visited[k] = true;
              var c = cells[k];
              if (!c) continue;
              members.push(c);
              [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].forEach(function(off){
                var nk = _cellKey(c.gx + off[0], c.gy + off[1], c.gz + off[2]);
                if (!visited[nk] && cells[nk]) stack.push(nk);
              });
            }
            // Aggregate cluster stats
            var nTot = 0, sx = 0, sy = 0, sz = 0, maxD = 0;
            members.forEach(function(c){ nTot += c.n; sx += c.sx; sy += c.sy; sz += c.sz; if (c.maxD > maxD) maxD = c.maxD; });
            if (nTot < minPoints) return;
            clusters.push({
              centroid: [sx/nTot, sy/nTot, sz/nTot],
              pointCount: nTot,
              maxDistance: maxD,
              cellCount: members.length
            });
          });
          // Sort biggest / worst first.
          clusters.sort(function(a, b){ return b.maxDistance - a.maxDistance; });
          // Dispatch issues + capture a viewpoint per cluster so the
          // deviation report has a 3D snapshot anchored on each hotspot.
          // Position the camera looking down-and-in at the centroid from
          // a distance scaled by cluster span so big clusters frame
          // wider; render synchronously, then call _ccCaptureViewpoint
          // (which reads the just-rendered canvas + the current
          // camera/orbit/section state). The captured viewpoint's id is
          // attached to the issue via linkedId so the Issues panel +
          // PDF report can restore the view in one click.
          var dispatch = window._ccDispatch;
          var A_ENUM = (window.A && window.A.ADD_ISSUE) || 'ADD_ISSUE';
          var A_VP   = (window.A && window.A.ADD_VIEWPOINT) || 'ADD_VIEWPOINT';
          var S3     = window._ccState3d;
          function _snapAtPoint(point, span) {
            if (!S3 || !S3.camera || !S3.orbit || !S3.renderer || !S3.scene) return null;
            var t = new THREE.Vector3(point[0], point[1], point[2]);
            // Distance: max(5 m, ~2× cluster span) so the cluster fills
            // the frame without being claustrophobic. Camera offset is
            // a fixed "down-3/4 view" relative to the target.
            var dist = Math.max(5, span * 2);
            S3.camera.position.set(t.x + dist*0.7, t.y + dist*0.55, t.z + dist*0.7);
            S3.orbit.target.copy(t);
            S3.orbit.sync(); S3.orbit.apply();
            S3.camera.lookAt(t);
            S3.renderer.render(S3.scene, S3.camera);
          }
          var made = 0;
          if (dispatch) {
            // Stash the camera so we can restore it after the snapshot run.
            var camSave = S3 && S3.camera ? {
              pos: S3.camera.position.clone(),
              tgt: S3.orbit.target.clone()
            } : null;
            clusters.forEach(function(c, i){
              var span = Math.cbrt(c.cellCount) * cellSize; // rough cluster radius
              _snapAtPoint(c.centroid, span);
              var issueId = (typeof uid === 'function') ? uid() : 'dev_' + Date.now() + '_' + i;
              var vp = null;
              if (typeof window._ccCaptureViewpoint === 'function') {
                try { vp = window._ccCaptureViewpoint('Deviation hotspot #' + (i+1), issueId); } catch(_) {}
              }
              if (vp) dispatch({ t: A_VP, v: vp });
              var title = 'Deviation hotspot #' + (i+1) + ' · '
                + (c.maxDistance*1000).toFixed(0) + ' mm max · '
                + c.pointCount + ' pts';
              dispatch({ t: A_ENUM, v: {
                id: issueId,
                source: 'deviation_auto',
                type: c.maxDistance > 0.2 ? 'hard' : 'soft',
                status: 'open',
                title: title,
                description: 'Auto-generated from point-cloud deviation analysis. ' +
                  'Cluster centroid at [' + c.centroid.map(function(x){return x.toFixed(2);}).join(', ') + '], ' +
                  'point count ' + c.pointCount + ', worst distance ' + (c.maxDistance*1000).toFixed(0) + ' mm.',
                priority: c.maxDistance > 0.2 ? 'critical' : c.maxDistance > 0.1 ? 'high' : 'normal',
                category: 'as-built',
                point: c.centroid,
                createdAt: new Date().toISOString()
              }});
              made++;
            });
            // Restore camera so the user lands back where they were.
            if (camSave && S3 && S3.camera && S3.orbit) {
              S3.camera.position.copy(camSave.pos);
              S3.orbit.target.copy(camSave.tgt);
              S3.orbit.sync(); S3.orbit.apply();
              S3.renderer.render(S3.scene, S3.camera);
            }
          }
          _toast('Created ' + made + ' deviation issue' + (made === 1 ? '' : 's'));
          resolve({ count: made, clusters: clusters });
        }
        _scan();
      });
    };

    // Remove a previously-applied alignment and re-anchor the cloud at
    // its original position (the load-time centring offset stays — it's
    // a precision thing, not user-visible).
    window._ccAlignClear = function(targetId) {
      var tgt = _findTarget(targetId);
      if (!tgt) return false;
      tgt.position.set(0,0,0);
      tgt.quaternion.identity();
      tgt.scale.set(1,1,1);
      tgt.updateMatrix();
      tgt.updateMatrixWorld(true);
      if (tgt.userData) tgt.userData.alignment = null;
      try { localStorage.removeItem(STORAGE_KEY_PREFIX + (tgt.name || targetId)); } catch(_){}
      _invalidate(3);
      _toast('Alignment cleared');
      return true;
    };

    // ── Compute, apply, persist ──────────────────────────────────
    function _finishAlignment() {
      _detachPicker();
      _pickActive = false;
      var tgt = _findTarget(_targetId);
      if (!tgt || _ifcPicks.length !== 3 || _scanPicks.length !== 3) {
        _toast('Alignment cancelled — incomplete picks');
        _clearMarkers();
        _emit(_status());
        return;
      }
      // We want to map SCAN points to IFC points (the scan currently
      // sits in its own frame; we transform it into the IFC frame).
      var M = _rigidFromThreePairs(
        _scanPicks[0], _scanPicks[1], _scanPicks[2],
        _ifcPicks[0],  _ifcPicks[1],  _ifcPicks[2]
      );

      // Sanity check: compute residual against the pairs
      var pairs = [
        {scan:_scanPicks[0].toArray(), ifc:_ifcPicks[0].toArray()},
        {scan:_scanPicks[1].toArray(), ifc:_ifcPicks[1].toArray()},
        {scan:_scanPicks[2].toArray(), ifc:_ifcPicks[2].toArray()}
      ];
      // Quick residual check by transforming scan picks via M and
      // comparing to the IFC picks. For a perfect rigid mapping with
      // 3 pairs and matching triangles the residual is ~0.
      var worst = 0;
      for (var i = 0; i < 3; i++) {
        var p = _scanPicks[i].clone().applyMatrix4(M);
        var d = p.distanceTo(_ifcPicks[i]);
        if (d > worst) worst = d;
      }

      // Apply transform to the point cloud's transform — decompose into
      // pos/quat/scale because the cloud may already carry a load-time
      // position offset that we want to compose with, not overwrite.
      var pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
      M.decompose(pos, quat, scl);
      tgt.position.copy(pos);
      tgt.quaternion.copy(quat);
      tgt.scale.copy(scl);
      tgt.updateMatrix();
      tgt.updateMatrixWorld(true);
      tgt.userData.alignment = {
        applied:   Array.from(M.elements),
        pairs:     pairs,
        timestamp: new Date().toISOString(),
        worstResidual: worst
      };

      // Persist so a reload doesn't lose the alignment.
      try {
        var k = STORAGE_KEY_PREFIX + (tgt.name || _targetId);
        localStorage.setItem(k, JSON.stringify(tgt.userData.alignment));
      } catch(_) {}

      _clearMarkers();
      _emit(_status());
      _invalidate(3);
      _toast('Alignment applied · worst pick residual ' + worst.toFixed(3) + ' m');
    }

    // ── Auto-restore on cloud-loaded event ───────────────────────
    // The pointcloud addon dispatches an event when a scan finishes
    // loading. If we have a saved alignment for that cloud's file name,
    // re-apply it.
    function _restoreFor(target) {
      if (!target || !target.name) return;
      try {
        var raw = localStorage.getItem(STORAGE_KEY_PREFIX + target.name);
        if (!raw) return;
        var saved = JSON.parse(raw);
        if (!saved || !saved.applied || saved.applied.length !== 16) return;
        var M = new THREE.Matrix4().fromArray(saved.applied);
        var p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
        M.decompose(p, q, s);
        target.position.copy(p);
        target.quaternion.copy(q);
        target.scale.copy(s);
        target.updateMatrix(); target.updateMatrixWorld(true);
        target.userData.alignment = saved;
        _invalidate(3);
      } catch(_){}
    }
    // Best-effort hook: every time the reference-layer group's children
    // change we sweep for unrestored alignments. The pointcloud addon
    // doesn't currently emit a per-load event; this sweep covers it.
    window.addEventListener('cc-reflayers-changed', function(){
      var sc = _scene(); if (!sc) return;
      var refs = sc.getObjectByName('cc-reference-layers');
      if (refs) refs.children.forEach(_restoreFor);
    });

    // Public: status + listener API for any UI we wire later.
    window._ccAlignStatus = _status;
    window._ccAlignOnChange = function(cb) {
      _onChange.push(cb);
      return function(){ _onChange = _onChange.filter(function(f){return f !== cb;}); };
    };

    // ── Deviation report PDF ──────────────────────────────────────
    // Opens a print-ready report window with a cover summary + one
    // page per auto-issue (snapshot, location, statistics, status).
    // The user clicks Print → save as PDF in their browser. Reuses
    // the snapshots already captured by _ccDeviationCreateIssues via
    // linkedId → viewpoint matching, so no second render pass needed.
    //
    // Public:
    //   _ccDeviationExportReport(targetId) → opens a new window
    function _escapeHtml(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function _formatDistance(m) {
      if (m == null || !isFinite(m)) return '—';
      if (m >= 1) return m.toFixed(2) + ' m';
      return (m * 1000).toFixed(0) + ' mm';
    }
    window._ccDeviationExportReport = function(targetId) {
      var tgt = _findTarget(targetId);
      if (!tgt) { _toast('Scan target not found'); return; }
      var dev = tgt.userData && tgt.userData.deviation;
      if (!dev) { _toast('Compute the deviation map first'); return; }
      var state = window._ccLatestState || {};
      var issues = (state.issues || []).filter(function(it){ return it.source === 'deviation_auto'; });
      if (!issues.length) {
        _toast('No auto-issues for this scan yet — click "Issues at hotspots" first');
        return;
      }
      var viewpoints = state.viewpoints || [];
      var vpByLinkedId = {};
      viewpoints.forEach(function(v){ if (v.linkedId) vpByLinkedId[v.linkedId] = v; });

      // Aggregate stats for the cover page.
      var critN = issues.filter(function(i){return i.priority==='critical';}).length;
      var highN = issues.filter(function(i){return i.priority==='high';}).length;
      var normN = issues.length - critN - highN;

      var scanName = tgt.name || 'Point cloud';
      var modelNames = (state.models || []).map(function(m){return m.name;}).filter(Boolean).join(', ') || '—';
      var generatedAt = new Date().toLocaleString();
      var ccVer = (window.CC_VERSION && window.CC_VERSION.v) ? ('v' + window.CC_VERSION.v) : '';

      var rowsHtml = issues.map(function(it, i){
        return '<tr>'
          + '<td>' + (i+1) + '</td>'
          + '<td>' + _escapeHtml(it.title) + '</td>'
          + '<td style="text-transform:capitalize">' + _escapeHtml(it.priority || 'normal') + '</td>'
          + '<td>' + _escapeHtml(it.status || 'open') + '</td>'
          + '<td style="font-family:monospace;font-size:10px">' + (it.point ? it.point.map(function(x){return x.toFixed(2);}).join(', ') : '—') + '</td>'
          + '</tr>';
      }).join('');

      var pagesHtml = issues.map(function(it, i){
        var vp = vpByLinkedId[it.id];
        var img = vp && vp.snapshot ? ('<img src="' + vp.snapshot + '" alt="hotspot snapshot" />') : '<div class="no-snap">No snapshot captured</div>';
        return '<section class="hotspot-page">'
          + '<h2>Hotspot ' + (i+1) + ' · ' + _escapeHtml(it.title) + '</h2>'
          + '<div class="hotspot-grid">'
          +   '<div class="snap">' + img + '</div>'
          +   '<dl class="meta">'
          +     '<dt>Priority</dt><dd style="text-transform:capitalize">' + _escapeHtml(it.priority || 'normal') + '</dd>'
          +     '<dt>Status</dt><dd>' + _escapeHtml(it.status || 'open') + '</dd>'
          +     '<dt>Type</dt><dd>' + _escapeHtml(it.type || '—') + '</dd>'
          +     '<dt>Location (x, y, z)</dt><dd>' + (it.point ? it.point.map(function(x){return x.toFixed(3);}).join(', ') : '—') + '</dd>'
          +     '<dt>Detected</dt><dd>' + _escapeHtml(it.createdAt || '—') + '</dd>'
          +   '</dl>'
          + '</div>'
          + '<div class="description">' + _escapeHtml(it.description || '') + '</div>'
          + '</section>';
      }).join('');

      // Alignment + deviation summary cards
      var aln = tgt.userData && tgt.userData.alignment;
      var alnHtml = aln ? (
        '<div class="card"><h3>Alignment</h3>'
        + '<dl>'
        +   '<dt>Captured at</dt><dd>' + _escapeHtml(aln.timestamp || '—') + '</dd>'
        +   '<dt>Worst pick residual</dt><dd>' + _formatDistance(aln.worstResidual) + '</dd>'
        +   (aln.icpRMSE != null ? ('<dt>ICP RMSE</dt><dd>' + _formatDistance(aln.icpRMSE) + ' · ' + (aln.icpIters || '—') + ' iterations</dd>') : '')
        + '</dl></div>'
      ) : '';

      var devHtml = '<div class="card"><h3>Deviation</h3>'
        + '<dl>'
        +   '<dt>Min</dt><dd>' + _formatDistance(dev.min) + '</dd>'
        +   '<dt>Mean</dt><dd>' + _formatDistance(dev.mean) + '</dd>'
        +   '<dt>Max</dt><dd>' + _formatDistance(dev.max) + '</dd>'
        +   '<dt>Green threshold</dt><dd>≤ ' + _formatDistance(dev.greenAt) + '</dd>'
        +   '<dt>Red threshold</dt><dd>≥ ' + _formatDistance(dev.redAt) + '</dd>'
        +   '<dt>Points (green/amber/red)</dt><dd>' + dev.greenCount + ' / ' + dev.amberCount + ' / ' + dev.redCount + '</dd>'
        + '</dl></div>';

      var docHtml = '<!DOCTYPE html><html><head><meta charset="utf-8" />'
        + '<title>Deviation report — ' + _escapeHtml(scanName) + '</title>'
        + '<style>'
        + '  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color:#1f2937; margin:0; padding:0 32px 32px; background:#fff; }'
        + '  h1 { font-size:28px; margin:32px 0 4px; }'
        + '  h2 { font-size:18px; margin:24px 0 8px; color:#111827; }'
        + '  h3 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:#6b7280; margin:0 0 8px; }'
        + '  .sub { color:#6b7280; font-size:13px; }'
        + '  .cards { display:grid; grid-template-columns:1fr 1fr 1fr; gap:12px; margin:24px 0; }'
        + '  .card { border:1px solid #e5e7eb; border-radius:8px; padding:12px; background:#f9fafb; }'
        + '  .card dl { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:0; font-size:12px; }'
        + '  .card dt { color:#6b7280; }'
        + '  .card dd { margin:0; color:#111827; font-family:ui-monospace,monospace; font-size:11px; }'
        + '  table { width:100%; border-collapse:collapse; font-size:12px; margin:12px 0 32px; }'
        + '  th, td { border-bottom:1px solid #e5e7eb; padding:6px 8px; text-align:left; }'
        + '  th { color:#6b7280; font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }'
        + '  .hotspot-page { page-break-before:always; margin-top:32px; }'
        + '  .hotspot-grid { display:grid; grid-template-columns:2fr 1fr; gap:18px; align-items:start; }'
        + '  .snap img { width:100%; height:auto; border:1px solid #e5e7eb; border-radius:6px; display:block; }'
        + '  .no-snap { padding:32px; border:1px dashed #d1d5db; border-radius:6px; text-align:center; color:#9ca3af; font-size:12px; }'
        + '  .description { margin-top:14px; font-size:12px; color:#374151; line-height:1.5; }'
        + '  .footer { border-top:1px solid #e5e7eb; padding:12px 0; color:#9ca3af; font-size:10px; margin-top:48px; }'
        + '  @media print { .noprint { display:none } .card { background:#fff } body { padding:0 16px 16px } }'
        + '  .toolbar { position:sticky; top:0; background:#fff; padding:12px 0; border-bottom:1px solid #e5e7eb; margin-bottom:16px; z-index:10; }'
        + '  .toolbar button { padding:6px 14px; margin-right:8px; border:1px solid #d1d5db; background:#fff; border-radius:6px; cursor:pointer; font-size:13px; }'
        + '  .toolbar button.primary { background:#1f2937; color:#fff; border-color:#1f2937; }'
        + '</style></head><body>'
        + '<div class="toolbar noprint">'
        +   '<button class="primary" onclick="window.print()">Print / Save as PDF</button>'
        +   '<button onclick="window.close()">Close</button>'
        +   '<span style="color:#6b7280;font-size:12px;margin-left:8px">Generated by ClashControl ' + _escapeHtml(ccVer) + '</span>'
        + '</div>'
        + '<h1>Deviation report</h1>'
        + '<div class="sub">Scan: <strong>' + _escapeHtml(scanName) + '</strong> · Model(s): ' + _escapeHtml(modelNames) + ' · Generated: ' + _escapeHtml(generatedAt) + '</div>'
        + '<div class="cards">'
        +   '<div class="card"><h3>Summary</h3>'
        +   '<dl>'
        +     '<dt>Hotspots</dt><dd>' + issues.length + '</dd>'
        +     '<dt>Critical</dt><dd>' + critN + '</dd>'
        +     '<dt>High</dt><dd>' + highN + '</dd>'
        +     '<dt>Normal</dt><dd>' + normN + '</dd>'
        +   '</dl></div>'
        +   alnHtml
        +   devHtml
        + '</div>'
        + '<h2>Hotspot index</h2>'
        + '<table><thead><tr><th>#</th><th>Title</th><th>Priority</th><th>Status</th><th>Location (x, y, z)</th></tr></thead>'
        + '<tbody>' + rowsHtml + '</tbody></table>'
        + pagesHtml
        + '<div class="footer">ClashControl ' + _escapeHtml(ccVer) + ' · deviation-report v1 · ' + _escapeHtml(generatedAt) + '</div>'
        + '</body></html>';

      var pw = window.open('', '_blank', 'width=1024,height=720');
      if (!pw) { _toast('Pop-up blocked — allow pop-ups for ClashControl'); return; }
      pw.document.write(docHtml);
      pw.document.close();
      setTimeout(function(){ pw.focus(); }, 200);
    };

    if (typeof window._ccRegisterAddon === 'function') {
      window._ccRegisterAddon({
        id: 'align',
        name: 'Point cloud ↔ IFC alignment',
        description: 'Three-point manual alignment that lifts an as-built scan into the design IFC coordinate frame. Foundation for as-built verification — the killer workflow for AEC coordination.'
      });
    }
  }
})();
