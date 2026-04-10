// ── ClashControl Addon: ClashControlEngine ──────────────────────
// Connects to a localhost Python server (port 19800) for exact mesh
// intersection. Falls back to the built-in browser OBB engine when
// the server isn't running.
//
// Targets clashcontrol-engine v0.2.2 (see _engineReleaseTag below).
//
// Install (recommended):
//   pip install clashcontrol-engine
//   clashcontrol-engine --install   # registers clashcontrol:// handler + starts engine
//
// Standalone binaries (v0.2.2) are also available via the GitHub
// releases page — mac/linux as .tar.gz, Windows as .exe.

(function() {
  'use strict';

  var _localEngineUrl = 'http://localhost:19800';
  var _localEngineWsUrl = 'ws://localhost:19801';
  var _engineVersion = null;
  var _engineCores = null;
  var _engineBackends = null;
  var _lastKnownVersion = null;
  var _updateChecked = false;   // true after the first /update check per connection
  var _updateInterval = null;   // periodic /update check handle

  // ── Download URLs for standalone executables ──────────────────
  // Pinned to clashcontrol-engine v0.2.2. mac/linux ship as tar.gz
  // (preserves executable bit); Windows is a self-contained .exe.
  var _engineReleaseTag = 'v0.2.2';
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

  // Generation counter for canceling in-flight connect polls. Every new
  // _connectLocalEngine call bumps this; tick() aborts if its captured
  // generation no longer matches. destroy() also bumps it to cancel.
  var _connectGen = 0;
  function _cancelPendingConnect() { _connectGen++; }

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
    if (versionChanged) { _updateChecked = false; }
    var updateAvailable = !!(j && j.update_available);
    var updateVersion = (j && j.update_version) || null;
    var updateUrl = (j && j.update_url) || null;
    if (d) d({t:'UPD_LOCAL_ENGINE', u:{
      available:true, checking:false, connecting:false, installing:false, failed:false,
      active:true, wasInstalled:true,
      version:version, cores:cores, backends:backends,
      updateAvailable:updateAvailable, updateVersion:updateVersion, updateUrl:updateUrl
    }});
    try { localStorage.setItem('cc_local_engine','1'); } catch(e){}
    // Poll GET /update once per connection (or after a version change).
    // Done after the status dispatch so the UI is already in "connected" state.
    if (!_updateChecked) { _updateChecked = true; _checkForUpdate(d); }
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

  // ── Update check: GET /update ────────────────────────────────
  // Called once after each successful connection and periodically (every 30 minutes).
  // If the engine reports update_available, automatically triggers the
  // self-update flow (POST /update + poll until restart).
  // Silently ignored if the engine is down or doesn't support the endpoint.
  function _checkForUpdate(d) {
    var fetchOpts = {method:'GET', cache:'no-store'};
    try { if (AbortSignal.timeout) fetchOpts.signal = AbortSignal.timeout(3000); } catch(e){}
    return fetch(_localEngineUrl + '/update', fetchOpts)
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(j) {
        if (j && j.update_available) {
          console.log('%c[LocalEngine] Update available — auto-updating to', 'color:#fbbf24;font-weight:bold', j.version || 'latest');
          // Auto-trigger the self-update: POST /update, then poll /status
          // until the engine restarts. No user interaction required.
          _applyEngineUpdate(d);
        }
      })
      .catch(function() { /* /update not present or engine unreachable — ignore */ });
  }

  // ── Poll /status until engine restarts (post-update) ─────────
  // Does NOT fire the URL scheme — the engine restarts itself.
  function _pollForRestart(d, timeoutMs) {
    var gen = ++_connectGen;
    var deadline = Date.now() + (timeoutMs || 30000);
    function tick() {
      if (gen !== _connectGen) return;
      if (Date.now() >= deadline) {
        if (d) d({t:'UPD_LOCAL_ENGINE', u:{updating:false, available:false, failed:true}});
        return;
      }
      _probeStatus(2000)
        .then(function(j) {
          if (gen !== _connectGen) return;
          _applyStatus(j, d);
          if (d) d({t:'UPD_LOCAL_ENGINE', u:{updating:false}});
        })
        .catch(function() { setTimeout(tick, 2000); });
    }
    setTimeout(tick, 1500); // wait for engine to start shutting down
  }

  // ── Trigger self-update: POST /update ─────────────────────────
  // Tells the engine to download the latest release, replace its own
  // binary, and restart. We then poll until it comes back online.
  function _applyEngineUpdate(d) {
    if (d) d({t:'UPD_LOCAL_ENGINE', u:{updating:true, updateAvailable:false}});
    var fetchOpts = {method:'POST', cache:'no-store'};
    try { if (AbortSignal.timeout) fetchOpts.signal = AbortSignal.timeout(5000); } catch(e){}
    return fetch(_localEngineUrl + '/update', fetchOpts)
      .then(function() {
        console.log('%c[LocalEngine] Self-update triggered, waiting for restart\u2026', 'color:#fbbf24');
        _pollForRestart(d, 60000); // up to 60s for the update + restart
      })
      .catch(function(e) {
        console.warn('[LocalEngine] POST /update failed:', e && e.message || e);
        if (d) d({t:'UPD_LOCAL_ENGINE', u:{updating:false, updateAvailable:true}});
      });
  }

  // Trigger a browser download of the OS-appropriate engine binary.
  // MUST be called from within a user-gesture handler. Uses a programmatic
  // <a download> click — the standard cross-browser pattern that forces
  // a file download rather than opening in a new tab.
  function _triggerEngineDownload() {
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
      setTimeout(function(){ try { document.body.removeChild(a); } catch(e){} }, 100);
      return true;
    } catch(e) {
      console.warn('[LocalEngine] download trigger failed:', e && e.message || e);
      return false;
    }
  }

  // ── Optimistic connect: URL scheme → poll → fall through ─────
  //
  // 1. Fire clashcontrol://start via an <a>.click() inside the user
  //    gesture. The browser has no API to check handler availability;
  //    we just try. A user-gesture anchor click is the only form most
  //    browsers route to a custom scheme without a security prompt.
  // 2. Poll /status while the daemon boots. For a normal connect that's
  //    6s with 300ms intervals; for an install-and-wait flow (opts.installing)
  //    it's up to 10 minutes with a ramped interval (300ms → 2s) so we
  //    can wait for the user to actually run the installer.
  // 3. If nothing responds within the deadline, reject with
  //    ENGINE_NOT_INSTALLED and let the UI show install instructions.
  //
  // MUST be called from within a user-gesture handler (e.g. onClick) to
  // ensure the URL-scheme launch and optional download-trigger are honored.
  function _connectLocalEngine(d, opts) {
    opts = opts || {};
    var installing = !!opts.installing;
    var timeoutMs = opts.timeoutMs || (installing ? 600000 : 6000); // 10 min vs 6s
    var gen = ++_connectGen;

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
    if (d) d({t:'UPD_LOCAL_ENGINE', u:{
      connecting: !installing,
      installing: installing,
      checking: false,
      failed: false
    }});

    var start = Date.now();
    var deadline = start + timeoutMs;
    function tick() {
      if (gen !== _connectGen) return Promise.resolve(null); // superseded/canceled
      if (Date.now() >= deadline) {
        // Connect timed out — we are confident the engine is not installed
        // (or at least not reachable). Flip `failed` so the UI shows the
        // download card instead of just a bare "Not connected" label.
        if (d) d({t:'UPD_LOCAL_ENGINE', u:{connecting:false, installing:false, available:false, failed:true}});
        var err = new Error('ENGINE_NOT_INSTALLED');
        err.code = 'ENGINE_NOT_INSTALLED';
        return Promise.reject(err);
      }
      // Ramp the poll interval over time: fast polling for the first 6s
      // catches quick URL-scheme launches; slower (2s) after that keeps
      // the network quiet while the user runs the installer.
      var elapsed = Date.now() - start;
      var pollInterval = elapsed < 6000 ? 300 : 2000;
      return _probeStatus(500)
        .then(function(j){
          if (gen !== _connectGen) return null; // canceled during probe
          _applyStatus(j, d);
          return j;
        })
        .catch(function() {
          return new Promise(function(r){ setTimeout(r, pollInterval); }).then(tick);
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
      // `failed` and `installing` are session-only: `failed` is set when
      // a connect attempt times out; `installing` is set when we've just
      // triggered a download and are waiting for the user to run the
      // installer. Both are cleared on every new Connect attempt.
      localEngine: { available: false, active: false, checking: false, connecting: false, installing: false, failed: false, wasInstalled: false, version: null, cores: null, backends: null, updateAvailable: false, updateVersion: null, updateUrl: null, updating: false }
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
      // Periodic update check every 30 minutes while the addon is active.
      _updateInterval = setInterval(function() {
        var le = (window._ccLatestState || {}).localEngine;
        if (le && le.available && !le.updating) _checkForUpdate(dispatch);
      }, 30 * 60 * 1000);
    },

    // Called from within the Enable button's click handler (user gesture).
    // First-time users (no `wasInstalled` evidence) get the whole flow
    // in one click: download the installer, fire the URL scheme in case
    // the engine is already running, and long-poll /status until the
    // engine comes online. Returning users with a prior install just
    // get the normal 6s URL-scheme connect.
    onEnable: function(dispatch) {
      var state = window._ccLatestState;
      var le = (state && state.localEngine) || {};
      var knownInstalled = !!(le.wasInstalled || le.available);

      if (knownInstalled) {
        _connectLocalEngine(dispatch).catch(function(err) {
          console.log('[LocalEngine] onEnable connect failed:', err && err.message || err);
        });
      } else {
        // First-time: trigger the download synchronously inside the user
        // gesture so the browser allows it, then long-poll /status so we
        // auto-connect the moment the user's installer brings the engine up.
        _triggerEngineDownload();
        _connectLocalEngine(dispatch, {installing: true}).catch(function(err) {
          console.log('[LocalEngine] onEnable install+connect failed:', err && err.message || err);
        });
      }
    },

    destroy: function() {
      // Abort any in-flight connect/install poll so it doesn't keep firing
      // /status requests after the user disables the addon.
      _cancelPendingConnect();
      clearInterval(_updateInterval); _updateInterval = null;
    },

    panel: function(html, s, d) {
      var le = s.localEngine || {};
      var os = _detectOS();
      var dl = _downloads[os];

      // ── Updating (self-update in progress) ───────────────────
      if (le.updating) {
        return html`<div style=${{padding:'.5rem 0',fontSize:'0.78rem',color:'var(--text-secondary)',lineHeight:1.7}}>
          <div style=${{display:'flex',alignItems:'center',gap:'.4rem',marginBottom:'.3rem'}}>
            <div style=${{width:12,height:12,border:'2px solid #fbbf24',borderTopColor:'transparent',borderRadius:'50%',animation:'cc-spin .6s linear infinite'}}></div>
            <span style=${{color:'#fbbf24',fontWeight:600}}>Updating engine\u2026</span>
          </div>
          <div style=${{fontSize:'0.65rem',color:'var(--text-faint)',lineHeight:1.6}}>
            Downloading update and restarting. Reconnecting automatically\u2026
          </div>
        </div>`;
      }

      // ── Connected ─────────────────────────────────────────────
      if (le.available) {
        return html`<div style=${{padding:'.5rem 0',fontSize:'0.78rem',color:'var(--text-secondary)',lineHeight:1.7}}>
          <div style=${{display:'flex',alignItems:'center',gap:'.4rem',marginBottom:'.3rem',flexWrap:'wrap'}}>
            <span style=${{width:7,height:7,borderRadius:'50%',background:'#22c55e',display:'inline-block'}}></span>
            <span style=${{fontWeight:600,color:'var(--text-primary)'}}>Connected</span>
            ${le.version && html`<span style=${{fontSize:'0.63rem',color:'var(--text-faint)'}}>v${le.version}</span>`}
            ${le.cores && html`<span style=${{fontSize:'0.63rem',color:'var(--text-faint)'}}>\u00b7 ${le.cores} cores</span>`}
          </div>
          ${le.updateAvailable && html`<div style=${{display:'flex',alignItems:'center',gap:'.5rem',padding:'.3rem .45rem',background:'rgba(234,179,8,.1)',border:'1px solid rgba(234,179,8,.25)',borderRadius:6,marginBottom:'.3rem'}}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fbbf24" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style=${{flexShrink:0}}><path d="M12 2v16M5 9l7-7 7 7"/></svg>
            <span style=${{fontSize:'0.66rem',color:'#fbbf24',flex:1}}>
              Update available${le.updateVersion ? ': v' + le.updateVersion : ''}
            </span>
            <button onClick=${function(){ _applyEngineUpdate(d); }}
              style=${{fontSize:'0.63rem',fontWeight:600,color:'#fbbf24',background:'rgba(234,179,8,.2)',border:'1px solid rgba(234,179,8,.4)',padding:'2px 7px',borderRadius:4,cursor:'pointer',fontFamily:'inherit',flexShrink:0}}>Update now</button>
          </div>`}
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

      // ── Installing (download triggered, waiting for user to run it) ──
      if (le.installing) {
        var fileName = os==='win' ? 'clashcontrol-engine-win.exe'
                     : os==='mac' ? 'clashcontrol-engine-mac.tar.gz'
                     : 'clashcontrol-engine-linux.tar.gz';
        return html`<div style=${{padding:'.5rem 0',fontSize:'0.78rem',color:'var(--text-secondary)',lineHeight:1.7}}>
          <div style=${{display:'flex',alignItems:'center',gap:'.4rem',marginBottom:'.4rem'}}>
            <div style=${{width:12,height:12,border:'2px solid #3b82f6',borderTopColor:'transparent',borderRadius:'50%',animation:'cc-spin .6s linear infinite'}}></div>
            <span style=${{color:'#3b82f6',fontWeight:600}}>Waiting for installation\u2026</span>
          </div>
          <div style=${{fontSize:'0.66rem',color:'var(--text-secondary)',lineHeight:1.65,marginBottom:'.45rem'}}>
            The ${dl.label} installer is downloading. Open <code style=${{fontSize:'0.64rem'}}>${fileName}</code> from your downloads and run it — ClashControl will connect the moment the engine is online.
          </div>
          ${os!=='win' && html`<pre style=${{fontSize:'0.63rem',background:'var(--tag-bg)',padding:'.35rem .5rem',borderRadius:5,color:'var(--text-primary)',
            fontFamily:'var(--font-mono,monospace)',margin:'0 0 .45rem',whiteSpace:'pre-wrap',lineHeight:1.55,overflowX:'auto'}}>${dl.cmd}</pre>`}
          <div style=${{display:'flex',gap:'.3rem'}}>
            <a href=${dl.url} download
              style=${{padding:'.3rem .55rem',borderRadius:5,fontSize:'0.7rem',fontWeight:600,
                border:'1px solid var(--border)',background:'var(--bg-secondary)',color:'var(--text-secondary)',
                fontFamily:'inherit',textDecoration:'none'}}>Re-download</a>
            <button onClick=${function(){
              _cancelPendingConnect();
              d({t:'UPD_LOCAL_ENGINE', u:{installing:false, connecting:false, failed:false}});
            }} style=${{padding:'.3rem .55rem',borderRadius:5,fontSize:'0.7rem',fontWeight:600,cursor:'pointer',border:'1px solid var(--border)',
              background:'var(--bg-secondary)',color:'var(--text-secondary)',fontFamily:'inherit'}}>Cancel</button>
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
        statusBlurb = 'Click Install & Connect to download the installer. ClashControl will connect automatically once it\u2019s running.';
      } else if (le.wasInstalled) {
        statusLabel = 'Engine not running';
        statusDot = '#f97316';
        statusBlurb = 'Click Connect to launch the installed engine.';
      } else {
        statusLabel = 'Not connected';
        statusDot = '#64748b';
        statusBlurb = 'Click Install & Connect to download, install, and start the engine in one step.';
      }

      return html`<div style=${{padding:'.5rem 0',fontSize:'0.78rem',color:'var(--text-secondary)',lineHeight:1.7}}>
        <div style=${{display:'flex',alignItems:'center',gap:'.4rem',marginBottom:'.45rem'}}>
          <span style=${{width:7,height:7,borderRadius:'50%',background:statusDot,display:'inline-block'}}></span>
          <span>${statusLabel}</span>
        </div>

        <button onClick=${function(){
          // If we have no evidence the engine is installed (first-time,
          // or a prior attempt confirmed failure), run the install flow:
          // download the binary + long-poll. Otherwise just connect.
          if (!le.wasInstalled || le.failed) {
            _triggerEngineDownload();
            _connectLocalEngine(d, {installing:true}).catch(function(err){
              console.log('[LocalEngine] Connect (install) failed:', err && err.message || err);
            });
          } else {
            _connectLocalEngine(d).catch(function(err){
              console.log('[LocalEngine] Connect failed:', err && err.message || err);
            });
          }
        }} style=${{display:'flex',alignItems:'center',justifyContent:'center',gap:'.4rem',width:'100%',
            padding:'.5rem .7rem',borderRadius:6,fontSize:'0.8rem',fontWeight:600,cursor:'pointer',border:'none',
            background:'var(--accent)',color:'#fff',fontFamily:'inherit',marginBottom:'.5rem'}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14M13 6l6 6-6 6"/>
          </svg> ${(!le.wasInstalled || le.failed) ? 'Install & Connect' : 'Connect to Engine'}
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

  // Produce a clash-object shape that matches the browser engine's
  // `_buildClashBase` output exactly: plain-JSON only (no Three.js
  // instances), model ids + expressIds instead of full element
  // references, and all the metadata columns the UI + IndexedDB
  // persistence rely on. Historically this mapper stashed raw `elA`
  // and `elB` element references and a THREE.Vector3 `point`; writing
  // that state to IndexedDB then blew up with a DataCloneError —
  // `function(){n.setFromEuler(e,!1)} could not be cloned` — because
  // the mesh objects carried Quaternion / Euler internal callbacks
  // that structuredClone can't serialise.
  function _clashFromEngineResult(c, elA, elB, mA, mB, rules) {
    var pA = (elA && elA.props) || {};
    var pB = (elB && elB.props) || {};
    var sameModel = mA.id === mB.id;
    var tA = pA.ifcType || 'Element';
    var tB = pB.ifcType || 'Element';
    var nA = pA.name || ('#' + (elA.expressId || elA.id));
    var nB = pB.name || ('#' + (elB.expressId || elB.id));
    // Point: prefer the engine's mesh-accurate contact point. Fall
    // back to the midpoint between element bbox centres if the engine
    // didn't emit one.
    var pt;
    if (c.point && c.point.length >= 3) {
      pt = [c.point[0], c.point[1], c.point[2]];
    } else {
      var cA = elA.box && elA.box.getCenter && elA.box.getCenter(new THREE.Vector3());
      var cB = elB.box && elB.box.getCenter && elB.box.getCenter(new THREE.Vector3());
      if (cA && cB) pt = [(cA.x+cB.x)/2, (cA.y+cB.y)/2, (cA.z+cB.z)/2];
      else pt = [0, 0, 0];
    }
    // Distance: engine returns metres for clearance, negative for
    // penetration. UI uses mm integers throughout.
    var type = c.type || (rules.mode === 'soft' ? 'soft' : 'hard');
    var rawDist = (typeof c.distance === 'number') ? c.distance : 0;
    var distMm;
    if (type === 'hard' || type === 'duplicate') {
      // rawDist < 0 is signed penetration depth in metres; surface
      // hits get -1 so the clash list still shows "touching".
      distMm = rawDist < 0 ? Math.round(rawDist * 1000) : -1;
    } else {
      distMm = Math.round(Math.abs(rawDist) * 1000);
    }
    // Title: reuse the same "Wall × Pipe Segment" format the browser
    // engine emits via _niceClashTitle so the clash list looks
    // identical between backends.
    function nice(t){ if(!t) return 'Element'; return String(t).replace(/^Ifc/i,'').replace(/([a-z])([A-Z])/g,'$1 $2')||'Element'; }
    var la = nice(tA), lb = nice(tB);
    var title = (la === lb ? (la + ' vs ' + lb) : (la + ' × ' + lb)) + (sameModel ? ' (self)' : '');
    var description = tA + ': ' + nA + ' (' + mA.name + ') vs ' + tB + ': ' + nB + ' (' + mB.name + ')';
    var discA = mA.discipline || '';
    var discB = mB.discipline || '';
    return {
      id: c.id || ((elA.expressId||elA.id) + '_' + (elB.expressId||elB.id)),
      source: 'local_engine',
      status: 'open',
      createdAt: new Date().toISOString(),
      modelAId: mA.id, modelBId: mB.id,
      elemA: elA.expressId || elA.id,
      elemB: elB.expressId || elB.id,
      point: pt,
      elevation: Math.round(pt[1] * 1000) / 1000,
      disciplines: [discA, discB].filter(Boolean),
      selfClash: sameModel,
      elemAType: tA, elemBType: tB,
      elemAName: nA, elemBName: nB,
      globalIdA: pA.globalId || '', globalIdB: pB.globalId || '',
      revitIdA: pA.revitId || null, revitIdB: pB.revitId || null,
      elemAStorey: pA.storey || '', elemBStorey: pB.storey || '',
      elemAMaterial: pA.material || '', elemBMaterial: pB.material || '',
      objectTypeA: pA.objectType || '', objectTypeB: pB.objectType || '',
      type: type === 'clearance' ? 'soft' : type,
      distance: distMm,
      title: title,
      description: description,
      overlapVolM3: c.volume || 0,
      clearanceMm: (type === 'soft' || type === 'clearance') ? Math.round(Math.abs(rawDist) * 1000) : null
    };
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
          if (msg.type === 'phase' && msg.label) {
            // Fan the engine's phase label out through the global
            // progress channel so the chat bubble can show "Building
            // BVH / Narrow phase / Finalising" just like the browser
            // engine's internal phases.
            window._ccDetectProgress = window._ccDetectProgress || {done:0,total:0,pct:0};
            window._ccDetectProgress.phase = msg.label;
            window.dispatchEvent(new Event('cc-detect-progress'));
          }
          if (msg.type === 'complete') console.log('%c[Engine] Done: ' + msg.clashCount + ' clashes in ' + msg.duration_ms + 'ms', 'color:#4ade80');
        } catch(ex){}
      };
    } catch(ex){}

    // Announce the pre-flight phase immediately — serialising 30k
    // meshes takes a second or two, and without this nothing shows in
    // the chat until the engine's first progress message.
    try {
      window._ccDetectProgress = {done:0, total:0, pct:0, phase:'Uploading geometry to engine'};
      window.dispatchEvent(new Event('cc-detect-progress'));
    } catch(e){}

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
      // Build lookup maps keyed by (modelId, expressId). The engine's
      // response annotates each clash with the originating model ids
      // when available; fall back to "search all models" for backward
      // compatibility with older engine builds.
      var byModel = {};
      models.forEach(function(m) {
        if (!m.elements) return;
        var map = byModel[m.id] = {};
        m.elements.forEach(function(el) { map[el.expressId||el.id] = el; });
      });
      function resolve(modelHint, eid) {
        if (modelHint && byModel[modelHint] && byModel[modelHint][eid]) {
          return {model: models.find(function(m){return m.id===modelHint;}), el: byModel[modelHint][eid]};
        }
        for (var mi = 0; mi < models.length; mi++) {
          var m = models[mi];
          if (m.elements) {
            var map2 = byModel[m.id];
            if (map2 && map2[eid]) return {model: m, el: map2[eid]};
          }
        }
        return null;
      }
      return result.clashes.map(function(c) {
        var rA = resolve(c.modelA || c.modelAId, c.elementA);
        var rB = resolve(c.modelB || c.modelBId, c.elementB);
        if (!rA || !rB) return null;
        return _clashFromEngineResult(c, rA.el, rB.el, rA.model, rB.model, rules);
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
