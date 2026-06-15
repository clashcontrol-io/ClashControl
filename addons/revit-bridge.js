// ── ClashControl Addon: Revit Bridge ─────────────────────────────
// Part 1: Direct Connector — WebSocket live link to Revit plugin.
// Receives geometry + properties, converts to Three.js meshes.
// Supports model update (REPLACE_MODEL) on re-sync, linked models,
// and manual-only push of clashes back to Revit.

(function() {
  'use strict';

  var uid = window._ccUid || function() { return Math.random().toString(36).slice(2,10).toUpperCase(); };

  // ── Direct Connector state ─────────────────────────────────────

  var _revitWs = null;
  var _revitBuf = null;
  var _revitMatCache = {}; // colour "r,g,b,a" → shared MeshPhongMaterial (dedup, see #572)
  var _revitTmpMtx = null; // reused per placement; lazy-init once THREE is loaded
  var _revitAborted = false; // set by Cancel — ignore further export messages until the next export-start
  var _revitReconnect = null;
  var _revitConnectTimeout = null; // watchdog: fails a socket stuck in CONNECTING (handshake never completes)
  var CONNECT_TIMEOUT_MS = 5000;   // how long to wait for the WS handshake before giving up
  var _revitReconnectDelay = 0; // exponential backoff: 0 = no reconnect scheduled
  var _revitLastPort = 19780;
  var _revitLastDispatch = null;
  var _revitUserDisconnected = false; // true when user clicks Disconnect
  var _pullOnConnect = false; // true when user-initiated connect should auto-pull
  // Track which CC model ID corresponds to which Revit document name
  // so re-exports update the existing model instead of adding a duplicate.
  var _revitModelMap = {}; // {documentName_modelName: ccModelId}

  // Protocol version this build expects from the Revit Connector
  var EXPECTED_PROTOCOL_VERSION = '1.0';

  // RevitId → GlobalId index for deletion fallback (populated during import)
  var _revitIdIndex = {}; // {revitId: globalId}

  // Content-addressable element hash cache (globalId → contentHash)
  var _elementHashCache = {};
  // Try loading from localStorage on init
  try {
    var _savedHashes = localStorage.getItem('cc_element_hashes');
    if (_savedHashes) _elementHashCache = JSON.parse(_savedHashes);
  } catch(e) {}

  // Camera sync state
  var _cameraSyncEnabled = false;
  var _cameraSyncThrottleTimer = null;
  var _selectionSyncEnabled = true;

  // Last synced timestamp for live update indicator
  var _lastElementSync = 0;

  // ── Reconnection with exponential backoff ─────────────────────

  function _scheduleReconnect() {
    if (_revitUserDisconnected || !_revitLastDispatch) return;
    // Never let two reconnect chains run at once. _revitReconnect holds a single
    // timer id, so if a second schedule overwrites it the first timer leaks —
    // _revitDirectConnect's lone clearTimeout can't cancel it, and the orphan
    // fires its own connect, which multiplies into a runaway loop (many
    // "Connecting…" log lines per second, "can't connect at all").
    clearTimeout(_revitReconnect);
    if (_revitWs && _revitWs.readyState <= 1) return; // a connect is already in flight
    _revitReconnectDelay = Math.min((_revitReconnectDelay || 1000) * 2, 30000);
    var delay = _revitReconnectDelay;
    _revitLastDispatch({t:'UPD_REVIT_DIRECT', u:{reconnecting:true, reconnectIn:delay}});
    _revitLastDispatch({t:'BRIDGE_LOG', logType:'info', text:'Reconnecting in ' + (delay/1000) + 's...'});
    _revitReconnect = setTimeout(function() {
      _revitDirectConnect(_revitLastPort, _revitLastDispatch);
    }, delay);
  }

  function _resetReconnectDelay() {
    _revitReconnectDelay = 0;
  }

  // ── On-screen loading feedback ─────────────────────────────────
  // After a hard refresh the bridge auto-reconnects and re-pulls the model with
  // no visible feedback (blank canvas). Drive the core's existing centered
  // LoadProgressCard / WelcomePopup via the same cc-model-loading event the IFC
  // loader uses, so the user sees "reconnecting / receiving N%".
  function _revitLoadingEvent(on, msg) {
    try {
      window._ccModelLoading = !!on;
      window._ccModelLoadMsg = on ? (msg || 'Revit: loading…') : '';
      window.dispatchEvent(new CustomEvent('cc-model-loading', { detail: { loading: !!on, msg: msg || '' } }));
    } catch (e) {}
  }

  // ── Connector update check ─────────────────────────────────────
  // Compare the connected Connector's reported version against the latest GitHub
  // release; surface an update prompt (with the installer link) in the Revit Bridge
  // panel so users don't keep running a stale plugin. Runs at most once per page.
  var _connUpdateChecked = false;
  function _verCmp(a, b) { // returns 1 if a>b, -1 if a<b, 0 equal (numeric-dotted)
    var pa = String(a).replace(/^v/, '').split('.').map(function(n){return parseInt(n,10)||0;});
    var pb = String(b).replace(/^v/, '').split('.').map(function(n){return parseInt(n,10)||0;});
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0, y = pb[i] || 0;
      if (x > y) return 1; if (x < y) return -1;
    }
    return 0;
  }
  function _revitCheckConnectorUpdate(d, currentVersion) {
    if (_connUpdateChecked || !currentVersion) return;
    _connUpdateChecked = true;
    fetch('https://api.github.com/repos/clashcontrol-io/ClashControlConnector/releases/latest', { cache: 'no-store' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(rel){
        if (!rel || !rel.tag_name) return;
        var latest = String(rel.tag_name).replace(/^v/, '');
        if (_verCmp(latest, currentVersion) <= 0) return; // up to date (or newer)
        // Prefer the installer .exe asset, else the release page.
        var url = rel.html_url || null;
        (rel.assets || []).forEach(function(a){ if (/Installer.*\.exe$/i.test(a.name) && a.browser_download_url) url = a.browser_download_url; });
        d({t:'UPD_REVIT_DIRECT', u:{ connectorUpdate: { current: currentVersion, latest: latest, url: url } }});
        d({t:'BRIDGE_LOG', logType:'info', text:'Connector update available: v' + currentVersion + ' → v' + latest + '. Download the latest installer.'});
        if (window._ccToast) window._ccToast('Revit Connector update available (v' + latest + ') — download the latest installer.');
      })
      .catch(function(){ /* offline / rate-limited — skip silently */ });
  }
  window._revitCheckConnectorUpdate = _revitCheckConnectorUpdate;

  // ── WebSocket connection ───────────────────────────────────────

  function _revitDirectConnect(port, d) {
    // Debounce repeat triggers while an attempt to the same port is already in
    // flight (impatient Connect clicks). Aborting the in-flight socket only
    // restarts the clock and spams "closed before the connection is
    // established" — let the existing attempt and its watchdog resolve first.
    if (_revitWs && _revitWs.readyState === 0 && _revitLastPort === (port || 19780)) {
      if (d) d({t:'BRIDGE_LOG', logType:'info', text:'Already connecting to Revit — please wait…'});
      return;
    }
    // Tear down any prior socket AND detach its handlers before opening a new
    // one. If we close a socket but leave its onclose/onerror attached, that
    // superseded socket can still fire _scheduleReconnect() — stacking a second
    // reconnect chain alongside the new attempt. Detaching first guarantees only
    // the current socket can ever drive reconnect/log state.
    if (_revitWs) {
      try { _revitWs.onopen = _revitWs.onclose = _revitWs.onerror = _revitWs.onmessage = null; } catch(_) {}
      try { if (_revitWs.readyState <= 1) _revitWs.close(); } catch(_) {}
      _revitWs = null;
    }
    clearTimeout(_revitReconnect);
    clearTimeout(_revitConnectTimeout);
    _revitLastPort = port || 19780;
    _revitLastDispatch = d;
    _revitUserDisconnected = false;
    var url = 'ws://localhost:' + _revitLastPort;
    d({t:'BRIDGE_LOG', logType:'info', text:'Connecting to Revit at ' + url + '...'});
    d({t:'UPD_REVIT_DIRECT', u:{connected:false, loading:false, progress:0, reconnecting:false}});
    var ws;
    try { ws = new WebSocket(url); _revitWs = ws; } catch(e) {
      d({t:'BRIDGE_LOG', logType:'error', text:'WebSocket error: ' + e.message});
      _scheduleReconnect();
      return;
    }
    ws.binaryType = 'arraybuffer';

    // Handshake watchdog: a wedged Connector can accept the TCP connection but
    // never complete the WebSocket upgrade, leaving the socket stuck in
    // CONNECTING with no onopen/onerror — a silent hang. Fail it explicitly
    // after CONNECT_TIMEOUT_MS with a clear message, then fall into the normal
    // backoff so a later attempt (or a Connector restart) can recover.
    clearTimeout(_revitConnectTimeout);
    _revitConnectTimeout = setTimeout(function() {
      if (_revitWs !== ws || ws.readyState !== 0) return; // already opened/closed
      d({t:'BRIDGE_LOG', logType:'error', text:'Revit handshake timed out after ' + (CONNECT_TIMEOUT_MS/1000) + 's. The Connector may be wedged — toggle it off then on in Revit.'});
      d({t:'UPD_REVIT_DIRECT', u:{connected:false, loading:false}});
      try { ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null; } catch(_) {}
      try { ws.close(); } catch(_) {}
      _revitWs = null;
      _scheduleReconnect();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = function() {
      clearTimeout(_revitConnectTimeout);
      // Guard against a stale socket: a prior attempt's onopen can race in
      // after a reconnect superseded it (or after close nulled _revitWs),
      // which previously threw "Cannot read properties of null (reading 'send')".
      if (_revitWs !== ws || ws.readyState !== 1) { try { ws.close(); } catch(_){} return; }
      var wasReconnect = _revitReconnectDelay > 0;
      _resetReconnectDelay();
      d({t:'UPD_REVIT_DIRECT', u:{connected:true, reconnecting:false}});
      d({t:'BRIDGE_LOG', logType:'info', text:wasReconnect ? 'Reconnected to Revit plugin.' : 'Connected to Revit plugin.'});
      ws.send(JSON.stringify({type:'ping'}));
      // Auto-pull on first user-initiated connect
      if (_pullOnConnect || window._ccPullOnConnect) {
        _pullOnConnect = false;
        window._ccPullOnConnect = false;
        d({t:'BRIDGE_LOG', logType:'pull', text:'Auto-pulling model...'});
        setTimeout(function(){ _revitDirectExport(['all']); }, 300);
      } else if (wasReconnect) {
        // On reconnect: try session resumption first if we have cached hashes and
        // an existing Revit model. Connector replies with only the delta, or
        // session-expired if its cache is gone (Revit restarted) — in which case
        // the session-expired handler triggers a full re-export automatically.
        var state = window._ccLatestState;
        var hasRevitModel = !!(state && state.models && state.models.some(function(m){
          return m.stats && m.stats.source === 'revit-direct';
        }));
        var hashes = Object.keys(_elementHashCache);
        if (hasRevitModel && hashes.length > 0) {
          d({t:'BRIDGE_LOG', logType:'info', text:'Resuming session (' + hashes.length + ' known elements)...'});
          var payload = hashes.length > 20000
            ? (function(){ var t={}; for(var i=0;i<20000;i++) t[hashes[i]]=_elementHashCache[hashes[i]]; return t; })()
            : _elementHashCache;
          setTimeout(function(){
            if (_revitWs && _revitWs.readyState === 1)
              _revitWs.send(JSON.stringify({type:'resume-session', knownElements:payload}));
          }, 300);
        } else {
          // No cached state — prompt user rather than auto-exporting
          d({t:'UPD_REVIT_DIRECT', u:{reconnectPrompt:true}});
        }
      }
    };

    ws.onclose = function() {
      // Only the current socket may drive teardown + reconnect. A superseded
      // socket (or one closed by a deliberate disconnect, which nulls _revitWs)
      // is ignored. Strict !== — not "_revitWs && _revitWs !== ws" — so a null
      // _revitWs can't let a stale socket through to _scheduleReconnect().
      if (_revitWs !== ws) return;
      clearTimeout(_revitConnectTimeout);
      d({t:'UPD_REVIT_DIRECT', u:{connected:false, loading:false}});
      d({t:'BRIDGE_LOG', logType:'info', text:'Revit connection closed.'});
      _revitLoadingEvent(false); // clear the loading card if the link drops mid-pull
      _revitWs = null;
      _scheduleReconnect();
    };

    ws.onerror = function() {
      if (_revitWs !== ws) return; // superseded socket
      clearTimeout(_revitConnectTimeout);
      d({t:'UPD_REVIT_DIRECT', u:{connected:false, loading:false}});
      _revitLoadingEvent(false);
      // Only log error if not already reconnecting (avoid spam)
      if (!_revitReconnectDelay) d({t:'BRIDGE_LOG', logType:'error', text:'Could not connect to Revit. Is the plugin running?'});
      // Do NOT null _revitWs here — that would defeat onclose's "is this still
      // the current socket?" guard. onclose fires right after and owns teardown
      // (null + _scheduleReconnect).
    };

    ws.onmessage = function(ev) {
      if (_revitWs !== ws) return; // ignore frames from a superseded socket
      var msg;
      try { msg = JSON.parse(ev.data); }
      catch(e) {
        console.warn('[Revit] Dropped malformed WS frame:', e && e.message || e);
        return;
      }
      _handleRevitMessage(msg, d);
    };
  }

  function _revitDirectDisconnect(d) {
    _revitUserDisconnected = true;
    clearTimeout(_revitReconnect);
    clearTimeout(_revitConnectTimeout);
    _resetReconnectDelay();
    if (_revitWs) {
      try { _revitWs.onopen = _revitWs.onclose = _revitWs.onerror = _revitWs.onmessage = null; } catch(_) {}
      try { _revitWs.close(); } catch(_) {}
      _revitWs = null;
    }
    _revitBuf = null;
    d({t:'UPD_REVIT_DIRECT', u:{connected:false, loading:false, progress:0, documentName:'', reconnecting:false}});
  }

  // Trigger an export from the Revit connector. Parameters:
  //   categories  — list of Revit categories to include (default ['all'])
  //   modelFilter — optional object { name: 'Doc.rvt' } to restrict the
  //                 export to a single linked Revit model. Sent as
  //                 `modelFilter` on the protocol message so plugins
  //                 that understand it can scope the pull; older plugins
  //                 ignore the field and re-export the whole document.
  function _revitDirectExport(categories, modelFilter) {
    if (!_revitWs || _revitWs.readyState !== 1) return;
    var msg = {type:'export', categories: categories || ['all']};
    // Include projectId for project scoping
    var targetProj = window._ccRevitTargetProject;
    if (targetProj) msg.projectId = targetProj;
    // Scoped sync: tell a filter-aware Connector not to send excluded models
    // (we also skip them on receive, so this works even with an older Connector).
    if (modelFilter) msg.modelFilter = modelFilter;
    else if (_revitExcluded.length) msg.modelFilter = { exclude: _revitExcluded.slice() };
    // Delta-export hashes: only send when there's actually a matching
    // model already in state for the current project. On a first sync
    // (no Revit model loaded yet for this project) sending a bag of
    // 50k+ cached hashes from a PRIOR session forced the Revit plugin
    // to walk every element checking "is this one unchanged?" before
    // sending the first byte — which on big models froze Revit's UI
    // thread for 30+ s while the browser showed nothing. Skipping the
    // cache on first sync lets the plugin stream geometry straight
    // away and the UI shows progress immediately.
    var state = window._ccLatestState;
    var hasExistingRevitModel = !!(state && state.models && state.models.some(function(m){
      return m.stats && m.stats.source === 'revit-direct';
    }));
    if (hasExistingRevitModel && Object.keys(_elementHashCache).length > 0) {
      // Additionally cap the hash payload at 20k entries so even a very
      // large delta doesn't exceed the WebSocket frame budget or the
      // plugin's JSON parser limits.
      var keys = Object.keys(_elementHashCache);
      if (keys.length > 20000) {
        var trimmed = {};
        for (var i = 0; i < 20000; i++) trimmed[keys[i]] = _elementHashCache[keys[i]];
        msg.knownElements = trimmed;
      } else {
        msg.knownElements = _elementHashCache;
      }
    }
    _revitWs.send(JSON.stringify(msg));
  }

  function _revitDirectCancelExport() {
    // Stop processing this export: flag so late model-start/element-batch messages
    // are ignored (the WS may keep delivering already-queued batches), tell the
    // Connector to stop, drop the buffer, and clear the loading card.
    _revitAborted = true;
    _revitLoadingEvent(false);
    if (_revitLastDispatch) _revitLastDispatch({t:'UPD_REVIT_DIRECT', u:{loading:false, progress:0}});
    if (_revitWs && _revitWs.readyState === 1) {
      try { _revitWs.send(JSON.stringify({type:'cancel-export'})); } catch(e) {}
    }
    _revitBuf = null;
  }

  // ── Base64 decode helpers ──────────────────────────────────────

  function _b64ToFloat32(b64) {
    var bin = atob(b64), n = bin.length, buf = new ArrayBuffer(n), u8 = new Uint8Array(buf);
    for (var i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return new Float32Array(buf);
  }
  function _b64ToUint32(b64) {
    var bin = atob(b64), n = bin.length, buf = new ArrayBuffer(n), u8 = new Uint8Array(buf);
    for (var i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
    return new Uint32Array(buf);
  }

  // ── Non-renderable element filter ──────────────────────────────
  // The Revit Connector can hand us elements that Revit never shows in its 3D
  // view and that should never clash — datums (grids/levels/reference planes),
  // survey/base-point markers, spatial containers (rooms/areas/spaces), scope
  // boxes, cameras, etc. Left in, they appear as stray geometry "flying" far
  // from the model (base points sit at the survey origin) and pollute clash
  // results. This mirrors the IFC path, which skips IfcSpace / IfcOpeningElement
  // / IfcVirtualElement / IfcAnnotation / IfcGrid and survey markers.
  //
  // Honour an explicit visibility flag from the Connector first (most reliable),
  // then fall back to a conservative category keyword list. Kept conservative so
  // real building geometry is never dropped.
  // Matched against the (lower-cased) Revit category name; chosen to hit the real
  // category strings (mostly plural) without snagging building elements.
  var _REVIT_SKIP_CATS = [
    'rooms', 'areas', 'spaces', 'mep spaces',            // spatial containers
    'survey point', 'project base point', 'internal origin', 'base point',
    'reference planes', 'reference lines', 'grids', 'levels', 'scope boxes',
    'cameras', 'section box', 'property lines', 'matchline', 'analytical',
    'sun path', 'viewports'
  ];
  function _revitSkipElement(el) {
    if (!el) return true;
    // Explicit visibility from the Connector, if provided.
    if (el.visible === false || el.hidden === true || el.isHidden === true) return true;
    var cat = (el.category || el.type || '').toLowerCase();
    if (!cat) return false;
    for (var i = 0; i < _REVIT_SKIP_CATS.length; i++) {
      if (cat.indexOf(_REVIT_SKIP_CATS[i]) >= 0) return true;
    }
    return false;
  }

  // ── Convert Revit element to Three.js mesh ─────────────────────

  function _revitElementToMesh(el, nextId) {
    var meshes = [], box = new THREE.Box3();
    if (el.geometry && el.geometry.positions) {
      var positions = _b64ToFloat32(el.geometry.positions);
      var indices = _b64ToUint32(el.geometry.indices);
      var geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geom.setIndex(new THREE.BufferAttribute(indices, 1));
      if (el.geometry.normals) {
        geom.setAttribute('normal', new THREE.BufferAttribute(_b64ToFloat32(el.geometry.normals), 3));
      } else {
        geom.computeVertexNormals();
      }
      // Quantize normals to Int8 (same memory win as the IFC path) when the core
      // helper is available.
      try { if (window._ccQuantizeNormalAttr) window._ccQuantizeNormalAttr(geom); } catch(_e) {}
      geom.computeBoundingBox();
      var c = el.geometry.color || [0.65, 0.65, 0.65, 1.0];
      var _a = c[3] != null ? c[3] : 1;
      // Rooms/spaces arrive as IfcSpace volumes. Render them translucent so they
      // read as room boundaries without hiding the building inside; they're also
      // excluded from standard clash detection (see _sweepAndPrune, includeSpaces).
      if (el.category === 'IfcSpace') { c = [0.30, 0.66, 0.95]; _a = 0.14; }
      // Material dedup by colour. Prefer the core's shared cache so EVERY load
      // path (IFC + Revit live-link) shares one material per colour — the whole
      // point of #572. Falls back to a local per-addon cache if the core helper
      // isn't exposed yet. A fresh material per element meant ~82k distinct
      // materials on the big model — heavy on memory and draw-call changes. Safe
      // with the highlight/ghost/render-style systems, which swap mesh.material
      // by reference (and stash _origMaterial) rather than mutating it in place.
      var mat;
      if (window._ccGetSharedPhongMat) {
        mat = window._ccGetSharedPhongMat(c[0], c[1], c[2], _a);
      } else {
        var _ck = c[0] + ',' + c[1] + ',' + c[2] + ',' + _a;
        mat = _revitMatCache[_ck];
        if (!mat) {
          mat = new THREE.MeshPhongMaterial({
            color: new THREE.Color(c[0], c[1], c[2]),
            opacity: _a, transparent: _a < 0.99, side: THREE.DoubleSide
          });
          _revitMatCache[_ck] = mat;
        }
      }
      var mesh = new THREE.Mesh(geom, mat);
      // Placement transform. The Connector should send geometry already in world
      // (shared) coordinates. When it instead sends an element's geometry in a
      // local space (a common Revit pitfall: family-instance symbol geometry, or
      // linked-model elements, without the instance/link transform applied), the
      // element appears "flying" away from the model. If the Connector provides
      // the transform (flat 16-element column-major 4x4 on el.transform /
      // el.geometry.transform), apply it here so placement is corrected client-
      // side; absent it, geometry is used as-is (the Connector must bake world
      // coords — see PropertyExporter geometry extraction).
      var _xf = el.transform || (el.geometry && el.geometry.transform);
      if (_xf && _xf.length === 16) {
        if (!_revitTmpMtx) _revitTmpMtx = new THREE.Matrix4();
        mesh.applyMatrix4(_revitTmpMtx.fromArray(_xf));
      }
      mesh.name = el.globalId || '';
      mesh.userData.expressId = el.expressId || nextId;
      // Bake the mesh for rendering perf (matrixAutoUpdate=false +
      // frustumCulled=false + matrixWorld precomputed). Uses the
      // global helper exposed by index.html so the IFC and Revit
      // load paths stay consistent. Falls back to inlining the same
      // three lines if the helper isn't available yet (e.g. addon
      // loaded before startApp finished).
      if (window._ccBakeMesh) {
        window._ccBakeMesh(mesh);
      } else {
        mesh.updateMatrix();
        mesh.updateMatrixWorld(true);
        mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = false;
      }
      meshes.push(mesh);
      box.copy(geom.boundingBox);
    }
    var mats = el.materials;
    if (Array.isArray(mats)) mats = mats.join(', ');
    // Link-source metadata. Used by _finalizeModel to split a single
    // model-start buffer into multiple ClashControl models, one per
    // linked Revit document. The plugin should tag each element that
    // comes from a linked file with linkName (required, human-readable)
    // and optionally linkDocument / linkInstanceId / linkGuid for more
    // precise grouping when the same RVT is linked multiple times.
    // Absent fields are no-ops — elements from the host model end up
    // ungrouped and stay in the single host ClashControl model.
    var linkName = el.linkName || el.linkDocumentName || null;
    var linkInstanceId = el.linkInstanceId || el.linkInstance || null;
    var linkKey = null;
    if (linkName) {
      linkKey = linkInstanceId ? (linkName + '#' + linkInstanceId) : linkName;
    }
    return {
      expressId: el.expressId || nextId,
      meshes: meshes,
      box: box,
      props: {
        globalId: el.globalId || '',
        ifcType: el.category || 'IfcBuildingElementProxy',
        name: el.name || '',
        description: el.description || '',
        objectType: el.type || '',
        storey: el.level || '',
        material: mats || '',
        quantities: el.quantities || {},
        psets: el.parameters || {},
        revitId: el.revitId || null,
        // Revit's only stable cross-document key (ElementId is doc-local). The
        // Connector must send it; null until then. This is the reliable join key
        // back to a live Revit doc / PDRA.
        uniqueId: el.uniqueId || el.UniqueId || null,
        hostId: el.hostId || null,
        hostRelationships: el.hostRelationships || null,
        linkName: linkName,
        linkInstanceId: linkInstanceId,
        linkKey: linkKey
      }
    };
  }

  // ── Message handler ────────────────────────────────────────────

  function _handleRevitMessage(msg, d) {
    // Debug: log all incoming messages (except high-frequency element-batch)
    if (msg.type !== 'element-batch' && msg.type !== 'pong') {
      console.log('%c[Revit→CC] %s', 'color:#60a5fa', msg.type, msg);
    }
    switch (msg.type) {
      case 'pong':
      case 'status':
        if (msg.projectUniqueId) { try { window._ccRevitProjectUniqueId = msg.projectUniqueId; } catch(_e) {} }
        if (msg.documentName) d({t:'UPD_REVIT_DIRECT', u:{documentName:msg.documentName}});
        if (msg.connected != null) d({t:'UPD_REVIT_DIRECT', u:{connected:msg.connected}});
        // Protocol version negotiation
        if (msg.version && msg.version !== EXPECTED_PROTOCOL_VERSION) {
          var major = msg.version.split('.')[0], expectedMajor = EXPECTED_PROTOCOL_VERSION.split('.')[0];
          if (major !== expectedMajor) {
            d({t:'BRIDGE_LOG', logType:'error', text:'Protocol version mismatch: plugin v' + msg.version + ', expected v' + EXPECTED_PROTOCOL_VERSION + '. Some features may not work correctly.'});
            d({t:'UPD_REVIT_DIRECT', u:{versionWarning:'Plugin v' + msg.version + ' (expected v' + EXPECTED_PROTOCOL_VERSION + ')'}});
          } else {
            d({t:'BRIDGE_LOG', logType:'info', text:'Plugin protocol v' + msg.version + ' (minor mismatch with v' + EXPECTED_PROTOCOL_VERSION + ', should be compatible).'});
          }
        }
        if (msg.version) d({t:'UPD_REVIT_DIRECT', u:{pluginVersion:msg.version}});
        // Connector app version (App.Version) — used to prompt for an update when a
        // newer Connector has been released. Capture it, then check GitHub once.
        if (msg.connectorVersion) {
          d({t:'UPD_REVIT_DIRECT', u:{connectorVersion: msg.connectorVersion}});
          try { _revitCheckConnectorUpdate(d, msg.connectorVersion); } catch(_e) {}
        }
        break;

      case 'model-start':
        if (_revitAborted) break; // user cancelled this export
        if (_isExcluded(msg.name)) { // scoped sync: drop this model — don't mesh it
          _revitBuf = null; // its element-batches/model-end will be skipped (guards check _revitBuf)
          d({t:'BRIDGE_LOG', logType:'info', text:'Skipping excluded model "' + (msg.name||'?') + '" (' + (msg.elementCount||'?') + ' elements).'});
          break;
        }
        var isLink = !!(msg.isLink || msg.isLinked); // connector sends isLinked, bridge expects isLink
        var modelLabel = (isLink ? '[Link] ' : '') + (msg.name || 'Revit Model');
        // Diagnostic: log the full model-start payload so we can see
        // whether the plugin is sending separate model-start events
        // per linked file (preferred) or lumping everything into a
        // single host model-start. If the latter, element-level
        // linkName tagging is required for the split path in
        // _finalizeModel to create separate ClashControl models.
        console.log('%c[Revit→CC] model-start', 'color:#60a5fa;font-weight:bold',
          'name=', msg.name, 'isLink=', isLink,
          'documentName=', msg.documentName, 'elementCount=', msg.elementCount);
        _revitBuf = {
          name: modelLabel,
          rawName: msg.name || 'Revit Model',
          isLink: isLink,
          elements:[], meshes:[],
          count: msg.elementCount || 0,
          received: 0,
          // Document version (Connector) → model.stats → modelInstanceId + freshness.
          docVersion: msg.docVersion || null,
          numberOfSaves: msg.numberOfSaves || 0
        };
        d({t:'UPD_REVIT_DIRECT', u:{loading:true, progress:0, elementCount:msg.elementCount||0}});
        d({t:'BRIDGE_LOG', logType:'pull', text:'Receiving ' + (isLink ? 'linked model' : 'model') + ' "' + msg.name + '" (' + (msg.elementCount||'?') + ' elements)...'});
        break;

      case 'element-batch':
        if (!_revitBuf || _revitAborted) break;
        var nextId = _revitBuf.elements.length + 1;
        (msg.elements || []).forEach(function(el) {
          // Drop datums / spatial containers / markers Revit never shows in 3D —
          // they otherwise show up as stray geometry far from the model and clash.
          if (_revitSkipElement(el)) { _revitBuf.skipped = (_revitBuf.skipped || 0) + 1; return; }
          var converted = _revitElementToMesh(el, nextId++);
          _revitBuf.elements.push(converted);
          converted.meshes.forEach(function(m) { _revitBuf.meshes.push(m); });
        });
        _revitBuf.received += (msg.elements || []).length;
        // Use batchIndex/totalBatches from Connector if available, else fall back to element count
        var prog = msg.totalBatches > 0 ? (msg.batchIndex + 1) / msg.totalBatches
          : _revitBuf.count > 0 ? _revitBuf.received / _revitBuf.count : 0;
        // Throttle the progress dispatch hard. Each dispatch is a full React
        // re-render of the app; firing one per batch (~1600 on an 82k model) is
        // what made the pull take minutes. We cap updates by BOTH whole-percent
        // steps AND a minimum interval (≈3/sec) so the re-render cost stays tiny
        // and constant no matter how fast batches stream in. The bar still moves;
        // it just doesn't repaint the whole app on every frame.
        var _pctNow = Math.round(Math.min(prog, 0.99) * 100);
        var _nowTs = Date.now();
        if (_pctNow !== _revitBuf._lastPct && (_nowTs - (_revitBuf._lastProgTs || 0) >= 300)) {
          _revitBuf._lastPct = _pctNow;
          _revitBuf._lastProgTs = _nowTs;
          d({t:'UPD_REVIT_DIRECT', u:{progress: _pctNow / 100, elementCount: _revitBuf.received}});
        }
        break;

      case 'model-end':
        if (!_revitBuf) break;
        // Handle content-addressable caching: store hashes and process unchanged elements
        if (msg.elementHashes) {
          Object.keys(msg.elementHashes).forEach(function(gid) {
            _elementHashCache[gid] = msg.elementHashes[gid];
          });
        }
        if (msg.unchanged && Array.isArray(msg.unchanged)) {
          // unchanged elements are still valid — keep them, remove anything not in unchanged or batches
          var batchGids = {};
          _revitBuf.elements.forEach(function(el) { if (el.props.globalId) batchGids[el.props.globalId] = true; });
          var unchangedSet = {};
          msg.unchanged.forEach(function(gid) { unchangedSet[gid] = true; });
          // Mark unchanged elements as retained (they stay in the existing model)
          _revitBuf._unchangedGids = unchangedSet;
          _revitBuf._batchGids = batchGids;
        }
        _finalizeModel(msg, d);
        // Persist element hash cache
        try { localStorage.setItem('cc_element_hashes', JSON.stringify(_elementHashCache)); } catch(e) {}
        break;

      case 'model-sync':
        // Revit project was synced to central.
        if (_revitBuf) {
          // If we have a buffer (sync arrived after model-start + batches), finalize it.
          _finalizeModel(msg, d);
        } else {
          // No buffer — connector notified us of a sync. Request updated model.
          d({t:'BRIDGE_LOG', logType:'pull', text:'Revit synced to central. Pulling updated model...'});
          _revitDirectExport(['all']);
        }
        break;

      case 'model-error':
        d({t:'UPD_REVIT_DIRECT', u:{loading:false, progress:0, exportError:msg.message||'Unknown error', exportErrorElementsSent:msg.elementsSent||0}});
        d({t:'BRIDGE_LOG', logType:'error', text:'Export error: ' + (msg.message || 'Unknown') + (msg.elementsSent ? ' (' + msg.elementsSent + ' elements sent)' : '')});
        // Keep partial buffer if elements were sent — user can decide to keep or discard
        if (!msg.elementsSent) _revitBuf = null;
        break;

      case 'push-clashes-ack':
        var ackMsg = (msg.clashesApplied||0) + ' clashes highlighted in Revit';
        if (msg.issuesApplied) ackMsg += ', ' + msg.issuesApplied + ' issues applied';
        if (msg.errors && msg.errors.length) ackMsg += '. Errors: ' + msg.errors.join('; ');
        d({t:'BRIDGE_LOG', logType:'push', text:ackMsg});
        // Surface confirmation to UI as a toast
        d({t:'UPD_REVIT_DIRECT', u:{lastPushAck:ackMsg, lastPushAckTs:Date.now()}});
        break;

      case 'element-update':
        _handleElementUpdate(msg, d);
        _lastElementSync = Date.now();
        d({t:'UPD_REVIT_DIRECT', u:{lastElementSync:_lastElementSync}});
        break;

      case 'selection-changed':
        // Revit → Browser selection sync
        if (!_selectionSyncEnabled) break;
        d({t:'BRIDGE_LOG', logType:'info', text:'Selection from Revit: ' + JSON.stringify(msg.globalIds || msg.elementIds || msg.revitIds || []).slice(0,80)});
        _handleSelectionChanged(msg, d);
        break;

      case 'camera-sync':
        // Revit → Browser camera sync
        if (!_cameraSyncEnabled) break;
        _handleCameraSync(msg);
        break;

      case 'session-expired':
        // Connector cache is empty (Revit restarted) — clear local hashes and do full export
        d({t:'BRIDGE_LOG', logType:'info', text:'Session expired on Revit side — requesting full re-export...'});
        _elementHashCache = {};
        try { localStorage.removeItem('cc_element_hashes'); } catch(e) {}
        setTimeout(function(){ _revitDirectExport(['all']); }, 300);
        break;

      case 'error':
        d({t:'BRIDGE_LOG', logType:'error', text:'Revit: ' + (msg.message || 'Unknown error')});
        break;

      case 'export-start':
        _revitAborted = false; // fresh export — clear any prior cancel
        // Stable Revit project identity (host doc ProjectInformation.UniqueId) so
        // the Smart Bridge can emit a deterministic projectKey ("revit:<uid>")
        // that matches PDRA/Loam for the same open document.
        if (msg.projectUniqueId) { try { window._ccRevitProjectUniqueId = msg.projectUniqueId; } catch(_e) {} }
        d({t:'BRIDGE_LOG', logType:'pull', text:'Export started — ' + (msg.totalModels||1) + ' model(s), ' + (msg.totalElements||'?') + ' elements total'});
        // Single loading-card event for the whole pull (cleared at export-end) —
        // no per-model/per-batch events (those caused the slow-pull regression).
        _revitLoadingEvent(true, 'Receiving model from Revit…');
        break;

      case 'export-end':
        d({t:'BRIDGE_LOG', logType:'pull', text:'Export complete.'});
        _revitLoadingEvent(false);
        break;
    }
  }

  // ── Finalize a received model (add or replace) ─────────────────

  function _finalizeModel(msg, d) {
    // Switch to target project if set (wired from RevitBridgePanel UI)
    var targetProj = window._ccRevitTargetProject;
    var state0 = window._ccLatestState;
    if (targetProj && state0 && state0.activeProject !== targetProj) {
      if (window._switchProject) window._switchProject(targetProj, state0, d);
      else window._ccDispatch({t:'SET_PROJECT', v:targetProj});
    }

    // ── Linked-model split ──────────────────────────────────────
    // If the incoming buffer contains elements from multiple Revit
    // linked files (each tagged with linkKey by _revitElementToMesh),
    // split it into separate sub-models and finalise each one
    // independently so they appear as distinct entries in the Models
    // tab and can be clashed against each other. Elements without a
    // linkKey stay in the host buffer. Single-source buffers (all
    // host, or all from one link) skip this path entirely.
    var _groups = {}; // linkKey → {name, rawName, isLink, elements, meshes, count, received}
    var _hostElements = [], _hostMeshes = [];
    _revitBuf.elements.forEach(function(el) {
      var lk = el.props && el.props.linkKey;
      if (!lk) {
        _hostElements.push(el);
        el.meshes.forEach(function(m) { _hostMeshes.push(m); });
        return;
      }
      if (!_groups[lk]) {
        _groups[lk] = {
          name: '[Link] ' + (el.props.linkName || lk),
          rawName: el.props.linkName || lk,
          isLink: true,
          elements: [],
          meshes: [],
          count: 0,
          received: 0
        };
      }
      _groups[lk].elements.push(el);
      el.meshes.forEach(function(m) { _groups[lk].meshes.push(m); });
    });
    var _groupKeys = Object.keys(_groups);
    if (_groupKeys.length > 0) {
      // Split detected — recurse into _finalizeModelInner for the host
      // (if any) and each link group. Swap _revitBuf for each call so
      // the rest of the finalise logic works on the current group.
      var _origBuf = _revitBuf;
      d({t:'BRIDGE_LOG', logType:'pull', text:'Splitting incoming buffer into ' + (_hostElements.length > 0 ? '1 host + ' : '') + _groupKeys.length + ' linked model(s)'});
      if (_hostElements.length > 0) {
        _revitBuf = {
          name: _origBuf.name,
          rawName: _origBuf.rawName,
          isLink: _origBuf.isLink,
          elements: _hostElements,
          meshes: _hostMeshes,
          count: _hostElements.length,
          received: _hostElements.length,
          _unchangedGids: _origBuf._unchangedGids,
          _batchGids: _origBuf._batchGids
        };
        _finalizeModelInner(msg, d);
      }
      _groupKeys.forEach(function(lk) {
        _revitBuf = _groups[lk];
        _finalizeModelInner(msg, d);
      });
      _revitBuf = null;
      return;
    }
    // No split needed — fall through to the single-model path.
    _finalizeModelInner(msg, d);
  }

  // Discipline from a Revit model name + element category mix. Returns a
  // discipline id or null (caller falls back to the IFC-type detector). Keyword
  // lists cover EN + NL (the common Revit UI languages here).
  function _revitDiscipline(name, elements) {
    var n = (name || '').toLowerCase();
    var STRUCT_N = ['structur', 'struct', 'construct', 'constructie', 'constructief', 'draag'];
    var MEP_N = ['installat', 'mep', 'hvac', 'mechanic', 'electric', 'elektr', 'plumb', 'sanitair', 'leiding', 'kanaal', 'ventilat', 'cv', 'w-install', 'e-install'];
    var ARCH_N = ['architect', 'bouwkund', 'arch', 'interieur'];
    function hit(list) { for (var i = 0; i < list.length; i++) if (n.indexOf(list[i]) >= 0) return true; return false; }
    if (hit(MEP_N)) return 'mep';
    if (hit(STRUCT_N)) return 'structural';
    if (hit(ARCH_N)) return 'architectural';
    // Name inconclusive — vote on Revit category keywords across the elements.
    var STRUCT_C = ['beam', 'column', 'footing', 'foundation', 'framing', 'truss', 'rebar', 'brace', 'pile', 'structural'];
    var MEP_C = ['pipe', 'duct', 'cable', 'conduit', 'mechanical', 'electrical', 'plumbing', 'sprinkler', 'lighting fixture', 'air terminal', 'hvac'];
    var sc = 0, mc = 0;
    (elements || []).forEach(function(el) {
      var t = ((el.props && el.props.ifcType) || '').toLowerCase();
      var i;
      for (i = 0; i < MEP_C.length; i++) if (t.indexOf(MEP_C[i]) >= 0) { mc++; return; }
      for (i = 0; i < STRUCT_C.length; i++) if (t.indexOf(STRUCT_C[i]) >= 0) { sc++; return; }
    });
    var total = (elements || []).length || 1;
    if (mc / total > 0.4 && mc >= sc) return 'mep';
    if (sc / total > 0.4) return 'structural';
    return null; // inconclusive — let the IFC-type detector decide
  }

  function _finalizeModelInner(msg, d) {
    var storeys = msg.storeys || [];
    var storeyData = msg.storeyData || [];
    var relatedPairs = msg.relatedPairs || {};
    // Structural grid reference lines [{name, pts:[x1,z1,x2,z2,...]}] in CC
    // ground-plane metres. Reference data only (overlay + "near grid X" queries),
    // never clashable geometry.
    var gridLines = msg.grids || [];

    // Derive storeys from elements if not provided
    if (storeys.length === 0) {
      var seen = {};
      _revitBuf.elements.forEach(function(el) {
        if (el.props.storey && !seen[el.props.storey]) { storeys.push(el.props.storey); seen[el.props.storey] = true; }
      });
    }

    // Derive relatedPairs from hostId/hostRelationships if not provided
    if (Object.keys(relatedPairs).length === 0) {
      _revitBuf.elements.forEach(function(el) {
        if (el.props.hostId) {
          relatedPairs[el.props.hostId + ':' + el.props.globalId] = true;
        }
        if (el.props.hostRelationships) {
          el.props.hostRelationships.forEach(function(childGid) {
            relatedPairs[el.props.globalId + ':' + childGid] = true;
          });
        }
      });
    }

    // Build revitId → globalId index for deletion fallback
    _revitBuf.elements.forEach(function(el) {
      if (el.props.revitId != null && el.props.globalId) {
        _revitIdIndex[el.props.revitId] = el.props.globalId;
      }
    });

    var detectDiscipline = window._ccDetectDiscipline || function() { return 'architectural'; };
    var DISC = window._ccDISC || [{id:'architectural', c:'#60a5fa'}];

    // Revit-aware discipline tagging. The shared detectDiscipline() matches IFC
    // types, but Revit-direct elements carry Revit *category* names, so it would
    // default everything to "architectural" — which collapses cross-discipline
    // filtering and floods detection with arch-vs-arch false positives. Use the
    // model name first (it usually encodes discipline), then the Revit-category
    // distribution, then fall back to the IFC-type detector.
    var disc = _revitDiscipline(_revitBuf.rawName || _revitBuf.name, _revitBuf.elements) || detectDiscipline(_revitBuf.elements);
    var dObj = DISC.find(function(x){return x.id===disc;});
    var col = dObj ? dObj.c : DISC[0].c;

    // Check if a model with this name already exists (update, don't duplicate)
    var state = window._ccLatestState;
    var mapKey = _revitBuf.rawName;
    var existingId = _revitModelMap[mapKey];
    var existingModel = null;

    if (existingId && state) {
      existingModel = state.models.find(function(m) { return m.id === existingId; });
    }

    // Also search by name + source if map doesn't have it
    if (!existingModel && state) {
      existingModel = state.models.find(function(m) {
        return m.name === _revitBuf.name && m.stats && m.stats.source === 'revit-direct';
      });
    }

    if (existingModel) {
      // Handle delta export: merge unchanged elements from existing model with new batch
      var finalElements = _revitBuf.elements;
      var finalMeshes = _revitBuf.meshes;
      if (_revitBuf._unchangedGids && existingModel.elements) {
        // Keep existing elements that are in the unchanged set
        existingModel.elements.forEach(function(el) {
          if (el.props.globalId && _revitBuf._unchangedGids[el.props.globalId] && !_revitBuf._batchGids[el.props.globalId]) {
            finalElements.push(el);
            el.meshes.forEach(function(m) { finalMeshes.push(m); });
          }
        });
        // Remove elements not in unchanged or batch (they were deleted)
      }

      // REPLACE existing model — keeps same ID, same slot, preserves clash references
      var modelData = {
        id: existingModel.id,
        name: _revitBuf.name,
        rawName: _revitBuf.rawName, // original Revit model name — used by scoped-sync exclude
        discipline: existingModel.discipline || disc,
        color: existingModel.color || col,
        visible: existingModel.visible !== false,
        tag: existingModel.tag || '',
        _version: (existingModel._version || 1) + 1,
        meshes: finalMeshes,
        elements: finalElements,
        storeys: storeys,
        storeyData: storeyData,
        gridLines: gridLines.length ? gridLines : (existingModel.gridLines || []),
        spatialHierarchy: {},
        relatedPairs: relatedPairs,
        stats: {elementCount:finalElements.length, source:'revit-direct', lastSync:Date.now(), docVersion:_revitBuf.docVersion||null, numberOfSaves:_revitBuf.numberOfSaves||0}
      };
      window._ccDispatch({t:'REPLACE_MODEL', id:existingModel.id, v:modelData});
      _revitModelMap[mapKey] = existingModel.id;
      d({t:'BRIDGE_LOG', logType:'pull', text:'Updated model "' + _revitBuf.rawName + '": ' + finalElements.length + ' elements (v' + modelData._version + ').'});
    } else {
      // ADD new model
      var modelId = uid();
      var modelData2 = {
        id: modelId, name: _revitBuf.name, rawName: _revitBuf.rawName, discipline:disc, color:col, visible:true, _version:1,
        meshes:_revitBuf.meshes, elements:_revitBuf.elements, storeys:storeys,
        storeyData:storeyData, gridLines:gridLines, spatialHierarchy:{}, relatedPairs:relatedPairs,
        stats:{elementCount:_revitBuf.elements.length, source:'revit-direct', lastSync:Date.now(), docVersion:_revitBuf.docVersion||null, numberOfSaves:_revitBuf.numberOfSaves||0}
      };
      window._ccDispatch({t:'ADD_MODEL', v:modelData2});
      _revitModelMap[mapKey] = modelId;
      d({t:'BRIDGE_LOG', logType:'pull', text:'Model "' + _revitBuf.rawName + '" loaded: ' + _revitBuf.elements.length + ' elements.'});
    }

    d({t:'UPD_REVIT_DIRECT', u:{loading:false, progress:1}});
    // Rebuild the structural-grid overlay from the freshly-loaded gridLines.
    try { if (window._ccRefreshGridOverlay) window._ccRefreshGridOverlay(); } catch(_e) {}
    // (loading card is cleared at export-end, not here — a federation has several
    // model-ends and we don't want to hide the card between models.)
    _revitBuf = null;
  }

  // ── Incremental element updates ────────────────────────────────

  function _handleElementUpdate(msg, d) {
    var state = window._ccLatestState;
    if (!state) return;

    if (msg.action === 'deleted' && (msg.globalIds || msg.revitIds)) {
      // Remove elements from the model that contains them (match by globalId or revitId)
      // Use revitId→globalId index to resolve revitIds to globalIds first
      var removedCount = 0;
      var gids = {};
      if (msg.globalIds) msg.globalIds.forEach(function(gid) { gids[gid] = true; });
      // Resolve revitIds to globalIds using the index, then fall back to direct revitId match
      var unresolvedRids = {};
      if (msg.revitIds) msg.revitIds.forEach(function(rid) {
        if (_revitIdIndex[rid]) {
          gids[_revitIdIndex[rid]] = true; // resolved via index
        } else {
          unresolvedRids[rid] = true; // fall back to direct match
        }
      });
      state.models.forEach(function(m) {
        if (!m.stats || m.stats.source !== 'revit-direct') return;
        var before = m.elements.length;
        var filtered = m.elements.filter(function(el) {
          return !gids[el.props.globalId] && !unresolvedRids[el.props.revitId];
        });
        if (filtered.length < before) {
          removedCount += (before - filtered.length);
          // Remove meshes from scene and clean up hash cache
          m.elements.forEach(function(el) {
            if (gids[el.props.globalId] || unresolvedRids[el.props.revitId]) {
              el.meshes.forEach(function(mesh) {
                if (mesh.parent) mesh.parent.remove(mesh);
                if (mesh.geometry) mesh.geometry.dispose();
                if (mesh.material) mesh.material.dispose();
              });
              // Clean up caches
              if (el.props.globalId) delete _elementHashCache[el.props.globalId];
              if (el.props.revitId != null) delete _revitIdIndex[el.props.revitId];
            }
          });
          m.elements = filtered;
          m.meshes = [];
          filtered.forEach(function(el) { el.meshes.forEach(function(mesh) { m.meshes.push(mesh); }); });
        }
      });
      d({t:'BRIDGE_LOG', logType:'pull', text:removedCount + ' elements deleted from Revit.'});
      if (window.invalidate) window.invalidate(2);

    } else if (msg.action === 'properties-only' && msg.elements) {
      // Update properties without rebuilding GPU geometry
      var propsCount = 0;
      msg.elements.forEach(function(elData) {
        var gid = elData.globalId;
        if (!gid) return;
        state.models.forEach(function(m) {
          if (!m.stats || m.stats.source !== 'revit-direct') return;
          var idx = m.elements.findIndex(function(el) { return el.props.globalId === gid; });
          if (idx === -1) return;
          var el = m.elements[idx];
          // Merge updated properties, keep existing meshes/geometry untouched
          if (elData.name != null) el.props.name = elData.name;
          if (elData.category != null) el.props.ifcType = elData.category;
          if (elData.type != null) el.props.objectType = elData.type;
          if (elData.level != null) el.props.storey = elData.level;
          if (elData.materials != null) el.props.material = Array.isArray(elData.materials) ? elData.materials.join(', ') : elData.materials;
          if (elData.parameters != null) el.props.psets = elData.parameters;
          if (elData.quantities != null) el.props.quantities = elData.quantities;
          if (elData.description != null) el.props.description = elData.description;
          propsCount++;
        });
      });
      d({t:'BRIDGE_LOG', logType:'pull', text:propsCount + ' element properties updated (no geometry change).'});

    } else if (msg.action === 'modified' && msg.elements) {
      // Replace meshes for modified elements (full geometry + properties)
      var updatedCount = 0;
      msg.elements.forEach(function(elData) {
        var gid = elData.globalId;
        if (!gid) return;
        state.models.forEach(function(m) {
          if (!m.stats || m.stats.source !== 'revit-direct') return;
          var idx = m.elements.findIndex(function(el) { return el.props.globalId === gid; });
          if (idx === -1) return;
          // Dispose old meshes
          var oldEl = m.elements[idx];
          oldEl.meshes.forEach(function(mesh) {
            if (mesh.parent) mesh.parent.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) mesh.material.dispose();
          });
          // Create new element
          var newEl = _revitElementToMesh(elData, oldEl.expressId);
          m.elements[idx] = newEl;
          // Rebuild mesh list
          m.meshes = [];
          m.elements.forEach(function(el) { el.meshes.forEach(function(mesh) { m.meshes.push(mesh); }); });
          // Add new meshes to scene
          var S = window._ccState3d;
          if (S && S.modelGroup) {
            newEl.meshes.forEach(function(mesh) { S.modelGroup.add(mesh); });
          }
          updatedCount++;
        });
      });
      d({t:'BRIDGE_LOG', logType:'pull', text:updatedCount + ' elements updated from Revit.'});
      if (window.invalidate) window.invalidate(2);
    }
  }

  // ── Selection sync (Revit → Browser) ───────────────────────────

  function _handleSelectionChanged(msg, d) {
    var rawIds = msg.globalIds || msg.elementIds || msg.revitIds || [];
    var state = window._ccLatestState;
    if (!state) return;

    // Resolve any revitIds to globalIds using the index
    var globalIds = rawIds.map(function(id) {
      return _revitIdIndex[id] || id; // try revitId lookup, fall back to treating as globalId
    });

    if (globalIds.length === 0) {
      // Deselect — clear highlights
      if (window._unghostAll) window._unghostAll();
      if (window._ccRemoveActiveClashMarker) window._ccRemoveActiveClashMarker();
      d({t:'ACTIVE', id:null});
      return;
    }

    // Find elements matching these globalIds and highlight them
    var expressIds = [];
    state.models.forEach(function(m) {
      (m.elements || []).forEach(function(el) {
        if (globalIds.indexOf(el.props.globalId) >= 0) {
          expressIds.push(el.expressId);
        }
      });
    });

    if (expressIds.length > 0) {
      // Ghost other elements and highlight selected ones
      if (window._ghostOthers) window._ghostOthers(expressIds);
      if (window._highlightById) window._highlightById(expressIds[0], false);
      if (window._flyToElements) window._flyToElements(expressIds);
      if (window.invalidate) window.invalidate(2);
    }

    // Show properties for single selection
    if (globalIds.length === 1) {
      state.models.forEach(function(m) {
        (m.elements || []).forEach(function(el) {
          if (el.props.globalId === globalIds[0]) {
            d({t:'UPD_REVIT_DIRECT', u:{revitSelectedElement:el.props}});
          }
        });
      });
    }
  }

  // ── Camera sync (bidirectional) ───────────────────────────────

  function _handleCameraSync(msg) {
    var S = window._ccState3d;
    if (!S || !S.camera || !S.controls) return;

    var pos = msg.position;
    var tgt = msg.target;
    if (!pos || !tgt) return;

    S.camera.position.set(pos[0], pos[1], pos[2]);
    S.controls.target.set(tgt[0], tgt[1], tgt[2]);
    if (msg.up) S.camera.up.set(msg.up[0], msg.up[1], msg.up[2]);
    if (msg.fov && S.camera.isPerspectiveCamera) {
      S.camera.fov = msg.fov;
      S.camera.updateProjectionMatrix();
    }
    S.controls.update();
    if (window.invalidate) window.invalidate(2);
  }

  function _sendCameraToRevit() {
    if (!_revitWs || _revitWs.readyState !== 1 || !_cameraSyncEnabled) return;
    var S = window._ccState3d;
    if (!S || !S.camera || !S.controls) return;

    var cam = S.camera;
    var tgt = S.controls.target;
    _revitWs.send(JSON.stringify({
      type: 'camera-sync',
      position: [cam.position.x, cam.position.y, cam.position.z],
      target: [tgt.x, tgt.y, tgt.z],
      up: [cam.up.x, cam.up.y, cam.up.z],
      fov: cam.fov || 60
    }));
  }

  // Throttled camera sync sender (max 5/sec = 200ms interval)
  function _throttledCameraSync() {
    if (_cameraSyncThrottleTimer) return;
    _cameraSyncThrottleTimer = setTimeout(function() {
      _cameraSyncThrottleTimer = null;
      _sendCameraToRevit();
    }, 200);
  }

  function _setCameraSyncEnabled(enabled) {
    _cameraSyncEnabled = enabled;
    var S = window._ccState3d;
    if (enabled && S && S.controls) {
      S.controls.addEventListener('change', _throttledCameraSync);
    } else if (!enabled && S && S.controls) {
      S.controls.removeEventListener('change', _throttledCameraSync);
      clearTimeout(_cameraSyncThrottleTimer);
      _cameraSyncThrottleTimer = null;
    }
  }

  function _setSelectionSyncEnabled(enabled) {
    _selectionSyncEnabled = enabled;
  }

  // ── Auto-detect Revit on page load ────────────────────────────

  function _autoDetectRevit(d) {
    // Try a lightweight HTTP fetch to see if Revit plugin is running
    // (avoids opening a real WebSocket which could interfere with the plugin)
    try {
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var opts = {method:'GET', mode:'no-cors'};
      if (controller) { opts.signal = controller.signal; setTimeout(function(){ controller.abort(); }, 2000); }
      fetch('http://localhost:19780', opts).then(function() {
        d({t:'UPD_REVIT_DIRECT', u:{autoDetected:true}});
      }).catch(function() {});
    } catch(e) {}
  }

  // ── Keep partial model from failed export ─────────────────────

  function _keepPartialModel(d) {
    if (!_revitBuf || _revitBuf.elements.length === 0) {
      d({t:'BRIDGE_LOG', logType:'info', text:'No partial data to keep.'});
      _revitBuf = null;
      return;
    }
    d({t:'BRIDGE_LOG', logType:'info', text:'Keeping partial model (' + _revitBuf.elements.length + ' elements).'});
    _finalizeModel({}, d);
  }

  function _discardPartialModel(d) {
    if (_revitBuf) {
      _revitBuf.elements.forEach(function(el) {
        el.meshes.forEach(function(mesh) {
          if (mesh.geometry) mesh.geometry.dispose();
          if (mesh.material) mesh.material.dispose();
        });
      });
    }
    _revitBuf = null;
    d({t:'UPD_REVIT_DIRECT', u:{exportError:null, exportErrorElementsSent:0}});
    d({t:'BRIDGE_LOG', logType:'info', text:'Partial export data discarded.'});
  }

  // ── Push clashes to Revit (manual only) ────────────────────────

  function _revitDirectPushClashes(s, d) {
    if (!_revitWs || _revitWs.readyState !== 1) {
      d({t:'BRIDGE_LOG', logType:'error', text:'Not connected to Revit.'});
      return;
    }
    var clashData = s.clashes.filter(function(c) {
      return c.status === 'open' || c.status === 'confirmed' || c.status === 'in_progress';
    }).map(function(c) {
      var elA = null, elB = null;
      s.models.forEach(function(m) {
        if (!m.elements) return;
        m.elements.forEach(function(el) {
          if (el.expressId === c.elemA) elA = el;
          if (el.expressId === c.elemB) elB = el;
        });
      });
      return {
        id: c.id,
        status: c.status,
        priority: c.priority || 'normal',
        type: c.type || 'hard',
        point: c.point ? {x:c.point.x, y:c.point.y, z:c.point.z} : null,
        elementA: elA ? {globalId:elA.props.globalId, name:elA.props.name, ifcType:elA.props.ifcType, revitId:elA.props.revitId||null} : null,
        elementB: elB ? {globalId:elB.props.globalId, name:elB.props.name, ifcType:elB.props.ifcType, revitId:elB.props.revitId||null} : null
      };
    });
    var issueData = s.issues.filter(function(i) {
      return i.status === 'open' || i.status === 'in_progress';
    }).map(function(i) {
      return {
        id: i.id,
        title: i.title,
        status: i.status,
        priority: i.priority || 'normal',
        description: i.description || '',
        elementIds: (i.elementIds || []).map(function(eid) {
          var found = null;
          s.models.forEach(function(m) { if (m.elements) m.elements.forEach(function(el) { if (el.expressId === eid) found = el; }); });
          return found ? {globalId:found.props.globalId, name:found.props.name, revitId:found.props.revitId||null} : null;
        }).filter(Boolean)
      };
    });
    _revitWs.send(JSON.stringify({
      type:'push-clashes',
      clashes: clashData,
      issues: issueData
    }));
    d({t:'UPD_REVIT_DIRECT', u:{lastPush:Date.now()}});
    d({t:'BRIDGE_LOG', logType:'push', text:'Pushed ' + clashData.length + ' clashes + ' + issueData.length + ' issues to Revit.'});
  }

  // ── Port persistence ───────────────────────────────────────────

  function _saveDirectPort(port) {
    try { localStorage.setItem('cc_revit_direct_port', String(port)); } catch(e) {}
  }
  function _loadDirectPort() {
    try { return parseInt(localStorage.getItem('cc_revit_direct_port'), 10) || 19780; } catch(e) { return 19780; }
  }

  // ── Scoped sync: per-model exclude list ────────────────────────
  // Lets the user drop a heavy linked model (e.g. an 82k MEP file) from the sync
  // so it isn't re-pulled/meshed on every refresh. Excluded models are skipped on
  // receive (no meshing) AND sent to the Connector as modelFilter.exclude so a
  // filter-aware Connector won't even transmit them. Keyed by the model's raw name.
  var _revitExcluded = (function() {
    try { return JSON.parse(localStorage.getItem('cc_revit_excluded') || '[]'); } catch(e) { return []; }
  })();
  function _saveExcluded() { try { localStorage.setItem('cc_revit_excluded', JSON.stringify(_revitExcluded)); } catch(e) {} }
  function _isExcluded(rawName) { return !!rawName && _revitExcluded.indexOf(rawName) !== -1; }
  window._ccRevitExcludeModel = function(rawName) {
    if (rawName && _revitExcluded.indexOf(rawName) === -1) { _revitExcluded.push(rawName); _saveExcluded(); }
  };
  window._ccRevitIncludeModel = function(rawName) {
    var i = _revitExcluded.indexOf(rawName);
    if (i !== -1) { _revitExcluded.splice(i, 1); _saveExcluded(); }
  };
  window._ccRevitGetExcluded = function() { return _revitExcluded.slice(); };

  // ── Expose globally ────────────────────────────────────────────

  // ── Highlight elements in Revit (sent when user selects a clash) ──

  function _revitHighlight(globalIds) {
    if (!_revitWs || _revitWs.readyState !== 1) return;
    _revitWs.send(JSON.stringify({type:'highlight', globalIds: globalIds || []}));
  }

  function _revitClearHighlights() {
    if (!_revitWs || _revitWs.readyState !== 1) return;
    _revitWs.send(JSON.stringify({type:'clear-highlights'}));
  }

  window._revitDirectConnect = _revitDirectConnect;
  window._revitDirectDisconnect = _revitDirectDisconnect;
  // Let the generic load-cancel (LoadProgressCard → _ccAbortLoading) stop a Revit pull too.
  window._ccRevitCancelLoad = _revitDirectCancelExport;
  window._revitDirectExport = _revitDirectExport;
  window._revitDirectCancelExport = _revitDirectCancelExport;
  window._revitDirectPushClashes = _revitDirectPushClashes;
  window._revitHighlight = _revitHighlight;
  window._revitClearHighlights = _revitClearHighlights;
  window._saveDirectPort = _saveDirectPort;
  window._loadDirectPort = _loadDirectPort;
  window._revitGetWs = function() { return _revitWs; };
  window._revitSetCameraSync = _setCameraSyncEnabled;
  window._revitSetSelectionSync = _setSelectionSyncEnabled;
  window._revitAutoDetect = _autoDetectRevit;
  window._revitKeepPartialModel = _keepPartialModel;
  window._revitDiscardPartialModel = _discardPartialModel;

  // ── Auto-reconnect on load / re-enable ─────────────────────────
  // Being active means the user previously enabled the bridge and expects the
  // link restored — the WebSocket connect needs no user gesture, so we rebuild
  // the session automatically and re-pull the model lost on refresh.
  function _revitAutoReconnect(dispatch) {
    if (typeof _revitDirectConnect !== 'function' || !dispatch) return;
    var port = _loadDirectPort();
    window._ccPullOnConnect = true;
    // Show feedback immediately on a hard refresh — the model is about to stream
    // in and the canvas is otherwise blank. Cleared on model-end or on failure.
    _revitLoadingEvent(true, 'Revit: reconnecting…');
    // Defer slightly so React state has fully mounted before we dispatch
    // connection state and logs into it.
    setTimeout(function() {
      try { _revitDirectConnect(port, dispatch); }
      catch(e) { console.warn('[RevitBridge] auto-reconnect failed:', e && e.message || e); }
    }, 150);
  }

  // ── Register addon ─────────────────────────────────────────────

  // Guard per addon convention: the core must define this before the addon loads.
  (typeof window._ccRegisterAddon === 'function' ? window._ccRegisterAddon : function(){})({
    id: 'revit-bridge',
    name: 'Revit Bridge',
    description: 'Live link to Autodesk Revit 2024 / 2025 / 2026 / 2027 via WebSocket. Pull geometry, push clashes. Supports linked models and incremental sync.',
    autoActivate: false,
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/></svg>',

    initState: {
      revitBridge: {
        provider: '',
        apiKey: '',
        mcpHost: 'localhost',
        mcpPort: 8080,
        connected: false,
        syncing: false,
        lastSync: null,
        log: []
      },
      showRevitBridge: false,
      revitDirect: {
        port: 19780,
        connected: false,
        reconnecting: false,
        reconnectIn: 0,
        documentName: '',
        loading: false,
        progress: 0,
        elementCount: 0,
        lastPush: null,
        pluginVersion: null,
        versionWarning: null,
        reconnectPrompt: false,
        autoDetected: false,
        exportError: null,
        exportErrorElementsSent: 0,
        lastPushAck: null,
        lastPushAckTs: null,
        lastElementSync: 0,
        cameraSyncEnabled: false,
        selectionSyncEnabled: true,
        revitSelectedElement: null
      }
    },

    reducerCases: {
      'UPD_BRIDGE': function(s, a) {
        return Object.assign({}, s, {revitBridge: Object.assign({}, s.revitBridge||{}, a.u)});
      },
      'BRIDGE_LOG': function(s, a) {
        var br = s.revitBridge || {log:[]};
        return Object.assign({}, s, {revitBridge: Object.assign({}, br, {
          log: (br.log||[]).concat([{ts:Date.now(), type:a.logType||'info', text:a.text}]).slice(-100)
        })});
      },
      'CLEAR_BRIDGE_LOG': function(s) {
        var br = s.revitBridge || {log:[]};
        return Object.assign({}, s, {revitBridge: Object.assign({}, br, {log:[]})});
      },
      'REVIT_BRIDGE': function(s, a) {
        return Object.assign({}, s, {showRevitBridge: a.v});
      },
      'UPD_REVIT_DIRECT': function(s, a) {
        return Object.assign({}, s, {revitDirect: Object.assign({}, s.revitDirect||{}, a.u)});
      }
    },

    init: function(dispatch, getState, opts) {
      // Only auto-reconnect on a genuine page-reload restore (restored:true) or
      // when the previous session was actively connected — NOT on a plain manual
      // activate/open, where the Revit Bridge dialog drives the connect explicitly.
      if (opts && opts.restored) _revitAutoReconnect(dispatch);
    },

    destroy: function() {
      _revitUserDisconnected = true;
      clearTimeout(_revitReconnect);
      clearTimeout(_revitConnectTimeout);
      _resetReconnectDelay();
      if (_revitWs) {
        try { _revitWs.onopen = _revitWs.onclose = _revitWs.onerror = _revitWs.onmessage = null; } catch(_) {}
        try { _revitWs.close(); } catch(_) {}
        _revitWs = null;
      }
      _revitBuf = null;
    }
  });

  // ── Part 2: AI Bridge (LLM-powered MCP integration) ────────────
  // Uses BYOK (Bring Your Own Key) to call Anthropic/OpenAI/Google APIs
  // with tool definitions. Orchestrates push/pull between CC and Revit MCP.

  // Persist bridge config — non-sensitive fields in localStorage; apiKey kept in memory only
  var _bridgeApiKeyMem = '';
  function _saveBridgeConfig(bridge) {
    try {
      localStorage.setItem('cc_revit_bridge', JSON.stringify({
        provider: bridge.provider,
        mcpHost: bridge.mcpHost,
        mcpPort: bridge.mcpPort
      }));
    } catch(e) {}
    _bridgeApiKeyMem = (bridge && bridge.apiKey) ? bridge.apiKey : '';
  }
  function _loadBridgeConfig() {
    try {
      var raw = localStorage.getItem('cc_revit_bridge');
      var cfg = raw ? JSON.parse(raw) : null;
      if (cfg) cfg.apiKey = _bridgeApiKeyMem || '';
      return cfg;
    } catch(e) { return null; }
  }

  // Build tool definitions that expose ClashControl data to the AI
  function _buildCCTools() {
    return [
      {
        name: 'get_clashes',
        description: 'Get all clash detection results from ClashControl.',
        parameters: { type: 'object', properties: { status: { type: 'string', enum: ['all','open','resolved','closed'], description: 'Filter by status' } } }
      },
      {
        name: 'get_issues',
        description: 'Get all issues from ClashControl.',
        parameters: { type: 'object', properties: { status: { type: 'string', enum: ['all','open','in_progress','resolved','closed'], description: 'Filter by status' } } }
      },
      {
        name: 'update_clash_status',
        description: 'Update the status of a clash in ClashControl.',
        parameters: { type: 'object', properties: { clash_id: { type: 'string' }, status: { type: 'string', enum: ['open','resolved','closed'] }, comment: { type: 'string' } }, required: ['clash_id','status'] }
      },
      {
        name: 'update_issue_status',
        description: 'Update the status of an issue in ClashControl.',
        parameters: { type: 'object', properties: { issue_id: { type: 'string' }, status: { type: 'string', enum: ['open','in_progress','resolved','closed'] }, comment: { type: 'string' } }, required: ['issue_id','status'] }
      },
      {
        name: 'push_to_revit',
        description: 'Push clash/issue data to Revit via MCP.',
        parameters: { type: 'object', properties: { item_ids: { type: 'array', items: { type: 'string' } } } }
      },
      {
        name: 'pull_from_revit',
        description: 'Pull resolution status from Revit via MCP.',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'get_revit_status',
        description: 'Check if Revit MCP server is running.',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'analyze_clashes',
        description: 'Analyze clash detection results: statistics, patterns, hotspots.',
        parameters: { type: 'object', properties: {} }
      },
      {
        name: 'suggest_resolution',
        description: 'Get resolution suggestions for a clash.',
        parameters: { type: 'object', properties: { clash_id: { type: 'string' } } }
      },
      {
        name: 'generate_report',
        description: 'Generate a coordination report.',
        parameters: { type: 'object', properties: { format: { type: 'string', enum: ['summary','detailed','discipline'] } } }
      },
      {
        name: 'batch_update_status',
        description: 'Batch update status of multiple clashes or issues.',
        parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['open','in_progress','resolved','closed'] }, item_type: { type: 'string', enum: ['clash','issue'] } }, required: ['ids','status','item_type'] }
      },
      {
        name: 'batch_assign',
        description: 'Batch assign multiple issues to a person.',
        parameters: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, assignee: { type: 'string' } }, required: ['ids','assignee'] }
      }
    ];
  }

  // Execute a tool call from the AI response
  function _executeCCTool(name, args, s, d) {
    switch(name) {
      case 'get_clashes': {
        var items = s.clashes;
        if (args.status && args.status !== 'all') items = items.filter(function(c) { return c.status === args.status; });
        return JSON.stringify(items.map(function(c) {
          return { id:c.id, type:c.type, status:c.status, title:c.title, elemAName:c.elemAName, elemBName:c.elemBName,
            elemAType:c.elemAType, elemBType:c.elemBType, point:c.point, distance:c.distance, elevation:c.elevation,
            elemAStorey:c.elemAStorey, elemBStorey:c.elemBStorey, disciplines:c.disciplines };
        }));
      }
      case 'get_issues': {
        var items2 = s.issues;
        if (args.status && args.status !== 'all') items2 = items2.filter(function(i) { return i.status === args.status; });
        return JSON.stringify(items2.map(function(i) {
          return { id:i.id, type:i.type, status:i.status, title:i.title, priority:i.priority, category:i.category,
            assignee:i.assignee, elementName:i.elementName, elementType:i.elementType, point:i.point, storey:i.storey };
        }));
      }
      case 'update_clash_status': {
        if (args.clash_id && args.status) {
          var upd = { status: args.status };
          if (args.comment) upd.description = args.comment;
          d({ t:'UPD_CLASH', id:args.clash_id, u:upd });
          return JSON.stringify({ success:true, id:args.clash_id, newStatus:args.status });
        }
        return JSON.stringify({ success:false, error:'Missing clash_id or status' });
      }
      case 'update_issue_status': {
        if (args.issue_id && args.status) {
          var upd2 = { status: args.status };
          if (args.comment) upd2.description = args.comment;
          d({ t:'UPD_ISSUE', id:args.issue_id, u:upd2 });
          return JSON.stringify({ success:true, id:args.issue_id, newStatus:args.status });
        }
        return JSON.stringify({ success:false, error:'Missing issue_id or status' });
      }
      case 'push_to_revit':
        return JSON.stringify({ action:'forward_to_revit_mcp', tool:'place_family', note:'AI should call Revit MCP tools to place markers' });
      case 'pull_from_revit':
        return JSON.stringify({ action:'forward_to_revit_mcp', tool:'get_revit_model_info', note:'AI should query Revit MCP for element status' });
      case 'get_revit_status':
        return JSON.stringify({ action:'forward_to_revit_mcp', tool:'get_revit_status', note:'AI should call Revit MCP get_revit_status' });
      case 'analyze_clashes': {
        var clashes = s.clashes;
        var total = clashes.length;
        var byStatus = {}; clashes.forEach(function(c){ byStatus[c.status] = (byStatus[c.status]||0)+1; });
        var byType = {}; clashes.forEach(function(c){ byType[c.type] = (byType[c.type]||0)+1; });
        var byStorey = {}; clashes.forEach(function(c){
          var st = c.elemAStorey || c.elemBStorey || 'Unknown';
          byStorey[st] = (byStorey[st]||0)+1;
        });
        var byDisc = {}; clashes.forEach(function(c){
          if(c.disciplines) c.disciplines.forEach(function(dd){ byDisc[dd]=(byDisc[dd]||0)+1; });
        });
        var hotStorey = Object.keys(byStorey).sort(function(a,b){return byStorey[b]-byStorey[a];})[0]||'N/A';
        var typePairs = {}; clashes.forEach(function(c){
          var pair = [c.elemAType||'?',c.elemBType||'?'].sort().join(' vs ');
          typePairs[pair] = (typePairs[pair]||0)+1;
        });
        var topPairs = Object.keys(typePairs).sort(function(a,b){return typePairs[b]-typePairs[a];}).slice(0,5);
        return JSON.stringify({ total:total, byStatus:byStatus, byType:byType, byStorey:byStorey, byDiscipline:byDisc,
          hotspotStorey:hotStorey, hotspotCount:byStorey[hotStorey]||0,
          topElementTypePairs:topPairs.map(function(p){return {pair:p,count:typePairs[p]};})
        });
      }
      case 'suggest_resolution': {
        var target = args.clash_id ? s.clashes.filter(function(c){return c.id===args.clash_id;}) : s.clashes.filter(function(c){return c.status==='open';}).slice(0,5);
        return JSON.stringify(target.map(function(c){
          return { id:c.id, type:c.type, elemAType:c.elemAType, elemBType:c.elemBType, elemAName:c.elemAName, elemBName:c.elemBName,
            elemAStorey:c.elemAStorey, distance:c.distance, disciplines:c.disciplines,
            context:'Provide resolution suggestions based on these element types, disciplines, and spatial relationship.' };
        }));
      }
      case 'generate_report': {
        var fmt = args.format || 'summary';
        var cl = s.clashes, is = s.issues;
        var data = { format:fmt, totalClashes:cl.length, totalIssues:is.length,
          clashBreakdown:{ open:cl.filter(function(c){return c.status==='open';}).length, resolved:cl.filter(function(c){return c.status==='resolved'||c.status==='closed';}).length, hard:cl.filter(function(c){return c.type==='hard';}).length, soft:cl.filter(function(c){return c.type==='soft';}).length },
          issueBreakdown:{ open:is.filter(function(i){return i.status==='open';}).length, inProgress:is.filter(function(i){return i.status==='in_progress';}).length, resolved:is.filter(function(i){return i.status==='resolved'||i.status==='closed';}).length }
        };
        if (fmt === 'detailed' || fmt === 'discipline') {
          var discData = {};
          cl.forEach(function(c){ (c.disciplines||[]).forEach(function(dd){ if(!discData[dd])discData[dd]={total:0,open:0,hard:0}; discData[dd].total++; if(c.status==='open')discData[dd].open++; if(c.type==='hard')discData[dd].hard++; }); });
          data.byDiscipline = discData;
        }
        return JSON.stringify(data);
      }
      case 'batch_update_status': {
        if (args.ids && args.status && args.item_type) {
          var actionType = args.item_type === 'clash' ? 'UPD_CLASH' : 'UPD_ISSUE';
          args.ids.forEach(function(id) { d({ t:actionType, id:id, u:{status:args.status} }); });
          return JSON.stringify({ success:true, updated:args.ids.length, newStatus:args.status });
        }
        return JSON.stringify({ success:false, error:'Missing ids, status, or item_type' });
      }
      case 'batch_assign': {
        if (args.ids && args.assignee) {
          args.ids.forEach(function(id) { d({ t:'UPD_ISSUE', id:id, u:{assignee:args.assignee} }); });
          return JSON.stringify({ success:true, assigned:args.ids.length, assignee:args.assignee });
        }
        return JSON.stringify({ success:false, error:'Missing ids or assignee' });
      }
      default:
        return JSON.stringify({ error:'Unknown tool: ' + name });
    }
  }

  // Call AI API with tools (supports Anthropic, OpenAI, Google)
  function _callAIWithTools(provider, apiKey, systemPrompt, userMessage, tools, mcpConfig) {
    var toolDefs = tools.map(function(t) {
      if (provider === 'anthropic') {
        return { name:t.name, description:t.description, input_schema:t.parameters };
      } else if (provider === 'openai') {
        return { type:'function', function:{ name:t.name, description:t.description, parameters:t.parameters } };
      } else {
        return { name:t.name, description:t.description, parameters:t.parameters };
      }
    });

    var mcpNote = '\n\nRevit MCP server is available at ' + mcpConfig.mcpHost + ':' + mcpConfig.mcpPort + '. When you need to interact with Revit, describe the MCP tool calls needed (place_family, set_element_parameter, etc.) in your response.';

    if (provider === 'anthropic') {
      return fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          'x-api-key':apiKey,
          'anthropic-version':'2023-06-01',
          'anthropic-dangerous-direct-browser-access':'true'
        },
        body:JSON.stringify({
          model:'claude-sonnet-4-20250514',
          max_tokens:4096,
          system:systemPrompt + mcpNote,
          messages:[{role:'user',content:userMessage}],
          tools:toolDefs
        })
      }).then(function(r) { return r.json(); });
    } else if (provider === 'openai') {
      return fetch('https://api.openai.com/v1/chat/completions', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+apiKey },
        body:JSON.stringify({
          model:'gpt-4o',
          messages:[{role:'system',content:systemPrompt+mcpNote},{role:'user',content:userMessage}],
          tools:toolDefs,
          tool_choice:'auto'
        })
      }).then(function(r) { return r.json(); });
    } else if (provider === 'google') {
      return fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key='+apiKey, {
        method:'POST',
        headers:{ 'Content-Type':'application/json' },
        body:JSON.stringify({
          system_instruction:{parts:[{text:systemPrompt+mcpNote}]},
          contents:[{role:'user',parts:[{text:userMessage}]}],
          tools:[{function_declarations:toolDefs}]
        })
      }).then(function(r) { return r.json(); });
    }
    return Promise.reject(new Error('Unknown provider: '+provider));
  }

  // Parse tool calls from AI response (normalize across providers)
  function _parseAIToolCalls(provider, response) {
    var text = '';
    var toolCalls = [];
    if (provider === 'anthropic') {
      (response.content || []).forEach(function(block) {
        if (block.type === 'text') text += block.text;
        if (block.type === 'tool_use') toolCalls.push({ id:block.id, name:block.name, args:block.input||{} });
      });
    } else if (provider === 'openai') {
      var choice = (response.choices||[])[0]||{};
      var msg = choice.message||{};
      text = msg.content||'';
      (msg.tool_calls||[]).forEach(function(tc) {
        var fn = tc.function||{};
        try { toolCalls.push({ id:tc.id, name:fn.name, args:JSON.parse(fn.arguments||'{}') }); } catch(e) { console.warn('[RevitBridge] Bad tool_call arguments:', fn.arguments); }
      });
    } else if (provider === 'google') {
      var parts = ((response.candidates||[])[0]||{}).content||{};
      (parts.parts||[]).forEach(function(p) {
        if (p.text) text += p.text;
        if (p.functionCall) toolCalls.push({ id:uid(), name:p.functionCall.name, args:p.functionCall.args||{} });
      });
    }
    return { text:text, toolCalls:toolCalls };
  }

  var BRIDGE_SYSTEM_PROMPT = 'You are the ClashControl-Revit Bridge AI. Your job is to help sync clash detection data and issues between ClashControl (a web-based BIM clash detection tool) and Autodesk Revit (via MCP server).\n\n' +
    'You have tools to read clashes and issues from ClashControl, update their statuses, and coordinate with Revit MCP.\n\n' +
    'When pushing clashes to Revit:\n1. Read open clashes from ClashControl using get_clashes\n2. For each clash, describe what Revit MCP calls are needed\n3. Summarize what was pushed\n\n' +
    'When pulling status from Revit:\n1. Query Revit MCP for elements tagged with CC_ClashID parameters\n2. Check if geometries have changed\n3. Update ClashControl clash statuses using update_clash_status\n4. Summarize what changed\n\nBe concise. Use tool calls. Report results clearly.';

  // High-level push/pull orchestration
  function _revitBridgePush(s, d) {
    var bridge = s.revitBridge;
    if (!bridge.provider || !bridge.apiKey) return Promise.reject(new Error('Configure AI provider and API key first'));

    d({t:'UPD_BRIDGE',u:{syncing:true}});
    d({t:'BRIDGE_LOG',logType:'push',text:'Pushing ' + s.clashes.filter(function(c){return c.status==='open';}).length + ' open clashes + ' + s.issues.filter(function(i){return i.status==='open';}).length + ' open issues to Revit...'});

    var tools = _buildCCTools();
    var userMsg = 'Push all open clashes and issues from ClashControl to Revit. First use get_clashes and get_issues to read the data, then describe the Revit MCP calls needed to create markers and tag elements. Finally summarize what would be pushed.';

    return _callAIWithTools(bridge.provider, bridge.apiKey, BRIDGE_SYSTEM_PROMPT, userMsg, tools, bridge)
      .then(function(response) {
        var parsed = _parseAIToolCalls(bridge.provider, response);
        var toolResults = parsed.toolCalls.map(function(tc) {
          return { id:tc.id, name:tc.name, result:_executeCCTool(tc.name, tc.args, s, d) };
        });
        var summary = parsed.text || 'Push completed.';
        if (toolResults.length) {
          summary += '\n\nTool calls executed: ' + toolResults.map(function(tr){ return tr.name; }).join(', ');
        }
        d({t:'BRIDGE_LOG',logType:'push',text:summary});
        d({t:'UPD_BRIDGE',u:{syncing:false,lastSync:Date.now()}});
        return summary;
      })
      .catch(function(err) {
        d({t:'BRIDGE_LOG',logType:'error',text:'Push failed: '+err.message});
        d({t:'UPD_BRIDGE',u:{syncing:false}});
        throw err;
      });
  }

  function _revitBridgePull(s, d) {
    var bridge = s.revitBridge;
    if (!bridge.provider || !bridge.apiKey) return Promise.reject(new Error('Configure AI provider and API key first'));

    d({t:'UPD_BRIDGE',u:{syncing:true}});
    d({t:'BRIDGE_LOG',logType:'pull',text:'Pulling status updates from Revit...'});

    var tools = _buildCCTools();
    var userMsg = 'Pull resolution status from Revit back to ClashControl. First check Revit MCP status, then check which clashes have been resolved in Revit, and update ClashControl accordingly using update_clash_status and update_issue_status tools.';

    return _callAIWithTools(bridge.provider, bridge.apiKey, BRIDGE_SYSTEM_PROMPT, userMsg, tools, bridge)
      .then(function(response) {
        var parsed = _parseAIToolCalls(bridge.provider, response);
        parsed.toolCalls.forEach(function(tc) {
          _executeCCTool(tc.name, tc.args, s, d);
        });
        var summary = parsed.text || 'Pull completed.';
        d({t:'BRIDGE_LOG',logType:'pull',text:summary});
        d({t:'UPD_BRIDGE',u:{syncing:false,lastSync:Date.now()}});
        return summary;
      })
      .catch(function(err) {
        d({t:'BRIDGE_LOG',logType:'error',text:'Pull failed: '+err.message});
        d({t:'UPD_BRIDGE',u:{syncing:false}});
        throw err;
      });
  }

  function _testBridgeConnection(bridge, d) {
    d({t:'BRIDGE_LOG',logType:'info',text:'Testing connection to '+bridge.provider+'...'});
    var tools = _buildCCTools();
    return _callAIWithTools(bridge.provider, bridge.apiKey, BRIDGE_SYSTEM_PROMPT, 'Say "Connection successful" and nothing else.', tools.slice(0,1), bridge)
      .then(function(response) {
        var parsed = _parseAIToolCalls(bridge.provider, response);
        d({t:'UPD_BRIDGE',u:{connected:true}});
        d({t:'BRIDGE_LOG',logType:'info',text:'Connected to '+bridge.provider+': '+(parsed.text||'OK')});
        return true;
      })
      .catch(function(err) {
        d({t:'UPD_BRIDGE',u:{connected:false}});
        d({t:'BRIDGE_LOG',logType:'error',text:'Connection failed: '+err.message});
        return false;
      });
  }

  // Expose AI bridge functions globally
  window._saveBridgeConfig = _saveBridgeConfig;
  window._loadBridgeConfig = _loadBridgeConfig;
  window._revitBridgePush = _revitBridgePush;
  window._revitBridgePull = _revitBridgePull;
  window._testBridgeConnection = _testBridgeConnection;

  // ── Deferred init fallback ─────────────────────────────────────
  // React 18 (createRoot) schedules its first render asynchronously, so on a
  // hard refresh this cached addon can register BEFORE window._ccDispatch is
  // set — in which case _ccRegisterAddon skips init() and the live link is
  // never auto-restored. Poll until dispatch is ready and run the reconnect
  // ourselves. (_revitDirectConnect guards against a duplicate live socket.)
  (function() {
    if (window._ccDispatch) return; // dispatch was ready — _ccRegisterAddon already called init
    if (!window._ccIsAddonActive || !window._ccIsAddonActive('revit-bridge')) return; // not active
    var _t = setInterval(function() {
      if (window._ccDispatch) {
        clearInterval(_t);
        if (window._ccIsAddonActive('revit-bridge')) {
          console.log('[RevitBridge] Deferred init (dispatch was not ready at register time)');
          _revitAutoReconnect(window._ccDispatch);
        }
      }
    }, 20);
  })();
})();
