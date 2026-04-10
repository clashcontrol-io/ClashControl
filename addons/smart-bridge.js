// ── ClashControl Addon: Smart Bridge ────────────────────────────────
// LLM bridge that connects ClashControl to AI assistants via WebSocket.
// Supports multiple connection options:
//   - Claude Desktop/Code (via MCP server)
//   - ChatGPT (via REST bridge + OpenAPI Actions)
//   - Any LLM with function calling (via REST API)
//
// Receives tool calls from the bridge server (localhost:19802),
// executes them via window._ccDispatch and friends, sends results back.

(function() {
  'use strict';

  var WS_URL = 'ws://127.0.0.1:19802';
  var _ws = null;
  var _reconnectTimer = null;
  var _reconnectDelay = 0;
  var _userDisabled = false;
  var _connected = false;

  // ── State helpers ─────────────────────────────────────────────────

  function _getState() {
    return window._ccLatestState || {};
  }

  function _dispatch(action) {
    if (window._ccDispatch) window._ccDispatch(action);
  }

  // ── Action handlers ───────────────────────────────────────────────
  // Each handler receives params and returns a result (string or object).

  var handlers = {};

  handlers.get_status = function() {
    var s = _getState();
    var models = (s.models || []).map(function(m) {
      return { name: m.name, discipline: m.discipline || 'Unknown', elements: (m.elements || []).length, visible: m.visible !== false };
    });
    var r = s.rules || {};
    return {
      models: models,
      modelCount: models.length,
      clashCount: (s.clashes || []).length,
      openClashes: (s.clashes || []).filter(function(c) { return c.status !== 'resolved'; }).length,
      issueCount: (s.issues || []).length,
      activeProject: s.activeProject || null,
      rules: { maxGap: r.maxGap || 10, hard: !!r.hard, modelA: r.modelA || 'all', modelB: r.modelB || 'all', excludeSelf: !!r.excludeSelf },
      activeTab: s.tab || 'clashes',
      walkMode: !!s.walkMode,
      theme: document.documentElement.getAttribute('data-theme') || 'dark'
    };
  };

  handlers.get_clashes = function(p) {
    var s = _getState();
    var clashes = s.clashes || [];
    if (p.status && p.status !== 'all') {
      clashes = clashes.filter(function(c) { return c.status === p.status; });
    }
    var limit = p.limit || 50;
    return {
      total: clashes.length,
      clashes: clashes.slice(0, limit).map(function(c, i) {
        return {
          index: i,
          title: c.title || c.aiTitle || ('Clash ' + (i + 1)),
          status: c.status || 'open',
          priority: c.priority || 'normal',
          storey: c.storey || null,
          typeA: c.typeA || null,
          typeB: c.typeB || null,
          nameA: c.nameA || null,
          nameB: c.nameB || null,
          distance: c.distance != null ? c.distance : null,
          aiSeverity: c.aiSeverity || null,
          aiCategory: c.aiCategory || null
        };
      })
    };
  };

  handlers.get_issues = function(p) {
    var s = _getState();
    var issues = s.issues || [];
    var limit = p.limit || 50;
    return {
      total: issues.length,
      issues: issues.slice(0, limit).map(function(issue, i) {
        return {
          index: i,
          title: issue.title || ('Issue ' + (i + 1)),
          status: issue.status || 'open',
          priority: issue.priority || 'normal',
          assignee: issue.assignee || null,
          description: issue.description || null
        };
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
    // Trigger detection via the global helper
    if (window._ccRunDetection) {
      window._ccRunDetection();
      return 'Detection started: ' + (p.modelA || 'all') + ' vs ' + (p.modelB || 'all') +
        (p.maxGap != null ? ', gap ' + p.maxGap + 'mm' : '') +
        (p.hard ? ', hard clashes' : '');
    }
    return 'Detection trigger not available. Make sure models are loaded.';
  };

  handlers.set_detection_rules = function(p) {
    var updates = {};
    if (p.maxGap != null) updates.maxGap = p.maxGap;
    if (p.hard != null) updates.hard = p.hard;
    if (p.excludeSelf != null) updates.excludeSelf = p.excludeSelf;
    if (p.duplicates != null) updates.duplicates = p.duplicates;
    _dispatch({ t: 'UPD_RULES', u: updates });
    return 'Detection rules updated.';
  };

  handlers.update_clash = function(p) {
    var s = _getState();
    var clashes = s.clashes || [];
    if (p.clashIndex < 0 || p.clashIndex >= clashes.length) return 'Invalid clash index.';
    var clash = clashes[p.clashIndex];
    var updates = {};
    if (p.status) updates.status = p.status;
    if (p.priority) updates.priority = p.priority;
    if (p.assignee != null) updates.assignee = p.assignee;
    if (p.title) updates.title = p.title;
    _dispatch({ t: 'UPD_CLASH', id: clash.id, u: updates });
    return 'Updated clash ' + (p.clashIndex + 1) + ': ' + JSON.stringify(updates);
  };

  handlers.batch_update_clashes = function(p) {
    // Delegate to processNLCommand for batch operations
    if (typeof processNLCommand === 'function') {
      return processNLCommand('batch ' + p.action + ' ' + p.filter, _getState(), _dispatch) || 'Batch update applied.';
    }
    return 'Batch update: not available in this context.';
  };

  handlers.set_view = function(p) {
    var viewMap = { top: 'top view', front: 'front view', back: 'back view', left: 'left view', right: 'right view', isometric: 'isometric view', reset: 'reset view' };
    var cmd = viewMap[p.view] || p.view;
    // Use the NL command processor for view changes
    if (window._ccProcessNLCommand) {
      window._ccProcessNLCommand(cmd);
      return (p.view === 'reset' ? 'View reset.' : p.view.charAt(0).toUpperCase() + p.view.slice(1) + ' view.');
    }
    return 'View change not available.';
  };

  handlers.set_render_style = function(p) {
    var map = { wireframe: 'wireframe', shaded: 'shaded', rendered: 'rendered', standard: 'standard' };
    _dispatch({ t: 'RENDER_STYLE', v: map[p.style] || 'shaded' });
    return 'Render style: ' + p.style;
  };

  handlers.set_section = function(p) {
    _dispatch({ t: 'SECTION', axis: p.axis === 'none' ? null : p.axis });
    return p.axis === 'none' ? 'Section cleared.' : 'Section cut: ' + p.axis.toUpperCase() + ' axis';
  };

  handlers.color_by = function(p) {
    var v = p.by === 'none' ? null : 'by' + p.by.charAt(0).toUpperCase() + p.by.slice(1);
    _dispatch({ t: 'COLOR_BY_CLASS', v: v });
    return p.by === 'none' ? 'Colors reset.' : 'Colored by ' + p.by + '.';
  };

  handlers.set_theme = function(p) {
    document.documentElement.setAttribute('data-theme', p.theme);
    try { localStorage.setItem('cc_theme', p.theme); } catch (e) {}
    return p.theme.charAt(0).toUpperCase() + p.theme.slice(1) + ' theme applied.';
  };

  handlers.set_visibility = function(p) {
    if (p.option === 'grid') _dispatch({ t: 'TOGGLE_GRID', v: p.visible });
    else if (p.option === 'axes') _dispatch({ t: 'TOGGLE_AXES', v: p.visible });
    else if (p.option === 'markers') _dispatch({ t: 'TOGGLE_MARKERS', v: p.visible });
    return (p.visible ? 'Showing' : 'Hiding') + ' ' + p.option + '.';
  };

  handlers.restore_visibility = function() {
    if (window._ccUnghostAll) window._ccUnghostAll();
    return 'All elements restored to full visibility.';
  };

  handlers.fly_to_clash = function(p) {
    var s = _getState();
    var clashes = s.clashes || [];
    if (p.clashIndex < 0 || p.clashIndex >= clashes.length) return 'Invalid clash index.';
    _dispatch({ t: 'SELECT_CLASH', id: clashes[p.clashIndex].id });
    return 'Flying to clash ' + (p.clashIndex + 1) + '.';
  };

  handlers.navigate_tab = function(p) {
    _dispatch({ t: 'TAB', v: p.tab });
    return 'Switched to ' + p.tab + ' tab.';
  };

  handlers.filter_clashes = function(p) {
    var u = {};
    if (p.status) u.status = p.status;
    if (p.priority) u.priority = p.priority;
    _dispatch({ t: 'UPD_FILTERS', u: u });
    return 'Filters updated.';
  };

  handlers.sort_clashes = function(p) {
    _dispatch({ t: 'CLASH_SORT', v: p.sortBy });
    return 'Sorted by ' + p.sortBy + '.';
  };

  handlers.group_clashes = function(p) {
    _dispatch({ t: 'CLASH_GROUP_BY', v: p.groupBy === 'none' ? [] : [p.groupBy] });
    return 'Grouped by ' + p.groupBy + '.';
  };

  handlers.export_bcf = function(p) {
    var s = _getState();
    var items = s.issues && s.issues.length ? s.issues : (s.clashes || []);
    if (!items.length) return 'Nothing to export — no clashes or issues.';
    if (window._ccExportBCF) {
      window._ccExportBCF(items, p.version || '2.1');
      return 'Exported ' + items.length + ' items as BCF ' + (p.version || '2.1') + '.';
    }
    return 'BCF export not available.';
  };

  handlers.create_project = function(p) {
    _dispatch({ t: 'CREATE_PROJECT', name: p.name });
    return 'Project "' + p.name + '" created.';
  };

  handlers.switch_project = function(p) {
    var s = _getState();
    var projects = s.projectList || [];
    var match = projects.find(function(proj) {
      return (proj.name || '').toLowerCase().indexOf(p.name.toLowerCase()) >= 0;
    });
    if (match) {
      _dispatch({ t: 'SET_PROJECT', id: match.id });
      return 'Switched to project "' + match.name + '".';
    }
    return 'Project "' + p.name + '" not found. Available: ' + projects.map(function(pr) { return pr.name; }).join(', ');
  };

  handlers.measure = function(p) {
    if (p.mode === 'stop') {
      _dispatch({ t: 'MEASURE_MODE', v: null });
      return 'Measurement stopped.';
    }
    if (p.mode === 'clear') {
      _dispatch({ t: 'CLEAR_MEASUREMENTS' });
      return 'Measurements cleared.';
    }
    _dispatch({ t: 'MEASURE_MODE', v: p.mode });
    return 'Measurement mode: ' + p.mode + '. Click elements in the 3D view.';
  };

  handlers.walk_mode = function(p) {
    if (p.enabled) {
      _dispatch({ t: 'WALK_MODE', v: true });
      if (window._ccWalkEnter) {
        var s = _getState();
        var elev = 0;
        if (s.floorPlan) elev = s.floorPlan.elevation;
        else {
          var storeys = (typeof _ccCollectStoreys === 'function') ? _ccCollectStoreys(s.models || []) : [];
          if (storeys.length) {
            var gf = (typeof _ccStoreyToGeoFactor === 'function') ? _ccStoreyToGeoFactor(s.models || []) : 1;
            elev = storeys[0].elevation * gf;
          }
        }
        window._ccWalkEnter(elev);
      }
      return 'Walk mode activated. Use WASD to move, click canvas for mouse look.';
    } else {
      if (window._ccWalkExit) window._ccWalkExit();
      _dispatch({ t: 'WALK_MODE', v: false });
      return 'Walk mode deactivated.';
    }
  };

  // ── WebSocket connection ──────────────────────────────────────────

  function _connect() {
    if (_userDisabled) return;
    if (_ws && _ws.readyState <= 1) return;

    try { _ws = new WebSocket(WS_URL); } catch (e) {
      _scheduleReconnect();
      return;
    }

    _ws.onopen = function() {
      _connected = true;
      _reconnectDelay = 0;
      _updateUI();
      console.log('%c[Smart Bridge] Connected to MCP server', 'color:#22c55e;font-weight:bold');
    };

    _ws.onmessage = function(evt) {
      try {
        var msg = JSON.parse(evt.data);
        if (msg.id != null && msg.action) {
          var handler = handlers[msg.action];
          var result;
          if (handler) {
            try {
              result = handler(msg.params || {});
            } catch (e) {
              result = 'Error executing ' + msg.action + ': ' + e.message;
            }
          } else {
            result = 'Unknown action: ' + msg.action;
          }
          _ws.send(JSON.stringify({ id: msg.id, result: result }));
        }
      } catch (e) {
        console.error('[Smart Bridge] Message error:', e);
      }
    };

    _ws.onclose = function() {
      _connected = false;
      _updateUI();
      _scheduleReconnect();
    };

    _ws.onerror = function() {
      // onclose will fire after this
    };
  }

  function _disconnect() {
    _userDisabled = true;
    clearTimeout(_reconnectTimer);
    if (_ws) { try { _ws.close(); } catch (e) {} }
    _ws = null;
    _connected = false;
    _updateUI();
  }

  function _scheduleReconnect() {
    if (_userDisabled) return;
    _reconnectDelay = Math.min((_reconnectDelay || 2000) * 1.5, 30000);
    _reconnectTimer = setTimeout(_connect, _reconnectDelay);
  }

  function _updateUI() {
    if (window._ccDispatch) {
      window._ccDispatch({ t: 'UPD_SMART_BRIDGE', u: { connected: _connected } });
    }
  }

  // ── Expose globals for the core UI ────────────────────────────────

  window._ccSmartBridgeConnect = function() { _userDisabled = false; _reconnectDelay = 0; _connect(); };
  window._ccSmartBridgeDisconnect = _disconnect;
  window._ccSmartBridgeStatus = function() { return { connected: _connected, url: WS_URL }; };

  // Auto-connect is handled by the addon init() callback above

  // Register as addon
  if (window._ccRegisterAddon) {
    window._ccRegisterAddon({
      id: 'smart-bridge',
      name: 'Smart Bridge',
      description: 'LLM bridge — connect Claude, ChatGPT, or any AI assistant to control ClashControl with natural language.',
      autoActivate: false,
      icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>',

      initState: {
        smartBridge: { connected: false }
      },

      reducerCases: {
        'UPD_SMART_BRIDGE': function(s, a) {
          return Object.assign({}, s, { smartBridge: Object.assign({}, s.smartBridge, a.u) });
        }
      },

      init: function(dispatch) {
        console.log('[Smart Bridge] Addon activated');
        var wasActive = false;
        try { wasActive = localStorage.getItem('cc_smart_bridge') === '1'; } catch (e) {}
        if (wasActive) {
          _userDisabled = false;
          _reconnectDelay = 0;
          setTimeout(_connect, 1500);
        }
      },

      destroy: function() {
        _disconnect();
        try { localStorage.removeItem('cc_smart_bridge'); } catch (e) {}
      },

      onEnable: function() {
        _userDisabled = false;
        _reconnectDelay = 0;
        _connect();
        try { localStorage.setItem('cc_smart_bridge', '1'); } catch (e) {}
      },

      onDisable: function() {
        _disconnect();
        try { localStorage.removeItem('cc_smart_bridge'); } catch (e) {}
      }
    });
  }

})();
