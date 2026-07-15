(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccClashAssignmentCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function matchAssignmentRule(rules, clash) {
    if (!rules || !rules.length) return null;
    var ds = clash.disciplines || [];
    var d1 = ds[0] || null, d2 = ds[1] || null;
    var storey = clash.elemAStorey || clash.elemBStorey || '';
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      var m1 = rule.discipline1 === 'any' || rule.discipline1 === d1 || rule.discipline1 === d2;
      var m2 = rule.discipline2 === 'any' || rule.discipline2 === d1 || rule.discipline2 === d2;
      if (!m1 || !m2) continue;
      if (rule.storey && rule.storey !== 'any' && rule.storey !== storey) continue;
      return rule;
    }
    return null;
  }

  function applyAssignmentRules(clashes, rules) {
    if (!rules || !rules.length) return clashes;
    return clashes.map(function(clash) {
      if (clash._delta !== 'new' || clash.assignee) return clash;
      var rule = matchAssignmentRule(rules, clash);
      if (!rule) return clash;
      var update = {};
      if (rule.assignee) update.assignee = rule.assignee;
      if (rule.priority) update.priority = rule.priority;
      return Object.keys(update).length ? Object.assign({}, clash, update) : clash;
    });
  }

  return Object.freeze({
    contractVersion: 1,
    matchAssignmentRule: matchAssignmentRule,
    applyAssignmentRules: applyAssignmentRules
  });
}));
