// @ts-check
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccClashReconciliationCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var AUTO_RESOLVE_CAP = 200;

  // options.coverage: optional function(prevClash) -> boolean describing
  // whether THIS run could plausibly have rediscovered a given prior clash
  // (e.g. "both of its elements' models were within the resolved scope of
  // this run"). Absent it, every prior clash is treated as in-scope -- the
  // behaviour every existing caller/test already relies on. A previously
  // open/in_progress clash OUTSIDE coverage is never auto-resolved: it
  // survives unchanged (status untouched) with `_delta:'not_checked'`
  // instead. See index.html's wiring of this via _ccResolveModelScope for
  // the real caller -- a run scoped to models A-B must never flip a C-D
  // clash to auto_resolved just because this run didn't happen to look at
  // it. Deliberately coarse (model-pair scope only, not excludeSelf/
  // discipline-matrix/hard-vs-soft nuance) -- see CLAUDE.md Item 2.
  function _inCoverage(options, c) {
    return typeof options.coverage !== 'function' || !!options.coverage(c);
  }

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
    // Bug 5: identity is element-pair based, with the point/spatial-cell
    // used only as a tiebreak when a pair genuinely has multiple distinct
    // clash locations (e.g. a long duct crossing a beam at 2+ points).
    // Group prior clashes by their element pair so an unambiguous 1:1 pair
    // match (both sides have exactly one clash for that pair) is stable
    // across engines/tiny point shifts, without needing the point at all.
    var prevByPair = {};
    prevClashes.forEach(function(c) {
      var key = identityKey(c);
      prevByKey[key] = c;
      var pair = clashPair(c);
      (prevByPair[pair] = prevByPair[pair] || []).push(c);
    });
    var newPairCount = {};
    newClashes.forEach(function(c) {
      var pair = clashPair(c);
      newPairCount[pair] = (newPairCount[pair] || 0) + 1;
    });

    var newKeys = {};
    var consumedPrevIds = {};
    var prevIdToNumber = {};
    var merged = newClashes.map(function(c) {
      var key = identityKey(c);
      newKeys[key] = true;
      var prev = prevByKey[key];
      var pair = clashPair(c);
      if (!prev) {
        var p = c.point || [0,0,0];
        var gx = Math.round(p[0]/0.5), gy = Math.round(p[1]/0.5), gz = Math.round(p[2]/0.5);
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
      if (!prev && newPairCount[pair] === 1 && (prevByPair[pair] || []).length === 1) {
        // Unambiguous on both sides: exactly one clash for this element
        // pair in each of the old and new result sets, regardless of how
        // far the hit point moved (engine swap, precision differences).
        // Genuinely multiple clashes between the same pair (either side
        // has >1) still fall through to the point-based matching above.
        var onlyPrev = prevByPair[pair][0];
        if (!consumedPrevIds[onlyPrev.id]) {
          prev = onlyPrev;
          newKeys[identityKey(onlyPrev)] = true;
          consumedPrevIds[onlyPrev.id] = true;
        }
      }
      if (prev) {
        // Bug 3: the matched previous clash may have been found via the
        // neighbouring-grid-cell fallback above (adjKey), so prevByKey[key]
        // (the NEW point's key) would miss it. Track the matched prev's
        // number directly (by the resulting id, which is set to prev.id)
        // instead of re-deriving it from _identityKey later.
        prevIdToNumber[prev.id] = prev.number;
        // A severity the rule model derived (clash-classification-core.js stamps
        // _sevSource:'rule') is a pure function of the clash's current depth /
        // gap / roles, so a re-run must re-derive it from the fresh geometry —
        // carrying the previous verdict forward would leave a clash that got
        // deeper (or was fixed to a graze) at its stale severity. Only human /
        // AI-authored verdicts (_sevSource:'ai', or legacy records with no
        // marker) are carried.
        var carrySev = prev._sevSource !== 'rule';
        var sevCarry = carrySev ? {
          aiSeverity: prev.aiSeverity,
          aiCategory: prev.aiCategory,
          aiReason: prev.aiReason,
          _sevSource: prev._sevSource
        } : {};
        return Object.assign({}, c, sevCarry, {
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
          _clusterGroup: prev._clusterGroup,
          _clusterSize: prev._clusterSize,
          clashTypeConfirmed: prev.clashTypeConfirmed,
          linkedIssueId: prev.linkedIssueId,
        });
      }
      return Object.assign({}, c, {_identityKey:key, _delta:'new', _firstSeen:now, _lastSeen:now, _runCount:1});
    });

    var arCount = 0, arOverflow = 0, notChecked = 0;
    prevClashes.forEach(function(c) {
      var key = identityKey(c);
      if (newKeys[key]) return;
      if (!_inCoverage(options, c)) {
        // This run's scope never touched this clash -- it wasn't
        // rediscovered because it was never checked, not because it went
        // away. Preserve it exactly (status untouched) so it stays
        // addressable, distinguishable from a genuine auto-resolve.
        // Bug 2: this must run for EVERY status (resolved/closed/accepted/
        // denied too), not just open/in_progress -- an out-of-coverage
        // clash of any status was previously dropped entirely by the
        // status guard below running first.
        notChecked++;
        merged.push(Object.assign({}, c, {_identityKey:key, _delta:'not_checked'}));
        return;
      }
      if (!(c.status==='open' || c.status==='in_progress')) return;
      if (arCount >= AUTO_RESOLVE_CAP) {
        // Cap how many auto-resolve per run, but never drop the record --
        // it keeps its prior status (assignee/comments/history intact) and
        // simply isn't flipped this run. deltaSummary reports it via
        // autoResolvedTruncated, separate from the real autoResolved count
        // (R3 follow-up: autoResolved used to add arOverflow on top of the
        // records that actually flipped, over-reporting "205 auto-resolved"
        // when only 200 did and 5 stayed open). _delta is explicitly set
        // (not left as whatever stale value `c` carried from a PRIOR run's
        // _delta, e.g. a leftover 'persisting') so it's never confused with
        // a fresh not_checked/auto_resolved/persisting/new record --
        // _delta is user-visible (badges, filters).
        arOverflow++;
        merged.push(Object.assign({}, c, {_identityKey:key, _delta:'auto_resolve_capped'}));
        return;
      }
      merged.push(Object.assign({}, c, {_identityKey:key, _delta:'auto_resolved', _lastSeen:now, status:'auto_resolved'}));
      arCount++;
    });

    var usedNums = {};
    merged.forEach(function(c){
      // Bug 3: prefer the number captured from the actually-matched prev
      // clash (handles the neighbouring-grid-cell fallback match, where
      // c._identityKey is the NEW point's key and wouldn't find the prev
      // record in prevByKey). Fall back to a direct key lookup for records
      // that were preserved as-is (not_checked / auto_resolved / capped),
      // whose _identityKey IS the prev's own key.
      var num = prevIdToNumber.hasOwnProperty(c.id) ? prevIdToNumber[c.id] : undefined;
      if (num == null) {
        var prev = prevByKey[c._identityKey];
        if (prev) num = prev.number;
      }
      if (num != null) {
        c.number = num;
        usedNums[num] = true;
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
    // R3 follow-up: autoResolved used to report autoResolved+arOverflow --
    // now that overflow is preserved (not dropped), that double-counted:
    // a 205-prior-open-clash run with the 200-cap in effect would report
    // "205 auto-resolved" when only 200 actually flipped status and 5
    // stayed open (_delta:'auto_resolve_capped'). Report them separately;
    // autoResolvedTruncated already existed as this exact count, it just
    // wasn't the ONLY place it was reflected.
    return {clashes:merged, deltaSummary:{newCount:newCount,persisting:persisting,autoResolved:autoResolved,autoResolvedTruncated:arOverflow||undefined,notChecked:notChecked||undefined,ts:now}};
  }

  return Object.freeze({
    // v2 (CLAUDE.md Item 2): added options.coverage (run-scope awareness --
    // a prior clash outside this run's scope is preserved as 'not_checked'
    // rather than auto-resolved) and AUTO_RESOLVE_CAP overflow no longer
    // drops records -- they're preserved unchanged, only capped from
    // flipping to auto_resolved.
    contractVersion: 2,
    autoResolveCap: AUTO_RESOLVE_CAP,
    mergeDetectionResults: mergeDetectionResults
  });
}));
