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
  // ctx (optional): { ruleSeverity(c) -> 'minor'|'major'|'critical'|null } —
  // a user rule's severity for the clash (index.html: the coordination-matrix
  // cell of its discipline pair). When it answers, it is the clash's severity
  // (still _sevSource 'rule': a re-run re-derives it from the current rules).
  /** @param {any[]} clashes @param {{ruleSeverity?: function(any): (string|null)}} [ctx] */
  function classifyClashes(clashes, ctx) {
    var ruleSev = ctx && typeof ctx.ruleSeverity === 'function' ? ctx.ruleSeverity : null;
    var FP_TYPES = ['IfcOpeningElement','IfcOpeningStandardCase','IfcSpace','IfcVirtualElement'];
    var STRUCTURAL_DISC = 'structural';
    var INSULATION_MAT = 'insulation';

    clashes.forEach(function(c) {
      // Extent is geometry, not a verdict: stamped on every hard clash (also
      // AI-triaged ones) so filters and buckets never depend on who judged.
      if (c.type === 'hard') c.extent = clashExtent(c); else if (c.extent != null) delete c.extent;
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
      // (The old "size ratio > 50 -> info / false positive" rule is gone: it
      // ran before the role model and labelled 99 % of a real structure +
      // HVAC federation as noise — a pipe through a slab IS a large size
      // ratio. Extent + review buckets below decide what needs review.)
      if (isFP) {
        sev = 'info'; cat = 'false_positive';
        reason = 'Opening/space element pair — likely intentional';
      } else if (c.type === 'duplicate') {
        sev = 'info'; cat = 'duplicate';
        reason = 'Duplicate element at same location';
      } else if (c.type === 'contact') {
        // Surfaces touch, nothing interpenetrates (flush faces, an element
        // resting on another): reported for completeness, not a clash.
        sev = 'info'; cat = 'contact';
        reason = 'Surfaces touch — no interpenetration';
      } else if (c.type === 'open-inside') {
        // Nested in a shape that is not closed: it has no defined inside, so
        // this is an indication to check, not a clash.
        sev = 'minor'; cat = 'open_inside';
        reason = 'Inside a shape that is not closed — check the model';
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

      if (cat !== 'false_positive' && cat !== 'duplicate' && cat !== 'contact' && cat !== 'open_inside') {
        var matA = fv.mat_cat_a || '';
        var matB = fv.mat_cat_b || '';
        if (matA === INSULATION_MAT || matB === INSULATION_MAT) {
          if (sev === 'critical') sev = 'major';
          cat = 'needs_review';
          reason += ' (insulation involved — may be intentional)';
        }
      }

      if (ruleSev) {
        var rs = ruleSev(c);
        if (rs === 'minor' || rs === 'major' || rs === 'critical') sev = rs;
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
    // key = '<typeA>:<typeB>|<storey>|<cx>,<cy>,<cz>'; the '<pair>|<storey>|'
    // prefix is built once per clash and reused for its 27 neighbour lookups.
    function _cPrefix(c){ return (c.elemAType||'') + ':' + (c.elemBType||'') + '|' + (c.elemAStorey||c.elemBStorey||'') + '|'; }
    var buckets = {};
    var prefixes = new Array(clashes.length);
    for (var bi = 0; bi < clashes.length; bi++) {
      var cb = clashes[bi], pb = cb.point || [0,0,0];
      var kb = (prefixes[bi] = _cPrefix(cb)) + Math.floor(pb[0]/CELL) + ',' + Math.floor(pb[1]/CELL) + ',' + Math.floor(pb[2]/CELL);
      (buckets[kb] || (buckets[kb] = [])).push(bi);
    }
    var groupId = 0;
    var assigned = {};
    for (var i = 0; i < clashes.length; i++) {
      if (assigned[i]) continue;
      var ci = clashes[i];
      var pi = ci.point || [0,0,0];
      var preI = prefixes[i];
      var cix = Math.floor(pi[0]/CELL), ciy = Math.floor(pi[1]/CELL), ciz = Math.floor(pi[2]/CELL);
      var cluster = [i];
      for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) for (var dz = -1; dz <= 1; dz++) {
        var bucket = buckets[preI + (cix+dx) + ',' + (ciy+dy) + ',' + (ciz+dz)];
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

  // ── Extent: how the two elements overlap ──────────────────────────
  // Read only from fields BOTH engines could produce: the element bounding-box
  // sizes (bboxA/bboxB, mm) and the penetration depth (distance < 0, mm — the
  // browser's separating-axis upper bound on the minimum translation
  // distance). Hard clashes only; null for every other type.
  //   'graze'        depth below min(25 mm, 10 % of the thinner element):
  //                  the surfaces barely overlap (a beam end 15 mm into a
  //                  column, a duct grazing a slab edge)
  //   'through'      depth >= the smaller cross-section (thinnest dimension)
  //                  of the passing element or of the host: one element runs
  //                  through the other (pipe through a slab, duct through a
  //                  wall, a pipe fully inside a column)
  //   'through-thin' a 'through' where that cross-section is <= 30 mm (hanger
  //                  rods, cables, plates, boards)
  //   'partial'      anything deeper than a graze that does not go through
  //   'unknown'      no usable depth/size data — and every local-engine clash:
  //                  its depth is an AABB-overlap bound, not a penetration
  // The passing element is the one with the smaller MIDDLE dimension (a duct
  // 400x600x5000 passes a wall 200x3000x5000); ties go to the smaller volume.
  var GRAZE_MAX_MM = 25, GRAZE_FRAC = 0.1, THIN_MM = 30;
  function _dimsSorted(bb) {
    if (!bb || typeof bb !== 'object') return null;
    var a = [Number(bb.dx), Number(bb.dy), Number(bb.dz)];
    for (var i = 0; i < 3; i++) if (!(a[i] >= 0) || !isFinite(a[i])) return null;
    return a.sort(function(x, y) { return x - y; });
  }
  function clashExtent(c) {
    if (!c || c.type !== 'hard') return null;
    if (c.source === 'local_engine' || c.depthSemantics === 'aabb') return 'unknown';
    var d = (typeof c.distance === 'number' && c.distance < 0) ? -c.distance : null;
    var a = _dimsSorted(c.bboxA), b = _dimsSorted(c.bboxB);
    if (d == null || !a || !b) return 'unknown';
    var thin = Math.min(a[0], b[0]);
    if (d < Math.min(GRAZE_MAX_MM, GRAZE_FRAC * thin)) return 'graze';
    var aPasses = a[1] < b[1] || (a[1] === b[1] && a[0] * a[1] * a[2] <= b[0] * b[1] * b[2]);
    var P = aPasses ? a : b, H = aPasses ? b : a;
    var cross = Math.min(P[0], H[0]);
    if (d >= cross) return cross <= THIN_MM ? 'through-thin' : 'through';
    return 'partial';
  }

  // ── Deterministic severity ──────────────────────────────────────────
  // Vocabulary matches aiSeverity exactly (critical / major / minor / info).
  // Inputs read from the clash object: type, distance (mm, negative =
  // penetration depth), clearanceMm (soft gap), requiredClearanceMm (the
  // clearance the rule asked for; default 50), roleA/roleB (stamped at
  // detection) with a fallback derived from elemAType/elemBType + disciplines
  // for legacy clashes, trades (per-side matrix key, 'mep.ventilation' …),
  // bboxA/bboxB (extent, above) and opening.
  //
  // HARD clash: the PAIR CLASS (what the two elements are) x the EXTENT (how
  // they overlap) — not an absolute depth. A column sitting 300 mm inside an
  // architectural wall is embedment / double modelling, not compromised
  // structure; a 100 mm duct cutting a beam is.
  //   pair class (severityClass)               through   through-thin  partial
  //   struct-mep  structure x MEP run              critical  major         major
  //   mep-mep     MEP run x MEP run, other trade   critical  major         major
  //   arch-mep    architecture x MEP run           major     major         minor
  //   struct-arch structure x architecture         major     major         minor
  //   other       anything x terminal / other …    major     major         minor
  //   same        same role, same model            minor     minor         minor
  // Critical needs a known extent: 'unknown' (no depth/size data, every
  // local-engine clash — its depth is an AABB bound) uses the 'partial' tier,
  // or the 'through' tier capped at major when the depth is >= 50 mm.
  // Then, in this order:
  //   depth < 10 mm                                  -> at most minor (info for finish x finish)
  //   one side a finish (covering, furniture)        -> -1 tier (not below minor)
  //   extent 'graze'                                 -> at most minor
  //   opening 'partial' (opening too small)          -> at least major
  // SOFT clash, gap g vs required clearance r (ratio = g / r):
  //   ratio <= 0.3 -> major (near miss), else minor;  finish x finish drops one tier
  // duplicate / contact (surfaces only touch) -> info;  visibility (sight-line) -> major.
  var TIERS = ['info', 'minor', 'major', 'critical'];
  var NEAR_MISS_RATIO = 0.3, DEFAULT_REQUIRED_MM = 50;
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
  // Two MEP trades that cannot both move ('mep.ventilation' x 'mep.plumbing').
  // An unresolved pipe ('mep.piping') is the same trade as every pipe trade,
  // a bare 'mep' (no sub-discipline) is unknown — neither counts as crossing
  // trades (same rule as clash-discipline-core.js disciplinePairEnabled).
  var TRADE_FAMILY = { ventilation: 'air', heating: 'pipe', plumbing: 'pipe', fire: 'pipe', piping: 'pipe', electrical: 'elec' };
  function crossTrade(c) {
    var t = c && c.trades;
    if (!t || t.length < 2) return false;
    var a = String(t[0] || ''), b = String(t[1] || '');
    if (a.indexOf('mep.') !== 0 || b.indexOf('mep.') !== 0) return false;
    var sa = a.slice(4), sb = b.slice(4);
    if (!sa || !sb || sa === sb) return false;
    if ((sa === 'piping' || sb === 'piping') && TRADE_FAMILY[sa] && TRADE_FAMILY[sa] === TRADE_FAMILY[sb]) return false;
    return true;
  }
  function _sameModel(c) {
    return !!c.selfClash || (c.modelAId != null && c.modelAId === c.modelBId);
  }
  // Pair class of a clash for severity (table above).
  function severityClass(c) {
    if (!c) return 'other';
    var a = _clashRole(c, 'A'), b = _clashRole(c, 'B');
    function has(r) { return a === r || b === r; }
    if (has('structural') && has('mep-main')) return 'struct-mep';
    if (a === 'mep-main' && b === 'mep-main' && crossTrade(c)) return 'mep-mep';
    if (a === b && _sameModel(c)) return 'same';
    if (has('architectural') && has('mep-main')) return 'arch-mep';
    if (has('structural') && has('architectural')) return 'struct-arch';
    return 'other';
  }
  var CLASS_TIERS = {
    'struct-mep':  { through: 'critical', thin: 'major', partial: 'major' },
    'mep-mep':     { through: 'critical', thin: 'major', partial: 'major' },
    'arch-mep':    { through: 'major', thin: 'major', partial: 'minor' },
    'struct-arch': { through: 'major', thin: 'major', partial: 'minor' },
    other:         { through: 'major', thin: 'major', partial: 'minor' },
    same:          { through: 'minor', thin: 'minor', partial: 'minor' }
  };
  // gap / required clearance of a soft clash (null when there is no gap data)
  function clearanceRatio(c) {
    if (!c) return null;
    var gap = typeof c.clearanceMm === 'number' ? c.clearanceMm : (typeof c.distance === 'number' ? Math.abs(c.distance) : null);
    if (gap == null || !isFinite(gap)) return null;
    var req = (typeof c.requiredClearanceMm === 'number' && c.requiredClearanceMm > 0) ? c.requiredClearanceMm : DEFAULT_REQUIRED_MM;
    return gap / req;
  }
  function isNearMiss(c) {
    if (!c || c.type !== 'soft') return false;
    var r = clearanceRatio(c);
    return r != null && r <= NEAR_MISS_RATIO;
  }
  function deterministicSeverity(c) {
    if (!c) return 'info';
    if (c.type === 'duplicate' || c.type === 'contact') return 'info';
    if (c.type === 'open-inside') return 'minor'; // an indication to check (no defined inside)
    if (c.type === 'visibility') return 'major';
    var crit = pairCriticality(c);
    if (c.type !== 'hard') {
      // No gap data at all -> no signal to escalate on.
      var soft = isNearMiss(c) ? 'major' : 'minor';
      return crit === 0 ? _shift(soft, -1) : soft;
    }
    var depth = (typeof c.distance === 'number' && c.distance < 0) ? -c.distance : 0;
    var roleA = _clashRole(c, 'A'), roleB = _clashRole(c, 'B');
    var tiers = CLASS_TIERS[severityClass(c)] || CLASS_TIERS.other;
    var ext = clashExtent(c);
    var sev;
    if (ext === 'through') sev = tiers.through;
    else if (ext === 'through-thin') sev = tiers.thin;
    else if (ext === 'unknown') sev = depth >= 50 && tiers.through !== 'minor' ? 'major' : tiers.partial;
    else sev = tiers.partial;                      // partial, graze (capped below)
    if (depth < 10) sev = crit === 0 ? 'info' : (TIERS.indexOf(sev) > 1 ? 'minor' : sev);
    else if (crit > 0 && (roleA === 'finish' || roleB === 'finish')) sev = sev === 'minor' ? 'minor' : _shift(sev, -1);
    else if (crit === 0) sev = _shift(sev, -1);
    if (ext === 'graze' && TIERS.indexOf(sev) > 1) sev = 'minor';
    if (c.opening === 'partial' && TIERS.indexOf(sev) < 2) sev = 'major';
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

  // ════════════════════════════════════════════════════════════════════
  // Default clash titles
  // ════════════════════════════════════════════════════════════════════
  // ONE implementation for every engine (browser, local engine, BCF export reads
  // the stored title). Inputs are only fields both engines produce identically:
  // element names/types/storeys, roles, opening status, clash type, selfClash.
  // Severity is deliberately NOT a title input: the depth behind it is a
  // browser-only estimate (the local engine has no _estimatePenetrationDepthM),
  // so a severity word would make the same pair title differently per engine.
  // The result is symmetric in A/B (a swapped pair titles identically).
  //   "Supply duct L0 through Corridor wall L0 — opening too small"
  //   "Sprinkler main crosses Beam B-12 (L1)"
  //   "Duct segment too close to Slab"           (no meaningful names, soft)
  // Pure per type string, called for every clash title / row: memoised (the
  // vocabulary of IFC types is small; the cache is capped all the same).
  /** @type {Object<string, string>} */
  var _typeLabelCache = Object.create(null);
  var _typeLabelCacheN = 0;
  function niceTypeLabel(t) {
    if (!t) return 'Element';
    var k = String(t);
    var hit = _typeLabelCache[k];
    if (hit !== undefined) return hit;
    var label = k.replace(/^Ifc/i, '').replace(/([a-z])([A-Z])/g, '$1 $2') || 'Element';
    if (_typeLabelCacheN >= 2000) { _typeLabelCache = Object.create(null); _typeLabelCacheN = 0; }
    _typeLabelCache[k] = label; _typeLabelCacheN++;
    return label;
  }
  // The pre-2026-09-29 default ("Wall × Pipe Segment"): kept as the secondary
  // line / tooltip, and to recognise an untouched legacy default title.
  function typePairTitle(tA, tB, sameModel) {
    var a = niceTypeLabel(tA), b = niceTypeLabel(tB);
    var core = a === b ? (a + ' vs ' + b) : (a + ' × ' + b);
    return sameModel ? (core + ' (self)') : core;
  }
  // Same list as addons/data-quality.js GENERIC_RE (asserted equal by a test).
  var GENERIC_NAME_RE = /^(basic\s+)?(wall|floor|ceiling|roof|column|beam|slab|door|window|generic model|furniture|curtain wall|curtain panel|railing|stair|ramp|mass|component|panel|mullion|structural framing|structural column)(\s+[\d\-]+)?$/i;
  var GUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}|[0-9A-Za-z_$]{22})$/i;
  // Returns the (truncated) name when it says something about THIS element,
  // '' when it is empty, a "#id" fallback, a GUID, a Revit "Family:Type:id"
  // string, a bare category word ("Basic Wall 3") or just the IFC type.
  function meaningfulName(name, ifcType) {
    var n = String(name == null ? '' : name).trim();
    if (!n) return '';
    if (/^#?\d+$/.test(n)) return '';
    if (!/\s/.test(n) && GUID_RE.test(n) && (n.length !== 22 || (/\d/.test(n) && /[A-Z]/.test(n) && /[a-z]/.test(n)))) return '';
    if (/:\d{4,}$/.test(n)) return '';
    if (GENERIC_NAME_RE.test(n)) return '';
    var bare = n.replace(/[\s_\-:.#]*\d+$/, '').replace(/\s+/g, ' ').toLowerCase();
    var label = niceTypeLabel(ifcType).toLowerCase();
    if (bare === label || bare === label.replace(/\s+/g, '') || bare === 'ifc' + label.replace(/\s+/g, '')) return '';
    return n.length > 40 ? n.slice(0, 39).replace(/\s+$/, '') + '…' : n;
  }
  // "Level 1" / "L1" / "01 - Level 1" -> "L1"; other storeys keep their own
  // (short) name; '' when unknown.
  function storeyShort(storey) {
    var s = String(storey == null ? '' : storey).trim();
    if (!s) return '';
    var m = s.match(/(?:\blevel|\blvl|\bfloor|\bstorey|\bstory|\bverdieping|\bniveau|\bl)\s*[_:]?\s*(-?\d+)\b/i);
    if (m) return 'L' + m[1];
    return s.length > 14 ? s.slice(0, 13) + '…' : s;
  }
  function _isMepRole(r) { return r === 'mep-main' || r === 'mep-terminal'; }
  function _titleSide(c, side) {
    var A = side === 'A';
    var type = A ? c.elemAType : c.elemBType;
    var role = _clashRole(c, side);
    var name = meaningfulName(A ? c.elemAName : c.elemBName, type);
    return {
      text: name || niceTypeLabel(type),
      role: role,
      mep: _isMepRole(role),
      storey: storeyShort(A ? c.elemAStorey : c.elemBStorey)
    };
  }
  function clashTitle(c) {
    if (!c) return 'Clash';
    var a = _titleSide(c, 'A'), b = _titleSide(c, 'B');
    var verb;
    var opening = (c.type === 'hard' || c.type === 'soft') ? c.opening : null;
    // Provision volumes (role 'provision', see clash-discipline-core.js) read
    // like openings; an IFC opening, when present, is the stronger statement.
    var provision = (c.type === 'hard' || c.type === 'soft') && !opening ? c.provision : null;
    // The MEP element is the passing one; otherwise order alphabetically so
    // the title does not depend on which engine called a given side "A".
    var first = a, second = b;
    if (a.mep !== b.mep) { if (b.mep) { first = b; second = a; } }
    else if (b.text.toLowerCase() < a.text.toLowerCase()) { first = b; second = a; }
    var directed = a.mep !== b.mep;
    if (c.type === 'open-inside' && (c.insideOpen === 'A' || c.insideOpen === 'B')) {
      // the nested element first: "Valve inside open Housing — check"
      first = c.insideOpen === 'A' ? a : b; second = c.insideOpen === 'A' ? b : a;
      verb = 'inside open';
    }
    else if (c.type === 'open-inside') verb = 'nested in open shape with';
    else if (c.type === 'duplicate') verb = 'duplicates';
    else if (c.type === 'contact') verb = 'touches';
    else if (opening === 'partial') verb = directed ? 'through' : 'in';
    else if (opening === 'provided') verb = directed ? 'through' : 'in';
    else if (provision === 'inside' || provision === 'partial') verb = directed ? 'through' : 'in';
    else if (c.type === 'soft') verb = 'too close to';
    else verb = directed ? 'crosses' : 'clashes with';
    var title = first.text + ' ' + verb + ' ' + second.text;
    if (c.type === 'open-inside') title += ' — check';
    else if (opening === 'partial') title += ' — opening too small';
    else if (opening === 'provided') title += ' — provided opening';
    else if (provision === 'inside') title += ' — inside provision';
    else if (provision === 'partial') title += ' — provision too small';
    else if (provision === 'obstructs') title += ' — blocks a provision';
    // Storey: only when it adds information — i.e. neither name already carries
    // a level ("Supply duct L0"). One label when both share it, "L0 / L1" when
    // the two elements sit on different storeys.
    var s1 = first.storey, s2 = second.storey, tag = '';
    var lower = (first.text + ' ' + second.text).toLowerCase();
    function known(s) { return !!s && lower.indexOf(s.toLowerCase()) !== -1; }
    if (!known(s1) && !known(s2)) tag = (s1 && s2 && s1 !== s2) ? (s1 + ' / ' + s2) : (s1 || s2);
    if (tag) title += ' (' + tag + ')';
    if (c.selfClash) title += ' (self)';
    return title;
  }
  // A title is "default" (safe to regenerate) when it is empty, equals the
  // stored auto title, or is the untouched legacy type-pair form. AI titles
  // (aiTitle) and user edits are therefore never overwritten.
  function isDefaultTitle(c) {
    if (!c) return true;
    if (c.aiTitle) return false;
    var t = c.title;
    if (!t) return true;
    if (c.titleAuto != null && t === c.titleAuto) return true;
    if (c.elemAType != null || c.elemBType != null) {
      if (t === typePairTitle(c.elemAType, c.elemBType, !!c.selfClash)) return true;
      if (t === typePairTitle(c.elemBType, c.elemAType, !!c.selfClash)) return true;
    }
    return false;
  }
  // Stamp the default title (+ titleAuto) unless the title is AI/user owned.
  function applyDefaultTitle(c) {
    if (!c || !isDefaultTitle(c)) return c;
    var t = clashTitle(c);
    c.title = t; c.titleAuto = t;
    return c;
  }

  // ════════════════════════════════════════════════════════════════════
  // Review buckets — "what needs a human" vs "counted, one click to show"
  // ════════════════════════════════════════════════════════════════════
  // Every raw clash lands in EXACTLY one bucket (first match wins), so the
  // bucket counts always add up to the raw total — nothing silently
  // disappears, it is only filed. Buckets other than 'review' are hidden by
  // default behind one bar of counts ("1243 inside provisions · 16 touch —
  // show"). Pure: reads only clash fields + rules (+ an optional context).
  //   handled    status resolved / closed / denied (a person already decided)
  //   contact    surfaces only touch (type 'contact')
  //   openshape  nested in a shape that is not closed (type 'open-inside'):
  //              no defined inside — an indication to check, not a clash
  //   provided   passes through an IFC opening made for it
  //   provision  MEP inside a provision / reservation volume (role group
  //              'provision' set to classify, the default)
  //   zone       an element of another suggestion group set to classify
  //              (zones, spaces, duplicates, proxies — rules.roleChoices)
  //   twice      the same conflict reported again against an exact copy of
  //              an element in another model (findTwice)
  //   embedded   by-design embedment: reinforcement, fasteners, accessories,
  //              building-element parts, voids/virtual elements, and doors /
  //              windows sitting in a wall, slab or roof of another model
  //   finish     finishes only (both sides covering / furniture) or movable
  //              furniture against anything
  //   graze      hard clash whose extent is 'graze' (barely overlaps)
  //   adjacent   clearance-only finding between architectural / structural /
  //              finish elements that sit next to each other by design
  //              (wall-slab, wall-beam). Near misses (gap <= 30 % of the
  //              required clearance) stay in review.
  //   review     everything else — the list a coordinator works through
  var REVIEW_BUCKETS = ['review', 'contact', 'openshape', 'provided', 'provision', 'zone', 'twice', 'embedded', 'finish', 'graze', 'adjacent', 'handled'];
  var DEFAULT_HIDDEN_BUCKETS = REVIEW_BUCKETS.filter(function(b) { return b !== 'review'; });
  var ROLE_CHOICE_DEFAULTS = { provision: 'classify', zone: 'classify', space: 'exclude', duplicate: 'include', proxy: 'include' };
  var EMBEDDED_TYPES = { IfcReinforcingBar:1, IfcReinforcingMesh:1, IfcReinforcingElement:1, IfcTendon:1, IfcTendonAnchor:1,
    IfcTendonConduit:1, IfcFastener:1, IfcMechanicalFastener:1, IfcDiscreteAccessory:1, IfcBuildingElementPart:1,
    IfcOpeningElement:1, IfcOpeningStandardCase:1, IfcVirtualElement:1 };
  var FILL_TYPES = { IfcDoor:1, IfcDoorStandardCase:1, IfcWindow:1, IfcWindowStandardCase:1 };
  var FILL_HOSTS = { IfcWall:1, IfcWallStandardCase:1, IfcWallElementedCase:1, IfcCurtainWall:1, IfcSlab:1,
    IfcSlabStandardCase:1, IfcSlabElementedCase:1, IfcRoof:1 };
  var FURNITURE_TYPES = { IfcFurnishingElement:1, IfcFurniture:1, IfcSystemFurnitureElement:1 };
  function _ifc(t) { t = String(t || ''); return (t && t.indexOf('Ifc') !== 0) ? 'Ifc' + t : t; }
  function _roleChoice(group, rules, ctx) {
    if (ctx && typeof ctx.roleChoice === 'function') return ctx.roleChoice(group, rules);
    var rc = (rules && rules.roleChoices) || {};
    if (rc[group]) return rc[group];
    if (group === 'space' && rules && rules.includeSpaces) return 'include';
    return ROLE_CHOICE_DEFAULTS[group] || 'include';
  }
  function isEmbedded(c) {
    var a = _ifc(c.elemAType), b = _ifc(c.elemBType);
    if (EMBEDDED_TYPES[a] || EMBEDDED_TYPES[b]) return true;
    return !!((FILL_TYPES[a] && FILL_HOSTS[b]) || (FILL_TYPES[b] && FILL_HOSTS[a]));
  }
  function isFinishOnly(c) {
    if (FURNITURE_TYPES[_ifc(c.elemAType)] || FURNITURE_TYPES[_ifc(c.elemBType)]) return true;
    return _clashRole(c, 'A') === 'finish' && _clashRole(c, 'B') === 'finish';
  }
  var ADJACENT_ROLES = { structural: 1, architectural: 1, finish: 1 };
  function isAdjacentByDesign(c) {
    if (!c || c.type !== 'soft') return false;
    if (!ADJACENT_ROLES[_clashRole(c, 'A')] || !ADJACENT_ROLES[_clashRole(c, 'B')]) return false;
    var r = clearanceRatio(c);
    return r != null && r > NEAR_MISS_RATIO;
  }
  // ctx (optional): { twice: {clashId: true} } from findTwice, roleChoice(g, rules)
  function reviewBucket(c, rules, ctx) {
    if (!c) return 'review';
    rules = rules || {};
    var st = c.status;
    if (st === 'resolved' || st === 'closed' || st === 'denied') return 'handled';
    if (c.type === 'contact') return 'contact';
    if (c.type === 'open-inside') return 'openshape';
    if (c.opening === 'provided') return 'provided';
    if (c.provision === 'inside' && _roleChoice('provision', rules, ctx) === 'classify') return 'provision';
    if (c.roleGroup && c.roleGroup !== 'provision' && _roleChoice(c.roleGroup, rules, ctx) === 'classify') return 'zone';
    if (c.type === 'duplicate') return 'review';
    if (ctx && ctx.twice && c.id != null && ctx.twice[c.id]) return 'twice';
    if (isEmbedded(c)) return 'embedded';
    if (isFinishOnly(c)) return 'finish';
    if (clashExtent(c) === 'graze') return 'graze';
    if (isAdjacentByDesign(c)) return 'adjacent';
    return 'review';
  }
  // Buckets hidden by the rules. rules.hideBuckets (array) wins; the legacy
  // switches still apply on top (hideContacts:false / hideProvidedOpenings:
  // false keep those buckets visible), so old projects behave as before.
  function hiddenBuckets(rules) {
    rules = rules || {};
    var h = Array.isArray(rules.hideBuckets) ? rules.hideBuckets.filter(function(b) { return REVIEW_BUCKETS.indexOf(b) > 0; }) : DEFAULT_HIDDEN_BUCKETS.slice();
    if (rules.hideContacts === false) h = h.filter(function(b) { return b !== 'contact'; });
    if (rules.hideProvidedOpenings === false) h = h.filter(function(b) { return b !== 'provided'; });
    return h;
  }
  // { review: n, contact: n, ... } over every bucket (zeros included); the
  // values always sum to clashes.length.
  function bucketCounts(clashes, rules, ctx) {
    var out = {};
    REVIEW_BUCKETS.forEach(function(b) { out[b] = 0; });
    (clashes || []).forEach(function(c) { out[reviewBucket(c, rules, ctx)]++; });
    return out;
  }

  // ── "Twice": one conflict reported against two copies of an element ──
  // A federation often carries the same physical element in two models (the
  // architect's copy of a structural column). A pipe crossing it is then
  // reported twice — once per copy. Copies are found from the clashes
  // themselves: a hard/duplicate clash between two elements of the same size
  // (each bbox axis within 2 mm) whose boxes overlap almost completely (AABB
  // overlap >= 90 % of the element volume). Every other clash of a copy is
  // keyed by (the other element, copy group, clash type); within a key the
  // clash on the copy with the smallest element key is kept, the rest are
  // 'twice'. The clash between the two copies stays in review (it IS the
  // finding: a duplicate). Deterministic: independent of the input order.
  function _elemKey(c, side) {
    var A = side === 'A';
    var g = A ? c.globalIdA : c.globalIdB;
    return g ? ('g:' + g) : ('m' + (A ? c.modelAId : c.modelBId) + ':' + (A ? c.elemA : c.elemB));
  }
  function _sameSize(c) {
    var a = _dimsSorted(c.bboxA), b = _dimsSorted(c.bboxB);
    if (!a || !b) return false;
    for (var i = 0; i < 3; i++) if (Math.abs(a[i] - b[i]) > 2) return false;
    var vol = a[0] * a[1] * a[2] * 1e-9;
    if (c.type === 'duplicate') return true;
    return vol > 0 && typeof c.overlapVolM3 === 'number' && c.overlapVolM3 >= 0.9 * vol;
  }
  function findTwice(clashes) {
    var parent = {};
    function find(k) { while (parent[k] && parent[k] !== k) { parent[k] = parent[parent[k]] || parent[k]; k = parent[k]; } return k; }
    function union(x, y) {
      var rx = find(x), ry = find(y);
      if (rx === ry) return;
      if (rx < ry) parent[ry] = rx; else parent[rx] = ry;
    }
    var list = clashes || [], i, c;
    for (i = 0; i < list.length; i++) {
      c = list[i];
      if (!c || (c.type !== 'hard' && c.type !== 'duplicate') || c.modelAId === c.modelBId) continue;
      if (!_sameSize(c)) continue;
      var ka = _elemKey(c, 'A'), kb = _elemKey(c, 'B');
      if (!parent[ka]) parent[ka] = ka;
      if (!parent[kb]) parent[kb] = kb;
      union(ka, kb);
    }
    var groups = {}, out = {};
    for (i = 0; i < list.length; i++) {
      c = list[i];
      if (!c || c.id == null) continue;
      var kA = _elemKey(c, 'A'), kB = _elemKey(c, 'B');
      var inA = !!parent[kA], inB = !!parent[kB];
      if (!inA && !inB) continue;
      if (inA && inB && find(kA) === find(kB)) continue;      // the copy-vs-copy clash itself
      // the copy side (when both sides are copies of different groups, A's)
      var copySide = inA ? 'A' : 'B';
      var copyKey = copySide === 'A' ? kA : kB, otherKey = copySide === 'A' ? kB : kA;
      var gk = otherKey + '|' + find(copyKey) + '|' + c.type;
      var cur = groups[gk];
      if (!cur) { groups[gk] = { keep: c, keepKey: copyKey, all: [c] }; continue; }
      cur.all.push(c);
      if (copyKey < cur.keepKey || (copyKey === cur.keepKey && String(c.id) < String(cur.keep.id))) { cur.keep = c; cur.keepKey = copyKey; }
    }
    Object.keys(groups).forEach(function(k) {
      var g = groups[k];
      g.all.forEach(function(x) { if (x !== g.keep) out[x.id] = true; });
    });
    return out;
  }

  return Object.freeze({
    contractVersion: 4,
    clashExtent: clashExtent,
    REVIEW_BUCKETS: REVIEW_BUCKETS,
    DEFAULT_HIDDEN_BUCKETS: DEFAULT_HIDDEN_BUCKETS,
    reviewBucket: reviewBucket,
    hiddenBuckets: hiddenBuckets,
    bucketCounts: bucketCounts,
    findTwice: findTwice,
    isEmbedded: isEmbedded,
    isFinishOnly: isFinishOnly,
    niceTypeLabel: niceTypeLabel,
    typePairTitle: typePairTitle,
    meaningfulName: meaningfulName,
    storeyShort: storeyShort,
    clashTitle: clashTitle,
    isDefaultTitle: isDefaultTitle,
    applyDefaultTitle: applyDefaultTitle,
    GENERIC_NAME_RE: GENERIC_NAME_RE,
    classifyClashes: classifyClashes,
    elementRole: elementRole,
    roleCriticality: roleCriticality,
    loadBearingOf: loadBearingOf,
    pairCriticality: pairCriticality,
    deterministicSeverity: deterministicSeverity,
    severityClass: severityClass,
    crossTrade: crossTrade,
    clearanceRatio: clearanceRatio,
    isNearMiss: isNearMiss,
    isAdjacentByDesign: isAdjacentByDesign,
    NEAR_MISS_RATIO: NEAR_MISS_RATIO,
    OPENING_STRIDE: OPENING_STRIDE,
    obbFromLocalBox: obbFromLocalBox,
    obbContains: obbContains,
    clipTrianglesToBox: clipTrianglesToBox,
    classifyOpening: classifyOpening,
    openingVisibility: openingVisibility
  });
}));
