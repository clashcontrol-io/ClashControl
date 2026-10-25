// @ts-check
// Shared session (docs/INTERNALS.md §21.55, §21.56): the part of team sharing
// that does not depend on WHERE the change records live. One implementation
// for both sharing modes — the shared folder (addons/shared-project.js) and
// the cloud project key (index.html, api/project.js) — so both turn local
// actions into the same records, apply teammates' records to the app state
// the same way and show the same conflicts.
//
// A transport (folder / cloud) owns the I/O: it hands records it read to
// `ingest` + `sync`, and writes what `takeBatch` gives it (`done` when it
// is stored, `release` when the write failed). Pure logic plus the
// injected env (dispatch, state, storage): no DOM, no network — node tests
// drive it with a fake dispatch.
//
// Targets: `clash` (by clash identity), `issue` / `note` / `viewpoint` (by
// id). Records carry decisions only — never geometry, pictures or results.
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccSharedSessionCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  /** @returns {any} */
  function L() {
    var g = /** @type {any} */ (typeof globalThis !== 'undefined' ? globalThis : {});
    if (g._ccSharedLogCore) return g._ccSharedLogCore;
    // eslint-disable-next-line no-undef
    if (typeof require === 'function') return require('./shared-log-core.js');
    return null;
  }

  var NOTE_FIELDS = ['text', 'resolved'];
  var VIEWPOINT_FIELDS = ['name'];
  var hasOwn = function(o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  /** @param {any} v */
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  /**
   * @param {{
   *   src:string, userId:string, writer:string, projectKey:string,
   *   dispatch:(a:any)=>void, getState:()=>any,
   *   identityKey?:(c:any)=>(string|null),
   *   i18n?:(k:string, en:string, vars?:any)=>string,
   *   storage?:any, outboxPrefix?:string,
   *   onRecorded?:(why:string)=>void, onConflicts?:(n:number)=>void,
   *   now?:()=>number
   * }} env
   */
  function createSession(env) {
    var C = L();
    if (!C) throw new Error('shared-log-core.js not loaded');
    var log = C.createLog();
    var outbox = [];                 // own records not stored yet (log record objects)
    var inflight = Object.create(null);
    var written = Object.create(null);
    var n = 0, recorded = false;
    var last = { clashes: null, issues: null, comments: null, viewpoints: null };
    /** @type {{clashes:any, map:Map<string, any[]>}} */
    var clashIndex = { clashes: null, map: new Map() };
    var pendingScan = [];            // issue lists before a confirm (their new issues get published)
    var stats = { dispatches: 0, records: 0, projected: 0 };
    var now = env.now || function() { return Date.now(); };
    var obKey = (env.outboxPrefix || 'cc_shared_outbox') + ':' + env.writer;

    function i18n(k, en, vars) {
      if (env.i18n) return env.i18n(k, en, vars);
      return vars ? String(en).replace(/\{(\w+)\}/g, function(m, x) { return hasOwn(vars, x) ? String(vars[x]) : m; }) : en;
    }
    function d(a) { stats.dispatches++; env.dispatch(a); }
    function state() { return env.getState ? env.getState() : null; }
    function clashKey(c) {
      if (!c) return null;
      if (c._identityKey) return c._identityKey;
      return env.identityKey ? env.identityKey(c) : null;
    }
    function newId() { return env.writer + '.' + (++n); }

    // ── Outbox (localStorage: survives a closed tab) ──────────────────
    function saveOutbox() {
      var ls = env.storage;
      if (!ls) return;
      try {
        if (outbox.length) ls.setItem(obKey, JSON.stringify({ pk: env.projectKey, ts: now(), recs: outbox }));
        else ls.removeItem(obKey);
      } catch (e) { /* quota / private mode: the write still happens this session */ }
    }
    // Outboxes left by an earlier session (a closed tab) of this project. One
    // touched less than a minute ago may belong to a tab that is still open
    // (it writes them itself), so it is looked at again on a later check.
    function adoptOutboxes() {
      var ls = env.storage, got = false;
      if (!ls) return false;
      try {
        var prefix = (env.outboxPrefix || 'cc_shared_outbox') + ':';
        for (var k = ls.length - 1; k >= 0; k--) {
          var lk = ls.key(k);
          if (!lk || lk === obKey || lk.indexOf(prefix) !== 0) continue;
          var ob = JSON.parse(ls.getItem(lk) || 'null');
          if (!ob || ob.pk !== env.projectKey || !Array.isArray(ob.recs) || now() - (ob.ts || 0) < 60000) continue;
          C.addChanges(log, ob.recs);
          ob.recs.forEach(function(r) { var rec = log.changes[r && r.id]; if (rec && outbox.indexOf(rec) === -1 && !written[rec.id]) { outbox.push(rec); got = true; } });
          ls.removeItem(lk);
        }
      } catch (e) { /* unreadable outbox: ignored */ }
      if (got) saveOutbox();
      return got;
    }

    // ── Local edits → records ────────────────────────────────────────
    // One field edit. Skips no-ops; while the record is still in the outbox
    // (and not being written), a further edit of the same field amends it
    // instead of adding a record per keystroke.
    function record(kind, key, field, value, prevLocal) {
      if (!key) return null;
      if (value === undefined) value = null;
      var st = C.fieldState(log, C.groupKey(kind, key, field));
      if (!st && C.same(value, prevLocal)) return null;
      if (st && !st.conflicted && C.same(st.value, value)) return null;
      var lastRec = outbox.length ? outbox[outbox.length - 1] : null;
      if (lastRec && !lastRec.resolution && !inflight[lastRec.id] && field !== 'deleted' && lastRec.target.kind === kind && lastRec.target.key === key &&
          lastRec.field === field && st && !st.conflicted && st.heads.length === 1 && st.heads[0] === lastRec) {
        lastRec.value = value;
        saveOutbox();
        recorded = true;
        return lastRec;
      }
      var r = C.makeChange(log, { id: newId(), user: env.userId, ts: now(), kind: kind, key: key, field: field, value: value, prev: prevLocal === undefined ? null : prevLocal });
      C.addChanges(log, [r]);
      var rec = log.changes[r.id];
      outbox.push(rec);
      stats.records++;
      saveOutbox();
      recorded = true;
      return rec;
    }
    function diffList(kind, key, prefix, before, after) {
      var b = {}, a = {};
      (before || []).forEach(function(x) { if (x && x.id) b[x.id] = x; });
      (after || []).forEach(function(x) { if (x && x.id) a[x.id] = x; });
      Object.keys(a).forEach(function(id) { if (!b[id] || !C.same(b[id], a[id])) record(kind, key, prefix + id, clone(a[id]), b[id] ? clone(b[id]) : null); });
      Object.keys(b).forEach(function(id) { if (!a[id]) record(kind, key, prefix + id, null, clone(b[id])); });
    }
    function noteRecord(nt) { var o = Object.assign({}, nt); delete o.replies; return C.issueRecord(o); }
    // A viewpoint linked to a clash is linked by the clash identity (clash
    // ids are per machine); one linked to an issue keeps the issue id.
    function vpRecord(vp, st) {
      var out = C.viewpointRecord(vp);
      if (vp.linkedId && st) {
        var c = (st.clashes || []).find(function(x) { return x.id === vp.linkedId; });
        if (c) { delete out.linkedId; var k = clashKey(c); if (k) out.linkedClash = k; }
      }
      return out;
    }
    function issueCreated(it) {
      if (!it || !it.id || C.fieldState(log, C.groupKey('issue', it.id, 'created'))) return;
      record('issue', it.id, 'created', C.issueRecord(it), null);
      if (it.comments) diffList('issue', it.id, 'comment:', [], it.comments);
    }

    // Every local (non-sync) action, with the state it was dispatched on and,
    // for batch actions, the id set it applies to.
    function note(a, prev, batchIds) {
      if (!a || !prev) return false;
      var F = C.DECISION_FIELDS, conflictedTargets = [];
      recorded = false;
      function clashEdit(c, u) {
        var key = clashKey(c);
        F.forEach(function(f) { if (u && hasOwn(u, f)) { record('clash', key, f, u[f], c[f]); if ((c._sharedConflict || []).length) conflictedTargets.push(C.targetKey('clash', key)); } });
      }
      function issueEdit(it, u) {
        F.forEach(function(f) { if (u && hasOwn(u, f)) record('issue', it.id, f, u[f], it[f]); });
        if (u && u.comments) diffList('issue', it.id, 'comment:', it.comments, u.comments);
        if ((it._sharedConflict || []).length) conflictedTargets.push(C.targetKey('issue', it.id));
      }
      var t = a.t;
      if (t === 'UPD_CLASH' && a.u) {
        var c = (prev.clashes || []).find(function(x) { return x.id === a.id; });
        if (c) clashEdit(c, a.u);
        // Confirm creates an issue in the reducer: publish it once it is there
        if (c && a.u.status === 'confirmed' && c.status !== 'confirmed') pendingScan.push(prev.issues || []);
      } else if (t === 'BATCH_UPD_CLASH' && a.u && batchIds) {
        (prev.clashes || []).forEach(function(x) { if (batchIds[x.id]) clashEdit(x, a.u); });
        if (a.u.status === 'confirmed') pendingScan.push(prev.issues || []);
      } else if (t === 'CLASH_BATCH_RESTORE' && a.prev) {
        (prev.clashes || []).forEach(function(x) { if (a.prev[x.id]) clashEdit(x, a.prev[x.id]); });
      } else if (t === 'UPD_ISSUE' && a.u) {
        var it = (prev.issues || []).find(function(x) { return x.id === a.id; });
        if (it) issueEdit(it, a.u);
      } else if (t === 'BATCH_UPD_ISSUE' && a.u && batchIds) {
        (prev.issues || []).forEach(function(x) { if (batchIds[x.id]) issueEdit(x, a.u); });
      } else if (t === 'ADD_ISSUE' && a.v && a.v.id) {
        if ((prev.issues || []).some(function(x) { return x.id === a.v.id; })) return false;
        issueCreated(a.v);
      } else if (t === 'DEL_ISSUE' && a.id) {
        if ((prev.issues || []).some(function(x) { return x.id === a.id; })) record('issue', a.id, 'deleted', true, null);
      } else if (t === 'ADD_COMMENT' && a.v && a.v.id) {
        record('note', a.v.id, 'created', noteRecord(a.v), null);
        if (a.v.replies) diffList('note', a.v.id, 'reply:', [], a.v.replies);
      } else if (t === 'UPD_COMMENT' && a.u) {
        var nt = (prev.comments || []).find(function(x) { return x.id === a.id; });
        if (nt) {
          NOTE_FIELDS.forEach(function(f) { if (hasOwn(a.u, f)) record('note', nt.id, f, a.u[f], nt[f]); });
          if (a.u.replies) diffList('note', nt.id, 'reply:', nt.replies, a.u.replies);
          if ((nt._sharedConflict || []).length) conflictedTargets.push(C.targetKey('note', nt.id));
        }
      } else if (t === 'DEL_COMMENT' && a.id) {
        if ((prev.comments || []).some(function(x) { return x.id === a.id; })) record('note', a.id, 'deleted', true, null);
      } else if (t === 'ADD_VIEWPOINT' && a.v && a.v.id && a.v.camera) {
        if (!(prev.viewpoints || []).some(function(x) { return x.id === a.v.id; })) record('viewpoint', a.v.id, 'created', vpRecord(a.v, prev), null);
      } else if (t === 'UPD_VIEWPOINT' && a.u) {
        var vp = (prev.viewpoints || []).find(function(x) { return x.id === a.id; });
        if (vp) {
          VIEWPOINT_FIELDS.forEach(function(f) { if (hasOwn(a.u, f)) record('viewpoint', vp.id, f, a.u[f], vp[f]); });
          if ((vp._sharedConflict || []).length) conflictedTargets.push(C.targetKey('viewpoint', vp.id));
        }
      } else if (t === 'DEL_VIEWPOINT' && a.id) {
        if ((prev.viewpoints || []).some(function(x) { return x.id === a.id; })) record('viewpoint', a.id, 'deleted', true, null);
      }
      var did = recorded;
      if (did && env.onRecorded) env.onRecorded('edit');
      // an edit of a conflicted field joins the conflict: show the agreed
      // value again once the reducer has applied the edit
      if (conflictedTargets.length) setTimeout(function() { project(new Set(conflictedTargets), state()); }, 0);
      return did;
    }

    // The state after an action, seen by the app (App effect on s.issues):
    // the issues a confirm created in the reducer are published.
    function observe(s) {
      if (!pendingScan.length || !s) return false;
      var known = Object.create(null);
      pendingScan.forEach(function(list) { list.forEach(function(i) { if (i && i.id) known[i.id] = true; }); });
      var before = pendingScan;
      pendingScan = [];
      if (before.length && s.issues === before[before.length - 1]) { pendingScan = before; return false; } // not applied yet
      recorded = false;
      (s.issues || []).forEach(function(it) { if (it && it.id && !known[it.id]) issueCreated(it); });
      if (recorded && env.onRecorded) env.onRecorded('edit');
      return recorded;
    }

    // A user's resolution of one conflicted field: one of the competing
    // values or a new one (for a delete conflict: keep = false, delete = true).
    function resolve(o) {
      if (!o || !o.kind || !o.key || !o.field) return false;
      var r = C.makeResolution(log, { id: newId(), user: env.userId, ts: now(), kind: o.kind, key: o.key, field: o.field, value: o.value });
      C.addChanges(log, [r]);
      outbox.push(log.changes[r.id]);
      stats.records++;
      saveOutbox();
      project(new Set([C.targetKey(o.kind, o.key)]), state());
      if (env.onConflicts) env.onConflicts(C.conflictCount(log));
      if (env.onRecorded) env.onRecorded('resolve');
      return true;
    }

    // Publishes, once per browser and shared project (`mark` in storage),
    // this user's own decisions not shared yet (non-default clash values,
    // issues, notes, viewpoints). A value that differs from a shared one is
    // published as a concurrent change — a conflict everyone sees.
    function seed(markKey) {
      var st = state(), ls = env.storage;
      if (!st) return false;
      var mark = env.projectKey + ':' + env.userId;
      try { if (ls && markKey && ls.getItem(markKey) === mark) return false; } catch (e) { /* no storage */ }
      var DEF = { status: ['open', 'auto_resolved'], priority: ['normal'], assignee: [''] };
      var before = outbox.length;
      function seedOne(kind, key, f, v, def) {
        var fs = C.fieldState(log, C.groupKey(kind, key, f));
        if (fs && (C.same(fs.value, v) || fs.conflicted)) return;
        var r = { id: newId(), user: env.userId, ts: now(), target: { kind: kind, key: key }, field: f, value: v, base: null, prev: def };
        C.addChanges(log, [r]);
        outbox.push(log.changes[r.id]);
      }
      (st.clashes || []).forEach(function(c) {
        var key = clashKey(c);
        if (!key) return;
        ['status', 'priority', 'assignee'].forEach(function(f) {
          var v = c[f];
          if (v == null || DEF[f].indexOf(v) !== -1) return;
          seedOne('clash', key, f, v, DEF[f][0]);
        });
      });
      (st.issues || []).forEach(function(it) {
        if (!it || !it.id || C.fieldState(log, C.groupKey('issue', it.id, 'created'))) return;
        seedOne('issue', it.id, 'created', C.issueRecord(it), null);
        (it.comments || []).forEach(function(cm) { if (cm && cm.id) seedOne('issue', it.id, 'comment:' + cm.id, clone(cm), null); });
      });
      (st.comments || []).forEach(function(nt) {
        if (!nt || !nt.id || C.fieldState(log, C.groupKey('note', nt.id, 'created'))) return;
        seedOne('note', nt.id, 'created', noteRecord(nt), null);
        (nt.replies || []).forEach(function(rp) { if (rp && rp.id) seedOne('note', nt.id, 'reply:' + rp.id, clone(rp), null); });
      });
      (st.viewpoints || []).forEach(function(vp) {
        if (!vp || !vp.id || !vp.camera || C.fieldState(log, C.groupKey('viewpoint', vp.id, 'created'))) return;
        seedOne('viewpoint', vp.id, 'created', vpRecord(vp, st), null);
      });
      try { if (ls && markKey) ls.setItem(markKey, mark); } catch (e) { /* no storage */ }
      if (outbox.length === before) return false;
      stats.records += outbox.length - before;
      saveOutbox();
      project(new Set(C.targets(log).map(function(t) { return C.targetKey(t[0], t[1]); })), st);
      if (env.onConflicts) env.onConflicts(C.conflictCount(log));
      if (env.onRecorded) env.onRecorded('seed');
      return true;
    }

    // ── The log → app state ──────────────────────────────────────────
    function who(r) { var nm = log.names[r.user]; return nm || i18n('sharedConflict.someone', 'a teammate'); }
    function markers(ts) {
      if (!ts.conflicts.length) return undefined;
      return ts.conflicts.map(function(st) {
        /** @type {any} */
        var m = { src: env.src, kind: st.kind, key: st.key, field: st.field,
          agreed: st.known ? { value: st.value === undefined ? null : st.value, user: st.agreed ? who(st.agreed) : null, ts: st.agreed ? st.agreed.ts : null } : null,
          heads: st.heads.map(function(h) { return { id: h.id, field: h.field, user: who(h), mine: h.user === env.userId, ts: h.ts, value: h.value }; }) };
        if (st.deleteConflict) m.deleteConflict = true;
        return m;
      });
    }
    function markerSig(m) { return m && m.length ? JSON.stringify(m.map(function(x) { return [x.src, x.field, x.agreed && x.agreed.value, x.heads.map(function(h) { return h.id + '@' + h.user; })]; })) : ''; }
    /** @returns {Map<string, any[]>} */
    function clashesByKey(st) {
      if (clashIndex.clashes === st.clashes) return clashIndex.map;
      var map = new Map();
      (st.clashes || []).forEach(function(c) {
        var k = clashKey(c);
        if (!k) return;
        var arr = map.get(k); if (arr) arr.push(c); else map.set(k, [c]);
      });
      clashIndex = { clashes: st.clashes, map: map };
      return map;
    }
    function mergeList(local, ts, prefix) {
      var byId = new Map(), changed = false;
      (local || []).forEach(function(x) { if (x && x.id) byId.set(x.id, x); });
      Object.keys(ts.fields).forEach(function(f) {
        if (f.indexOf(prefix) !== 0) return;
        var fs = ts.fields[f], id = f.slice(prefix.length);
        if (!fs.known) return;
        if (fs.value == null) { if (byId.has(id)) { byId.delete(id); changed = true; } return; }
        var cur = byId.get(id);
        if (!cur || !C.same(cur, fs.value)) { byId.set(id, fs.value); changed = true; }
      });
      if (!changed) return null;
      return Array.from(byId.values()).sort(function(a, b) { return (a.ts || 0) - (b.ts || 0); });
    }
    function isDeleted(ts) { var del = ts.fields.deleted; return !!(del && del.known && del.value === true); }
    // Puts the shared value of every field of the given targets (and their
    // conflict markers) on the local clashes / issues / notes / viewpoints.
    // Dispatches only what differs (all `_fromSync`). Returns the number of
    // dispatches.
    function project(tks, st) {
      if (!st || !tks || !tks.size) return 0;
      var F = C.DECISION_FIELDS, restore = {}, nRestore = 0, cnt = 0;
      var issues = new Map(); (st.issues || []).forEach(function(i) { issues.set(i.id, i); });
      var notes = new Map(); (st.comments || []).forEach(function(c) { notes.set(c.id, c); });
      var vps = new Map(); (st.viewpoints || []).forEach(function(v) { vps.set(v.id, v); });
      var byKey = clashesByKey(st);
      function dd(a) { d(a); cnt++; }
      tks.forEach(function(tk) {
        var i = tk.indexOf('\u0001'), kind = tk.slice(0, i), key = tk.slice(i + 1);
        var ts = C.targetState(log, kind, key), mk = markers(ts), sig = markerSig(mk);
        if (kind === 'clash') {
          (byKey.get(key) || []).forEach(function(c) {
            var patch = {}, any = false;
            F.forEach(function(f) {
              var fs = ts.fields[f];
              if (!fs || !fs.known) return;
              if (f === 'status' && c.status === 'auto_resolved') return; // the geometry says it is gone
              if (!C.same(c[f], fs.value)) { patch[f] = fs.value; any = true; }
            });
            if (markerSig(c._sharedConflict) !== sig) { patch._sharedConflict = mk; any = true; }
            if (any) { restore[c.id] = patch; nRestore++; }
          });
        } else if (kind === 'issue') {
          var cr = ts.fields.created, loc = issues.get(key);
          if (isDeleted(ts)) { if (loc) dd({ t: 'DEL_ISSUE', id: key, _fromSync: true }); return; }
          var patchI = {}, anyI = false;
          F.forEach(function(f) { var fs = ts.fields[f]; if (fs && fs.known && (!loc || !C.same(loc[f], fs.value))) { patchI[f] = fs.value; anyI = true; } });
          var cms = mergeList(loc ? loc.comments : [], ts, 'comment:');
          if (cms) { patchI.comments = cms; anyI = true; }
          if (!loc) {
            if (!cr || !cr.known || !cr.value) return;
            dd({ t: 'ADD_ISSUE', v: Object.assign({}, cr.value, patchI, { id: key, _sharedConflict: mk }), _fromSync: true });
            return;
          }
          if (markerSig(loc._sharedConflict) !== sig) { patchI._sharedConflict = mk; anyI = true; }
          if (anyI) dd({ t: 'UPD_ISSUE', id: key, u: patchI, _fromSync: true });
        } else if (kind === 'note') {
          var crN = ts.fields.created, ln = notes.get(key);
          if (isDeleted(ts)) { if (ln) dd({ t: 'DEL_COMMENT', id: key, _fromSync: true }); return; }
          var patchN = {}, anyN = false;
          NOTE_FIELDS.forEach(function(f) { var fs = ts.fields[f]; if (fs && fs.known && (!ln || !C.same(ln[f], fs.value))) { patchN[f] = fs.value; anyN = true; } });
          var reps = mergeList(ln ? ln.replies : [], ts, 'reply:');
          if (reps) { patchN.replies = reps; anyN = true; }
          if (!ln) {
            if (!crN || !crN.known || !crN.value) return;
            dd({ t: 'ADD_COMMENT', v: Object.assign({ replies: [] }, crN.value, patchN, { id: key, _sharedConflict: mk }), _fromSync: true });
            return;
          }
          if (markerSig(ln._sharedConflict) !== sig) { patchN._sharedConflict = mk; anyN = true; }
          if (anyN) dd({ t: 'UPD_COMMENT', id: key, u: patchN, _fromSync: true });
        } else if (kind === 'viewpoint') {
          var crV = ts.fields.created, lv = vps.get(key);
          if (isDeleted(ts)) { if (lv) dd({ t: 'DEL_VIEWPOINT', id: key, _fromSync: true }); return; }
          var patchV = {}, anyV = false;
          VIEWPOINT_FIELDS.forEach(function(f) { var fs = ts.fields[f]; if (fs && fs.known && (!lv || !C.same(lv[f], fs.value))) { patchV[f] = fs.value; anyV = true; } });
          if (!lv) {
            if (!crV || !crV.known || !crV.value) return;
            var v = Object.assign({}, crV.value);
            if (v.linkedClash) { var lc = (byKey.get(v.linkedClash) || [])[0]; v.linkedId = lc ? lc.id : null; delete v.linkedClash; }
            dd({ t: 'ADD_VIEWPOINT', v: Object.assign(v, patchV, { id: key, _sharedConflict: mk }), _fromSync: true });
            return;
          }
          if (markerSig(lv._sharedConflict) !== sig) { patchV._sharedConflict = mk; anyV = true; }
          if (anyV) dd({ t: 'UPD_VIEWPOINT', id: key, u: patchV, _fromSync: true });
        }
      });
      if (nRestore) dd({ t: 'CLASH_BATCH_RESTORE', prev: restore, keepIssueIds: null, _fromSync: true });
      stats.projected += cnt;
      return cnt;
    }
    // Teammates' changes in the History of each clash / issue.
    function history(recs, st) {
      if (!st) return;
      var byKey = clashesByKey(st), out = [];
      recs.forEach(function(r) {
        if (r.user === env.userId || r.target.kind === 'viewpoint') return;
        var targetId = r.target.kind === 'clash' ? ((byKey.get(r.target.key) || [])[0] || {}).id : r.target.key;
        if (!targetId) return;
        out.push({ id: r.id, ts: r.ts, user: who(r), type: r.target.kind === 'clash' ? 'clash_update' : (r.field === 'created' ? 'issue_created' : r.field === 'deleted' ? (r.value === true ? 'issue_deleted' : 'issue_update') : 'issue_update'),
          targetId: targetId, field: r.field, value: (r.value && typeof r.value === 'object') ? (r.value.title || r.value.text || r.value.name || '') : r.value });
      });
      if (out.length) d({ t: 'MERGE_CHANGELOG', v: out });
    }
    function allOf(kind) {
      var out = [];
      C.targets(log).forEach(function(t) { if (t[0] === kind) out.push(C.targetKey(t[0], t[1])); });
      return out;
    }

    // ── Transport side ───────────────────────────────────────────────
    // Records the transport read (a file, a pull). Malformed ones are dropped
    // by the core. Returns the newly added records and the targets touched.
    function ingest(recs, names) {
      var add = C.addChanges(log, recs || []);
      if (names) C.addNames(log, names);
      (recs || []).forEach(function(r) { if (r && typeof r.id === 'string') written[r.id] = true; });
      return { added: add.added.map(function(id) { return log.changes[id]; }), touched: add.touched };
    }
    // After reading: apply what changed (and everything of a kind whose local
    // array was replaced — a detection run, a project load). Nothing new →
    // no dispatch.
    function sync(o) {
      o = o || {};
      var st = state(), touched = new Set(o.touched || []);
      if (o.full) C.targets(log).forEach(function(t) { touched.add(C.targetKey(t[0], t[1])); });
      if (st) {
        if (st.clashes !== last.clashes) { allOf('clash').forEach(function(t) { touched.add(t); }); last.clashes = st.clashes; }
        if (st.issues !== last.issues) { allOf('issue').forEach(function(t) { touched.add(t); }); last.issues = st.issues; }
        if (st.comments !== last.comments) { allOf('note').forEach(function(t) { touched.add(t); }); last.comments = st.comments; }
        if (st.viewpoints !== last.viewpoints) { allOf('viewpoint').forEach(function(t) { touched.add(t); }); last.viewpoints = st.viewpoints; }
      }
      var projected = touched.size ? project(touched, st) : 0;
      if (o.remote && o.remote.length) history(o.remote, st);
      if ((projected || (o.remote && o.remote.length)) && env.onConflicts) env.onConflicts(C.conflictCount(log));
      return projected;
    }
    // Pending own records to store, marked as being written (no amending).
    function takeBatch(max) {
      var out = [];
      for (var i = 0; i < outbox.length && (!max || out.length < max); i++) {
        if (inflight[outbox[i].id]) continue;
        inflight[outbox[i].id] = true;
        out.push(outbox[i]);
      }
      return out;
    }
    function done(batch) {
      var ids = Object.create(null);
      (batch || []).forEach(function(r) { ids[r.id] = true; written[r.id] = true; delete inflight[r.id]; });
      outbox = outbox.filter(function(r) { return !ids[r.id]; });
      saveOutbox();
    }
    function release(batch) { (batch || []).forEach(function(r) { delete inflight[r.id]; }); }
    function clearMarkers() {
      var st = state();
      if (!st) return;
      var restore = {}, any = false;
      function mine(m) { return m && m.some(function(x) { return x.src === env.src || !x.src; }); }
      (st.clashes || []).forEach(function(c) { if (mine(c._sharedConflict)) { restore[c.id] = { _sharedConflict: undefined }; any = true; } });
      if (any) d({ t: 'CLASH_BATCH_RESTORE', prev: restore, keepIssueIds: null, _fromSync: true });
      (st.issues || []).forEach(function(i) { if (mine(i._sharedConflict)) d({ t: 'UPD_ISSUE', id: i.id, u: { _sharedConflict: undefined }, _fromSync: true }); });
      (st.comments || []).forEach(function(c) { if (mine(c._sharedConflict)) d({ t: 'UPD_COMMENT', id: c.id, u: { _sharedConflict: undefined }, _fromSync: true }); });
      (st.viewpoints || []).forEach(function(v) { if (mine(v._sharedConflict)) d({ t: 'UPD_VIEWPOINT', id: v.id, u: { _sharedConflict: undefined }, _fromSync: true }); });
    }

    return {
      src: env.src, userId: env.userId, writer: env.writer, projectKey: env.projectKey,
      log: log, stats: stats,
      note: note, observe: observe, resolve: resolve, seed: seed,
      ingest: ingest, sync: sync, project: project,
      takeBatch: takeBatch, done: done, release: release,
      pending: function() { return outbox.length; },
      outbox: function() { return outbox.slice(); },
      saveOutbox: saveOutbox, adoptOutboxes: adoptOutboxes,
      markWritten: function(ids) { (ids || []).forEach(function(id) { written[id] = true; }); },
      conflictCount: function() { return C.conflictCount(log); },
      clearMarkers: clearMarkers
    };
  }

  // ── Active sessions (the folder and / or the cloud project) ─────────
  // The core's dispatch wrapper and the conflict UI talk to these, never to
  // a transport directly.
  var sessions = [];
  /** @param {any} s */
  function register(s) { if (s && sessions.indexOf(s) === -1) sessions.push(s); return s; }
  /** @param {any} s */
  function unregister(s) { var i = sessions.indexOf(s); if (i !== -1) sessions.splice(i, 1); }
  /** @param {any} a @param {any} prev @param {any} batchIds */
  function noteAll(a, prev, batchIds) { sessions.slice().forEach(function(s) { try { s.note(a, prev, batchIds); } catch (e) { if (typeof console !== 'undefined') console.warn('[shared] note failed:', e); } }); }
  /** @param {any} st */
  function observeAll(st) { sessions.slice().forEach(function(s) { try { s.observe(st); } catch (e) { /* next observe retries */ } }); }
  // Routed to the session whose log the marker came from (`src`).
  /** @param {{src?:string, kind:string, key:string, field:string, value:any}} o */
  function resolveAny(o) {
    var hit = false;
    sessions.forEach(function(s) { if (!hit && (!o.src || o.src === s.src)) hit = s.resolve(o); });
    return hit;
  }

  // ── One sharing mode at a time ────────────────────────────────────
  // The folder and the project key each keep their own log; with both
  // linked, one log's values and conflict markers would overwrite the
  // other's on the same item, and a teammate on only one of them never
  // sees the other's decisions. So a transport claims the link before it
  // starts (the folder before it touches the folder, the cloud before its
  // first pull) and a claim held by the other mode is refused — the UI
  // says which mode is linked and how to leave it.
  /** @type {{src:string, label:string}|null} */
  var holder = null;
  /** @param {string} src @param {string} [label] @returns {{src:string, label:string}|null} the other mode's claim, or null when the link is ours */
  function claimLink(src, label) {
    if (holder && holder.src !== src) return { src: holder.src, label: holder.label };
    holder = { src: src, label: label || '' };
    return null;
  }
  /** @param {string} src */
  function releaseLink(src) { if (holder && holder.src === src) holder = null; }
  function linkHolder() { return holder ? { src: holder.src, label: holder.label } : null; }

  return Object.freeze({
    contractVersion: 1,
    NOTE_FIELDS: NOTE_FIELDS,
    VIEWPOINT_FIELDS: VIEWPOINT_FIELDS,
    createSession: createSession,
    register: register,
    unregister: unregister,
    sessions: function() { return sessions.slice(); },
    noteAll: noteAll,
    observeAll: observeAll,
    resolve: resolveAny,
    claimLink: claimLink,
    releaseLink: releaseLink,
    linkHolder: linkHolder
  });
}));
