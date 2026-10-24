// @ts-check
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccClashTriageCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // Smart filtering for the clash review (overview + list): storey
  // normalisation across models, facet values with live counts, suggested
  // views derived from the data, free-text search and saved views. Pure —
  // reads clash fields and a small context; node:test drives it directly
  // (tests/clash-triage-core.test.js). The review buckets and severity live in
  // clash-classification-core.js; this module only files and filters.

  // ── Storey normalisation ────────────────────────────────────────────
  // Federated models name the same floor differently ("Level 1", "01 - Eerste
  // verdieping", "L1", "+3.000"). Two storeys are the same floor when
  //   1. both names carry the same level number (numeric prefix / "level n" /
  //      "n-th floor" / ground and basement words), or
  //   2. their elevations match within ELEV_TOL_M (any model, any name).
  // The canonical label is "L<n>" when a level number is known, otherwise the
  // most common (then alphabetically first) name of the elevation cluster.
  var ELEV_TOL_M = 0.5;
  var GROUND_RE = /^(ground|ground floor|gf|bg|begane grond|eg|erdgeschoss|rdc|rez-de-chauss[eé]e|planta baja|pb|piano terra|pt)\b/i;
  var BASEMENT_RE = /^(basement|kelder|souterrain|untergeschoss|sous-sol|b|ug|k)\s*-?\s*(\d+)?\b/i;
  var LEVEL_RE = /(?:\blevel|\blvl|\bfloor|\bstorey|\bstory|\bverdieping|\bniveau|\bgeschoss|\bétage|\betage|\bplanta|\bpiano|\bl)\s*[_:.]?\s*([+-]?\d+)\b/i;
  var ORDINAL_RE = /^([+-]?\d+)\s*(?:e|de|ste|st|nd|rd|th|\.)?\s*(?:verdieping|floor|storey|story|etage|étage|og|obergeschoss|stock)\b/i;
  var PREFIX_RE = /^([+-]?\d{1,3})(?:\s*[-_.:)]\s*|\s+)(?=\D)/;
  function levelNumber(name) {
    var s = String(name == null ? '' : name).trim();
    if (!s) return null;
    if (GROUND_RE.test(s)) return 0;
    var m = s.match(BASEMENT_RE);
    if (m && (m[2] || /^(basement|kelder|souterrain|untergeschoss|sous-sol)/i.test(s))) return -(m[2] ? parseInt(m[2], 10) : 1);
    m = s.match(ORDINAL_RE); if (m) return parseInt(m[1], 10);
    m = s.match(LEVEL_RE); if (m) return parseInt(m[1], 10);
    m = s.match(PREFIX_RE); if (m) return parseInt(m[1], 10);
    if (/^[+-]?\d{1,3}$/.test(s)) return parseInt(s, 10);
    return null;
  }
  // entries: [{modelId, name, elevation, unitScale?}] — elevation in model
  // units; unitScale = model units per metre when the model declares its
  // length unit (1000 = mm, 1 = m). Without it, a model whose largest
  // |elevation| exceeds 1000 is taken to store millimetres.
  // Returns { label(modelId, name) -> canonical label ('' for no storey),
  //           labels: [canonical labels ordered by elevation] }.
  function buildStoreyNormaliser(entries) {
    var list = (entries || []).filter(function(e) { return e && e.name; });
    var maxAbs = {};
    list.forEach(function(e) {
      var v = Math.abs(Number(e.elevation) || 0), k = String(e.modelId || '');
      if (!(k in maxAbs) || v > maxAbs[k]) maxAbs[k] = v;
    });
    var rows = list.map(function(e) {
      var k = String(e.modelId || ''), el = Number(e.elevation);
      var hasEl = e.elevation != null && isFinite(el);
      var us = Number(e.unitScale);
      var elev = !hasEl ? null : (us > 0 && isFinite(us)) ? el / us : (maxAbs[k] > 1000 ? el / 1000 : el);
      return { modelId: k, name: String(e.name), elev: elev, level: levelNumber(e.name) };
    });
    // elevation clusters (single linkage over the sorted elevations)
    var withEl = rows.filter(function(r) { return r.elev != null; }).sort(function(a, b) { return a.elev - b.elev || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    var clusters = [], cur = null;
    withEl.forEach(function(r) {
      if (!cur || r.elev - cur.last > ELEV_TOL_M) { cur = { rows: [], last: r.elev, first: r.elev }; clusters.push(cur); }
      cur.rows.push(r); cur.last = r.elev; r.cluster = cur;
    });
    function clusterLabel(cl) {
      if (cl.label != null) return cl.label;
      var lv = {}, nm = {}, bestLv = null, bestName = null;
      cl.rows.forEach(function(r) {
        if (r.level != null) lv[r.level] = (lv[r.level] || 0) + 1;
        nm[r.name] = (nm[r.name] || 0) + 1;
      });
      Object.keys(lv).forEach(function(k) { if (bestLv == null || lv[k] > lv[bestLv] || (lv[k] === lv[bestLv] && +k < +bestLv)) bestLv = k; });
      Object.keys(nm).sort().forEach(function(k) { if (bestName == null || nm[k] > nm[bestName]) bestName = k; });
      cl.label = bestLv != null ? ('L' + bestLv) : (bestName || '');
      return cl.label;
    }
    var byModelName = {}, byName = {};
    rows.forEach(function(r) {
      var lab = r.level != null ? ('L' + r.level) : (r.cluster ? clusterLabel(r.cluster) : r.name);
      // a numbered name whose elevation cluster agrees on another number
      // keeps its own number: names beat elevations for an explicit level
      byModelName[r.modelId + '\u0000' + r.name] = lab;
      if (!(r.name in byName)) byName[r.name] = lab;
    });
    var order = {};
    clusters.forEach(function(cl, i) { cl.rows.forEach(function(r) { var l = byModelName[r.modelId + '\u0000' + r.name]; if (!(l in order)) order[l] = i; }); });
    var labels = Object.keys(byModelName).map(function(k) { return byModelName[k]; })
      .filter(function(v, i, a) { return a.indexOf(v) === i; })
      .sort(function(a, b) {
        var oa = a in order ? order[a] : 1e9, ob = b in order ? order[b] : 1e9;
        if (oa !== ob) return oa - ob;
        var la = /^L-?\d+$/.test(a) ? +a.slice(1) : null, lb = /^L-?\d+$/.test(b) ? +b.slice(1) : null;
        if (la != null && lb != null) return la - lb;
        return a < b ? -1 : a > b ? 1 : 0;
      });
    function label(modelId, name) {
      if (name == null || name === '') return '';
      var k = String(modelId || '') + '\u0000' + name;
      if (k in byModelName) return byModelName[k];
      if (name in byName) return byName[name];
      var lv = levelNumber(name);
      return lv != null ? ('L' + lv) : String(name);
    }
    return { label: label, labels: labels };
  }

  // ── Facets ──────────────────────────────────────────────────────────
  // One value per clash and facet (single-valued, so per-facet counts add
  // up to the items matching every other facet). 'tag' is the only
  // multi-valued key: the suggested views' predicates.
  var FACETS = ['severity', 'extent', 'storey', 'modelPair', 'trade', 'typePair', 'status', 'assignee', 'bucket'];
  var SEV_RANK = { critical: 3, major: 2, minor: 1, info: 0 };
  function _nice(t) { return String(t || 'Element').replace(/^Ifc/i, '').replace(/([a-z])([A-Z])/g, '$1 $2') || 'Element'; }
  function _pair(a, b, sep) { a = String(a || '?'); b = String(b || '?'); return a === b ? a : (a < b ? a + sep + b : b + sep + a); }
  function _isVertical(bb) {
    if (!bb) return false;
    var dy = Number(bb.dy), h = Math.max(Number(bb.dx) || 0, Number(bb.dz) || 0);
    return dy > 0 && dy >= 2 * h;               // scene space is Y-up
  }
  // The one facet value that reads the model names (a rename patches only it).
  /** @param {any} c @param {(id: any) => any} [modelName] */
  function modelPairValue(c, modelName) {
    var mn = modelName || function(id) { return id; };
    return _pair(mn(c.modelAId), mn(c.modelBId || c.modelAId), ' ↔ ');
  }
  // ctx: { severity(c), bucket(c), storey(modelId, name), modelName(id), trade(c, side) }
  function facetValues(c, ctx) {
    ctx = ctx || {};
    var sev = c.aiSeverity || (ctx.severity ? ctx.severity(c) : 'minor');
    var ext = c.type === 'hard' ? (c.extent || 'unknown') : (c.type === 'soft' ? 'clearance' : (c.type || 'other'));
    var stA = ctx.storey ? ctx.storey(c.modelAId, c.elemAStorey) : (c.elemAStorey || '');
    var stB = ctx.storey ? ctx.storey(c.modelBId, c.elemBStorey) : (c.elemBStorey || '');
    var mn = ctx.modelName || function(id) { return id; };
    var tA = ctx.trade ? ctx.trade(c, 'A') : ((c.trades && c.trades[0]) || (c.disciplines && c.disciplines[0]) || '');
    var tB = ctx.trade ? ctx.trade(c, 'B') : ((c.trades && c.trades[1]) || (c.disciplines && c.disciplines[1]) || '');
    var tags = [];
    var roleA = c.roleA, roleB = c.roleB;
    var structural = roleA === 'structural' || roleB === 'structural';
    if (c.type === 'hard' && structural && (ext === 'through' || ext === 'through-thin' || ext === 'partial')) tags.push('structural-penetration');
    var tyA = String(c.elemAType || ''), tyB = String(c.elemBType || '');
    var runA = /Pipe|Duct|CableCarrier|Conduit|FlowSegment/.test(tyA), runB = /Pipe|Duct|CableCarrier|Conduit|FlowSegment/.test(tyB);
    if (c.type === 'hard' && ((runA && /Slab/.test(tyB) && _isVertical(c.bboxA)) || (runB && /Slab/.test(tyA) && _isVertical(c.bboxB)))) tags.push('riser-through-slab');
    if (sev === 'critical' && !c.assignee) tags.push('unassigned-critical');
    if (c.opening === 'partial' || c.provision === 'partial') tags.push('opening-too-small');
    if (c._delta === 'new') tags.push('new');
    // a decision teammates changed at the same time in a shared folder
    // (addons/shared-project.js puts the conflict on the clash)
    if (c._sharedConflict && c._sharedConflict.length) tags.push('shared-conflict');
    // near miss: a clearance finding whose gap is <= 30 % of the clearance
    // the rule asked for (same ratio as the severity model's soft tier)
    if (c.type === 'soft') {
      var gap = typeof c.clearanceMm === 'number' ? c.clearanceMm : (typeof c.distance === 'number' ? Math.abs(c.distance) : null);
      var req = (typeof c.requiredClearanceMm === 'number' && c.requiredClearanceMm > 0) ? c.requiredClearanceMm : 50;
      if (gap != null && isFinite(gap) && gap / req <= 0.3) tags.push('near-miss');
    }
    return {
      severity: sev,
      extent: ext,
      storey: stA || stB || '',
      modelPair: modelPairValue(c, mn),
      trade: _pair(tA || 'other', tB || 'other', ' × '),
      typePair: _pair(_nice(c.elemAType), _nice(c.elemBType), ' × '),
      status: c.status || 'open',
      assignee: c.assignee || '',
      bucket: ctx.bucket ? ctx.bucket(c) : 'review',
      tag: tags
    };
  }
  // facets: { key: [values] } — OR inside a key, AND across keys. An empty or
  // missing array means "no filter on this key".
  function _active(facets) {
    var out = [];
    Object.keys(facets || {}).forEach(function(k) { if (Array.isArray(facets[k]) && facets[k].length) out.push(k); });
    return out;
  }
  function _matches(v, facets, keys, skip) {
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === skip) continue;
      var want = facets[k], have = v[k];
      if (Array.isArray(have)) {
        var any = false;
        for (var j = 0; j < have.length; j++) if (want.indexOf(have[j]) !== -1) { any = true; break; }
        if (!any) return false;
      } else if (want.indexOf(have) === -1) return false;
    }
    return true;
  }
  function matchesFacets(v, facets) { return _matches(v, facets || {}, _active(facets), null); }
  function hasFacets(facets) { return _active(facets).length > 0; }
  // Values are computed once per item (the expensive part) and reused.
  function indexItems(items, ctx) {
    return (items || []).map(function(c) { return { c: c, v: facetValues(c, ctx) }; });
  }
  function applyFacets(index, facets) {
    var keys = _active(facets);
    if (!keys.length) return index.map(function(r) { return r.c; });
    var out = [];
    for (var i = 0; i < index.length; i++) if (_matches(index[i].v, facets, keys, null)) out.push(index[i].c);
    return out;
  }
  // Live counts per facet value: each key counted over the items matching
  // every OTHER active key, so a chip's number is what you'd get by adding it.
  function facetCounts(index, facets, keysWanted) {
    var keys = _active(facets), out = {};
    (keysWanted || FACETS.concat(['tag'])).forEach(function(k) {
      var counts = {};
      for (var i = 0; i < index.length; i++) {
        var r = index[i];
        if (!_matches(r.v, facets, keys, k)) continue;
        var val = r.v[k];
        if (Array.isArray(val)) val.forEach(function(x) { counts[x] = (counts[x] || 0) + 1; });
        else counts[val] = (counts[val] || 0) + 1;
      }
      out[k] = counts;
    });
    return out;
  }
  // Values of one facet in display order: severity / extent / bucket by their
  // own scale, storey by the normaliser's order, the rest by count.
  var ORDER = {
    severity: ['critical', 'major', 'minor', 'info'],
    extent: ['through', 'through-thin', 'partial', 'graze', 'unknown', 'clearance', 'contact', 'duplicate', 'visibility', 'other'],
    bucket: ['review', 'contact', 'provided', 'provision', 'zone', 'twice', 'embedded', 'finish', 'graze', 'adjacent', 'handled'],
    status: ['open', 'in_progress', 'accepted_needs_check', 'confirmed', 'resolved', 'closed', 'denied']
  };
  function orderedValues(key, counts, storeyLabels) {
    var vals = Object.keys(counts || {});
    var base = ORDER[key] || (key === 'storey' ? (storeyLabels || []) : null);
    return vals.sort(function(a, b) {
      if (base) {
        var ia = base.indexOf(a), ib = base.indexOf(b);
        if (ia === -1) ia = 1e6; if (ib === -1) ib = 1e6;
        if (ia !== ib) return ia - ib;
      }
      if (counts[b] !== counts[a]) return counts[b] - counts[a];
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  // ── Suggested views ─────────────────────────────────────────────────
  // Offered only when they select something in the CURRENT data (a view that
  // would show nothing — or everything — is never suggested). Each is a facet set, so it
  // combines with whatever else is active.
  var SUGGESTED = [
    { id: 'structural-penetration', label: 'Structural penetrations', facets: { tag: ['structural-penetration'] } },
    { id: 'riser-through-slab', label: 'Risers through slabs', facets: { tag: ['riser-through-slab'] } },
    { id: 'unassigned-critical', label: 'Unassigned critical', facets: { tag: ['unassigned-critical'] } },
    { id: 'opening-too-small', label: 'Openings too small', facets: { tag: ['opening-too-small'] } },
    { id: 'near-miss', label: 'Near misses', facets: { extent: ['clearance'], tag: ['near-miss'] } },
    { id: 'new', label: 'New since last run', facets: { tag: ['new'] } },
    // offered whenever there are any, even when every item is in conflict
    { id: 'shared-conflict', label: 'Conflicts', facets: { tag: ['shared-conflict'] }, always: true }
  ];
  // Returns [{id, label, facets, count}] — fixed views first, then up to
  // maxStoreys "per storey" views (most clashes first), all non-empty.
  function suggestedViews(index, opts) {
    opts = opts || {};
    var tags = {}, storeys = {};
    index.forEach(function(r) {
      r.v.tag.forEach(function(t) { tags[t] = (tags[t] || 0) + 1; });
      if (r.v.storey) storeys[r.v.storey] = (storeys[r.v.storey] || 0) + 1;
    });
    var out = [];
    SUGGESTED.forEach(function(s) {
      var n = tags[s.facets.tag[0]] || 0;
      // non-empty, and narrower than "everything" (a first run makes every
      // clash 'new' — offering that view would filter nothing)
      if (n > 0 && (n < index.length || s.always)) out.push({ id: s.id, label: s.label, facets: s.facets, count: n });
    });
    var st = Object.keys(storeys);
    if (st.length > 1) {
      st.sort(function(a, b) { return storeys[b] - storeys[a] || (a < b ? -1 : 1); });
      st.slice(0, opts.maxStoreys || 4).forEach(function(k) {
        out.push({ id: 'storey:' + k, label: k, facets: { storey: [k] }, count: storeys[k], perStorey: true });
      });
    }
    return out;
  }

  // ── Free-text search ────────────────────────────────────────────────
  // Names, IFC types (raw and readable), storeys (raw and normalised),
  // GlobalIds, title and model names — lower-case, one string per clash.
  function searchText(c, v, ctx) {
    var mn = (ctx && ctx.modelName) || function(id) { return id; };
    return [c.title, c.elemAName, c.elemBName, c.elemAType, c.elemBType, _nice(c.elemAType), _nice(c.elemBType),
      c.elemAStorey, c.elemBStorey, v && v.storey, c.globalIdA, c.globalIdB, mn(c.modelAId), mn(c.modelBId),
      c.assignee, c.status, c.type].filter(Boolean).join(' ').toLowerCase();
  }
  // Every whitespace-separated term must occur (AND); quotes keep a phrase.
  function matchesSearch(text, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return true;
    var terms = [], m, re = /"([^"]+)"|(\S+)/g;
    while ((m = re.exec(q)) !== null) terms.push(m[1] || m[2]);
    for (var i = 0; i < terms.length; i++) if (text.indexOf(terms[i]) === -1) return false;
    return true;
  }

  // ── Saved views ─────────────────────────────────────────────────────
  // A view is {id, name, facets, search}. normaliseView drops unknown keys and
  // empty arrays so a round trip through the project file is lossless.
  function normaliseFacets(f) {
    var out = {};
    FACETS.concat(['tag']).forEach(function(k) {
      if (f && Array.isArray(f[k]) && f[k].length) out[k] = f[k].map(String).filter(function(v, i, a) { return a.indexOf(v) === i; }).sort();
    });
    return out;
  }
  function normaliseView(v) {
    if (!v || typeof v !== 'object') return null;
    var name = String(v.name || '').trim();
    if (!name) return null;
    return { id: String(v.id || ('view-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'))), name: name.slice(0, 80),
      facets: normaliseFacets(v.facets), search: String(v.search || '').slice(0, 200) };
  }
  function sameFacets(a, b) { return JSON.stringify(normaliseFacets(a)) === JSON.stringify(normaliseFacets(b)); }

  return Object.freeze({
    contractVersion: 1,
    ELEV_TOL_M: ELEV_TOL_M,
    levelNumber: levelNumber,
    buildStoreyNormaliser: buildStoreyNormaliser,
    FACETS: FACETS,
    SEV_RANK: SEV_RANK,
    facetValues: facetValues,
    modelPairValue: modelPairValue,
    indexItems: indexItems,
    applyFacets: applyFacets,
    matchesFacets: matchesFacets,
    hasFacets: hasFacets,
    facetCounts: facetCounts,
    orderedValues: orderedValues,
    SUGGESTED: SUGGESTED,
    suggestedViews: suggestedViews,
    searchText: searchText,
    matchesSearch: matchesSearch,
    normaliseFacets: normaliseFacets,
    normaliseView: normaliseView,
    sameFacets: sameFacets
  });
}));
