(function(root, factory) {
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
    { store: 'ifcFiles', retention: 'source',  scope: 'per-project' },
    { store: 'projects', retention: 'source',  scope: 'per-project' },
    { store: 'geoCache', retention: 'derived', scope: 'per-file' }
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
  function estimateRecordBytes(v) {
    var seen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
    function walk(x, depth) {
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
    formatBytes: formatBytes
  });
}));
