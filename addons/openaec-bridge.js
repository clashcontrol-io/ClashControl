// ClashControl ↔ OpenAEC bridge addon
// =====================================
//
// Integrates ClashControl with sibling AEC tooling from the OpenAEC
// Foundation. Phase 1 targets open-pointcloud-studio (OPS) — a Tauri
// desktop point-cloud viewer that exposes a localhost HTTP server.
//
// OPS public surface (verified from their main + api_server.rs):
//   • Server:        127.0.0.1:<port>  (port dynamic, starts at 49100)
//   • Discovery file: %APPDATA%\OpenNDStudio\instances\instance-<PID>.json
//                     ~/.config/open-nd-studio/instances/...
//   • GET  /health   → {"status":"ok"}
//   • GET  /info     → {pid, port, version}
//   • POST /eval     → {"script": "<JS>"} — executes in their webview
//   • OPTIONS *      → CORS preflight (Allow-Origin: *)
//
// CC is in a browser sandbox so it can't read the discovery file directly.
// Phase 1 probes the port range, finds OPS, and ships actions via /eval.
// When CC is itself a Tauri desktop build (planned), we can read the
// discovery file the proper way.
//
// The eval payload is built on a defensive convention: assume OPS exposes
// a `window.OPS` namespace once its frontend reaches a usable state. We
// guard every call with typeof checks and surface what's missing in the
// status so we don't make false promises in the UI. Final function names
// land via direct coordination with the OpenAEC team.

