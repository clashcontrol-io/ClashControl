// ── ClashControl Addon: Local Clash Detection Engine ────────────
// Connects to a localhost Python server (port 19800) for exact mesh
// intersection. Falls back to the built-in browser OBB engine when
// the server isn't running. Completely optional.

(function() {
  'use strict';

  var _localEngineUrl = 'http://localhost:19800';
  var _localEngineWsUrl = 'ws://localhost:19801';

  window._ccRegisterAddon({
    id: 'local-engine',
    name: 'Local Clash Engine',
    description: 'Multi-threaded Python server on localhost:19800 for exact mesh intersection. 5-10x faster on large models.',
    autoActivate: false,
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6v6H9z"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>',

    initState: {
      localEngine: {
        available: false,
        active: false,
        checking: false
      }
    },

    reducerCases: {
      'UPD_LOCAL_ENGINE': function(s, a) {
        return Object.assign({}, s, {localEngine: Object.assign({}, s.localEngine, a.u)});
      }
    },

    init: function(dispatch, getState) {
      // Restore opt-in from localStorage
      try {
        if (localStorage.getItem('cc_local_engine') === '1') {
          dispatch({t:'UPD_LOCAL_ENGINE', u:{active:true}});
        }
      } catch(e){}

      // Check if engine is available
      _checkLocalEngine(dispatch);
    },

    destroy: function() {
      // Nothing persistent to clean up
    },

    panel: function(html, s, d) {
      var le = s.localEngine || {};
      var statusColor = le.available ? '#22c55e' : le.checking ? '#eab308' : '#64748b';
      var statusText = le.available ? 'Connected to localhost:19800' : le.checking ? 'Checking...' : 'Server not running';

      return html`<div style=${{padding:'.5rem 0',fontSize:'0.78rem',color:'var(--text-secondary)',lineHeight:1.7}}>
        <div style=${{display:'flex',alignItems:'center',gap:'.4rem',marginBottom:'.4rem'}}>
          <span style=${{width:7,height:7,borderRadius:'50%',background:statusColor,display:'inline-block'}}></span>
          <span>${statusText}</span>
        </div>
        <div style=${{display:'flex',gap:'.3rem',marginBottom:'.4rem'}}>
          <button onClick=${function(){_checkLocalEngine(d);}}
            disabled=${le.checking}
            style=${{padding:'.3rem .6rem',borderRadius:6,fontSize:'0.75rem',fontWeight:600,cursor:'pointer',
              border:'1px solid var(--border)',background:'var(--bg-secondary)',color:'var(--text-secondary)',fontFamily:'inherit',
              opacity:le.checking?0.5:1}}>
            ${le.checking?'Checking...':'Check Status'}</button>
          ${le.available && html`<button onClick=${function(){
            var newActive = !le.active;
            try{localStorage.setItem('cc_local_engine',newActive?'1':'0');}catch(e){}
            d({t:'UPD_LOCAL_ENGINE',u:{active:newActive}});
          }} style=${{padding:'.3rem .6rem',borderRadius:6,fontSize:'0.75rem',fontWeight:600,cursor:'pointer',border:'none',fontFamily:'inherit',
            background:le.active?'var(--bg-secondary)':'#2563eb',
            color:le.active?'var(--text-secondary)':'#fff'}}>
            ${le.active?'Disable':'Enable for Detection'}</button>`}
        </div>
        ${!le.available && html`<div style=${{fontSize:'0.69rem',color:'var(--text-faint)',lineHeight:1.6}}>
          Run in your terminal to start the server:
          <div style=${{marginTop:'.25rem',display:'flex',flexDirection:'column',gap:'.2rem'}}>
            <div style=${{display:'flex',alignItems:'center',gap:'.4rem'}}>
              <code style=${{fontSize:'0.63rem',background:'var(--tag-bg)',padding:'2px 6px',borderRadius:3}}>pip install clashcontrol-engine</code>
            </div>
            <div style=${{display:'flex',alignItems:'center',gap:'.4rem'}}>
              <code style=${{fontSize:'0.63rem',background:'var(--tag-bg)',padding:'2px 6px',borderRadius:3}}>clashcontrol-engine</code>
              <button onClick=${function(){var cmd=navigator.platform&&navigator.platform.indexOf('Win')!==-1?'pip install clashcontrol-engine; clashcontrol-engine':'pip install clashcontrol-engine && clashcontrol-engine';navigator.clipboard.writeText(cmd).catch(function(){});}}
                style=${{fontSize:'0.58rem',padding:'2px 6px',borderRadius:4,cursor:'pointer',border:'1px solid var(--border)',background:'var(--bg-secondary)',color:'var(--text-muted)',fontFamily:'inherit',whiteSpace:'nowrap'}}>Copy both</button>
            </div>
          </div>
          <div style=${{marginTop:'.25rem',color:'var(--text-faint)'}}>Requires Python 3.8+. Detection uses the built-in browser engine until the server is running.</div>
        </div>`}
      </div>`;
    }
  });

  // ── Engine communication functions ──────────────────────────────
  // Exposed globally so the core detection system can call them

  function _checkLocalEngine(d) {
    if (d) d({t:'UPD_LOCAL_ENGINE', u:{checking:true}});
    return fetch(_localEngineUrl + '/status', {method:'GET', signal:AbortSignal.timeout(2000)})
      .then(function(r){ return r.json(); })
      .then(function(j){
        var ready = j && j.status === 'ready';
        if (d) d({t:'UPD_LOCAL_ENGINE', u:{available:ready, checking:false}});
        return ready;
      })
      .catch(function(){
        if (d) d({t:'UPD_LOCAL_ENGINE', u:{available:false, checking:false}});
        return false;
      });
  }

  // Serialize models + rules for the local engine
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
          if (idx) {
            for (var j = 0; j < idx.count; j++) indices.push(idx.getX(j) + offset);
          } else {
            for (var j = 0; j < pos.count; j++) indices.push(j + offset);
          }
        });
        if (verts.length === 0) return;
        elements.push({
          id: el.expressId || el.id,
          modelId: m.id,
          ifcType: el.props && el.props.ifcType || '',
          name: el.props && el.props.name || '',
          storey: el.props && el.props.storey || '',
          discipline: m.discipline || '',
          vertices: verts,
          indices: indices
        });
      });
    });
    return {elements:elements, rules:{
      modelA: rules.modelA,
      modelB: rules.modelB,
      maxGap: rules.maxGap || 0,
      mode: rules.mode || 'hard'
    }};
  }

  // Run detection on local engine, returns promise of clash array
  function _detectOnLocalEngine(models, rules, onProgress) {
    var payload = _serializeForLocalEngine(models, rules);
    var progressWs = null;
    try {
      progressWs = new WebSocket(_localEngineWsUrl);
      progressWs.onmessage = function(e) {
        try {
          var msg = JSON.parse(e.data);
          if (msg.type === 'progress' && onProgress && msg.total > 0) {
            onProgress(msg.done, msg.total);
          }
        } catch(ex){}
      };
    } catch(ex){}

    return fetch(_localEngineUrl + '/detect', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(payload)
    })
    .then(function(r){ return r.json(); })
    .then(function(result) {
      if (progressWs) try{progressWs.close();}catch(ex){}
      if (!result || !result.clashes) return [];
      return result.clashes.map(function(c) {
        var elA = null, elB = null;
        models.forEach(function(m) {
          if (!m.elements) return;
          m.elements.forEach(function(el) {
            var eid = el.expressId || el.id;
            if (eid === c.elementA) elA = el;
            if (eid === c.elementB) elB = el;
          });
        });
        if (!elA || !elB) return null;
        var pt = c.point ? new THREE.Vector3(c.point[0], c.point[1], c.point[2]) : new THREE.Vector3();
        return {
          id: c.id || (c.elementA + '_' + c.elementB),
          elementA: elA,
          elementB: elB,
          point: pt,
          distance: c.distance != null ? c.distance : 0,
          volume: c.volume || 0,
          type: c.type || (rules.mode === 'soft' ? 'clearance' : 'hard'),
          status: 'open',
          source: 'local_engine'
        };
      }).filter(Boolean);
    })
    .catch(function(err) {
      if (progressWs) try{progressWs.close();}catch(ex){}
      console.warn('Local engine detection failed, falling back to browser:', err);
      return null; // null signals fallback
    });
  }

  // Expose functions globally for the core detection system
  window._checkLocalEngine = _checkLocalEngine;
  window._detectOnLocalEngine = _detectOnLocalEngine;
})();
