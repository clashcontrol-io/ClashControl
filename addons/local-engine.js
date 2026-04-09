// ── ClashControl Addon: ClashControlEngine ──────────────────────
// Connects to a localhost Python server (port 19800) for exact mesh
// intersection. Falls back to the built-in browser OBB engine when
// the server isn't running.
//
// Install (recommended):
//   pip install clashcontrol-engine
//   clashcontrol-engine --install   # registers clashcontrol:// handler + starts engine
//
// Standalone binaries are also available via the GitHub releases page.

(function() {
  'use strict';

  var _localEngineUrl = 'http://localhost:19800';
  var _localEngineWsUrl = 'ws://localhost:19801';
  var _engineVersion = null;
  var _engineCores = null;
  var _engineBackends = null;
  var _lastKnownVersion = null;

  // ── Single /status probe with configurable timeout ───────────
  function _probeStatus(timeoutMs) {
    var fetchOpts = {method:'GET', cache:'no-store'};
    try { if (AbortSignal.timeout) fetchOpts.signal = AbortSignal.timeout(timeoutMs || 500); } catch(e){}
    return fetch(_localEngineUrl + '/status', fetchOpts)
      .then(function(r){ if (!r.ok) throw new Error('HTTP '+r.status); return r.json(); });
  }

  // Extract engine metadata from a /status JSON payload and detect
  // version changes, which the UI treats as "force reconnect" because
  // the new engine may have a different port or backend set.
  function _applyStatus(j, d) {
    var version = j && j.version || null;
    var cores = j && j.cores || null;
    var backends = j && j.backends || null;
    var versionChanged = !!(_lastKnownVersion && version && version !== _lastKnownVersion);
    if (versionChanged) {
      console.log('[LocalEngine] Version changed ' + _lastKnownVersion + ' \u2192 ' + version + ', forcing reconnect');
    }
    _engineVersion = version;
    _engineCores = cores;
    _engineBackends = backends;
    _lastKnownVersion = version;
    // Preserve the user's active preference — don't force-enable if they disabled it
    var prevActive = true;
    try { var _s = localStorage.getItem('cc_local_engine'); prevActive = _s === null ? true : _s === '1'; } catch(e){}
    if (d) d({t:'UPD_LOCAL_ENGINE', u:{
      available:true, checking:false, connecting:false,
      active:prevActive, wasInstalled:true,
      version:version, cores:cores, backends:backends
    }});
    try { localStorage.setItem('cc_local_engine','1'); } catch(e){}
    return {versionChanged: versionChanged, version: version};
  }

  // ── Passive check: a single /status probe ────────────────────
  // Used on addon init and for the "Refresh" button in the connected
  // panel. Does NOT trigger the URL-scheme launcher.
  function _checkLocalEngine(d) {
    if (d) d({t:'UPD_LOCAL_ENGINE', u:{checking:true}});
    return _probeStatus(2000)
      .then(function(j){
        _applyStatus(j, d);
        return true;
      })
      .catch(function(err){
        console.log('[LocalEngine] /status probe failed:', err && err.message || err);
        if (d) d({t:'UPD_LOCAL_ENGINE', u:{available:false, checking:false}});
        return false;
      });
  }

  // ── Optimistic connect: URL scheme → poll → fall through ─────
  //
  // 1. Fire clashcontrol://start via an <a>.click() inside the user
  //    gesture. The browser has no API to check handler availability;
  //    we just try. A user-gesture anchor click is the only form most
  //    browsers route to a custom scheme without a security prompt.
  // 2. Poll /status every 300ms for up to ~6s while the daemon boots.
  //    6s is deliberately generous: a cold Python interpreter can take
  //    2-4s to import numpy/scipy/numba on first launch.
  // 3. If nothing responds, reject with ENGINE_NOT_INSTALLED and let
  //    the UI show first-run install instructions.
  //
  // MUST be called from within a user-gesture handler (e.g. onClick).
  function _connectLocalEngine(d) {
    // 1. Trigger the custom-scheme handler via a user-gesture click.
    //    Using <a>.click() rather than window.location.href because
    //    anchor-click is the only form browsers consistently honor
    //    for custom schemes without a security prompt.
    try {
      var a = document.createElement('a');
      a.href = 'clashcontrol://start';
      a.rel = 'noopener';
      a.click();
    } catch (e) {
      console.log('[LocalEngine] URL-scheme launch failed:', e && e.message || e);
    }

    if (d) d({t:'UPD_LOCAL_ENGINE', u:{connecting:true, checking:false}});

    var deadline = Date.now() + 6000;
    function tick() {
      if (Date.now() >= deadline) {
        if (d) d({t:'UPD_LOCAL_ENGINE', u:{connecting:false, available:false}});
        var err = new Error('ENGINE_NOT_INSTALLED');
        err.code = 'ENGINE_NOT_INSTALLED';
        return Promise.reject(err);
      }
      return _probeStatus(500)
        .then(function(j){
          _applyStatus(j, d);
          return j;
        })
        .catch(function() {
          return new Promise(function(r){ setTimeout(r, 300); }).then(tick);
        });
    }
    return tick();
  }

  // ── Self-initialize: probe engine on load ────────────────────
  // The file is loaded after the app mounts so window._ccDispatch should
  // be available shortly. Poll for it then run a passive status probe.
  function _selfInit() {
    if (!window._ccDispatch) { setTimeout(_selfInit, 100); return; }
    console.log('[LocalEngine] Self-init');
    _checkLocalEngine(window._ccDispatch);
  }
  setTimeout(_selfInit, 50);

  // ── Engine communication ──────────────────────────────────────

  function _serializeForLocalEngine(models, rules) {
    var elements = [];
    models.forEach(function(m) {
      if (!m.elements) return;
      m.elements.forEach(function(el) {
        if (!el.meshes || !el.meshes.length) return;
        var verts = [], indices = [];
        el.meshes.forEach(function(mesh) {
          if (!mesh.geometry) return;
          var pos = mesh.geometry.attributes.position;
          var idx = mesh.geometry.index;
          var offset = verts.length / 3;
          var v = new THREE.Vector3();
          for (var i = 0; i < pos.count; i++) {
            v.set(pos.getX(i), pos.getY(i), pos.getZ(i));
            v.applyMatrix4(mesh.matrixWorld);
            verts.push(v.x, v.y, v.z);
          }
          if (idx) { for (var j = 0; j < idx.count; j++) indices.push(idx.getX(j) + offset); }
          else { for (var j = 0; j < pos.count; j++) indices.push(j + offset); }
        });
        if (verts.length === 0) return;
        elements.push({
          id: el.expressId || el.id, modelId: m.id,
          ifcType: el.props && el.props.ifcType || '',
          name: el.props && el.props.name || '',
          storey: el.props && el.props.storey || '',
          discipline: m.discipline || '',
          vertices: verts, indices: indices
        });
      });
    });
    var r = {modelA:rules.modelA, modelB:rules.modelB, maxGap:rules.maxGap||0, mode:rules.mode||'hard'};
    if (rules.excludeSelf != null) r.excludeSelf = rules.excludeSelf;
    if (rules.excludeTypePairs) r.excludeTypePairs = rules.excludeTypePairs;
    return {elements:elements, rules:r};
  }

  function _detectOnLocalEngine(models, rules, onProgress) {
    var payload = _serializeForLocalEngine(models, rules);
    var progressWs = null;
    try {
      progressWs = new WebSocket(_localEngineWsUrl);
      progressWs.onmessage = function(e) {
        try {
          var msg = JSON.parse(e.data);
          if (msg.type === 'progress' && onProgress && msg.total > 0) onProgress(msg.done, msg.total);
          if (msg.type === 'complete') console.log('%c[Engine] Done: ' + msg.clashCount + ' clashes in ' + msg.duration_ms + 'ms', 'color:#4ade80');
        } catch(ex){}
      };
    } catch(ex){}

    return fetch(_localEngineUrl + '/detect', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)})
    .then(function(r){ return r.json(); })
    .then(function(result) {
      if (progressWs) try{progressWs.close();}catch(ex){}
      if (result && result.error) { console.warn('[Engine] Server error:', result.error); return null; }
      if (!result || !result.clashes) return [];
      // Log stats if available
      if (result.stats) {
        console.log('%c[Engine] ' + result.stats.elementCount + ' elements, ' + result.stats.candidatePairs + ' candidates, ' +
          result.stats.clashCount + ' clashes, ' + result.stats.duration_ms + 'ms (' + result.stats.threads + ' threads)', 'color:#60a5fa');
      }
      // Build lookup map for faster element resolution
      var elMap = {};
      models.forEach(function(m) { if (!m.elements) return; m.elements.forEach(function(el) { elMap[el.expressId||el.id] = el; }); });
      return result.clashes.map(function(c) {
        var elA = elMap[c.elementA], elB = elMap[c.elementB];
        if (!elA || !elB) return null;
        var pt = c.point ? new THREE.Vector3(c.point[0], c.point[1], c.point[2]) : new THREE.Vector3();
        return {id:c.id||(c.elementA+'_'+c.elementB), elementA:elA, elementB:elB, point:pt,
          distance:c.distance!=null?c.distance:0, volume:c.volume||0,
          type:c.type||(rules.mode==='soft'?'clearance':'hard'), status:'open', source:'local_engine'};
      }).filter(Boolean);
    })
    .catch(function(err) {
      if (progressWs) try{progressWs.close();}catch(ex){}
      console.warn('[Engine] Detection failed, falling back to browser:', err);
      return null;
    });
  }

  window._checkLocalEngine = _checkLocalEngine;
  window._connectLocalEngine = _connectLocalEngine;
  window._detectOnLocalEngine = _detectOnLocalEngine;
})();
