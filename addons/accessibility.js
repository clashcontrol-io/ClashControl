// ── ClashControl Addon: Accessibility (Toegankelijkheid) Check Engine ──────
// Deterministic geometric building-code checks. No LLM anywhere in the path —
// every result is a measured value compared against a numeric threshold.
//
// Scope is intentionally narrow: the dimensional accessibility checks that
// IDS and the ILS / data-quality engines cannot express (clear widths, route
// widths, turning clearance, threshold height, ramp slope). This is NOT a
// general rule framework, and it does not touch geo / zoning / setbacks.
//
// The UI panel lives in index.html and calls window._ccRunAccessibilityChecks.
// Defaults are NL Bbl / NEN-oriented but overridable per run.
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  // Threshold defaults (metres, or ratio for slope). Overridable via opts.
  var DEFAULTS = {
    doorClearWidth:  0.85,   // m  — min clear opening width
    corridorWidth:   1.20,   // m  — min circulation / escape-route width
    turningDiameter: 1.50,   // m  — free turning circle (wheelchair)
    thresholdHeight: 0.02,   // m  — max height difference at a door threshold
    rampSlope:       1 / 12  // max rise/run (~8.3 %)
  };

  // Space-role matchers (EN + NL), matched against name + objectType.
  var CORRIDOR_RE = /corridor|gang|\bhal\b|circulat|route|vlucht|escape|passage/i;
  var SANITARY_RE = /toilet|\bwc\b|sanitair|bath|badkamer|douche|mindervalide|accessible|invalide|rolstoel/i;

  function _num(x) {
    if (x && x.value != null) x = x.value;
    var n = +x;
    return isFinite(n) ? n : null;
  }

  // Search flat quantities + every pset group for the first matching key.
  // Quantities (Qto_*) land in props.quantities; Pset_* props in props.psets.
  function _q(props, keys) {
    if (!props) return null;
    var i;
    var Q = props.quantities || {};
    for (i = 0; i < keys.length; i++) {
      if (Q[keys[i]] != null) { var v = _num(Q[keys[i]]); if (v != null) return v; }
    }
    var P = props.psets || {};
    for (var g in P) {
      if (!P.hasOwnProperty(g) || !P[g]) continue;
      for (i = 0; i < keys.length; i++) {
        if (P[g][keys[i]] != null) { var v2 = _num(P[g][keys[i]]); if (v2 != null) return v2; }
      }
    }
    return null;
  }

  // World-space AABB of an element's meshes → {size:{x,y,z}} in metres.
  function _bbox(el) {
    var THREE = window.THREE; if (!THREE) return null;
    var ms = (el && el.meshes) || []; if (!ms.length) return null;
    var box = new THREE.Box3(), tmp = new THREE.Box3(), any = false;
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i]; if (!m || !m.geometry) continue;
      m.updateWorldMatrix(true, false); tmp.setFromObject(m);
      if (!tmp.isEmpty()) { if (!any) { box.copy(tmp); any = true; } else box.union(tmp); }
    }
    if (!any) return null;
    var s = box.getSize(new THREE.Vector3());
    return { min: box.min.clone(), max: box.max.clone(), size: { x: s.x, y: s.y, z: s.z } };
  }

  function _mk(check, value, required, pass, unit, note, basis) {
    return { check: check, value: value, required: required, pass: !!pass, unit: unit || 'm', note: note || '', basis: basis || '' };
  }

  // ── Per-element checks → result object, or null when not applicable ──────

  // Clear door width. Prefer an IFC quantity; fall back to footprint geometry.
  // Honest caveat: a quantity is usually the nominal opening, not the leaf-
  // deducted clear width — flagged in `note` so it is never silently trusted.
  function checkDoorWidth(el, TH) {
    var req = TH.doorClearWidth;
    var w = _q(el.props, ['ClearWidth', 'Width', 'OverallWidth', 'NominalWidth']);
    var basis = 'quantity', note = 'IFC quantity — verify this is the leaf-deducted clear width, not nominal';
    if (w == null) {
      var bb = _bbox(el);
      // Larger horizontal dimension = the leaf/opening width. The smaller one
      // is the panel THICKNESS (~0.05-0.2 m) — using min failed every door
      // that lacked a width quantity.
      if (bb) { w = Math.max(bb.size.x, bb.size.z); basis = 'bbox'; note = 'measured from bounding geometry (nominal opening width, not deducted)'; }
    }
    if (w == null) return null;
    return _mk('door_clear_width', w, req, w >= req - 1e-4, 'm', note, basis);
  }

  // Threshold height difference at a door. Only evaluated when the model
  // actually carries the figure (a Threshold/Step quantity or property) —
  // we do NOT guess it from geometry, so absence is "n/a", never a false fail.
  function checkThreshold(el, TH) {
    var h = _q(el.props, ['ThresholdHeight', 'StepHeight', 'ThresholdOffset']);
    if (h == null) return null;
    h = Math.abs(h);
    return _mk('threshold_height', h, TH.thresholdHeight, h <= TH.thresholdHeight + 1e-4, 'm',
      'from IFC property', 'quantity');
  }

  // Ramp slope from bounding geometry: rise / run. Deterministic and robust
  // for a single flight; a multi-flight IfcRamp bbox slightly under-reports.
  function checkRampSlope(el, TH) {
    var bb = _bbox(el); if (!bb) return null;
    var rise = bb.size.y;
    var run = Math.max(bb.size.x, bb.size.z);
    if (run <= 1e-4 || rise <= 1e-4) return null;
    var slope = rise / run;
    var note = 'rise/run from bounding box' + (el.props.ifcType === 'IfcRamp' ? ' (multi-flight ramps under-report)' : '');
    return _mk('ramp_slope', slope, TH.rampSlope, slope <= TH.rampSlope + 1e-4, 'ratio', note, 'bbox');
  }

  // Corridor / escape-route width: minor horizontal footprint dimension of the
  // IfcSpace. Caveat: this is the bounding width, so it over-reports for L- or
  // T-shaped routes — a true narrowest-width needs a medial-axis pass (v2).
  function checkCorridor(el, TH) {
    var bb = _bbox(el); if (!bb) return null;
    var w = Math.min(bb.size.x, bb.size.z);
    return _mk('route_width', w, TH.corridorWidth, w >= TH.corridorWidth - 1e-4, 'm',
      'minor footprint dimension — over-reports for non-rectangular routes', 'bbox');
  }

  // Turning clearance: can a free circle of the required diameter fit. v1 uses
  // the footprint minor dimension as an upper bound; a true largest-inscribed-
  // circle (free of fixtures) is a distance-transform problem deferred to v2.
  function checkTurning(el, TH) {
    var bb = _bbox(el); if (!bb) return null;
    var d = Math.min(bb.size.x, bb.size.z);
    return _mk('turning_circle', d, TH.turningDiameter, d >= TH.turningDiameter - 1e-4, 'm',
      'footprint minor dimension (upper bound — does not subtract fixtures)', 'bbox');
  }

  var LABELS = {
    door_clear_width: { label: 'Door clear width', sev: 'error' },
    threshold_height: { label: 'Threshold height difference', sev: 'error' },
    ramp_slope:       { label: 'Ramp slope', sev: 'error' },
    route_width:      { label: 'Corridor / escape-route width', sev: 'warn' },
    turning_circle:   { label: 'Turning clearance', sev: 'warn' }
  };

  // ── Public engine ────────────────────────────────────────────────────────
  // Returns { items:[...per-element results], groups:{check:{label,sev,total,fail,ex}}, thresholds }
  function runAccessibilityChecks(elements, opts) {
    // Precedence: built-in NL Bbl/NEN defaults < active regional preset
    // (regulations/*.json, follows the model's location) < explicit per-call
    // override. A region with no registered 'accessibility' preset falls
    // through to DEFAULTS unchanged.
    var regionPreset = (typeof window._ccGetRegulationPreset === 'function')
      ? window._ccGetRegulationPreset(null, 'accessibility') : null;
    var TH = Object.assign({}, DEFAULTS, regionPreset || {}, (opts && opts.thresholds) || {});
    var items = [];
    (elements || []).forEach(function (el) {
      var p = el.props || {}; var t = p.ifcType || '';
      var res = [];
      if (t === 'IfcDoor' || t === 'IfcDoorStandardCase') {
        res.push(checkDoorWidth(el, TH)); res.push(checkThreshold(el, TH));
      } else if (t === 'IfcRamp' || t === 'IfcRampFlight') {
        res.push(checkRampSlope(el, TH));
      } else if (t === 'IfcSpace') {
        var nm = (p.name || '') + ' ' + (p.objectType || '');
        if (CORRIDOR_RE.test(nm)) res.push(checkCorridor(el, TH));
        if (SANITARY_RE.test(nm)) res.push(checkTurning(el, TH));
      }
      for (var i = 0; i < res.length; i++) {
        var r = res[i]; if (!r) continue;
        r.el = el; r.ifcType = t;
        r.name = p.name || ('#' + el.expressId);
        r.globalId = p.globalId || '';
        r.storey = p.storey || '';
        items.push(r);
      }
    });

    var groups = {};
    Object.keys(LABELS).forEach(function (k) {
      var sub = items.filter(function (it) { return it.check === k; });
      var fails = sub.filter(function (it) { return !it.pass; });
      groups[k] = {
        label: LABELS[k].label, sev: LABELS[k].sev,
        total: sub.length, fail: fails.length,
        ex: fails.slice(0, 6)
      };
    });

    return { items: items, groups: groups, thresholds: TH, evaluated: items.length };
  }

  window._ccRunAccessibilityChecks = runAccessibilityChecks;
  window._ccAccessibilityDefaults = DEFAULTS;

  // Clearance helper that reuses the existing min-distance kernel (WASM, JS
  // fallback). Exposed for the panel's future "clearance to nearest obstacle"
  // refinement — the kernel fits element-to-element clearance, which most of
  // the v1 dimensional checks above are not, so they stay quantity/bbox-based.
  window._ccAccessibilityClearance = function (vertsA, vertsB, maxDistM) {
    if (typeof window._ccWasmMinDist === 'function') {
      var out = new Float32Array(6);
      var d = window._ccWasmMinDist(vertsA, vertsB, maxDistM || 5, out);
      return { dist: d, pair: out };
    }
    return null; // core soft-clash path is the fallback when wired in the panel
  };

  // Follows the data-quality.js pattern: expose engine globals only. The panel
  // (AccessibilityPanel) and the failure→clash/BCF wiring live in index.html.
  console.log('[Accessibility] Engine ready');

  if (typeof window._ccRegisterAddon === 'function') {
    window._ccRegisterAddon({
      id: 'accessibility',
      alwaysOn: true,
      name: 'Accessibility checks',
      description: 'Deterministic building-code geometry checks (door clear width, thresholds, ramp slope, corridor width, turning circles) with NL Bbl/NEN defaults — behind the Accessibility panel.'
    });
  }
})();
