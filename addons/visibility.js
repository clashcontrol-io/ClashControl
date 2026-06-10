// ClashControl — visibility clash addon
// =======================================
//
// Adds a third clash category alongside hard (intersection) and soft
// (clearance): VISIBILITY. A visibility clash records that an obstructer
// element blocks a viewer's sight line to a target element that the
// viewer is supposed to see — emergency exit signs, traffic signs,
// camera coverage, surveillance lines, reception-desk line-of-sight,
// nurse-station observation, etc.
//
// Algorithm: ray-segment intersection against the BVH the clash engine
// already builds. For each (viewer pose × target sample point) we cast
// a ray from V toward T with length |V→T|. If any triangle of any
// obstructer element falls within the segment, the sight line is
// blocked and we emit a clash {viewer, target, blocker, point, distance}.
//
// Filters
//   Viewer:     IFC type list, optional name regex, sample strategy
//   Target:     IFC type list, optional name regex
//   Obstructer: IFC type EXCLUDE list (default skips IfcSpace,
//               IfcAnnotation, the target itself, the viewer host)
//   Sight cone: half-angle in degrees, optional viewer facing
//   Max range:  metres
//
// Outputs are dispatched as ADD_CLASHES with type:'visibility' so they
// flow through the existing Issues panel, BCF export, clustering, and
// AI-triage paths without a special-case branch. Type-aware UI lights
// the visibility chip a distinct colour.
//
// Public API
//   window._ccDetectVisibility(rule) → Promise<{clashes, summary}>
//   window._ccVisibilityRuleSchema() → JSON-schema-style descriptor