(function(){
  if (typeof window === 'undefined') return;

  // ── Configuration ─────────────────────────────────────────────
  // OPS scans 49100+ for a free port; we probe the first N ports in
  // parallel and pick the first that answers /health. Increase the range
  // if multiple instances are expected on one machine.
  var PORT_BASE  = 49100;
  var PORT_COUNT = 16;
  var PROBE_TIMEOUT_MS = 1500;
  var HEALTH_POLL_MS   = 15000; // re-confirm every 15 s once connected

  var _opsPort = null;     // null until discovered
  var _opsInfo = null;     // {pid, port, version}
  var _healthTimer = null;
  var _stateListeners = [];

  function _dispatch(u) {
    if (typeof window._ccDispatch === 'function') {
      try { window._ccDispatch({t:'UPD_OPENAEC_BRIDGE', u:u}); } catch(_) {}
    }
    _stateListeners.forEach(function(cb){ try { cb(u); } catch(_) {} });
  }

  function _baseUrl() {
    return _opsPort ? ('http://127.0.0.1:' + _opsPort) : null;
  }

  // ── Discovery ─────────────────────────────────────────────────
  // Probe the port range in parallel. First /health responder wins.
  function _probePort(port) {
    var ctrl;
    try { ctrl = new AbortController(); } catch(_) { ctrl = null; }
    var t = ctrl ? setTimeout(function(){ try { ctrl.abort(); } catch(_) {} }, PROBE_TIMEOUT_MS) : null;
    return fetch('http://127.0.0.1:' + port + '/health', ctrl ? {signal: ctrl.signal} : undefined)
      .then(function(r){
        if (t) clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function(j){
        if (j && j.status === 'ok') return port;
        throw new Error('Not OPS');
      })
      .catch(function(err){
        if (t) clearTimeout(t);
        throw err;
      });
  }

  function _discover() {
    _dispatch({checking:true});
    var attempts = [];
    for (var i = 0; i < PORT_COUNT; i++) {
      attempts.push(_probePort(PORT_BASE + i).catch(function(){ return null; }));
    }
    return Promise.all(attempts).then(function(results){
      var found = null;
      for (var k = 0; k < results.length; k++) if (results[k] !== null) { found = results[k]; break; }
      if (found === null) {
        _opsPort = null; _opsInfo = null;
        _dispatch({available:false, checking:false, port:null, info:null});
        return null;
      }
      _opsPort = found;
      return _getInfo().then(function(info){
        _opsInfo = info || null;
        _dispatch({available:true, checking:false, port:_opsPort, info:_opsInfo});
        return found;
      });
    });
  }

  function _getInfo() {
    var b = _baseUrl(); if (!b) return Promise.resolve(null);
    return fetch(b + '/info').then(function(r){ return r.ok ? r.json() : null; }).catch(function(){ return null; });
  }

  // ── Health watchdog ───────────────────────────────────────────
  function _startHealthPoll() {
    if (_healthTimer) return;
    _healthTimer = setInterval(function(){
      var b = _baseUrl(); if (!b) return;
      fetch(b + '/health').then(function(r){
        if (!r.ok) throw new Error('HTTP ' + r.status);
      }).catch(function(){
        // Lost connection — drop state and re-probe.
        _opsPort = null; _opsInfo = null;
        _dispatch({available:false, port:null, info:null});
      });
    }, HEALTH_POLL_MS);
  }
  function _stopHealthPoll() {
    if (_healthTimer) { clearInterval(_healthTimer); _healthTimer = null; }
  }

  // ── Eval RPC ──────────────────────────────────────────────────
  // POST /eval executes the script in OPS's webview. We wrap calls in a
  // top-level try and an existence check so a missing OPS function
  // surfaces as a structured error instead of a thrown exception inside
  // their app. The OPS /eval response is the script's return value
  // serialised via their tauri IPC; the 30-second timeout is their side.
  function _eval(script) {
    var b = _baseUrl();
    if (!b) return Promise.reject(new Error('OpenAEC bridge: not connected'));
    var wrapped = '(function(){ try { return (' + script + '); } catch(e) { return { error: String(e && e.message || e) }; } })()';
    return fetch(b + '/eval', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({script: wrapped})
    }).then(function(r){
      if (!r.ok) throw new Error('OPS /eval HTTP ' + r.status);
      return r.json();
    });
  }

  // ── Public actions ────────────────────────────────────────────
  // Each action is a thin wrapper around /eval that posts a script
  // targeting OPS's window-level API. We assume an `window.OPS` namespace;
  // when OpenAEC publishes their stable API names we swap them in here.
  // Until then each helper falls back to a "feature not yet wired" error
  // rather than silently no-op.

  // Open a point cloud file in OPS by its file path (OPS uses
  // tauri-plugin-fs and tauri-plugin-dialog, so it can resolve a
  // user-readable absolute path).
  window._ccOpenAECOpenCloud = function(filePath) {
    var script = "typeof window.OPS === 'object' && typeof window.OPS.openPointcloud === 'function' ? window.OPS.openPointcloud(" + JSON.stringify(filePath) + ") : { error: 'OPS.openPointcloud not available — confirm function name with OpenAEC' }";
    return _eval(script);
  };

  // Push the CC camera state to OPS so the user sees the same view in
  // both windows. Camera comes from window._ccViewport.getCamera() which
  // is documented and stable.
  window._ccOpenAECSyncCamera = function() {
    if (!window._ccViewport || typeof window._ccViewport.getCamera !== 'function') {
      return Promise.reject(new Error('CC viewport not ready'));
    }
    var cam = window._ccViewport.getCamera();
    if (!cam) return Promise.reject(new Error('No active camera'));
    var payload = {
      position: cam.position,
      target:   cam.target,
      up:       cam.up,
      fov:      cam.fov,
      isOrtho:  !!cam.isOrtho
    };
    var script = "typeof window.OPS === 'object' && typeof window.OPS.setCamera === 'function' ? window.OPS.setCamera(" + JSON.stringify(payload) + ") : { error: 'OPS.setCamera not available — confirm function name with OpenAEC' }";
    return _eval(script);
  };

  // Pull OPS's current camera so CC can mirror the view the other way.
  window._ccOpenAECPullCamera = function() {
    var script = "typeof window.OPS === 'object' && typeof window.OPS.getCamera === 'function' ? window.OPS.getCamera() : { error: 'OPS.getCamera not available — confirm function name with OpenAEC' }";
    return _eval(script).then(function(resp){
      // Tauri-side response shape depends on their api_eval_callback impl.
      // Conservatively unwrap a few common envelopes and fall through to
      // the raw object so we can iterate without breaking.
      var data = resp && (resp.result != null ? resp.result : resp);
      if (!data || data.error) throw new Error((data && data.error) || 'OPS returned no camera');
      if (!window._ccViewport || typeof window._ccViewport.flyTo !== 'function') return data;
      var p = data.position || [0,0,0];
      var t = data.target   || [0,0,0];
      window._ccViewport.flyTo(p[0], p[1], p[2], t[0], t[1], t[2]);
      return data;
    });
  };

  // List the point clouds OPS currently has open (so CC can decide
  // whether to "Open this file" or just sync the camera).
  window._ccOpenAECListClouds = function() {
    var script = "typeof window.OPS === 'object' && typeof window.OPS.listClouds === 'function' ? window.OPS.listClouds() : { error: 'OPS.listClouds not available — confirm function name with OpenAEC' }";
    return _eval(script);
  };

  // Status snapshot for the UI / Settings panel.
  window._ccOpenAECStatus = function() {
    return {
      connected: !!_opsPort,
      port:      _opsPort,
      info:      _opsInfo,
      baseUrl:   _baseUrl()
    };
  };
  window._ccOpenAECReconnect = function() {
    _opsPort = null; _opsInfo = null;
    return _discover().then(function(p){
      if (p) _startHealthPoll();
      return _ccOpenAECStatus();
    });
  };
  window._ccOpenAECOnChange = function(cb) {
    _stateListeners.push(cb);
    return function() { _stateListeners = _stateListeners.filter(function(f){return f!==cb;}); };
  };

  // ── Boot ──────────────────────────────────────────────────────
  // Fire-and-forget initial discovery. Failure here is the norm (OPS not
  // running) and must not block the rest of CC.
  function _init() {
    _discover().then(function(p){
      if (p) _startHealthPoll();
    }).catch(function(){});
  }

  if (typeof window._ccRegisterAddon === 'function') {
    window._ccRegisterAddon({
      id: 'openaec-bridge',
      name: 'OpenAEC bridge',
      description: 'Talks to sibling OpenAEC Foundation desktop apps over localhost — Phase 1 targets open-pointcloud-studio so CC can sync views, open scans, and round-trip viewpoints.',
      init: function(){ _init(); }
    });
  } else {
    // Fallback for environments where the addon registry isn't ready yet.
    setTimeout(_init, 0);
  }
})();
