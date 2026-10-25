// @ts-check
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccProjectCodec = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function serializeProject(state, version, savedAt) {
    return {
      _cc: 'ClashControl', _v: version,
      savedAt: savedAt,
      rules: state.rules,
      // Parked models (memory relief, PARK_MODEL) are still part of the
      // project: their clashes/issues reference them by id, so they are saved
      // as model stubs exactly like loaded ones.
      models: state.models.concat(state.parkedModels || []).map(function(model) {
        return {id:model.id,name:model.name,discipline:model.discipline,color:model.color,visible:model.visible,tag:model.tag||''};
      }),
      clashes: state.clashes,
      issues: state.issues,
      floors: state.floors,
      lastDeltaSummary: state.lastDeltaSummary || null,
      runHistory: state.runHistory || [],
      viewpoints: (state.viewpoints || []).map(function(viewpoint) {
        return Object.assign({}, viewpoint, {snapshot:undefined});
      }),
      measurements: state.measurements || [],
      selectionSets: state.selectionSets || [],
      searchSets: state.searchSets || [],
      assignmentRules: state.assignmentRules || [],
      changelog: state.changelog || [],
      comments: state.comments || [],
      // denied memory: clashes a person denied are dropped by later runs
      // (identity key → {pair, point, ts, reason, by}); per project, shared
      deniedPairs: state.deniedPairs || {},
      // clash review: facet filters, search, saved views and the overview/list
      // choice — per project (autoOpen is per run and never stored)
      triage: serializeTriage(state),
    };
  }

  function serializeTriage(state) {
    var t = state.triage || {};
    return {
      facets: t.facets || {},
      search: (state.filters && state.filters.search) || '',
      view: t.view === 'list' || t.view === 'overview' ? t.view : 'auto',
      savedViews: Array.isArray(t.savedViews) ? t.savedViews : [],
      activeViewId: t.activeViewId || null
    };
  }

  function validateProject(data) {
    if (!data._cc || data._cc !== 'ClashControl') throw new Error('Not a ClashControl project file.');
  }

  // Rule maps that belong to one project (never carried over from another).
  var PROJECT_RULE_MAPS = ['disciplineMatrix', 'matrixRules', 'toleranceByTypePair', 'roleChoices'];

  /** @param {any} v */
  function isDeniedMemory(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  // The old per-browser store (`cc_denied_clashes`: element pair → {point,
  // ts}) as denied memory. Keyed `legacy:<pair>` — the old store had no
  // identity key; matching uses pair + point either way.
  /** @param {any} store */
  function importLegacyDenied(store) {
    /** @type {any} */
    var out = {};
    if (!isDeniedMemory(store)) return out;
    Object.keys(store).forEach(function(pair) {
      var e = store[pair];
      if (!pair || !e || !Array.isArray(e.point) || e.point.length < 3) return;
      out['legacy:' + pair] = {pair: pair, point: [+e.point[0] || 0, +e.point[1] || 0, +e.point[2] || 0], ts: +e.ts || 0, reason: '', by: ''};
    });
    return out;
  }

  /** @param {any} data @param {(a:any)=>void} dispatch @param {any} actions @param {{legacyDenied?:any}} [opts] */
  function restoreProject(data, dispatch, actions, opts) {
    data.models.forEach(function(model) {
      dispatch({t:actions.ADD_MODEL, v:Object.assign({}, model, {meshes:[],elements:[],_stub:true})});
    });
    var rules = data.rules;
    // 1e-5 m³ was the shipped minOverlapVolM3 default until touches got real
    // contact classification; it dropped genuine small penetrations, so a
    // project saved with the old default loads with the new one (0 = off).
    if (rules && rules.minOverlapVolM3 === 1e-5) rules = Object.assign({}, rules, {minOverlapVolM3: 0});
    // Rules merge into the current ones (UPD_RULES), so a per-project rule
    // map the file lacks (older projects) would keep the previously open
    // project's cells / tolerances / choices. Those maps start empty.
    if (rules) {
      var maps = {};
      PROJECT_RULE_MAPS.forEach(function(k) { if (!(k in rules)) maps[k] = {}; });
      if (Object.keys(maps).length) rules = Object.assign({}, rules, maps);
    }
    dispatch({t:actions.UPD_RULES, u:rules});
    // Before the clashes: a restored list drops what is denied, as it always
    // did with the per-browser store. A file saved before the denied memory
    // was project state has no `deniedPairs`: it gets the old store's
    // entries (opts.legacyDenied) once — saved again, it carries its own.
    if (actions.DENIED_SET) {
      var denied = isDeniedMemory(data.deniedPairs) ? data.deniedPairs : importLegacyDenied(opts && opts.legacyDenied);
      dispatch({t:actions.DENIED_SET, v:denied});
    }
    if (data.clashes) dispatch({t:actions.SET_CLASHES, v:data.clashes});
    if (data.runHistory || data.lastDeltaSummary) dispatch({
      t:actions.LOAD_PROJECT_STATE,
      data:{runHistory:data.runHistory||[],lastDeltaSummary:data.lastDeltaSummary||null}
    });
    (data.issues || []).forEach(function(issue) { dispatch({t:actions.ADD_ISSUE, v:issue}); });
    (data.viewpoints || []).forEach(function(viewpoint) { dispatch({t:actions.ADD_VIEWPOINT, v:viewpoint}); });
    if (data.measurements) data.measurements.forEach(function(measurement) { dispatch({t:actions.ADD_MEASUREMENT, v:measurement}); });
    if (data.selectionSets) data.selectionSets.forEach(function(selectionSet) { dispatch({t:actions.ADD_SELSET, v:selectionSet}); });
    if (data.searchSets) data.searchSets.forEach(function(searchSet) { dispatch({t:actions.ADD_SEARCHSET, v:searchSet}); });
    if (data.assignmentRules) data.assignmentRules.forEach(function(rule) { dispatch({t:actions.ADD_ASSIGN_RULE, v:rule}); });
    if (data.changelog && data.changelog.length) dispatch({t:actions.MERGE_CHANGELOG, v:data.changelog});
    if (data.comments && data.comments.length && actions.MERGE_COMMENTS) dispatch({t:actions.MERGE_COMMENTS, v:data.comments});
    if (actions.TRIAGE_STATE) {
      var tr = data.triage || {};
      dispatch({t:actions.TRIAGE_STATE, v:{facets: tr.facets || {}, view: tr.view || 'auto', savedViews: Array.isArray(tr.savedViews) ? tr.savedViews : [], activeViewId: tr.activeViewId || null}});
      if (actions.UPD_FILTERS && tr.search) dispatch({t:actions.UPD_FILTERS, u:{search: String(tr.search)}});
    }
  }

  return Object.freeze({
    contractVersion: 1,
    serializeProject: serializeProject,
    validateProject: validateProject,
    restoreProject: restoreProject,
    importLegacyDenied: importLegacyDenied,
    serializeTriage: serializeTriage
  });
}));
