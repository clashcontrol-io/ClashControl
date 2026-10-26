// @ts-check
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccClashExceptionsCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // Intersection exceptions and "A requires B" presence checks — pure
  // post-classification on clashes the engine already produced. Nothing here
  // decides whether a clash exists, and nothing runs inside the kernel: the
  // caller (index.html _ccApplyClashExceptions) hands over clash objects plus
  // a context that reads the two elements' vertices, the host's IFC openings
  // and the provision-for-void volumes. Every engine path (JS / WASM /
  // cached Engine / worker pool / native / local engine) produces the same
  // clash list, so the annotations are identical on every path.
  //
  // Three rules, all OFF by default (rules.exceptions, see normalize()):
  //   penetration      a linear MEP member (duct / pipe / cable carrier /
  //                    cable segment, or an element whose role is an MEP run)
  //                    passes through a planar host (wall / slab / covering /
  //                    roof) with its long axis within angleDeg of the host
  //                    normal and sticking out at least minProtrusionMm beyond
  //                    BOTH host faces -> c.exception = 'penetration'
  //   fitting          an air terminal / light fixture / outlet-type element
  //                    set into a ceiling / wall / slab with one face flush
  //                    with a host face (within flushMm) and its body going
  //                    into the host -> c.exception = 'fitting'
  //   requireProvision every 'through' penetration of a STRUCTURAL wall / slab
  //                    by an MEP run requires an IfcOpeningElement of the
  //                    host or a provision-for-void volume within withinMm;
  //                    when there is none -> c.missingProvision (annotation on
  //                    the existing clash — never a second clash, so the
  //                    bucket counts still add up to the raw total)
  //
  // Geometry is read from the elements' own vertices (any frame, both sides
  // the same frame): principal axes (covariance, Jacobi) give a member's
  // long axis and a host's normal (least-variance axis = thinnest direction)
  // whatever the IFC placement says — a world-aligned local frame (baked
  // geometry) does not hide an oblique pipe. Without vertices nothing is
  // excepted (the clash stays where it was): an exception is never a guess.
  // IFC-neutral: IFC entity types and element roles only, no names.

  var LINEAR_TYPES = { IfcDuctSegment: 1, IfcPipeSegment: 1, IfcCableCarrierSegment: 1, IfcCableSegment: 1,
    IfcConduitSegment: 1, IfcFlowSegment: 1 };
  var WALL_TYPES = { IfcWall: 1, IfcWallStandardCase: 1, IfcWallElementedCase: 1 };
  var SLAB_TYPES = { IfcSlab: 1, IfcSlabStandardCase: 1, IfcSlabElementedCase: 1 };
  var PLANAR_EXTRA = { IfcCovering: 1, IfcRoof: 1 };
  var FITTING_TYPES = { IfcAirTerminal: 1, IfcLightFixture: 1, IfcLamp: 1, IfcOutlet: 1, IfcSwitchingDevice: 1,
    IfcFireSuppressionTerminal: 1, IfcSensor: 1, IfcAlarm: 1, IfcFlowTerminal: 1, IfcCommunicationsAppliance: 1,
    IfcAudioVisualAppliance: 1 };
  var DEFAULTS = {
    penetration: { on: false, minProtrusionMm: 20, angleDeg: 5 },
    fitting: { on: false, flushMm: 20 },
    requireProvision: { on: false, withinMm: 50 }
  };
  var PLANAR_RATIO = 0.5;   // host thickness <= half its middle extent
  var LINEAR_RATIO = 1.5;   // member length >= 1.5 x its larger cross-section

  function _ifc(t) { t = String(t || ''); return (t && t.indexOf('Ifc') !== 0) ? 'Ifc' + t : t; }
  function _type(c, side) { return _ifc(side === 'A' ? c.elemAType : c.elemBType); }
  function _role(c, side) { return side === 'A' ? c.roleA : c.roleB; }
  function _other(side) { return side === 'A' ? 'B' : 'A'; }
  function _num(v, d) { var n = Number(v); return isFinite(n) && n >= 0 ? n : d; }

  /** @param {any} ex */
  function normalize(ex) {
    ex = ex && typeof ex === 'object' ? ex : {};
    var p = ex.penetration || {}, f = ex.fitting || {}, r = ex.requireProvision || {};
    return {
      penetration: { on: p.on === true, minProtrusionMm: _num(p.minProtrusionMm, DEFAULTS.penetration.minProtrusionMm), angleDeg: Math.min(45, _num(p.angleDeg, DEFAULTS.penetration.angleDeg)) },
      fitting: { on: f.on === true, flushMm: _num(f.flushMm, DEFAULTS.fitting.flushMm) },
      requireProvision: { on: r.on === true, withinMm: _num(r.withinMm, DEFAULTS.requireProvision.withinMm) }
    };
  }
  /** @param {any} ex */
  function anyOn(ex) { var n = normalize(ex); return n.penetration.on || n.fitting.on || n.requireProvision.on; }

  function isLinearMep(c, side) { return !!LINEAR_TYPES[_type(c, side)] || _role(c, side) === 'mep-main'; }
  function isPlanarHostType(c, side) { var t = _type(c, side); return !!(WALL_TYPES[t] || SLAB_TYPES[t] || PLANAR_EXTRA[t]); }
  function isStructuralHost(c, side) { var t = _type(c, side); return !!(WALL_TYPES[t] || SLAB_TYPES[t]) && _role(c, side) === 'structural'; }
  function isFitting(c, side) { return !!FITTING_TYPES[_type(c, side)]; }

  // ── Principal axes ───────────────────────────────────────────────────
  // Symmetric 3x3 eigen-decomposition (cyclic Jacobi), deterministic.
  function _jacobi(m) {
    var a = [[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]];
    var v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (var sweep = 0; sweep < 32; sweep++) {
      var off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
      if (off < 1e-18) break;
      for (var p = 0; p < 2; p++) for (var q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        var th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        var t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        var cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
        for (var k = 0; k < 3; k++) {
          var akp = a[k][p], akq = a[k][q];
          a[k][p] = cs * akp - sn * akq; a[k][q] = sn * akp + cs * akq;
        }
        for (k = 0; k < 3; k++) {
          var apk = a[p][k], aqk = a[q][k];
          a[p][k] = cs * apk - sn * aqk; a[q][k] = sn * apk + cs * aqk;
        }
        for (k = 0; k < 3; k++) {
          var vkp = v[k][p], vkq = v[k][q];
          v[k][p] = cs * vkp - sn * vkq; v[k][q] = sn * vkp + cs * vkq;
        }
      }
    }
    var out = [0, 1, 2].map(function(i) {
      var vec = [v[0][i], v[1][i], v[2][i]];
      // sign: largest-magnitude component positive (stable across inputs)
      var mi = 0; for (var j = 1; j < 3; j++) if (Math.abs(vec[j]) > Math.abs(vec[mi])) mi = j;
      if (vec[mi] < 0) vec = [-vec[0], -vec[1], -vec[2]];
      return { val: a[i][i], vec: vec };
    });
    out.sort(function(x, y) { return y.val - x.val; });
    return out;
  }
  // Shape of a point set (flat xyz, any frame): centre, principal axes
  // (largest variance first) and the min / max projection on each axis.
  /** @param {ArrayLike<number>} pts */
  function shapeOf(pts) {
    if (!pts || pts.length < 9) return null;
    var n = Math.floor(pts.length / 3), i, x, y, z;
    var mx = 0, my = 0, mz = 0;
    for (i = 0; i < n; i++) { mx += pts[3 * i]; my += pts[3 * i + 1]; mz += pts[3 * i + 2]; }
    mx /= n; my /= n; mz /= n;
    var cxx = 0, cxy = 0, cxz = 0, cyy = 0, cyz = 0, czz = 0;
    for (i = 0; i < n; i++) {
      x = pts[3 * i] - mx; y = pts[3 * i + 1] - my; z = pts[3 * i + 2] - mz;
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
      cxx += x * x; cxy += x * y; cxz += x * z; cyy += y * y; cyz += y * z; czz += z * z;
    }
    var eig = _jacobi([cxx / n, cxy / n, cxz / n, cyy / n, cyz / n, czz / n]);
    var axes = eig.map(function(e) { return e.vec; });
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (i = 0; i < n; i++) {
      x = pts[3 * i]; y = pts[3 * i + 1]; z = pts[3 * i + 2];
      for (var k = 0; k < 3; k++) {
        var d = x * axes[k][0] + y * axes[k][1] + z * axes[k][2];
        if (d < lo[k]) lo[k] = d; if (d > hi[k]) hi[k] = d;
      }
    }
    return { center: [mx, my, mz], axes: axes, lo: lo, hi: hi };
  }
  /** @param {ArrayLike<number>} pts @param {number[]} n */
  function intervalAlong(pts, n) {
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i + 2 < pts.length; i += 3) {
      var d = pts[i] * n[0] + pts[i + 1] * n[1] + pts[i + 2] * n[2];
      if (d < lo) lo = d; if (d > hi) hi = d;
    }
    return [lo, hi];
  }
  function _dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function _ext(s, k) { return s.hi[k] - s.lo[k]; }
  function _pts(opts, side) { return opts && (side === 'A' ? opts.ptsA : opts.ptsB); }
  function _shape(opts, side) {
    var s = opts && (side === 'A' ? opts.shapeA : opts.shapeB);
    if (s) return s;
    var p = _pts(opts, side);
    return p ? shapeOf(p) : null;
  }
  function _planar(s) { return s && _ext(s, 2) <= PLANAR_RATIO * _ext(s, 1); }

  // ── penetration ──────────────────────────────────────────────────────
  // opts: { ptsA, ptsB (flat xyz, metres, one frame) | shapeA, shapeB,
  //         minProtrusionMm, angleDeg }
  // -> { ok, passer, host, angleDeg, protrusionMm:[lo, hi], reason }
  function passThroughOrthogonal(c, opts) {
    opts = opts || {};
    var minP = _num(opts.minProtrusionMm, DEFAULTS.penetration.minProtrusionMm);
    var maxAng = _num(opts.angleDeg, DEFAULTS.penetration.angleDeg);
    if (!c || c.type !== 'hard') return { ok: false, reason: 'not-hard' };
    // an opening / provision that is too small is a finding of its own
    if (c.opening === 'partial' || c.provision === 'partial') return { ok: false, reason: 'opening-too-small' };
    var passer = null;
    if (isLinearMep(c, 'A') && isPlanarHostType(c, 'B')) passer = 'A';
    else if (isLinearMep(c, 'B') && isPlanarHostType(c, 'A')) passer = 'B';
    if (!passer) return { ok: false, reason: 'roles' };
    var host = _other(passer);
    var sp = _shape(opts, passer), sh = _shape(opts, host), pp = _pts(opts, passer);
    if (!sp || !sh) return { ok: false, passer: passer, host: host, reason: 'no-geometry' };
    if (!_planar(sh)) return { ok: false, passer: passer, host: host, reason: 'host-not-planar' };
    if (_ext(sp, 0) < LINEAR_RATIO * _ext(sp, 1)) return { ok: false, passer: passer, host: host, reason: 'not-linear' };
    var n = sh.axes[2];
    var ang = Math.acos(Math.min(1, Math.abs(_dot(sp.axes[0], n)))) * 180 / Math.PI;
    var pI = pp ? intervalAlong(pp, n) : null;
    if (!pI) {
      // shapes only: the passer's projection on the host normal from its box
      var c0 = 0, r0 = 0;
      for (var k = 0; k < 3; k++) {
        var mid = (sp.lo[k] + sp.hi[k]) / 2, d = _dot(sp.axes[k], n);
        c0 += mid * d; r0 += Math.abs(d) * _ext(sp, k) / 2;
      }
      pI = [c0 - r0, c0 + r0];
    }
    var lo = (sh.lo[2] - pI[0]) * 1000, hi = (pI[1] - sh.hi[2]) * 1000;
    var res = { ok: false, passer: passer, host: host, angleDeg: Math.round(ang * 100) / 100,
      protrusionMm: [Math.round(lo * 10) / 10, Math.round(hi * 10) / 10], reason: '' };
    if (ang > maxAng) { res.reason = 'oblique'; return res; }
    if (Math.min(lo, hi) < minP) { res.reason = 'protrusion'; return res; }
    res.ok = true;
    return res;
  }

  // ── fitting ──────────────────────────────────────────────────────────
  // opts: { ptsA, ptsB | shapeA, shapeB, flushMm }
  // -> { ok, fitting, host, offsetMm, face:'lo'|'hi', reason }
  function flushFitting(c, opts) {
    opts = opts || {};
    var tol = _num(opts.flushMm, DEFAULTS.fitting.flushMm) / 1000;
    if (!c || c.type !== 'hard') return { ok: false, reason: 'not-hard' };
    var fit = null;
    if (isFitting(c, 'A') && isPlanarHostType(c, 'B')) fit = 'A';
    else if (isFitting(c, 'B') && isPlanarHostType(c, 'A')) fit = 'B';
    if (!fit) return { ok: false, reason: 'roles' };
    var host = _other(fit);
    var sh = _shape(opts, host), fp = _pts(opts, fit), sf = fp ? null : _shape(opts, fit);
    if (!sh || (!fp && !sf)) return { ok: false, fitting: fit, host: host, reason: 'no-geometry' };
    if (!_planar(sh)) return { ok: false, fitting: fit, host: host, reason: 'host-not-planar' };
    var iv = [], k;
    for (k = 0; k < 3; k++) {
      if (fp) iv.push(intervalAlong(fp, sh.axes[k]));
      else {
        var c0 = 0, r0 = 0;
        for (var j = 0; j < 3; j++) { var d = _dot(sf.axes[j], sh.axes[k]); c0 += (sf.lo[j] + sf.hi[j]) / 2 * d; r0 += Math.abs(d) * _ext(sf, j) / 2; }
        iv.push([c0 - r0, c0 + r0]);
      }
    }
    // set INTO the host: its centre lies within the host's extent in-plane
    for (k = 0; k < 2; k++) {
      var cm = (iv[k][0] + iv[k][1]) / 2;
      if (cm < sh.lo[k] || cm > sh.hi[k]) return { ok: false, fitting: fit, host: host, reason: 'outside-host' };
    }
    var fI = iv[2], hLo = sh.lo[2], hHi = sh.hi[2];
    var offLo = Math.abs(fI[0] - hLo), offHi = Math.abs(fI[1] - hHi);
    var flushLo = offLo <= tol && fI[1] > hLo + tol, flushHi = offHi <= tol && fI[0] < hHi - tol;
    if (!flushLo && !flushHi) return { ok: false, fitting: fit, host: host, offsetMm: Math.round(Math.min(offLo, offHi) * 10000) / 10, reason: 'not-flush' };
    var face = flushLo && (!flushHi || offLo <= offHi) ? 'lo' : 'hi';
    return { ok: true, fitting: fit, host: host, face: face, offsetMm: Math.round((face === 'lo' ? offLo : offHi) * 10000) / 10, reason: '' };
  }

  // ── presence: "a structural penetration requires an opening / provision" ──
  // Boxes: { c:[x,y,z], u:[[3],[3],[3]] (orthonormal), h:[3] (half extents) }.
  function boxFromAabb(min, max) {
    return { c: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      u: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], h: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2] };
  }
  // flat 15-number oriented box (clash-classification-core OPENING_STRIDE layout)
  function boxFromObb(o, at) {
    at = at || 0;
    return { c: [o[at], o[at + 1], o[at + 2]], u: [[o[at + 3], o[at + 4], o[at + 5]], [o[at + 6], o[at + 7], o[at + 8]], [o[at + 9], o[at + 10], o[at + 11]]],
      h: [o[at + 12], o[at + 13], o[at + 14]] };
  }
  function _cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  // Separating-axis test with a margin: true when no axis separates the two
  // boxes by more than `margin` (metres) — "within margin of each other"
  // (conservative on the 9 edge-edge axes).
  function boxesWithin(A, B, margin) {
    var T = [B.c[0] - A.c[0], B.c[1] - A.c[1], B.c[2] - A.c[2]];
    var axes = A.u.concat(B.u);
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) {
      var x = _cross(A.u[i], B.u[j]), l = Math.sqrt(_dot(x, x));
      if (l > 1e-9) axes.push([x[0] / l, x[1] / l, x[2] / l]);
    }
    for (var a = 0; a < axes.length; a++) {
      var L = axes[a], rA = 0, rB = 0;
      for (var k = 0; k < 3; k++) { rA += A.h[k] * Math.abs(_dot(A.u[k], L)); rB += B.h[k] * Math.abs(_dot(B.u[k], L)); }
      if (Math.abs(_dot(T, L)) > rA + rB + margin) return false;
    }
    return true;
  }
  // ctx: { extent(c) -> 'through' | ..., points(c, side) -> flat xyz | null,
  //        region(c) -> {min:[3], max:[3]} (the two elements' box overlap,
  //        same frame as the openings), openings(c, side) -> flat 15-number
  //        boxes of that element's IfcOpeningElements, provisions(c) ->
  //        [flat 15-number box] of provision-for-void volumes nearby }
  // -> [{ type:'missing-provision', clashId, host, passer, hostType,
  //       passerType, hostName, passerName, withinMm }]
  function _isThrough(c, ctx, passer, host) {
    var ext = ctx && typeof ctx.extent === 'function' ? ctx.extent(c) : null;
    if (ext === 'through' || ext === 'through-thin') return true;
    if (!ctx || typeof ctx.points !== 'function') return false;
    var pp = ctx.points(c, passer), ph = ctx.points(c, host);
    var sh = ph ? shapeOf(ph) : null;
    if (!pp || !sh) return false;
    var pI = intervalAlong(pp, sh.axes[2]);
    return pI[0] <= sh.lo[2] && pI[1] >= sh.hi[2];
  }
  function _provisionPresent(c, ctx, host, withinM) {
    if (c.opening === 'provided' || c.opening === 'partial') return true;
    if (c.provision === 'inside' || c.provision === 'partial') return true;
    var reg = ctx && typeof ctx.region === 'function' ? ctx.region(c) : null;
    var R = reg ? boxFromAabb(reg.min, reg.max) : (Array.isArray(c.point) ? boxFromAabb(c.point, c.point) : null);
    if (!R) return false;
    var ops = ctx && typeof ctx.openings === 'function' ? ctx.openings(c, host) : null;
    if (ops) for (var i = 0; i + 15 <= ops.length; i += 15) if (boxesWithin(R, boxFromObb(ops, i), withinM)) return true;
    var pv = ctx && typeof ctx.provisions === 'function' ? ctx.provisions(c) : null;
    if (pv) for (var j = 0; j < pv.length; j++) if (pv[j] && boxesWithin(R, boxFromObb(pv[j], 0), withinM)) return true;
    return false;
  }
  function presenceFindings(clashes, ctx, req) {
    var r = normalize({ requireProvision: req }).requireProvision, out = [];
    if (!r.on) return out;
    var withinM = r.withinMm / 1000;
    (clashes || []).forEach(function(c) {
      if (!c || c.type !== 'hard') return;
      var host = isStructuralHost(c, 'A') && isLinearMep(c, 'B') ? 'A' : isStructuralHost(c, 'B') && isLinearMep(c, 'A') ? 'B' : null;
      if (!host) return;
      var passer = _other(host);
      if (!_isThrough(c, ctx, passer, host)) return;
      if (_provisionPresent(c, ctx, host, withinM)) return;
      out.push({ type: 'missing-provision', clashId: c.id, host: host, passer: passer,
        hostType: _type(c, host), passerType: _type(c, passer),
        hostName: host === 'A' ? c.elemAName : c.elemBName, passerName: passer === 'A' ? c.elemAName : c.elemBName,
        withinMm: r.withinMm });
    });
    return out;
  }

  // ── annotate: one pass for the run (index.html calls this) ────────────
  // Returns { clashes, findings, counts } — `clashes` is a NEW array; a clash
  // whose annotation changes is copied (clash objects are immutable state,
  // and smart re-run snapshots may share them), all others are the same
  // objects. With every rule off the input array's objects come back as they
  // are, and only stale annotations from an earlier run are removed.
  //   c.exception        'penetration' | 'fitting'   (that rule on)
  //   c.missingProvision { host:'A'|'B', withinMm }   (requireProvision on)
  function annotate(clashes, ctx, exceptions) {
    var ex = normalize(exceptions);
    var findings = presenceFindings(clashes, ctx, ex.requireProvision);
    var byId = {};
    findings.forEach(function(f) { byId[f.clashId] = f; });
    var counts = { penetration: 0, fitting: 0, missingProvision: findings.length };
    var shapeMemo = typeof Map === 'function' ? new Map() : null;
    function opts(c, extra) {
      var o = { ptsA: null, ptsB: null };
      if (ctx && typeof ctx.points === 'function') { o.ptsA = ctx.points(c, 'A'); o.ptsB = ctx.points(c, 'B'); }
      if (shapeMemo) {
        if (o.ptsA) { if (!shapeMemo.has(o.ptsA)) shapeMemo.set(o.ptsA, shapeOf(o.ptsA)); o.shapeA = shapeMemo.get(o.ptsA); }
        if (o.ptsB) { if (!shapeMemo.has(o.ptsB)) shapeMemo.set(o.ptsB, shapeOf(o.ptsB)); o.shapeB = shapeMemo.get(o.ptsB); }
      }
      return Object.assign(o, extra);
    }
    var out = (clashes || []).map(function(c) {
      if (!c) return c;
      var exc = null;
      if (ex.penetration.on && c.type === 'hard' && passThroughOrthogonal(c, opts(c, { minProtrusionMm: ex.penetration.minProtrusionMm, angleDeg: ex.penetration.angleDeg })).ok) exc = 'penetration';
      else if (ex.fitting.on && c.type === 'hard' && flushFitting(c, opts(c, { flushMm: ex.fitting.flushMm })).ok) exc = 'fitting';
      var f = c.id != null ? byId[c.id] : null;
      if (exc) counts[exc]++;
      var hasEx = c.exception != null, hasMp = c.missingProvision != null;
      if (!exc && !f && !hasEx && !hasMp) return c;
      if (exc === c.exception && f && hasMp && c.missingProvision.host === f.host && c.missingProvision.withinMm === f.withinMm) return c;
      if (exc === c.exception && !f && !hasMp) return c;
      var n = { ...c };
      if (exc) n.exception = exc; else if (hasEx) delete n.exception;
      if (f) n.missingProvision = { host: f.host, withinMm: f.withinMm }; else if (hasMp) delete n.missingProvision;
      return n;
    });
    return { clashes: out, findings: findings, counts: counts };
  }

  return Object.freeze({
    contractVersion: 1,
    DEFAULTS: DEFAULTS,
    normalize: normalize,
    anyOn: anyOn,
    isLinearMep: isLinearMep,
    isPlanarHostType: isPlanarHostType,
    isStructuralHost: isStructuralHost,
    isFitting: isFitting,
    shapeOf: shapeOf,
    intervalAlong: intervalAlong,
    passThroughOrthogonal: passThroughOrthogonal,
    flushFitting: flushFitting,
    boxFromAabb: boxFromAabb,
    boxFromObb: boxFromObb,
    boxesWithin: boxesWithin,
    presenceFindings: presenceFindings,
    annotate: annotate
  });
}));
