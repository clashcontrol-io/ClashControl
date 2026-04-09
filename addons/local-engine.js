// ── ClashControl Addon: ClashControlEngine ──────────────────────
// Connects to a localhost Python server (port 19800) for exact mesh
// intersection. Falls back to the built-in browser OBB engine when
// the server isn't running.
//
// Targets clashcontrol-engine v0.2.1 (see _engineReleaseTag below).
//
// Install (recommended):
//   pip install clashcontrol-engine
//   clashcontrol-engine --install   # registers clashcontrol:// handler + starts engine
//
// Standalone binaries (v0.2.1) are also available via the GitHub
// releases page — mac/linux as .tar.gz, Windows as .exe.

(function() {
  'use strict';

  var _localEngineUrl = 'http://localhost:19800';
  var _localEngineWsUrl = 'ws://localhost:19801';
  var _engineVersion = null;
  var _engineCores = null;
  var _engineBackends = null;
  var _lastKnownVersion = null;

  // ── Download URLs for standalone executables ──────────────────
  // Pinned to clashcontrol-engine v0.2.1. mac/linux ship as tar.gz
  // (preserves executable bit); Windows is a self-contained .exe.
  var _engineReleaseTag = 'v0.2.1';
  var _releaseBase = 'https://github.com/clashcontrol-io/ClashControlEngine/releases/download/' + _engineReleaseTag + '/';
  var _downloads = {
    win:   {url: _releaseBase + 'clashcontrol-engine-win.exe',       label: 'Windows (.exe)',    cmd: 'clashcontrol-engine.exe --install'},
    mac:   {url: _releaseBase + 'clashcontrol-engine-mac.tar.gz',    label: 'macOS (.tar.gz)',   cmd: 'tar -xzf clashcontrol-engine-mac.tar.gz\n./clashcontrol-engine --install'},
    linux: {url: _releaseBase + 'clashcontrol-engine-linux.tar.gz',  label: 'Linux (.tar.gz)',   cmd: 'tar -xzf clashcontrol-engine-linux.tar.gz\n./clashcontrol-engine --install'}
  };

  function _detectOS() {
    var ua = navigator.userAgent || '';
    if (/Win/.test(navigator.platform || ua)) return 'win';
    if (/Mac/.test(navigator.platform || ua)) return 'mac';
    return 'linux';
  }

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
    if (d) d({t:'UPD_LOCAL_ENGINE', u:{
      available:true, checking:false, connecting:false, failed:false,
      active:true, wasInstalled:true,
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

    // Clear any prior failed state so retries start clean.
    if (d) d({t:'UPD_LOCAL_ENGINE', u:{connecting:true, checking:false, failed:false}});

    var deadline = Date.now() + 6000;
    function tick() {
      if (Date.now() >= deadline) {
        // Connect timed out — we are confident the engine is not installed
        // (or at least not reachable). Flip `failed` so the UI shows the
        // download card instead of just a bare "Not connected" label.
        if (d) d({t:'UPD_LOCAL_ENGINE', u:{connecting:false, available:false, failed:true}});
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

  window._ccRegisterAddon({
    id: 'local-engine',
    name: 'ClashControlEngine',
    description: 'Multi-threaded local server for exact mesh intersection. 5-10x faster on large models.',
    autoActivate: false,
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>',

    initState: {
      // `failed` is session-only: set when a connect attempt times out so
      // the UI knows to show the download card. Cleared on every new
      // Connect click so retries start from a clean state.
      localEngine: { available: false, active: false, checking: false, connecting: false, failed: false, wasInstalled: false, version: null, cores: null, backends: null }
    },

    reducerCases: {
      'UPD_LOCAL_ENGINE': function(s, a) {
        return Object.assign({}, s, {localEngine: Object.assign({}, s.localEngine, a.u)});
      }
    },

    init: function(dispatch) {
      console.log('[LocalEngine] Addon init');
      var wasActive = false;
      try { wasActive = localStorage.getItem('cc_local_engine') === '1'; } catch(e){}
      if (wasActive) {
        dispatch({t:'UPD_LOCAL_ENGINE', u:{active:true, wasInstalled:true}});
      }
      // Passive probe only — we can't fire the URL scheme without a
      // user gesture, so the actual connect happens on button click or onEnable.
      _checkLocalEngine(dispatch);
    },

    // Called from within the Enable button's click handler (user gesture),
    // so firing the URL scheme here is safe. Skips the "Connect" button step.
    onEnable: function(dispatch) {
      _connectLocalEngine(dispatch).catch(function(err) {
        console.log('[LocalEngine] onEnable connect failed:', err && err.message || err);
      });
    },

    destroy: function() {},

    panel: function(html, s, d) {
      var le = s.localEngine || {};
      var os = _detectOS();
      var dl = _downloads[os];

      // ── Connected ─────────────────────────────────────────────
      if (le.available) {
        return html`<div style=${{padding:'.5rem 0',fontSize:'0.78rem',color:'var(--text-secondary)',lineHeight:1.7}}>
          <div style=${{display:'flex',alignItems:'center',gap:'.4rem',marginBottom:'.3rem',flexWrap:'wrap'}}>
            <span style=${{width:7,height:7,borderRadius:'50%',background:'#22c55e',display:'inline-block'}}></span>
            <span style=${{fontWeight:600,color:'var(--text-primary)'}}>Connected</span>
            ${le.version && html`<span style=${{fontSize:'0.63rem',color:'var(--text-faint)'}}>v${le.version}</span>`}
            ${le.cores && html`<span style=${{fontSize:'0.63rem',color:'var(--text-faint)'}}>\u00b7 ${le.cores} cores</span>`}
          </div>
          ${le.backends && le.backends.length ? html`<div style=${{fontSize:'0.63rem',color:'var(--text-faint)',marginBottom:'.4rem'}}>
            Backends: ${le.backends.join(', ')}
          </div>` : null}
          <div style=${{display:'flex',gap:'.3rem'}}>
            <button onClick=${function(){_checkLocalEngine(d);}} disabled=${le.checking}
              style=${{padding:'.3rem .6rem',borderRadius:6,fontSize:'0.75rem',fontWeight:600,cursor:'pointer',
                border:'1px solid var(--border)',background:'var(--bg-secondary)',color:'var(--text-secondary)',fontFamily:'inherit',
                opacity:le.checking?0.5:1}}>
              ${le.checking?'Checking\u2026':'Refresh'}</button>
            <button onClick=${function(){
              var newActive=!le.active;try{localStorage.setItem('cc_local_engine',newActive?'1':'0');}catch(e){}
              d({t:'UPD_LOCAL_ENGINE',u:{active:newActive}});
            }} style=${{padding:'.3rem .6rem',borderRadius:6,fontSize:'0.75rem',fontWeight:600,cursor:'pointer',border:'none',fontFamily:'inherit',
              background:le.active?'var(--bg-secondary)':'#2563eb',color:le.active?'var(--text-secondary)':'#fff'}}>
              ${le.active?'Disconnect':'Use for Detection'}</button>
          </div>
        </div>`;
      }

      // ── Connecting (URL scheme fired, polling /status) ───────
      if (le.connecting) {
        return html`<div style=${{padding:'.5rem 0',fontSize:'0.78rem',color:'var(--text-secondary)',lineHeight:1.7}}>
          <div style=${{display:'flex',alignItems:'center',gap:'.4rem',marginBottom:'.4rem'}}>
            <div style=${{width:12,height:12,border:'2px solid #eab308',borderTopColor:'transparent',borderRadius:'50%',animation:'cc-spin .6s linear infinite'}}></div>
            <span style=${{color:'#eab308',fontWeight:600}}>Starting engine\u2026</span>
          </div>
          <div style=${{fontSize:'0.65rem',color:'var(--text-faint)',lineHeight:1.6}}>
            Waiting for the local engine to boot (up to 6 seconds). First launch can be slower while Python imports load.
          </div>
        </div>`;
      }

      // ── Three resting states (not counting transient "connecting") ──
      // 1. Not installed        — le.failed === true: confirmed timeout,
      //                           show Connect button + download card.
      // 2. Installed, not running — le.wasInstalled && !le.failed: show
      //                           Connect button with a "Not running" hint,
      //                           no download card (user just needs to launch).
      // 3. Unknown (initial load) — !le.wasInstalled && !le.failed: show
      //                           Connect button prominently. No download
      //                           card — if they click Connect and it
      //                           times out we flip to state 1.

      var statusLabel, statusDot, statusBlurb;
      if (le.failed) {
        statusLabel = 'Engine not installed';
        statusDot = '#ef4444';
        statusBlurb = 'Couldn\'t reach the engine after 6 seconds. Install it below and click Connect again.';
      } else if (le.wasInstalled) {
        statusLabel = 'Engine not running';
        statusDot = '#f97316';
        statusBlurb = 'Click Connect to launch the installed engine.';
      } else {
        statusLabel = 'Not connected';
        statusDot = '#64748b';
        statusBlurb = 'Click Connect to launch the engine. If it\u2019s not installed yet, you\u2019ll see install options.';
      }

      return html`<div style=${{padding:'.5rem 0',fontSize:'0.78rem',color:'var(--text-secondary)',lineHeight:1.7}}>
        <div style=${{display:'flex',alignItems:'center',gap:'.4rem',marginBottom:'.45rem'}}>
          <span style=${{width:7,height:7,borderRadius:'50%',background:statusDot,display:'inline-block'}}></span>
          <span>${statusLabel}</span>
        </div>

        <button onClick=${function(){
          _connectLocalEngine(d).catch(function(err){
            console.log('[LocalEngine] Connect failed:', err && err.message || err);
          });
        }} style=${{display:'flex',alignItems:'center',justifyContent:'center',gap:'.4rem',width:'100%',
            padding:'.5rem .7rem',borderRadius:6,fontSize:'0.8rem',fontWeight:600,cursor:'pointer',border:'none',
            background:'var(--accent)',color:'#fff',fontFamily:'inherit',marginBottom:'.5rem'}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6"/>
          </svg> Connect to Engine
        </button>
        <div style=${{fontSize:'0.64rem',color:'var(--text-faint)',lineHeight:1.6,marginBottom:'.55rem'}}>
          ${statusBlurb}
        </div>

        ${le.failed ? html`<div style=${{borderTop:'1px solid var(--border-subtle)',paddingTop:'.5rem'}}>
          <div style=${{display:'flex',alignItems:'center',gap:'.35rem',marginBottom:'.3rem'}}>
            <div style=${{fontSize:'0.68rem',fontWeight:600,color:'var(--text-secondary)',textTransform:'uppercase',letterSpacing:'.04em'}}>Install</div>
            <span style=${{fontSize:'0.58rem',fontWeight:600,padding:'1px 5px',borderRadius:4,background:'var(--tag-bg)',color:'var(--text-faint)'}}>engine ${_engineReleaseTag}</span>
          </div>
          <div style=${{fontSize:'0.65rem',color:'var(--text-faint)',marginBottom:'.3rem',lineHeight:1.6}}>
            With Python (recommended):
          </div>
          <pre style=${{fontSize:'0.66rem',background:'var(--tag-bg)',padding:'.4rem .55rem',borderRadius:5,color:'var(--text-primary)',
            fontFamily:'var(--font-mono,monospace)',margin:'0 0 .4rem',whiteSpace:'pre-wrap',lineHeight:1.55,overflowX:'auto'}}>pip install clashcontrol-engine
clashcontrol-engine --install</pre>
          <div style=${{fontSize:'0.62rem',color:'var(--text-faint)',marginBottom:'.5rem',lineHeight:1.6}}>
            <code style=${{fontSize:'0.62rem'}}>--install</code> registers the <code style=${{fontSize:'0.62rem'}}>clashcontrol://</code> handler and starts the engine, so the Connect button works right away.
          </div>

          <div style=${{fontSize:'0.65rem',color:'var(--text-faint)',marginBottom:'.3rem',lineHeight:1.6}}>
            Or download a standalone binary:
          </div>
          <a href=${dl.url} download
            style=${{display:'flex',alignItems:'center',justifyContent:'center',gap:'.3rem',
              padding:'.35rem .55rem',borderRadius:5,fontSize:'0.72rem',fontWeight:600,
              border:'1px solid var(--border)',background:'var(--bg-secondary)',color:'var(--text-secondary)',
              fontFamily:'inherit',textDecoration:'none',marginBottom:'.3rem'}}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            Download for ${dl.label}
          </a>
          <pre style=${{fontSize:'0.64rem',background:'var(--tag-bg)',padding:'.35rem .55rem',borderRadius:5,color:'var(--text-primary)',
            fontFamily:'var(--font-mono,monospace)',margin:'0 0 .4rem',whiteSpace:'pre-wrap',lineHeight:1.55,overflowX:'auto'}}>${dl.cmd}</pre>

          <div style=${{display:'flex',gap:'.3rem',alignItems:'center',flexWrap:'wrap',fontSize:'0.62rem',color:'var(--text-faint)'}}>
            Also:
            ${os!=='win'&&html`<a href=${_downloads.win.url} download style=${{color:'var(--text-faint)',textDecoration:'underline'}}>Windows</a>`}
            ${os!=='mac'&&html`<a href=${_downloads.mac.url} download style=${{color:'var(--text-faint)',textDecoration:'underline'}}>macOS</a>`}
            ${os!=='linux'&&html`<a href=${_downloads.linux.url} download style=${{color:'var(--text-faint)',textDecoration:'underline'}}>Linux</a>`}
            <span style=${{margin:'0 .2rem'}}>\u00b7</span>
            <a href="https://github.com/clashcontrol-io/ClashControlEngine" target="_blank" rel="noopener"
              style=${{color:'var(--accent)',textDecoration:'none'}}>GitHub repo</a>
          </div>
        </div>` : html`<div style=${{fontSize:'0.62rem',color:'var(--text-faint)',lineHeight:1.6}}>
          Not installed? <a href="https://github.com/clashcontrol-io/ClashControlEngine#install" target="_blank" rel="noopener" style=${{color:'var(--accent)'}}>Install instructions</a>
        </div>`}
      </div>`;
    }
  });

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
