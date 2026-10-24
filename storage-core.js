// @ts-check
(function(/** @type {any} */ root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccStorageCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  // ── Storage registry ──────────────────────────────────────────────
  // Every persistent store the app owns, pinned with an explicit retention
  // class. Retention drives eviction ordering (planEviction / planLocalPrune):
  //   'source'   — user data we cannot recompute (IFC bytes, decisions).
  //                Never auto-deleted; eviction is a user-confirmed proposal.
  //   'derived'  — recomputable from source (geo cache, element hashes,
  //                memos). Free to GC under pressure; cold path re-creates it.
  //   'decay'    — bounded history whose old tail loses value (training
  //                buffers, chat, run profiles). Pruned oldest-first.
  //   'prefs'    — tiny settings. Never pruned automatically.
  // Scope 'per-project'/'per-modelset' keys are prunable when their owning
  // entity no longer exists (orphans). tests/storage-registry-wiring.test.js
  // fails when a new cc_* key or IDB store is added without a row here.
  var IDB_REGISTRY = [
    { store: 'ifcFiles', db: 'ClashControlFiles', retention: 'source',  scope: 'per-project' },
    { store: 'projects', db: 'ClashControlFiles', retention: 'source',  scope: 'per-project' },
    { store: 'geoCache', db: 'ClashControlFiles', retention: 'derived', scope: 'per-file' },
    // One-shot file handoff between / and /tour — written by one page,
    // consumed and cleared by the next load.
    { store: 'pending',  db: 'cc-handoff', retention: 'decay', scope: 'global' },
    // shared-project's persisted FileSystem directory handle.
    { store: 'handles',  db: 'cc_shared', retention: 'source', scope: 'global' },
    // shared-project's local copy of the shared folder's change log (records
    // and the file names already read, per shared project): the folder stays
    // the source, so a lost cache only means one full read.
    { store: 'log',      db: 'cc_shared', retention: 'derived', scope: 'per-project' },
    { store: 'seen',     db: 'cc_shared', retention: 'derived', scope: 'per-project' },
    // Clash viewpoint snapshots (overview cards, BCF snapshot.png, PDF
    // report): re-rendered from the loaded geometry on demand, keyed by clash
    // identity + element geometry hashes, budgeted by planSnapshotGC.
    { store: 'snapshots', db: 'cc-snapshots', retention: 'derived', scope: 'per-project' }
  ];

  var LS_REGISTRY = [
    // family: label used in reports; match: exact key or prefix.
    { family: 'ui-prefs', retention: 'prefs', scope: 'global', owner: 'core', prefix: 'cc_', catchAllPrefs: true },
    { family: 'projects-index', retention: 'source', scope: 'global', owner: 'core', keys: ['cc_projects', 'cc_activeProject'] },
    { family: 'clash-config', retention: 'source', scope: 'global', owner: 'core',
      keys: ['cc_clash_presets', 'cc_smartViews', 'cc_defaultTolerances', 'cc_standard_default_clearance',
             'cc_standard_pair_rules', 'cc_standard_type_pair_rules', 'cc_hiddenClasses'] },
    { family: 'clash-decisions', retention: 'source', scope: 'global', owner: 'core', keys: ['cc_denied_clashes'] },
    { family: 'training', retention: 'decay', scope: 'global', owner: 'training-data',
      keys: ['cc_clash_training_data', 'cc_nl_training_data', 'cc_trainingFeedback', 'cc_detection_runs',
             'cc_trainingMode', 'cc_data_consent', 'cc_data_consent_explicit', 'cc_consent_banner_seen'] },
    { family: 'chat', retention: 'decay', scope: 'per-project', owner: 'core', prefix: 'cc_chat_msgs_' },
    { family: 'detection-feedback', retention: 'decay', scope: 'per-project', owner: 'smart-bridge', prefix: 'cc_detection_feedback:' },
    { family: 'type-pair-memo', retention: 'derived', scope: 'per-modelset', owner: 'core', prefix: 'cc_typePairMemo:' },
    { family: 'revit-bridge', retention: 'derived', scope: 'global', owner: 'revit-bridge',
      keys: ['cc_element_hashes', 'cc_revit_excluded', 'cc_revit_bridge', 'cc_revit_direct_port'] },
    { family: 'align', retention: 'source', scope: 'per-target', owner: 'align', prefix: 'cc_align_' },
    { family: 'shared-project', retention: 'source', scope: 'global', owner: 'shared-project',
      keys: ['cc_sharedProjectId', 'cc_sharedProjectName', 'cc_sharedProjectEditKey', 'cc_username'] },
    { family: 'walk', retention: 'prefs', scope: 'global', owner: 'core',
      keys: ['cc_walkBookmarks', 'cc_walkViewpoints', 'cc_walkBob', 'cc_walkCollision', 'cc_walkFoot',
             'cc_walkFov', 'cc_walkHeight', 'cc_walkInvY', 'cc_walkSens'] },
    // Occlusion culling's per-device verdict (GPU + build -> verified/refused);
    // recomputable by re-running the offscreen check, so derived.
    { family: 'viewer-device', retention: 'derived', scope: 'global', owner: 'core', keys: ['cc_occlusion_verdict'] },
    { family: 'integrations', retention: 'prefs', scope: 'global', owner: 'addons',
      keys: ['cc_addons_active', 'cc_tiles', 'cc_google_tiles_key', 'cc_cesium_ion_token', 'cc_local_engine',
             'cc_local_engine_seen', 'cc_smart_bridge', 'cc_sb_downloaded', 'cc_geo_nudge_step', 'cc_brand_logo'] }
  ];

  function classifyKey(key) {
    var i, fam, k;
    // Exact keys first, then longest-prefix; the bare 'cc_' catch-all
    // (ui-prefs via _ccPersistUI/_ccLoadPref) matches last so specific
    // families always win.
    for (i = 0; i < LS_REGISTRY.length; i++) {
      fam = LS_REGISTRY[i];
      if (fam.keys) {
        for (k = 0; k < fam.keys.length; k++) if (fam.keys[k] === key) return fam;
      }
    }
    var best = null;
    for (i = 0; i < LS_REGISTRY.length; i++) {
      fam = LS_REGISTRY[i];
      if (fam.prefix && key.indexOf(fam.prefix) === 0 && !fam.catchAllPrefs) {
        if (!best || fam.prefix.length > best.prefix.length) best = fam;
      }
    }
    if (best) return best;
    for (i = 0; i < LS_REGISTRY.length; i++) {
      fam = LS_REGISTRY[i];
      if (fam.catchAllPrefs && key.indexOf(fam.prefix) === 0) return fam;
    }
    return null;
  }

  // ── Byte estimation ───────────────────────────────────────────────
  // Cheap structural estimate, not exact serialized size: strings are
  // UTF-16 in memory (×2) but usually ASCII-ish in JSON (×1) — we use ×1
  // to approximate the at-rest cost that quota actually charges for.
  //
  // sizeCache (optional WeakMap): per-object sizes remembered across calls,
  // for records rebuilt from mostly the same immutable objects (a project
  // autosave reuses the clone of every unchanged clash) — the walk then costs
  // what changed, not the whole record. Only objects below the root are
  // cached; never pass a cache for records whose objects are mutated.
  /**
   * @param {any} v
   * @param {WeakMap<object, number>} [sizeCache]
   * @returns {number}
   */
  function estimateRecordBytes(v, sizeCache) {
    var seen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    var cache = sizeCache || null;
    function walk(x, depth) {
      if (cache && depth > 0 && x !== null && typeof x === 'object') {
        if (seen && seen.has(x)) return 0;          // a shared object counts once
        var hit = cache.get(x);
        if (hit !== undefined) { if (seen) seen.add(x); return hit; }
        var n = walk1(x, depth);
        cache.set(x, n);
        return n;
      }
      return walk1(x, depth);
    }
    function walk1(x, depth) {
      if (x == null) return 4;
      var t = typeof x;
      if (t === 'string') return x.length + 2;
      if (t === 'number') return 8;
      if (t === 'boolean') return 4;
      if (t !== 'object') return 0;
      if (typeof ArrayBuffer !== 'undefined') {
        if (x instanceof ArrayBuffer) return x.byteLength;
        if (ArrayBuffer.isView(x)) return x.byteLength;
      }
      if (typeof Blob !== 'undefined' && x instanceof Blob) return x.size;
      if (depth > 8) return 16;
      if (seen) {
        if (seen.has(x)) return 0;
        seen.add(x);
      }
      var total = 8, i, k;
      if (Array.isArray(x)) {
        for (i = 0; i < x.length; i++) total += walk(x[i], depth + 1);
        return total;
      }
      for (k in x) {
        if (!Object.prototype.hasOwnProperty.call(x, k)) continue;
        total += k.length + walk(x[k], depth + 1);
      }
      return total;
    }
    return walk(v, 0);
  }

  // ── localStorage scan ─────────────────────────────────────────────
  // entries: [{key, value}] (values are the raw strings). Returns per-key
  // rows + per-family aggregation + any unregistered keys.
  function scanLocalStorage(entries) {
    var items = [], unregistered = [], famAgg = {}, totalBytes = 0;
    (entries || []).forEach(function(e) {
      if (!e || typeof e.key !== 'string') return;
      var bytes = (e.key.length + (typeof e.value === 'string' ? e.value.length : 0));
      var fam = classifyKey(e.key);
      totalBytes += bytes;
      items.push({ key: e.key, bytes: bytes, family: fam ? fam.family : null,
        retention: fam ? fam.retention : null, scope: fam ? fam.scope : null });
      if (!fam) { unregistered.push(e.key); return; }
      var agg = famAgg[fam.family] || (famAgg[fam.family] = { family: fam.family, retention: fam.retention, bytes: 0, count: 0 });
      agg.bytes += bytes; agg.count++;
    });
    items.sort(function(a, b) { return b.bytes - a.bytes; });
    var families = Object.keys(famAgg).map(function(k) { return famAgg[k]; })
      .sort(function(a, b) { return b.bytes - a.bytes; });
    return { items: items, families: families, unregistered: unregistered, totalBytes: totalBytes };
  }

  // ── Report shaping ────────────────────────────────────────────────
  // input:
  //   estimate:  {quota, usage} from navigator.storage.estimate() (or null)
  //   persisted: bool|null — navigator.storage.persisted() result
  //   ifcFiles:  [{id, name, projectId, savedAt, bytes}]
  //   geoCache:  [{id, sourceId, savedAt, bytes}]  (sourceId absent on legacy rows)
  //   projects:  [{id, bytes}]
  //   localEntries: [{key, value}]
  // Output groups everything per project so the UI can show "who is heavy".
  function buildStorageReport(input) {
    input = input || {};
    var perProject = {};
    function proj(id) {
      var pid = id || 'default';
      return perProject[pid] || (perProject[pid] = {
        projectId: pid, fileCount: 0, ifcBytes: 0, geoBytes: 0, sessionBytes: 0, lastSavedAt: 0
      });
    }
    var fileProject = {};
    (input.ifcFiles || []).forEach(function(f) {
      var p = proj(f.projectId);
      p.fileCount++;
      p.ifcBytes += f.bytes || 0;
      if (f.savedAt > p.lastSavedAt) p.lastSavedAt = f.savedAt;
      fileProject[f.id] = f.projectId || 'default';
    });
    (input.geoCache || []).forEach(function(g) {
      var srcId = g.sourceId != null ? g.sourceId :
        (typeof g.id === 'string' && g.id.indexOf('v8:') === 0 ? g.id.slice(3) : g.id);
      proj(fileProject[srcId]).geoBytes += g.bytes || 0;
    });
    (input.projects || []).forEach(function(p) {
      proj(p.id).sessionBytes += p.bytes || 0;
    });
    var rows = Object.keys(perProject).map(function(k) {
      var p = perProject[k];
      p.totalBytes = p.ifcBytes + p.geoBytes + p.sessionBytes;
      return p;
    }).sort(function(a, b) { return b.totalBytes - a.totalBytes; });
    var ls = scanLocalStorage(input.localEntries || []);
    var idbBytes = rows.reduce(function(t, p) { return t + p.totalBytes; }, 0);
    return {
      quota: input.estimate && input.estimate.quota != null ? input.estimate.quota : null,
      usage: input.estimate && input.estimate.usage != null ? input.estimate.usage : null,
      persisted: input.persisted != null ? input.persisted : null,
      idb: {
        totalBytes: idbBytes,
        ifcBytes: rows.reduce(function(t, p) { return t + p.ifcBytes; }, 0),
        geoBytes: rows.reduce(function(t, p) { return t + p.geoBytes; }, 0),
        sessionBytes: rows.reduce(function(t, p) { return t + p.sessionBytes; }, 0)
      },
      perProject: rows,
      localStorage: ls
    };
  }

  // ── Budget + eviction planning ────────────────────────────────────
  // The effective budget is the tighter of the user's preference and 80% of
  // the browser quota. Null = no enforceable budget (no quota info, no pref).
  function computeBudget(prefBytes, quota) {
    var q = (quota && isFinite(quota)) ? Math.floor(quota * 0.8) : null;
    var p = (prefBytes && isFinite(prefBytes)) ? prefBytes : null;
    if (q == null && p == null) return null;
    if (q == null) return p;
    if (p == null) return q;
    return Math.min(p, q);
  }

  function _geoSourceOf(g) {
    if (g.sourceId != null) return g.sourceId;
    return (typeof g.id === 'string' && g.id.indexOf('v8:') === 0) ? g.id.slice(3) : g.id;
  }

  // Pure eviction plan over IDB inventory metadata. Retention drives the
  // tiers: geoCache is derived (auto-deletable — cold re-parse rebuilds it),
  // ifcFiles are source data (returned as user-confirmed proposals ONLY,
  // never auto, never the active project — the app reads bytes back out of
  // the active project's files for reload-in-full and storey scoping).
  // inventory: {ifcFiles:[{id,projectId,savedAt,bytes}],
  //             geoCache:[{id,sourceId,savedAt,bytes}],
  //             projects:[{id,bytes}]}
  function planEviction(inventory, budget, opts) {
    inventory = inventory || {};
    opts = opts || {};
    var active = opts.activeProject || 'default';
    var ifc = inventory.ifcFiles || [];
    var geo = inventory.geoCache || [];
    var proj = inventory.projects || [];
    var totalBytes = 0;
    ifc.forEach(function(f) { totalBytes += f.bytes || 0; });
    geo.forEach(function(g) { totalBytes += g.bytes || 0; });
    proj.forEach(function(p) { totalBytes += p.bytes || 0; });
    var base = { totalBytes: totalBytes, budget: budget || null, overBy: 0, auto: /** @type {any[]} */ ([]), proposals: /** @type {any[]} */ ([]) };
    if (!budget || !isFinite(budget) || totalBytes <= budget) return base;
    base.overBy = totalBytes - budget;

    var fileProject = {};
    ifc.forEach(function(f) { fileProject[f.id] = f.projectId || 'default'; });

    // Tier 1 (auto): geo cache grouped per source file — a legacy row and a
    // v8: row for the same file die together via idbDeleteGeoCache(sourceId).
    // Cold (non-active-project) entries go first, oldest savedAt first.
    var groups = {};
    geo.forEach(function(g) {
      var src = _geoSourceOf(g);
      var grp = groups[src] || (groups[src] = { sourceId: src, bytes: 0, savedAt: Infinity });
      grp.bytes += g.bytes || 0;
      var at = g.savedAt || 0;
      if (at < grp.savedAt) grp.savedAt = at;
    });
    var geoGroups = Object.keys(groups).map(function(k) { return groups[k]; });
    geoGroups.sort(function(a, b) {
      var aActive = fileProject[a.sourceId] === active;
      var bActive = fileProject[b.sourceId] === active;
      if (aActive !== bActive) return aActive ? 1 : -1;
      return a.savedAt - b.savedAt;
    });
    var freed = 0, i;
    for (i = 0; i < geoGroups.length && freed < base.overBy; i++) {
      base.auto.push({ action: 'delete-geocache', sourceId: geoGroups[i].sourceId, bytes: geoGroups[i].bytes });
      freed += geoGroups[i].bytes;
    }

    // Tier 2 (proposals): whole non-active projects' stored files, least
    // recently saved first. Listed until the remaining overage is covered.
    var remaining = base.overBy - freed;
    if (remaining > 0) {
      var perProj = {};
      ifc.forEach(function(f) {
        var pid = f.projectId || 'default';
        if (pid === active) return;
        var row = perProj[pid] || (perProj[pid] = { projectId: pid, bytes: 0, fileCount: 0, lastSavedAt: 0 });
        row.bytes += f.bytes || 0;
        row.fileCount++;
        if ((f.savedAt || 0) > row.lastSavedAt) row.lastSavedAt = f.savedAt || 0;
      });
      var rows = Object.keys(perProj).map(function(k) { return perProj[k]; });
      rows.sort(function(a, b) { return a.lastSavedAt - b.lastSavedAt; });
      var covered = 0;
      for (i = 0; i < rows.length && covered < remaining; i++) {
        base.proposals.push({ action: 'remove-project-files', projectId: rows[i].projectId,
          bytes: rows[i].bytes, fileCount: rows[i].fileCount, lastSavedAt: rows[i].lastSavedAt });
        covered += rows[i].bytes;
      }
    }
    return base;
  }

  // Quota-recovery plan for localStorage: which keys to sacrifice so a
  // write of `needed` bytes can land. Only derived (fully recomputable)
  // and decay (bounded history) families are candidates — source data and
  // prefs are never pruned. Derived goes first, biggest first.
  // items: rows from scanLocalStorage().items.
  function planLocalPrune(items, needed) {
    var order = { derived: 0, decay: 1 };
    var cands = (items || []).filter(function(i) {
      return i.retention === 'derived' || i.retention === 'decay';
    });
    cands.sort(function(a, b) {
      return (order[a.retention] - order[b.retention]) || (b.bytes - a.bytes);
    });
    var keys = [], freed = 0, i;
    for (i = 0; i < cands.length && freed < needed; i++) {
      keys.push(cands[i].key);
      freed += cands[i].bytes;
    }
    return { keys: keys, freedBytes: freed };
  }

  // Snapshot cache budget (derived data): keep at most maxCount entries and
  // maxBytes in total; the least recently used go first, and any entry whose
  // key is in `drop` (superseded: the clash's geometry changed) goes always.
  // entries: [{key, bytes, at}] -> keys to delete, deterministic order.
  var SNAPSHOT_BUDGET = { maxCount: 600, maxBytes: 40 * 1024 * 1024 };
  function planSnapshotGC(entries, opts) {
    opts = opts || {};
    var maxCount = opts.maxCount != null ? opts.maxCount : SNAPSHOT_BUDGET.maxCount;
    var maxBytes = opts.maxBytes != null ? opts.maxBytes : SNAPSHOT_BUDGET.maxBytes;
    var drop = opts.drop || {};
    var del = [], keep = [];
    (entries || []).forEach(function(e) { if (!e || !e.key) return; if (drop[e.key]) del.push(e.key); else keep.push(e); });
    keep.sort(function(a, b) { return (b.at || 0) - (a.at || 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); });
    var bytes = 0, n = 0;
    keep.forEach(function(e) {
      n++; bytes += e.bytes || 0;
      if (n > maxCount || bytes > maxBytes) del.push(e.key);
    });
    return del;
  }

  // ── Project record pages ──────────────────────────────────────────
  // The project autosave record ('projects' store) is a small header keyed
  // by the project id plus fixed-size pages of the two long lists, keyed
  // [projectId, list, pageIndex] ('c' clashes, 'i' issues). Array keys sort
  // after every string key and never collide with a project id; all pages
  // of one project lie in projectPagesRange(pid). The autosave clones are
  // identity-stable (an unchanged clash keeps its clone), so a page whose
  // clone references are unchanged since the last write is not written
  // again: one status edit puts one page and the header.
  var PROJECT_PAGE_SIZE = 128;
  var PROJECT_PAGE_LISTS = [['c', 'clashes'], ['i', 'issues']];

  /** @param {string} pid */
  function projectPagesRange(pid) { return { lower: [pid], upper: [pid, []] }; }

  // The project a 'projects' store key belongs to (header: the key itself).
  /** @param {any} key */
  function projectKeyOwner(key) { return Array.isArray(key) ? key[0] : key; }

  // Which page records to put / delete for this save.
  //   pid   — project id
  //   lists — {clashes: [...clones], issues: [...clones]}
  //   prev  — the memo returned by the previous plan for what is on disk
  //           (null: unknown — every page is rewritten and stale pages of
  //           this project are deleted first)
  // Returns {full, deletes:[{lower, upper}], puts:[{key, items}],
  //          header:{v, size, clashes, issues}, memo}.
  /**
   * @param {string} pid
   * @param {{clashes?: any[], issues?: any[]}} lists
   * @param {any} prev
   * @param {number} [pageSize]
   */
  function planProjectPages(pid, lists, prev, pageSize) {
    var size = pageSize || PROJECT_PAGE_SIZE;
    var full = !prev || prev.pid !== pid || prev.size !== size;
    var out = { full: full, deletes: /** @type {any[]} */ ([]), puts: /** @type {any[]} */ ([]),
      header: /** @type {any} */ ({ v: 1, size: size }), memo: /** @type {any} */ ({ pid: pid, size: size, pages: {} }) };
    if (full) out.deletes.push(projectPagesRange(pid));
    PROJECT_PAGE_LISTS.forEach(function(pl) {
      var tag = pl[0], arr = (lists && lists[pl[1]]) || [];
      var n = Math.ceil(arr.length / size), pages = [], old = full ? [] : (prev.pages[tag] || []);
      for (var p = 0; p < n; p++) {
        var items = arr.slice(p * size, (p + 1) * size), was = old[p], same = !!was && was.length === items.length;
        for (var j = 0; same && j < items.length; j++) if (items[j] !== was[j]) same = false;
        pages.push(same ? was : items);
        if (!same) out.puts.push({ key: [pid, tag, p], items: items });
      }
      if (!full && old.length > n) out.deletes.push({ lower: [pid, tag, n], upper: [pid, tag, Infinity] });
      out.header[pl[1]] = arr.length;
      out.memo.pages[tag] = pages;
    });
    return out;
  }

  // Rebuild the stored project data from its header and page records (any
  // order). A header without `_ccPages` is a single-record project written
  // before pages existed and is returned as it is. The result has the same
  // fields as the single record had: header fields, clashes, issues and
  // bytes (header + pages).
  /**
   * @param {any} header
   * @param {any[]} pageRecords
   */
  function assembleProjectRecord(header, pageRecords) {
    if (!header || !header._ccPages) return header || null;
    var info = header._ccPages, size = info.size || PROJECT_PAGE_SIZE, bytes = header.bytes || 0;
    /** @type {any} */
    var out = {};
    Object.keys(header).forEach(function(k) { if (k !== '_ccPages' && k !== 'bytes') out[k] = header[k]; });
    var byList = { c: /** @type {any[]} */ ([]), i: /** @type {any[]} */ ([]) };
    (pageRecords || []).forEach(function(r) {
      if (!r || !Array.isArray(r.id) || r.id[0] !== header.id) return;
      var tag = r.id[1], idx = r.id[2];
      if (!byList[tag] || typeof idx !== 'number') return;
      byList[tag][idx] = r.items || [];
      bytes += r.bytes || 0;
    });
    PROJECT_PAGE_LISTS.forEach(function(pl) {
      var want = info[pl[1]] || 0, pages = byList[pl[0]], list = [];
      for (var p = 0; p * size < want; p++) {
        var items = pages[p] || [];
        for (var j = 0; j < items.length; j++) list.push(items[j]);
      }
      if (list.length !== want && typeof console !== 'undefined') console.warn('[storage] project ' + header.id + ': ' + pl[1] + ' pages hold ' + list.length + ' of ' + want);
      out[pl[1]] = list;
    });
    out.bytes = bytes;
    return out;
  }

  // Inventory rows of the 'projects' store ({id, bytes}, id = header key or
  // page key) folded into one row per project.
  /** @param {{id: any, bytes?: number}[]} rows */
  function foldProjectRows(rows) {
    /** @type {Object<string, {id: string, bytes: number}>} */
    var by = {};
    var order = [];
    (rows || []).forEach(function(r) {
      var id = projectKeyOwner(r.id);
      if (!by[id]) { by[id] = { id: id, bytes: 0 }; order.push(id); }
      by[id].bytes += r.bytes || 0;
    });
    return order.map(function(id) { return by[id]; });
  }

  function formatBytes(n) {
    if (n == null || isNaN(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  return Object.freeze({
    contractVersion: 1,
    IDB_REGISTRY: IDB_REGISTRY,
    LS_REGISTRY: LS_REGISTRY,
    classifyKey: classifyKey,
    estimateRecordBytes: estimateRecordBytes,
    scanLocalStorage: scanLocalStorage,
    buildStorageReport: buildStorageReport,
    computeBudget: computeBudget,
    planEviction: planEviction,
    planLocalPrune: planLocalPrune,
    SNAPSHOT_BUDGET: SNAPSHOT_BUDGET,
    planSnapshotGC: planSnapshotGC,
    PROJECT_PAGE_SIZE: PROJECT_PAGE_SIZE,
    projectPagesRange: projectPagesRange,
    projectKeyOwner: projectKeyOwner,
    planProjectPages: planProjectPages,
    assembleProjectRecord: assembleProjectRecord,
    foldProjectRows: foldProjectRows,
    formatBytes: formatBytes
  });
}));
