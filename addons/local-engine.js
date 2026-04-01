// ── ClashControl Addon: ClashControlEngine ──────────────────────
// Connects to a localhost Python server (port 19800) for exact mesh
// intersection. Falls back to the built-in browser OBB engine when
// the server isn't running. Desktop/PWA only — not loaded in browser.

(function() {
  'use strict';

  // Only load in installed PWA (standalone) — not in browser tab
  var isDesktop = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  if (!isDesktop) return;

  var _localEngineUrl = 'http://localhost:19800';
  var _localEngineWsUrl = 'ws://localhost:19801';
  var _pollTimer = null;

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
      localEngine: { available: false, active: false, checking: false, installing: false }
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
      var statusText = le.available ? 'Connected to localhost:19800'
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

        : html`<div style=${{fontSize:'0.72rem',lineHeight:1.7}}>
          <div style=${{marginBottom:'.5rem',color:'var(--text-muted)'}}>
            Runs on your machine for faster, more accurate clash detection. No Python or command line needed.
          </div>
          <div style=${{display:'flex',flexDirection:'column',gap:'.35rem'}}>
            <div style=${{display:'flex',alignItems:'center',gap:'.5rem'}}>
              <span style=${{color:'var(--accent)',fontWeight:700,fontSize:'0.75rem',width:18,textAlign:'center'}}>1</span>
              <span>Download for ${dl.label}:</span>
            </div>
            <div style=${{marginLeft:26,display:'flex',gap:'.3rem',alignItems:'center',flexWrap:'wrap'}}>
              <a href=${dl.url} download onClick=${function(){d({t:'UPD_LOCAL_ENGINE',u:{installing:true}});_startPolling(d);}}
                style=${{padding:'.35rem .7rem',borderRadius:6,fontSize:'0.75rem',fontWeight:600,cursor:'pointer',border:'none',
                  background:'var(--accent)',color:'#fff',fontFamily:'inherit',textDecoration:'none',display:'inline-flex',alignItems:'center',gap:'.3rem'}}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                </svg> Download</a>
              ${os!=='win'&&html`<a href=${_downloads.win.url} download style=${{fontSize:'0.65rem',color:'var(--text-faint)',textDecoration:'underline'}}>Windows</a>`}
              ${os!=='mac'&&html`<a href=${_downloads.mac.url} download style=${{fontSize:'0.65rem',color:'var(--text-faint)',textDecoration:'underline'}}>macOS</a>`}
              ${os!=='linux'&&html`<a href=${_downloads.linux.url} download style=${{fontSize:'0.65rem',color:'var(--text-faint)',textDecoration:'underline'}}>Linux</a>`}
            </div>
            <div style=${{display:'flex',alignItems:'center',gap:'.5rem',marginTop:'.15rem'}}>
              <span style=${{color:'var(--accent)',fontWeight:700,fontSize:'0.75rem',width:18,textAlign:'center'}}>2</span>
              <span>Run the downloaded file</span>
            </div>
            <div style=${{display:'flex',alignItems:'center',gap:'.5rem',marginTop:'.15rem'}}>
              <span style=${{color:'var(--accent)',fontWeight:700,fontSize:'0.75rem',width:18,textAlign:'center'}}>3</span>
              <span>ClashControl connects automatically</span>
            </div>
          </div>
          ${le.installing&&html`<div style=${{marginTop:'.4rem',fontSize:'0.65rem',color:'#eab308',display:'flex',alignItems:'center',gap:'.3rem'}}>
            <div style=${{width:10,height:10,border:'2px solid #eab308',borderTopColor:'transparent',borderRadius:'50%',animation:'cc-spin .6s linear infinite'}}></div>
            Polling for server\u2026 run the downloaded file to start it.
          </div>`}
          <div style=${{marginTop:'.5rem',display:'flex',gap:'.3rem'}}>
            <button onClick=${function(){_checkLocalEngine(d);}} disabled=${le.checking}
              style=${{padding:'.3rem .6rem',borderRadius:6,fontSize:'0.75rem',fontWeight:600,cursor:'pointer',
                border:'1px solid var(--border)',background:'var(--bg-secondary)',color:'var(--text-secondary)',fontFamily:'inherit',
                opacity:le.checking?0.5:1}}>
              ${le.checking?'Checking\u2026':'Check Connection'}</button>
          </div>
          <div style=${{marginTop:'.4rem',fontSize:'0.65rem',color:'var(--text-faint)'}}>
            The built-in browser engine is used until the local engine is running.
          </div>
        </div>`}
      </div>`;
    }
  });

  // ── Engine communication ──────────────────────────────────────

  function _checkLocalEngine(d) {
    if (d) d({t:'UPD_LOCAL_ENGINE', u:{checking:true}});
    return fetch(_localEngineUrl + '/status', {method:'GET', signal:AbortSignal.timeout(2000)})
      .then(function(r){ return r.json(); })
      .then(function(j){
        var ready = j && j.status === 'ready';
        if (d) d({t:'UPD_LOCAL_ENGINE', u:{available:ready, checking:false}});
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
    return {elements:elements, rules:{modelA:rules.modelA, modelB:rules.modelB, maxGap:rules.maxGap||0, mode:rules.mode||'hard'}};
  }

  function _detectOnLocalEngine(models, rules, onProgress) {
    var payload = _serializeForLocalEngine(models, rules);
    var progressWs = null;
    try {
      progressWs = new WebSocket(_localEngineWsUrl);
      progressWs.onmessage = function(e) {
        try { var msg = JSON.parse(e.data); if (msg.type === 'progress' && onProgress && msg.total > 0) onProgress(msg.done, msg.total); } catch(ex){}
      };
    } catch(ex){}

    return fetch(_localEngineUrl + '/detect', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)})
    .then(function(r){ return r.json(); })
    .then(function(result) {
      if (progressWs) try{progressWs.close();}catch(ex){}
      if (!result || !result.clashes) return [];
      return result.clashes.map(function(c) {
        var elA = null, elB = null;
        models.forEach(function(m) { if (!m.elements) return; m.elements.forEach(function(el) { var eid = el.expressId||el.id; if(eid===c.elementA)elA=el; if(eid===c.elementB)elB=el; }); });
        if (!elA || !elB) return null;
        var pt = c.point ? new THREE.Vector3(c.point[0], c.point[1], c.point[2]) : new THREE.Vector3();
        return {id:c.id||(c.elementA+'_'+c.elementB), elementA:elA, elementB:elB, point:pt,
          distance:c.distance!=null?c.distance:0, volume:c.volume||0,
          type:c.type||(rules.mode==='soft'?'clearance':'hard'), status:'open', source:'local_engine'};
      }).filter(Boolean);
    })
    .catch(function(err) {
      if (progressWs) try{progressWs.close();}catch(ex){}
      console.warn('Local engine detection failed, falling back to browser:', err);
      return null;
    });
  }

  window._checkLocalEngine = _checkLocalEngine;
  window._detectOnLocalEngine = _detectOnLocalEngine;
})();
