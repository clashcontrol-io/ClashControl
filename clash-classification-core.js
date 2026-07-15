(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccClashClassificationCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // Deterministic triage extracted verbatim from index.html — including the
  // spatial-hash cluster grouping (the old all-pairs O(n²) scan was the
  // detection wall on large federations). Any drift from the inline legacy
  // implementation is caught by the boot-time equivalence gate and falls
  // back, so this file must stay a byte-faithful port of the inline body.
  function classifyClashes(clashes) {
    var FP_TYPES = ['IfcOpeningElement','IfcOpeningStandardCase','IfcSpace','IfcVirtualElement'];
    var STRUCTURAL_DISC = 'Structural';
    var INSULATION_MAT = 'insulation';

    clashes.forEach(function(c) {
      if (c.aiSeverity) return;

      var typeA = c.elemAType || '';
      var typeB = c.elemBType || '';
      var discs = c.disciplines || [];
      var crossDisc = discs.length >= 2 && discs[0] !== discs[1];
      var hasStructural = discs.indexOf(STRUCTURAL_DISC) !== -1;
      var fv = c._trainFV || {};

      var sev = 'minor', cat = 'needs_review', reason = '';

      // ── False positive checks (override everything) ──
      var isFP = false;
      for (var fi = 0; fi < FP_TYPES.length; fi++) {
        if (typeA.indexOf(FP_TYPES[fi]) !== -1 || typeB.indexOf(FP_TYPES[fi]) !== -1) { isFP = true; break; }
      }
      if (isFP) {
        sev = 'info'; cat = 'false_positive';
        reason = 'Opening/space element pair — likely intentional';
      } else if (fv.size_ratio > 50) {
        sev = 'info'; cat = 'false_positive';
        reason = 'Extreme size ratio (' + Math.round(fv.size_ratio) + ':1) — small element inside large one';
      } else if (c.type === 'duplicate') {
        sev = 'info'; cat = 'duplicate';
        reason = 'Duplicate element at same location';
      } else if (c.type === 'soft') {
        var gap = c.clearanceMm || Math.abs(c.distance || 0);
        if (gap < 25) {
          sev = 'major'; cat = 'clearance';
          reason = 'Near miss — only ' + Math.round(gap) + 'mm clearance' + (crossDisc ? ' (cross-discipline)' : '');
        } else {
          sev = 'minor'; cat = 'clearance';
          reason = Math.round(gap) + 'mm clearance gap' + (crossDisc ? ' (cross-discipline)' : '');
        }
      } else {
        if (crossDisc && hasStructural) {
          sev = 'critical'; cat = 'penetration';
          var otherDisc = discs[0] === STRUCTURAL_DISC ? discs[1] : discs[0];
          reason = (otherDisc || 'MEP') + ' penetrating primary structure';
        } else if (crossDisc) {
          sev = 'major'; cat = 'penetration';
          reason = 'Cross-discipline clash: ' + discs.join(' vs ');
        } else {
          sev = 'minor'; cat = 'penetration';
          reason = 'Same-discipline intersection';
        }
      }

      if (cat !== 'false_positive' && cat !== 'duplicate') {
        var matA = fv.mat_cat_a || '';
        var matB = fv.mat_cat_b || '';
        if (matA === INSULATION_MAT || matB === INSULATION_MAT) {
          if (sev === 'critical') sev = 'major';
          cat = 'needs_review';
          reason += ' (insulation involved — may be intentional)';
        }
      }

      c.aiSeverity = sev;
      c.aiCategory = cat;
      c.aiReason = reason;
    });

    // ── Cluster grouping: same type-pair + same storey + within 500mm ──
    // Spatial-hash version of the original all-pairs O(n²) scan. Buckets each
    // clash by (type-pair | storey | 500mm cell); a seed only compares against
    // its own + 26 neighbour cells with the same key (a point within 500mm can
    // sit at most one 500mm cell away on each axis). Behaviour-identical to the
    // old nested loop — same forward-only, greedy-by-index, seed-distance
    // clustering — but O(n·k) instead of O(n²). The old loop was the detection
    // wall on large federations (≈2.2 billion iterations / ~130s at 47k clashes).
    var CLUSTER_DIST_SQ = 0.5 * 0.5; // 500mm in meters squared
    var CELL = 0.5;
    function _cKey(pair, storey, cx, cy, cz){ return pair + '|' + storey + '|' + cx + ',' + cy + ',' + cz; }
    var buckets = {};
    for (var bi = 0; bi < clashes.length; bi++) {
      var cb = clashes[bi], pb = cb.point || [0,0,0];
      var kb = _cKey((cb.elemAType||'')+':'+(cb.elemBType||''), cb.elemAStorey||cb.elemBStorey||'',
        Math.floor(pb[0]/CELL), Math.floor(pb[1]/CELL), Math.floor(pb[2]/CELL));
      (buckets[kb] || (buckets[kb] = [])).push(bi);
    }
    var groupId = 0;
    var assigned = {};
    for (var i = 0; i < clashes.length; i++) {
      if (assigned[i]) continue;
      var ci = clashes[i];
      var pi = ci.point || [0,0,0];
      var pairI = (ci.elemAType || '') + ':' + (ci.elemBType || '');
      var storeyI = ci.elemAStorey || ci.elemBStorey || '';
      var cix = Math.floor(pi[0]/CELL), ciy = Math.floor(pi[1]/CELL), ciz = Math.floor(pi[2]/CELL);
      var cluster = [i];
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
        var bucket = buckets[_cKey(pairI, storeyI, cix+dx, ciy+dy, ciz+dz)];
        if (!bucket) continue;
        for (var bj = 0; bj < bucket.length; bj++) {
          var j = bucket[bj];
          if (j <= i || assigned[j]) continue; // forward-only + skip prior clusters, matching the old scan
          var cj = clashes[j];
          var pj = cj.point || [0,0,0];
          var ex = pi[0]-pj[0], ey = pi[1]-pj[1], ez = pi[2]-pj[2];
          if (ex*ex + ey*ey + ez*ez <= CLUSTER_DIST_SQ) cluster.push(j);
        }
      }
      if (cluster.length >= 2) {
        groupId++;
        for (var k = 0; k < cluster.length; k++) {
          clashes[cluster[k]]._clusterGroup = groupId;
          clashes[cluster[k]]._clusterSize = cluster.length;
          assigned[cluster[k]] = true;
        }
      }
    }
  }

  return Object.freeze({
    contractVersion: 1,
    classifyClashes: classifyClashes
  });
}));
