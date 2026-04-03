// ── ClashControl Addon: ClashControlEngine ──────────────────────
// Connects to a localhost Python server (port 19800) for exact mesh
// intersection. Falls back to the built-in browser OBB engine when
// the server isn't running.
// Install: pip install clashcontrol-engine
// Run:     clashcontrol-engine

(function() {
  'use strict';

  var _localEngineUrl = 'http://localhost:19800';
  var _localEngineWsUrl = 'ws://localhost:19801';
  var _pollTimer = null;
  var _engineVersion = null;
  var _engineCores = null;

  // ── Download URLs for standalone executables ──────────────────
  var _releaseBase = 'https://github.com/clashcontrol-io/ClashControlEngine/releases/latest/download/';
  var _downloads = {
    win:   {url: _releaseBase + 'clashcontrol-engine-win.exe',   label: 'Windows (.exe)'},
    mac:   {url: _releaseBase + 'clashcontrol-engine-mac',       label: 'macOS'},
    linux: {url: _releaseBase + 'clashcontrol-engine-linux',     label: 'Linux'}
  };

  function _detectOS() {
    var ua = navigator.userAgent || '';
    if (/Win/.test(navigator.platform || ua)) return 'win';
    if (/Mac/.test(navigator.platform || ua)) return 'mac';
    return 'linux';
  }

  function _stopPolling() { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } }

  function _startPolling(d) {
    _stopPolling();
    var attempts = 0;
    _pollTimer = setInterval(function() {
      attempts++;
      if (attempts > 60) { _stopPolling(); d({t:'UPD_LOCAL_ENGINE', u:{installing:false}}); return; }
      _checkLocalEngine(null).then(function(ready) {
        if (ready) {
          _stopPolling();
          d({t:'UPD_LOCAL_ENGINE', u:{available:true, installing:false, active:true}});
          try { localStorage.setItem('cc_local_engine','1'); } catch(e){}
        }
      });
    }, 3000);
  }

  window._ccRegisterAddon({
    id: 'local-engine',
    name: 'ClashControlEngine',
    description: 'Multi-threaded local server for exact mesh intersection. 5-10x faster on large models. One-click install.',
    autoActivate: false,
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>',

    initState: {
      localEngine: { available: false, active: false, checking: false, installing: false, version: null, cores: null }
    },

    reducerCases: {
      'UPD_LOCAL_ENGINE': function(s, a) {
        return Object.assign({}, s, {localEngine: Object.assign({}, s.localEngine, a.u)});
      }
    },

    init: function(dispatch) {
      try { if (localStorage.getItem('cc_local_engine') === '1') dispatch({t:'UPD_LOCAL_ENGINE', u:{active:true}}); } catch(e){}
      _checkLocalEngine(dispatch);
    },

    destroy: function() { _stopPolling(); },

    panel: function(html, s, d) {
      var le = s.localEngine || {};
      var os = _detectOS();
      var dl = _downloads[os];

      var statusColor = le.available ? '#22c55e' : le.installing ? '#eab308' : le.checking ? '#eab308' : '#64748b';
      var statusText = le.available ? 'Connected' + (le.version ? ' v' + le.version : '') + (le.cores ? ' (' + le.cores + ' cores)' : '')
        : le.installing ? 'Waiting for server\u2026'
        : le.checking ? 'Checking\u2026' : 'Not running';

      return html`<div style=${{padding:'.5rem 0',fontSize:'0.78rem',color:'var(--text-secondary)',lineHeight:1.7}}>
        <div style=${{display:'flex',alignItems:'center',gap:'.4rem',marginBottom:'.4rem'}}>
          <span style=${{width:7,height:7,borderRadius:'50%',background:statusColor,display:'inline-block'}}></span>
          <span>${statusText}</span>
        </div>

        ${le.available ? html`<div style=${{display:'flex',gap:'.3rem',marginBottom:'.4rem'}}>
          <button onClick=${function(){_checkLocalEngine(d);}} disabled=${le.checking}
            style=${{padding:'.3rem .6rem',borderRadius:6,fontSize:'0.75rem',fontWeight:600,cursor:'pointer',
              border:'1px solid var(--border)',background:'var(--bg-secondary)',color:'var(--text-secondary)',fontFamily:'inherit',
              opacity:le.checking?0.5:1}}>
            ${le.checking?'Checking\u2026':'Check Status'}</button>
          <button onClick=${function(){
            var newActive=!le.active;try{localStorage.setItem('cc_local_engine',newActive?'1':'0');}catch(e){}
            d({t:'UPD_LOCAL_ENGINE',u:{active:newActive}});
          }} style=${{padding:'.3rem .6rem',borderRadius:6,fontSize:'0.75rem',fontWeight:600,cursor:'pointer',border:'none',fontFamily:'inherit',
            background:le.active?'var(--bg-secondary)':'#2563eb',color:le.active?'var(--text-secondary)':'#fff'}}>
            ${le.active?'Disable':'Enable for Detection'}</button>
        </div>`

        : le.installing ? html`<div style=${{fontSize:'0.72rem',lineHeight:1.7}}>
          <div style=${{display:'flex',alignItems:'center',gap:'.4rem',marginBottom:'.4rem'}}>
            <div style=${{width:12,height:12,border:'2px solid #eab308',borderTopColor:'transparent',borderRadius:'50%',animation:'cc-spin .6s linear infinite'}}></div>
            <span style=${{color:'#eab308'}}>Waiting for engine to start\u2026</span>
          </div>
          <div style=${{fontSize:'0.65rem',color:'var(--text-faint)',lineHeight:1.6}}>
            Run the downloaded file to start the engine. ClashControl will connect automatically.
          </div>
          <button onClick=${function(){_stopPolling();d({t:'UPD_LOCAL_ENGINE',u:{installing:false}});}}
            style=${{marginTop:'.3rem',padding:'.2rem .5rem',borderRadius:5,fontSize:'0.69rem',cursor:'pointer',border:'1px solid var(--border)',background:'none',color:'var(--text-faint)',fontFamily:'inherit'}}>Cancel</button>
        </div>`

        : html`<div style=${{fontSize:'0.72rem',lineHeight:1.7}}>
          <a href=${dl.url} download onClick=${function(){d({t:'UPD_LOCAL_ENGINE',u:{installing:true}});_startPolling(d);}}
            style=${{display:'flex',alignItems:'center',justifyContent:'center',gap:'.4rem',padding:'.45rem .7rem',borderRadius:6,fontSize:'0.78rem',fontWeight:600,cursor:'pointer',border:'none',
              background:'var(--accent)',color:'#fff',fontFamily:'inherit',textDecoration:'none',marginBottom:'.4rem'}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg> Download for ${dl.label}</a>
          <div style=${{fontSize:'0.63rem',color:'var(--text-faint)',textAlign:'center',marginBottom:'.4rem'}}>
            Download, run the file, done. No install wizard needed.
          </div>
          <div style=${{display:'flex',gap:'.3rem',alignItems:'center',flexWrap:'wrap',fontSize:'0.63rem',color:'var(--text-faint)'}}>
            ${os!=='win'&&html`<a href=${_downloads.win.url} download style=${{color:'var(--text-faint)',textDecoration:'underline'}}>Windows</a>`}
            ${os!=='mac'&&html`<a href=${_downloads.mac.url} download style=${{color:'var(--text-faint)',textDecoration:'underline'}}>macOS</a>`}
            ${os!=='linux'&&html`<a href=${_downloads.linux.url} download style=${{color:'var(--text-faint)',textDecoration:'underline'}}>Linux</a>`}
            <span style=${{margin:'0 .2rem'}}>\u00b7</span>
            Or: <code style=${{fontSize:'0.63rem',background:'var(--tag-bg)',padding:'1px 4px',borderRadius:3}}>pip install clashcontrol-engine</code>
          </div>
          <div style=${{display:'flex',gap:'.3rem',alignItems:'center',justifyContent:'space-between',marginTop:'.4rem'}}>
            <a href="https://github.com/clashcontrol-io/ClashControlEngine" target="_blank" rel="noopener"
              style=${{fontSize:'0.63rem',color:'var(--accent)',textDecoration:'none'}}>GitHub repo</a>
            <button onClick=${function(){_checkLocalEngine(d);}} disabled=${le.checking}
              style=${{padding:'.25rem .5rem',borderRadius:5,fontSize:'0.69rem',fontWeight:600,cursor:'pointer',
                border:'1px solid var(--border)',background:'none',color:'var(--text-faint)',fontFamily:'inherit',
                opacity:le.checking?0.5:1}}>
              ${le.checking?'Checking\u2026':'Already running? Check'}</button>
          </div>
        </div>`}
      </div>`;
    }
  });

  // ── Engine communication ──────────────────────────────────────

  function _checkLocalEngine(d) {
    if (d) d({t:'UPD_LOCAL_ENGINE', u:{checking:true}});
    var fetchOpts = {method:'GET'};
    try { if (AbortSignal.timeout) fetchOpts.signal = AbortSignal.timeout(2000); } catch(e){}
    return fetch(_localEngineUrl + '/status', fetchOpts)
      .then(function(r){ return r.json(); })
      .then(function(j){
        var ready = j && j.status === 'ready';
        _engineVersion = j && j.version || null;
        _engineCores = j && j.cores || null;
        if (d) d({t:'UPD_LOCAL_ENGINE', u:{available:ready, checking:false, version:_engineVersion, cores:_engineCores}});
        if (ready) {
          try { localStorage.setItem('cc_local_engine','1'); } catch(e){}
          if (d) d({t:'UPD_LOCAL_ENGINE', u:{active:true}});
        }
        return ready;
      })
      .catch(function(){
        if (d) d({t:'UPD_LOCAL_ENGINE', u:{available:false, checking:false}});
        return false;
      });
  }

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
  window._detectOnLocalEngine = _detectOnLocalEngine;
})();
