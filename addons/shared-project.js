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
// Pure log logic: shared-log-core.js (window._ccSharedLogCore). This file
// only does the folder I/O and maps the log onto the app state.

(function() {
  'use strict';

  // i18n passthrough: translated through the core's locale registry (window._cc_t) when it is
  // present, plain English otherwise, so this addon never depends on the core being newer.
  function _i18n(key, en, vars) {
    if (typeof window._cc_t === 'function') return window._cc_t(key, en, vars);
    return vars ? String(en).replace(/\{(\w+)\}/g, function(m, k) { return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m; }) : en;
  }
  function core() { return window._ccSharedLogCore || null; }

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
  var NOTE_FIELDS = ['text', 'resolved'];

  // ── Session state ───────────────────────────────────────────────
  var _root = null;         // the folder the user picked
  var _proj = null;         // the <name>.ccshared folder in it
  var _projKey = null;      // project-<id>.json name (local cache key)
  var _log = null;          // shared-log-core log
  var _applied = new Set(); // change files ('changes/<u>/<f>') + snapshots already in the log
  var _broken = new Map();  // file → {size, lastModified} of a copy that did not parse (half-synced)
  var _snapMeta = new Map();// snapshot name → {name, by, ts, files, snapshots}
  var _outbox = [];         // own changes not yet written (the log's record objects)
  var _flushTimer = null, _tickTimer = null, _busy = false, _again = false, _recorded = false;
  var _writer = null, _seq = 0, _n = 0;
  var _cachePending = { recs: [], seen: [] };
  var _written = new Set(); // ids of changes known to be in a file (this session)
  var _lastClashes = null, _lastIssues = null, _lastNotes = null;
  var _clashIndex = { clashes: null, map: null };
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
    _seq = 0; _n = 0;
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
    _log = C.createLog();
    _applied = new Set(); _broken = new Map(); _snapMeta = new Map(); _outbox = []; _written = new Set();
    _cachePending = {recs:[], seen:[]};
    _lastClashes = _lastIssues = _lastNotes = null;
    var cache = await _cacheLoad(_projKey);
    C.addChanges(_log, cache.recs);
    C.addNames(_log, cache.names);
    cache.seen.forEach(function(n) { _applied.add(n); });
    _adoptOutboxes();
    if (legacy) { try { await _migrate(legacy); } catch (e) { console.warn('[shared-project] migration of the old project file failed:', e); } }
    _saveSharedHandle(dirHandle, proj.name);
    d({t:A_UPD, u:{enabled:true, folderName:dirHandle.name || '', fileName:proj.name, lastSync:null, syncing:false, conflicts:C.conflictCount(_log)}});
    await _tick({force:true, full:true});
    _seed();
    _schedule();
    return true;
  }

  // Edits an earlier session (a closed tab) never got into the folder. Each
  // session keeps its own localStorage key; one touched less than a minute
  // ago may belong to a tab that is still open (it writes them itself), so
  // it is looked at again on a later check.
  function _adoptOutboxes() {
    var C = core();
    if (!_log || !_projKey) return;
    try {
      var now = Date.now(), mineKey = LS_OUTBOX + ':' + _writer, got = false;
      for (var k = localStorage.length - 1; k >= 0; k--) {
        var lk = localStorage.key(k);
        if (!lk || lk === mineKey || lk.indexOf(LS_OUTBOX + ':') !== 0) continue;
        var ob = JSON.parse(localStorage.getItem(lk) || 'null');
        if (!ob || ob.pk !== _projKey || !Array.isArray(ob.recs) || now - (ob.ts || 0) < 60000) continue;
        C.addChanges(_log, ob.recs);
        ob.recs.forEach(function(r) { var rec = _log.changes[r.id]; if (rec && _outbox.indexOf(rec) === -1 && !_written.has(r.id)) { _outbox.push(rec); got = true; } });
        localStorage.removeItem(lk);
      }
      if (got) { _saveOutbox(); _scheduleFlush(); }
    } catch (e) {}
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
      var st = _state();
      _clearMarkers(st, d);
      _root = _proj = _projKey = _log = null;
      _applied = new Set(); _outbox = [];
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
      _adoptOutboxes();
      if (_outbox.length && (opts.force || !_flushTimer)) await _flush();
      var listing = await _list();
      // snapshots first (newest first): what they cover need not be read
      var snaps = listing.snapshots.filter(function(s) { return !_applied.has(s.name); }).sort(function(a, b) { return a.name < b.name ? 1 : -1; });
      for (var i = 0; i < snaps.length; i++) {
        var s = snaps[i];
        if (_applied.has(s.name)) continue;
        var parsed = await _readParsed(s, 'snapshot');
        if (!parsed) continue;
        var add = C.addChanges(_log, parsed.changes);
        C.addNames(_log, parsed.names);
        _cacheRecs(add.added.map(function(id) { return _log.changes[id]; }));
        add.touched.forEach(function(t) { touched.add(t); });
        add.added.forEach(function(id) { remote.push(_log.changes[id]); });
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
        var addF = C.addChanges(_log, parsedF.changes);
        C.addNames(_log, parsedF.names);
        _cacheRecs(addF.added.map(function(id) { return _log.changes[id]; }));
        addF.touched.forEach(function(t) { touched.add(t); });
        addF.added.forEach(function(id) { remote.push(_log.changes[id]); });
        parsedF.changes.forEach(function(r) { _written.add(r.id); });
        _noteApplied(files[j].name);
        changed = true;
      }
      var st = _state();
      if (opts.full) C.targets(_log).forEach(function(t) { touched.add(C.targetKey(t[0], t[1])); });
      // new local clash / issue / note objects (a detection run, a project
      // load): put the shared decisions on them
      if (st && st.clashes !== _lastClashes) { _allOf('clash').forEach(function(t) { touched.add(t); }); _lastClashes = st.clashes; }
      if (st && st.issues !== _lastIssues) { _allOf('issue').forEach(function(t) { touched.add(t); }); _lastIssues = st.issues; }
      if (st && st.comments !== _lastNotes) { _allOf('note').forEach(function(t) { touched.add(t); }); _lastNotes = st.comments; }
      var projected = touched.size ? _project(touched, st) : 0;
      if (remote.length) _history(remote, st);
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
  function _allOf(kind) {
    var C = core(), out = [];
    if (!_log) return out;
    C.targets(_log).forEach(function(t) { if (t[0] === kind) out.push(C.targetKey(t[0], t[1])); });
    return out;
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
  function _saveOutbox() {
    try {
      var key = LS_OUTBOX + ':' + _writer;
      if (_outbox.length) localStorage.setItem(key, JSON.stringify({pk:_projKey, ts:Date.now(), recs:_outbox}));
      else localStorage.removeItem(key);
    } catch (e) {}
  }
  function _scheduleFlush(ms) {
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(function() { _flushTimer = null; _flush(); }, ms == null ? CFG.flushDelayMs : ms);
  }
  // Every pending local change → ONE new file of this user. A failed write
  // keeps them pending (and in localStorage) for the next attempt.
  var _flushing = null;
  function _flush() {
    if (_flushing) return _flushing.then(function() { return _outbox.length ? _flush() : null; });
    if (!_proj || !_outbox.length) return Promise.resolve();
    var C = core(), recs = _outbox.slice();
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    _flushing = (async function() {
      var changes = await _proj.getDirectoryHandle('changes', {create:true});
      var mine = await changes.getDirectoryHandle(_userId, {create:true});
      var seq = ++_seq;
      var name = C.changeFileName(_writer, seq);
      await _writeNew(mine, name, C.changeFile({user:_userId, name:_userName(), writer:_writer, seq:seq, ts:Date.now()}, recs));
      _outbox = _outbox.slice(recs.length);
      recs.forEach(function(r) { _written.add(r.id); });
      _saveOutbox();
      _noteApplied('changes/' + _userId + '/' + name);
      var nm = {}; nm[_userId] = _userName(); C.addNames(_log, nm);
      _cacheRecs(recs);
      _cacheFlush();
    })().catch(function(e) {
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
    if (loose.length < CFG.snapshotAt || _outbox.length || Math.random() < 0.5) return;
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

  // ── Local edits → change records ────────────────────────────────
  function _clashKey(c) {
    if (!c) return null;
    if (c._identityKey) return c._identityKey;
    var ic = window._ccClashIdentityCore;
    return ic ? ic.computeClashIdentityKey(c) : null;
  }
  function _newId() { return _writer + '.' + (++_n); }
  // One field edit. Skips no-ops; while the change is still unwritten, a
  // further edit of the same field (typing an assignee) amends it instead of
  // adding a record per keystroke.
  function _record(kind, key, field, value, prevLocal) {
    var C = core();
    if (!key || !_log) return null;
    if (value === undefined) value = null;
    var gk = C.groupKey(kind, key, field);
    var st = C.fieldState(_log, gk);
    if (!st && C.same(value, prevLocal)) return null;
    if (st && !st.conflicted && C.same(st.value, value)) return null;
    var last = _outbox.length ? _outbox[_outbox.length - 1] : null;
    if (last && !last.resolution && last.target.kind === kind && last.target.key === key && last.field === field &&
        st && !st.conflicted && st.heads.length === 1 && st.heads[0] === last) {
      last.value = value;
      _saveOutbox();
      _recorded = true;
      return last;
    }
    var r = C.makeChange(_log, {id:_newId(), user:_userId, ts:Date.now(), kind:kind, key:key, field:field, value:value, prev:prevLocal === undefined ? null : prevLocal});
    C.addChanges(_log, [r]);
    var rec = _log.changes[r.id];
    _outbox.push(rec);
    _saveOutbox();
    _recorded = true;
    return rec;
  }
  function _diffList(kind, key, prefix, before, after) {
    var b = {}, a = {};
    (before || []).forEach(function(x) { if (x && x.id) b[x.id] = x; });
    (after || []).forEach(function(x) { if (x && x.id) a[x.id] = x; });
    Object.keys(a).forEach(function(id) { if (!b[id] || !core().same(b[id], a[id])) _record(kind, key, prefix + id, JSON.parse(JSON.stringify(a[id])), b[id] ? JSON.parse(JSON.stringify(b[id])) : null); });
    Object.keys(b).forEach(function(id) { if (!a[id]) _record(kind, key, prefix + id, null, JSON.parse(JSON.stringify(b[id]))); });
  }
  function _noteRecord(n) { var o = Object.assign({}, n); delete o.replies; return core().issueRecord(o); }

  // Called by the core's dispatch wrapper for every local (non-sync) action,
  // with the state the action was dispatched on and, for batch actions, the
  // id set it applies to.
  function _note(a, prev, batchIds) {
    var C = core();
    if (!_proj || !_log || !C || !a || !prev) return;
    var F = C.DECISION_FIELDS, conflictedTargets = [];
    _recorded = false;
    function clashEdit(c, u) {
      var key = _clashKey(c);
      F.forEach(function(f) { if (u && Object.prototype.hasOwnProperty.call(u, f)) { _record('clash', key, f, u[f], c[f]); if ((c._sharedConflict || []).length) conflictedTargets.push(C.targetKey('clash', key)); } });
    }
    function issueEdit(it, u) {
      F.forEach(function(f) { if (u && Object.prototype.hasOwnProperty.call(u, f)) _record('issue', it.id, f, u[f], it[f]); });
      if (u && u.comments) _diffList('issue', it.id, 'comment:', it.comments, u.comments);
      if ((it._sharedConflict || []).length) conflictedTargets.push(C.targetKey('issue', it.id));
    }
    var t = a.t;
    if (t === 'UPD_CLASH' && a.u) {
      var c = (prev.clashes || []).find(function(x) { return x.id === a.id; });
      if (c) clashEdit(c, a.u);
    } else if (t === 'BATCH_UPD_CLASH' && a.u && batchIds) {
      (prev.clashes || []).forEach(function(x) { if (batchIds[x.id]) clashEdit(x, a.u); });
    } else if (t === 'CLASH_BATCH_RESTORE' && a.prev) {
      (prev.clashes || []).forEach(function(x) { if (a.prev[x.id]) clashEdit(x, a.prev[x.id]); });
    } else if (t === 'UPD_ISSUE' && a.u) {
      var it = (prev.issues || []).find(function(x) { return x.id === a.id; });
      if (it) issueEdit(it, a.u);
    } else if (t === 'BATCH_UPD_ISSUE' && a.u && batchIds) {
      (prev.issues || []).forEach(function(x) { if (batchIds[x.id]) issueEdit(x, a.u); });
    } else if (t === 'ADD_ISSUE' && a.v && a.v.id) {
      if ((prev.issues || []).some(function(x) { return x.id === a.v.id; })) return;
      _record('issue', a.v.id, 'created', C.issueRecord(a.v), null);
      if (a.v.comments) _diffList('issue', a.v.id, 'comment:', [], a.v.comments);
    } else if (t === 'DEL_ISSUE' && a.id) {
      if ((prev.issues || []).some(function(x) { return x.id === a.id; })) _record('issue', a.id, 'deleted', true, null);
    } else if (t === 'ADD_COMMENT' && a.v && a.v.id) {
      _record('note', a.v.id, 'created', _noteRecord(a.v), null);
      if (a.v.replies) _diffList('note', a.v.id, 'reply:', [], a.v.replies);
    } else if (t === 'UPD_COMMENT' && a.u) {
      var n = (prev.comments || []).find(function(x) { return x.id === a.id; });
      if (n) {
        NOTE_FIELDS.forEach(function(f) { if (Object.prototype.hasOwnProperty.call(a.u, f)) _record('note', n.id, f, a.u[f], n[f]); });
        if (a.u.replies) _diffList('note', n.id, 'reply:', n.replies, a.u.replies);
      }
    } else if (t === 'DEL_COMMENT' && a.id) {
      if ((prev.comments || []).some(function(x) { return x.id === a.id; })) _record('note', a.id, 'deleted', true, null);
    }
    if (_recorded) _scheduleFlush();
    // an edit of a conflicted field joins the conflict: show the agreed
    // value again once the reducer has applied the edit
    if (conflictedTargets.length) setTimeout(function() { _project(new Set(conflictedTargets), _state()); }, 0);
  }

  // A user's resolution of one conflicted field: one of the competing values
  // or a new one. Written at once, so teammates see it on their next check.
  function _resolve(o) {
    var C = core();
    if (!_proj || !_log || !o || !o.kind || !o.key || !o.field) return false;
    var r = C.makeResolution(_log, {id:_newId(), user:_userId, ts:Date.now(), kind:o.kind, key:o.key, field:o.field, value:o.value});
    C.addChanges(_log, [r]);
    _outbox.push(_log.changes[r.id]);
    _saveOutbox();
    _project(new Set([C.targetKey(o.kind, o.key)]), _state());
    _d({t:A_UPD, u:{conflicts:C.conflictCount(_log)}});
    _flush();
    return true;
  }

  // Publishes, once per browser and shared project, this user's own
  // decisions that are not in the folder yet (non-default clash values,
  // issues, notes). A value that differs from a shared one is published as a
  // concurrent change — a conflict for everyone to see, never silently lost.
  function _seed() {
    var C = core(), st = _state();
    if (!_log || !st) return;
    var mark = _projKey + ':' + _userId;
    try { if (localStorage.getItem(LS_SEEDED) === mark) return; } catch (e) {}
    var DEF = {status:['open', 'auto_resolved'], priority:['normal'], assignee:[''], title:null, description:null, category:null, dueDate:null};
    function seedOne(kind, key, f, v, def) {
      var fs = C.fieldState(_log, C.groupKey(kind, key, f));
      if (fs && (C.same(fs.value, v) || fs.conflicted)) return;
      var r = {id:_newId(), user:_userId, ts:Date.now(), target:{kind:kind, key:key}, field:f, value:v, base:null, prev:def};
      C.addChanges(_log, [r]);
      _outbox.push(_log.changes[r.id]);
    }
    (st.clashes || []).forEach(function(c) {
      var key = _clashKey(c);
      if (!key) return;
      ['status', 'priority', 'assignee'].forEach(function(f) {
        var v = c[f];
        if (v == null || DEF[f].indexOf(v) !== -1) return;
        seedOne('clash', key, f, v, DEF[f][0]);
      });
    });
    (st.issues || []).forEach(function(it) {
      if (!it || !it.id || C.fieldState(_log, C.groupKey('issue', it.id, 'created'))) return;
      seedOne('issue', it.id, 'created', C.issueRecord(it), null);
      (it.comments || []).forEach(function(cm) { if (cm && cm.id) seedOne('issue', it.id, 'comment:' + cm.id, JSON.parse(JSON.stringify(cm)), null); });
    });
    (st.comments || []).forEach(function(n) {
      if (!n || !n.id || C.fieldState(_log, C.groupKey('note', n.id, 'created'))) return;
      seedOne('note', n.id, 'created', _noteRecord(n), null);
      (n.replies || []).forEach(function(rp) { if (rp && rp.id) seedOne('note', n.id, 'reply:' + rp.id, JSON.parse(JSON.stringify(rp)), null); });
    });
    try { localStorage.setItem(LS_SEEDED, mark); } catch (e) {}
    if (_outbox.length) {
      _saveOutbox();
      _project(new Set(C.targets(_log).map(function(t) { return C.targetKey(t[0], t[1]); })), st);
      _d({t:A_UPD, u:{conflicts:C.conflictCount(_log)}});
      _flush();
    }
  }

  // ── The log → app state ─────────────────────────────────────────
  function _who(r) { var n = _log && _log.names[r.user]; return n || _i18n('sharedConflict.someone', 'a teammate'); }
  function _markers(ts) {
    if (!ts.conflicts.length) return undefined;
    return ts.conflicts.map(function(st) {
      return {kind:st.kind, key:st.key, field:st.field,
        agreed: st.known ? {value: st.value === undefined ? null : st.value, user: st.agreed ? _who(st.agreed) : null, ts: st.agreed ? st.agreed.ts : null} : null,
        heads: st.heads.map(function(h) { return {id:h.id, user:_who(h), mine:h.user === _userId, ts:h.ts, value:h.value}; })};
    });
  }
  function _markerSig(m) { return m && m.length ? JSON.stringify(m.map(function(x) { return [x.field, x.agreed && x.agreed.value, x.heads.map(function(h) { return h.id + '@' + h.user; })]; })) : ''; }
  function _clashesByKey(st) {
    if (_clashIndex.clashes === st.clashes) return _clashIndex.map;
    var map = new Map();
    (st.clashes || []).forEach(function(c) {
      var k = _clashKey(c);
      if (!k) return;
      var arr = map.get(k); if (arr) arr.push(c); else map.set(k, [c]);
    });
    _clashIndex = {clashes: st.clashes, map: map};
    return map;
  }
  function _mergeList(local, ts, prefix) {
    var byId = new Map(), changed = false;
    (local || []).forEach(function(x) { if (x && x.id) byId.set(x.id, x); });
    Object.keys(ts.fields).forEach(function(f) {
      if (f.indexOf(prefix) !== 0) return;
      var fs = ts.fields[f], id = f.slice(prefix.length);
      if (!fs.known) return;
      if (fs.value == null) { if (byId.has(id)) { byId.delete(id); changed = true; } return; }
      var cur = byId.get(id);
      if (!cur || !core().same(cur, fs.value)) { byId.set(id, fs.value); changed = true; }
    });
    if (!changed) return null;
    return Array.from(byId.values()).sort(function(a, b) { return (a.ts || 0) - (b.ts || 0); });
  }
  // Puts the shared value of every field of the given targets (and their
  // conflict markers) on the local clashes / issues / notes. Dispatches only
  // what differs. Returns the number of dispatches.
  function _project(tks, st) {
    var C = core();
    if (!_log || !st || !tks || !tks.size) return 0;
    var F = C.DECISION_FIELDS, restore = {}, nRestore = 0, n = 0;
    var issues = new Map(); (st.issues || []).forEach(function(i) { issues.set(i.id, i); });
    var notes = new Map(); (st.comments || []).forEach(function(c) { notes.set(c.id, c); });
    var byKey = _clashesByKey(st);
    tks.forEach(function(tk) {
      var i = tk.indexOf('\u0001'), kind = tk.slice(0, i), key = tk.slice(i + 1);
      var ts = C.targetState(_log, kind, key), mk = _markers(ts), sig = _markerSig(mk);
      if (kind === 'clash') {
        (byKey.get(key) || []).forEach(function(c) {
          var patch = {}, any = false;
          F.forEach(function(f) {
            var fs = ts.fields[f];
            if (!fs || !fs.known) return;
            if (f === 'status' && c.status === 'auto_resolved') return; // the geometry says it is gone
            if (!C.same(c[f], fs.value)) { patch[f] = fs.value; any = true; }
          });
          if (_markerSig(c._sharedConflict) !== sig) { patch._sharedConflict = mk; any = true; }
          if (any) { restore[c.id] = patch; nRestore++; }
        });
      } else if (kind === 'issue') {
        var del = ts.fields.deleted, cr = ts.fields.created, loc = issues.get(key);
        if (del && del.known && del.value === true) { if (loc) { _d({t:'DEL_ISSUE', id:key, _fromSync:true}); n++; } return; }
        var patchI = {}, anyI = false;
        F.forEach(function(f) { var fs = ts.fields[f]; if (fs && fs.known && (!loc || !C.same(loc[f], fs.value))) { patchI[f] = fs.value; anyI = true; } });
        var cms = _mergeList(loc ? loc.comments : [], ts, 'comment:');
        if (cms) { patchI.comments = cms; anyI = true; }
        if (!loc) {
          if (!cr || !cr.known || !cr.value) return;
          _d({t:'ADD_ISSUE', v:Object.assign({}, cr.value, patchI, {id:key, _sharedConflict:mk}), _fromSync:true}); n++;
          return;
        }
        if (_markerSig(loc._sharedConflict) !== sig) { patchI._sharedConflict = mk; anyI = true; }
        if (anyI) { _d({t:'UPD_ISSUE', id:key, u:patchI, _fromSync:true}); n++; }
      } else if (kind === 'note') {
        var delN = ts.fields.deleted, crN = ts.fields.created, ln = notes.get(key);
        if (delN && delN.known && delN.value === true) { if (ln) { _d({t:'DEL_COMMENT', id:key, _fromSync:true}); n++; } return; }
        var patchN = {}, anyN = false;
        NOTE_FIELDS.forEach(function(f) { var fs = ts.fields[f]; if (fs && fs.known && (!ln || !C.same(ln[f], fs.value))) { patchN[f] = fs.value; anyN = true; } });
        var reps = _mergeList(ln ? ln.replies : [], ts, 'reply:');
        if (reps) { patchN.replies = reps; anyN = true; }
        if (!ln) {
          if (!crN || !crN.known || !crN.value) return;
          _d({t:'ADD_COMMENT', v:Object.assign({replies:[]}, crN.value, patchN, {id:key, _sharedConflict:mk}), _fromSync:true}); n++;
          return;
        }
        if (_markerSig(ln._sharedConflict) !== sig) { patchN._sharedConflict = mk; anyN = true; }
        if (anyN) { _d({t:'UPD_COMMENT', id:key, u:patchN, _fromSync:true}); n++; }
      }
    });
    if (nRestore) { _d({t:'CLASH_BATCH_RESTORE', prev:restore, keepIssueIds:null, _fromSync:true}); n++; }
    return n;
  }
  // Teammates' changes in the History of each clash / issue.
  function _history(recs, st) {
    if (!st) return;
    var byKey = _clashesByKey(st), out = [];
    recs.forEach(function(r) {
      if (r.user === _userId) return;
      var targetId = r.target.kind === 'clash' ? ((byKey.get(r.target.key) || [])[0] || {}).id : r.target.key;
      if (!targetId) return;
      out.push({id:r.id, ts:r.ts, user:_who(r), type:r.target.kind === 'clash' ? 'clash_update' : (r.field === 'created' ? 'issue_created' : r.field === 'deleted' ? 'issue_deleted' : 'issue_update'),
        targetId:targetId, field:r.field, value:(r.value && typeof r.value === 'object') ? (r.value.title || r.value.text || '') : r.value});
    });
    if (out.length) _d({t:'MERGE_CHANGELOG', v:out});
  }
  function _clearMarkers(st, d) {
    if (!st) return;
    var restore = {}, any = false;
    (st.clashes || []).forEach(function(c) { if (c._sharedConflict) { restore[c.id] = {_sharedConflict: undefined}; any = true; } });
    if (any) d({t:'CLASH_BATCH_RESTORE', prev:restore, keepIssueIds:null, _fromSync:true});
    (st.issues || []).forEach(function(i) { if (i._sharedConflict) d({t:'UPD_ISSUE', id:i.id, u:{_sharedConflict:undefined}, _fromSync:true}); });
    (st.comments || []).forEach(function(c) { if (c._sharedConflict) d({t:'UPD_COMMENT', id:c.id, u:{_sharedConflict:undefined}, _fromSync:true}); });
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
  window.addEventListener('pagehide', function() { if (_outbox.length) { _saveOutbox(); _flush(); } });
  document.addEventListener('visibilitychange', function() { if (document.visibilityState === 'hidden' && _outbox.length) _flush(); });

  // Expose for the core (Share modal, welcome, dispatch wrapper, row UI)
  window._pickSharedFolder = _pickSharedFolder;
  window._disconnectShared = _disconnectShared;
  window._syncSharedProject = _syncSharedProject;
  window._startSharedSync = _startSharedSync;
  window._loadSharedHandle = _loadSharedHandle;
  window._ccSharedLogNote = _note;
  window._ccSharedResolve = _resolve;
  // internal plumbing for the browser test (OPFS stands in for a picked folder)
  window._ccSharedLog = {
    config: CFG, stats: _stats,
    link: function(dirHandle) { return _link(dirHandle, window._ccDispatch, {}); },
    tick: function() { return _tick({}); },
    flush: function() { return _flush(); },
    pending: function() { return _outbox.length; },
    log: function() { return _log; }
  };
})();
