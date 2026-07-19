// ── ClashControl Addon: Shared Project ──────────────────────────
// Multi-user collaboration via File System Access API.
// Users pick a shared folder (OneDrive, Dropbox, NAS) and ClashControl
// syncs a .ccproject file every 60s. No backend needed.

(function() {
  'use strict';

  var _sharedDirHandle = null;
  var _sharedFileHandle = null;
  var _sharedSyncTimer = null;

  // Action type constant
  var A_UPD = 'UPD_SHARED_PROJECT';
  var A_MERGE = 'MERGE_CHANGELOG';

  // Guard per addon convention: the core must define this before the addon loads.
  (typeof window._ccRegisterAddon === 'function' ? window._ccRegisterAddon : function(){})({
    id: 'shared-project',
    name: 'Shared Project',
    description: 'Sync clashes and issues with your team via a shared folder (OneDrive, Dropbox, NAS). No server needed.',
    autoActivate: false,
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',

    initState: {
      sharedProject: {
        enabled: false,
        folderName: '',
        fileName: '',
        userName: '',
        lastSync: null,
        syncing: false,
        lastRemoteTs: null
      }
    },

    reducerCases: {
      'UPD_SHARED_PROJECT': function(s, a) {
        return Object.assign({}, s, {sharedProject: Object.assign({}, s.sharedProject, a.u)});
      }
    },

    init: function(dispatch, getState) {
      // Auto-reconnect to previously linked shared folder
      _loadSharedHandle(function(saved) {
        if (!saved || !saved.dirHandle) return;
        saved.dirHandle.queryPermission({mode:'readwrite'}).then(function(perm) {
          if (perm === 'granted') {
            _sharedDirHandle = saved.dirHandle;
            dispatch({t:A_UPD, u:{enabled:true, folderName:saved.dirHandle.name, fileName:saved.fileName||'project.ccproject'}});
            _startSharedSync(dispatch);
          }
        }).catch(function(){});
      });
    },

    destroy: function() {
      if (_sharedSyncTimer) { clearTimeout(_sharedSyncTimer); _sharedSyncTimer = null; }
      _sharedDirHandle = null;
      _sharedFileHandle = null;
    },

    panel: function(html, s, d) {
      var sp = s.sharedProject || {};
      var enabled = sp.enabled;
      var statusColor = enabled ? '#22c55e' : '#64748b';
      var canUse = !!window.showDirectoryPicker;

      return html`<div style=${{padding:'.5rem 0',fontSize:'0.78rem',color:'var(--text-secondary)',lineHeight:1.7}}>
        <div style=${{display:'flex',alignItems:'center',gap:'.4rem',marginBottom:'.5rem',padding:'.4rem .5rem',background:'rgba(37,99,235,.08)',borderRadius:6,border:'1px solid rgba(37,99,235,.15)'}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          <span style=${{fontSize:'0.72rem',color:'var(--text-muted)',flexShrink:0}}>Your name:</span>
          <input type="text" value=${sp.userName||''} placeholder="Enter your name"
            onInput=${function(e){ d({t:A_UPD, u:{userName:e.target.value}}); }}
            style=${{flex:1,padding:'.2rem .4rem',background:'var(--bg-primary)',color:'var(--text-primary)',border:'1px solid var(--border)',borderRadius:4,fontSize:'0.75rem',fontFamily:'inherit',outline:'none'}} />
        </div>
        ${!sp.userName && enabled && html`<div style=${{fontSize:'0.69rem',color:'#f59e0b',marginBottom:'.3rem',padding:'.2rem .4rem',background:'rgba(245,158,11,.08)',borderRadius:4}}>
          Set your name above so collaborators can see who made changes.
        </div>`}
        <div style=${{display:'flex',alignItems:'center',gap:'.4rem',marginBottom:'.4rem'}}>
          <span style=${{width:7,height:7,borderRadius:'50%',background:statusColor,display:'inline-block'}}></span>
          <span>${enabled ? 'Connected: ' + sp.folderName + '/' + sp.fileName : 'Not connected'}</span>
        </div>
        ${enabled && sp.lastSync && html`<div style=${{fontSize:'0.69rem',color:'var(--text-faint)',marginBottom:'.3rem'}}>
          Last sync: ${new Date(sp.lastSync).toLocaleTimeString()}${sp.syncing ? ' (syncing...)' : ''}
        </div>`}
        <div style=${{display:'flex',gap:'.3rem',marginBottom:'.4rem'}}>
          ${!enabled && html`<button onClick=${function(){_pickSharedFolder(d);}}
            disabled=${!canUse}
            style=${{padding:'.3rem .6rem',borderRadius:6,fontSize:'0.75rem',fontWeight:600,cursor:'pointer',border:'none',fontFamily:'inherit',
              background:canUse?'var(--accent)':'var(--bg-tertiary)',color:canUse?'#fff':'var(--text-faint)',
              opacity:canUse?1:0.5}}>Link Folder</button>`}
          ${enabled && html`<button onClick=${function(){_syncSharedProject(d);}}
            disabled=${sp.syncing}
            style=${{padding:'.3rem .6rem',borderRadius:6,fontSize:'0.75rem',fontWeight:600,cursor:'pointer',
              border:'1px solid var(--border)',background:'var(--bg-secondary)',color:'var(--text-secondary)',fontFamily:'inherit',
              opacity:sp.syncing?0.5:1}}>${sp.syncing?'Syncing...':'Sync Now'}</button>`}
          ${enabled && html`<button onClick=${function(){_disconnectShared(d);}}
            style=${{padding:'.3rem .6rem',borderRadius:6,fontSize:'0.75rem',fontWeight:600,cursor:'pointer',fontFamily:'inherit',
              border:'1px solid #ef444444',background:'var(--bg-secondary)',color:'#f87171'}}>Unlink</button>`}
        </div>
        ${!canUse && html`<div style=${{fontSize:'0.69rem',color:'#eab308',lineHeight:1.6}}>
          File System Access API not available. Use Chrome or Edge.
        </div>`}
      </div>`;
    }
  });

  // ── IndexedDB handle persistence ───────────────────────────────

  function _openSharedDB(cb) {
    try {
      var req = indexedDB.open('cc_shared', 1);
      req.onupgradeneeded = function(e) { e.target.result.createObjectStore('handles'); };
      req.onsuccess = function(e) { cb(e.target.result); };
      req.onerror = function() { cb(null); };
    } catch(e) { cb(null); }
  }

  function _saveSharedHandle(dirHandle, fileName) {
    _openSharedDB(function(db) {
      if (!db) return;
      var tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').put({dirHandle:dirHandle, fileName:fileName}, 'shared');
    });
  }

  function _loadSharedHandle(cb) {
    _openSharedDB(function(db) {
      if (!db) { cb(null); return; }
      var tx = db.transaction('handles', 'readonly');
      var get = tx.objectStore('handles').get('shared');
      get.onsuccess = function() { cb(get.result || null); };
      get.onerror = function() { cb(null); };
    });
  }

  function _clearSharedHandle() {
    _openSharedDB(function(db) {
      if (!db) return;
      var tx = db.transaction('handles', 'readwrite');
      tx.objectStore('handles').delete('shared');
    });
  }

  // ── Folder picker ──────────────────────────────────────────────

  function _pickSharedFolder(d) {
    if (!window.showDirectoryPicker) {
      alert('File System Access API not supported in this browser. Use Chrome or Edge.');
      return;
    }
    window.showDirectoryPicker({mode:'readwrite'}).then(function(dirHandle) {
      _sharedDirHandle = dirHandle;
      var fileName = 'project.ccproject';
      dirHandle.values().then(function(iter) {
        var found = null;
        function checkNext() {
          iter.next().then(function(result) {
            if (result.done) { finalize(found || fileName); return; }
            var entry = result.value;
            if (entry.kind === 'file' && (entry.name.endsWith('.ccproject') || entry.name.endsWith('.json'))) {
              found = entry.name;
            }
            checkNext();
          });
        }
        checkNext();
      }).catch(function() { finalize(fileName); });

      function finalize(fn) {
        _saveSharedHandle(dirHandle, fn);
        d({t:A_UPD, u:{enabled:true, folderName:dirHandle.name, fileName:fn, lastSync:null}});
        _startSharedSync(d); // syncs now AND starts the recurring timer — a fresh link must not go silent until reload
      }
    }).catch(function(e) {
      if (e.name !== 'AbortError') console.warn('Folder picker error:', e);
    });
  }

  function _disconnectShared(d) {
    if (_sharedSyncTimer) { clearTimeout(_sharedSyncTimer); _sharedSyncTimer = null; }
    _sharedDirHandle = null;
    _sharedFileHandle = null;
    _clearSharedHandle();
    d({t:A_UPD, u:{enabled:false, folderName:'', fileName:'', lastSync:null, syncing:false, lastRemoteTs:null}});
  }

  // ── File read/write ────────────────────────────────────────────

  // Resolves to: parsed data | null (file genuinely absent → safe to init-write)
  // | {__readError:true} (transient failure — permission hiccup, half-synced
  // cloud file, parse error). The distinction matters: writing local state
  // over a file we merely FAILED TO READ would erase the team's records.
  function _readSharedFile() {
    if (!_sharedDirHandle) return Promise.resolve(null);
    var state = window._ccLatestState;
    var fn = state && state.sharedProject ? state.sharedProject.fileName : 'project.ccproject';
    return _sharedDirHandle.getFileHandle(fn, {create:false}).then(function(fh) {
      _sharedFileHandle = fh;
      return fh.getFile().then(function(file) { return file.text(); }).then(function(txt) {
        var data = JSON.parse(txt);
        return data._cc === 'ClashControl' ? data : null;
      }).catch(function(e) {
        console.warn('Shared project read failed (skipping this sync):', e);
        return {__readError: true};
      });
    }).catch(function(e) {
      if (e && e.name === 'NotFoundError') return null; // no file yet — first writer initialises it
      console.warn('Shared project open failed (skipping this sync):', e);
      return {__readError: true};
    });
  }

  function _writeSharedFile(d) {
    if (!_sharedDirHandle) return Promise.resolve();
    var state = window._ccLatestState;
    if (!state) return Promise.resolve();
    var fn = state.sharedProject ? state.sharedProject.fileName : 'project.ccproject';
    var CC_VERSION = window.CC_VERSION || {v:'0.0.0'};
    var data = {
      _cc: 'ClashControl', _v: CC_VERSION.v,
      savedAt: new Date().toISOString(),
      rules: state.rules,
      models: state.models.map(function(m) {
        return {id:m.id, name:m.name, discipline:m.discipline, color:m.color, visible:m.visible, tag:m.tag||''};
      }),
      clashes: state.clashes,
      issues: state.issues,
      floors: state.floors,
      lastDeltaSummary: state.lastDeltaSummary || null,
      viewpoints: (state.viewpoints||[]).map(function(v){return Object.assign({},v,{snapshot:undefined})}),
      measurements: state.measurements||[],
      changelog: state.changelog || [],
      comments: state.comments || []
    };
    // _trainFV is the per-run training vector — rebuilt on every detection
    // run, meaningless to teammates, and ~250-350 B per clash in a file
    // rewritten every 60 s.
    var json = JSON.stringify(data, function(k, v) { return k === '_trainFV' ? undefined : v; }, 2);
    return _sharedDirHandle.getFileHandle(fn, {create:true}).then(function(fh) {
      _sharedFileHandle = fh;
      return fh.createWritable();
    }).then(function(writable) {
      return writable.write(json).then(function() { return writable.close(); });
    }).then(function() {
      d({t:A_UPD, u:{lastSync:Date.now()}});
    }).catch(function(e) {
      console.warn('Shared project write failed:', e);
      if (window._ccToast && e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        window._ccToast('Shared folder access lost — open Integrations and re-link the folder.', 'error');
      }
      throw e; // let the sync loop record the failure instead of stamping lastSync
    });
  }

  // ── Sync ───────────────────────────────────────────────────────

  function _syncSharedProject(d) {
    if (!_sharedDirHandle) return;
    var state = window._ccLatestState;
    if (!state || !state.sharedProject.enabled) return;
    d({t:A_UPD, u:{syncing:true}});

    _readSharedFile().then(function(remote) {
      if (remote && remote.__readError) {
        // Transient read failure — do NOT write (we'd clobber records we
        // couldn't see). Next tick retries.
        d({t:A_UPD, u:{syncing:false}});
        return null;
      }
      if (!remote) {
        return _writeSharedFile(d).then(function(){ d({t:A_UPD, u:{syncing:false, lastSync:Date.now()}}); });
      }
      var remoteChangelog = remote.changelog || [];
      if (remoteChangelog.length) {
        d({t:A_MERGE, v:remoteChangelog});
      }
      var ingested = _replayRemoteChanges(remote, d);
      if (ingested) {
        // We just dispatched remote-only records into local state, but the
        // reducer hasn't committed yet — writing now would serialize the OLD
        // arrays and erase what we ingested from the shared file. Skip this
        // cycle's write; the next tick writes the merged state.
        d({t:A_UPD, u:{syncing:false, lastSync:Date.now()}});
        return null;
      }
      return _writeSharedFile(d).then(function(){ d({t:A_UPD, u:{syncing:false, lastSync:Date.now()}}); });
    }).catch(function(e) {
      console.warn('Shared sync error:', e);
      d({t:A_UPD, u:{syncing:false}});
    });
  }

  // Returns true when remote-only records were dispatched into local state
  // (the caller must then skip this cycle's write — see _syncSharedProject).
  function _replayRemoteChanges(remote, d) {
    var state = window._ccLatestState;
    if (!state) return false;
    var ingested = false;

    // Ingest remote clashes/issues we don't have locally. Without this, a
    // client that never ran detection writes its (shorter) arrays over the
    // shared file and erases the team's records.
    var localClashIds = {};
    (state.clashes || []).forEach(function(c){ if (c && c.id) localClashIds[c.id] = true; });
    var newClashes = (remote.clashes || []).filter(function(c){ return c && c.id && !localClashIds[c.id]; });
    if (newClashes.length) {
      d({t:'ADD_CLASHES', v:newClashes}); // additive — never auto-resolves existing local clashes
      ingested = true;
    }
    var localIssueIds = {};
    (state.issues || []).forEach(function(i){ if (i && i.id) localIssueIds[i.id] = true; });
    (remote.issues || []).forEach(function(iss){
      if (iss && iss.id && !localIssueIds[iss.id]) { d({t:'ADD_ISSUE', v:iss, _fromSync:true}); ingested = true; }
    });

    // Merge in any remote viewpoints we don't already have. Snapshots are
    // stripped on write to keep the .ccproject file small, so recipients
    // see the camera/target but not the preview image.
    if (remote.viewpoints && remote.viewpoints.length) {
      var localVpIds = {};
      (state.viewpoints || []).forEach(function(v){ if (v && v.id) localVpIds[v.id] = true; });
      remote.viewpoints.forEach(function(v) {
        if (v && v.id && !localVpIds[v.id]) { d({t:'ADD_VIEWPOINT', v:v}); ingested = true; }
      });
    }

    // Comments — last-write-wins by id+ts. Reducer handles dedupe.
    if (remote.comments && remote.comments.length) {
      d({t:'MERGE_COMMENTS', v:remote.comments});
    }

    var localIds = {};
    state.changelog.forEach(function(e){ localIds[e.id] = true; });
    var newEntries = (remote.changelog || []).filter(function(e){ return !localIds[e.id]; });
    if (!newEntries.length) return ingested;

    var updates = {};
    newEntries.forEach(function(e) {
      if (!e.targetId) return;
      if (!updates[e.targetId]) updates[e.targetId] = {};
      updates[e.targetId][e.field] = e.value;
    });

    Object.keys(updates).forEach(function(targetId) {
      var upd = updates[targetId];
      var isClash = state.clashes.some(function(c){ return c.id === targetId; });
      var isIssue = state.issues.some(function(i){ return i.id === targetId; });
      if (isClash) {
        d({t:'UPD_CLASH', id:targetId, u:upd, _fromSync:true});
      } else if (isIssue) {
        d({t:'UPD_ISSUE', id:targetId, u:upd, _fromSync:true});
      }
    });
    return ingested;
  }

  function _startSharedSync(d) {
    if (_sharedSyncTimer) clearTimeout(_sharedSyncTimer);
    function tick() {
      _syncSharedProject(d);
      var st = window._ccLatestState;
      var hasOpenComments = st && (st.comments||[]).some(function(c){return !c.resolved;});
      var ms = hasOpenComments ? 15000 : 60000;
      _sharedSyncTimer = setTimeout(tick, ms);
    }
    _sharedSyncTimer = setTimeout(tick, 15000);
    _syncSharedProject(d);
  }

  // Expose for settings panel and welcome popup compatibility
  window._pickSharedFolder = _pickSharedFolder;
  window._disconnectShared = _disconnectShared;
  window._syncSharedProject = _syncSharedProject;
  window._startSharedSync = _startSharedSync;
  window._loadSharedHandle = _loadSharedHandle;
})();
