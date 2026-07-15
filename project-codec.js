(function(root, factory) {
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
      models: state.models.map(function(model) {
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
    };
  }

  function validateProject(data) {
    if (!data._cc || data._cc !== 'ClashControl') throw new Error('Not a ClashControl project file.');
  }

  function restoreProject(data, dispatch, actions) {
    data.models.forEach(function(model) {
      dispatch({t:actions.ADD_MODEL, v:Object.assign({}, model, {meshes:[],elements:[],_stub:true})});
    });
    dispatch({t:actions.UPD_RULES, u:data.rules});
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
  }

  return Object.freeze({
    contractVersion: 1,
    serializeProject: serializeProject,
    validateProject: validateProject,
    restoreProject: restoreProject
  });
}));
