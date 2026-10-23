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
// The engine has NO built-in numbers: thresholds come from the active country
// pack (regulations/*.json, engines.accessibility), or from values the user
// enters when no pack applies, or per call. A check without a threshold does
// not run (it is never measured against a guessed value).
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  // Threshold keys (metres, or a rise/run ratio for slope) and the check each
  // one drives:
  //   doorClearWidth   min clear opening width        -> door_clear_width
  //   corridorWidth    min circulation / escape width  -> route_width
  //   turningDiameter  free turning circle             -> turning_circle
  //   thresholdHeight  max height step at a door       -> threshold_height
  //   rampSlope        max rise/run                    -> ramp_slope
  var THRESHOLD_KEYS = ['doorClearWidth', 'corridorWidth', 'turningDiameter', 'thresholdHeight', 'rampSlope'];
  var CHECK_THRESHOLD = {
    door_clear_width: 'doorClearWidth', threshold_height: 'thresholdHeight', ramp_slope: 'rampSlope',
    route_width: 'corridorWidth', turning_circle: 'turningDiameter'
  };

  // Space-role words, matched against name + objectType. English generic
  // defaults; the active country pack's naming.spaceRoles replaces them.
  var ROLE_DEFAULTS = {
    corridor: /corridor|hallway|\bhall\b|circulat|route|escape|passage/i,
    sanitary: /toilet|\bwc\b|bath|shower|restroom|accessible|wheelchair/i
  };
  function _roleRe(role) {
    var pk = (typeof window._ccGetCountryPack === 'function') ? window._ccGetCountryPack() : null;
    var src = pk && pk.naming && pk.naming.spaceRoles && pk.naming.spaceRoles[role];
    var core = window._ccCountryPackCore;
    var re = (src && core) ? core.safeRegex(src, 'i') : null;
    return re || ROLE_DEFAULTS[role];
  }

  // Thresholds the user entered for when no country pack applies (per
  // browser; never overrides an active pack's values).
  var CUSTOM_KEY = 'cc_a11y_thresholds';
  function _num0(v) { var n = +v; return (v !== '' && v != null && isFinite(n) && n > 0) ? n : null; }
  function getCustomThresholds() {
    var out = {};
    try {
      var raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '{}') || {};
      THRESHOLD_KEYS.forEach(function (k) { var n = _num0(raw[k]); if (n != null) out[k] = n; });
    } catch (e) {}
    return out;
  }
  function setCustomThresholds(th) {
    var out = {};
    THRESHOLD_KEYS.forEach(function (k) { var n = _num0(th && th[k]); if (n != null) out[k] = n; });
    try {
      if (Object.keys(out).length) localStorage.setItem(CUSTOM_KEY, JSON.stringify(out));
      else localStorage.removeItem(CUSTOM_KEY);
    } catch (e) {}
    return out;
  }

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
  // groups only lists checks that have a threshold.
  function runAccessibilityChecks(elements, opts) {
    // Precedence: active country pack (regulations/*.json, follows the
    // model's location or the Settings pick) — or, when no pack carries
    // accessibility thresholds, the values the user entered — < explicit
    // per-call override. No built-in numbers.
    var regionPreset = (typeof window._ccGetRegulationPreset === 'function')
      ? window._ccGetRegulationPreset(null, 'accessibility') : null;
    var TH = Object.assign({}, regionPreset || getCustomThresholds(), (opts && opts.thresholds) || {});
    function has(k) { return typeof TH[k] === 'number' && isFinite(TH[k]); }
    var CORRIDOR_RE = _roleRe('corridor'), SANITARY_RE = _roleRe('sanitary');
    var items = [];
    (elements || []).forEach(function (el) {
      var p = el.props || {}; var t = p.ifcType || '';
      var res = [];
      if (t === 'IfcDoor' || t === 'IfcDoorStandardCase') {
        if (has('doorClearWidth')) res.push(checkDoorWidth(el, TH));
        if (has('thresholdHeight')) res.push(checkThreshold(el, TH));
      } else if (t === 'IfcRamp' || t === 'IfcRampFlight') {
        if (has('rampSlope')) res.push(checkRampSlope(el, TH));
      } else if (t === 'IfcSpace') {
        var nm = (p.name || '') + ' ' + (p.objectType || '');
        if (has('corridorWidth') && CORRIDOR_RE.test(nm)) res.push(checkCorridor(el, TH));
        if (has('turningDiameter') && SANITARY_RE.test(nm)) res.push(checkTurning(el, TH));
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
      if (!has(CHECK_THRESHOLD[k])) return;
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
  window._ccAccessibilityThresholdKeys = THRESHOLD_KEYS.slice();
  window._ccGetAccessibilityCustomThresholds = getCustomThresholds;
  window._ccSetAccessibilityCustomThresholds = setCustomThresholds;

  // Clearance helper that reuses the existing min-distance kernel (WASM, JS
  // fallback). Exposed for the panel's future "clearance to nearest obstacle"
  // refinement — the kernel fits element-to-element clearance, which most of
  // the v1 dimensional checks above are not, so they stay quantity/bbox-based.
  // NOTE: takes TRIANGLE arrays (9 floats/tri), not raw vertices — the
  // min-distance kernel is a true point-to-triangle + edge-edge mesh
  // distance now, not vertex-to-vertex (see index.html's _meshMinDist).
  window._ccAccessibilityClearance = function (trisA, trisB, maxDistM) {
    if (typeof window._ccWasmMinDist === 'function') {
      var out = new Float32Array(6);
      var d = window._ccWasmMinDist(trisA, trisB, maxDistM || 5, out);
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
      description: 'Deterministic building-code geometry checks (door clear width, thresholds, ramp slope, corridor width, turning circles) against the active country pack\'s thresholds or your own — behind the Accessibility panel.'
    });
  }
})();
