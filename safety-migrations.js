(function(root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccSafetyMigrations = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';

  // Risky migrations are opt-in and independently reversible. Keep this list
  // deliberately closed: an unknown or malformed flag always resolves false.
  var MANIFEST = Object.freeze({
    concurrencyV2: Object.freeze({ fallback: 'legacy', defaultEnabled: false }),
    geoCacheV8: Object.freeze({ fallback: 'cold-parse', defaultEnabled: false }),
    batchedSectionsV2: Object.freeze({ fallback: 'legacy', defaultEnabled: false }),
    rendererV2: Object.freeze({ fallback: 'legacy', defaultEnabled: false })
  });
  var diagnostics = [];

  function _known(name) {
    return Object.prototype.hasOwnProperty.call(MANIFEST, name);
  }

  function _tokens(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'object') {
      return Object.keys(value).filter(function(k) { return value[k] === true; });
    }
    return String(value).split(',').map(function(v) { return v.trim(); }).filter(Boolean);
  }

  function readFlags(options) {
    options = options || {};
    var search = options.search;
    if (search == null && root.location) search = root.location.search;
    var storage = options.storage;
    if (storage === undefined) {
      try { storage = root.localStorage; } catch (_) { storage = null; }
    }
    var enabled = {};
    try {
      var params = new URLSearchParams(search || '');
      _tokens(params.get('ccSafety')).forEach(function(name) {
        if (_known(name)) enabled[name] = true;
      });
    } catch (_) {}
    try {
      var raw = storage && storage.getItem('cc_safety_flags');
      if (raw) {
        var parsed;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
        _tokens(parsed).forEach(function(name) {
          if (_known(name)) enabled[name] = true;
        });
      }
    } catch (_) {}
    return Object.freeze(enabled);
  }

  var flags = readFlags();

  function isEnabled(name) {
    return _known(name) && flags[name] === true;
  }

  function _round(value) {
    var n = Number(value);
    if (!isFinite(n)) return null;
    return Math.round(n * 1000000) / 1000000;
  }

  function _boxValues(box) {
    if (!box || !box.min || !box.max) return null;
    return [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].map(_round);
  }

  // This is intentionally semantic rather than a raw scene serialization:
  // UUIDs, insertion order, draw grouping and material object identities may
  // differ while the user-visible model is still exactly equivalent.
  function modelFingerprint(models) {
    var rows = [];
    (models || []).forEach(function(model) {
      (model.elements || []).forEach(function(el) {
        rows.push({
          key: String(model.id) + ':' + String(el.expressId),
          box: _boxValues(el.box),
          meshCount: (el.meshes || []).length,
          ifcType: String((el.props && el.props.ifcType) || '')
        });
      });
    });
    rows.sort(function(a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
    return rows;
  }

  function _endpoint(modelId, expressId) {
    return String(modelId == null ? '' : modelId) + ':' + String(expressId == null ? '' : expressId);
  }

  function clashFingerprint(clashes) {
    var rows = (clashes || []).map(function(c) {
      var a = _endpoint(c.modelAId, c.elemA);
      var b = _endpoint(c.modelBId, c.elemB);
      if (b < a) { var t = a; a = b; b = t; }
      return {
        key: a + '|' + b + '|' + String(c.type || ''),
        distance: _round(c.distance),
        point: Array.isArray(c.point) ? c.point.map(_round) : null
      };
    });
    rows.sort(function(a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
    return rows;
  }

  function compareFingerprints(expected, actual) {
    var a = expected || [], b = actual || [];
    var byA = {}, byB = {};
    a.forEach(function(row) { byA[row.key] = row; });
    b.forEach(function(row) { byB[row.key] = row; });
    var missing = [], extra = [], changed = [];
    Object.keys(byA).sort().forEach(function(key) {
      if (!Object.prototype.hasOwnProperty.call(byB, key)) missing.push(key);
      else if (JSON.stringify(byA[key]) !== JSON.stringify(byB[key])) changed.push(key);
    });
    Object.keys(byB).sort().forEach(function(key) {
      if (!Object.prototype.hasOwnProperty.call(byA, key)) extra.push(key);
    });
    return { equal: !missing.length && !extra.length && !changed.length,
      missing: missing, extra: extra, changed: changed };
  }

  function record(event) {
    var entry = Object.assign({ ts: Date.now() }, event || {});
    diagnostics.push(entry);
    if (diagnostics.length > 100) diagnostics.shift();
    try { root.dispatchEvent(new CustomEvent('cc-safety-diagnostic', { detail: entry })); } catch (_) {}
    return entry;
  }

  // Candidate failures and mismatches always fall back to the known path.
  // The wrapper is async because the highest-risk migrations (detection,
  // cache restore and shared sync) are asynchronous in production.
  async function guardedAsync(name, legacy, candidate, equivalence) {
    if (!isEnabled(name)) return legacy();
    try {
      var candidateResult = await candidate();
      if (equivalence) {
        var legacyResult = await legacy();
        var comparison = equivalence(legacyResult, candidateResult);
        if (!comparison || comparison.equal !== true) {
          record({ migration: name, outcome: 'mismatch', comparison: comparison || null });
          return legacyResult;
        }
      }
      record({ migration: name, outcome: 'candidate' });
      return candidateResult;
    } catch (error) {
      record({ migration: name, outcome: 'fallback', error: String(error && error.message || error) });
      return legacy();
    }
  }

  function diagnosticsSnapshot() {
    return diagnostics.slice();
  }

  function createRunCoordinator() {
    var sequence = 0;
    var active = null;
    return Object.freeze({
      begin: function(label) {
        if (active) return null;
        active = Object.freeze({ id: ++sequence, label: String(label || 'run') });
        return active;
      },
      isCurrent: function(token) {
        return !!(token && active && token.id === active.id);
      },
      finish: function(token) {
        if (!token || !active || token.id !== active.id) return false;
        active = null;
        return true;
      },
      cancel: function() {
        var cancelled = active;
        active = null;
        return cancelled;
      },
      snapshot: function() {
        return active;
      }
    });
  }

  function _setFlagsForTest(next) {
    flags = Object.freeze(Object.assign({}, next || {}));
  }

  return Object.freeze({
    manifest: MANIFEST,
    readFlags: readFlags,
    isEnabled: isEnabled,
    modelFingerprint: modelFingerprint,
    clashFingerprint: clashFingerprint,
    compareFingerprints: compareFingerprints,
    guardedAsync: guardedAsync,
    createRunCoordinator: createRunCoordinator,
    record: record,
    diagnostics: diagnosticsSnapshot,
    _setFlagsForTest: _setFlagsForTest
  });
}));
