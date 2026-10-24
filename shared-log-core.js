// @ts-check
// Shared-folder change log (docs/INTERNALS.md §21.55). Pure logic only — the
// File System Access I/O lives in addons/shared-project.js.
//
// A shared project is a folder. Every user writes only NEW, small files of
// their own (changes/<userId>/<writer>-<seq>.json, never rewritten), each a
// batch of change records:
//   {id, user, ts, target:{kind, key}, field, value, base, resolves?, prev?, resolution?}
// `base` is the id of the change to this (target, field) the author had
// applied when editing (null if none); a resolution lists every head it
// resolves in `resolves`. `prev` (only when base is null) is the value the
// author saw before the first shared change.
//
// Conflict rule — never time-based: per (target, field) the HEADS are the
// changes no other change builds on (via base or resolves). One head → its
// value applies. Several heads with different values → CONFLICT, whether they
// were made seconds or days apart; the field keeps the last agreed value (the
// newest common ancestor) for everyone until someone resolves it. A change
// made after seeing another is an ordinary update, however soon after.
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccSharedLogCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var FORMAT = 1;
  // Team decisions shared per clash / issue (same set as api/project.js).
  var DECISION_FIELDS = ['status', 'priority', 'assignee', 'title', 'description', 'category', 'dueDate'];
  var SEP = '\u0001';

  /** @param {string} kind @param {string} key */
  function targetKey(kind, key) { return kind + SEP + key; }
  /** @param {string} kind @param {string} key @param {string} field */
  function groupKey(kind, key, field) { return kind + SEP + key + SEP + field; }
  /** @param {string} gk */
  function splitGroupKey(gk) { var p = gk.split(SEP); return { kind: p[0], key: p[1], field: p.slice(2).join(SEP) }; }

  // JSON-equality for the small decision values (strings, null, comment objects).
  function same(a, b) {
    if (a === b) return true;
    if (a === undefined) a = null;
    if (b === undefined) b = null;
    return JSON.stringify(a) === JSON.stringify(b);
  }
  /** @param {{ts:number,id:string}} a @param {{ts:number,id:string}} b */
  function byTsId(a, b) { return (a.ts - b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

  // ── Records ─────────────────────────────────────────────────────────
  // A record read from a file is untrusted data: anything malformed is
  // dropped (never thrown on), unknown keys are not carried.
  /** @param {any} r */
  function normaliseChange(r) {
    if (!r || typeof r !== 'object') return null;
    if (typeof r.id !== 'string' || !r.id || r.id.length > 200) return null;
    if (typeof r.user !== 'string' || r.user.length > 120) return null;
    var ts = Number(r.ts);
    if (!isFinite(ts)) return null;
    var t = r.target;
    if (!t || typeof t.kind !== 'string' || !t.kind || typeof t.key !== 'string' || !t.key) return null;
    if (typeof r.field !== 'string' || !r.field) return null;
    if (r.base != null && typeof r.base !== 'string') return null;
    /** @type {any} */
    var out = { id: r.id, user: r.user, ts: ts, target: { kind: t.kind, key: t.key }, field: r.field,
      value: r.value === undefined ? null : r.value, base: r.base || null };
    if (Array.isArray(r.resolves)) {
      var rs = r.resolves.filter(function(x) { return typeof x === 'string' && x; });
      if (rs.length) out.resolves = rs;
    }
    if (out.base == null && r.prev !== undefined) out.prev = r.prev;
    if (r.resolution === true) out.resolution = true;
    return out;
  }

  // ── The log (one per shared project, owned by its client) ───────────
  // changes: id → record; groups: (target, field) → ids; targets: target →
  // {field: true}; names: userId → display name. addChanges mutates the log
  // (the addon keeps exactly one) and is idempotent by id.
  function createLog() {
    return { changes: Object.create(null), groups: Object.create(null), targets: Object.create(null), names: Object.create(null), size: 0 };
  }
  /**
   * @param {any} log @param {any[]} recs
   * @returns {{added:string[], touched:string[]}} touched = target keys
   */
  function addChanges(log, recs) {
    var added = [], touched = [], seenT = Object.create(null);
    (recs || []).forEach(function(raw) {
      var r = normaliseChange(raw);
      if (!r || log.changes[r.id]) return;
      log.changes[r.id] = r;
      log.size++;
      var gk = groupKey(r.target.kind, r.target.key, r.field);
      (log.groups[gk] || (log.groups[gk] = [])).push(r.id);
      var tk = targetKey(r.target.kind, r.target.key);
      (log.targets[tk] || (log.targets[tk] = Object.create(null)))[r.field] = true;
      added.push(r.id);
      if (!seenT[tk]) { seenT[tk] = true; touched.push(tk); }
    });
    return { added: added, touched: touched };
  }
  /** @param {any} log @param {Object<string,string>} names */
  function addNames(log, names) {
    Object.keys(names || {}).forEach(function(u) {
      var n = names[u];
      if (typeof n === 'string' && n.length <= 120) log.names[u] = n;
    });
  }

  // Ids a record builds on (base + resolves).
  function parents(r) { return r.resolves ? (r.base ? [r.base].concat(r.resolves) : r.resolves.slice()) : (r.base ? [r.base] : []); }

  // The heads of one (target, field): the changes nothing builds on. A
  // reference to a change this client has not read yet still counts — the
  // referenced change can never be a head once it arrives.
  /** @param {any} log @param {string} gk */
  function headsOf(log, gk) {
    var ids = log.groups[gk];
    if (!ids || !ids.length) return [];
    var sup = Object.create(null);
    ids.forEach(function(id) { parents(log.changes[id]).forEach(function(p) { sup[p] = true; }); });
    return ids.filter(function(id) { return !sup[id]; }).map(function(id) { return log.changes[id]; }).sort(byTsId);
  }
  // Every change reachable through base/resolves (missing ones included as
  // ids, not expanded).
  /** @param {any} log @param {string} id */
  function ancestors(log, id) {
    var out = Object.create(null), stack = parents(log.changes[id] || {});
    while (stack.length) {
      var p = stack.pop();
      if (out[p]) continue;
      out[p] = true;
      var r = log.changes[p];
      if (r) stack.push.apply(stack, parents(r));
    }
    return out;
  }
  // The last agreed version below a set of competing changes: the newest
  // common ancestor(s). When several maximal common ancestors disagree among
  // themselves (two concurrent resolutions of one conflict), go further down
  // until they agree; with none at all, the value the earliest author saw
  // before any shared change (`prev`), else unknown.
  /** @param {any} log @param {string[]} ids @param {number} [depth] @returns {{rec:any, value:any, known:boolean}} */
  function agreedBelow(log, ids, depth) {
    depth = depth || 0;
    var sets = ids.map(function(id) { return ancestors(log, id); });
    var common = Object.keys(sets[0]).filter(function(a) { return log.changes[a] && sets.every(function(s) { return s[a]; }); });
    if (!common.length || depth > 32) {
      // roots of everything involved: their prev is the pre-share value
      var seen = Object.create(null), roots = [];
      ids.forEach(function(id) {
        var all = ancestors(log, id); all[id] = true;
        Object.keys(all).forEach(function(a) { var r = log.changes[a]; if (r && !seen[a]) { seen[a] = true; if (!r.base && !r.resolves) roots.push(r); } });
      });
      roots.sort(byTsId);
      for (var i = 0; i < roots.length; i++) if (roots[i].prev !== undefined) return { rec: null, value: roots[i].prev, known: true };
      return { rec: null, value: null, known: false };
    }
    var inCommon = Object.create(null);
    common.forEach(function(a) { inCommon[a] = true; });
    // maximal = not an ancestor of another common ancestor
    var below = Object.create(null);
    common.forEach(function(a) { var an = ancestors(log, a); Object.keys(an).forEach(function(x) { if (inCommon[x]) below[x] = true; }); });
    var max = common.filter(function(a) { return !below[a]; }).map(function(a) { return log.changes[a]; }).sort(byTsId);
    if (max.length === 1 || max.every(function(r) { return same(r.value, max[0].value); })) {
      var last = max[max.length - 1];
      return { rec: last, value: last.value, known: true };
    }
    return agreedBelow(log, max.map(function(r) { return r.id; }), depth + 1);
  }

  // State of one (target, field):
  //   {kind, key, field, heads, conflicted, value, known, agreed}
  // value/known: what the field shows (the head's value, or the agreed
  // value while conflicted; known=false → no shared value, keep the local one).
  /** @param {any} log @param {string} gk */
  function fieldState(log, gk) {
    var heads = headsOf(log, gk);
    if (!heads.length) return null;
    var g = splitGroupKey(gk);
    var last = heads[heads.length - 1];
    var agreeing = heads.every(function(h) { return same(h.value, last.value); });
    if (agreeing) return { kind: g.kind, key: g.key, field: g.field, heads: heads, conflicted: false, value: last.value, known: true, agreed: null };
    var ag = agreedBelow(log, heads.map(function(h) { return h.id; }));
    return { kind: g.kind, key: g.key, field: g.field, heads: heads, conflicted: true, value: ag.value, known: ag.known, agreed: ag.rec };
  }
  /** @param {any} log @param {string} kind @param {string} key */
  function targetState(log, kind, key) {
    var fields = log.targets[targetKey(kind, key)];
    /** @type {{kind:string, key:string, fields:any, conflicts:any[]}} */
    var out = { kind: kind, key: key, fields: Object.create(null), conflicts: [] };
    if (!fields) return out;
    Object.keys(fields).sort().forEach(function(f) {
      var st = fieldState(log, groupKey(kind, key, f));
      if (!st) return;
      out.fields[f] = st;
      if (st.conflicted) out.conflicts.push(st);
    });
    return out;
  }
  // Every target with at least one change, as [kind, key].
  /** @param {any} log */
  function targets(log) { return Object.keys(log.targets).map(function(tk) { var p = tk.split(SEP); return [p[0], p.slice(1).join(SEP)]; }); }
  /** @param {any} log */
  function conflictCount(log) {
    var n = 0;
    Object.keys(log.groups).forEach(function(gk) { var st = fieldState(log, gk); if (st && st.conflicted) n++; });
    return n;
  }

  // ── New changes ─────────────────────────────────────────────────────
  // An ordinary edit builds on what the author sees: the head when the field
  // agrees (several agreeing heads are all folded in), the agreed version
  // while it is conflicted (so editing a conflicted field through the normal
  // controls joins the conflict — only a resolution clears it).
  /**
   * @param {any} log
   * @param {{id:string, user:string, ts:number, kind:string, key:string, field:string, value:any, prev?:any}} o
   */
  function makeChange(log, o) {
    var st = fieldState(log, groupKey(o.kind, o.key, o.field));
    /** @type {any} */
    var r = { id: o.id, user: o.user, ts: o.ts, target: { kind: o.kind, key: o.key }, field: o.field, value: o.value === undefined ? null : o.value, base: null };
    if (!st) {
      if (o.prev !== undefined) r.prev = o.prev;
    } else if (st.conflicted) {
      r.base = st.agreed ? st.agreed.id : null;
      if (!r.base && st.known) r.prev = st.value;
    } else {
      var hs = st.heads;
      r.base = hs[hs.length - 1].id;
      if (hs.length > 1) r.resolves = hs.slice(0, -1).map(function(h) { return h.id; });
    }
    return r;
  }
  // A resolution: picks one competing value or a new one and builds on every
  // current head, which clears the conflict for everyone who reads it.
  /** @param {any} log @param {{id:string, user:string, ts:number, kind:string, key:string, field:string, value:any}} o */
  function makeResolution(log, o) {
    var st = fieldState(log, groupKey(o.kind, o.key, o.field));
    /** @type {any} */
    var r = { id: o.id, user: o.user, ts: o.ts, target: { kind: o.kind, key: o.key }, field: o.field, value: o.value === undefined ? null : o.value, base: null, resolution: true };
    if (!st) return r;
    r.base = st.agreed ? st.agreed.id : null;
    r.resolves = st.heads.map(function(h) { return h.id; }).filter(function(id) { return id !== r.base; });
    if (!r.resolves.length) delete r.resolves;
    if (!r.base && st.known) r.prev = st.value;
    return r;
  }

  // Canonical digest of the applied state + conflicts (tests: two clients that
  // read the same changes must agree exactly).
  /** @param {any} log */
  function digest(log) {
    return Object.keys(log.groups).sort().map(function(gk) {
      var st = /** @type {any} */ (fieldState(log, gk));
      return [gk.split(SEP).join('|'), st.conflicted ? 'C' : '=', JSON.stringify(st.value === undefined ? null : st.value), st.known ? 1 : 0,
        st.heads.map(function(h) { return h.id; }).join(',')].join(' ');
    }).join('\n');
  }

  // ── Files ───────────────────────────────────────────────────────────
  /** @param {number} n @param {number} w */
  function pad(n, w) { var s = String(Math.max(0, Math.floor(n))); while (s.length < w) s = '0' + s; return s; }
  // userId / writer ids are random [a-z0-9] — safe as file and folder names.
  /** @param {string} id */
  function safeId(id) { return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{2,63}$/.test(id); }
  /** @param {string} writer @param {number} seq */
  function changeFileName(writer, seq) { return writer + '-' + pad(seq, 6) + '.json'; }
  /**
   * @param {{user:string, name?:string, writer:string, seq:number, ts:number}} meta @param {any[]} recs
   */
  function changeFile(meta, recs) {
    var names = {}; names[meta.user] = meta.name || '';
    return { _cc: 'ClashControl.sharedChanges', v: FORMAT, user: meta.user, writer: meta.writer, seq: meta.seq, ts: meta.ts, names: names, changes: recs };
  }
  /** @param {any} obj */
  function parseChangeFile(obj) {
    if (!obj || obj._cc !== 'ClashControl.sharedChanges' || !Array.isArray(obj.changes)) return null;
    return { changes: obj.changes.map(normaliseChange).filter(Boolean), names: (obj.names && typeof obj.names === 'object') ? obj.names : {} };
  }

  // A snapshot carries every change it covers (full records), so a change
  // made later on ANY older version — by a client that was offline for a
  // month — is still placed correctly, plus the open conflicts and which
  // change files / older snapshots it covers. Merging is a union by change
  // id, so reading a snapshot and the files it covers in any order, any
  // number of times, gives the same log.
  /** @param {string} by @param {number} ts */
  function snapshotName(by, ts) { return 'snapshot-' + pad(ts, 14) + '-' + by + '.json'; }
  /** @param {string} name */
  function parseSnapshotName(name) {
    var m = /^snapshot-(\d{14})-([a-z0-9-]+)\.json$/.exec(name || '');
    return m ? { ts: Number(m[1]), by: m[2] } : null;
  }
  /**
   * @param {any} log
   * @param {{by:string, ts:number, files?:string[], snapshots?:string[]}} meta
   */
  function buildSnapshot(log, meta) {
    var changes = Object.keys(log.changes).map(function(id) { return log.changes[id]; }).sort(byTsId);
    var conflicts = [];
    Object.keys(log.groups).sort().forEach(function(gk) {
      var st = fieldState(log, gk);
      if (st && st.conflicted) conflicts.push({ target: { kind: st.kind, key: st.key }, field: st.field, agreed: st.agreed ? st.agreed.id : null, heads: st.heads.map(function(h) { return h.id; }) });
    });
    var names = {};
    Object.keys(log.names).sort().forEach(function(u) { names[u] = log.names[u]; });
    return { _cc: 'ClashControl.sharedSnapshot', v: FORMAT, by: meta.by, ts: meta.ts, names: names,
      files: (meta.files || []).slice().sort(), snapshots: (meta.snapshots || []).slice().sort(),
      conflicts: conflicts, changes: changes };
  }
  /** @param {any} obj */
  function parseSnapshot(obj) {
    if (!obj || obj._cc !== 'ClashControl.sharedSnapshot' || !Array.isArray(obj.changes)) return null;
    function names(a) { return Array.isArray(a) ? a.filter(function(x) { return typeof x === 'string'; }) : []; }
    return { by: String(obj.by || ''), ts: Number(obj.ts) || 0, names: (obj.names && typeof obj.names === 'object') ? obj.names : {},
      files: names(obj.files), snapshots: names(obj.snapshots), changes: obj.changes.map(normaliseChange).filter(Boolean) };
  }

  // What may be deleted now. Only a snapshot's own author removes what it
  // covers, and only once the snapshot is older than the grace period (time
  // for cloud sync to deliver it everywhere). Covered change files and older
  // snapshots only: their every change is inside the covering snapshot, so a
  // client that never read them gets the same log from the snapshot. A file
  // or snapshot that is not covered is never returned.
  /**
   * @param {{me:string, now:number, graceMs:number,
   *   snapshots:{name:string, by:string, ts:number, files:string[], snapshots:string[]}[],
   *   presentFiles:string[], presentSnapshots:string[]}} o
   */
  function planCleanup(o) {
    var files = Object.create(null), snaps = Object.create(null);
    var presentF = Object.create(null), presentS = Object.create(null);
    (o.presentFiles || []).forEach(function(n) { presentF[n] = true; });
    (o.presentSnapshots || []).forEach(function(n) { presentS[n] = true; });
    (o.snapshots || []).forEach(function(s) {
      if (s.by !== o.me || !(o.now - s.ts >= o.graceMs) || !presentS[s.name]) return;
      (s.files || []).forEach(function(f) { if (presentF[f]) files[f] = true; });
      (s.snapshots || []).forEach(function(n) { if (n !== s.name && presentS[n]) snaps[n] = true; });
    });
    return { files: Object.keys(files).sort(), snapshots: Object.keys(snaps).sort() };
  }

  // ── Issues ──────────────────────────────────────────────────────────
  // The record an issue is created with: its own fields, without local
  // bookkeeping (_*), comments (shared one by one) and heavy or per-user
  // data (pictures, training signals).
  var ISSUE_DROP = { comments: 1, aiSignals: 1, snapshot: 1, snapshots: 1, viewpoint: 1, viewpoints: 1, markup: 1, markups: 1, image: 1, images: 1, attachments: 1 };
  /** @param {any} issue */
  function issueRecord(issue) {
    var out = {};
    Object.keys(issue || {}).forEach(function(k) {
      if (k.charAt(0) === '_' || ISSUE_DROP[k]) return;
      var v = issue[k];
      if (v === undefined || typeof v === 'function') return;
      if (typeof v === 'string' && v.length > 4000) return;
      if (typeof v === 'string' && /^data:/.test(v)) return;
      out[k] = v;
    });
    return JSON.parse(JSON.stringify(out));
  }

  // ── Migration from a single .ccproject file ─────────────────────────
  // Read once into an initial snapshot; the old file is left untouched. Ids
  // and the snapshot name derive from the file's content, so two clients
  // migrating the same file at once write the same records (a duplicate copy
  // made by a sync client is merged by id). Decisions only: non-default
  // clash status / priority / assignee, issues (created + comments), notes.
  /** @param {string} text */
  function hash32(text) {
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  /**
   * @param {any} data parsed .ccproject
   * @param {string} text its file text (for the deterministic ids)
   * @param {{identityKey:(c:any)=>string}} opts
   */
  function migrateProject(data, text, opts) {
    if (!data || data._cc !== 'ClashControl') return null;
    var h = hash32(String(text || ''));
    var ts = Date.parse(data.savedAt || '') || 0;
    var user = 'legacy-' + h, n = 0, recs = [];
    function add(kind, key, field, value, prev) {
      /** @type {any} */
      var r = { id: 'm-' + h + '-' + (n++), user: user, ts: ts, target: { kind: kind, key: String(key) }, field: field, value: value, base: null };
      if (prev !== undefined) r.prev = prev;
      recs.push(r);
    }
    (data.clashes || []).forEach(function(c) {
      if (!c || typeof c !== 'object') return;
      var key = c._identityKey || (opts && opts.identityKey ? opts.identityKey(c) : null);
      if (!key) return;
      if (c.status && c.status !== 'open' && c.status !== 'auto_resolved') add('clash', key, 'status', c.status, 'open');
      if (c.priority && c.priority !== 'normal') add('clash', key, 'priority', c.priority, 'normal');
      if (c.assignee) add('clash', key, 'assignee', c.assignee, '');
    });
    (data.issues || []).forEach(function(it) {
      if (!it || !it.id) return;
      add('issue', it.id, 'created', issueRecord(it));
      (it.comments || []).forEach(function(cm) { if (cm && cm.id) add('issue', it.id, 'comment:' + cm.id, JSON.parse(JSON.stringify(cm))); });
    });
    (data.comments || []).forEach(function(nt) {
      if (!nt || !nt.id) return;
      add('note', nt.id, 'created', JSON.parse(JSON.stringify(Object.assign({}, nt, { replies: undefined }))));
      (nt.replies || []).forEach(function(rp) { if (rp && rp.id) add('note', nt.id, 'reply:' + rp.id, JSON.parse(JSON.stringify(rp))); });
    });
    var log = createLog();
    addChanges(log, recs);
    /** @type {Object<string,string>} */
    var names = {}; names[user] = 'project file';
    addNames(log, names);
    var snap = buildSnapshot(log, { by: user, ts: ts, files: [], snapshots: [] });
    return { name: 'snapshot-' + pad(ts, 14) + '-' + user + '.json', snapshot: snap, changes: recs.length };
  }

  return Object.freeze({
    contractVersion: 1,
    FORMAT: FORMAT,
    DECISION_FIELDS: DECISION_FIELDS,
    targetKey: targetKey,
    groupKey: groupKey,
    splitGroupKey: splitGroupKey,
    same: same,
    normaliseChange: normaliseChange,
    createLog: createLog,
    addChanges: addChanges,
    addNames: addNames,
    headsOf: headsOf,
    fieldState: fieldState,
    targetState: targetState,
    targets: targets,
    conflictCount: conflictCount,
    makeChange: makeChange,
    makeResolution: makeResolution,
    digest: digest,
    safeId: safeId,
    changeFileName: changeFileName,
    changeFile: changeFile,
    parseChangeFile: parseChangeFile,
    snapshotName: snapshotName,
    parseSnapshotName: parseSnapshotName,
    buildSnapshot: buildSnapshot,
    parseSnapshot: parseSnapshot,
    planCleanup: planCleanup,
    issueRecord: issueRecord,
    hash32: hash32,
    migrateProject: migrateProject
  });
}));
