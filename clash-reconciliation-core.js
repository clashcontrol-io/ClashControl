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

  // Rows are copied with object spread, not Object.assign({}, c, {...}):
  // the same own keys, order and values, but V8 keeps a ~50-field clash a
  // fast-mode object (~0.4 KB) — Object.assign adding two or more new keys
  // to a copy produces a dictionary-mode object (~3 KB), and these rows are
  // the clash list held in state.
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
        return {...c, _identityKey:identityKey(c), _delta:'new', _firstSeen:now0, _lastSeen:now0, _runCount:1, number:i+1};
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
        // Titles: an AI title (aiTitle) or a user-edited title belongs to the
        // clash, not to the run — carry it. A default title (the engine's own
        // "Supply duct through Wall" text) is regenerated from the fresh run.
        // options.isDefaultTitle (clash-classification-core) tells them apart;
        // without it only AI titles are carried.
        var titleCarry = {};
        if (prev.aiTitle) {
          titleCarry = { aiTitle: prev.aiTitle, title: prev.title, aiProvenance: prev.aiProvenance };
        } else if (typeof options.isDefaultTitle === 'function' && prev.title && !options.isDefaultTitle(prev)) {
          titleCarry = { title: prev.title };
        }
        return {...c, ...sevCarry, ...titleCarry,
          id: prev.id,
          _identityKey: key,
          _delta: 'persisting',
          _firstSeen: prev._firstSeen || now,
          _lastSeen: now,
          _runCount: (prev._runCount || 1) + 1,
          _prevDepth: prev.distance,
          _prevPoint: prev.point,
          // A clash that comes back after an auto-resolve reopens; one that was
          // confirmed (it has an issue) is confirmed again — its issue is
          // reopened by applyIssueLifecycle.
          status: prev.status === 'auto_resolved' ? (prev._preAutoStatus === 'confirmed' && prev.linkedIssueId ? 'confirmed' : 'open') : prev.status,
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
        };
      }
      return {...c, _identityKey:key, _delta:'new', _firstSeen:now, _lastSeen:now, _runCount:1};
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
        merged.push({...c, _identityKey:key, _delta:'not_checked'});
        return;
      }
      // A confirmed clash with an issue is followed too: when the geometry
      // no longer has it, the run auto-resolves it and applyIssueLifecycle
      // resolves its issue. (It used to be dropped from the list here.)
      if (!(c.status==='open' || c.status==='in_progress' || (c.status==='confirmed' && c.linkedIssueId))) return;
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
        merged.push({...c, _identityKey:key, _delta:'auto_resolve_capped'});
        return;
      }
      merged.push({...c, _identityKey:key, _delta:'auto_resolved', _lastSeen:now, status:'auto_resolved', _preAutoStatus:c.status});
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

  // ── Linked issues follow their clash (docs/INTERNALS.md §21.58) ─────
  // After a merge: an issue linked to a clash the run auto-resolved is
  // resolved (only while it is open / in progress — an issue a person
  // resolved, closed or set to anything else is never touched), with a
  // comment saying so and an `autoResolved` marker {ts, prevStatus, clashKey}.
  // When a later run finds that clash again (persisting, or new under the
  // same identity once the auto-resolved record has left the list) and the
  // issue is still resolved with the marker, it is reopened to its previous
  // status with a comment. Pure: returns the new arrays plus the per-issue /
  // per-clash before → after values the caller needs for undo.
  //   opts.now, opts.author, opts.resolvedText(ts), opts.reopenedText(ts),
  //   opts.commentId(issueId, kind)
  var LIFECYCLE_CLOSABLE = { open: true, in_progress: true };
  /** @param {any[]} clashes @param {any[]} issues @param {any} [opts] */
  function applyIssueLifecycle(clashes, issues, opts) {
    opts = opts || {};
    var now = opts.now != null ? opts.now : Date.now();
    /** @type {{clashes:any[], issues:any[], issueChanges:any[], clashChanges:any[], resolved:number, reopened:number}} */
    var out = { clashes: clashes, issues: issues, issueChanges: [], clashChanges: [], resolved: 0, reopened: 0 };
    if (!Array.isArray(clashes) || !Array.isArray(issues) || !issues.length) return out;
    var byId = Object.create(null), byAutoKey = Object.create(null);
    issues.forEach(function(it) {
      if (!it || !it.id) return;
      byId[it.id] = it;
      if (it.autoResolved && it.autoResolved.clashKey && it.status === 'resolved') byAutoKey[it.autoResolved.clashKey] = it;
    });
    var linkedNow = Object.create(null);
    clashes.forEach(function(c) { if (c && c.linkedIssueId) linkedNow[c.linkedIssueId] = true; });
    var patch = Object.create(null), clashPatch = Object.create(null);
    function comment(it, kind) {
      var text = kind === 'resolved'
        ? (opts.resolvedText ? opts.resolvedText(now) : 'Resolved by re-check')
        : (opts.reopenedText ? opts.reopenedText(now) : 'Reopened: found again by re-check');
      var id = opts.commentId ? opts.commentId(it.id, kind) : ('rc_' + kind + '_' + it.id + '_' + now);
      return { id: id, author: opts.author || 'ClashControl', text: text, ts: now, system: 'recheck' };
    }
    function resolve(it, c) {
      if (patch[it.id] || !LIFECYCLE_CLOSABLE[it.status]) return;
      patch[it.id] = { kind: 'resolved', u: {
        status: 'resolved',
        autoResolved: { ts: now, prevStatus: it.status, clashKey: c._identityKey || null },
        comments: (it.comments || []).concat([comment(it, 'resolved')])
      } };
      out.resolved++;
    }
    function reopen(it) {
      if (patch[it.id] || it.status !== 'resolved' || !it.autoResolved) return;
      patch[it.id] = { kind: 'reopened', u: {
        status: LIFECYCLE_CLOSABLE[it.autoResolved.prevStatus] ? it.autoResolved.prevStatus : 'open',
        autoResolved: null,
        comments: (it.comments || []).concat([comment(it, 'reopened')])
      } };
      out.reopened++;
    }
    clashes.forEach(function(c) {
      if (!c) return;
      if (c.linkedIssueId) {
        var it = byId[c.linkedIssueId];
        if (!it) return;
        if (c._delta === 'auto_resolved') resolve(it, c);
        else if (c._delta === 'persisting' || c._delta === 'new') reopen(it);
        return;
      }
      // found again after its auto-resolved record left the list: same identity
      if (c._delta === 'new' && c._identityKey && byAutoKey[c._identityKey]) {
        var it2 = byAutoKey[c._identityKey];
        if (linkedNow[it2.id] || patch[it2.id]) return;
        reopen(it2);
        if (patch[it2.id]) { clashPatch[c.id] = { linkedIssueId: it2.id }; linkedNow[it2.id] = true; }
      }
    });
    if (!Object.keys(patch).length) return out;
    out.issues = issues.map(function(it) {
      var p = it && patch[it.id];
      if (!p) return it;
      /** @type {any} */
      var before = {};
      Object.keys(p.u).forEach(function(f) { before[f] = it[f] === undefined ? null : it[f]; });
      out.issueChanges.push({ id: it.id, kind: p.kind, prev: before, next: p.u });
      return Object.assign({}, it, p.u);
    });
    if (Object.keys(clashPatch).length) {
      out.clashes = clashes.map(function(c) {
        var p = c && clashPatch[c.id];
        if (!p) return c;
        out.clashChanges.push({ id: c.id, prev: { linkedIssueId: c.linkedIssueId == null ? null : c.linkedIssueId }, next: p });
        return Object.assign({}, c, p);
      });
    }
    return out;
  }

  // ── Denied memory (project state, docs/INTERNALS.md §21.58) ─────────
  // `deniedPairs`: { [clash identity key]: {pair, point, ts, reason, by} }.
  // A detected clash is dropped when a denied entry has the same element
  // pair within DENIED_RADIUS_MM of its point (the rule of the old
  // per-browser `cc_denied_clashes` store, which kept one point per pair).
  var DENIED_RADIUS_MM = 150;
  var DENIED_CAP = 5000;
  /** @param {any} p @param {any} q */
  function _dist2Mm(p, q) {
    p = p || [0, 0, 0]; q = q || [0, 0, 0];
    var dx = (p[0] - q[0]) * 1000, dy = (p[1] - q[1]) * 1000, dz = (p[2] - q[2]) * 1000;
    return dx * dx + dy * dy + dz * dz;
  }
  // isDeniedClash for mergeDetectionResults, indexed once per call.
  /** @param {any} memory @param {(c:any)=>string} clashPair @returns {(c:any)=>boolean} */
  function makeDeniedMatcher(memory, clashPair) {
    var byPair = Object.create(null), any = false;
    Object.keys(memory || {}).forEach(function(k) {
      var e = memory[k];
      if (!e || !e.pair) return;
      (byPair[e.pair] = byPair[e.pair] || []).push(e);
      any = true;
    });
    var r2 = DENIED_RADIUS_MM * DENIED_RADIUS_MM;
    return function(c) {
      if (!any || !c) return false;
      var list = byPair[clashPair(c)];
      if (!list) return false;
      for (var i = 0; i < list.length; i++) if (_dist2Mm(c.point, list[i].point) <= r2) return true;
      return false;
    };
  }
  /** @param {any} c @param {any} deps */
  function deniedEntryFor(c, deps) {
    var p = c.point || [0, 0, 0];
    return { pair: deps.computeClashPair(c), point: [p[0], p[1], p[2]], ts: c.deniedAt || deps.now || Date.now(),
      reason: c.deniedReason || '', by: c.deniedBy || '' };
  }
  // Keeps the memory in step with a clash-list change made by an action
  // (deny, reopen, undo, a teammate's record): compares `before` and `after`
  // item by item (the reducer keeps order and object identity of untouched
  // clashes). Returns the same memory object when nothing changed.
  /** @param {any} memory @param {any[]} before @param {any[]} after @param {any} deps */
  function updateDeniedMemory(memory, before, after, deps) {
    memory = memory || {};
    if (!before || !after || before === after) return memory;
    /** @type {any} */
    var prevById = null;
    /** @type {any} */
    var next = null;
    function prevOf(c, i) {
      var b = before[i];
      if (b && b.id === c.id) return b;
      if (!prevById) { prevById = Object.create(null); before.forEach(function(x) { if (x) prevById[x.id] = x; }); }
      return prevById[c.id] || null;
    }
    after.forEach(function(c, i) {
      if (!c || c === before[i]) return;
      var b = prevOf(c, i);
      var wasDenied = !!(b && b.status === 'denied'), isDenied = c.status === 'denied';
      if (!wasDenied && !isDenied) return;
      var key = c._identityKey || deps.computeClashIdentityKey(c);
      if (!key) return;
      if (isDenied) {
        var cur = memory[key], e = deniedEntryFor(c, deps);
        if (cur && cur.pair === e.pair && cur.reason === e.reason && cur.by === e.by && _dist2Mm(cur.point, e.point) === 0) return;
        if (cur && wasDenied) e.ts = cur.ts;
        next = next || Object.assign({}, memory);
        next[key] = e;
      } else if (memory[key] || (next && next[key])) {
        next = next || Object.assign({}, memory);
        delete next[key];
      }
    });
    if (!next) return memory;
    var keys = Object.keys(next);
    if (keys.length > DENIED_CAP) {
      keys.sort(function(a, b) { return (next[a].ts || 0) - (next[b].ts || 0); });
      keys.slice(0, keys.length - DENIED_CAP).forEach(function(k) { delete next[k]; });
    }
    return next;
  }

  return Object.freeze({
    // v2 (CLAUDE.md Item 2): added options.coverage (run-scope awareness --
    // a prior clash outside this run's scope is preserved as 'not_checked'
    // rather than auto-resolved) and AUTO_RESOLVE_CAP overflow no longer
    // drops records -- they're preserved unchanged, only capped from
    // flipping to auto_resolved.
    contractVersion: 2,
    autoResolveCap: AUTO_RESOLVE_CAP,
    mergeDetectionResults: mergeDetectionResults,
    applyIssueLifecycle: applyIssueLifecycle,
    deniedRadiusMm: DENIED_RADIUS_MM,
    makeDeniedMatcher: makeDeniedMatcher,
    updateDeniedMemory: updateDeniedMemory
  });
}));
