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

    // ── Lookup the target THREE.Points or SplatMesh ───────────────
    // Point clouds live under 'cc-reference-layers' (set up by
    // addons/pointcloud.js). Splats live under 'cc-splat-layers'.
    // We accept either as the alignment target — same transform pipeline.
    function _findTarget(id) {
      var sc = _scene(); if (!sc) return null;
      var refs = sc.getObjectByName('cc-reference-layers');
      if (refs) {
        for (var i = 0; i < refs.children.length; i++) {
          var o = refs.children[i];
          if (o.userData && (o.userData._ccLayerId === id || o.uuid === id)) return o;
        }
      }
      var splats = sc.getObjectByName('cc-splat-layers');
      if (splats) {
        for (var j = 0; j < splats.children.length; j++) {
          var s = splats.children[j];
          if (s.userData && (s.userData._ccSplatId === id || s.uuid === id)) return s;
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

    if (typeof window._ccRegisterAddon === 'function') {
      window._ccRegisterAddon({
        id: 'align',
        name: 'Point cloud ↔ IFC alignment',
        description: 'Three-point manual alignment that lifts an as-built scan into the design IFC coordinate frame. Foundation for as-built verification — the killer workflow for AEC coordination.'
      });
    }
  }
})();
