// ── ClashControl Addon: Shared Project (shared folder) ──────────
// Team collaboration through a folder everyone can reach (OneDrive, Dropbox,
// NAS) via the File System Access API. No server.
//
// The folder holds a CHANGE LOG, not a project file (docs/INTERNALS.md §21.55):
//   <name>.ccshared/
//     project-<id>.json                 written once, names the project
//     changes/<userId>/<writer>-<seq>.json   one batch of change records,
//                                       written once by its author, never rewritten
//     snapshot-<ts>-<userId>.json       occasional compaction (every change it covers)
// Each user only ever creates new small files of their own, so a cloud sync
// client never sees two writers on one file (no "conflicted copy", no lost
// update) and a write costs what changed. Records carry team decisions only
// (status, priority, assignee, title, …, issues, comments), keyed by the
// clash identity / issue id; clash geometry and results stay local.
// Concurrent edits of one field are CONFLICTS shown to every user
// (shared-log-core.js decides them from the change graph, never by time);
// nobody wins automatically — a user resolves them.
//
// Pure log logic: shared-log-core.js (window._ccSharedLogCore); turning app
// actions into records and records into app state: shared-session-core.js
// (window._ccSharedSessionCore, the same engine the cloud project key uses).
// This file only does the folder I/O.

(function() {
  'use strict';

  // i18n passthrough: translated through the core's locale registry (window._cc_t) when it is
  // present, plain English otherwise, so this addon never depends on the core being newer.
  function _i18n(key, en, vars) {
    if (typeof window._cc_t === 'function') return window._cc_t(key, en, vars);
    return vars ? String(en).replace(/\{(\w+)\}/g, function(m, k) { return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m; }) : en;
  }
  function core() { return window._ccSharedLogCore || null; }
  function sessCore() { return window._ccSharedSessionCore || null; }

  var A_UPD = 'UPD_SHARED_PROJECT';
  var LS_UID = 'cc_shared_uid';
  var LS_OUTBOX = 'cc_shared_outbox';
  var LS_SEEDED = 'cc_shared_seeded';
  var LS_MIGRATED = 'cc_shared_migrated';

  // Tunables (tests shorten them through window._ccSharedLog.config).
  var CFG = {
    tickMs: 15000,          // folder check (names + metadata only when idle)
    flushDelayMs: 3000,     // local edits are batched this long into one file
    snapshotAt: 200,        // uncovered change files before someone compacts
    graceMs: 6 * 3600000    // a snapshot's covered files are removed this long after it
  };

  // ── Session state ───────────────────────────────────────────────
  var _root = null;         // the folder the user picked
  var _proj = null;         // the <name>.ccshared folder in it
  var _projKey = null;      // project-<id>.json name (local cache key)
  var _sess = null;         // shared-session-core session (owns the log + outbox)
  var _log = null;          // its shared-log-core log
  var _applied = new Set(); // change files ('changes/<u>/<f>') + snapshots already in the log
  var _broken = new Map();  // file → {size, lastModified} of a copy that did not parse (half-synced)
  var _snapMeta = new Map();// snapshot name → {name, by, ts, files, snapshots}
  var _flushTimer = null, _tickTimer = null, _busy = false, _again = false;
  var _writer = null, _seq = 0;
  var _cachePending = { recs: [], seen: [] };
  var _userId = null;
  var _stats = { ticks: 0, idleTicks: 0, listings: 0, filesRead: 0, bytesRead: 0, filesWritten: 0, bytesWritten: 0, deleted: 0, dispatches: 0, snapshotsWritten: 0 };

  function _rand(n) { var s = ''; while (s.length < n) s += Math.random().toString(36).slice(2); return s.slice(0, n); }
  function _uid() {
    if (typeof window.__ccSharedTestUser === 'string' && window.__ccSharedTestUser) return window.__ccSharedTestUser;
    try {
      var u = localStorage.getItem(LS_UID);
      if (u && core() && core().safeId(u)) return u;
      u = 'u' + _rand(11);
      localStorage.setItem(LS_UID, u);
      return u;
    } catch (e) { return 'u' + _rand(11); }
  }
  function _userName() {
    var st = window._ccLatestState, n = st && st.sharedProject && st.sharedProject.userName;
    if (!n) { try { n = localStorage.getItem('cc_username') || ''; } catch (e) { n = ''; } }
    return String(n || '').trim().slice(0, 80);
  }
  function _d(a) { if (typeof window._ccDispatch === 'function') { _stats.dispatches++; window._ccDispatch(a); } }
  function _state() { return window._ccLatestState || null; }

  // ── Registration ────────────────────────────────────────────────
  (typeof window._ccRegisterAddon === 'function' ? window._ccRegisterAddon : function(){})({
    id: 'shared-project',
    name: 'Shared Project',
    description: 'Work on clash and issue decisions with your team through a shared folder (OneDrive, Dropbox, NAS). Each person writes only small files of their own; changes made at the same time are shown to everyone as conflicts. No server needed.',
    autoActivate: false,
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',

    initState: {
      sharedProject: { enabled: false, folderName: '', fileName: '', userName: '', lastSync: null, syncing: false, conflicts: 0 }
    },

    reducerCases: {
      'UPD_SHARED_PROJECT': function(s, a) {
        return Object.assign({}, s, {sharedProject: Object.assign({}, s.sharedProject, a.u)});
      }
    },

    init: function(dispatch) {
      var nm = ''; try { nm = localStorage.getItem('cc_username') || ''; } catch (e) {}
      if (nm) dispatch({t:A_UPD, u:{userName:nm}});
      _loadSharedHandle(function(saved) {
        if (!saved || !saved.dirHandle || typeof saved.dirHandle.queryPermission !== 'function') return;
        saved.dirHandle.queryPermission({mode:'readwrite'}).then(function(perm) {
          if (perm === 'granted') _link(saved.dirHandle, dispatch, {restored:true}).catch(function(e) { console.warn('[shared-project] reconnect failed:', e); });
        }).catch(function(){});
      });
    },

    destroy: function() { _stop(); },

    panel: function(html, s, d) {
      var sp = s.sharedProject || {};
      var enabled = sp.enabled;
      var canUse = !!window.showDirectoryPicker;
      var T = {fontSize:'var(--text-xs)', color:'var(--text-secondary)', lineHeight:'var(--leading-base)'};
      var BTN = {padding:'var(--space-1) var(--space-3)', borderRadius:'var(--radius-sm)', fontSize:'var(--text-xs)', fontWeight:'var(--weight-semibold)', cursor:'pointer', fontFamily:'inherit', border:'1px solid var(--border)', background:'var(--bg-secondary)', color:'var(--text-secondary)'};
      return html`<div style=${{padding:'var(--space-2) 0', display:'flex', flexDirection:'column', gap:'var(--space-2)', ...T}}>
        <label style=${{display:'flex', alignItems:'center', gap:'var(--space-2)'}}>
          <span style=${{color:'var(--text-muted)', flexShrink:0}}>${_i18n('sharedProject.yourName','Your name:')}</span>
          <input type="text" value=${sp.userName||''} placeholder=${_i18n('sharedProject.enterYourName', 'Enter your name')}
            onInput=${function(e){ try { localStorage.setItem('cc_username', e.target.value); } catch (x) {} d({t:A_UPD, u:{userName:e.target.value}}); }}
            style=${{flex:1, padding:'var(--space-1) var(--space-2)', background:'var(--input-bg)', color:'var(--text-primary)', border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', fontSize:'var(--text-xs)', fontFamily:'inherit'}} />
        </label>
        ${!sp.userName && enabled && html`<div class="cc-status-pill" style=${{alignSelf:'flex-start', textTransform:'none', letterSpacing:0, background:'var(--color-warning-bg)', color:'var(--color-warning-fg)'}}>
          ${_i18n('sharedProject.setYourName', 'Set your name above so collaborators can see who made changes.')}
        </div>`}
        <div>${enabled ? _i18n('sharedProject.connectedTo', 'Connected: {path}', {path: sp.folderName + '/' + sp.fileName}) : _i18n('sharedProject.notConnected', 'Not connected')}</div>
        ${enabled && sp.lastSync && html`<div style=${{color:'var(--text-muted)'}}>
          ${_i18n('sharedProject.lastSync', 'Last sync:')} ${(typeof window._ccDateFmt === 'function') ? window._ccDateFmt(sp.lastSync, 'time') : new Date(sp.lastSync).toLocaleTimeString()}
        </div>`}
        ${enabled && sp.conflicts > 0 && html`<div data-cc-shared-conflict-count="1" class="cc-status-pill" style=${{alignSelf:'flex-start', background:'var(--color-warning-bg)', color:'var(--color-warning-fg)'}}>
          ${sp.conflicts === 1 ? _i18n('sharedConflict.countOne', '1 conflict to resolve') : _i18n('sharedConflict.countMany', '{n} conflicts to resolve', {n: sp.conflicts})}
        </div>`}
        <div style=${{display:'flex', gap:'var(--space-1)', flexWrap:'wrap'}}>
          ${!enabled && html`<button onClick=${function(){ _pickSharedFolder(d); }} disabled=${!canUse}
            style=${{...BTN, border:'none', background:canUse?'var(--accent)':'var(--bg-tertiary)', color:canUse?'var(--accent-contrast)':'var(--text-faint)'}}>${_i18n('sharedProject.linkFolder','Link Folder')}</button>`}
          ${enabled && html`<button onClick=${function(){ _syncSharedProject(d); }} disabled=${sp.syncing} style=${BTN}>${sp.syncing ? _i18n('sharedProject.syncing', 'Syncing...') : _i18n('sharedProject.syncNow', 'Sync Now')}</button>`}
          ${enabled && html`<button onClick=${function(){ _disconnectShared(d); }} style=${{...BTN, border:'1px solid var(--color-danger-border)', color:'var(--color-danger-fg)'}}>${_i18n('sharedProject.unlink','Unlink')}</button>`}
        </div>
        ${!canUse && html`<div style=${{color:'var(--color-warning-fg)'}}>${_i18n('sharedProject.fileSystemAccessApiNot','File System Access API not supported in this browser. Use Chrome or Edge.')}</div>`}
      </div>`;
    }
  });

  // ── IndexedDB: folder handle + local copy of the log ────────────
  // 'handles' keeps the picked folder; 'log' and 'seen' are a local cache
  // of what this browser already read ([projectKey, changeId] / [projectKey,
  // fileName]), so a reload reads only files that are new since.
  function _openSharedDB(cb) {
    try {
      var req = indexedDB.open('cc_shared', 2);
      req.onupgradeneeded = function(e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
        if (!db.objectStoreNames.contains('log')) db.createObjectStore('log');
        if (!db.objectStoreNames.contains('seen')) db.createObjectStore('seen');
      };
      req.onsuccess = function(e) { cb(e.target.result); };
      req.onerror = function() { cb(null); };
    } catch(e) { cb(null); }
  }
  function _saveSharedHandle(dirHandle, projName) {
    _openSharedDB(function(db) {
      if (!db) return;
      db.transaction('handles', 'readwrite').objectStore('handles').put({dirHandle:dirHandle, fileName:projName}, 'shared');
    });
  }
  function _loadSharedHandle(cb) {
    _openSharedDB(function(db) {
      if (!db) { cb(null); return; }
      var get = db.transaction('handles', 'readonly').objectStore('handles').get('shared');
      get.onsuccess = function() { cb(get.result || null); };
      get.onerror = function() { cb(null); };
    });
  }
  function _clearSharedHandle() {
    _openSharedDB(function(db) { if (db) db.transaction('handles', 'readwrite').objectStore('handles').delete('shared'); });
  }
  function _cacheLoad(pk) {
    return new Promise(function(resolve) {
      _openSharedDB(function(db) {
        if (!db) { resolve({recs:[], seen:[], names:{}}); return; }
        try {
          var tx = db.transaction(['log', 'seen'], 'readonly'), range = IDBKeyRange.bound([pk], [pk, []]);
          var out = {recs:[], seen:[], names:{}};
          var a = tx.objectStore('log').getAll(range), b = tx.objectStore('seen').getAll(range);
          a.onsuccess = function() { (a.result || []).forEach(function(v) { if (v && v.names) Object.assign(out.names, v.names); else if (v) out.recs.push(v); }); };
          b.onsuccess = function() { out.seen = b.result || []; };
          tx.oncomplete = function() { resolve(out); };
          tx.onerror = tx.onabort = function() { resolve({recs:[], seen:[], names:{}}); };
        } catch (e) { resolve({recs:[], seen:[], names:{}}); }
      });
    });
  }
  // Puts only what is new since the last put (one transaction).
  function _cacheFlush() {
    var pk = _projKey, p = _cachePending;
    if (!pk || (!p.recs.length && !p.seen.length)) return;
    _cachePending = {recs:[], seen:[]};
    _openSharedDB(function(db) {
      if (!db) return;
      try {
        var tx = db.transaction(['log', 'seen'], 'readwrite'), lg = tx.objectStore('log'), sn = tx.objectStore('seen');
        p.recs.forEach(function(r) { lg.put(r, [pk, r.id]); });
        if (_log) lg.put({names: _log.names}, [pk, '~names']);
        p.seen.forEach(function(n) { sn.put(n, [pk, n]); });
        if (tx.commit) tx.commit();
      } catch (e) { /* a cache only — the folder stays the source */ }
    });
  }
  function _noteApplied(name) { if (!_applied.has(name)) { _applied.add(name); _cachePending.seen.push(name); } }
  function _cacheRecs(recs) { recs.forEach(function(r) { _cachePending.recs.push(r); }); }

  // ── Folder access ───────────────────────────────────────────────
  async function _entries(dir) {
    var out = [];
    for await (var pair of dir.entries()) out.push({name: pair[0], handle: pair[1]});
    return out;
  }
  async function _readJson(handle) {
    var f = await handle.getFile();
    var txt = await f.text();
    _stats.filesRead++; _stats.bytesRead += txt.length;
    return {json: JSON.parse(txt), file: f, text: txt};
  }
  async function _writeNew(dir, name, obj) {
    var json = JSON.stringify(obj);
    var fh = await dir.getFileHandle(name, {create:true});
    var w = await fh.createWritable();
    await w.write(json);
    await w.close();
    _stats.filesWritten++; _stats.bytesWritten += json.length;
    return json.length;
  }

  function _pickSharedFolder(d) {
    if (!window.showDirectoryPicker) {
      alert(_i18n('sharedProject.fileSystemAccessApiNot','File System Access API not supported in this browser. Use Chrome or Edge.'));
      return;
    }
    // (The old code called .then on dirHandle.values() — an async iterator,
    // not a promise — so linking never completed. _link iterates with for await.)
    window.showDirectoryPicker({mode:'readwrite'}).then(function(dirHandle) {
      return _link(dirHandle, d, {});
    }).catch(function(e) {
      if (e && e.name !== 'AbortError') {
        console.warn('Folder picker error:', e);
        if (window._ccToast) window._ccToast(_i18n('sharedProject.linkFailed', 'Could not link the folder. Check that you can write to it and try again.'), 'error');
      }
    });
  }

  // Finds (or creates) the shared project in the picked folder, migrates an
  // old .ccproject there once, loads the local cache and starts syncing.
  async function _link(dirHandle, d, opts) {
    var C = core();
    if (!C) throw new Error('shared-log-core.js not loaded');
    _stop();
    _userId = _uid();
    _writer = 'w' + Date.now().toString(36) + _rand(4);
    _seq = 0;
    var entries = await _entries(dirHandle);
    var proj = null, legacy = null;
    if (/\.ccshared$/i.test(dirHandle.name || '')) proj = dirHandle;
    var dirs = entries.filter(function(e) { return e.handle.kind === 'directory' && /\.ccshared$/i.test(e.name); }).sort(function(a, b) { return a.name < b.name ? -1 : 1; });
    var olds = entries.filter(function(e) { return e.handle.kind === 'file' && /\.ccproject$/i.test(e.name); }).sort(function(a, b) { return a.name < b.name ? -1 : 1; });
    if (olds.length) legacy = olds[0];
    if (!proj && dirs.length) proj = dirs[0].handle;
    if (!proj) {
      var base = legacy ? legacy.name.replace(/\.ccproject$/i, '') : 'ClashControl';
      proj = await dirHandle.getDirectoryHandle(base.replace(/[\\/:*?"<>|]/g, '_') + '.ccshared', {create:true});
    }
    // the project's id file (write-once, unique name: no two writers on one file)
    var pents = await _entries(proj);
    var ids = pents.filter(function(e) { return e.handle.kind === 'file' && /^project-[a-z0-9]+\.json$/.test(e.name); }).map(function(e) { return e.name; }).sort();
    if (!ids.length) {
      var idName = 'project-' + _rand(12) + '.json';
      await _writeNew(proj, idName, {_cc:'ClashControl.sharedProject', v:C.FORMAT, createdAt:new Date().toISOString()});
      ids = [idName];
    }
    _root = dirHandle; _proj = proj; _projKey = ids[0];
    _applied = new Set(); _broken = new Map(); _snapMeta = new Map();
    _cachePending = {recs:[], seen:[]};
    _sess = _newSession();
    _log = _sess.log;
    var cache = await _cacheLoad(_projKey);
    _sess.ingest(cache.recs, cache.names);
    cache.seen.forEach(function(n) { _applied.add(n); });
    if (_sess.adoptOutboxes()) _scheduleFlush();
    if (legacy) { try { await _migrate(legacy); } catch (e) { console.warn('[shared-project] migration of the old project file failed:', e); } }
    _saveSharedHandle(dirHandle, proj.name);
    d({t:A_UPD, u:{enabled:true, folderName:dirHandle.name || '', fileName:proj.name, lastSync:null, syncing:false, conflicts:C.conflictCount(_log)}});
    await _tick({force:true, full:true});
    _sess.seed(LS_SEEDED);
    _schedule();
    return true;
  }

  // The engine shared with the cloud project key (shared-session-core.js):
  // records from local actions, the log → app state, conflict markers.
  function _newSession() {
    var SC = sessCore();
    if (!SC) throw new Error('shared-session-core.js not loaded');
    if (_sess) SC.unregister(_sess);
    var ident = window._ccClashIdentityCore;
    var ls = null; try { ls = window.localStorage; } catch (e) {}
    return SC.register(SC.createSession({
      src: 'folder', userId: _userId, writer: _writer, projectKey: _projKey,
      dispatch: _d, getState: _state, i18n: _i18n, storage: ls, outboxPrefix: LS_OUTBOX,
      identityKey: function(c) { return ident ? ident.computeClashIdentityKey(c) : null; },
      onRecorded: function(why) { if (why === 'edit') _scheduleFlush(); else _flush(); },
      onConflicts: function(n) { _d({t:A_UPD, u:{conflicts:n}}); }
    }));
  }

  // Reads an old single-file project ONCE into an initial snapshot (the old
  // file stays as it is). Deterministic, so two people migrating the same
  // file at once write the same snapshot.
  async function _migrate(legacy) {
    var C = core();
    var f = await legacy.handle.getFile();
    var mark = _projKey + ':' + legacy.name + ':' + f.lastModified + ':' + f.size;
    try { if (localStorage.getItem(LS_MIGRATED) === mark) return; } catch (e) {}
    var txt = await f.text();
    _stats.filesRead++; _stats.bytesRead += txt.length;
    var data = JSON.parse(txt);
    var ident = window._ccClashIdentityCore && window._ccClashIdentityCore.computeClashIdentityKey;
    var m = C.migrateProject(data, txt, {identityKey: function(c) { return ident ? ident(c) : null; }});
    if (m && m.changes) {
      var have = (await _entries(_proj)).some(function(e) { return e.name === m.name; });
      if (!have) await _writeNew(_proj, m.name, m.snapshot);
    }
    try { localStorage.setItem(LS_MIGRATED, mark); } catch (e) {}
  }

  function _stop() {
    if (_tickTimer) { clearTimeout(_tickTimer); _tickTimer = null; }
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  }

  function _disconnectShared(d) {
    var done = function() {
      _stop();
      if (_sess) { _sess.clearMarkers(); if (sessCore()) sessCore().unregister(_sess); }
      _root = _proj = _projKey = _log = _sess = null;
      _applied = new Set();
      _clearSharedHandle();
      d({t:A_UPD, u:{enabled:false, folderName:'', fileName:'', lastSync:null, syncing:false, conflicts:0}});
    };
    _flush().then(done, done);
  }

  function _schedule() {
    if (_tickTimer) clearTimeout(_tickTimer);
    _tickTimer = setTimeout(function() { _tick({}).then(_schedule, _schedule); }, CFG.tickMs);
  }

  // ── Sync tick ───────────────────────────────────────────────────
  // Lists names (and, for a file that failed to parse before, its metadata);
  // reads only files not yet applied. Nothing new → no reads, no writes, no
  // dispatches.
  async function _tick(opts) {
    opts = opts || {};
    if (!_proj || !_log) return;
    if (_busy) { _again = true; return; }
    _busy = true;
    var C = core(), changed = false, touched = new Set(), remote = [];
    _stats.ticks++;
    try {
      if (_sess.adoptOutboxes()) _scheduleFlush();
      if (_sess.pending() && (opts.force || !_flushTimer)) await _flush();
      var listing = await _list();
      // snapshots first (newest first): what they cover need not be read
      var snaps = listing.snapshots.filter(function(s) { return !_applied.has(s.name); }).sort(function(a, b) { return a.name < b.name ? 1 : -1; });
      for (var i = 0; i < snaps.length; i++) {
        var s = snaps[i];
        if (_applied.has(s.name)) continue;
        var parsed = await _readParsed(s, 'snapshot');
        if (!parsed) continue;
        var add = _sess.ingest(parsed.changes, parsed.names);
        _cacheRecs(add.added);
        add.touched.forEach(function(t) { touched.add(t); });
        add.added.forEach(function(r) { remote.push(r); });
        var nm = C.parseSnapshotName(s.name);
        _snapMeta.set(s.name, {name:s.name, by:nm ? nm.by : parsed.by, ts:nm ? nm.ts : parsed.ts, files:parsed.files, snapshots:parsed.snapshots});
        _noteApplied(s.name);
        parsed.files.forEach(_noteApplied);
        parsed.snapshots.forEach(_noteApplied);
        changed = true;
      }
      var files = listing.files.filter(function(f) { return !_applied.has(f.name); });
      for (var j = 0; j < files.length; j++) {
        var parsedF = await _readParsed(files[j], 'changes');
        if (!parsedF) continue;
        var addF = _sess.ingest(parsedF.changes, parsedF.names);
        _cacheRecs(addF.added);
        addF.touched.forEach(function(t) { touched.add(t); });
        addF.added.forEach(function(r) { remote.push(r); });
        _noteApplied(files[j].name);
        changed = true;
      }
      // what changed in the log, plus every target of a kind whose local
      // array was replaced (a detection run, a project load)
      var projected = _sess.sync({touched: touched, remote: remote, full: !!opts.full});
      if (changed) {
        _cacheFlush();
        _d({t:A_UPD, u:{lastSync:Date.now(), conflicts:C.conflictCount(_log)}});
      } else if (projected) {
        _d({t:A_UPD, u:{conflicts:C.conflictCount(_log)}});
      }
      if (!changed && !projected) _stats.idleTicks++;
      await _maybeSnapshot(listing);
      await _cleanup(listing);
    } catch (e) {
      console.warn('[shared-project] sync failed:', e);
      if (window._ccToast && e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        window._ccToast(_i18n('sharedProject.sharedFolderAccessLostOpen','Shared folder access lost — open Integrations and re-link the folder.'), 'error');
      }
    } finally {
      _busy = false;
      if (_again) { _again = false; setTimeout(function() { _tick({}); }, 0); }
    }
  }

  // Names only (+ the handles to read the new ones with).
  async function _list() {
    _stats.listings++;
    var out = {snapshots: [], files: [], dirs: {}};
    var ents = await _entries(_proj);
    var changesDir = null;
    ents.forEach(function(e) {
      if (e.handle.kind === 'file' && /^snapshot-.*\.json$/.test(e.name)) out.snapshots.push({name:e.name, handle:e.handle, dir:_proj});
      if (e.handle.kind === 'directory' && e.name === 'changes') changesDir = e.handle;
    });
    if (changesDir) {
      var users = await _entries(changesDir);
      for (var i = 0; i < users.length; i++) {
        var u = users[i];
        if (u.handle.kind !== 'directory' || !core().safeId(u.name)) continue;
        out.dirs[u.name] = u.handle;
        var fs = await _entries(u.handle);
        fs.forEach(function(f) { if (f.handle.kind === 'file' && /\.json$/.test(f.name)) out.files.push({name:'changes/' + u.name + '/' + f.name, base:f.name, handle:f.handle, dir:u.handle}); });
      }
    }
    return out;
  }
  // A file that fails to parse (a cloud client still downloading it) is
  // retried only once its size or date changes — metadata, not contents.
  async function _readParsed(ent, kind) {
    var C = core(), prev = _broken.get(ent.name);
    if (prev) {
      var meta = await ent.handle.getFile();
      if (meta.size === prev.size && meta.lastModified === prev.lastModified) return null;
    }
    var r;
    try { r = await _readJson(ent.handle); } catch (e) {
      try { var f = await ent.handle.getFile(); _broken.set(ent.name, {size:f.size, lastModified:f.lastModified}); } catch (e2) {}
      return null;
    }
    _broken.delete(ent.name);
    var parsed = kind === 'snapshot' ? C.parseSnapshot(r.json) : C.parseChangeFile(r.json);
    if (!parsed) { _broken.set(ent.name, {size:r.file.size, lastModified:r.file.lastModified}); return null; }
    return parsed;
  }

  // ── Writing ─────────────────────────────────────────────────────
  function _scheduleFlush(ms) {
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(function() { _flushTimer = null; _flush(); }, ms == null ? CFG.flushDelayMs : ms);
  }
  // Every pending local change → ONE new file of this user. A failed write
  // keeps them pending (and in localStorage) for the next attempt.
  var _flushing = null;
  function _flush() {
    if (_flushing) return _flushing.then(function() { return _sess && _sess.pending() ? _flush() : null; });
    if (!_proj || !_sess || !_sess.pending()) return Promise.resolve();
    var C = core(), sess = _sess, recs = sess.takeBatch();
    if (!recs.length) return Promise.resolve();
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    _flushing = (async function() {
      var changes = await _proj.getDirectoryHandle('changes', {create:true});
      var mine = await changes.getDirectoryHandle(_userId, {create:true});
      var seq = ++_seq;
      var name = C.changeFileName(_writer, seq);
      await _writeNew(mine, name, C.changeFile({user:_userId, name:_userName(), writer:_writer, seq:seq, ts:Date.now()}, recs));
      sess.done(recs);
      _noteApplied('changes/' + _userId + '/' + name);
      var nm = {}; nm[_userId] = _userName(); C.addNames(sess.log, nm);
      _cacheRecs(recs);
      _cacheFlush();
    })().catch(function(e) {
      sess.release(recs);
      console.warn('[shared-project] write failed, will retry:', e);
      if (window._ccToast && e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        window._ccToast(_i18n('sharedProject.sharedFolderAccessLostOpen','Shared folder access lost — open Integrations and re-link the folder.'), 'error');
      }
      _scheduleFlush(CFG.tickMs);
    }).then(function() { _flushing = null; });
    return _flushing;
  }

  // Compaction: past the threshold, one client writes a snapshot of its log
  // covering the change files it has read (a random half of the clients per
  // tick, so a team rarely writes two at once — two are harmless anyway).
  async function _maybeSnapshot(listing) {
    var C = core();
    var covered = new Set();
    _snapMeta.forEach(function(m) { (m.files || []).forEach(function(f) { covered.add(f); }); });
    var loose = listing.files.filter(function(f) { return !covered.has(f.name); });
    if (loose.length < CFG.snapshotAt || _sess.pending() || Math.random() < 0.5) return;
    var files = listing.files.filter(function(f) { return _applied.has(f.name); }).map(function(f) { return f.name; });
    var snaps = listing.snapshots.filter(function(s) { return _applied.has(s.name); }).map(function(s) { return s.name; });
    var ts = Date.now(), name = C.snapshotName(_userId, ts);
    await _writeNew(_proj, name, C.buildSnapshot(_log, {by:_userId, ts:ts, files:files, snapshots:snaps}));
    _stats.snapshotsWritten++;
    _snapMeta.set(name, {name:name, by:_userId, ts:ts, files:files, snapshots:snaps});
    _noteApplied(name);
    _cacheFlush();
  }
  // Removes what this user's own snapshots cover, once they are older than
  // the grace period (shared-log-core.planCleanup decides; covered = every
  // change of it is inside the snapshot).
  async function _cleanup(listing) {
    var C = core(), mine = [];
    _snapMeta.forEach(function(m) { if (m.by === _userId) mine.push(m); });
    if (!mine.length) return;
    var plan = C.planCleanup({me:_userId, now:Date.now(), graceMs:CFG.graceMs, snapshots:mine,
      presentFiles: listing.files.map(function(f) { return f.name; }), presentSnapshots: listing.snapshots.map(function(s) { return s.name; })});
    var byName = new Map();
    listing.files.forEach(function(f) { byName.set(f.name, f); });
    listing.snapshots.forEach(function(s) { byName.set(s.name, {base:s.name, dir:s.dir}); });
    var gone = plan.files.concat(plan.snapshots);
    for (var i = 0; i < gone.length; i++) {
      var ent = byName.get(gone[i]);
      if (!ent) continue;
      try { await ent.dir.removeEntry(ent.base); _stats.deleted++; } catch (e) { /* already gone / a teammate removed it */ }
    }
  }

  // Sync Now: write what is pending, then read what is new.
  function _syncSharedProject(d) {
    if (!_proj) return Promise.resolve();
    (d || _d)({t:A_UPD, u:{syncing:true}});
    return _flush().then(function() { return _tick({force:true}); }).then(function() {
      (d || _d)({t:A_UPD, u:{syncing:false, lastSync:Date.now()}});
    });
  }
  function _startSharedSync() { if (_proj) _schedule(); }

  // Last-moment write when the tab goes away (best effort; whatever does not
  // make it stays in localStorage and is written on the next link).
  window.addEventListener('pagehide', function() { if (_sess && _sess.pending()) { _sess.saveOutbox(); _flush(); } });
  document.addEventListener('visibilitychange', function() { if (document.visibilityState === 'hidden' && _sess && _sess.pending()) _flush(); });

  // Expose for the core (Share modal, welcome, dispatch wrapper, row UI)
  window._pickSharedFolder = _pickSharedFolder;
  window._disconnectShared = _disconnectShared;
  window._syncSharedProject = _syncSharedProject;
  window._startSharedSync = _startSharedSync;
  window._loadSharedHandle = _loadSharedHandle;
  // internal plumbing for the browser test (OPFS stands in for a picked folder)
  window._ccSharedLog = {
    config: CFG, stats: _stats,
    link: function(dirHandle) { return _link(dirHandle, window._ccDispatch, {}); },
    tick: function() { return _tick({}); },
    flush: function() { return _flush(); },
    pending: function() { return _sess ? _sess.pending() : 0; },
    log: function() { return _log; },
    session: function() { return _sess; }
  };
})();
