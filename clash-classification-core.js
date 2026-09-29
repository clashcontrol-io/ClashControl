// @ts-check
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccClashClassificationCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // Deterministic triage — including the spatial-hash cluster grouping (the
  // old all-pairs O(n²) scan was the detection wall on large federations).
  // Severity for hard/soft clashes comes from deterministicSeverity() below
  // (penetration depth / clearance x element role).
  function classifyClashes(clashes) {
    var FP_TYPES = ['IfcOpeningElement','IfcOpeningStandardCase','IfcSpace','IfcVirtualElement'];
    var STRUCTURAL_DISC = 'structural';
    var INSULATION_MAT = 'insulation';

    clashes.forEach(function(c) {
      if (c.aiSeverity) return;

      var typeA = c.elemAType || '';
      var typeB = c.elemBType || '';
      var discs = c.disciplines || [];
      var crossDisc = discs.length >= 2 && discs[0] !== discs[1];
      // Case-insensitive: the IFC discipline classifier yields lowercase
      // ('structural'), but Revit-bridge and preset sources can be capitalised.
      var hasStructural = false, structuralAt = -1;
      for (var _si = 0; _si < discs.length; _si++) {
        if (String(discs[_si] || '').toLowerCase() === STRUCTURAL_DISC) { hasStructural = true; structuralAt = _si; break; }
      }
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
        // Severity comes from the shared deterministic model (gap vs the
        // required clearance, weighted by element role) — see
        // deterministicSeverity below.
        var gap = c.clearanceMm || Math.abs(c.distance || 0);
        sev = deterministicSeverity(c); cat = 'clearance';
        reason = (sev === 'major' ? 'Near miss — only ' : '') + Math.round(gap) + 'mm clearance' +
          (sev === 'major' ? '' : ' gap') + (crossDisc ? ' (cross-discipline)' : '');
      } else {
        // Hard clash: penetration depth x element role (see the role table).
        sev = deterministicSeverity(c); cat = 'penetration';
        if (crossDisc && hasStructural) {
          var otherDisc = structuralAt === 0 ? discs[1] : discs[0];
          reason = (otherDisc || 'MEP') + ' penetrating primary structure';
        } else if (crossDisc) {
          reason = 'Cross-discipline clash: ' + discs.join(' vs ');
        } else {
          reason = 'Same-discipline intersection';
        }
        if (typeof c.distance === 'number' && c.distance < 0) reason += ' — ' + Math.round(-c.distance) + 'mm deep';
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
      // Marks the verdict as rule-derived (not AI triage) so a re-run
      // re-derives it from the fresh geometry instead of the reconciler
      // carrying a stale one forward (see clash-reconciliation-core.js).
      c._sevSource = 'rule';
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

  // ════════════════════════════════════════════════════════════════════
  // Smarter clashes — element role + deterministic severity
  // ════════════════════════════════════════════════════════════════════
  // Everything below is pure post-processing on top of the clash engine's
  // results (penetration depth, overlap volume, clearance gap); nothing here
  // touches the geometric kernel.
  //
  // ── Role table (elementRole) ────────────────────────────────────────
  //   role            criticality  IFC types
  //   structural          3        IfcBeam, IfcColumn, IfcFooting, IfcPile, IfcMember,
  //                                IfcSlab (unless LoadBearing=false), IfcWall /
  //                                IfcWallStandardCase with LoadBearing=true,
  //                                reinforcement, IfcStructural*
  //   mep-main            2        IfcDuctSegment, IfcPipeSegment, IfcCableCarrier-
  //                                Segment, IfcCableSegment, IfcConduitSegment,
  //                                IfcFlowSegment (the long runs)
  //   infrastructure      2        civil-discipline elements of unknown IFC type
  //   architectural       1        non-load-bearing walls, doors, windows, stairs,
  //                                ramps, roofs, plates, curtain walls, railings
  //   mep-terminal        1        terminals, fittings, valves, devices, equipment
  //                                (IfcFlowTerminal, IfcDuctFitting, IfcPipeFitting,
  //                                IfcFlow*Device, IfcDistribution*, IfcLightFixture ...)
  //   other               1        anything unrecognised (IfcBuildingElementProxy ...)
  //   finish              0        IfcCovering, IfcFurnishingElement, IfcFurniture,
  //                                IfcSystemFurnitureElement
  // A clash's pair criticality is the MAX of its two elements.
  var ROLE_CRIT = { structural:3, 'mep-main':2, infrastructure:2, architectural:1, 'mep-terminal':1, other:1, finish:0 };
  var STRUCTURAL_TYPES = { IfcBeam:1, IfcColumn:1, IfcFooting:1, IfcPile:1, IfcMember:1,
    IfcReinforcingBar:1, IfcReinforcingMesh:1, IfcTendon:1, IfcTendonAnchor:1 };
  var MEP_MAIN_TYPES = { IfcDuctSegment:1, IfcPipeSegment:1, IfcCableCarrierSegment:1,
    IfcCableSegment:1, IfcConduitSegment:1, IfcFlowSegment:1 };
  var ARCH_TYPES = { IfcDoor:1, IfcWindow:1, IfcStair:1, IfcStairFlight:1, IfcRamp:1, IfcRampFlight:1,
    IfcRoof:1, IfcPlate:1, IfcCurtainWall:1, IfcRailing:1, IfcChimney:1, IfcShadingDevice:1 };
  var FINISH_TYPES = { IfcCovering:1, IfcFurnishingElement:1, IfcFurniture:1, IfcSystemFurnitureElement:1 };
  var DISC_DEFAULT_ROLE = { structural:'structural', mep:'mep-main', civil:'infrastructure', architectural:'architectural' };
  var MEP_TERMINAL_RE = /^Ifc(Flow|Distribution|Duct|Pipe|Cable|Electric|Light|Sensor|Actuator|Alarm|Valve|Pump|Fan|Boiler|Chiller|Unitary|Air|Outlet|Junction|Protective|Sanitary|Fire|Communications|Audio|Controller|Motor|Tank|Heat|Coil|Damper|Filter|Interceptor|Switching|Transformer|Medical|Stack)/;

  // Parses the many spellings of a boolean pset value (true / 'TRUE' / 1 /
  // '.T.'). Returns true / false / null (unknown).
  function _bool(v) {
    if (v === true || v === false) return v;
    if (v == null) return null;
    if (typeof v === 'number') return v !== 0;
    var t = String(v).trim().toLowerCase();
    if (t === 'true' || t === '.t.' || t === '1' || t === 'yes') return true;
    if (t === 'false' || t === '.f.' || t === '0' || t === 'no') return false;
    return null;
  }
  // LoadBearing lives in Pset_*Common (any pset name, any case) — same lookup
  // shape data-quality.js uses. Returns true / false / null.
  function loadBearingOf(props) {
    var psets = props && props.psets;
    if (!psets || typeof psets !== 'object') return null;
    var names = Object.keys(psets);
    for (var i = 0; i < names.length; i++) {
      var grp = psets[names[i]];
      if (!grp || typeof grp !== 'object') continue;
      var keys = Object.keys(grp);
      for (var k = 0; k < keys.length; k++) {
        if (keys[k].toLowerCase() === 'loadbearing') return _bool(grp[keys[k]]);
      }
    }
    return null;
  }
  // opts: { loadBearing: true|false|null, discipline: 'structural'|'mep'|... }
  function elementRole(ifcType, opts) {
    opts = opts || {};
    var t = String(ifcType || '');
    if (t && t.indexOf('Ifc') !== 0) t = 'Ifc' + t;
    var lb = opts.loadBearing;
    if (STRUCTURAL_TYPES[t] || t.indexOf('IfcStructural') === 0) return 'structural';
    if (t === 'IfcSlab' || t === 'IfcSlabStandardCase' || t === 'IfcSlabElementedCase') {
      return lb === false ? 'architectural' : 'structural';
    }
    if (t === 'IfcWall' || t === 'IfcWallStandardCase' || t === 'IfcWallElementedCase') {
      return lb === true ? 'structural' : 'architectural';
    }
    if (MEP_MAIN_TYPES[t]) return 'mep-main';
    if (FINISH_TYPES[t]) return 'finish';
    if (ARCH_TYPES[t]) return 'architectural';
    if (MEP_TERMINAL_RE.test(t)) return 'mep-terminal';
    var d = String(opts.discipline || '').toLowerCase();
    if ((!t || t === 'IfcBuildingElementProxy' || t === 'IfcElement') && DISC_DEFAULT_ROLE[d]) return DISC_DEFAULT_ROLE[d];
    return 'other';
  }
  function roleCriticality(role) {
    return ROLE_CRIT.hasOwnProperty(role) ? ROLE_CRIT[role] : 1;
  }

  // ── Deterministic severity ──────────────────────────────────────────
  // Vocabulary matches aiSeverity exactly (critical / major / minor / info).
  // Inputs read from the clash object: type, distance (mm, negative =
  // penetration depth), clearanceMm (soft gap), requiredClearanceMm (the
  // clearance the rule asked for; default 50), overlapVolM3 (AABB overlap
  // volume from the engine), roleA/roleB (stamped at detection) with a
  // fallback derived from elemAType/elemBType + disciplines for legacy clashes.
  //
  // HARD clash, depth d (mm), pair criticality c = max(critA, critB):
  //   d < 10                     -> minor (info when c == 0): tolerance/rounding floor
  //   c = 3 (structural)         -> d >= 20 critical, d >= 10 major
  //   c = 2 (MEP run / civil)    -> d >= 50 critical, d >= 10 major
  //   c = 1 (terminal, arch ...) -> d >= 100 critical, d >= 10 major
  //   c = 0 (finishes only)      -> never critical; d >= 50 major, else minor
  //   overlap volume >= 0.05 m3 bumps minor/major one tier when c >= 2
  // SOFT clash, gap g vs required clearance r (ratio = g / r):
  //   ratio <= 0.3 -> major (near miss), else minor;  c == 0 drops one tier
  // duplicate -> info;  visibility (sight-line) -> major.
  var TIERS = ['info', 'minor', 'major', 'critical'];
  function _shift(sev, delta) {
    var i = TIERS.indexOf(sev) + delta;
    return TIERS[Math.max(0, Math.min(TIERS.length - 1, i))];
  }
  function _clashRole(c, side) {
    var r = side === 'A' ? c.roleA : c.roleB;
    if (r && ROLE_CRIT.hasOwnProperty(r)) return r;
    var discs = c.disciplines || [];
    return elementRole(side === 'A' ? c.elemAType : c.elemBType, { discipline: discs[side === 'A' ? 0 : 1] });
  }
  function pairCriticality(c) {
    return Math.max(roleCriticality(_clashRole(c, 'A')), roleCriticality(_clashRole(c, 'B')));
  }
  var HARD_THRESH = { 3:{major:10, critical:20}, 2:{major:10, critical:50}, 1:{major:10, critical:100}, 0:{major:50, critical:Infinity} };
  function deterministicSeverity(c) {
    if (!c) return 'info';
    if (c.type === 'duplicate') return 'info';
    if (c.type === 'visibility') return 'major';
    var crit = pairCriticality(c);
    if (c.type !== 'hard') {
      var gap = typeof c.clearanceMm === 'number' ? c.clearanceMm : (typeof c.distance === 'number' ? Math.abs(c.distance) : null);
      var req = (typeof c.requiredClearanceMm === 'number' && c.requiredClearanceMm > 0) ? c.requiredClearanceMm : 50;
      // No gap data at all -> no signal to escalate on.
      var soft = (gap != null && (gap / req) <= 0.3) ? 'major' : 'minor';
      return crit === 0 ? _shift(soft, -1) : soft;
    }
    var depth = (typeof c.distance === 'number' && c.distance < 0) ? -c.distance : 0;
    var vol = typeof c.overlapVolM3 === 'number' ? c.overlapVolM3 : 0;
    var th = HARD_THRESH[crit] || HARD_THRESH[1];
    var sev;
    if (depth < 10) sev = crit === 0 ? 'info' : 'minor';
    else if (depth >= th.critical) sev = 'critical';
    else if (depth >= th.major) sev = 'major';
    else sev = 'minor';
    if (crit >= 2 && vol >= 0.05 && (sev === 'minor' || sev === 'major')) sev = _shift(sev, 1);
    return sev;
  }

  // ════════════════════════════════════════════════════════════════════
  // Provision for void — clashes through IFC openings
  // ════════════════════════════════════════════════════════════════════
  // An opening is stored per host element as a flat 15-number oriented box:
  //   [cx,cy,cz, ux,uy,uz, vx,vy,vz, wx,wy,wz, hu,hv,hw]
  // centre, three orthonormal axes, three half-extents (metres, scene space).
  var OPENING_STRIDE = 15;
  function obbFromLocalBox(lmin, lmax, m) {
    // lmin/lmax: AABB of the opening geometry in its own local frame; m: the
    // 16-number column-major local->world matrix (web-ifc flatTransformation).
    var lc = [(lmin[0]+lmax[0])/2, (lmin[1]+lmax[1])/2, (lmin[2]+lmax[2])/2];
    var lh = [(lmax[0]-lmin[0])/2, (lmax[1]-lmin[1])/2, (lmax[2]-lmin[2])/2];
    var out = [
      m[0]*lc[0] + m[4]*lc[1] + m[8]*lc[2] + m[12],
      m[1]*lc[0] + m[5]*lc[1] + m[9]*lc[2] + m[13],
      m[2]*lc[0] + m[6]*lc[1] + m[10]*lc[2] + m[14]
    ];
    var scales = [];
    for (var a = 0; a < 3; a++) {
      var ax = m[a*4], ay = m[a*4+1], az = m[a*4+2];
      var sc = Math.sqrt(ax*ax + ay*ay + az*az) || 1;
      scales.push(sc);
      out.push(ax/sc, ay/sc, az/sc);
    }
    out.push(lh[0]*scales[0], lh[1]*scales[1], lh[2]*scales[2]);
    for (var i = 0; i < out.length; i++) out[i] = Math.round(out[i] * 10000) / 10000; // 0.1 mm
    return out;
  }
  function obbContains(o, x, y, z, tol) {
    var dx = x - o[0], dy = y - o[1], dz = z - o[2];
    var pu = dx*o[3] + dy*o[4] + dz*o[5];
    if (pu > o[12] + tol || pu < -o[12] - tol) return false;
    var pv = dx*o[6] + dy*o[7] + dz*o[8];
    if (pv > o[13] + tol || pv < -o[13] - tol) return false;
    var pw = dx*o[9] + dy*o[10] + dz*o[11];
    return !(pw > o[14] + tol || pw < -o[14] - tol);
  }

  // Sutherland-Hodgman clip of every triangle of `tris` (flat, 9 numbers per
  // triangle) against an axis-aligned box. Returns the flat xyz list of every
  // clipped-polygon vertex — i.e. the boundary of (element ∩ box). Returns
  // null when the triangle count exceeds maxTris (caller treats as unknown).
  function clipTrianglesToBox(tris, bmin, bmax, maxTris) {
    var n = (tris.length / 9) | 0;
    if (maxTris && n > maxTris) return null;
    var out = [];
    for (var t = 0; t < n; t++) {
      var o = t * 9;
      // quick AABB reject
      var minx = Math.min(tris[o], tris[o+3], tris[o+6]), maxx = Math.max(tris[o], tris[o+3], tris[o+6]);
      if (maxx < bmin[0] || minx > bmax[0]) continue;
      var miny = Math.min(tris[o+1], tris[o+4], tris[o+7]), maxy = Math.max(tris[o+1], tris[o+4], tris[o+7]);
      if (maxy < bmin[1] || miny > bmax[1]) continue;
      var minz = Math.min(tris[o+2], tris[o+5], tris[o+8]), maxz = Math.max(tris[o+2], tris[o+5], tris[o+8]);
      if (maxz < bmin[2] || minz > bmax[2]) continue;
      var poly = [[tris[o], tris[o+1], tris[o+2]], [tris[o+3], tris[o+4], tris[o+5]], [tris[o+6], tris[o+7], tris[o+8]]];
      for (var axis = 0; axis < 3 && poly.length; axis++) {
        for (var side = 0; side < 2 && poly.length; side++) {
          var lim = side === 0 ? bmin[axis] : bmax[axis];
          var sgn = side === 0 ? 1 : -1; // inside when sgn*(p-lim) >= 0
          var next = [];
          for (var i = 0; i < poly.length; i++) {
            var a = poly[i], b = poly[(i + 1) % poly.length];
            var da = sgn * (a[axis] - lim), db = sgn * (b[axis] - lim);
            if (da >= 0) next.push(a);
            if ((da >= 0) !== (db >= 0)) {
              var f = da / (da - db);
              next.push([a[0] + (b[0]-a[0])*f, a[1] + (b[1]-a[1])*f, a[2] + (b[2]-a[2])*f]);
            }
          }
          poly = next;
        }
      }
      for (var q = 0; q < poly.length; q++) out.push(poly[q][0], poly[q][1], poly[q][2]);
    }
    return out;
  }

  // Classify a clash region against one host's openings.
  //   openings : flat array (OPENING_STRIDE numbers per opening) or array of arrays
  //   pts      : flat xyz list — the element's (clipped) region inside the host
  //   tolM     : containment tolerance in metres
  //   type     : 'hard' | 'soft'
  // 'provided' — every region point lies inside one opening (± tolM): the
  //              element passes through a void made for it.
  // 'partial'  — (hard only) the region overlaps an opening (a point inside it,
  //              or the opening's centre inside the region's box) but pokes
  //              outside: "opening too small".
  // null       — no relationship to any opening.
  function classifyOpening(openings, pts, tolM, type) {
    if (!openings || !pts || pts.length < 3) return null;
    var list = [];
    if (openings.length && typeof openings[0] === 'number') {
      for (var i = 0; i + OPENING_STRIDE <= openings.length; i += OPENING_STRIDE) list.push(openings.slice(i, i + OPENING_STRIDE));
    } else list = openings;
    if (!list.length) return null;
    var tol = typeof tolM === 'number' ? tolM : 0.02;
    var n = (pts.length / 3) | 0;
    var mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (var p = 0; p < n; p++) for (var a = 0; a < 3; a++) {
      var v = pts[p*3 + a];
      if (v < mn[a]) mn[a] = v;
      if (v > mx[a]) mx[a] = v;
    }
    var partial = false;
    for (var k = 0; k < list.length; k++) {
      var o = list[k];
      if (!o || o.length < OPENING_STRIDE) continue;
      var inside = 0;
      for (var j = 0; j < n; j++) if (obbContains(o, pts[j*3], pts[j*3+1], pts[j*3+2], tol)) inside++;
      if (inside === n) return 'provided';
      if (type === 'hard' && !partial) {
        if (inside > 0) partial = true;
        else if (o[0] >= mn[0] - tol && o[0] <= mx[0] + tol && o[1] >= mn[1] - tol && o[1] <= mx[1] + tol &&
                 o[2] >= mn[2] - tol && o[2] <= mx[2] + tol) partial = true;
      }
    }
    return partial ? 'partial' : null;
  }
  // Visibility rank used when several raw clashes merge into one row: the most
  // visible status wins so a merged group is only hidden when EVERY member is
  // provided. none(3) > partial(2) > provided(1).
  function openingVisibility(status) { return status === 'provided' ? 1 : status === 'partial' ? 2 : 3; }

  return Object.freeze({
    contractVersion: 2,
    classifyClashes: classifyClashes,
    elementRole: elementRole,
    roleCriticality: roleCriticality,
    loadBearingOf: loadBearingOf,
    pairCriticality: pairCriticality,
    deterministicSeverity: deterministicSeverity,
    OPENING_STRIDE: OPENING_STRIDE,
    obbFromLocalBox: obbFromLocalBox,
    obbContains: obbContains,
    clipTrianglesToBox: clipTrianglesToBox,
    classifyOpening: classifyOpening,
    openingVisibility: openingVisibility
  });
}));
