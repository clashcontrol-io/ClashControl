// ── ClashControl Addon: Smart Bridge ────────────────────────────────
// LLM bridge that connects ClashControl to AI assistants via WebSocket.
// Supports multiple connection options:
//   - Claude Desktop/Code (via MCP server)
//   - ChatGPT (via REST bridge + OpenAPI Actions)
//   - Any LLM with function calling (via REST API)
//
// One-click install: downloads a standalone binary, registers a URL
// scheme (clashcontrol-bridge://start), and polls until connected.
//
// Receives tool calls from the bridge server (localhost:19802),
// executes them via window._ccDispatch and friends, sends results back.

(function() {
  'use strict';

  var WS_URL = 'ws://127.0.0.1:19802';
  var REST_URL = 'http://127.0.0.1:19803';
  var _ws = null;
  var _connected = false;
  var _releaseTag = 'bridge-v0.3.3'; // fallback; will be updated from GitHub API

  function _buildDownloads() {
    var _releaseBase = 'https://github.com/clashcontrol-io/ClashControl/releases/download/' + _releaseTag + '/';
    return {
    win:   {url: _releaseBase + 'clashcontrol-smart-bridge-win.exe',
            label: 'Windows (.exe)',
            cmd: 'clashcontrol-smart-bridge-win.exe',
            installPath: '%APPDATA%\\ClashControl\\clashcontrol-smart-bridge.exe'},
    mac:   {url: _releaseBase + 'clashcontrol-smart-bridge-mac.tar.gz',
            label: 'macOS (.tar.gz)',
            cmd: 'tar -xzf clashcontrol-smart-bridge-mac.tar.gz && ./clashcontrol-smart-bridge',
            installPath: '~/Library/Application Support/ClashControl/clashcontrol-smart-bridge'},
      linux: {url: _releaseBase + 'clashcontrol-smart-bridge-linux.tar.gz',
              label: 'Linux (.tar.gz)',
              cmd: 'tar -xzf clashcontrol-smart-bridge-linux.tar.gz && ./clashcontrol-smart-bridge',
              installPath: '~/.local/share/clashcontrol/clashcontrol-smart-bridge'}
    };
  }

  // ── Fetch latest release tag from GitHub API ──────────────────────
  // Initializes with fallback version, then updates if API succeeds.
  // This ensures downloads work immediately without waiting for the API.
  var _downloads = _buildDownloads();

  // Compare two semver strings (with or without leading 'v').
  // Returns true if a > b.
  function _semverGt(a, b) {
    var pa = (a || '').replace(/^bridge-v|^v/, '').split('.').map(Number);
    var pb = (b || '').replace(/^bridge-v|^v/, '').split('.').map(Number);
    for (var i = 0; i < 3; i++) {
      var na = pa[i] || 0, nb = pb[i] || 0;
      if (na > nb) return true;
      if (na < nb) return false;
    }
    return false;
  }

  // Trigger auto-update if latestTag is newer than runningVersion.
  // Called from both the GitHub API callback and after bridge connection,
  // whichever resolves last, to cover both orderings.
  function _maybeAutoUpdate(d, runningVersion, latestTag) {
    if (!runningVersion || !latestTag) return;
    if (_semverGt(latestTag, runningVersion)) {
      console.log('%c[Smart Bridge] Running v' + runningVersion + ' < latest ' + latestTag + ' — auto-updating', 'color:#fbbf24;font-weight:bold');
      _applyBridgeUpdate(d);
    }
  }

  function _fetchLatestReleaseTag(d) {
    fetch('https://api.github.com/repos/clashcontrol-io/ClashControl/releases?per_page=10', {cache:'no-store'})
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(arr) {
        var rel = (arr || []).find(function(r) { return r.tag_name && r.tag_name.indexOf('bridge-v') === 0; });
        var j = rel || null;
        var newTag = (j && j.tag_name) || _releaseTag;
        console.log('[Smart Bridge] GitHub API returned:', newTag);
        if (newTag !== _releaseTag) {
          console.log('%c[Smart Bridge] Updating release from ' + _releaseTag + ' to ' + newTag, 'color:#22c55e;font-weight:bold');
          _releaseTag = newTag;
          _downloads = _buildDownloads(); // rebuild with new tag
        }
        // Trigger A: GitHub resolved — compare against running bridge version (if already connected).
        if (d) {
          var sb = (window._ccLatestState || {}).smartBridge || {};
          _maybeAutoUpdate(d, sb.version, newTag);
        }
      })
      .catch(function(e) {
        console.warn('[Smart Bridge] Failed to fetch latest release:', e && e.message || e);
      });
  }

  function _detectOS() {
    var ua = navigator.userAgent || '';
    if (/Win/.test(navigator.platform || ua)) return 'win';
    if (/Mac/.test(navigator.platform || ua)) return 'mac';
    return 'linux';
  }

  // ── Status probe ──────────────────────────────────────────────────

  function _probeStatus(timeoutMs) {
    var fetchOpts = {method:'GET', cache:'no-store'};
    try { if (AbortSignal.timeout) fetchOpts.signal = AbortSignal.timeout(timeoutMs || 500); } catch(e){}
    return fetch(REST_URL + '/status', fetchOpts)
      .then(function(r){ if (!r.ok) throw new Error('HTTP '+r.status); return r.json(); });
  }

  // ── Download trigger ──────────────────────────────────────────────
  // Must be called synchronously within a user gesture (click handler)

  function _triggerDownload() {
    try {
      var os = _detectOS();
      var dl = _downloads[os];
      var a = document.createElement('a');
      a.href = dl.url;
      a.download = '';
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function(){ document.body.removeChild(a); }, 100);
    } catch(e) {
      console.warn('[Smart Bridge] download trigger failed:', e && e.message || e);
    }
  }

  // ── URL-scheme launch ─────────────────────────────────────────────

  function _launchBridge() {
    try {
      var a = document.createElement('a');
      a.href = 'clashcontrol-bridge://start';
      a.rel = 'noopener';
      a.click();
    } catch (e) {
      console.log('[Smart Bridge] URL-scheme launch failed:', e && e.message || e);
    }
  }

  // ── Update check: GET /update ────────────────────────────────────
  // Called once after each successful connection and periodically.
  // If the bridge reports update_available, automatically triggers the
  // self-update flow (POST /update + poll until restart).
  // Silently ignored if the bridge is down or doesn't support the endpoint.
  function _checkForUpdate(d) {
    var fetchOpts = {method:'GET', cache:'no-store'};
    try { if (AbortSignal.timeout) fetchOpts.signal = AbortSignal.timeout(3000); } catch(e){}
    return fetch(REST_URL + '/update', fetchOpts)
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(j) {
        if (j && j.update_available) {
          console.log('%c[Smart Bridge] Update available — auto-updating to', 'color:#fbbf24;font-weight:bold', j.version || 'latest');
          // Auto-trigger the self-update: POST /update, then poll /status
          // until the bridge restarts. No user interaction required.
          _applyBridgeUpdate(d);
        }
      })
      .catch(function() { /* /update not present or bridge unreachable — ignore */ });
  }

  // ── Poll /status until bridge restarts (post-update) ──────────────
  // Does NOT fire the URL scheme — the bridge restarts itself.
  function _pollForRestart(d, timeoutMs) {
    var gen = ++_connectGen;
    var deadline = Date.now() + (timeoutMs || 30000);
    function tick() {
      if (gen !== _connectGen) return;
      if (Date.now() >= deadline) {
        if (d) d({t:'UPD_SMART_BRIDGE', u:{updating:false, available:false, failed:true}});
        return;
      }
      _probeStatus(2000)
        .then(function(j) {
          if (gen !== _connectGen) return;
          if (d) d({t:'UPD_SMART_BRIDGE', u:{available:true, updating:false, version:j.version||null}});
          _connectWs(d);
        })
        .catch(function() { setTimeout(tick, 2000); });
    }
    setTimeout(tick, 1500); // wait for bridge to start shutting down
  }

  // ── Trigger self-update: POST /update ──────────────────────────────
  // Tells the bridge to download the latest release, replace its own
  // binary, and restart. We then poll until it comes back online.
  function _applyBridgeUpdate(d) {
    if (d) d({t:'UPD_SMART_BRIDGE', u:{updating:true, updateAvailable:false}});
    var fetchOpts = {method:'POST', cache:'no-store'};
    try { if (AbortSignal.timeout) fetchOpts.signal = AbortSignal.timeout(5000); } catch(e){}
    return fetch(REST_URL + '/update', fetchOpts)
      .then(function() {
        console.log('%c[Smart Bridge] Self-update triggered, waiting for restart\u2026', 'color:#fbbf24');
        _pollForRestart(d, 60000); // up to 60s for the update + restart
      })
      .catch(function(e) {
        console.warn('[Smart Bridge] POST /update failed:', e && e.message || e);
        if (d) d({t:'UPD_SMART_BRIDGE', u:{updating:false, updateAvailable:true}});
      });
  }

  // ── Connect with polling ──────────────────────────────────────────

  var _connectGen = 0;
  function _cancelPendingConnect() { _connectGen++; }
  var _wsGen = 0;
  var _updateChecked = false;   // true after first /update check per connection
  var _updateInterval = null;   // periodic /update check handle

  function _connectBridge(d, opts) {
    opts = opts || {};
    _cancelPendingConnect();
    var gen = _connectGen;
    var timeoutMs = opts.installing ? 600000 : 6000; // 10min for install, 6s for reconnect

    if (d) d({t:'UPD_SMART_BRIDGE', u:{
      connecting: true, installing: !!opts.installing, failed: false
    }});

    // Try URL scheme launch (for returning users with registered handler)
    if (!opts.installing) {
      _launchBridge();
    }

    var start = Date.now();
    var deadline = start + timeoutMs;
    function tick() {
      if (gen !== _connectGen) return Promise.resolve(null);
      if (Date.now() >= deadline) {
        // Bridge binary isn't running. The failure is already in state
        // (failed:true), and every caller is fire-and-forget — rejecting here
        // just produces unhandled-promise-rejection spam in the console. Resolve
        // null instead so "not installed" is a normal, observable outcome.
        if (d) d({t:'UPD_SMART_BRIDGE', u:{connecting:false, installing:false, failed:true}});
        console.warn('[Smart Bridge] bridge not reachable on ' + REST_URL + ' — is the Connector running?');
        return Promise.resolve(null);
      }
      var elapsed = Date.now() - start;
      var pollInterval = elapsed < 6000 ? 300 : 2000;
      return _probeStatus(500)
        .then(function(j) {
          if (gen !== _connectGen) return null;
          // Bridge is running — connect WebSocket
          if (d) d({t:'UPD_SMART_BRIDGE', u:{
            available: true, connecting: false, installing: false, failed: false,
            wasInstalled: true, version: j.version || null
          }});
          try { localStorage.setItem('cc_smart_bridge','1'); } catch(e){}
          try { localStorage.setItem('cc_sb_downloaded','1'); } catch(e){}
          _connectWs(d);
          // Check for updates after successful connection
          if (!_updateChecked) {
            _updateChecked = true;
            _checkForUpdate(d);
            // Trigger B: bridge version now known — compare against GitHub tag (if already resolved).
            _maybeAutoUpdate(d, j.version, _releaseTag);
          }
          return j;
        })
        .catch(function() {
          return new Promise(function(r){ setTimeout(r, pollInterval); }).then(tick);
        });
    }
    return tick();
  }

  // ── Passive status check (no URL scheme, no install) ──────────────

  function _checkBridge(d) {
    if (d) d({t:'UPD_SMART_BRIDGE', u:{checking:true}});
    return _probeStatus(1000)
      .then(function(j) {
        if (d) d({t:'UPD_SMART_BRIDGE', u:{
          checking:false, available:true, version: j.version || null
        }});
        // Check for updates after successful connection
        if (!_updateChecked) {
          _updateChecked = true;
          _checkForUpdate(d);
          // Trigger B: bridge version now known — compare against GitHub tag (if already resolved).
          _maybeAutoUpdate(d, j.version, _releaseTag);
        }
        return j;
      })
      .catch(function() {
        if (d) d({t:'UPD_SMART_BRIDGE', u:{checking:false, available:false}});
        return null;
      });
  }

  // ── State helpers ─────────────────────────────────────────────────

  function _getState() {
    return window._ccLatestState || {};
  }

  function _dispatch(action) {
    if (window._ccDispatch) window._ccDispatch(action);
  }

  // Deterministic projectKey (connective-spine partition key). Must be identical
  // across tools (PDRA, Loam) for the SAME open Revit doc so the join lines up.
  // A per-session CC slug breaks that, so prefer the Revit project identity the
  // Connector forwards (ProjectInformation.UniqueId) as "revit:<uid>" — same open
  // document → same string everywhere. Falls back to the active CC project, then
  // a stable literal.
  function _projectKey(s) {
    try {
      var rpid = window._ccRevitProjectUniqueId;
      if (rpid) return 'revit:' + rpid;
    } catch (e) {}
    return (s && s.activeProject) || 'local';
  }

  // ── Action handlers ───────────────────────────────────────────────

  var handlers = {};

  // Extract a classification code (NL-SfB / Uniclass / assembly / OmniClass) from
  // an element's nested property sets. Self-contained (no cross-addon import) — the
  // key list mirrors the data-quality addon. Classification is the join key to
  // non-model sources (finance/ERP, spec) that GUID can't reach. Returns
  // { system, code } or null.
  function _classSysOf(key) {
    var kl = String(key).toLowerCase().replace(/[\s_\/-]/g, '');
    return kl.indexOf('nlsfb') >= 0 || kl.indexOf('sfb') >= 0 ? 'NL-SfB'
         : kl.indexOf('uniclass') >= 0 ? 'Uniclass'
         : kl.indexOf('omniclass') >= 0 ? 'OmniClass'
         : kl.indexOf('uniformat') >= 0 ? 'Uniformat'
         : (kl === 'assemblycode' || kl.indexOf('classification') >= 0 || kl === 'classificationcode') ? 'Classification'
         : null;
  }
  // Generic "this field holds the code" key names (used when the SYSTEM is carried
  // by the pset/group name instead, e.g. a pset "NL-SfB" with a key "Code").
  function _isGenericCodeKey(key) {
    var kl = String(key).toLowerCase().replace(/[\s_\/-]/g, '');
    return kl === 'code' || kl === 'value' || kl === 'elementcode' || kl === 'nummer' || kl === 'number';
  }
  function _classOf(props) {
    var ps = props && props.psets;
    var hit = null;
    if (ps) {
      Object.keys(ps).forEach(function(pset) {
        if (hit) return;
        var grp = ps[pset];
        var psetSys = _classSysOf(pset); // system carried by the GROUP name?
        // psets may be NESTED ({Pset:{key:val}}, IFC loads) or FLAT
        // ({paramName:val}, Revit-direct parameters). Handle both.
        if (grp && typeof grp === 'object' && !Array.isArray(grp)) {
          Object.keys(grp).forEach(function(k) {
            if (hit) return;
            // System from the key, else from the group name when the key is a
            // generic code field (mirrors the DQ addon's _extractNLSfB breadth —
            // catches a "NL-SfB"/"Classification" pset whose key is just "Code").
            var sys = _classSysOf(k) || (psetSys && _isGenericCodeKey(k) ? psetSys : null);
            if (!sys) return;
            var v = grp[k];
            if (v != null && String(v).trim() !== '') hit = { system: sys, code: String(v).trim() };
          });
        } else {
          // Flat: the pset key IS the parameter name, grp is its value.
          var sys = _classSysOf(pset);
          if (sys && grp != null && String(grp).trim() !== '') hit = { system: sys, code: String(grp).trim() };
        }
      });
    }
    // Fallback: NL-SfB often lives in ObjectType as "(NN)" or "NN.xx ..." (the DQ
    // addon does the same). Only used when no explicit classification field found.
    if (!hit && props && props.objectType) {
      var m = /\((\d{2}(?:\.\d{1,2})*)\)/.exec(props.objectType) || /^(\d{2}(?:\.\d{1,2})*)[\.\-\s]/.exec(props.objectType);
      if (m) hit = { system: 'NL-SfB', code: m[1] };
    }
    return hit;
  }

  // Classification for one element by model + expressId (one-off lookup, used when
  // promoting a clash to an issue so the Issue carries the same join key).
  function _classByElem(modelId, eid) {
    if (!modelId || eid == null) return null;
    var ms = (_getState().models) || [];
    for (var i = 0; i < ms.length; i++) {
      if (ms[i].id !== modelId) continue;
      var els = ms[i].elements || [];
      for (var j = 0; j < els.length; j++) {
        if (els[j].expressId === eid) return _classOf(els[j].props);
      }
    }
    return null;
  }

  handlers.get_status = function() {
    var s = _getState();
    var models = (s.models || []).map(function(m) {
      // Source-aware revision stamp so an external tool (e.g. a PDRA join) can
      // tell whether CC is talking about the same model state. Live link uses the
      // Connector sync (source + lastSync + version); a loaded IFC is a snapshot
      // identified by file name + element count + version. Both are coarse — they
      // answer "same revision or not", not byte-equality.
      var st = m.stats || {};
      var live = st.source === 'revit-direct';
      var revision = live
        ? ('revit:' + (m.name || '') + '@v' + (m._version || 1) + (st.lastSync ? ('/' + st.lastSync) : ''))
        : ('ifc:' + (m.name || '') + '#' + ((m.elements || []).length) + '@v' + (m._version || 1));
      return { name: m.name, discipline: m.discipline || 'Unknown',
        elements: (m.elements || []).length, visible: m.visible !== false,
        source: st.source || 'ifc', version: m._version || 1,
        lastSync: st.lastSync || null, revision: revision,
        // modelInstanceId distinguishes document copies so a join can't silently
        // cross two copies of the "same" model. m.id is CC's per-load instance;
        // the authoritative token (Revit Document VersionGUID) must come from the
        // Connector — surface it when present.
        modelInstanceId: st.docVersion || st.versionGuid || m.id || null,
        // Uniform freshness stamp (connective-spine §2) — generic staleness guard.
        freshness: { source: 'clashcontrol', revisionId: revision,
          asOf: st.lastSync ? new Date(st.lastSync).toISOString() : null,
          confidence: live ? 'live' : 'snapshot' } };
    });
    var r = s.rules || {};
    // Detection freshness. clashCount:0 is ambiguous (no clashes vs never ran);
    // lastDetection:null means detection has never run this session. clashesStale
    // flags that a model synced AFTER the last run, so the clash set is out of date
    // (re-run before acting). _rh comes from the run-history the reducer keeps.
    var _rh = (s.runHistory && s.runHistory.length) ? s.runHistory[s.runHistory.length - 1] : null;
    var _maxSync = 0;
    (s.models || []).forEach(function(m) { var ls = (m.stats && m.stats.lastSync) || 0; if (ls > _maxSync) _maxSync = ls; });
    var _clashesStale = !!(_rh && _maxSync && _maxSync > _rh.ts);
    return {
      models: models, modelCount: models.length,
      clashCount: (s.clashes || []).length,
      openClashes: (s.clashes || []).filter(function(c) { var st = c.status || 'open'; return st !== 'resolved' && st !== 'expected' && st !== 'closed'; }).length,
      issueCount: (s.issues || []).length,
      activeProject: s.activeProject || null,
      projectKey: _projectKey(s), // connective-spine partition key (deterministic)
      source: 'clashcontrol',
      rules: { maxGap: r.maxGap || 10, hard: !!r.hard, modelA: r.modelA || 'all', modelB: r.modelB || 'all', excludeSelf: !!r.excludeSelf },
      // Loam detection-feedback round-trip: confirms ingest_detection_feedback
      // landed (projectKey, counts, when) so the auto-feed can verify it stuck.
      detectionFeedback: (function(){ try { var fb = window._ccDetectionFeedback; return fb ? { projectKey: fb.projectKey || null, rules: (fb.byRule||[]).length, pairs: (fb.byPair||[]).length, ts: fb.ts || null } : null; } catch(e){ return null; } })(),
      // Last detection failure (e.g. RangeError on a huge federation) so the
      // orchestrator can report it without browser-console access. null when OK.
      lastDetectionError: (function(){ try { return window._ccLastDetectError || null; } catch(e){ return null; } })(),
      detecting: !!s.detecting,
      // Live progress while detecting so the orchestrator gets intermediate
      // feedback instead of just true→false. {done,total,pct} or null when idle.
      detectionProgress: (function(){ try { return (s.detecting && window._ccDetectProgress) ? window._ccDetectProgress : null; } catch(e){ return null; } })(),
      // When detection last completed (null = never run this session) + its result
      // counts, and whether a later model sync makes the current clashes stale.
      lastDetection: _rh ? { at: _rh.ts, total: _rh.total, open: _rh.open, newCount: _rh.newCount } : null,
      clashesStale: _clashesStale,
      // Live Revit-bridge ingest state. Without this an agent can't tell that a
      // model is still streaming in ("Receiving model from Revit 77%") — modelCount
      // already shows the slot while the data is half-loaded. `ingesting:true` means
      // DO NOT act on model/clash data yet; poll until state==='ready'.
      connector: (function(){
        try {
          var rd = s.revitDirect || {};
          var receiving = !!rd.loading;
          return {
            connected: !!rd.connected,
            state: receiving ? 'receiving' : (rd.connected ? 'ready' : 'disconnected'),
            ingesting: receiving,
            percent: receiving ? Math.round((rd.progress || 0) * 100) : (rd.connected ? 100 : 0),
            elementCount: rd.elementCount || 0,
            documentName: rd.documentName || null,
            // Last pull error (e.g. a partial/failed export) so the agent doesn't
            // treat a half-loaded or stale model as complete. null when OK.
            lastError: rd.exportError || null
          };
        } catch(e) { return null; }
      })(),
      activeTab: s.tab || 'clashes', walkMode: !!s.walkMode,
      theme: document.documentElement.getAttribute('data-theme') || 'dark'
    };
  };

  handlers.get_clashes = function(p) {
    var s = _getState();
    var clashes = s.clashes || [];
    if (p.status && p.status !== 'all') clashes = clashes.filter(function(c) { return c.status === p.status; });
    if (p.category) clashes = clashes.filter(function(c) { return (c.aiCategory || '') === p.category; });
    var limit = p.limit || 50;
    var offset = p.offset > 0 ? Math.floor(p.offset) : 0; // pagination — page the full set
    var slice = clashes.slice(offset, offset + limit);

    // Resolve a classification code per clash element (the join key to finance /
    // spec sources). Build an index only over the models + expressIds the slice
    // references, so this stays bounded even on large federations.
    var needed = {};
    function need(mid, eid) { if (mid && eid != null) { (needed[mid] || (needed[mid] = {}))[eid] = true; } }
    slice.forEach(function(c) { need(c.modelAId, c.elemA); need(c.modelBId, c.elemB); });
    var classIdx = {}; // modelId -> expressId -> {system,code}
    (s.models || []).forEach(function(m) {
      var nm = needed[m.id]; if (!nm) return;
      var map = classIdx[m.id] = {};
      (m.elements || []).forEach(function(el) { if (nm[el.expressId]) map[el.expressId] = _classOf(el.props); });
    });
    function classFor(mid, eid) { return (classIdx[mid] && classIdx[mid][eid]) || null; }
    var pk = _projectKey(s); // projectKey — partitions the connective graph (deterministic)

    return {
      total: clashes.length, offset: offset, returned: slice.length,
      clashes: slice.map(function(c, i) {
        return { index: offset + i, title: c.title || c.aiTitle || ('Clash ' + (offset + i + 1)),
          status: c.status || 'open', priority: c.priority || 'normal',
          // NOTE: clashes store elem*Type/Name/Storey — read those (the old
          // typeA/nameA/storey fields don't exist on the clash, so they were null).
          storey: c.storey || c.elemAStorey || c.elemBStorey || null,
          // Per-side storey + element bbox SIZE (mm, [w,d,h]) — for the orchestrator's
          // storey-band rule (arch finish-floor vs structural slab in a storey's band).
          storeyA: c.elemAStorey || null, storeyB: c.elemBStorey || null,
          bboxA: c.bboxA || null, bboxB: c.bboxB || null,
          typeA: c.typeA || c.elemAType || null, typeB: c.typeB || c.elemBType || null,
          nameA: c.nameA || c.elemAName || null, nameB: c.nameB || c.elemBName || null,
          distance: c.distance != null ? c.distance : null,
          // Elevation of the clash point (m) — lets a consumer (orchestrator) test
          // a slab/slab overlap against a storey's floor build-up band.
          elevation: c.elevation != null ? c.elevation : null,
          // Nearest structural-grid bay (e.g. "A-3") for the clash point, when grids
          // were brought in via the Revit bridge. Enables "clashes near grid A-3".
          gridBay: (c.point && typeof window._ccGridBayForPoint === 'function') ? window._ccGridBayForPoint(c.point) : null,
          aiSeverity: c.aiSeverity || null, aiCategory: c.aiCategory || null,
          // Stable identity for cross-tool joins. globalId = IFC GlobalId; revitId =
          // Revit ElementId (doc-local); uniqueId = Revit UniqueId — the only stable
          // cross-document key, so the reliable join back to a live Revit doc / PDRA.
          globalIdA: c.globalIdA || null, globalIdB: c.globalIdB || null,
          revitIdA: c.revitIdA != null ? c.revitIdA : null,
          revitIdB: c.revitIdB != null ? c.revitIdB : null,
          uniqueIdA: c.uniqueIdA || null, uniqueIdB: c.uniqueIdB || null,
          // Classification (NL-SfB/Uniclass/...) — the join key to finance/spec
          // sources that IFC GUID can't reach. storey is the spatial (zone) bucket.
          classificationA: classFor(c.modelAId, c.elemA),
          classificationB: classFor(c.modelBId, c.elemB),
          // Disciplines of the two sides — lets a consumer tell arch×structural
          // (expected floor build-up) from same-discipline (a real problem).
          disciplines: c.disciplines || null,
          // Connective-spine MUST keys (for the provenance ledger / write-back):
          // source + projectKey (the clash is the write target for set_clash_status,
          // so clashId is its sourceLocalId; each element side carries its own).
          source: 'clashcontrol', projectKey: pk, clashId: c.id || null,
          modelAId: c.modelAId || null, modelBId: c.modelBId || null,
          sourceLocalIdA: c.uniqueIdA || c.globalIdA || (c.elemA != null ? String(c.elemA) : null),
          sourceLocalIdB: c.uniqueIdB || c.globalIdB || (c.elemB != null ? String(c.elemB) : null) };
      })
    };
  };

  // Aggregate profile of the WHOLE clash set without paging it — so a consumer
  // (orchestrator) can see the category distribution and spot the few root causes
  // behind a large count. Counts by status, AI category, discipline-pair,
  // type-pair (top N), and storey.
  handlers.get_clash_summary = function(p) {
    var s = _getState();
    var clashes = s.clashes || [];
    var topN = p && p.topN > 0 ? Math.floor(p.topN) : 20;
    function bump(o, k) { k = k || '(none)'; o[k] = (o[k] || 0) + 1; }
    var byStatus = {}, byCategory = {}, byDiscipline = {}, byTypePair = {}, byStorey = {};
    clashes.forEach(function(c) {
      bump(byStatus, c.status || 'open');
      bump(byCategory, c.aiCategory);
      var d = c.disciplines || [];
      bump(byDiscipline, [d[0] || '?', d[1] || '?'].sort().join(' × '));
      var tp = [c.elemAType || c.typeA || '?', c.elemBType || c.typeB || '?'].sort().join(' × ');
      bump(byTypePair, tp);
      bump(byStorey, c.storey || c.elemAStorey || c.elemBStorey || '(none)');
    });
    function top(o) {
      return Object.keys(o).map(function(k) { return { key: k, count: o[k] }; })
        .sort(function(a, b) { return b.count - a.count; }).slice(0, topN);
    }
    return {
      total: clashes.length,
      open: clashes.filter(function(c) { return c.status !== 'resolved'; }).length,
      byStatus: byStatus, byCategory: byCategory, byDiscipline: byDiscipline,
      byTypePair: top(byTypePair), byStorey: top(byStorey)
    };
  };

  handlers.get_issues = function(p) {
    var s = _getState(); var issues = s.issues || []; var limit = p.limit || 50;
    var pk = _projectKey(s);
    return { total: issues.length,
      issues: issues.slice(0, limit).map(function(issue, i) {
        // Gather whatever element identity the issue carries, from any source:
        // clash-promoted issues (globalIdA/B), data-quality issues (qualityGids),
        // or single-element/BCF issues (globalId). Enables the same GUID join as
        // clashes.
        var gids = [];
        if (issue.globalIdA) gids.push(issue.globalIdA);
        if (issue.globalIdB) gids.push(issue.globalIdB);
        if (Array.isArray(issue.qualityGids)) gids = gids.concat(issue.qualityGids);
        if (issue.globalId) gids.push(issue.globalId);
        // Revit UniqueIds (the most reliable cross-doc join key) from either the
        // per-side fields or an array — mirrors get_clashes so a promoted issue
        // joins back the same way a clash does.
        var uids = [];
        if (issue.uniqueIdA) uids.push(issue.uniqueIdA);
        if (issue.uniqueIdB) uids.push(issue.uniqueIdB);
        if (Array.isArray(issue.uniqueIds)) uids = uids.concat(issue.uniqueIds);
        return { index: i, title: issue.title || ('Issue ' + (i + 1)),
          status: issue.status || 'open', priority: issue.priority || 'normal',
          assignee: issue.assignee || null, description: issue.description || null,
          globalIds: gids,
          uniqueIds: uids,
          uniqueIdA: issue.uniqueIdA || null, uniqueIdB: issue.uniqueIdB || null,
          revitIdA: issue.revitIdA != null ? issue.revitIdA : null,
          revitIdB: issue.revitIdB != null ? issue.revitIdB : null,
          storey: issue.storey || null,
          // Classification: use what's stamped, else derive from the element refs
          // (modelAId/elemA) the same way get_clashes does — so a UI-promoted issue
          // (which stamps refs but not classification) still joins to finance/spec.
          classificationA: issue.classificationA || issue.classification || _classByElem(issue.modelAId, issue.elemA) || null,
          classificationB: issue.classificationB || _classByElem(issue.modelBId, issue.elemB) || null,
          disciplines: issue.disciplines || null,
          revitIds: (function(){ var r=[]; if(issue.revitIdA!=null)r.push(issue.revitIdA); if(issue.revitIdB!=null)r.push(issue.revitIdB); if(Array.isArray(issue.revitIds))r=r.concat(issue.revitIds); return r; })(),
          modelAId: issue.modelAId || null, modelBId: issue.modelBId || null,
          linkedClashId: issue.linkedClashId || issue.clashId || null,
          // Connective-spine MUST keys.
          source: 'clashcontrol', projectKey: pk, sourceLocalId: issue.id || null };
      })
    };
  };

  // Resolve element(s) by IFC GlobalId or Revit ElementId — the other half of
  // the cross-tool join: given a GUID from another tool (e.g. a PDRA/Revit
  // element), find the matching CC element and its model/type/storey. Accepts a
  // single globalId/revitId or arrays (globalIds[]/revitIds[]).
  handlers.get_element_by_guid = function(p) {
    var s = _getState();
    var wantG = {}, wantR = {}, wantU = {};
    function addG(v){ if (v != null && v !== '') wantG[String(v)] = true; }
    function addR(v){ if (v != null && v !== '') wantR[String(v)] = true; }
    function addU(v){ if (v != null && v !== '') wantU[String(v)] = true; }
    addG(p.globalId); addR(p.revitId); addU(p.uniqueId);
    if (Array.isArray(p.globalIds)) p.globalIds.forEach(addG);
    if (Array.isArray(p.revitIds)) p.revitIds.forEach(addR);
    if (Array.isArray(p.uniqueIds)) p.uniqueIds.forEach(addU);
    if (!Object.keys(wantG).length && !Object.keys(wantR).length && !Object.keys(wantU).length)
      return 'Provide uniqueId/uniqueIds (Revit UniqueId — most reliable), globalId/globalIds (IFC GlobalId), or revitId/revitIds (Revit ElementId).';
    var limit = p.limit || 50;
    var pk = _projectKey(s);
    var out = [];
    (s.models || []).some(function(m) {
      (m.elements || []).some(function(el) {
        var pr = el.props || {};
        var gid = pr.globalId || '', rid = pr.revitId, uid2 = pr.uniqueId;
        if ((gid && wantG[gid]) || (rid != null && wantR[String(rid)]) || (uid2 && wantU[String(uid2)])) {
          out.push({ modelId: m.id, modelName: m.name, expressId: el.expressId,
            globalId: gid || null, revitId: rid != null ? rid : null,
            uniqueId: uid2 || null,
            ifcType: pr.ifcType || null, name: pr.name || null,
            storey: pr.storey || null, material: pr.material || null,
            classification: _classOf(pr),
            // Connective-spine MUST keys (element record). sourceLocalId = the
            // element's stable id (Revit UniqueId, else GlobalId, else expressId).
            source: 'clashcontrol', projectKey: pk,
            sourceLocalId: uid2 || gid || String(el.expressId) });
        }
        return out.length >= limit;
      });
      return out.length >= limit;
    });
    return { count: out.length, elements: out };
  };

  // Force the live Revit link to re-pull the model so CC catches up to the
  // current Revit state (use before a cross-tool join if revisions differ).
  // Live-link only — a no-op for plain IFC loads.
  handlers.resync = function() {
    var rd = (_getState() || {}).revitDirect || {};
    if (!rd.connected) return 'Not connected to a live Revit link — nothing to resync. (Plain IFC models are static snapshots; reload the file to refresh.)';
    if (typeof window._revitDirectExport !== 'function') return 'Revit bridge not available.';
    try { window._revitDirectExport(['all']); }
    catch (e) { return 'Resync request failed: ' + (e && e.message || e); }
    return 'Resync requested from Revit — the model will refresh shortly. Re-query get_status to confirm the new revision.';
  };

  // Per-element data-quality annotations, keyed by uniqueId/globalId. A *parallel*
  // signal for the orchestrator's triage — NOT a detection gate (a flagged proxy
  // is still clashed; it's just down-ranked). Flags: untyped_proxy, no_classification,
  // degenerate_bbox (no geometry / zero size), oversized_bbox (>200 m, almost always
  // an export error). Returns only elements that have ≥1 flag.
  handlers.get_element_quality = function(p) {
    var s = _getState();
    var pk = _projectKey(s);
    var limit = p && p.limit > 0 ? Math.floor(p.limit) : 1000;
    var models = s.models || [];
    if (p && p.modelId) models = models.filter(function(m) { return m.id === p.modelId; });
    var out = [];
    models.some(function(m) {
      (m.elements || []).some(function(el) {
        var pr = el.props || {};
        var flags = [];
        var t = (pr.ifcType || '').toLowerCase();
        if (t.indexOf('proxy') >= 0 || t === '' || t === 'element') flags.push('untyped_proxy');
        if (!_classOf(pr)) flags.push('no_classification');
        if (el.box && typeof el.box.isEmpty === 'function') {
          if (el.box.isEmpty()) flags.push('degenerate_bbox');
          else {
            var dx = el.box.max.x - el.box.min.x, dy = el.box.max.y - el.box.min.y, dz = el.box.max.z - el.box.min.z;
            if (dx < 1e-4 && dy < 1e-4 && dz < 1e-4) flags.push('degenerate_bbox');
            else if (dx > 200 || dy > 200 || dz > 200) flags.push('oversized_bbox');
          }
        }
        if (!flags.length) return false;
        out.push({ uniqueId: pr.uniqueId || null, globalId: pr.globalId || null,
          revitId: pr.revitId != null ? pr.revitId : null, expressId: el.expressId,
          modelId: m.id, source: 'clashcontrol', projectKey: pk,
          ifcType: pr.ifcType || null, name: pr.name || null, flags: flags });
        return out.length >= limit;
      });
      return out.length >= limit;
    });
    return { projectKey: pk, source: 'clashcontrol', count: out.length, annotations: out };
  };

  // Per-model level/storey elevations — raw data so the orchestrator can compute
  // floor build-up bands. NOTE: `elevation` is in the model's stored units;
  // `elevationM` is metres when unitScale is known (clash elevation in get_clashes
  // is scene metres) — reconcile on those.
  handlers.get_levels = function() {
    var s = _getState();
    var pk = _projectKey(s);
    return { projectKey: pk, source: 'clashcontrol',
      note: 'elevation = model stored units; elevationM = metres when unitScale known; get_clashes.elevation is scene metres.',
      models: (s.models || []).map(function(m) {
        var us = (m.stats && m.stats.unitScale) || null;
        return { modelId: m.id, modelName: m.name, discipline: m.discipline || 'Unknown', unitScale: us,
          levels: (m.storeyData || []).map(function(sd) {
            return { name: sd.name, id: sd.id || null, elevation: sd.elevation,
              elevationM: us != null ? sd.elevation * us : null };
          }) };
      }) };
  };

  handlers.get_grids = function() {
    var s = _getState();
    var pk = _projectKey(s);
    var seen = {}, names = [];
    (s.models || []).forEach(function(m) {
      (m.gridLines || []).forEach(function(g) { if (g && g.name && !seen[g.name]) { seen[g.name] = 1; names.push(g.name); } });
    });
    return { projectKey: pk, source: 'clashcontrol', total: names.length, grids: names,
      note: names.length ? 'Structural grids from the Revit bridge. get_clashes.gridBay gives each clash\'s nearest bay (e.g. "A-3").'
                         : 'No grids loaded. Grids come in via the Revit bridge (Connector) — not from plain IFC loads.' };
  };

  handlers.run_detection = function(p) {
    var s = _getState();
    if (!s.models || !s.models.length) return 'No models loaded. Open an IFC file first.';
    if (s.detecting) return 'Detection already in progress — poll get_status (detecting / detectionProgress) until it finishes before starting another.';
    // Resolve a scope reference (id / name / rawName / case-insensitive substring,
    // or 'all' / 'disc:<d>' / 'tag:<t>') the same way the engine's pick() does, so
    // we can reject a scope that matches NO models up front instead of silently
    // running to 0 clashes (the "scoped run returns 0 instantly" trap).
    function _resolveScope(ref) {
      if (!ref || ref === 'all') return s.models;
      var r = String(ref);
      if (r.indexOf('disc:') === 0) { var d = r.slice(5); return s.models.filter(function(m){ return (m.discipline||'') === d; }); }
      if (r.indexOf('tag:') === 0) { var t = r.slice(4).toLowerCase(); return s.models.filter(function(m){ return m.tag && m.tag.toLowerCase() === t; }); }
      var exact = s.models.filter(function(m){ return m.id === r || m.name === r || m.rawName === r; });
      if (exact.length) return exact;
      var n = r.toLowerCase();
      return s.models.filter(function(m){ return (m.name||'').toLowerCase().indexOf(n) >= 0 || (m.rawName||'').toLowerCase().indexOf(n) >= 0; });
    }
    if (p.modelA || p.modelB) {
      var names = s.models.map(function(m){ return m.name; });
      if (p.modelA && _resolveScope(p.modelA).length === 0)
        return 'modelA "' + p.modelA + '" matched no loaded model. Available: ' + JSON.stringify(names) + '. Use a full/partial name, "all", or "disc:<discipline>".';
      if (p.modelB && _resolveScope(p.modelB).length === 0)
        return 'modelB "' + p.modelB + '" matched no loaded model. Available: ' + JSON.stringify(names) + '. Use a full/partial name, "all", or "disc:<discipline>".';
    }
    var updates = {};
    if (p.modelA) updates.modelA = p.modelA;
    if (p.modelB) updates.modelB = p.modelB;
    if (p.maxGap != null) updates.maxGap = p.maxGap;
    if (p.hard != null) updates.hard = p.hard;
    if (p.excludeSelf != null) updates.excludeSelf = p.excludeSelf;
    // Rooms/spaces (IfcSpace) are excluded from detection by default. Set
    // includeSpaces:true to clash *against* rooms (e.g. space-intrusion checks).
    if (p.includeSpaces != null) updates.includeSpaces = p.includeSpaces;
    _dispatch({ t: 'UPD_RULES', u: updates });
    // Force a fresh compute: a stale type-pair "impossibility" memo from a prior
    // (crashed/empty) run can make detection short-circuit to 0 instantly. Clearing
    // it guarantees the orchestrator gets a real result (correctness over cache).
    try { if (window._ccResetTypePairMemo) window._ccResetTypePairMemo(); } catch(e) {}
    if (window._ccRunDetection) {
      // Pass `updates` as an override: _dispatch is async, so without this the
      // run would read the pre-dispatch rules (stale scope) and could test the
      // wrong/empty model pair → "0 clashes instantly". The override guarantees
      // the run uses the modelA/modelB/gap the orchestrator just asked for.
      var started = window._ccRunDetection(updates);
      if (started === false) return 'Detection already in progress — poll get_status until it finishes.';
      return 'Detection started: ' + (p.modelA || 'all') + ' vs ' + (p.modelB || 'all') +
        (p.maxGap != null ? ', gap ' + p.maxGap + 'mm' : '') + (p.hard ? ', hard clashes' : '') +
        '. Async — poll get_status (detecting/detectionProgress); results via get_clashes; failures via get_status.lastDetectionError.';
    }
    return 'Detection trigger not available. Make sure models are loaded.';
  };

  // Rule-based / cross-discipline detection (Solibri-style): run several scoped
  // rules — each a discipline/model pair with its own gap — and return the UNION
  // (deduped). Cuts volume at source vs flat all-vs-all; hosted/by-design pairs are
  // excluded at detection time (inherits useSemanticFilter). Body:
  //   { rules:[{ disciplineA?, disciplineB?, modelA?, modelB?, maxGap?, hard? }],
  //     preset?:'cross_discipline', maxGap?, hard? }
  // With no rules, preset 'cross_discipline' auto-builds every distinct discipline
  // pair present (arch×structural, arch×mep, structural×mep, …).
  handlers.run_detection_ruleset = function(p) {
    var s = _getState();
    if (!s.models || !s.models.length) return 'No models loaded. Open a model first.';
    if (s.detecting) return 'Detection already in progress — poll get_status until it finishes.';
    var gap = p.maxGap != null ? p.maxGap : 10;
    var hard = p.hard != null ? !!p.hard : true;
    var rules = Array.isArray(p.rules) && p.rules.length ? p.rules.map(function(r) {
      return {
        modelA: r.modelA || (r.disciplineA ? 'disc:' + r.disciplineA : 'all'),
        modelB: r.modelB || (r.disciplineB ? 'disc:' + r.disciplineB : 'all'),
        maxGap: r.maxGap != null ? r.maxGap : gap,
        hard: r.hard != null ? !!r.hard : hard
      };
    }) : null;
    if (!rules) {
      // Preset: every distinct discipline pair present among loaded models.
      var discs = {};
      (s.models || []).forEach(function(m) { if (m.discipline) discs[m.discipline] = true; });
      var list = Object.keys(discs);
      if (list.length < 2) return 'Need at least 2 disciplines for cross-discipline detection. Loaded: ' + JSON.stringify(list) + '. Pass explicit rules[] instead.';
      rules = [];
      for (var i = 0; i < list.length; i++)
        for (var j = i + 1; j < list.length; j++)
          rules.push({ modelA: 'disc:' + list[i], modelB: 'disc:' + list[j], maxGap: gap, hard: hard });
    }
    if (window._ccRunDetectionRuleset) {
      var started = window._ccRunDetectionRuleset(rules);
      if (started === false) return 'Could not start (already running, or no models).';
      return 'Ruleset detection started: ' + rules.length + ' rule(s) — ' +
        rules.map(function(r){ return r.modelA + '×' + r.modelB + (r.maxGap != null ? '@' + r.maxGap + 'mm' : ''); }).join(', ') +
        '. Async — poll get_status (detecting/detectionProgress); results via get_clashes (union, deduped).';
    }
    return 'Ruleset detection not available.';
  };

  // Reset a wedged/stuck detection from the MCP side (no browser restart needed).
  // Clears the detecting flag so a fresh run_detection can start.
  handlers.cancel_detection = function() {
    var wasDetecting = !!(_getState() || {}).detecting;
    try {
      if (window._ccCancelDetection) window._ccCancelDetection();
      else _dispatch({ t: 'STOP_DETECT' });
    } catch (e) { return 'Cancel failed: ' + (e && e.message || e); }
    try { window._ccDetectProgress = null; } catch (e) {}
    return wasDetecting ? 'Detection cancelled and reset — you can run_detection again.'
                        : 'No detection was running; state reset anyway.';
  };

  // Receiver for Loam's outcome feedback (push_detection_feedback). CC consumes it
  // to stop auto-suppressing element-type pairs whose suppression turned out to eat
  // REAL clashes. Local-first: stored per projectKey, applied on the next run.
  // Payload: { projectKey?, feedback:{ byRule:[{key,real,false,realRate,recommendation}],
  //            byPair:[{key,real,false,realRate,recommendation}] } }
  var _FEEDBACK_REALRATE_TH = 0.34; // realRate >= this => stop suppressing that pair
  function _loadDetectionFeedback() {
    // Restore the most recent stored payload on page load so it survives refresh.
    try {
      var latest = null;
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('cc_detection_feedback:') === 0) {
          var v = JSON.parse(localStorage.getItem(k));
          if (v && (!latest || (v.ts || 0) > (latest.ts || 0))) latest = v;
        }
      }
      if (latest) window._ccDetectionFeedback = latest;
    } catch (e) {}
  }
  _loadDetectionFeedback();

  handlers.ingest_detection_feedback = function(p) {
    var s = _getState();
    var pk = p.projectKey || _projectKey(s);
    var fb = p.feedback || {};
    var byRule = Array.isArray(fb.byRule) ? fb.byRule : [];
    var byPair = Array.isArray(fb.byPair) ? fb.byPair : [];
    var payload = { projectKey: pk, byRule: byRule, byPair: byPair, ts: Date.now() };
    try { localStorage.setItem('cc_detection_feedback:' + pk, JSON.stringify(payload)); } catch (e) {}
    try { window._ccDetectionFeedback = payload; } catch (e) {}
    var protectedPairs = byPair.filter(function (e) {
      var rate = (e && e.realRate != null) ? e.realRate
        : ((e && e.real || 0) / Math.max(1, (e && e.real || 0) + (e && e['false'] || 0)));
      return rate >= _FEEDBACK_REALRATE_TH;
    }).map(function (e) { return e.key; });
    return { ok: true, projectKey: pk,
      received: { rules: byRule.length, pairs: byPair.length },
      protectedPairs: protectedPairs,
      note: 'Stored. On the next detection run, type-pairs with realRate >= ' + _FEEDBACK_REALRATE_TH +
        ' are no longer auto-suppressed by the type-pair memo (CC stops eating those real clashes). ' +
        'byRule is stored for inspection; the actionable hook is byPair -> the type-pair impossibility memo.' };
  };

  handlers.set_detection_rules = function(p) {
    var u = {};
    if (p.maxGap != null) u.maxGap = p.maxGap;
    if (p.hard != null) u.hard = p.hard;
    if (p.excludeSelf != null) u.excludeSelf = p.excludeSelf;
    if (p.duplicates != null) u.duplicates = p.duplicates;
    _dispatch({ t: 'UPD_RULES', u: u }); return 'Detection rules updated.';
  };

  handlers.update_clash = function(p) {
    var s = _getState(); var clashes = s.clashes || [];
    var _remapped = 0;
    function apply(q, target) {
      var u = {};
      if (q.status) {
        // Guard the AI-sweep auto-resolve incident: 'resolved' means a real clash
        // was ACTUALLY FIXED (a human/Revit action CC can't verify). The bridge
        // (an AI/agent) must bucket, not decide — so route 'resolved' to the
        // reversible 'expected' (suppressed/by-design) bucket instead. Keeps it out
        // of the open count, re-openable, and never destroys the signal.
        if (q.status === 'resolved') { u.status = 'expected'; _remapped++; }
        else u.status = q.status;
      }
      if (q.priority) u.priority = q.priority;
      if (q.assignee != null) u.assignee = q.assignee; if (q.title) u.title = q.title;
      _dispatch({ t: 'UPD_CLASH', id: target.id, u: u });
    }
    if (Array.isArray(p.items)) {
      // Resolve every target from the snapshot BEFORE mutating so a batch
      // can't act on an index that shifted mid-run.
      var pairs = p.items.map(function(q){
        return { q:q, t:(q.clashIndex>=0 && q.clashIndex<clashes.length) ? clashes[q.clashIndex] : null };
      });
      var done=0, bad=0;
      pairs.forEach(function(pr){ if (pr.t) { apply(pr.q, pr.t); done++; } else bad++; });
      return 'Updated ' + done + ' clash' + (done===1?'':'es') + (bad?' ('+bad+' invalid index)':'') +
        (_remapped ? ' — ' + _remapped + " routed to 'expected' (by-design/suppressed): the bridge does not mark clashes 'resolved' (that means actually fixed). Re-openable." : '') + '.';
    }
    if (p.clashIndex < 0 || p.clashIndex >= clashes.length) return 'Invalid clash index.';
    apply(p, clashes[p.clashIndex]);
    return 'Updated clash ' + (p.clashIndex + 1) + '.' +
      (_remapped ? " Status routed to 'expected' (by-design/suppressed) — the bridge does not set 'resolved' (= actually fixed). Re-openable." : '');
  };

  handlers.batch_update_clashes = function(p) {
    // Same guard as update_clash: never let a bulk AI action mark clashes
    // 'resolved' (the all-7,420-resolved incident). Bucket into 'expected' instead.
    var action = String(p.action || '').toLowerCase();
    if (/resolv/.test(action)) {
      return "Refused: the bridge does not bulk-'resolve' clashes ('resolved' = a real clash actually fixed, which an agent can't verify). " +
        "To suppress by-design/false-positive clashes, use action 'expected' (reversible, kept out of the open count) — e.g. batch_update_clashes(action:'expected', filter:'" + (p.filter||'') + "').";
    }
    if (window._ccProcessNLCommand) return window._ccProcessNLCommand('batch ' + p.action + ' ' + p.filter) || 'Batch update applied.';
    return 'Batch update: not available.';
  };

  handlers.set_view = function(p) {
    var viewMap = { top: 'top view', front: 'front view', back: 'back view', left: 'left view', right: 'right view', isometric: 'isometric view', reset: 'reset view' };
    if (window._ccProcessNLCommand) { window._ccProcessNLCommand(viewMap[p.view] || p.view); return (p.view === 'reset' ? 'View reset.' : p.view.charAt(0).toUpperCase() + p.view.slice(1) + ' view.'); }
    return 'View change not available.';
  };

  handlers.set_render_style = function(p) { _dispatch({ t: 'RENDER_STYLE', v: p.style || 'shaded' }); return 'Render style: ' + p.style; };
  handlers.set_section = function(p) {
    if (p.axis === 'none' || !p.axis) { _dispatch({ t: 'SECTION', axis: null }); return 'Section cleared.'; }
    var pos = null;
    if (p.position != null) {
      // Convert absolute world position to relative 0-1 using current model bounds
      var bounds = window._ccViewport && window._ccViewport.getBounds();
      if (bounds) {
        var axIdx = {x:0, y:1, z:2}[p.axis];
        if (axIdx != null) {
          var span = bounds.max[axIdx] - bounds.min[axIdx];
          if (span > 0) pos = Math.max(0.01, Math.min(0.99, (p.position - bounds.min[axIdx]) / span));
        }
      }
    }
    var act = { t: 'SECTION', axis: p.axis };
    if (pos != null) act.pos = pos;
    _dispatch(act);
    return 'Section cut: ' + p.axis.toUpperCase() + (pos != null ? ' at ' + Number(p.position).toFixed(2) : '') + '.';
  };
  handlers.color_by = function(p) { var v = p.by === 'none' ? null : 'by' + p.by.charAt(0).toUpperCase() + p.by.slice(1); _dispatch({ t: 'COLOR_BY_CLASS', v: v }); return p.by === 'none' ? 'Colors reset.' : 'Colored by ' + p.by + '.'; };
  handlers.set_theme = function(p) { document.documentElement.setAttribute('data-theme', p.theme); try { localStorage.setItem('cc_theme', p.theme); } catch (e) {} return p.theme.charAt(0).toUpperCase() + p.theme.slice(1) + ' theme.'; };
  handlers.set_visibility = function(p) { if (p.option === 'grid') _dispatch({ t: 'TOGGLE_GRID', v: p.visible }); else if (p.option === 'axes') _dispatch({ t: 'TOGGLE_AXES', v: p.visible }); else if (p.option === 'markers') _dispatch({ t: 'TOGGLE_MARKERS', v: p.visible }); return (p.visible ? 'Showing' : 'Hiding') + ' ' + p.option + '.'; };
  handlers.restore_visibility = function() { if (window._unghostAll) window._unghostAll(); return 'All elements restored.'; };

  handlers.isolate_elements = function(p) {
    var s = _getState();
    var models = s.models || [];
    if (!models.length) return 'No models loaded.';

    // Mode: 'ghost' (default) = ghost others, 'hide' = hide via class visibility, 'show_all' = reset
    var mode = p.mode || 'ghost';

    if (mode === 'show_all' || mode === 'reset') {
      if (window._unghostAll) window._unghostAll();
      _dispatch({ t: 'SHOW_ALL_CLASSES' });
      return 'All elements visible.';
    }

    // Build list of target expressIds from filter criteria
    var targets = [];
    models.forEach(function(m) {
      (m.elements || []).forEach(function(el) {
        var pr = el.props || {};
        var match = true;
        if (p.ifcType && pr.ifcType !== p.ifcType) match = false;
        if (p.storey && pr.storey !== p.storey) match = false;
        if (p.discipline && m.discipline !== p.discipline) match = false;
        if (p.material && (!pr.material || pr.material.indexOf(p.material) < 0)) match = false;
        if (p.expressIds && p.expressIds.indexOf(el.expressId) < 0) match = false;
        if (match) targets.push({ expressId: el.expressId, modelId: m.id });
      });
    });

    if (!targets.length) return 'No elements matched the filter.';

    if (mode === 'ghost') {
      // Ghost everything except targets
      if (window._ghostOthers) window._ghostOthers(targets);
      return 'Isolated ' + targets.length + ' elements (others ghosted).';
    }

    if (mode === 'hide') {
      // Use class visibility to hide matched elements
      // Build class keys from targets
      var s2 = _getState();
      var cls = s2.classifications || {};
      var viewKey = p.classView || 'byType';
      var groups = cls[viewKey] || {};
      var keysToHide = [];
      Object.keys(groups).forEach(function(k) {
        var grp = groups[k];
        if (!grp || !grp.items) return;
        var anyMatch = grp.items.some(function(it) {
          return targets.some(function(t) { return t.expressId === it.expressId; });
        });
        if (anyMatch) keysToHide.push(viewKey + ':' + k);
      });
      keysToHide.forEach(function(key) { _dispatch({ t: 'TOGGLE_CLASS_VIS', key: key }); });
      return 'Hidden ' + keysToHide.length + ' classification groups containing ' + targets.length + ' elements.';
    }

    return 'Unknown mode: ' + mode + '. Use ghost, hide, show_all, or reset.';
  };
  handlers.fly_to_clash = function(p) { var s = _getState(); var cl = s.clashes || []; if (p.clashIndex < 0 || p.clashIndex >= cl.length) return 'Invalid clash index.'; _dispatch({ t: 'SELECT_CLASH', id: cl[p.clashIndex].id }); return 'Flying to clash ' + (p.clashIndex + 1) + '.'; };
  handlers.navigate_tab = function(p) { _dispatch({ t: 'TAB', v: p.tab }); return 'Switched to ' + p.tab + ' tab.'; };
  handlers.filter_clashes = function(p) { var u = {}; if (p.status) u.status = p.status; if (p.priority) u.priority = p.priority; _dispatch({ t: 'UPD_FILTERS', u: u }); return 'Filters updated.'; };
  handlers.sort_clashes = function(p) { _dispatch({ t: 'CLASH_SORT', v: p.sortBy }); return 'Sorted by ' + p.sortBy + '.'; };
  handlers.group_clashes = function(p) { _dispatch({ t: 'CLASH_GROUP_BY', v: p.groupBy === 'none' ? [] : [p.groupBy] }); return 'Grouped by ' + p.groupBy + '.'; };
  handlers.export_bcf = function(p) { var s = _getState(); var items = s.issues && s.issues.length ? s.issues : (s.clashes || []); if (!items.length) return 'Nothing to export.'; if (window._ccExportBCF) { window._ccExportBCF(items, p.version || '2.1'); return 'Exported ' + items.length + ' items as BCF.'; } return 'BCF export not available.'; };
  handlers.import_bcf = function(p) {
    if (!window._ccImportBCF) return 'BCF import not available.';
    // Two modes: an agent with the file passes base64 BCF content (parsed
    // directly, no dialog); otherwise open the file picker for the user.
    var b64 = p && (p.base64 || p.bcfBase64 || p.content);
    if (b64) {
      var ok = window._ccImportBCF({ base64: String(b64) });
      return ok ? 'Importing BCF — topics are being added as issues (check the Issues tab).'
                : 'Could not read the provided BCF content. Pass a base64-encoded .bcf/.bcfzip.';
    }
    window._ccImportBCF();
    return 'Opened the BCF import dialog in ClashControl — choose a .bcf/.bcfzip file to import its topics as issues. (To import without a dialog, pass the file as base64.)';
  };
  handlers.create_project = function(p) { _dispatch({ t: 'CREATE_PROJECT', name: p.name }); return 'Project "' + p.name + '" created.'; };
  handlers.switch_project = function(p) { var s = _getState(); var projects = s.projectList || []; var match = projects.find(function(pr) { return (pr.name || '').toLowerCase().indexOf(p.name.toLowerCase()) >= 0; }); if (match) { _dispatch({ t: 'SET_PROJECT', id: match.id }); return 'Switched to "' + match.name + '".'; } return 'Project "' + p.name + '" not found.'; };
  handlers.measure = function(p) {
    if (p.mode === 'stop') { _dispatch({ t: 'MEASURE_MODE', v: null }); return 'Measurement stopped.'; }
    if (p.mode === 'clear') { _dispatch({ t: 'CLEAR_MEASUREMENTS' }); return 'Measurements cleared.'; }
    var mode = p.mode;
    // Backwards-compat: 'point' / 'edge' both map to 'length'
    if (mode === 'point' || mode === 'edge') mode = 'length';
    _dispatch({ t: 'MEASURE_MODE', v: mode });
    if (mode === 'clearance') window._ccClearancePickA = null;
    return 'Measurement mode: ' + mode + '.';
  };
  handlers.takeoff = function(p) {
    var f = (p && p.filter) || '';
    if (!f || !window._ccComputeTakeoff) return 'Provide an IFC type filter.';
    window._ccComputeTakeoff(f);
    var r = window._ccLastTakeoff;
    if (!r) return 'Takeoff failed.';
    return 'Takeoff "' + f + '": ' + r.count + ' element' + (r.count===1?'':'s') +
           (r.totalLength!=null ? ', length ' + r.totalLength.toFixed(2) + ' m' : '') +
           (r.totalArea!=null   ? ', area '   + r.totalArea.toFixed(2)   + ' m²' : '') +
           (r.totalVolume!=null ? ', volume ' + r.totalVolume.toFixed(2) + ' m³' : '') + '.';
  };
  handlers.set_measure_units = function(p) {
    var v = (p && p.units) || 'auto';
    _dispatch({ t: 'UPD_PREFS', u: { measureUnits: v } });
    return 'Units set to ' + v + '.';
  };
  handlers.walk_mode = function(p) {
    if (p.enabled) {
      _dispatch({ t: 'WALK_MODE', v: true });
      if (window._ccWalkEnter) { var s = _getState(); var elev = 0; if (s.floorPlan) elev = s.floorPlan.elevation; else { var storeys = (typeof _ccCollectStoreys === 'function') ? _ccCollectStoreys(s.models || []) : []; if (storeys.length) { var gf = (typeof _ccStoreyToGeoFactor === 'function') ? _ccStoreyToGeoFactor(s.models || []) : 1; elev = storeys[0].elevation * gf; } } window._ccWalkEnter(elev); }
      return 'Walk mode activated.';
    } else { if (window._ccWalkExit) window._ccWalkExit(); _dispatch({ t: 'WALK_MODE', v: false }); return 'Walk mode deactivated.'; }
  };

  // ── 2D sheet / floor plan handlers ──────────────────────────────

  handlers.create_2d_sheet = function(p) {
    var s = _getState();
    if (!s.models || !s.models.length) return 'No models loaded.';
    var storeys = (typeof _ccCollectStoreys === 'function') ? _ccCollectStoreys(s.models) : [];
    var elevation = null, storeyName = null;

    if (p.floorName) {
      var match = storeys.find(function(st) { return st.name.toLowerCase().indexOf(p.floorName.toLowerCase()) >= 0; });
      if (match) { elevation = match.elevation; storeyName = match.name; }
      else return 'Storey "' + p.floorName + '" not found. Available: ' + storeys.map(function(st) { return st.name; }).join(', ');
    } else if (p.height != null) {
      elevation = p.height;
      storeyName = 'Cut at ' + p.height;
    } else if (storeys.length) {
      elevation = storeys[0].elevation;
      storeyName = storeys[0].name;
    } else {
      return 'No storey data and no height specified.';
    }

    // Build sheet using same logic as _ccMakeSheet (exposed as window._ccMakeSheet)
    var sheet;
    if (window._ccMakeSheet) {
      sheet = window._ccMakeSheet(storeyName, elevation);
    } else {
      var gf = (typeof _ccStoreyToGeoFactor === 'function') ? _ccStoreyToGeoFactor(s.models) : 1;
      var id = 'SH' + Date.now().toString(36).toUpperCase();
      sheet = {
        id: id, name: storeyName + ' Plan', storeyName: storeyName,
        elevation: elevation * gf, _storeyElevation: elevation, cutHeight: 1.2,
        scale: { pxPerMeter: 100 }, paper: { size: 'A3', orient: 'landscape' },
        titleBlock: { project: '', author: '', date: new Date().toLocaleDateString(), revision: '', notes: '' },
        northDeg: 0, createdAt: Date.now(), updatedAt: Date.now()
      };
    }
    // Apply optional scale override (e.g. '1:50', '1:200')
    if (p.scale) {
      var scaleNum = parseFloat(('' + p.scale).replace(/[^0-9.]/g, ''));
      if (scaleNum > 0) sheet.scale = { pxPerMeter: Math.round(10000 / scaleNum) };
    }

    _dispatch({ t: 'SHEET_ADD', v: sheet });
    _dispatch({ t: 'UNDERLAY_MODE', v: 'view2d' });

    // Trigger export after sheet renders if format specified
    if (p.format) {
      var fmt = (p.format || '').toLowerCase();
      setTimeout(function() {
        if (fmt === 'dxf' && window._ccDoExportDXF) window._ccDoExportDXF();
        else if (fmt === 'pdf' && window._ccDoExportPDF) window._ccDoExportPDF();
        else if (window._ccDoExportPNG) window._ccDoExportPNG();
      }, 800);
    }

    return { sheetId: sheet.id, name: sheet.name, storeyName: storeyName, elevation: elevation };
  };

  handlers.list_storeys = function() {
    var s = _getState();
    var storeys = (typeof _ccCollectStoreys === 'function') ? _ccCollectStoreys(s.models || []) : [];
    if (!storeys.length) return { storeys: [], note: 'No storey data found. IFC files need IfcBuildingStorey entities.' };
    return { storeys: storeys.map(function(st) { return { name: st.name, elevation: st.elevation }; }) };
  };

  handlers.exit_floor_plan = function() {
    _dispatch({ t: 'FLOOR_PLAN', v: null });
    return 'Floor plan view exited.';
  };

  handlers.list_2d_sheets = function() {
    var s = _getState();
    var sheets = s.sheets || [];
    if (!sheets.length) return { sheets: [], note: 'No sheets yet. Use create_2d_sheet to create one.' };
    var markups = s.markups || [];
    return {
      sheets: sheets.map(function(sh) {
        return { id: sh.id, name: sh.name, storeyName: sh.storeyName, elevation: sh._storeyElevation || sh.elevation, annotationCount: markups.filter(function(m) { return m.sheetId === sh.id; }).length };
      }),
      activeSheetId: s.activeSheetId || null
    };
  };

  handlers.export_sheet = function(p) {
    var s = _getState();
    var sheets = s.sheets || [];
    if (p.sheetId) {
      var found = sheets.find(function(sh) { return sh.id === p.sheetId || sh.name === p.sheetId; });
      if (!found) return 'Sheet "' + p.sheetId + '" not found. Available: ' + sheets.map(function(sh) { return sh.id + ' (' + sh.name + ')'; }).join(', ');
      _dispatch({ t: 'SHEET_SET_ACTIVE', id: found.id });
    } else if (!s.activeSheetId) {
      if (!sheets.length) return 'No sheets exist. Use create_2d_sheet first.';
      _dispatch({ t: 'SHEET_SET_ACTIVE', id: sheets[0].id });
    }
    var fmt = ((p.format || 'png') + '').toLowerCase();
    setTimeout(function() {
      if (fmt === 'dxf' && window._ccDoExportDXF) window._ccDoExportDXF();
      else if (fmt === 'pdf' && window._ccDoExportPDF) window._ccDoExportPDF();
      else if (window._ccDoExportPNG) window._ccDoExportPNG();
    }, 300);
    return 'Exporting sheet as ' + fmt.toUpperCase() + '.';
  };

  handlers.delete_sheet = function(p) {
    var s = _getState();
    var sheets = s.sheets || [];
    var found = sheets.find(function(sh) { return sh.id === p.sheetId || sh.name === p.sheetId; });
    if (!found) return 'Sheet "' + p.sheetId + '" not found. Available IDs: ' + sheets.map(function(sh) { return sh.id; }).join(', ');
    _dispatch({ t: 'SHEET_DEL', id: found.id });
    return 'Deleted sheet "' + found.name + '".';
  };

  // ── 2D viewport control handlers ─────────────────────────────

  handlers.pan_2d_sheet = function(p) {
    if (window._cc2DSetPan) { window._cc2DSetPan(p.x || 0, p.y || 0); return 'Panned 2D view by (' + (p.x || 0) + ', ' + (p.y || 0) + ') px.'; }
    return '2D view not active.';
  };

  handlers.zoom_2d_sheet = function(p) {
    if (window._cc2DSetZoom) { window._cc2DSetZoom(p.level || 1); return 'Zoom set to ' + (p.level || 1) + 'x.'; }
    return '2D view not active.';
  };

  handlers.fit_2d_bounds = function() {
    if (window._ccFit2DOutlines) { window._ccFit2DOutlines(); return 'View fitted to floor plan bounds.'; }
    return '2D view not active.';
  };

  // ── 2D annotation handlers ────────────────────────────────────

  handlers.add_annotation = function(p) {
    var s = _getState();
    if (!s.activeSheetId) return 'No active sheet. Use create_2d_sheet first.';
    function one(q) {
      var id = window._ccUid ? window._ccUid() : 'mk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      var type = q.type || 'text';
      var pts = (type === 'pin' || type === 'text')
        ? [q.x || 0, q.y || 0, q.x || 0, q.y || 0]
        : [q.x || 0, q.y || 0, (q.x2 != null ? q.x2 : q.x || 0), (q.y2 != null ? q.y2 : q.y || 0)];
      _dispatch({ t: 'ADD_MARKUP', v: { id: id, type: type, color: q.color || '#f59e0b', text: q.text || '', points: pts } });
      return type;
    }
    if (Array.isArray(p.items)) {
      var types = p.items.map(one);
      return 'Added ' + types.length + ' annotations to active sheet.';
    }
    one(p);
    return 'Added ' + (p.type || 'text') + ' annotation to active sheet.';
  };

  handlers.measure_on_sheet = function(p) {
    var s = _getState();
    if (!s.activeSheetId) return 'No active sheet. Use create_2d_sheet first.';
    if (!p.points || p.points.length < 4) return 'Provide at least two world-space points: [x1, z1, x2, z2] in metres.';
    var id = window._ccUid ? window._ccUid() : 'mk_' + Date.now();
    var dx = p.points[2] - p.points[0], dz = p.points[3] - p.points[1];
    var dist = Math.sqrt(dx * dx + dz * dz);
    var label = dist < 1 ? (dist * 1000).toFixed(0) + ' mm' : dist.toFixed(2) + ' m';
    _dispatch({ t: 'ADD_MARKUP', v: { id: id, type: 'dimension', color: p.color || '#60a5fa', points: p.points.slice(0, 4), text: label } });
    return 'Dimension added: ' + label + '.';
  };

  // ── Issue management handlers ─────────────────────────────────

  handlers.create_issue = function(p) {
    function one(q) {
      // Random suffix so a bulk create in the same millisecond can't collide
      // when _ccUid is unavailable.
      var id = (window._ccUid) ? window._ccUid() : 'i_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      var issue = {
        id: id, title: q.title || 'New Issue', description: q.description || '',
        status: q.status || 'open', priority: q.priority || 'normal',
        assignee: q.assignee || '', category: q.category || 'coordination',
        createdAt: new Date().toISOString()
      };
      // Element linkage — without this a promoted/created issue has globalIds:[] and
      // can't be joined back to the model / Loam. Accept per-side ids or arrays.
      if (q.globalIdA) issue.globalIdA = q.globalIdA;
      if (q.globalIdB) issue.globalIdB = q.globalIdB;
      if (Array.isArray(q.globalIds) && q.globalIds.length) {
        issue.qualityGids = q.globalIds.slice();
        if (!issue.globalIdA) issue.globalIdA = q.globalIds[0] || null;
        if (!issue.globalIdB && q.globalIds[1]) issue.globalIdB = q.globalIds[1];
      }
      if (q.revitIdA != null) issue.revitIdA = q.revitIdA;
      if (q.revitIdB != null) issue.revitIdB = q.revitIdB;
      if (Array.isArray(q.revitIds) && q.revitIds.length) {
        issue.revitIds = q.revitIds.slice();
        if (issue.revitIdA == null) issue.revitIdA = q.revitIds[0];
        if (issue.revitIdB == null && q.revitIds[1] != null) issue.revitIdB = q.revitIds[1];
      }
      if (q.uniqueIdA) issue.uniqueIdA = q.uniqueIdA;
      if (q.uniqueIdB) issue.uniqueIdB = q.uniqueIdB;
      if (Array.isArray(q.uniqueIds) && q.uniqueIds.length) {
        issue.uniqueIds = q.uniqueIds.slice();
        if (!issue.uniqueIdA) issue.uniqueIdA = q.uniqueIds[0] || null;
        if (!issue.uniqueIdB && q.uniqueIds[1]) issue.uniqueIdB = q.uniqueIds[1];
      }
      if (q.storey) issue.storey = q.storey;
      if (q.classification) issue.classification = q.classification;
      if (q.clashId) issue.linkedClashId = q.clashId;
      _dispatch({ t: 'ADD_ISSUE', v: issue });
      return issue.title;
    }
    if (Array.isArray(p.items)) {
      var titles = p.items.map(one);
      return 'Created ' + titles.length + ' issues: ' + titles.map(function(t){return '"'+t+'"';}).join(', ') + '.';
    }
    one(p);
    return 'Issue "' + (p.title || 'New Issue') + '" created.';
  };

  // Promote one (or many via items[]) detected clash to a coordination issue,
  // COPYING the clash's element identity (uniqueId/globalId/revitId per side),
  // storey, types, disciplines and classification — so the Issue is joinable back
  // to the model / Loam. Links the clash → issue (linkedIssueId); does NOT resolve
  // the clash (CC buckets/signals, it doesn't decide a clash is fixed).
  handlers.promote_clash_to_issue = function(p) {
    var s = _getState(); var clashes = s.clashes || [];
    function promote(idx, extra) {
      var c = (idx >= 0 && idx < clashes.length) ? clashes[idx] : null;
      if (!c) return null;
      extra = extra || {};
      var id = (window._ccUid) ? window._ccUid() : 'i_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      var issue = {
        id: id,
        title: extra.title || c.title || c.aiTitle || ('Clash ' + (idx + 1)),
        description: extra.description || c.aiReason || c.description || '',
        status: extra.status || 'open', priority: extra.priority || c.priority || 'normal',
        assignee: extra.assignee || '', category: 'coordination', createdAt: new Date().toISOString(),
        // In-app navigation: the Issues UI Zoom A/B / Box / highlight read
        // elemA/elemB + modelAId/modelBId + point (via _itemRefs) — same fields the
        // native "From clash" button sets. Without these the zoom buttons no-op.
        elemA: c.elemA != null ? c.elemA : null, elemB: c.elemB != null ? c.elemB : null,
        modelAId: c.modelAId || null, modelBId: c.modelBId || null,
        point: c.point || null,
        clashId: c.id || null, clashIdentityKey: c._identityKey || null,
        // Cross-tool join identity per side.
        globalIdA: c.globalIdA || null, globalIdB: c.globalIdB || null,
        revitIdA: c.revitIdA != null ? c.revitIdA : null, revitIdB: c.revitIdB != null ? c.revitIdB : null,
        uniqueIdA: c.uniqueIdA || null, uniqueIdB: c.uniqueIdB || null,
        storey: c.storey || c.elemAStorey || c.elemBStorey || '',
        elemAType: c.elemAType || null, elemBType: c.elemBType || null,
        disciplines: c.disciplines || null,
        classificationA: _classByElem(c.modelAId, c.elemA),
        classificationB: _classByElem(c.modelBId, c.elemB),
        linkedClashId: c.id || null
      };
      _dispatch({ t: 'ADD_ISSUE', v: issue });
      if (c.id) _dispatch({ t: 'UPD_CLASH', id: c.id, u: { linkedIssueId: id } });
      return issue.title;
    }
    if (Array.isArray(p.items)) {
      var done = 0, bad = 0;
      p.items.forEach(function(q){ if (promote(q.clashIndex, q) != null) done++; else bad++; });
      return 'Promoted ' + done + ' clash' + (done === 1 ? '' : 'es') + ' to issues' + (bad ? ' (' + bad + ' invalid index)' : '') + '.';
    }
    var t = promote(p.clashIndex, p);
    return t != null ? 'Promoted clash ' + (p.clashIndex + 1) + ' to issue "' + t + '" (element link copied).'
                     : 'Invalid clash index.';
  };

  handlers.update_issue = function(p) {
    var s = _getState(); var issues = s.issues || [];
    function apply(q, target) {
      var u = {};
      if (q.status) u.status = q.status;
      if (q.priority) u.priority = q.priority;
      if (q.assignee != null) u.assignee = q.assignee;
      if (q.title) u.title = q.title;
      if (q.description != null) u.description = q.description;
      _dispatch({ t: 'UPD_ISSUE', id: target.id, u: u });
    }
    if (Array.isArray(p.items)) {
      var pairs = p.items.map(function(q){
        return { q:q, t:(q.issueIndex>=0 && q.issueIndex<issues.length) ? issues[q.issueIndex] : null };
      });
      var done=0, bad=0;
      pairs.forEach(function(pr){ if (pr.t) { apply(pr.q, pr.t); done++; } else bad++; });
      return 'Updated ' + done + ' issue' + (done===1?'':'s') + (bad?' ('+bad+' invalid index)':'') + '.';
    }
    if (p.issueIndex < 0 || p.issueIndex >= issues.length) return 'Invalid issue index.';
    apply(p, issues[p.issueIndex]);
    return 'Updated issue ' + (p.issueIndex + 1) + '.';
  };

  handlers.delete_issue = function(p) {
    var s = _getState(); var issues = s.issues || [];
    if (Array.isArray(p.items)) {
      // Resolve ids up front so deleting one doesn't shift the indices of
      // the rest mid-batch (the index-fragility trap).
      var ids = [], bad = 0;
      p.items.forEach(function(q){
        if (q.issueIndex >= 0 && q.issueIndex < issues.length) ids.push(issues[q.issueIndex].id); else bad++;
      });
      ids.forEach(function(id){ _dispatch({ t: 'DEL_ISSUE', id: id }); });
      return 'Deleted ' + ids.length + ' issue' + (ids.length===1?'':'s') + (bad?' ('+bad+' invalid index)':'') + '.';
    }
    if (p.issueIndex < 0 || p.issueIndex >= issues.length) return 'Invalid issue index.';
    _dispatch({ t: 'DEL_ISSUE', id: issues[p.issueIndex].id });
    return 'Deleted issue ' + (p.issueIndex + 1) + '.';
  };

  // ── Data quality handler ──────────────────────────────────────

  handlers.run_data_quality = function() {
    var s = _getState();
    if (!s.models || !s.models.length) return 'No models loaded.';
    var allElements = [];
    s.models.forEach(function(m) { (m.elements || []).forEach(function(el) { allElements.push(el); }); });
    var results = {};
    if (window._ccRunDataQualityChecks) results.general = window._ccRunDataQualityChecks(allElements);
    if (window._ccRunBIMModelChecks) results.bim = window._ccRunBIMModelChecks(allElements);
    return results;
  };

  // ── Section with position parameter ───────────────────────────

  handlers.set_section_at = function(p) {
    var axis = p.axis || 'y';
    var position = p.position;
    if (position == null) return 'Position required.';
    // Use floor plan for horizontal cuts (Y axis)
    if (axis === 'y') {
      _dispatch({ t: 'FLOOR_PLAN', v: { storeyName: 'Section at ' + position, elevation: position, cutHeight: p.cutHeight || 1.2 } });
      return 'Horizontal section at Y=' + position + '.';
    }
    // For X/Z, convert absolute world position to relative 0-1 using model bounds
    var relPos = 0.5;
    var bounds = window._ccViewport && window._ccViewport.getBounds();
    if (bounds) {
      var axIdx = {x:0, y:1, z:2}[axis];
      if (axIdx != null) {
        var span = bounds.max[axIdx] - bounds.min[axIdx];
        if (span > 0) relPos = Math.max(0.01, Math.min(0.99, (position - bounds.min[axIdx]) / span));
      }
    }
    _dispatch({ t: 'SECTION', axis: axis, pos: relPos });
    return 'Section plane on ' + axis.toUpperCase() + ' at ' + position + '.';
  };

  // ── Model management handlers ───────────────────────────────────

  handlers.delete_model = function(p) {
    var s = _getState(); var models = s.models || [];
    var match = models.find(function(m) { return m.name.toLowerCase() === (p.name || '').toLowerCase(); });
    if (!match) {
      match = models.find(function(m) { return m.name.toLowerCase().indexOf((p.name || '').toLowerCase()) >= 0; });
    }
    if (!match) return 'Model "' + p.name + '" not found. Loaded: ' + models.map(function(m) { return m.name; }).join(', ');
    _dispatch({ t: 'DEL_MODEL', id: match.id });
    return 'Removed model "' + match.name + '".';
  };

  handlers.rename_model = function(p) {
    var s = _getState(); var models = s.models || [];
    var match = models.find(function(m) { return m.name.toLowerCase() === (p.oldName || '').toLowerCase(); });
    if (!match) {
      match = models.find(function(m) { return m.name.toLowerCase().indexOf((p.oldName || '').toLowerCase()) >= 0; });
    }
    if (!match) return 'Model "' + p.oldName + '" not found.';
    _dispatch({ t: 'UPD_MODEL', id: match.id, u: { name: p.newName } });
    return 'Renamed "' + match.name + '" to "' + p.newName + '".';
  };

  handlers.get_model_info = function(p) {
    var s = _getState(); var models = s.models || [];
    var match = models.find(function(m) { return m.name.toLowerCase().indexOf((p.name || '').toLowerCase()) >= 0; });
    if (!match && models.length === 1) match = models[0];
    if (!match) return 'Model "' + (p.name || '') + '" not found.';
    return {
      name: match.name, discipline: match.discipline || 'Unknown',
      elementCount: (match.elements || []).length,
      meshCount: (match.meshes || []).length,
      storeys: (match.storeyData || []).map(function(st) { return { name: st.name, elevation: st.elevation }; }),
      visible: match.visible !== false,
      stats: match.stats || {},
      color: match.color || null
    };
  };

  handlers.toggle_model = function(p) {
    var s = _getState(); var models = s.models || [];
    var match = models.find(function(m) { return m.name.toLowerCase().indexOf((p.name || '').toLowerCase()) >= 0; });
    if (!match) return 'Model "' + p.name + '" not found.';
    var newVis = p.visible != null ? !!p.visible : !(match.visible !== false);
    _dispatch({ t: 'UPD_MODEL', id: match.id, u: { visible: newVis } });
    return (newVis ? 'Showing' : 'Hiding') + ' model "' + match.name + '".';
  };

  // ── NL / AI handler ───────────────────────────────────────────

  handlers.send_nl_command = function(p) {
    var cmd = p.command || p.message || '';
    // Close the AI mass-resolve hole: update_clash/batch_update_clashes already
    // route 'resolved' to 'expected', but send_nl_command was a raw passthrough to
    // the NL engine, whose "(mark|resolve) all … clashes" grammar defaults to
    // status 'resolved'. Refuse that here so an agent can't empty openClashes and
    // starve triage. Queries ("show/list/how many … resolved") are unaffected.
    if (/\b(mark|set|change|update|resolve|close)\s+all\b/i.test(cmd) &&
        /\b(resolv|close|closed)\b/i.test(cmd) &&
        !/\b(show|list|filter|how many|count|select|highlight)\b/i.test(cmd)) {
      return "Refused: the bridge won't bulk-resolve clashes from a free-text command " +
        "('resolved'/'closed' means actually fixed/closed — an agent can't verify that). " +
        "To suppress by-design/false-positive clashes use update_clash or batch_update_clashes " +
        "with status 'expected' (reversible, kept out of the open count).";
    }
    if (window._ccProcessNLCommand) {
      var result = window._ccProcessNLCommand(cmd);
      return result || 'Command processed.';
    }
    return 'NL command processing not available.';
  };

  // ── Camera control handlers ─────────────────────────────────────

  handlers.get_model_bounds = function() {
    var vp = window._ccViewport;
    if (vp) { var b = vp.getBounds(); if (b) return b; }
    return 'No models loaded or bounds unavailable.';
  };

  handlers.get_camera = function() {
    var vp = window._ccViewport;
    if (vp) { var c = vp.getCamera(); if (c) return c; }
    return 'Camera state unavailable.';
  };

  handlers.pan_camera = function(p) {
    var vp = window._ccViewport;
    if (vp) { vp.pan(p.x || 0, p.y || 0, p.z || 0); return 'Camera panned by [' + (p.x||0) + ', ' + (p.y||0) + ', ' + (p.z||0) + '].'; }
    return 'Pan not available.';
  };

  handlers.set_camera = function(p) {
    var vp = window._ccViewport;
    if (vp) { vp.flyTo(p.px, p.py, p.pz, p.tx, p.ty, p.tz); return 'Camera moved.'; }
    return 'Camera control not available.';
  };

  handlers.zoom_to_bounds = function(p) {
    var vp = window._ccViewport;
    if (vp) { vp.fitAll(p.padding || 1.0); return 'Zoomed to fit model bounds.'; }
    return 'Zoom not available.';
  };

  // ── Tool manifest ─────────────────────────────────────────────────
  // Sent to the bridge on WebSocket connect so the binary can update its
  // /tools and /openapi.json endpoints without requiring a rebuild.
  // Schema format: JSON Schema subset (OpenAPI-compatible).

  var _TOOL_MANIFEST = [
    { name:'get_status',          description:'Snapshot of the current session: models (with source, version, lastSync and a coarse revision stamp per model — use to check sync with another live tool), clash/issue counts, detection rules, active tab, walk mode, theme. Includes connector:{state(receiving|ready|disconnected),ingesting,percent,elementCount} — when connector.ingesting is true the Revit model is still streaming in, so DO NOT act on model/clash data until state==="ready". Also detecting/detectionProgress and lastDetectionError.' },
    { name:'get_clashes',         description:'Detected clash pairs: status, priority, severity, storey, types/names, distance (mm), elevation (m), gridBay (nearest structural-grid bay e.g. "A-3" when grids loaded via the Revit bridge), disciplines (arch×structural vs same-discipline), and stable identity per side — uniqueIdA/B (Revit UniqueId, most reliable cross-doc key; prefer it), globalIdA/B (IFC GlobalId), revitIdA/B (ElementId, doc-local) — plus classificationA/B ({system,code} NL-SfB/Uniclass) and modelAId/B.',
      params:{ status:{type:'string',enum:['all','open','resolved','approved','expected','closed'],opt:1}, category:{type:'string',opt:1}, limit:{type:'number',opt:1}, offset:{type:'number',opt:1} } },
    { name:'get_clash_summary',   description:'Aggregate profile of the WHOLE clash set without paging it: total/open, and counts byStatus, byCategory (AI), byDiscipline (pair), byTypePair (top N), byStorey. Use to find the few root causes behind a large count.',
      params:{ topN:{type:'number',opt:1} } },
    { name:'get_element_quality', description:'Per-element data-quality annotations keyed by uniqueId/globalId (untyped_proxy, no_classification, degenerate_bbox, oversized_bbox). A parallel triage signal — NOT a detection gate. Returns only flagged elements.',
      params:{ modelId:{type:'string',opt:1}, limit:{type:'number',opt:1} } },
    { name:'get_levels',          description:"Per-model level/storey elevations (raw + elevationM when unitScale known) so a consumer can compute floor build-up bands. get_clashes.elevation is scene metres." },
    { name:'get_grids',           description:'Structural grid axis names (e.g. "A","B","1","2") brought in via the Revit bridge. Pair with get_clashes.gridBay to locate or filter clashes by grid position ("near grid A-3"). Empty for plain IFC loads.' },
    { name:'get_issues',          description:'Retrieves coordination issues with status, priority, assignee, description, involved element IFC GlobalIds (globalIds[]) and Revit ElementIds (revitIdA/B) for cross-tool joins.',
      params:{ status:{type:'string',enum:['all','open','in_progress','resolved','closed'],opt:1}, limit:{type:'number',opt:1} } },
    { name:'get_element_by_guid',  description:'Resolve loaded element(s) by Revit UniqueId (preferred), IFC GlobalId, or Revit ElementId — the inverse join: turn a key from another tool into the matching CC element with its model, type, storey, material, uniqueId and classification. Accepts single uniqueId/globalId/revitId or arrays uniqueIds[]/globalIds[]/revitIds[].',
      params:{ uniqueId:{type:'string',opt:1}, globalId:{type:'string',opt:1}, revitId:{type:'string',opt:1}, uniqueIds:{type:'array',opt:1}, globalIds:{type:'array',opt:1}, revitIds:{type:'array',opt:1}, limit:{type:'number',opt:1} } },
    { name:'resync',              description:'Force the live Revit link to re-pull the model so CC matches the current Revit state. Live-link only (no-op for static IFC loads). Re-check get_status afterwards for the new revision.' },
    { name:'run_detection',       description:'Starts clash detection between loaded models (async). modelA/modelB accept "all", a model name, "disc:<discipline>" (disc:architectural/structural/mep — disciplines from get_status), or "tag:<tag>"; use disc: on both sides to scope to cross-discipline pairs only and cut same-discipline noise at source. Rooms/spaces (IfcSpace) are excluded by default — set includeSpaces:true to clash against rooms (space-intrusion checks). Results via get_clashes; on failure (e.g. very large federation) get_status.lastDetectionError reports the message + stack.',
      params:{ modelA:{type:'string',opt:1}, modelB:{type:'string',opt:1}, maxGap:{type:'number',opt:1}, hard:{type:'boolean',opt:1}, excludeSelf:{type:'boolean',opt:1}, includeSpaces:{type:'boolean',opt:1} } },
    { name:'run_detection_ruleset', description:"Rule-based / cross-discipline detection (Solibri-style): runs several scoped rules — each a discipline/model pair with its own gap — and returns the UNION (deduped). Cuts volume at source vs flat all-vs-all; hosted/by-design pairs are excluded at detection time. With no rules[], preset 'cross_discipline' auto-builds every distinct discipline pair present (arch×structural, arch×mep, structural×mep). Async — results via get_clashes.",
      params:{ rules:{type:'array',items:{type:'object'},opt:1}, preset:{type:'string',opt:1}, maxGap:{type:'number',opt:1}, hard:{type:'boolean',opt:1} } },
    { name:'cancel_detection',    description:'Reset a stuck/wedged detection (clears detecting:true) so a new run_detection can start — no browser restart needed.' },
    { name:'ingest_detection_feedback', description:"Receiver for Loam's outcome feedback. Body: { projectKey?, feedback:{ byRule:[{key,real,false,realRate,recommendation}], byPair:[{key,real,false,realRate,recommendation}] } }. byPair.key = element-type pair (e.g. 'IfcSlab × IfcSlab'); realRate = real/(real+false). On the next detection run, pairs with realRate >= 0.34 are no longer auto-suppressed by the type-pair memo (CC stops eating those real clashes). Stored per projectKey, survives refresh; round-trip visible in get_status.detectionFeedback. byRule is stored for inspection.",
      params:{ projectKey:{type:'string',opt:1}, feedback:{type:'object'} } },
    { name:'set_detection_rules', description:'Updates detection parameters without running detection.',
      params:{ maxGap:{type:'number',opt:1}, hard:{type:'boolean',opt:1}, excludeSelf:{type:'boolean',opt:1}, duplicates:{type:'boolean',opt:1} } },
    { name:'update_clash',        description:"Updates one clash by 0-based index, or many at once via items[] (bulk-safe: all targets resolved before any change). status can be open|approved|closed|expected. Use 'expected' for by-design/false-positive clashes — a reversible suppressed bucket, kept out of the open count and re-openable by setting status back to 'open'. NOTE: 'resolved' (= a real clash actually fixed, which an agent can't verify) is automatically routed to 'expected' here — the bridge buckets, it does not decide a clash is fixed.",
      params:{ clashIndex:{type:'number',opt:1}, status:{type:'string',opt:1}, priority:{type:'string',opt:1}, assignee:{type:'string',opt:1}, title:{type:'string',opt:1}, items:{type:'array',items:{type:'object'},opt:1} } },
    { name:'batch_update_clashes',description:'Applies a batch action to clashes matching a natural-language filter.',
      params:{ action:{type:'string'}, filter:{type:'string'} } },
    { name:'filter_clashes',      description:'Applies status/priority filters to the clash list UI.',
      params:{ status:{type:'string',opt:1}, priority:{type:'string',opt:1} } },
    { name:'sort_clashes',        description:'Sorts the clash list by a field: status, priority, storey, typeA, typeB, distance, severity.',
      params:{ sortBy:{type:'string'} } },
    { name:'group_clashes',       description:"Groups the clash list by a field or 'none' to ungroup.",
      params:{ groupBy:{type:'string'} } },
    { name:'fly_to_clash',        description:'Animates the 3D camera to a specific clash by 0-based index.',
      params:{ clashIndex:{type:'number'} } },
    { name:'set_view',            description:"Changes the 3D camera to a standard view: top, front, back, left, right, isometric, or reset.",
      params:{ view:{type:'string',enum:['top','front','back','left','right','isometric','reset']} } },
    { name:'set_render_style',    description:'Changes 3D render mode: standard, shaded, rendered, wireframe.',
      params:{ style:{type:'string',enum:['standard','shaded','rendered','wireframe']} } },
    { name:'set_section',         description:'Creates a section cutting plane along an axis. Optional position sets absolute world-space coordinate.',
      params:{ axis:{type:'string',enum:['x','y','z','none']}, position:{type:'number',opt:1} } },
    { name:'set_section_at',      description:'Places a section plane at an absolute world-space position on the given axis.',
      params:{ axis:{type:'string',enum:['x','y','z']}, position:{type:'number'}, cutHeight:{type:'number',opt:1} } },
    { name:'color_by',            description:"Colors elements by a field: discipline, type, storey, model, status, or 'none' to reset.",
      params:{ by:{type:'string'} } },
    { name:'set_theme',           description:'Switches the UI between dark and light themes.',
      params:{ theme:{type:'string',enum:['dark','light']} } },
    { name:'set_visibility',      description:'Toggles visibility of UI overlays: grid, axes, or markers.',
      params:{ option:{type:'string',enum:['grid','axes','markers']}, visible:{type:'boolean'} } },
    { name:'restore_visibility',  description:'Unhides all ghosted/hidden IFC elements, restoring full model visibility.' },
    { name:'isolate_elements',    description:'Ghosts or hides elements not matching a filter (ifcType, storey, discipline, material, expressIds). mode: ghost|hide|show_all.',
      params:{ mode:{type:'string',enum:['ghost','hide','show_all'],opt:1}, ifcType:{type:'string',opt:1}, storey:{type:'string',opt:1}, discipline:{type:'string',opt:1}, material:{type:'string',opt:1}, expressIds:{type:'array',items:{type:'number'},opt:1} } },
    { name:'navigate_tab',        description:'Switches the active sidebar tab: clashes, issues, models, settings, addons.',
      params:{ tab:{type:'string'} } },
    { name:'measure',             description:"Activates measurement: 'length', 'angle', 'area', 'element' (read Qto_*), 'clearance' (min distance between two elements), 'stop', or 'clear'.",
      params:{ mode:{type:'string',enum:['length','angle','area','element','clearance','point','edge','stop','clear']} } },
    { name:'takeoff',             description:'Aggregates length/area/volume across all elements matching an IFC type filter (e.g. IfcWall). Reads Qto_* quantity sets.',
      params:{ filter:{type:'string'} } },
    { name:'set_measure_units',   description:"Changes measurement display units. 'auto' detects from IFC; 'metric' uses mm/m; 'imperial-decimal' uses ft.dec; 'imperial-fractional' uses ft' in\".",
      params:{ units:{type:'string',enum:['auto','metric','imperial-decimal','imperial-fractional']} } },
    { name:'walk_mode',           description:'Enables or disables first-person walk mode.',
      params:{ enabled:{type:'boolean'} } },
    { name:'get_model_bounds',    description:'Returns the bounding box of all loaded models: min, max, center, size (metres).' },
    { name:'get_camera',          description:'Returns current camera position, target point, and orbit distance.' },
    { name:'pan_camera',          description:'Pans the 3D camera by a world-space offset.',
      params:{ x:{type:'number',opt:1}, y:{type:'number',opt:1}, z:{type:'number',opt:1} } },
    { name:'set_camera',          description:'Flies the camera to a new position and look-at target.',
      params:{ px:{type:'number'}, py:{type:'number'}, pz:{type:'number'}, tx:{type:'number'}, ty:{type:'number'}, tz:{type:'number'} } },
    { name:'zoom_to_bounds',      description:'Fits the camera to show all model geometry.',
      params:{ padding:{type:'number',opt:1} } },
    { name:'send_nl_command',     description:'Sends a natural-language command directly to the ClashControl NL engine.',
      params:{ command:{type:'string'} } },
    { name:'list_storeys',        description:'Returns all building storeys with names and elevations. Call before create_2d_sheet.' },
    { name:'create_2d_sheet',     description:'Creates a 2D floor plan sheet at a storey or elevation, switches to sheet view. Returns sheetId.',
      params:{ floorName:{type:'string',opt:1}, height:{type:'number',opt:1}, scale:{type:'string',opt:1}, format:{type:'string',enum:['png','pdf','dxf'],opt:1} } },
    { name:'list_2d_sheets',      description:'Returns all 2D sheets with IDs, names, elevations, annotation counts, and active sheet ID.' },
    { name:'export_sheet',        description:'Exports a floor plan sheet as PNG, PDF, or DXF. Uses active sheet if sheetId omitted.',
      params:{ sheetId:{type:'string',opt:1}, format:{type:'string',enum:['png','pdf','dxf'],opt:1} } },
    { name:'delete_sheet',        description:'Permanently deletes a sheet and all its annotations.',
      params:{ sheetId:{type:'string'} } },
    { name:'exit_floor_plan',     description:'Returns from 2D floor plan mode to the standard 3D perspective view.' },
    { name:'pan_2d_sheet',        description:'Pans the 2D floor plan canvas by a pixel offset.',
      params:{ x:{type:'number',opt:1}, y:{type:'number',opt:1} } },
    { name:'zoom_2d_sheet',       description:'Sets the 2D floor plan zoom level (0.05–50). 1.0 = natural size.',
      params:{ level:{type:'number'} } },
    { name:'fit_2d_bounds',       description:'Auto-fits the 2D floor plan to show all geometry.' },
    { name:'add_annotation',      description:'Adds one markup annotation (text, pin, line, rect, arrow) to the active 2D sheet, or many at once via items[] (array of the same fields).',
      params:{ type:{type:'string',enum:['text','pin','line','rect','arrow'],opt:1}, x:{type:'number',opt:1}, y:{type:'number',opt:1}, x2:{type:'number',opt:1}, y2:{type:'number',opt:1}, text:{type:'string',opt:1}, color:{type:'string',opt:1}, items:{type:'array',items:{type:'object'},opt:1} } },
    { name:'measure_on_sheet',    description:'Adds a dimension annotation between two world-space points on the active 2D sheet.',
      params:{ points:{type:'array',items:{type:'number'},minItems:4,maxItems:4}, color:{type:'string',opt:1} } },
    { name:'promote_clash_to_issue', description:'Promote a detected clash (by 0-based clashIndex, or many via items[]) to a coordination issue, COPYING its element identity (uniqueIdA/B, globalIdA/B, revitIdA/B), storey, types, disciplines and classification — so the Issue is joinable back to the model/Loam (manual create_issue would have globalIds:[]). Links clash→issue (linkedIssueId); does NOT resolve the clash.',
      params:{ clashIndex:{type:'number',opt:1}, items:{type:'array',items:{type:'object'},opt:1}, title:{type:'string',opt:1}, description:{type:'string',opt:1}, priority:{type:'string',opt:1}, assignee:{type:'string',opt:1} } },
    { name:'create_issue',        description:'Creates one coordination issue, or many at once via items[]. Each: {title,description?,status?,priority?,assignee?,category?}. For element linkage (so the issue joins back to the model/Loam) pass globalIds[]/revitIds[]/uniqueIds[] or per-side globalIdA/B, revitIdA/B, uniqueIdA/B, plus storey/classification. To promote a detected clash, prefer promote_clash_to_issue (copies identity automatically).',
      params:{ title:{type:'string',opt:1}, description:{type:'string',opt:1}, status:{type:'string',opt:1}, priority:{type:'string',opt:1}, assignee:{type:'string',opt:1}, category:{type:'string',opt:1}, items:{type:'array',items:{type:'object'},opt:1} } },
    { name:'update_issue',        description:'Updates one issue by 0-based index, or many at once via items:[{issueIndex,...}]. Targets are resolved before any change, so a batch is index-safe.',
      params:{ issueIndex:{type:'number',opt:1}, status:{type:'string',opt:1}, priority:{type:'string',opt:1}, assignee:{type:'string',opt:1}, title:{type:'string',opt:1}, description:{type:'string',opt:1}, items:{type:'array',items:{type:'object'},opt:1} } },
    { name:'delete_issue',        description:'Deletes one issue by 0-based index, or many at once via items:[{issueIndex}, ...]. Indices are resolved to ids up front, so deleting several at once is safe from index shifting.',
      params:{ issueIndex:{type:'number',opt:1}, items:{type:'array',items:{type:'object'},opt:1} } },
    { name:'export_bcf',          description:'Exports all clashes or issues as a BCF ZIP file.',
      params:{ version:{type:'string',enum:['2.1','3.0'],opt:1} } },
    { name:'import_bcf',          description:'Imports a BCF (2.1/3.0) file, adding its topics as issues (with element GUIDs, status, priority, viewpoints). Pass base64 of the .bcf/.bcfzip to import directly without a dialog; omit it to open the file picker for the user to choose a file.',
      params:{ base64:{type:'string',opt:1} } },
    { name:'create_project',      description:'Creates a new project.',
      params:{ name:{type:'string'} } },
    { name:'switch_project',      description:'Switches to a project by name (fuzzy match).',
      params:{ name:{type:'string'} } },
    { name:'delete_model',        description:'Removes a loaded IFC model by name.',
      params:{ name:{type:'string'} } },
    { name:'rename_model',        description:'Renames a loaded model.',
      params:{ oldName:{type:'string'}, newName:{type:'string'}, discipline:{type:'string',opt:1} } },
    { name:'get_model_info',      description:'Returns element list and metadata for a model.',
      params:{ name:{type:'string'} } },
    { name:'toggle_model',        description:'Shows or hides a model by name.',
      params:{ name:{type:'string'}, visible:{type:'boolean'} } },
    { name:'run_data_quality',    description:'Runs BIM/ILS data quality checks on all loaded models.' }
  ];

  // Convert compact schema to JSON Schema object format used by MCP/OpenAPI
  function _buildSchema(params) {
    if (!params) return { type: 'object', properties: {}, required: [] };
    var props = {}, req = [];
    Object.keys(params).forEach(function(k) {
      var p = params[k];
      var s = { type: p.type, description: p.description || k };
      if (p.enum) s.enum = p.enum;
      if (p.items) s.items = p.items;
      if (p.minItems) s.minItems = p.minItems;
      if (p.maxItems) s.maxItems = p.maxItems;
      props[k] = s;
      if (!p.opt) req.push(k);
    });
    return { type: 'object', properties: props, required: req };
  }

  // ── Claude Desktop auto-configure ────────────────────────────────
  // Callback set by the "Configure Claude" button; fired when the binary
  // responds with { type: 'mcp_config_installed', success, path }.
  var _onMcpConfigInstalled = null;

  // ── WebSocket connection ──────────────────────────────────────────

  function _connectWs(d) {
    if (_ws && _ws.readyState <= 1) return;
    var capturedGen = _wsGen;
    try { _ws = new WebSocket(WS_URL); } catch (e) { return; }

    _ws.onopen = function() {
      _connected = true;
      if (d) d({t:'UPD_SMART_BRIDGE', u:{connected:true, bridgeUpdating:false, bridgeReconnecting:false}});
      console.log('%c[Smart Bridge] Connected', 'color:#22c55e;font-weight:bold');
      // Fetch stored LLM config so the chat panel pre-fills correctly
      fetch(REST_URL + '/llm-config', {cache:'no-store'})
        .then(function(r){ return r.ok ? r.json() : null; })
        .then(function(j){ if (j && d) d({t:'UPD_SMART_BRIDGE', u:{llmConfig:j}}); })
        .catch(function(){}); // bridge may not support /llm-config yet — ignore
      // Announce full tool manifest so the bridge can update /tools and /openapi.json
      // without requiring a binary rebuild when new handlers are added.
      try {
        var manifest = _TOOL_MANIFEST.map(function(t) {
          return { name: t.name, description: t.description, inputSchema: _buildSchema(t.params) };
        });
        _ws.send(JSON.stringify({ type: 'tool_manifest', tools: manifest }));
      } catch (e) { console.warn('[Smart Bridge] Failed to send tool manifest:', e); }
    };

    _ws.onmessage = function(evt) {
      try {
        var msg = JSON.parse(evt.data);
        // Server-push notifications from the bridge process
        if (msg.type === 'update_available') {
          console.log('%c[Smart Bridge] Update available:', 'color:#fbbf24;font-weight:bold', msg.version || '');
          if (d) d({t:'UPD_SMART_BRIDGE', u:{
            updateAvailable: true,
            updateVersion: msg.version || null,
            updateUrl: msg.url || null
          }});
          return;
        }
        // Bridge is downloading its own update binary
        if (msg.type === 'update_downloading') {
          console.log('%c[Smart Bridge] Downloading update\u2026', 'color:#fbbf24;font-weight:bold');
          if (d) d({t:'UPD_SMART_BRIDGE', u:{bridgeUpdating: true, updateAvailable: false}});
          return;
        }
        // Bridge has installed the update and is about to restart
        if (msg.type === 'update_installed') {
          console.log('%c[Smart Bridge] Update installed \u2014 reconnecting\u2026', 'color:#fbbf24;font-weight:bold');
          if (d) d({t:'UPD_SMART_BRIDGE', u:{bridgeUpdating: false, bridgeReconnecting: true}});
          return;
        }
        // Binary wrote the Claude Desktop config file on request
        if (msg.type === 'mcp_config_installed') {
          if (typeof _onMcpConfigInstalled === 'function') { _onMcpConfigInstalled(msg); _onMcpConfigInstalled = null; }
          return;
        }
        // Tool call request
        if (msg.id != null && msg.action) {
          if (d) d({t:'UPD_SMART_BRIDGE', u:{llmConnected:true}});
          var handler = handlers[msg.action];
          var result;
          if (handler) { try { result = handler(msg.params || {}); } catch (e) { result = 'Error: ' + e.message; } }
          else { result = 'Unknown action: ' + msg.action; }
          _ws.send(JSON.stringify({ id: msg.id, result: result }));
        }
      } catch (e) { console.error('[Smart Bridge] Message error:', e); }
    };

    _ws.onclose = function() {
      _connected = false;
      if (d) d({t:'UPD_SMART_BRIDGE', u:{connected:false, llmConnected:false}});
      // Auto-reconnect after 3s, but only if still in the same session (not destroyed)
      setTimeout(function() { if (_wsGen === capturedGen) _connectWs(d); }, 3000);
    };

    _ws.onerror = function() {};
  }

  function _disconnectWs() {
    _wsGen++; // Invalidate any pending auto-reconnect timers
    _cancelPendingConnect();
    if (_ws) { try { _ws.close(); } catch (e) {} }
    _ws = null;
    _connected = false;
  }

  // ── Expose globals ────────────────────────────────────────────────

  // Relay CC's detection-complete ping to the bridge (and on to the LLM) so a
  // connected orchestrator gets pushed a "run done" message instead of polling /
  // sitting idle. Registered once; no-op when the bridge WS isn't connected.
  if (!window._ccSbDetectDoneWired) {
    window._ccSbDetectDoneWired = true;
    window.addEventListener('cc-detection-complete', function(ev) {
      try {
        if (!_ws || _ws.readyState !== 1) return;
        var det = (ev && ev.detail) || {};
        var s = _getState();
        _ws.send(JSON.stringify({ type: 'event', event: 'detection_complete',
          ok: det.ok !== false,
          total: det.total != null ? det.total : ((s.clashes||[]).length),
          open: det.open != null ? det.open : null,
          modelA: det.modelA || null, modelB: det.modelB || null,
          error: det.error || null,
          projectKey: _projectKey(s), source: 'clashcontrol', ts: det.ts || Date.now() }));
      } catch (e) {}
    });
  }

  window._ccSmartBridgeConnect = function(d) { _connectBridge(d || window._ccDispatch); };
  window._ccSmartBridgeInstall = function(d) { _triggerDownload(); _connectBridge(d || window._ccDispatch, {installing:true}); };
  window._ccSmartBridgeDisconnect = function() { _disconnectWs(); _dispatch({t:'UPD_SMART_BRIDGE', u:{connected:false, available:false}}); };
  window._ccSmartBridgeCheck = function(d) { _checkBridge(d || window._ccDispatch); };

  // ── Register addon ────────────────────────────────────────────────

  // ── Passive auto-connect (called on page load via init, and as deferred fallback) ──

  function _doInit(dispatch) {
    var wasInstalled = false;
    try { wasInstalled = localStorage.getItem('cc_sb_downloaded') === '1' || localStorage.getItem('cc_smart_bridge') === '1'; } catch (e) {}
    if (wasInstalled) {
      dispatch({t:'UPD_SMART_BRIDGE', u:{wasInstalled:true}});
      // Passive check — if bridge is already running, connect automatically
      _checkBridge(dispatch).then(function(j) {
        if (j) _connectWs(dispatch);
      });
    }
  }

  if (window._ccRegisterAddon) {
    window._ccRegisterAddon({
      id: 'smart-bridge',
      name: 'Smart Bridge',
      description: 'LLM bridge — connect Claude, ChatGPT, or any AI assistant to control ClashControl with natural language.',
      autoActivate: false,
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',

      initState: {
        smartBridge: { connected: false, available: false, checking: false,
          connecting: false, installing: false, failed: false,
          wasInstalled: false, version: null,
          updateAvailable: false, updateVersion: null, updateUrl: null,
          bridgeUpdating: false, bridgeReconnecting: false, updating: false,
          llmConnected: false,
          llmConfig: null, chatBusy: false, chatMessages: [], chatError: null }
      },

      reducerCases: {
        'UPD_SMART_BRIDGE': function(s, a) {
          return Object.assign({}, s, { smartBridge: Object.assign({}, s.smartBridge, a.u) });
        }
      },

      init: function(dispatch) {
        console.log('[Smart Bridge] Addon activated');
        _updateChecked = false; // reset on activation
        _fetchLatestReleaseTag(dispatch); // fetch latest release tag from GitHub (non-blocking)
        _doInit(dispatch);

        // /smart command handling lives in processNLCommandWithLLM (index.html) —
        // it calls POST /chat on the bridge and feeds the async response back into
        // the main chat. The addon panel mirrors those messages via UPD_SMART_BRIDGE.

        // Periodic update check every 30 minutes while the addon is active.
        _updateInterval = setInterval(function() {
          var sb = (window._ccLatestState || {}).smartBridge;
          if (sb && sb.available && !sb.updating) {
            _checkForUpdate(dispatch);
            // Also re-fetch the GitHub tag so stale sessions catch new releases.
            _fetchLatestReleaseTag(dispatch);
          }
        }, 30 * 60 * 1000);
      },

      onEnable: function(dispatch) {
        var wasDownloaded = false;
        try { wasDownloaded = localStorage.getItem('cc_sb_downloaded') === '1'; } catch (e) {}
        if (wasDownloaded) {
          // Binary already in Downloads: skip re-download, try URL scheme + fast poll
          _connectBridge(dispatch);
        } else {
          // First time: download binary + long poll
          _triggerDownload();
          try { localStorage.setItem('cc_sb_downloaded', '1'); } catch (e) {}
          _connectBridge(dispatch, {installing: true});
        }
      },

      destroy: function() {
        // Cancel any in-flight connect poll loop — otherwise disabling the
        // integration leaves tick() hammering /status (and spamming the console
        // with ERR_CONNECTION_REFUSED) until its deadline expires.
        _cancelPendingConnect();
        _disconnectWs();
        clearInterval(_updateInterval); _updateInterval = null;
        try { localStorage.removeItem('cc_smart_bridge'); } catch (e) {}
        // cc_sb_downloaded is intentionally kept so re-enabling never re-downloads the binary.
      },

      // ── Addon panel (rendered inside the addon card) ──────────────
      panel: function(html, s, d) {
        var sb = s.smartBridge || {};
        var os = _detectOS();
        var dl = _downloads[os];

        var _codeStyle = {fontSize:'0.57rem',background:'var(--bg-tertiary)',padding:'2px 5px',borderRadius:3,wordBreak:'break-all'};
        var _btnSmall = {padding:'.25rem .6rem',borderRadius:5,fontSize:'0.63rem',fontWeight:600,cursor:'pointer',border:'none',fontFamily:'inherit'};
        var _installerFile = dl.url.split('/').pop();

        function _copyInstallerName() {
          navigator.clipboard.writeText(_installerFile).catch(function() {
            var ta = document.createElement('textarea');
            ta.value = _installerFile; ta.style.position='fixed'; ta.style.opacity='0';
            document.body.appendChild(ta); ta.select(); document.execCommand('copy');
            document.body.removeChild(ta);
          });
        }

        var _cleanupRow = html`<div style=${{display:'flex',alignItems:'center',gap:'.4rem',padding:'.3rem .45rem',background:'var(--bg-secondary)',borderRadius:5,marginTop:'.1rem'}}>
          <span style=${{fontSize:'0.57rem',color:'var(--text-faint)',flex:1,lineHeight:1.4}}>
            Installer <code style=${{background:'var(--bg-tertiary)',padding:'1px 4px',borderRadius:2,fontSize:'0.57rem'}}>${_installerFile}</code>${' '}can be deleted from your Downloads folder
          </span>
          <button onClick=${_copyInstallerName}
            style=${{padding:'2px 7px',borderRadius:4,fontSize:'0.57rem',fontWeight:600,cursor:'pointer',border:'none',background:'var(--bg-tertiary)',color:'var(--text-muted)',fontFamily:'inherit',flexShrink:0}}>Copy name</button>
        </div>`;

        // Claude Desktop MCP config snippet — just the block to merge in,
        // not a full JSON object (the file already has content).
        var _claudeConfigBlock = JSON.stringify({
          clashcontrol: {
            command: dl.installPath,
            args: ['--mcp']
          }
        }, null, 2);
        var _claudeConfig = '"mcpServers": ' + _claudeConfigBlock;

        function _copyToClipboard(text, btnId, label) {
          var setLabel = function(t) { var b = document.getElementById(btnId); if (b) b.textContent = t; };
          navigator.clipboard.writeText(text).then(function() {
            setLabel(label); setTimeout(function(){ setLabel('Configure Claude'); }, 2200);
          }).catch(function() {
            var ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select(); document.execCommand('copy');
            document.body.removeChild(ta);
            setLabel(label); setTimeout(function(){ setLabel('Configure Claude'); }, 2200);
          });
        }

        function _autoConfigureClaude() {
          var btn = document.getElementById('cc-sb-claude-btn');
          if (btn) btn.textContent = 'Configuring\u2026';
          var done = false;
          var timer = setTimeout(function() {
            if (done) return; done = true; _onMcpConfigInstalled = null;
            // Binary didn't respond — fall back to clipboard copy
            _copyToClipboard(_claudeConfig, 'cc-sb-claude-btn', 'Config copied \u2014 paste into file');
          }, 3000);
          _onMcpConfigInstalled = function(msg) {
            if (done) return; done = true; clearTimeout(timer);
            var btn2 = document.getElementById('cc-sb-claude-btn');
            if (btn2) {
              btn2.textContent = msg.success ? 'Done \u2014 restart Claude' : 'Failed \u2014 config copied';
              if (!msg.success) _copyToClipboard(_claudeConfig, 'cc-sb-claude-btn', 'Failed \u2014 config copied');
              setTimeout(function(){ var b = document.getElementById('cc-sb-claude-btn'); if (b) b.textContent = 'Configure Claude'; }, 3000);
            }
          };
          // Ask binary to write the config file via WebSocket
          if (_ws && _ws.readyState === 1) {
            try { _ws.send(JSON.stringify({ type: 'install_mcp_config' })); }
            catch (e) { /* timeout will fire fallback */ }
          }
        }

        // Updating (self-update in progress)
        if (sb.updating) {
          return html`<div style=${{display:'flex',flexDirection:'column',gap:'.4rem'}}>
            <div style=${{display:'flex',alignItems:'center',gap:'.4rem'}}>
              <div style=${{width:7,height:7,border:'1.5px solid #fbbf24',borderTopColor:'transparent',borderRadius:'50%',animation:'cc-spin .6s linear infinite',flexShrink:0}}></div>
              <span style=${{fontSize:'0.75rem',color:'#fbbf24',flex:1}}>Updating bridge\u2026</span>
            </div>
            <div style=${{fontSize:'0.6rem',color:'var(--text-faint)',lineHeight:1.5}}>
              Downloading update and restarting. Reconnecting automatically\u2026
            </div>
          </div>`;
        }

        // Reconnecting after self-update (WebSocket dropped, bridge is restarting)
        if (!sb.connected && sb.bridgeReconnecting) {
          return html`<div style=${{display:'flex',flexDirection:'column',gap:'.4rem'}}>
            <div style=${{display:'flex',alignItems:'center',gap:'.4rem'}}>
              <div style=${{width:7,height:7,border:'1.5px solid #fbbf24',borderTopColor:'transparent',borderRadius:'50%',animation:'cc-spin .6s linear infinite',flexShrink:0}}></div>
              <span style=${{fontSize:'0.75rem',color:'#fbbf24',flex:1}}>Reconnecting\u2026</span>
            </div>
            <div style=${{fontSize:'0.6rem',color:'var(--text-faint)',lineHeight:1.5}}>
              Bridge updated and restarted. Reconnecting automatically\u2026
            </div>
          </div>`;
        }

        // Connected state
        if (sb.connected) {
          var _updateHref = sb.updateUrl ||
            (sb.updateVersion ? 'https://github.com/clashcontrol-io/ClashControl/releases/tag/bridge-v' + sb.updateVersion : null);
          return html`<div style=${{display:'flex',flexDirection:'column',gap:'.5rem'}}>
            <div style=${{display:'flex',alignItems:'center',gap:'.4rem'}}>
              ${sb.bridgeUpdating
                ? html`<div style=${{width:7,height:7,border:'1.5px solid #fbbf24',borderTopColor:'transparent',borderRadius:'50%',animation:'cc-spin .6s linear infinite',flexShrink:0}}></div>`
                : html`<span style=${{width:7,height:7,borderRadius:'50%',background:'#22c55e',flexShrink:0}}></span>`}
              <span style=${{fontSize:'0.75rem',color:sb.bridgeUpdating?'#fbbf24':'#4ade80',flex:1}}>
                ${sb.bridgeUpdating ? 'Downloading update\u2026' : ('Connected' + (sb.version ? ' \u2014 v' + sb.version : ''))}
              </span>
            </div>
            ${sb.updateAvailable && html`<div style=${{display:'flex',alignItems:'center',gap:'.5rem',padding:'.3rem .45rem',background:'rgba(234,179,8,.1)',border:'1px solid rgba(234,179,8,.25)',borderRadius:6}}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style=${{flexShrink:0}}><path d="M12 2v16M5 9l7-7 7 7"/></svg>
              <span style=${{fontSize:'0.66rem',color:'#fbbf24',flex:1}}>
                Update available${sb.updateVersion ? ': v' + sb.updateVersion : ''}
              </span>
              ${_updateHref && html`<a href=${_updateHref} target="_blank" rel="noopener"
                style=${{fontSize:'0.63rem',fontWeight:600,color:'#fbbf24',textDecoration:'none',background:'rgba(234,179,8,.15)',padding:'2px 7px',borderRadius:4,flexShrink:0}}>Download</a>`}
            </div>`}
            ${!sb.llmConnected && html`<div style=${{fontSize:'0.63rem',color:'var(--text-faint)',lineHeight:1.6}}>
              Smart Bridge is running. Connect your AI — one click, no API key:
            </div>`}

            ${!sb.llmConnected && html`<button onClick=${function(){ if(d) d({t:'UPD_SMART_BRIDGE', u:{showSetup: !sb.showSetup}}); }}
              style=${{..._btnSmall,background:'var(--bg-secondary)',color:'var(--text-secondary)',alignSelf:'stretch',textAlign:'left',fontWeight:600}}>
              ${sb.showSetup ? '▾' : '▸'} Connect an AI assistant — Claude, ChatGPT, REST
            </button>`}

            ${!sb.llmConnected && sb.showSetup && html`<div style=${{background:'var(--bg-secondary)',borderRadius:6,padding:'.45rem .5rem',display:'flex',flexDirection:'column',gap:'.35rem'}}>
              <div style=${{display:'flex',alignItems:'center',gap:'.4rem'}}>
                <span style=${{fontSize:'0.69rem',fontWeight:600,color:'#c084fc',flex:1}}>Claude Desktop / Claude Code</span>
                <button id="cc-sb-claude-btn" onClick=${_autoConfigureClaude}
                  style=${{..._btnSmall,background:'#7c3aed',color:'#fff',flexShrink:0}}>Configure Claude</button>
              </div>
              <div style=${{fontSize:'0.58rem',color:'var(--text-faint)',lineHeight:1.4}}>
                ${os === 'win'
                  ? html`Auto-configures <code style=${{fontSize:'0.58rem',background:'var(--bg-tertiary)',padding:'1px 3px',borderRadius:2}}>%APPDATA%\\Claude\\claude_desktop_config.json</code> and restarts Claude.`
                  : os === 'mac'
                    ? html`Auto-configures <code style=${{fontSize:'0.58rem',background:'var(--bg-tertiary)',padding:'1px 3px',borderRadius:2}}>~/Library/Application\u00a0Support/Claude/claude_desktop_config.json</code> and restarts Claude.`
                    : html`Auto-configures <code style=${{fontSize:'0.58rem',background:'var(--bg-tertiary)',padding:'1px 3px',borderRadius:2}}>~/.config/claude-desktop/claude_desktop_config.json</code> and restarts Claude.`}
                ${' Or run '}
                <code style=${{fontSize:'0.58rem',background:'var(--bg-tertiary)',padding:'1px 3px',borderRadius:2}}>node mcp-server.js --install</code>
                ${' in the ClashControl folder for all 51 tools.'}
              </div>
              <details>
                <summary style=${{fontSize:'0.58rem',color:'var(--text-faint)',cursor:'pointer',userSelect:'none'}}>Show block to add</summary>
                <pre style=${{..._codeStyle,margin:'.3rem 0 0',padding:'.35rem .4rem',whiteSpace:'pre-wrap',lineHeight:1.4,fontSize:'0.57rem'}}>${_claudeConfig}</pre>
              </details>
            </div>`}

            ${!sb.llmConnected && html`<div style=${{background:'var(--bg-secondary)',borderRadius:6,padding:'.5rem',display:'flex',flexDirection:'column',gap:'.3rem'}}>
              <div style=${{fontSize:'0.69rem',fontWeight:600,color:'#22c55e'}}>ChatGPT</div>
              <div style=${{fontSize:'0.6rem',color:'var(--text-faint)',lineHeight:1.5}}>
                Create a custom GPT → Configure → Actions → Import from URL:
              </div>
              <code style=${_codeStyle}>http://localhost:19803/openapi.json</code>
            </div>`}

            ${!sb.llmConnected && html`<div style=${{background:'var(--bg-secondary)',borderRadius:6,padding:'.5rem',display:'flex',flexDirection:'column',gap:'.3rem'}}>
              <div style=${{fontSize:'0.69rem',fontWeight:600,color:'#60a5fa'}}>Any LLM / HTTP Client</div>
              <div style=${{fontSize:'0.6rem',color:'var(--text-faint)',lineHeight:1.5}}>
                Call tools via REST API:
              </div>
              <code style=${_codeStyle}>POST http://localhost:19803/call/{tool_name}</code>
              <div style=${{fontSize:'0.57rem',color:'var(--text-faint)'}}>
                <a href="http://localhost:19803/tools" target="_blank" rel="noopener" style=${{color:'var(--accent)',textDecoration:'underline'}}>View all tools</a>
                ${' · '}
                <a href="http://localhost:19803/openapi.json" target="_blank" rel="noopener" style=${{color:'var(--accent)',textDecoration:'underline'}}>OpenAPI spec</a>
              </div>
            </div>`}

            ${(function() {
              // ── Ollama / OpenAI built-in chat ─────────────────────────────
              var cfg = sb.llmConfig || {provider:'ollama', model:'llama3.2', baseUrl:'http://localhost:11434', hasKey:false};
              var msgs = sb.chatMessages || [];

              var _inputStyle = {width:'100%',boxSizing:'border-box',padding:'.25rem .4rem',borderRadius:4,border:'1px solid var(--border)',background:'var(--bg-tertiary)',color:'var(--text-main)',fontSize:'0.63rem',fontFamily:'inherit'};
              var _labelStyle = {fontSize:'0.6rem',color:'var(--text-faint)',display:'block',marginBottom:2};

              function _onProviderChange() {
                var sel = document.getElementById('cc-sb-llm-provider');
                var urlField = document.getElementById('cc-sb-llm-url');
                if (!sel) return;
                var urls = {ollama:'http://localhost:11434', lmstudio:'http://localhost:1234', llamacpp:'http://localhost:8080', jan:'http://localhost:1337', custom:''};
                var models = {ollama:'llama3.2', lmstudio:'', llamacpp:'', jan:'', custom:''};
                if (urlField && urls[sel.value] !== undefined) urlField.value = urls[sel.value];
                var mf = document.getElementById('cc-sb-llm-model');
                if (mf && models[sel.value] !== undefined) mf.value = models[sel.value];
              }

              // One-click: ask the bridge which local desktop LLM server is running,
              // then auto-fill + save its config. Falls back to the manual presets
              // below if the Connector is too old to expose /llm/autodetect.
              function _detectLocal() {
                var btn = document.getElementById('cc-sb-detect-btn');
                if (btn) btn.textContent = 'Detecting…';
                fetch(REST_URL + '/llm/autodetect')
                  .then(function(r){ if (r.status === 404) throw new Error('Update your Connector to auto-detect — or pick a preset below'); return r.json(); })
                  .then(function(j){
                    var found = (j && j.found) || [];
                    if (!found.length) { if (btn) btn.textContent = 'No local LLM found — is it running?'; setTimeout(function(){ if (btn) btn.textContent = 'Connect my desktop LLM'; }, 2800); return; }
                    var pick = found[0];
                    var model = (pick.models && pick.models[0]) || 'local-model';
                    var newCfg = {provider:pick.provider, model:model, baseUrl:pick.baseUrl, apiKey:''};
                    fetch(REST_URL + '/llm-config', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(newCfg)})
                      .then(function(){ if (d) d({t:'UPD_SMART_BRIDGE', u:{llmConfig:{provider:pick.provider, model:model, baseUrl:pick.baseUrl, hasKey:false}}}); });
                  })
                  .catch(function(e){ if (btn) { btn.textContent = e.message || 'Detect failed'; setTimeout(function(){ if (btn) btn.textContent = 'Connect my desktop LLM'; }, 3400); } });
              }

              function _saveLlmCfg() {
                var sel = document.getElementById('cc-sb-llm-provider');
                var mf  = document.getElementById('cc-sb-llm-model');
                var uf  = document.getElementById('cc-sb-llm-url');
                var kf  = document.getElementById('cc-sb-llm-key');
                if (!sel || !mf || !uf) return;
                var newCfg = {
                  provider: sel.value,
                  model:    mf.value.trim() || 'llama3.2',
                  baseUrl:  uf.value.trim() || 'http://localhost:11434',
                  apiKey:   kf ? kf.value : ''
                };
                var btn = document.getElementById('cc-sb-llm-save-btn');
                if (btn) btn.textContent = 'Saving\u2026';
                fetch(REST_URL + '/llm-config', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(newCfg)})
                  .then(function(){ if (d) d({t:'UPD_SMART_BRIDGE', u:{llmConfig:{provider:newCfg.provider, model:newCfg.model, baseUrl:newCfg.baseUrl, hasKey:!!newCfg.apiKey}}}); if (btn) { btn.textContent = 'Saved \u2713'; setTimeout(function(){ if (btn) btn.textContent='Save'; }, 1800); } })
                  .catch(function(e){ if (btn) btn.textContent = 'Failed'; console.warn('[Smart Bridge] save llm config:', e); });
              }

              function _sendChat() {
                var inp = document.getElementById('cc-sb-chat-input');
                var msg = inp && inp.value && inp.value.trim();
                if (!msg || sb.chatBusy) return;
                if (inp) inp.value = '';
                var updMsgs = msgs.concat([{role:'user', content:msg}]);
                if (d) d({t:'UPD_SMART_BRIDGE', u:{chatBusy:true, chatError:null, chatMessages:updMsgs}});
                // Build history from current messages (skip the last user msg we just added)
                var history = msgs.map(function(m){ return {role:m.role, content:m.content}; });
                fetch(REST_URL + '/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({message:msg, history:history})})
                  .then(function(r){ if (!r.ok) return r.json().then(function(j){ throw new Error(j.error || ('HTTP '+r.status)); }); return r.json(); })
                  .then(function(j){ if (d) d({t:'UPD_SMART_BRIDGE', u:{chatBusy:false, chatMessages:updMsgs.concat([{role:'assistant', content:j.response}])}}); })
                  .catch(function(e){ if (d) d({t:'UPD_SMART_BRIDGE', u:{chatBusy:false, chatError:e.message}}); });
              }

              var _providerLabels = {ollama:'Ollama (local)', lmstudio:'LM Studio (local)', llamacpp:'llama.cpp (local)', jan:'Jan (local)', custom:'Custom OpenAI-compatible'};

              return html`<div style=${{background:'var(--bg-secondary)',borderRadius:6,padding:'.5rem',display:'flex',flexDirection:'column',gap:'.4rem'}}>
                <div style=${{display:'flex',alignItems:'center',gap:'.4rem'}}>
                  <span style=${{fontSize:'0.69rem',fontWeight:600,color:'#fb923c',flex:1}}>Use your own AI</span>
                  <span style=${{fontSize:'0.57rem',color:'var(--text-faint)',background:'var(--bg-tertiary)',padding:'1px 5px',borderRadius:3}}>2.1</span>
                </div>
                <div style=${{fontSize:'0.6rem',color:'var(--text-faint)',lineHeight:1.4}}>
                  One click connects the LLM running on your desktop (Ollama, LM Studio, llama.cpp, Jan) — no API key. The bridge runs the agent loop.
                </div>
                <button id="cc-sb-detect-btn" onClick=${_detectLocal}
                  style=${{..._btnSmall,background:'var(--accent)',color:'#fff',alignSelf:'stretch',textAlign:'center',fontWeight:600}}>Connect my desktop LLM</button>

                <details style=${{borderRadius:4,overflow:'hidden'}}>
                  <summary style=${{fontSize:'0.6rem',color:'var(--text-faint)',cursor:'pointer',userSelect:'none',padding:'.15rem 0'}}>
                    LLM: ${_providerLabels[cfg.provider] || cfg.provider} · ${cfg.model}${cfg.hasKey ? ' · key set' : ''}
                  </summary>
                  <div key=${cfg.provider + cfg.model + cfg.baseUrl} style=${{display:'flex',flexDirection:'column',gap:'.3rem',paddingTop:'.35rem'}}>
                    <div>
                      <label style=${_labelStyle}>Provider</label>
                      <select id="cc-sb-llm-provider" onChange=${_onProviderChange}
                        style=${{..._inputStyle,padding:'.2rem .35rem'}}>
                        <option value="ollama" selected=${cfg.provider==='ollama'}>Ollama (local)</option>
                        <option value="lmstudio" selected=${cfg.provider==='lmstudio'}>LM Studio (local)</option>
                        <option value="llamacpp" selected=${cfg.provider==='llamacpp'}>llama.cpp (local)</option>
                        <option value="jan" selected=${cfg.provider==='jan'}>Jan (local)</option>
                        <option value="custom" selected=${cfg.provider==='custom'}>Custom OpenAI-compatible</option>
                      </select>
                    </div>
                    <div>
                      <label style=${_labelStyle}>Model</label>
                      <input id="cc-sb-llm-model" type="text" placeholder="llama3.2" defaultValue=${cfg.model} style=${_inputStyle} />
                    </div>
                    <div>
                      <label style=${_labelStyle}>Base URL</label>
                      <input id="cc-sb-llm-url" type="text" placeholder="http://localhost:11434" defaultValue=${cfg.baseUrl} style=${_inputStyle} />
                    </div>
                    <button id="cc-sb-llm-save-btn" onClick=${_saveLlmCfg}
                      style=${{..._btnSmall,background:'var(--bg-tertiary)',color:'var(--text-muted)',alignSelf:'flex-start'}}>Save</button>
                  </div>
                </details>

                ${msgs.length > 0 && html`<div style=${{display:'flex',flexDirection:'column',gap:'.25rem',maxHeight:'160px',overflowY:'auto',paddingRight:2}}>
                  ${msgs.map(function(m, i) {
                    var isUser = m.role === 'user';
                    return html`<div key=${i} style=${{fontSize:'0.63rem',lineHeight:1.5,padding:'.25rem .4rem',borderRadius:5,
                      background: isUser ? 'rgba(251,146,60,.12)' : 'var(--bg-tertiary)',
                      color: isUser ? '#fed7aa' : 'var(--text-main)',
                      alignSelf: isUser ? 'flex-end' : 'flex-start',
                      maxWidth:'92%',whiteSpace:'pre-wrap',wordBreak:'break-word'}}>
                      ${m.content}
                    </div>`;
                  })}
                  ${sb.chatBusy && html`<div style=${{fontSize:'0.6rem',color:'var(--text-faint)',fontStyle:'italic',alignSelf:'flex-start',padding:'0 .2rem'}}>Thinking\u2026</div>`}
                </div>`}

                ${sb.chatError && html`<div style=${{fontSize:'0.6rem',color:'#f87171',padding:'.2rem .3rem',background:'rgba(248,113,113,.08)',borderRadius:4}}>${sb.chatError}</div>`}

                <div style=${{display:'flex',gap:'.3rem',alignItems:'center'}}>
                  <input id="cc-sb-chat-input" type="text" placeholder="Ask about your models\u2026"
                    disabled=${sb.chatBusy}
                    onKeyDown=${function(e){ if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendChat(); } }}
                    style=${{..._inputStyle,flex:1}} />
                  <button onClick=${_sendChat} disabled=${sb.chatBusy}
                    style=${{..._btnSmall,background:sb.chatBusy?'var(--bg-tertiary)':'#fb923c',color:sb.chatBusy?'var(--text-faint)':'#fff',flexShrink:0}}>
                    ${sb.chatBusy ? '\u29d7' : 'Send'}
                  </button>
                </div>
                ${msgs.length > 0 && html`<button onClick=${function(){ if(d) d({t:'UPD_SMART_BRIDGE',u:{chatMessages:[],chatError:null}}); }}
                  style=${{..._btnSmall,background:'transparent',color:'var(--text-faint)',border:'1px solid var(--border)',alignSelf:'flex-start'}}>Clear chat</button>`}
              </div>`;
            })()}

            ${_cleanupRow}
          </div>`;
        }

        // Installing / connecting state
        if (sb.connecting || sb.installing) {
          return html`<div style=${{display:'flex',flexDirection:'column',gap:'.4rem'}}>
            <div style=${{display:'flex',alignItems:'center',gap:'.4rem'}}>
              <span style=${{width:7,height:7,borderRadius:'50%',background:'#eab308',flexShrink:0,animation:'pulse 1s infinite'}}></span>
              <span style=${{fontSize:'0.75rem',color:'#facc15',flex:1}}>${sb.installing ? 'Waiting for installation...' : 'Connecting...'}</span>
            </div>
            ${sb.installing && html`<div style=${{fontSize:'0.63rem',color:'var(--text-faint)',lineHeight:1.5}}>
              <b>1.</b> Run the downloaded file<br/>
              <code style=${{fontSize:'0.57rem',background:'var(--bg-tertiary)',padding:'2px 4px',borderRadius:3,wordBreak:'break-all'}}>${dl.cmd}</code>
              <br/><b>2.</b> The bridge installs to:<br/>
              <code style=${{fontSize:'0.57rem',background:'var(--bg-tertiary)',padding:'2px 4px',borderRadius:3,wordBreak:'break-all'}}>${dl.installPath}</code>
              <br/><b>3.</b> It will connect automatically — you can then delete the downloaded file
            </div>`}
          </div>`;
        }

        // Failed state
        if (sb.failed) {
          return html`<div style=${{display:'flex',flexDirection:'column',gap:'.4rem'}}>
            <div style=${{fontSize:'0.69rem',color:'#fca5a5'}}>Could not connect to Smart Bridge.</div>
            <div style=${{fontSize:'0.6rem',color:'var(--text-faint)',lineHeight:1.5}}>
              Start the bridge manually:<br/>
              <code style=${{fontSize:'0.57rem',background:'var(--bg-tertiary)',padding:'2px 4px',borderRadius:3,wordBreak:'break-all'}}>${dl.installPath}</code>
            </div>
            <div style=${{display:'flex',gap:'.3rem'}}>
              <button onClick=${function(){ _connectBridge(d); }}
                style=${{padding:'.25rem .6rem',borderRadius:5,fontSize:'0.69rem',fontWeight:600,cursor:'pointer',border:'none',background:'var(--accent)',color:'#fff',fontFamily:'inherit'}}>Retry</button>
              <button onClick=${function(){ _triggerDownload(); _connectBridge(d, {installing:true}); }}
                style=${{padding:'.25rem .6rem',borderRadius:5,fontSize:'0.69rem',fontWeight:600,cursor:'pointer',border:'none',background:'#1e3a5f',color:'#93c5fd',fontFamily:'inherit'}}>Re-download</button>
            </div>
          </div>`;
        }

        // Idle state (not connected, not trying)
        return html`<div style=${{display:'flex',flexDirection:'column',gap:'.4rem'}}>
          <div style=${{fontSize:'0.63rem',color:'var(--text-faint)',lineHeight:1.5}}>
            Connect any AI assistant to control ClashControl with natural language. Supports Claude, ChatGPT, and more.
          </div>
          ${sb.wasInstalled ?
            html`<button onClick=${function(){ _connectBridge(d); }}
              style=${{padding:'.3rem .7rem',borderRadius:6,fontSize:'0.75rem',fontWeight:600,cursor:'pointer',border:'none',background:'var(--accent)',color:'#fff',fontFamily:'inherit',width:'100%'}}>Connect to Smart Bridge</button>
            ${_cleanupRow}` :
            html`<button onClick=${function(){ _triggerDownload(); _connectBridge(d, {installing:true}); }}
              style=${{padding:'.3rem .7rem',borderRadius:6,fontSize:'0.75rem',fontWeight:600,cursor:'pointer',border:'none',background:'var(--accent)',color:'#fff',fontFamily:'inherit',width:'100%'}}>Install & Connect</button>`}
          <div style=${{display:'flex',gap:'.3rem',flexWrap:'wrap'}}>
            ${Object.keys(_downloads).map(function(k) {
              var d2 = _downloads[k];
              return html`<a key=${k} href=${d2.url} download="" style=${{fontSize:'0.57rem',color:'var(--text-faint)',textDecoration:'underline'}}>${d2.label}</a>`;
            })}
          </div>
        </div>`;
      }
    });
  }

  // ── Deferred init fallback ────────────────────────────────────────
  // React 18 (createRoot) schedules its first render asynchronously.
  // If this script loads from HTTP cache before React renders,
  // window._ccDispatch is undefined when _ccRegisterAddon runs, so
  // init() is silently skipped and the bridge never auto-reconnects.
  // Poll here until dispatch is ready and call _doInit ourselves.
  // _doInit is idempotent (_connectWs guards against double-connect),
  // so it's safe even if _ccRegisterAddon did call init() after all.
  (function() {
    if (window._ccDispatch) return; // dispatch was ready, _ccRegisterAddon already called init
    if (!window._ccIsAddonActive || !window._ccIsAddonActive('smart-bridge')) return; // not active
    var _t = setInterval(function() {
      if (window._ccDispatch) {
        clearInterval(_t);
        if (window._ccIsAddonActive('smart-bridge')) {
          console.log('[Smart Bridge] Deferred init (dispatch was not ready at register time)');
          _doInit(window._ccDispatch);
        }
      }
    }, 20);
  })();

})();
