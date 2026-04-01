// ── ClashControl Addon: PWA (Progressive Web App) ──────────────
// Handles service worker registration, update detection, and install prompts.
// The core app works without this — it just won't have offline support or install-as-app.

(function() {
  'use strict';

  var _ccInstallPrompt = null;
  var _updateCheckTimer = null;

  window._ccRegisterAddon({
    id: 'pwa',
    name: 'Progressive Web App',
    description: 'Offline support, install-as-app, and automatic updates via service worker.',
    autoActivate: true, // PWA should be active by default
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',

    initState: {
      pwa: {
        updateAvailable: false,
        installAvailable: false,
        dismissed: false
      }
    },

    reducerCases: {
      'UPD_PWA': function(s, a) {
        return Object.assign({}, s, {pwa: Object.assign({}, s.pwa, a.u)});
      }
    },

    init: function(dispatch, getState) {
      // Register service worker
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').then(function(reg) {
          dispatch({t:'UPD_PWA', u:{swRegistered:true}});
          // Check for updates periodically (every 60 min)
          _updateCheckTimer = setInterval(function(){ reg.update(); }, 3600000);

          // Detect waiting worker = new version available
          function _swReady(sw) {
            sw.addEventListener('statechange', function() {
              if (sw.state === 'activated') window.location.reload();
            });
            dispatch({t:'UPD_PWA', u:{updateAvailable:true}});
          }
          if (reg.waiting) _swReady(reg.waiting);
          reg.addEventListener('updatefound', function() {
            var nw = reg.installing;
            if (!nw) return;
            nw.addEventListener('statechange', function() {
              if (nw.state === 'installed' && navigator.serviceWorker.controller) _swReady(nw);
            });
          });
        }).catch(function(err) {
          console.warn('[PWA] Service worker registration failed:', err);
          dispatch({t:'UPD_PWA', u:{swRegistered:false, swError:true}});
        });
      }

      // PWA install prompt
      window.addEventListener('beforeinstallprompt', function(e) {
        e.preventDefault();
        _ccInstallPrompt = e;
        dispatch({t:'UPD_PWA', u:{installAvailable:true}});
      });
    },

    destroy: function() {
      if (_updateCheckTimer) { clearInterval(_updateCheckTimer); _updateCheckTimer = null; }
      // Note: we don't unregister the service worker — just stop checking for updates
    },

    // Panel UI rendered in the Addons tab when this addon is active
    panel: function(html, s, d) {
      var pwa = s.pwa || {};
      var hasUpdate = pwa.updateAvailable;
      var canInstall = pwa.installAvailable && _ccInstallPrompt;
      var swController = navigator.serviceWorker && navigator.serviceWorker.controller;
      var swStatus = swController ? 'active' : pwa.swError ? 'error' : pwa.swRegistered ? 'registered' : 'inactive';
      var swColor = swStatus === 'active' ? '#22c55e' : swStatus === 'registered' ? '#eab308' : '#64748b';
      var swText = swStatus === 'active' ? 'Service worker active'
        : swStatus === 'registered' ? 'Service worker registered — reload to activate'
        : swStatus === 'error' ? 'Service worker failed — requires HTTPS or localhost'
        : !('serviceWorker' in navigator) ? 'Service workers not supported'
        : 'Service worker not active';

      return html`<div style=${{padding:'.5rem 0',fontSize:'0.78rem',color:'var(--text-secondary)',lineHeight:1.7}}>
        <div style=${{display:'flex',alignItems:'center',gap:'.4rem',marginBottom:'.4rem'}}>
          <span style=${{width:7,height:7,borderRadius:'50%',background:swColor,display:'inline-block'}}></span>
          <span>${swText}</span>
        </div>
        ${hasUpdate && html`<button onClick=${function(){
          navigator.serviceWorker.getRegistration().then(function(r){
            if(r&&r.waiting) r.waiting.postMessage({type:'SKIP_WAITING'});
            else window.location.reload();
          });
        }} style=${{padding:'.35rem .7rem',borderRadius:6,background:'var(--accent)',color:'#fff',fontWeight:600,fontSize:'0.8rem',border:'none',cursor:'pointer',marginBottom:'.4rem',fontFamily:'inherit'}}>
          Update available — click to update</button>`}
        ${canInstall && html`<button onClick=${function(){
          if(_ccInstallPrompt){_ccInstallPrompt.prompt();_ccInstallPrompt.userChoice.then(function(){_ccInstallPrompt=null;d({t:'UPD_PWA',u:{installAvailable:false}});});}
        }} style=${{padding:'.35rem .7rem',borderRadius:6,background:'#2563eb',color:'#fff',fontWeight:600,fontSize:'0.8rem',border:'none',cursor:'pointer',fontFamily:'inherit'}}>
          Install as Desktop App</button>`}
        ${!hasUpdate && !canInstall && html`<span style=${{color:'var(--text-faint)'}}>Everything up to date.</span>`}
      </div>`;
    }
  });

  // Expose install prompt for WelcomePopup compatibility
  window._ccPwaInstallPrompt = function() { return _ccInstallPrompt; };
  window._ccPwaPromptInstall = function() {
    if (_ccInstallPrompt) {
      _ccInstallPrompt.prompt();
      _ccInstallPrompt.userChoice.then(function(){ _ccInstallPrompt = null; });
    }
  };
})();
