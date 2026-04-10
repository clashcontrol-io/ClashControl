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

  // ── Download URLs for standalone binaries ─────────────────────────
  var _releaseTag = 'v0.1.1';
  var _releaseBase = 'https://github.com/clashcontrol-io/ClashControlSmartBridge/releases/download/' + _releaseTag + '/';
  var _downloads = {
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
    return true;
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

  // ── Connect with polling ──────────────────────────────────────────

  var _connectGen = 0;
  function _cancelPendingConnect() { _connectGen++; }
  var _wsGen = 0;

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
        if (d) d({t:'UPD_SMART_BRIDGE', u:{connecting:false, installing:false, failed:true}});
        return Promise.reject(new Error('BRIDGE_NOT_INSTALLED'));
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

  // ── Action handlers ───────────────────────────────────────────────

  var handlers = {};

  handlers.get_status = function() {
    var s = _getState();
    var models = (s.models || []).map(function(m) {
      return { name: m.name, discipline: m.discipline || 'Unknown', elements: (m.elements || []).length, visible: m.visible !== false };
    });
    var r = s.rules || {};
    return {
      models: models, modelCount: models.length,
      clashCount: (s.clashes || []).length,
      openClashes: (s.clashes || []).filter(function(c) { return c.status !== 'resolved'; }).length,
      issueCount: (s.issues || []).length,
      activeProject: s.activeProject || null,
      rules: { maxGap: r.maxGap || 10, hard: !!r.hard, modelA: r.modelA || 'all', modelB: r.modelB || 'all', excludeSelf: !!r.excludeSelf },
      activeTab: s.tab || 'clashes', walkMode: !!s.walkMode,
      theme: document.documentElement.getAttribute('data-theme') || 'dark'
    };
  };

  handlers.get_clashes = function(p) {
    var s = _getState();
    var clashes = s.clashes || [];
    if (p.status && p.status !== 'all') clashes = clashes.filter(function(c) { return c.status === p.status; });
    var limit = p.limit || 50;
    return {
      total: clashes.length,
      clashes: clashes.slice(0, limit).map(function(c, i) {
        return { index: i, title: c.title || c.aiTitle || ('Clash ' + (i + 1)),
          status: c.status || 'open', priority: c.priority || 'normal',
          storey: c.storey || null, typeA: c.typeA || null, typeB: c.typeB || null,
          nameA: c.nameA || null, nameB: c.nameB || null,
          distance: c.distance != null ? c.distance : null,
          aiSeverity: c.aiSeverity || null, aiCategory: c.aiCategory || null };
      })
    };
  };

  handlers.get_issues = function(p) {
    var s = _getState(); var issues = s.issues || []; var limit = p.limit || 50;
    return { total: issues.length,
      issues: issues.slice(0, limit).map(function(issue, i) {
        return { index: i, title: issue.title || ('Issue ' + (i + 1)),
          status: issue.status || 'open', priority: issue.priority || 'normal',
          assignee: issue.assignee || null, description: issue.description || null };
      })
    };
  };

  handlers.run_detection = function(p) {
    var s = _getState();
    if (!s.models || !s.models.length) return 'No models loaded. Open an IFC file first.';
    var updates = {};
    if (p.modelA) updates.modelA = p.modelA;
    if (p.modelB) updates.modelB = p.modelB;
    if (p.maxGap != null) updates.maxGap = p.maxGap;
    if (p.hard != null) updates.hard = p.hard;
    if (p.excludeSelf != null) updates.excludeSelf = p.excludeSelf;
    _dispatch({ t: 'UPD_RULES', u: updates });
    if (window._ccRunDetection) {
      window._ccRunDetection();
      return 'Detection started: ' + (p.modelA || 'all') + ' vs ' + (p.modelB || 'all') +
        (p.maxGap != null ? ', gap ' + p.maxGap + 'mm' : '') + (p.hard ? ', hard clashes' : '');
    }
    return 'Detection trigger not available. Make sure models are loaded.';
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
    if (p.clashIndex < 0 || p.clashIndex >= clashes.length) return 'Invalid clash index.';
    var u = {};
    if (p.status) u.status = p.status; if (p.priority) u.priority = p.priority;
    if (p.assignee != null) u.assignee = p.assignee; if (p.title) u.title = p.title;
    _dispatch({ t: 'UPD_CLASH', id: clashes[p.clashIndex].id, u: u });
    return 'Updated clash ' + (p.clashIndex + 1) + '.';
  };

  handlers.batch_update_clashes = function(p) {
    if (window._ccProcessNLCommand) return window._ccProcessNLCommand('batch ' + p.action + ' ' + p.filter) || 'Batch update applied.';
    return 'Batch update: not available.';
  };

  handlers.set_view = function(p) {
    var viewMap = { top: 'top view', front: 'front view', back: 'back view', left: 'left view', right: 'right view', isometric: 'isometric view', reset: 'reset view' };
    if (window._ccProcessNLCommand) { window._ccProcessNLCommand(viewMap[p.view] || p.view); return (p.view === 'reset' ? 'View reset.' : p.view.charAt(0).toUpperCase() + p.view.slice(1) + ' view.'); }
    return 'View change not available.';
  };

  handlers.set_render_style = function(p) { _dispatch({ t: 'RENDER_STYLE', v: p.style || 'shaded' }); return 'Render style: ' + p.style; };
  handlers.set_section = function(p) { _dispatch({ t: 'SECTION', axis: p.axis === 'none' ? null : p.axis }); return p.axis === 'none' ? 'Section cleared.' : 'Section cut: ' + p.axis.toUpperCase(); };
  handlers.color_by = function(p) { var v = p.by === 'none' ? null : 'by' + p.by.charAt(0).toUpperCase() + p.by.slice(1); _dispatch({ t: 'COLOR_BY_CLASS', v: v }); return p.by === 'none' ? 'Colors reset.' : 'Colored by ' + p.by + '.'; };
  handlers.set_theme = function(p) { document.documentElement.setAttribute('data-theme', p.theme); try { localStorage.setItem('cc_theme', p.theme); } catch (e) {} return p.theme.charAt(0).toUpperCase() + p.theme.slice(1) + ' theme.'; };
  handlers.set_visibility = function(p) { if (p.option === 'grid') _dispatch({ t: 'TOGGLE_GRID', v: p.visible }); else if (p.option === 'axes') _dispatch({ t: 'TOGGLE_AXES', v: p.visible }); else if (p.option === 'markers') _dispatch({ t: 'TOGGLE_MARKERS', v: p.visible }); return (p.visible ? 'Showing' : 'Hiding') + ' ' + p.option + '.'; };
  handlers.restore_visibility = function() { if (window._ccUnghostAll) window._ccUnghostAll(); return 'All elements restored.'; };
  handlers.fly_to_clash = function(p) { var s = _getState(); var cl = s.clashes || []; if (p.clashIndex < 0 || p.clashIndex >= cl.length) return 'Invalid clash index.'; _dispatch({ t: 'SELECT_CLASH', id: cl[p.clashIndex].id }); return 'Flying to clash ' + (p.clashIndex + 1) + '.'; };
  handlers.navigate_tab = function(p) { _dispatch({ t: 'TAB', v: p.tab }); return 'Switched to ' + p.tab + ' tab.'; };
  handlers.filter_clashes = function(p) { var u = {}; if (p.status) u.status = p.status; if (p.priority) u.priority = p.priority; _dispatch({ t: 'UPD_FILTERS', u: u }); return 'Filters updated.'; };
  handlers.sort_clashes = function(p) { _dispatch({ t: 'CLASH_SORT', v: p.sortBy }); return 'Sorted by ' + p.sortBy + '.'; };
  handlers.group_clashes = function(p) { _dispatch({ t: 'CLASH_GROUP_BY', v: p.groupBy === 'none' ? [] : [p.groupBy] }); return 'Grouped by ' + p.groupBy + '.'; };
  handlers.export_bcf = function(p) { var s = _getState(); var items = s.issues && s.issues.length ? s.issues : (s.clashes || []); if (!items.length) return 'Nothing to export.'; if (window._ccExportBCF) { window._ccExportBCF(items, p.version || '2.1'); return 'Exported ' + items.length + ' items as BCF.'; } return 'BCF export not available.'; };
  handlers.create_project = function(p) { _dispatch({ t: 'CREATE_PROJECT', name: p.name }); return 'Project "' + p.name + '" created.'; };
  handlers.switch_project = function(p) { var s = _getState(); var projects = s.projectList || []; var match = projects.find(function(pr) { return (pr.name || '').toLowerCase().indexOf(p.name.toLowerCase()) >= 0; }); if (match) { _dispatch({ t: 'SET_PROJECT', id: match.id }); return 'Switched to "' + match.name + '".'; } return 'Project "' + p.name + '" not found.'; };
  handlers.measure = function(p) { if (p.mode === 'stop') { _dispatch({ t: 'MEASURE_MODE', v: null }); return 'Measurement stopped.'; } if (p.mode === 'clear') { _dispatch({ t: 'CLEAR_MEASUREMENTS' }); return 'Measurements cleared.'; } _dispatch({ t: 'MEASURE_MODE', v: p.mode }); return 'Measurement mode: ' + p.mode + '.'; };
  handlers.walk_mode = function(p) {
    if (p.enabled) {
      _dispatch({ t: 'WALK_MODE', v: true });
      if (window._ccWalkEnter) { var s = _getState(); var elev = 0; if (s.floorPlan) elev = s.floorPlan.elevation; else { var storeys = (typeof _ccCollectStoreys === 'function') ? _ccCollectStoreys(s.models || []) : []; if (storeys.length) { var gf = (typeof _ccStoreyToGeoFactor === 'function') ? _ccStoreyToGeoFactor(s.models || []) : 1; elev = storeys[0].elevation * gf; } } window._ccWalkEnter(elev); }
      return 'Walk mode activated.';
    } else { if (window._ccWalkExit) window._ccWalkExit(); _dispatch({ t: 'WALK_MODE', v: false }); return 'Walk mode deactivated.'; }
  };

  // ── WebSocket connection ──────────────────────────────────────────

  function _connectWs(d) {
    if (_ws && _ws.readyState <= 1) return;
    var capturedGen = _wsGen;
    try { _ws = new WebSocket(WS_URL); } catch (e) { return; }

    _ws.onopen = function() {
      _connected = true;
      if (d) d({t:'UPD_SMART_BRIDGE', u:{connected:true, bridgeUpdating:false, bridgeReconnecting:false}});
      console.log('%c[Smart Bridge] Connected', 'color:#22c55e;font-weight:bold');
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
        // Tool call request
        if (msg.id != null && msg.action) {
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
      if (d) d({t:'UPD_SMART_BRIDGE', u:{connected:false}});
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
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',

      initState: {
        smartBridge: { connected: false, available: false, checking: false,
          connecting: false, installing: false, failed: false,
          wasInstalled: false, version: null,
          updateAvailable: false, updateVersion: null, updateUrl: null,
          bridgeUpdating: false, bridgeReconnecting: false }
      },

      reducerCases: {
        'UPD_SMART_BRIDGE': function(s, a) {
          return Object.assign({}, s, { smartBridge: Object.assign({}, s.smartBridge, a.u) });
        }
      },

      init: function(dispatch) {
        console.log('[Smart Bridge] Addon activated');
        _doInit(dispatch);
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
        _disconnectWs();
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

        // Claude Desktop MCP config snippet
        var _claudeConfig = JSON.stringify({
          mcpServers: {
            clashcontrol: {
              command: dl.installPath,
              args: ['--mcp']
            }
          }
        }, null, 2);

        function _copyClaudeConfig() {
          navigator.clipboard.writeText(_claudeConfig).then(function() {
            // Brief visual feedback
            var btn = document.getElementById('cc-sb-copy-btn');
            if (btn) { var orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(function(){ btn.textContent = orig; }, 1500); }
          }).catch(function() {
            // Fallback: select a textarea
            var ta = document.createElement('textarea');
            ta.value = _claudeConfig; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select(); document.execCommand('copy');
            document.body.removeChild(ta);
            var btn = document.getElementById('cc-sb-copy-btn');
            if (btn) { var orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(function(){ btn.textContent = orig; }, 1500); }
          });
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
            (sb.updateVersion ? 'https://github.com/clashcontrol-io/ClashControlSmartBridge/releases/tag/v' + sb.updateVersion : null);
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
            <div style=${{fontSize:'0.63rem',color:'var(--text-faint)',lineHeight:1.6}}>
              Smart Bridge is running. Connect your AI assistant:
            </div>

            <div style=${{background:'var(--bg-secondary)',borderRadius:6,padding:'.5rem',display:'flex',flexDirection:'column',gap:'.4rem'}}>
              <div style=${{fontSize:'0.69rem',fontWeight:600,color:'#c084fc'}}>Claude Desktop / Claude Code</div>
              <div style=${{fontSize:'0.6rem',color:'var(--text-faint)',lineHeight:1.5}}>
                Add this to your Claude config file, then restart Claude:<br/>
                <span style=${{opacity:.7}}>${os === 'win' ? '%APPDATA%\\Claude\\claude_desktop_config.json' : '~/.claude/claude_desktop_config.json'}</span>
              </div>
              <pre style=${{..._codeStyle,margin:0,padding:'.4rem',whiteSpace:'pre-wrap',lineHeight:1.4}}>${_claudeConfig}</pre>
              <button id="cc-sb-copy-btn" onClick=${_copyClaudeConfig}
                style=${{..._btnSmall,background:'#7c3aed',color:'#fff',width:'100%'}}>Copy Claude Config</button>
            </div>

            <div style=${{background:'var(--bg-secondary)',borderRadius:6,padding:'.5rem',display:'flex',flexDirection:'column',gap:'.3rem'}}>
              <div style=${{fontSize:'0.69rem',fontWeight:600,color:'#22c55e'}}>ChatGPT</div>
              <div style=${{fontSize:'0.6rem',color:'var(--text-faint)',lineHeight:1.5}}>
                Create a custom GPT → Configure → Actions → Import from URL:
              </div>
              <code style=${_codeStyle}>http://localhost:19803/openapi.json</code>
            </div>

            <div style=${{background:'var(--bg-secondary)',borderRadius:6,padding:'.5rem',display:'flex',flexDirection:'column',gap:'.3rem'}}>
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
            </div>
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
