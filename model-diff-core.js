// @ts-check
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccModelDiffCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // Model version comparison (docs/INTERNALS.md §21.63). A reloaded model
  // (same name, REPLACE_MODEL) is compared with the version it replaces:
  // elements are matched by GlobalId and each matched element is unchanged,
  // property-changed, geometry-changed (moved or reshaped) or both; the rest
  // are added / removed. Pure — index.html hands in plain entries and mesh
  // parts; node:test drives it directly (tests/model-version-diff.test.js).
  //
  // Geometry signature: WORLD-space vertex positions (the mesh's local
  // positions through its world matrix, op for op like three.js
  // Vector3.applyMatrix4, rounded to Float32, then quantised to 0.1 mm) plus
  // the index arrays, hashed with the same two 32-bit FNV / DJB2 streams as
  // the smart re-run's element hash (_hashElement). World space, not
  // local arrays + matrices: a model restored from the geometry cache has
  // byte-identical world positions and indices to a fresh load
  // (tests/browser/cache-restore-exact.mjs) even where it keeps a shape in a
  // different local frame, so a restore never reads as a change.

  var Q = 10000; // 0.1 mm
  /** @param {number} v */
  function quant(v) { return Math.round(Math.fround(v) * Q) | 0; }

  // World xyz of vertex i of a part. part: {pos: ArrayLike (x,y,z,...),
  // index?: ArrayLike|null, matrix?: ArrayLike (16, column-major)|null}
  /** @param {any} part @param {number} i @param {number[]} out */
  function worldVertex(part, i, out) {
    var p = part.pos, x = +p[i * 3], y = +p[i * 3 + 1], z = +p[i * 3 + 2], e = part.matrix;
    if (!e) { out[0] = Math.fround(x); out[1] = Math.fround(y); out[2] = Math.fround(z); return out; }
    var w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
    out[0] = Math.fround((e[0] * x + e[4] * y + e[8] * z + e[12]) * w);
    out[1] = Math.fround((e[1] * x + e[5] * y + e[9] * z + e[13]) * w);
    out[2] = Math.fround((e[2] * x + e[6] * y + e[10] * z + e[14]) * w);
    return out;
  }
  /** @param {any} part */
  function vertexCount(part) { return part && part.pos ? Math.floor(part.pos.length / 3) : 0; }

  // Signature of an element's geometry: '' for an element without geometry.
  /** @param {any[]} parts */
  function geometrySignature(parts) {
    var list = parts || [];
    if (!list.length) return '';
    var h1 = 2166136261, h2 = 5381, v, i, k;
    var w = [0, 0, 0];
    v = list.length; h1 = Math.imul(h1 ^ v, 16777619); h2 = (Math.imul(h2, 33) + v) | 0;
    for (var pi = 0; pi < list.length; pi++) {
      var part = list[pi], n = vertexCount(part), idx = part.index, ni = idx ? idx.length : 0;
      h1 = Math.imul(h1 ^ n, 16777619); h2 = (Math.imul(h2, 33) + n) | 0;
      h1 = Math.imul(h1 ^ ni, 16777619); h2 = (Math.imul(h2, 33) + ni) | 0;
      for (i = 0; i < n; i++) {
        worldVertex(part, i, w);
        for (k = 0; k < 3; k++) { v = quant(w[k]); h1 = Math.imul(h1 ^ v, 16777619); h2 = (Math.imul(h2, 33) + v) | 0; }
      }
      for (i = 0; i < ni; i++) { v = idx[i] | 0; h1 = Math.imul(h1 ^ v, 16777619); h2 = (Math.imul(h2, 33) + v) | 0; }
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
  }

  // Two versions of an element whose signatures differ:
  //   'same'     — same parts / counts / indices and every world vertex within
  //                0.05 mm (+ Float32 spacing): the signatures only differ by
  //                rounding (e.g. a shape newly shared by another element is
  //                drawn instanced in the new version — local frame + matrix
  //                instead of world positions — and a coordinate fell on the
  //                other side of a 0.1 mm step);
  //   'moved'    — a rigid motion (translation and / or rotation): same
  //                topology, every triangle edge and every vertex's distance
  //                to the element's first vertex kept within tol (0.5 mm +
  //                Float32 spacing, so a far-georeferenced model does not read
  //                rounding as reshaping);
  //   'reshaped' — anything else.
  /** @param {any[]} a @param {any[]} b @param {number=} tol */
  function compareGeometry(a, b, tol) {
    var w = _worlds(a, b);
    if (!w) return 'reshaped';
    var tolSame = 5e-5 + 2.5e-7 * w.maxAbs, same = true;
    for (var pi = 0; pi < w.a.length && same; pi++) {
      var A = w.a[pi], B = w.b[pi];
      for (var i = 0; i < A.length; i++) if (Math.abs(A[i] - B[i]) > tolSame) { same = false; break; }
    }
    if (same) return 'same';
    return _rigid(a, w, tol) ? 'moved' : 'reshaped';
  }
  /** @param {any[]} a @param {any[]} b @param {number=} tol */
  function rigidMotion(a, b, tol) {
    var w = _worlds(a, b);
    return !!w && _rigid(a, w, tol);
  }
  // World positions of both versions (Float64 copies) when their topology
  // matches (parts, vertex counts, index arrays), else null.
  /** @param {any[]} a @param {any[]} b */
  function _worlds(a, b) {
    a = a || []; b = b || [];
    if (!a.length || a.length !== b.length) return null;
    var i, k, pi;
    for (pi = 0; pi < a.length; pi++) {
      var na = vertexCount(a[pi]);
      if (na !== vertexCount(b[pi]) || !na) return null;
      var ia = a[pi].index, ib = b[pi].index;
      if (!!ia !== !!ib) return null;
      if (ia) {
        if (ia.length !== ib.length) return null;
        for (i = 0; i < ia.length; i++) if ((ia[i] | 0) !== (ib[i] | 0)) return null;
      }
    }
    // world positions + the largest coordinate magnitude
    var wa = [], wb = [], maxAbs = 0, t = [0, 0, 0];
    for (pi = 0; pi < a.length; pi++) {
      var n = vertexCount(a[pi]), fa = new Float64Array(n * 3), fb = new Float64Array(n * 3);
      for (i = 0; i < n; i++) {
        worldVertex(a[pi], i, t); for (k = 0; k < 3; k++) { fa[i * 3 + k] = t[k]; if (Math.abs(t[k]) > maxAbs) maxAbs = Math.abs(t[k]); }
        worldVertex(b[pi], i, t); for (k = 0; k < 3; k++) { fb[i * 3 + k] = t[k]; if (Math.abs(t[k]) > maxAbs) maxAbs = Math.abs(t[k]); }
      }
      wa.push(fa); wb.push(fb);
    }
    return { a: wa, b: wb, maxAbs: maxAbs };
  }
  /** @param {any[]} a @param {{a: Float64Array[], b: Float64Array[], maxAbs: number}} w @param {number=} tol */
  function _rigid(a, w, tol) {
    var wa = w.a, wb = w.b, pi, i;
    var eps = (tol == null ? 5e-4 : tol) + 8e-7 * w.maxAbs;
    /** @param {Float64Array} f @param {number} i @param {Float64Array} g @param {number} j */
    function dist(f, i, g, j) {
      var dx = f[i * 3] - g[j * 3], dy = f[i * 3 + 1] - g[j * 3 + 1], dz = f[i * 3 + 2] - g[j * 3 + 2];
      return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    var a0 = wa[0], b0 = wb[0];
    for (pi = 0; pi < a.length; pi++) {
      var A = wa[pi], B = wb[pi], cnt = A.length / 3;
      for (i = 0; i < cnt; i++) if (Math.abs(dist(A, i, a0, 0) - dist(B, i, b0, 0)) > eps) return false;
      var idx = a[pi].index, nt = idx ? Math.floor(idx.length / 3) : Math.floor(cnt / 3);
      for (var tri = 0; tri < nt; tri++) {
        var v0 = idx ? idx[tri * 3] : tri * 3, v1 = idx ? idx[tri * 3 + 1] : tri * 3 + 1, v2 = idx ? idx[tri * 3 + 2] : tri * 3 + 2;
        if (Math.abs(dist(A, v0, A, v1) - dist(B, v0, B, v1)) > eps) return false;
        if (Math.abs(dist(A, v1, A, v2) - dist(B, v1, B, v2)) > eps) return false;
        if (Math.abs(dist(A, v2, A, v0) - dist(B, v2, B, v0)) > eps) return false;
      }
    }
    return true;
  }

  // ── Properties ──────────────────────────────────────────────────────
  // Compared: the IFC attributes below and every property-set value
  // ("Pset_WallCommon.FireRating"). Not compared: ids (GlobalId, express /
  // type / host ids, which renumber between exports), quantities and
  // opening boxes (they follow the geometry, which the geometry signature
  // already covers).
  var ATTRS = ['name', 'description', 'objectType', 'ifcType', 'predefinedType', 'tag', 'storey', 'material', 'phase', 'workset', 'designOption'];
  /** @param {any} v */
  function _str(v) {
    if (v == null) return '';
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
    return String(v);
  }
  // { key: value-string } of everything compared; psets only when asked.
  /** @param {any} p @param {boolean=} withPsets */
  function flatProps(p, withPsets) {
    /** @type {Record<string, string>} */
    var out = {};
    p = p || {};
    ATTRS.forEach(function(k) { var s = _str(p[k]); if (s !== '') out[k] = s; });
    if (withPsets && p.psets && typeof p.psets === 'object') {
      Object.keys(p.psets).forEach(function(set) {
        var ps = p.psets[set];
        if (!ps || typeof ps !== 'object') return;
        Object.keys(ps).forEach(function(k) { var s = _str(ps[k]); if (s !== '') out[set + '.' + k] = s; });
      });
    }
    return out;
  }
  // [{k, o, n}] sorted by key ('' = absent on that side).
  /** @param {any} oldP @param {any} newP @param {boolean=} withPsets */
  function propertyChanges(oldP, newP, withPsets) {
    var a = flatProps(oldP, withPsets), b = flatProps(newP, withPsets), keys = {};
    Object.keys(a).forEach(function(k) { keys[k] = 1; });
    Object.keys(b).forEach(function(k) { keys[k] = 1; });
    var out = [];
    Object.keys(keys).sort().forEach(function(k) {
      var o = k in a ? a[k] : '', n = k in b ? b[k] : '';
      if (o !== n) out.push({ k: k, o: o, n: n });
    });
    return out;
  }
  // Does a side carry property sets at all (lazily merged psets may not have
  // landed yet)? Psets are compared only when both sides have them.
  /** @param {any[]} entries */
  function hasPsets(entries) {
    for (var i = 0; i < (entries || []).length; i++) {
      var p = entries[i] && entries[i].props, ps = p && p.psets;
      if (ps && typeof ps === 'object') for (var k in ps) if (Object.prototype.hasOwnProperty.call(ps, k)) return true;
    }
    return false;
  }

  // ── Diff ────────────────────────────────────────────────────────────
  // entries: [{gid, eid, props, geo}] (geo = geometrySignature). Elements
  // without a GlobalId are not compared (as before). For an element whose
  // signature changed, opts.geometry(oldEntry, newEntry) -> 'same' | 'moved'
  // | 'reshaped' (compareGeometry on its parts); without it opts.rigid(o, n)
  // -> true for "moved", else "reshaped".
  var KIND_ORDER = ['added', 'removed', 'moved', 'reshaped', 'moved+properties', 'reshaped+properties', 'properties'];
  /** @param {any[]} oldEntries @param {any[]} newEntries @param {any=} opts */
  function diffModels(oldEntries, newEntries, opts) {
    opts = opts || {};
    /** @type {Record<string, any>} */ var oldBy = {};
    /** @type {Record<string, any>} */ var newBy = {};
    (oldEntries || []).forEach(function(e) { if (e && e.gid) oldBy[e.gid] = e; });
    (newEntries || []).forEach(function(e) { if (e && e.gid) newBy[e.gid] = e; });
    var withPsets = opts.psets != null ? !!opts.psets : (hasPsets(oldEntries) && hasPsets(newEntries));
    var added = [], removed = [], modified = [], unchanged = [], moved = [], reshaped = [], propChanged = [], records = [];
    function rec(e, kind, geo, props) {
      var p = e.props || {};
      return { gid: e.gid, eid: e.eid, type: p.ifcType || '', name: p.name || '', kind: kind, geo: geo, props: props };
    }
    Object.keys(newBy).sort().forEach(function(gid) {
      var n = newBy[gid], o = oldBy[gid];
      if (!o) { added.push(n.eid); records.push(rec(n, 'added', null, [])); return; }
      var geo = null;
      if ((o.geo || '') !== (n.geo || '')) geo = opts.geometry ? opts.geometry(o, n) : ((opts.rigid && opts.rigid(o, n)) ? 'moved' : 'reshaped');
      var pc = propertyChanges(o.props, n.props, withPsets);
      if (geo === 'same') geo = null;
      if (!geo && !pc.length) { unchanged.push(n.eid); return; }
      modified.push(n.eid);
      if (geo === 'moved') moved.push(n.eid);
      if (geo === 'reshaped') reshaped.push(n.eid);
      if (pc.length) propChanged.push(n.eid);
      records.push(rec(n, geo ? (pc.length ? geo + '+properties' : geo) : 'properties', geo, pc));
    });
    Object.keys(oldBy).sort().forEach(function(gid) {
      if (newBy[gid]) return;
      removed.push(oldBy[gid].eid); records.push(rec(oldBy[gid], 'removed', null, []));
    });
    records.sort(function(a, b) { return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.gid < b.gid ? -1 : a.gid > b.gid ? 1 : 0); });
    var both = records.filter(function(r) { return r.geo && r.props.length; }).length;
    return {
      v: 2,
      added: added, removed: removed, modified: modified, unchanged: unchanged,
      moved: moved, reshaped: reshaped, propChanged: propChanged, records: records,
      summary: {
        added: added.length, removed: removed.length, modified: modified.length, unchanged: unchanged.length,
        moved: moved.length, reshaped: reshaped.length, geometry: moved.length + reshaped.length,
        properties: propChanged.length, both: both, psetsCompared: withPsets,
        ts: opts.ts || new Date().toISOString()
      }
    };
  }

  // Express ids of the NEW version an element filter keeps: 'changed' =
  // added + any change, 'added' = added only. null for 'all' / no diff.
  /** @param {any} diff @param {string} mode */
  function filterIds(diff, mode) {
    if (!diff || !mode || mode === 'all') return null;
    var set = new Set();
    (diff.added || []).forEach(function(id) { set.add(id); });
    if (mode === 'changed') (diff.modified || []).forEach(function(id) { set.add(id); });
    return set;
  }
  // Is this clash on a changed element (added / moved / reshaped / property
  // change) of a reloaded model? diffs: { modelId: diff }.
  /** @param {any} c @param {Record<string, Set<any>>} changedByModel */
  function clashOnChanged(c, changedByModel) {
    if (!c || !changedByModel) return false;
    var a = changedByModel[c.modelAId], b = changedByModel[c.modelBId];
    return !!((a && a.has(c.elemA)) || (b && b.has(c.elemB)));
  }

  // ── Export ──────────────────────────────────────────────────────────
  /** @param {any} v */
  function csvCell(v) {
    if (typeof v === 'number') return String(v);
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  // One row per changed element and per changed property (an element
  // without property changes: one row with empty property columns).
  // labels (optional): { kind(k), prop(key), header: [7 strings] }.
  /** @param {any} diff @param {any=} labels */
  function csvRows(diff, labels) {
    labels = labels || {};
    var kind = labels.kind || function(/** @type {string} */ k) { return k; };
    var prop = labels.prop || function(/** @type {string} */ k) { return k; };
    var rows = [labels.header || ['GlobalId', 'IFC type', 'Name', 'Change', 'Property', 'Old value', 'New value']];
    ((diff && diff.records) || []).forEach(function(r) {
      var base = [r.gid, r.type, r.name, kind(r.kind)];
      if (!r.props || !r.props.length) rows.push(base.concat(['', '', '']));
      else r.props.forEach(function(p) { rows.push(base.concat([prop(p.k), p.o, p.n])); });
    });
    return rows;
  }
  /** @param {any} diff @param {any=} labels */
  function toCsv(diff, labels) {
    return csvRows(diff, labels).map(function(r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  return Object.freeze({
    contractVersion: 1,
    ATTRS: ATTRS,
    KIND_ORDER: KIND_ORDER,
    quant: quant,
    worldVertex: worldVertex,
    geometrySignature: geometrySignature,
    rigidMotion: rigidMotion,
    compareGeometry: compareGeometry,
    flatProps: flatProps,
    propertyChanges: propertyChanges,
    hasPsets: hasPsets,
    diffModels: diffModels,
    filterIds: filterIds,
    clashOnChanged: clashOnChanged,
    csvCell: csvCell,
    csvRows: csvRows,
    toCsv: toCsv
  });
}));
