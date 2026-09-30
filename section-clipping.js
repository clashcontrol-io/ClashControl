// @ts-check
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccSectionClipping = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function eligible(obj) {
    return !!(obj && obj.isMesh && obj.material && obj.userData &&
      (obj.userData.expressId != null || obj.isInstancedMesh || obj.userData._isCCBatch));
  }

  function materials(obj) {
    var out = [];
    function add(value) {
      (Array.isArray(value) ? value : [value]).forEach(function(material) {
        if (material && out.indexOf(material) === -1) out.push(material);
      });
    }
    add(obj.material);
    var styles = obj.userData && obj.userData._styleMats;
    if (styles) Object.keys(styles).forEach(function(key) { add(styles[key]); });
    return out;
  }

  function _assign(material, planes, mode, cached) {
    if (mode === 'clear') {
      if (material.clippingPlanes && material.clippingPlanes.length) {
        material.clippingPlanes = planes;
        material.needsUpdate = true;
      }
      return;
    }
    if (mode === 'box') {
      material.clippingPlanes = planes;
      material.needsUpdate = true;
      return;
    }
    // Existing section-plane semantics: cached styles are only touched while
    // planes exist; the active material is updated when the array identity
    // changes. This exact behavior is the default-off legacy path.
    if (cached && !planes.length) return;
    if (material.clippingPlanes !== planes) {
      material.clippingPlanes = planes;
      material.needsUpdate = true;
    }
  }

  function applyLegacy(root, planes, mode) {
    var objects = 0, batches = 0, materialCount = 0;
    root.traverse(function(obj) {
      if (!eligible(obj)) return;
      objects++;
      if (obj.userData._isCCBatch) batches++;
      var active = Array.isArray(obj.material) ? obj.material : [obj.material];
      active.forEach(function(material) { if (material) { materialCount++; _assign(material, planes, mode, false); } });
      var styles = obj.userData._styleMats;
      if (styles) Object.keys(styles).forEach(function(key) {
        (Array.isArray(styles[key]) ? styles[key] : [styles[key]]).forEach(function(material) {
          if (material) { materialCount++; _assign(material, planes, mode, true); }
        });
      });
    });
    return { objects:objects, batches:batches, materials:materialCount };
  }

  function applyCandidate(modelRoot, planes) {
    var objects = 0, batches = 0, batchItems = 0, materialCount = 0;
    modelRoot.traverse(function(obj) {
      if (!eligible(obj)) return;
      objects++;
      if (obj.userData._isCCBatch) {
        batches++;
        batchItems += (obj.userData.batchExprIds || []).filter(function(id){ return id != null; }).length;
      }
      materials(obj).forEach(function(material) {
        materialCount++;
        if (material.clippingPlanes !== planes) {
          material.clippingPlanes = planes;
          material.needsUpdate = true;
        }
      });
    });
    return { objects:objects, batches:batches, batchItems:batchItems, materials:materialCount };
  }

  function verify(modelRoot, planes) {
    var missing = [], checked = 0, batches = 0;
    modelRoot.traverse(function(obj) {
      if (!eligible(obj)) return;
      if (obj.userData._isCCBatch) batches++;
      materials(obj).forEach(function(material, index) {
        checked++;
        if (material.clippingPlanes !== planes) {
          missing.push(String(obj.uuid || obj.userData.expressId || 'mesh') + ':' + index);
        }
      });
    });
    return { equal:missing.length === 0, checked:checked, batches:batches, missing:missing };
  }

  function applyGuarded(options) {
    options = options || {};
    var scene = options.scene;
    var modelRoot = options.modelRoot;
    var planes = options.planes || [];
    var mode = options.mode || 'section';
    if (!options.enabled || !modelRoot) return { path:'legacy', stats:applyLegacy(scene, planes, mode) };
    try {
      var stats = applyCandidate(modelRoot, planes);
      var comparison = verify(modelRoot, planes);
      if (!comparison.equal) {
        if (options.record) options.record({outcome:'mismatch', comparison:comparison});
        return { path:'fallback', stats:applyLegacy(scene, planes, mode), comparison:comparison };
      }
      if (options.record) options.record({outcome:'candidate', stats:stats});
      return { path:'candidate', stats:stats, comparison:comparison };
    } catch (error) {
      if (options.record) options.record({outcome:'fallback', error:String(error && error.message || error)});
      return { path:'fallback', stats:applyLegacy(scene, planes, mode), error:error };
    }
  }

  // ── Building plan orientation ──────────────────────────────────────
  // Dominant horizontal grid direction of a model, so axis section planes
  // (and the whole-model section box) cut parallel to the walls instead of
  // diagonally through a building that is rotated in plan (e.g. placed at
  // its real-world / true-north orientation).
  //
  // segs: flat [dx, dz, weight, dx, dz, weight, ...] — horizontal edge
  // vectors in scene X/Z (weight = edge length).
  // Returns {angle, confidence}: `angle` (radians, in (-PI/4, PI/4]) is the
  // rotation about +Y — Three.js convention, +X -> (cos a, 0, -sin a) — that
  // maps world X/Z onto the building grid; 0 means "world axes" (no
  // dominant direction, too little evidence, or already within 0.25 deg).
  // Directions are folded mod 90 deg (walls run along both grid axes).
  function dominantPlanAngle(segs, opts) {
    opts = opts || {};
    var BINS = 180, BIN = (Math.PI / 2) / BINS; // 0.5 deg bins over [0, 90 deg)
    var minConfidence = opts.minConfidence != null ? opts.minConfidence : 0.2;
    var hist = new Float64Array(BINS);
    var total = 0, i, n = segs ? segs.length : 0;
    function fold(phi) { // -> [0, PI/2)
      var q = Math.PI / 2;
      phi = phi % q; if (phi < 0) phi += q;
      return phi >= q ? 0 : phi;
    }
    for (i = 0; i + 2 < n; i += 3) {
      var w = segs[i + 2];
      if (!(w > 0)) continue;
      var phi = fold(Math.atan2(-segs[i + 1], segs[i]));
      hist[Math.min(BINS - 1, Math.floor(phi / BIN))] += w;
      total += w;
    }
    if (!(total > 0)) return { angle: 0, confidence: 0 };
    // Circular smoothing (+-2 bins) so a peak split across a bin edge wins.
    var best = -1, bestW = -1;
    for (i = 0; i < BINS; i++) {
      var sum = 0;
      for (var k = -2; k <= 2; k++) sum += hist[(i + k + BINS) % BINS];
      if (sum > bestW) { bestW = sum; best = i; }
    }
    var peak = (best + 0.5) * BIN, win = 2 * Math.PI / 180;
    // Refine: weighted circular mean of 4*phi over edges within +-2 deg of
    // the peak (4*phi makes the mean invariant to the 90 deg fold).
    var sx = 0, sy = 0, near = 0;
    for (i = 0; i + 2 < n; i += 3) {
      var w2 = segs[i + 2];
      if (!(w2 > 0)) continue;
      var p2 = fold(Math.atan2(-segs[i + 1], segs[i]));
      var dd = Math.abs(p2 - peak); dd = Math.min(dd, Math.PI / 2 - dd);
      if (dd > win) continue;
      sx += w2 * Math.cos(4 * p2); sy += w2 * Math.sin(4 * p2);
      near += w2;
    }
    var confidence = near / total;
    if (confidence < minConfidence) return { angle: 0, confidence: confidence };
    var angle = Math.atan2(sy, sx) / 4; // (-PI/4, PI/4]
    // Second, tighter pass (+-0.5 deg around the first estimate) so nearly-
    // parallel triangulation edges inside the +-2 deg window don't bias it.
    var est = fold(angle), tight = 0.5 * Math.PI / 180, tx = 0, ty = 0;
    for (i = 0; i + 2 < n; i += 3) {
      var w3 = segs[i + 2];
      if (!(w3 > 0)) continue;
      var p3 = fold(Math.atan2(-segs[i + 1], segs[i]));
      var d3 = Math.abs(p3 - est); d3 = Math.min(d3, Math.PI / 2 - d3);
      if (d3 > tight) continue;
      tx += w3 * Math.cos(4 * p3); ty += w3 * Math.sin(4 * p3);
    }
    if (tx !== 0 || ty !== 0) angle = Math.atan2(ty, tx) / 4;
    if (Math.abs(angle) < 0.25 * Math.PI / 180) angle = 0;
    return { angle: angle, confidence: confidence };
  }

  // ── Section-plane outline size ─────────────────────────────────────
  // Half-extents of the drawn outline along the plane's two in-plane axes.
  // ext: the model's extents along those axes; gap: the largest distance
  // from the cut to model geometry along the plane normal.
  // One margin fraction f for both axes, so the outline keeps the model's
  // exact proportions (a long building gets a long outline, not a square).
  // f is what gives the SHORT side a margin of 2 x gap — geometry above/
  // below the cut then still reads as inside the outline in perspective (up
  // to ~63 deg off the normal) — clamped to 4%..25%: never a huge sheet
  // under one chair, never a stamp on a big building.
  function outlineHalfExtents(ext, gap) {
    var big = Math.max(ext[0] || 0, ext[1] || 0, 1e-6);
    var e = [Math.max(ext[0] || 0, 0.01 * big), Math.max(ext[1] || 0, 0.01 * big)]; // zero-depth model: still a visible band
    var f = Math.min(0.25, Math.max(0.04, 2 * Math.max(0, gap || 0) / Math.min(e[0], e[1])));
    return [e[0] * (0.5 + f), e[1] * (0.5 + f)];
  }

  return Object.freeze({
    dominantPlanAngle: dominantPlanAngle,
    outlineHalfExtents: outlineHalfExtents,
    eligible: eligible,
    materials: materials,
    applyLegacy: applyLegacy,
    applyCandidate: applyCandidate,
    verify: verify,
    applyGuarded: applyGuarded
  });
}));
