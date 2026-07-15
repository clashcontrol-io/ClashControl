(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccClashReconciliationCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var AUTO_RESOLVE_CAP = 200;

  function mergeDetectionResults(newClashes, prevClashes, options) {
    options = options || {};
    var identityKey = options.computeClashIdentityKey;
    var clashPair = options.computeClashPair;
    var isDenied = options.isDeniedClash;
    if (typeof identityKey !== 'function' || typeof clashPair !== 'function' || typeof isDenied !== 'function') {
      throw new Error('Clash reconciliation requires identity and denied-clash dependencies');
    }

    newClashes = newClashes.filter(function(c){ return !isDenied(c); });
    if (!prevClashes || prevClashes.length === 0) {
      var now0 = options.now != null ? options.now : Date.now();
      var firstRun = newClashes.map(function(c, i) {
        return Object.assign({}, c, {_identityKey:identityKey(c), _delta:'new', _firstSeen:now0, _lastSeen:now0, _runCount:1, number:i+1});
      });
      return {clashes:firstRun, deltaSummary:{newCount:firstRun.length,persisting:0,autoResolved:0,ts:now0}};
    }
    var now = options.now != null ? options.now : Date.now();
    var prevByKey = {};
    prevClashes.forEach(function(c) {
      var key = identityKey(c);
      prevByKey[key] = c;
    });

    var newKeys = {};
    var merged = newClashes.map(function(c) {
      var key = identityKey(c);
      newKeys[key] = true;
      var prev = prevByKey[key];
      if (!prev) {
        var p = c.point || [0,0,0];
        var gx = Math.round(p[0]/0.5), gy = Math.round(p[1]/0.5), gz = Math.round(p[2]/0.5);
        var pair = clashPair(c);
        outer: for (var dx=-1; dx<=1; dx++) { for (var dy=-1; dy<=1; dy++) { for (var dz=-1; dz<=1; dz++) {
          if (dx===0 && dy===0 && dz===0) continue;
          var adjKey = pair+'@'+(gx+dx)+','+(gy+dy)+','+(gz+dz);
          var cand = prevByKey[adjKey];
          if (cand) {
            var pp = cand.point||[0,0,0];
            var distMm = Math.sqrt(Math.pow((p[0]-pp[0])*1000,2)+Math.pow((p[1]-pp[1])*1000,2)+Math.pow((p[2]-pp[2])*1000,2));
            if (distMm <= 300) { prev = cand; newKeys[adjKey] = true; break outer; }
          }
        }}}
      }
      if (prev) {
        return Object.assign({}, c, {
          id: prev.id,
          _identityKey: key,
          _delta: 'persisting',
          _firstSeen: prev._firstSeen || now,
          _lastSeen: now,
          _runCount: (prev._runCount || 1) + 1,
          _prevDepth: prev.distance,
          _prevPoint: prev.point,
          status: prev.status === 'auto_resolved' ? 'open' : prev.status,
          assignee: prev.assignee,
          priority: prev.priority,
          aiSignals: prev.aiSignals,
          aiFeedback: prev.aiFeedback,
          aiReasons: prev.aiReasons,
          aiResolution: prev.aiResolution,
          aiNote: prev.aiNote,
          aiSeverity: prev.aiSeverity,
          aiCategory: prev.aiCategory,
          aiReason: prev.aiReason,
          _clusterGroup: prev._clusterGroup,
          _clusterSize: prev._clusterSize,
          clashTypeConfirmed: prev.clashTypeConfirmed,
          linkedIssueId: prev.linkedIssueId,
        });
      }
      return Object.assign({}, c, {_identityKey:key, _delta:'new', _firstSeen:now, _lastSeen:now, _runCount:1});
    });

    var arCount = 0, arOverflow = 0;
    prevClashes.forEach(function(c) {
      var key = identityKey(c);
      if (!newKeys[key] && (c.status==='open' || c.status==='in_progress')) {
        if (arCount >= AUTO_RESOLVE_CAP) { arOverflow++; return; }
        merged.push(Object.assign({}, c, {_identityKey:key, _delta:'auto_resolved', _lastSeen:now, status:'auto_resolved'}));
        arCount++;
      }
    });

    var usedNums = {};
    merged.forEach(function(c){
      var prev = prevByKey[c._identityKey];
      if (prev && prev.number != null) {
        c.number = prev.number;
        usedNums[prev.number] = true;
      }
    });
    var nextNum = 1;
    merged.forEach(function(c){
      if (c.number != null) return;
      while (usedNums[nextNum]) nextNum++;
      c.number = nextNum;
      usedNums[nextNum] = true;
      nextNum++;
    });

    var newCount=0, persisting=0, autoResolved=0;
    merged.forEach(function(c){if(c._delta==='new')newCount++;else if(c._delta==='persisting')persisting++;else if(c._delta==='auto_resolved')autoResolved++;});
    return {clashes:merged, deltaSummary:{newCount:newCount,persisting:persisting,autoResolved:autoResolved+arOverflow,autoResolvedTruncated:arOverflow||undefined,ts:now}};
  }

  return Object.freeze({
    contractVersion: 1,
    autoResolveCap: AUTO_RESOLVE_CAP,
    mergeDetectionResults: mergeDetectionResults
  });
}));