(function(){
  if (typeof window === 'undefined') return;
  var THREE = window.THREE;
  if (!THREE) {
    var _retry = setInterval(function(){
      if (window.THREE) { clearInterval(_retry); _init(); }
    }, 100);
  } else { _init(); }

  function _init() {
    THREE = window.THREE;

    // Built-in defaults — coordinator can override per run. Excluded
    // obstructers prevent self-occlusion (target counts itself as a
    // blocker) and skip semantic-only volumes (IfcSpace, IfcAnnotation).
    var DEFAULT_OBSTRUCTER_EXCLUDES = {
      'IfcSpace': true,
      'IfcAnnotation': true,
      'IfcGrid': true,
      'IfcOpeningElement': true,
      'IfcVirtualElement': true
    };

    function _state() { return window._ccLatestState || {}; }
    function _allElements() {
      var s = _state();
      var out = [];
      (s.models || []).forEach(function(m){
        if (m.visible === false) return;
        (m.elements || []).forEach(function(el){ out.push({el:el, modelId:m.id}); });
      });
      return out;
    }
    function _typeOf(el) {
      return (el.props && el.props.ifcType) || el.ifcType || '';
    }
    function _nameOf(el) {
      return (el.props && el.props.name) || el.name || '';
    }

    // ── Filter resolver ──────────────────────────────────────────
    // Resolve a {types, namePattern, ids} filter into the matching
    // element list. ids wins outright (manual pick); otherwise we walk
    // the type + regex predicates.
    function _resolveFilter(filter, all) {
      if (!filter) return [];
      if (Array.isArray(filter.ids) && filter.ids.length) {
        var idSet = Object.create(null);
        filter.ids.forEach(function(id){ idSet[id] = true; });
        return all.filter(function(e){ return idSet[e.el.expressId]; });
      }
      var types = filter.types && filter.types.length ? filter.types : null;
      var rx    = filter.namePattern ? new RegExp(filter.namePattern, 'i') : null;
      return all.filter(function(e){
        if (types) {
          var t = _typeOf(e.el);
          var hit = false;
          for (var i = 0; i < types.length; i++) { if (t === types[i]) { hit = true; break; } }
          if (!hit) return false;
        }
        if (rx && !rx.test(_nameOf(e.el))) return false;
        return true;
      });
    }

    // ── Viewer sampling ──────────────────────────────────────────
    // Three sampling modes:
    //   'centroid'  — single sample at element centroid + eye height
    //   'grid'      — N×N grid on the element's footprint bbox
    //   'path'      — sample along the longer horizontal axis (corridors)
    function _viewerSamples(viewerEntry, sampling) {
      var el = viewerEntry.el;
      if (!el.box) return [];
      var box = el.box;
      var eyeHeight = (sampling && sampling.eyeHeight) || 1.65;
      var mode = (sampling && sampling.mode) || 'centroid';
      var stride = (sampling && sampling.stride) || 2.0;
      var samples = [];
      if (mode === 'centroid') {
        samples.push([
          (box.min.x + box.max.x) * 0.5,
          box.min.y + eyeHeight,
          (box.min.z + box.max.z) * 0.5
        ]);
      } else if (mode === 'grid') {
        var nx = Math.max(2, Math.ceil((box.max.x - box.min.x) / stride));
        var nz = Math.max(2, Math.ceil((box.max.z - box.min.z) / stride));
        for (var i = 0; i < nx; i++) for (var j = 0; j < nz; j++) {
          var u = (i + 0.5) / nx;
          var v = (j + 0.5) / nz;
          samples.push([
            box.min.x + u * (box.max.x - box.min.x),
            box.min.y + eyeHeight,
            box.min.z + v * (box.max.z - box.min.z)
          ]);
        }
      } else if (mode === 'path') {
        var spanX = box.max.x - box.min.x;
        var spanZ = box.max.z - box.min.z;
        var alongX = spanX >= spanZ;
        var span = Math.max(spanX, spanZ);
        var nSteps = Math.max(2, Math.ceil(span / stride));
        var cx = (box.min.x + box.max.x) * 0.5;
        var cz = (box.min.z + box.max.z) * 0.5;
        for (var k = 0; k < nSteps; k++) {
          var t = (k + 0.5) / nSteps;
          if (alongX) samples.push([box.min.x + t * spanX, box.min.y + eyeHeight, cz]);
          else        samples.push([cx, box.min.y + eyeHeight, box.min.z + t * spanZ]);
        }
      }
      return samples;
    }

    // ── Target surface sampling ──────────────────────────────────
    // Returns N sample points on the target bbox face most likely to
    // face a typical viewer. We pick the bbox face whose normal aligns
    // best with the candidate viewer direction, then grid it.
    // For partial-occlusion grading the caller iterates samples and
    // counts hits — fully blocked vs partially blocked emerges naturally.
    // For single-sample (legacy) callers we return just the centroid.
    function _targetSamplePoint(targetEntry) {
      var box = targetEntry.el.box;
      if (!box) return null;
      return [
        (box.min.x + box.max.x) * 0.5,
        (box.min.y + box.max.y) * 0.5,
        (box.min.z + box.max.z) * 0.5
      ];
    }
    function _targetSurfaceSamples(targetEntry, viewerPos, grid) {
      // grid = 1 → centroid only (cheap, same as legacy single-sample);
      //       2 → 4 corners + centroid;
      //       3 → 3×3 grid (the documented default).
      grid = Math.max(1, Math.min(5, grid || 1));
      var box = targetEntry.el.box; if (!box) return [];
      var cx = (box.min.x + box.max.x) * 0.5;
      var cy = (box.min.y + box.max.y) * 0.5;
      var cz = (box.min.z + box.max.z) * 0.5;
      if (grid === 1) return [[cx, cy, cz]];
      // Pick the bbox face whose outward normal best aligns with
      // (viewer → centroid). For a flat sign mounted on a wall this
      // picks the front face; for an omnidirectional light it picks the
      // side closest to the viewer.
      var vx = cx - viewerPos[0], vy = cy - viewerPos[1], vz = cz - viewerPos[2];
      var ax = Math.abs(vx), ay = Math.abs(vy), az = Math.abs(vz);
      var axis = (ax >= ay && ax >= az) ? 0 : (ay >= az ? 1 : 2);
      // Grid the two axes orthogonal to the chosen face.
      var sx = box.min.x, ex = box.max.x;
      var sy = box.min.y, ey = box.max.y;
      var sz = box.min.z, ez = box.max.z;
      var fixed = (axis === 0)
        ? (vx > 0 ? sx : ex)
        : (axis === 1) ? (vy > 0 ? sy : ey)
                       : (vz > 0 ? sz : ez);
      var samples = [];
      // Inset by 2% so corner rays don't graze the bbox edge and miss
      // the BVH leaf in a numerically-edge-case way.
      var inset = 0.02;
      function _lerp(a, b, t) { return a + (b - a) * t; }
      var n = grid;
      for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
        var u = n === 1 ? 0.5 : (inset + (1 - 2*inset) * i / (n - 1));
        var v = n === 1 ? 0.5 : (inset + (1 - 2*inset) * j / (n - 1));
        var px, py, pz;
        if (axis === 0)      { px = fixed; py = _lerp(sy, ey, u); pz = _lerp(sz, ez, v); }
        else if (axis === 1) { py = fixed; px = _lerp(sx, ex, u); pz = _lerp(sz, ez, v); }
        else                 { pz = fixed; px = _lerp(sx, ex, u); py = _lerp(sy, ey, v); }
        samples.push([px, py, pz]);
      }
      return samples;
    }

    // ── Ray-AABB intersection (slab test) ─────────────────────────
    // Returns [tMin, tMax] of the ray segment that lies inside the AABB,
    // or null if the ray misses. Box AABB encoded as min/max via mnx/mxx
    // fields (matches the core BVH node format).
    function _rayAABB(ox, oy, oz, dx, dy, dz, node) {
      var tx1 = (node.mnx - ox) / dx, tx2 = (node.mxx - ox) / dx;
      var ty1 = (node.mny - oy) / dy, ty2 = (node.mxy - oy) / dy;
      var tz1 = (node.mnz - oz) / dz, tz2 = (node.mxz - oz) / dz;
      var tmin = Math.max(Math.min(tx1, tx2), Math.min(ty1, ty2), Math.min(tz1, tz2));
      var tmax = Math.min(Math.max(tx1, tx2), Math.max(ty1, ty2), Math.max(tz1, tz2));
      if (tmax < 0 || tmin > tmax) return null;
      return [tmin, tmax];
    }

    // ── Möller-Trumbore ray-triangle intersection ────────────────
    // tris layout: [v0x,v0y,v0z, v1x,v1y,v1z, v2x,v2y,v2z, ...]
    // Returns hit distance t (≥ 0) or -1 on miss. Backface culling off.
    var EPS = 1e-7;
    function _rayTri(ox, oy, oz, dx, dy, dz, tris, off) {
      var v0x = tris[off],   v0y = tris[off+1], v0z = tris[off+2];
      var v1x = tris[off+3], v1y = tris[off+4], v1z = tris[off+5];
      var v2x = tris[off+6], v2y = tris[off+7], v2z = tris[off+8];
      var e1x = v1x - v0x, e1y = v1y - v0y, e1z = v1z - v0z;
      var e2x = v2x - v0x, e2y = v2y - v0y, e2z = v2z - v0z;
      var px = dy*e2z - dz*e2y;
      var py = dz*e2x - dx*e2z;
      var pz = dx*e2y - dy*e2x;
      var det = e1x*px + e1y*py + e1z*pz;
      if (det > -EPS && det < EPS) return -1;
      var invDet = 1.0 / det;
      var tx = ox - v0x, ty = oy - v0y, tz = oz - v0z;
      var u = (tx*px + ty*py + tz*pz) * invDet;
      if (u < 0 || u > 1) return -1;
      var qx = ty*e1z - tz*e1y;
      var qy = tz*e1x - tx*e1z;
      var qz = tx*e1y - ty*e1x;
      var v = (dx*qx + dy*qy + dz*qz) * invDet;
      if (v < 0 || u + v > 1) return -1;
      var t = (e2x*qx + e2y*qy + e2z*qz) * invDet;
      return t > EPS ? t : -1;
    }

    // ── Ray cast against a BVH ──────────────────────────────────
    // Returns the smallest hit distance ≤ maxT, or Infinity if no hit.
    // Traversal recurses into nearer child first using the slab tMin so
    // we can early-out as soon as a hit smaller than the remaining cone
    // shows up.
    function _bvhRayCast(node, tris, ox, oy, oz, dx, dy, dz, maxT) {
      if (!node) return Infinity;
      var slab = _rayAABB(ox, oy, oz, dx, dy, dz, node);
      if (!slab || slab[0] > maxT) return Infinity;
      // Leaf
      if (node.lo !== undefined) {
        var best = Infinity;
        for (var i = node.lo; i < node.hi; i++) {
          var triIdx = node.idx[i];
          var t = _rayTri(ox, oy, oz, dx, dy, dz, tris, triIdx * 9);
          if (t > 0 && t < best && t <= maxT) best = t;
        }
        return best;
      }
      var hl = _bvhRayCast(node.left,  tris, ox, oy, oz, dx, dy, dz, maxT);
      var hr = _bvhRayCast(node.right, tris, ox, oy, oz, dx, dy, dz, Math.min(maxT, hl));
      return hl < hr ? hl : hr;
    }

    // ── Main: visibility check ───────────────────────────────────
    //
    // rule = {
    //   viewer:     { types:[], namePattern:'', ids:[], sampling:{mode,eyeHeight,stride,facing,coneDeg} },
    //   target:     { types:[], namePattern:'', ids:[] },
    //   obstructer: { excludeTypes:[], includeTypes:[] },
    //   maxRange:   25.0,
    //   sampleId:   'unique-rule-name'   // for clash ID stability
    // }
    window._ccDetectVisibility = function(rule) {
      rule = rule || {};
      var all = _allElements();
      var viewers = _resolveFilter(rule.viewer, all);
      var targets = _resolveFilter(rule.target, all);
      if (!viewers.length || !targets.length) {
        return Promise.resolve({
          clashes: [],
          summary: { reason: 'no viewers (' + viewers.length + ') or targets (' + targets.length + ')' }
        });
      }

      // Obstructer candidates: everything except the explicitly-excluded
      // types + the viewer-host elements + the targets themselves.
      var excludeTypes = Object.assign({}, DEFAULT_OBSTRUCTER_EXCLUDES);
      if (rule.obstructer && Array.isArray(rule.obstructer.excludeTypes)) {
        rule.obstructer.excludeTypes.forEach(function(t){ excludeTypes[t] = true; });
      }
      var includeTypes = (rule.obstructer && Array.isArray(rule.obstructer.includeTypes) && rule.obstructer.includeTypes.length)
        ? rule.obstructer.includeTypes.reduce(function(acc, t){ acc[t] = true; return acc; }, {})
        : null;
      var viewerIds = {}; viewers.forEach(function(v){ viewerIds[v.el.expressId] = true; });
      var targetIds = {}; targets.forEach(function(t){ targetIds[t.el.expressId] = true; });
      var obstructers = all.filter(function(e){
        if (viewerIds[e.el.expressId] || targetIds[e.el.expressId]) return false;
        var t = _typeOf(e.el);
        if (excludeTypes[t]) return false;
        if (includeTypes && !includeTypes[t]) return false;
        return true;
      });

      var maxRange = rule.maxRange != null ? rule.maxRange : 50.0;
      var coneCos = null;
      var facing = null;
      if (rule.viewer && rule.viewer.sampling && rule.viewer.sampling.coneDeg != null && rule.viewer.sampling.facing) {
        coneCos = Math.cos(rule.viewer.sampling.coneDeg * Math.PI / 180);
        facing  = rule.viewer.sampling.facing;
        var fLen = Math.sqrt(facing[0]*facing[0] + facing[1]*facing[1] + facing[2]*facing[2]);
        if (fLen > 0) facing = [facing[0]/fLen, facing[1]/fLen, facing[2]/fLen];
        else facing = null;
      }

      // Pre-warm BVH for obstructers and pre-compute their bboxes so the
      // outer loop can early-skip on a segment-vs-bbox test before
      // descending into the BVH proper.
      var obstructerSnapshot = obstructers.map(function(entry){
        var b = entry.el.box;
        return {
          entry: entry,
          mnx: b ? b.min.x : 0, mxx: b ? b.max.x : 0,
          mny: b ? b.min.y : 0, mxy: b ? b.max.y : 0,
          mnz: b ? b.min.z : 0, mxz: b ? b.max.z : 0,
          bvh: null  // lazy
        };
      });

      // Target sampling: grid size on the target face. 1 = centroid
      // (cheap, legacy). 3 = 3×3 → partial occlusion can be graded.
      var targetGrid = (rule.target && rule.target.surfaceGrid != null)
        ? rule.target.surfaceGrid
        : (rule.targetGrid != null ? rule.targetGrid : 3);

      var clashes = [];
      var nRays = 0, nHits = 0, nPartial = 0;
      var sampleId = rule.sampleId || ('vis_' + Date.now().toString(36));

      // Per-pair test: cast one ray for each surface sample of the
      // target and aggregate the results. Returns:
      //   { samples, blocked, worstT, worstBlocker, worstHitPoint, worstT_target }
      // The "worst" tracking picks the nearest blocker (the one a
      // coordinator should consider relocating first) and its
      // corresponding target sample point so the sight-line viz reads
      // along the most-blocked ray.
      function _testPair(V, tgt) {
        var samples = _targetSurfaceSamples(tgt, V, targetGrid);
        var blocked = 0;
        var worstT = Infinity;
        var worstBlocker = null;
        var worstT_target = null;
        for (var si = 0; si < samples.length; si++) {
          var T = samples[si];
          var dxL = T[0] - V[0], dyL = T[1] - V[1], dzL = T[2] - V[2];
          var lenL = Math.sqrt(dxL*dxL + dyL*dyL + dzL*dzL);
          if (lenL < 1e-6) continue;
          if (lenL > maxRange) continue;
          dxL /= lenL; dyL /= lenL; dzL /= lenL;
          if (coneCos != null && facing) {
            var dotFL = facing[0]*dxL + facing[1]*dyL + facing[2]*dzL;
            if (dotFL < coneCos) continue;
          }
          nRays++;
          var bestT = lenL;
          var hitBlocker = null;
          for (var oi = 0; oi < obstructerSnapshot.length; oi++) {
            var snap = obstructerSnapshot[oi];
            if (V[0] > snap.mxx && T[0] > snap.mxx) continue;
            if (V[0] < snap.mnx && T[0] < snap.mnx) continue;
            if (V[1] > snap.mxy && T[1] > snap.mxy) continue;
            if (V[1] < snap.mny && T[1] < snap.mny) continue;
            if (V[2] > snap.mxz && T[2] > snap.mxz) continue;
            if (V[2] < snap.mnz && T[2] < snap.mnz) continue;
            if (snap.bvh === null) {
              snap.bvh = (typeof window._ccGetBVH === 'function') ? window._ccGetBVH(snap.entry.el) : null;
              if (snap.bvh === null) snap.bvh = false;
            }
            if (!snap.bvh) continue;
            var h = _bvhRayCast(snap.bvh.root, snap.bvh.tris, V[0], V[1], V[2], dxL, dyL, dzL, bestT);
            if (h < bestT) { bestT = h; hitBlocker = snap.entry; if (h < 0.05) break; }
          }
          if (hitBlocker) {
            blocked++;
            if (bestT < worstT) {
              worstT = bestT;
              worstBlocker = hitBlocker;
              worstT_target = T;
            }
          }
        }
        return { samples: samples.length, blocked: blocked, worstT: worstT, worstBlocker: worstBlocker, worstT_target: worstT_target };
      }

      // Time-slice viewer iteration so big federations don't lock the UI.
      var vi = 0;
      var BATCH = 8;
      return new Promise(function(resolve) {
        function _stepViewers() {
          var stopAt = Math.min(viewers.length, vi + BATCH);
          for (; vi < stopAt; vi++) {
            var v = viewers[vi];
            var samples = _viewerSamples(v, rule.viewer && rule.viewer.sampling);
            for (var s = 0; s < samples.length; s++) {
              var V = samples[s];
              for (var ti = 0; ti < targets.length; ti++) {
                var tgt = targets[ti];
                var res = _testPair(V, tgt);
                if (res.samples === 0 || res.blocked === 0) continue;
                var occlusionRate = res.blocked / res.samples;
                var isPartial = res.blocked < res.samples;
                if (isPartial) nPartial++;
                var T = res.worstT_target;
                var len = Math.sqrt(
                  (T[0]-V[0])*(T[0]-V[0]) + (T[1]-V[1])*(T[1]-V[1]) + (T[2]-V[2])*(T[2]-V[2])
                );
                var blocker = res.worstBlocker;
                var bestT = res.worstT;
                if (true) {
                  nHits++;
                  clashes.push({
                    id: 'vis_' + sampleId + '_' + v.el.expressId + '_' + tgt.el.expressId + '_' + s,
                    type: 'visibility',
                    status: 'open',
                    priority: isPartial ? 'low' : 'normal',
                    title: (isPartial ? 'Partial visibility block: ' : 'Visibility blocked: ') +
                           (_nameOf(tgt.el) || ('#' + tgt.el.expressId)) +
                           ' from ' + (_nameOf(v.el) || ('#' + v.el.expressId)) +
                           (isPartial ? ' (' + Math.round(occlusionRate*100) + '% blocked)' : ''),
                    description: 'Sight line from ' + (_nameOf(v.el) || ('viewer #' + v.el.expressId)) +
                                 ' to ' + (_nameOf(tgt.el) || ('target #' + tgt.el.expressId)) +
                                 ' is ' + (isPartial ? 'partially' : 'fully') + ' blocked by ' +
                                 (_nameOf(blocker.el) || ('#' + blocker.el.expressId)) +
                                 ' (' + (_typeOf(blocker.el) || 'unknown type') + ')' +
                                 ' at ' + bestT.toFixed(2) + ' m along a ' + len.toFixed(2) + ' m line.',
                    point: [V[0] + dx*bestT, V[1] + dy*bestT, V[2] + dz*bestT],
                    elemA: v.el.expressId,
                    elemB: tgt.el.expressId,
                    elemBlocker: blocker.el.expressId,
                    elemAName: _nameOf(v.el),
                    elemBName: _nameOf(tgt.el),
                    elemBlockerName: _nameOf(blocker.el),
                    elemAType: _typeOf(v.el),
                    elemBType: _typeOf(tgt.el),
                    elemBlockerType: _typeOf(blocker.el),
                    modelAId: v.modelId,
                    modelBId: tgt.modelId,
                    distance: bestT,
                    rangeTotal: len,
                    sightFrom: V.slice(),
                    sightTo: T.slice(),
                    partialOcclusion: isPartial,
                    blockedSamples: res.blocked,
                    totalSamples: res.samples,
                    occlusionRate: occlusionRate,
                    category: 'visibility',
                    source: 'visibility_check',
                    sampleId: sampleId,
                    createdAt: new Date().toISOString()
                  });
                }
              }
            }
          }
          if (vi < viewers.length) { setTimeout(_stepViewers, 0); return; }
          resolve({
            clashes: clashes,
            summary: {
              viewers: viewers.length,
              targets: targets.length,
              obstructers: obstructers.length,
              raysCast: nRays,
              blocked: nHits,
              partialBlocked: nPartial,
              targetGrid: targetGrid,
              clearRate: nRays > 0 ? (1 - nHits/nRays) : 0
            }
          });
        }
        _stepViewers();
      });
    };

    // Schema descriptor for any UI / NL command that wants to expose
    // visibility configuration. JSON-schema-ish, deliberately compact.
    window._ccVisibilityRuleSchema = function() {
      return {
        type: 'visibility',
        version: 1,
        fields: {
          viewer: {
            types:        { type:'string[]',  hint:'IFC type list, e.g. ["IfcSpace"]' },
            namePattern:  { type:'regex',     hint:'optional name filter, case-insensitive' },
            ids:          { type:'int[]',     hint:'manual pick — expressIds, wins over types' },
            sampling: {
              mode:       { type:'enum',      values:['centroid','grid','path'], default:'centroid' },
              eyeHeight:  { type:'number',    default:1.65, unit:'m' },
              stride:     { type:'number',    default:2.0,  unit:'m' },
              coneDeg:    { type:'number',    default:null, hint:'cone half-angle, omit for omnidirectional' },
              facing:     { type:'vec3',      default:null, hint:'unit vector of viewer facing direction' }
            }
          },
          target: {
            types:       { type:'string[]', hint:'IFC type list' },
            namePattern: { type:'regex',    hint:'optional name filter' },
            ids:         { type:'int[]',    hint:'manual pick — expressIds, wins over types' }
          },
          obstructer: {
            excludeTypes: { type:'string[]', hint:'add to defaults: IfcSpace, IfcAnnotation, IfcGrid' },
            includeTypes: { type:'string[]', hint:'if set, only check these types as obstructers' }
          },
          maxRange: { type:'number', default:50, unit:'m', hint:'skip viewer/target pairs farther than this' },
          sampleId: { type:'string', hint:'rule label used in clash ids — make stable for reruns' }
        }
      };
    };

    // Preset library — these are starting points coordinators can run
    // directly. Tied to recognised conventions / regulations.
    var PRESETS = {
      'exit-signs-generic': {
        sampleId: 'exit-signs-generic',
        viewer:  { types:['IfcSpace'], sampling:{mode:'grid', eyeHeight:1.65, stride:3.0} },
        target:  { types:['IfcSign','IfcLightFixture'], namePattern:'exit|uitgang|sortie|notausgang' },
        obstructer: { excludeTypes:['IfcFurnishingElement'] },
        maxRange: 25.0,
        mode: 'obstruction'
      },
      // EN 1838 emergency-lighting variant: same idea as the generic
      // preset but with the 25 m luminaire-spacing rule baked into
      // maxRange and a stricter obstructer set (furniture counts).
      'exit-signs-EN-1838': {
        sampleId: 'exit-signs-EN-1838',
        viewer:  { types:['IfcSpace'], sampling:{mode:'grid', eyeHeight:1.65, stride:2.0} },
        target:  { types:['IfcSign','IfcLightFixture'], namePattern:'exit|escape|emergency|notausgang' },
        obstructer: { excludeTypes:[] },
        maxRange: 25.0,
        mode: 'obstruction'
      },
      // BS 5499-style — UK exit signs, same geometry, label kept
      // distinct so the BCF / report carries the regulation context.
      'exit-signs-BS-5499': {
        sampleId: 'exit-signs-BS-5499',
        viewer:  { types:['IfcSpace'], sampling:{mode:'grid', eyeHeight:1.65, stride:2.0} },
        target:  { types:['IfcSign'], namePattern:'exit|escape' },
        obstructer: { excludeTypes:[] },
        maxRange: 25.0,
        mode: 'obstruction'
      },
      'workplace-window-view-NL': {
        sampleId: 'workplace-view-NL',
        viewer:  { types:['IfcFurnishingElement'], namePattern:'desk|werkplek|workstation', sampling:{mode:'centroid', eyeHeight:1.20} },
        target:  { types:['IfcWindow'] },
        obstructer: { excludeTypes:['IfcFurnishingElement','IfcDoor'] },
        maxRange: 6.0,
        mode: 'obstruction'
      },
      'nurse-station-LOS': {
        sampleId: 'nurse-station-LOS',
        viewer:  { types:['IfcFurnishingElement'], namePattern:'nurse|verpleeg|station', sampling:{mode:'centroid', eyeHeight:1.20} },
        target:  { types:['IfcSpace'], namePattern:'bed|patient|kamer|room' },
        obstructer: { excludeTypes:[] },
        maxRange: 25.0,
        mode: 'obstruction'
      },
      'wheelchair-exit-signs-1200': {
        sampleId: 'wheelchair-exit-signs',
        viewer:  { types:['IfcSpace'], sampling:{mode:'grid', eyeHeight:1.20, stride:3.0} },
        target:  { types:['IfcSign','IfcLightFixture'], namePattern:'exit|uitgang|sortie' },
        obstructer: { excludeTypes:['IfcFurnishingElement'] },
        maxRange: 25.0,
        mode: 'obstruction'
      },
      // Reception line-of-sight — receptionist must see the front
      // door + waiting area. Frequently violated by tall plants /
      // standing screens that designers add after the fact.
      'reception-front-door-LOS': {
        sampleId: 'reception-LOS',
        viewer:  { types:['IfcFurnishingElement'], namePattern:'reception|balie|receptie', sampling:{mode:'centroid', eyeHeight:1.20} },
        target:  { types:['IfcDoor'], namePattern:'entrance|main|hoofdingang' },
        obstructer: { excludeTypes:[] },
        maxRange: 30.0,
        mode: 'obstruction'
      },
      // ── Inverse / coverage presets ─────────────────────────────
      'surveillance-camera-coverage': {
        sampleId: 'cam-coverage',
        viewer:  { types:['IfcSpace'], sampling:{mode:'grid', eyeHeight:1.50, stride:2.0} },
        target:  { types:['IfcFlowTerminal','IfcSensor','IfcAudioVisualAppliance'], namePattern:'camera|cctv|surveillance' },
        obstructer: { excludeTypes:[] },
        maxRange: 15.0,
        mode: 'coverage'
      },
      'smoke-detector-coverage': {
        sampleId: 'smoke-coverage',
        viewer:  { types:['IfcSpace'], sampling:{mode:'grid', eyeHeight:2.20, stride:2.0} },
        target:  { types:['IfcSensor','IfcFlowTerminal'], namePattern:'smoke|rook|detector' },
        obstructer: { excludeTypes:[] },
        maxRange: 8.0,
        mode: 'coverage'
      },
      'patient-bay-nurse-observation': {
        sampleId: 'patient-observ',
        viewer:  { types:['IfcSpace'], namePattern:'bed|patient|kamer', sampling:{mode:'centroid', eyeHeight:1.0} },
        target:  { types:['IfcFurnishingElement'], namePattern:'nurse|verpleeg|station' },
        obstructer: { excludeTypes:[] },
        maxRange: 25.0,
        mode: 'coverage'
      }
    };
    window._ccVisibilityPresets = function() { return Object.keys(PRESETS).map(function(k){ return Object.assign({key:k}, PRESETS[k]); }); };
    window._ccVisibilityRunPreset = function(key) {
      var p = PRESETS[key];
      if (!p) return Promise.reject(new Error('Unknown visibility preset: ' + key));
      return p.mode === 'coverage' ? window._ccDetectCoverage(p) : window._ccDetectVisibility(p);
    };

    // ── Inverse / coverage mode ───────────────────────────────────
    //
    // Same engine, flipped semantic. In the obstruction case we report
    // each viewer→target pair where the line is blocked. In coverage
    // mode we report each viewer that is NOT clearly seen by ANY of the
    // targets. Unlocks:
    //   - Surveillance camera coverage gaps (viewer = sampled floor
    //     point, target = IfcFlowTerminal "camera")
    //   - Fire / smoke sensor coverage (viewer = ceiling sample,
    //     target = sensors)
    //   - Nurse-station observation gaps (viewer = patient bay sample,
    //     target = nurse station)
    //
    // Result clashes are anchored on the under-covered viewer point
    // (.point), with elemB=null because no single target "owns" the
    // gap. The 3D viz path treats sightFrom only and skips the sight
    // line — a coverage gap is visualised as a red dot in space, not a
    // line.
    window._ccDetectCoverage = function(rule) {
      rule = rule || {};
      // Reuse the same filter resolution + obstructer construction;
      // we just need to invert the per-pair logic.
      var all = _allElements();
      var viewers = _resolveFilter(rule.viewer, all);
      var targets = _resolveFilter(rule.target, all);
      if (!viewers.length || !targets.length) {
        return Promise.resolve({ clashes: [], summary: { reason: 'no viewers (' + viewers.length + ') or targets (' + targets.length + ')' } });
      }
      var excludeTypes = Object.assign({}, DEFAULT_OBSTRUCTER_EXCLUDES);
      if (rule.obstructer && Array.isArray(rule.obstructer.excludeTypes)) {
        rule.obstructer.excludeTypes.forEach(function(t){ excludeTypes[t] = true; });
      }
      var viewerIds = {}; viewers.forEach(function(v){ viewerIds[v.el.expressId] = true; });
      var targetIds = {}; targets.forEach(function(t){ targetIds[t.el.expressId] = true; });
      var obstructers = all.filter(function(e){
        if (viewerIds[e.el.expressId] || targetIds[e.el.expressId]) return false;
        if (excludeTypes[_typeOf(e.el)]) return false;
        return true;
      });
      var maxRange = rule.maxRange != null ? rule.maxRange : 25.0;
      var obstSnaps = obstructers.map(function(entry){
        var b = entry.el.box;
        return {
          entry: entry,
          mnx: b ? b.min.x : 0, mxx: b ? b.max.x : 0,
          mny: b ? b.min.y : 0, mxy: b ? b.max.y : 0,
          mnz: b ? b.min.z : 0, mxz: b ? b.max.z : 0,
          bvh: null
        };
      });
      var targetPoints = targets.map(function(t){
        var b = t.el.box; if (!b) return null;
        return {
          entry: t,
          point: [(b.min.x + b.max.x)*0.5, (b.min.y + b.max.y)*0.5, (b.min.z + b.max.z)*0.5]
        };
      }).filter(function(t){ return t != null; });

      function _isClear(V, T) {
        var dxL = T[0] - V[0], dyL = T[1] - V[1], dzL = T[2] - V[2];
        var lenL = Math.sqrt(dxL*dxL + dyL*dyL + dzL*dzL);
        if (lenL > maxRange || lenL < 1e-6) return false;
        dxL /= lenL; dyL /= lenL; dzL /= lenL;
        for (var oi = 0; oi < obstSnaps.length; oi++) {
          var snap = obstSnaps[oi];
          if (V[0] > snap.mxx && T[0] > snap.mxx) continue;
          if (V[0] < snap.mnx && T[0] < snap.mnx) continue;
          if (V[1] > snap.mxy && T[1] > snap.mxy) continue;
          if (V[1] < snap.mny && T[1] < snap.mny) continue;
          if (V[2] > snap.mxz && T[2] > snap.mxz) continue;
          if (V[2] < snap.mnz && T[2] < snap.mnz) continue;
          if (snap.bvh === null) {
            snap.bvh = (typeof window._ccGetBVH === 'function') ? window._ccGetBVH(snap.entry.el) : null;
            if (snap.bvh === null) snap.bvh = false;
          }
          if (!snap.bvh) continue;
          var h = _bvhRayCast(snap.bvh.root, snap.bvh.tris, V[0], V[1], V[2], dxL, dyL, dzL, lenL);
          if (h > 0 && h < lenL) return false;
        }
        return true;
      }

      var clashes = [];
      var nViewerPts = 0, nUncovered = 0;
      var sampleId = rule.sampleId || ('cov_' + Date.now().toString(36));
      var vi = 0, BATCH = 4;
      return new Promise(function(resolve) {
        function _step() {
          var stopAt = Math.min(viewers.length, vi + BATCH);
          for (; vi < stopAt; vi++) {
            var v = viewers[vi];
            var samples = _viewerSamples(v, rule.viewer && rule.viewer.sampling);
            for (var s = 0; s < samples.length; s++) {
              var V = samples[s];
              nViewerPts++;
              var coveredBy = null;
              for (var ti = 0; ti < targetPoints.length; ti++) {
                if (_isClear(V, targetPoints[ti].point)) { coveredBy = targetPoints[ti].entry; break; }
              }
              if (!coveredBy) {
                nUncovered++;
                clashes.push({
                  id: 'cov_' + sampleId + '_' + v.el.expressId + '_' + s,
                  type: 'visibility',
                  status: 'open',
                  priority: 'normal',
                  title: 'Coverage gap in ' + (_nameOf(v.el) || ('#' + v.el.expressId)) +
                         ' — no ' + (rule.target && rule.target.types ? rule.target.types.join('/') : 'target') + ' visible',
                  description: 'Point [' + V.map(function(x){return x.toFixed(2);}).join(', ') + '] is not in clear line of sight of any candidate target within ' + maxRange + ' m.',
                  point: V.slice(),
                  elemA: v.el.expressId,
                  elemAName: _nameOf(v.el),
                  elemAType: _typeOf(v.el),
                  modelAId: v.modelId,
                  sightFrom: V.slice(),
                  category: 'visibility',
                  source: 'visibility_coverage',
                  sampleId: sampleId,
                  coverageGap: true,
                  rangeTotal: maxRange,
                  createdAt: new Date().toISOString()
                });
              }
            }
          }
          if (vi < viewers.length) { setTimeout(_step, 0); return; }
          resolve({
            clashes: clashes,
            summary: {
              viewers: viewers.length,
              targets: targets.length,
              obstructers: obstructers.length,
              viewerPoints: nViewerPts,
              uncovered: nUncovered,
              coverageRate: nViewerPts > 0 ? (1 - nUncovered/nViewerPts) : 0
            }
          });
        }
        _step();
      });
    };
    window._ccDetectCoverageAndMerge = function(rule) {
      return window._ccDetectCoverage(rule).then(function(res){
        if (res.clashes.length && window._ccDispatch) {
          window._ccDispatch({ t: 'ADD_CLASHES', v: res.clashes });
        }
        return res;
      });
    };

    // Convenience: run a check and merge results into the existing
    // clashes state so they show up in the Issues / Conflicts panel
    // alongside hard and soft clashes.
    window._ccDetectVisibilityAndMerge = function(rule) {
      return window._ccDetectVisibility(rule).then(function(res){
        if (res.clashes.length && window._ccDispatch) {
          // ADD_CLASHES is the additive merge path the accessibility
          // addon uses. Doesn't auto-resolve unrelated clashes.
          window._ccDispatch({ t: 'ADD_CLASHES', v: res.clashes });
        }
        return res;
      });
    };

    if (typeof window._ccRegisterAddon === 'function') {
      window._ccRegisterAddon({
        id: 'visibility',
        alwaysOn: true,
        name: 'Visibility clash detection',
        description: 'Third clash category — geometric ray-cast against the BVH the clash engine builds. Catches sight-line obstructions: exit signs, traffic signs, surveillance coverage, nurse-station observation, reception line-of-sight, workplace window views. Layered filters (IFC type, name regex, custom pset, manual pick) for viewer / target / obstructer roles plus a preset library for common regulations.'
      });
    }
  }
})();
