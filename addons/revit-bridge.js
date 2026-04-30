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
  var _revitReconnect = null;
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

  // ── WebSocket connection ───────────────────────────────────────

  function _revitDirectConnect(port, d) {
    if (_revitWs && _revitWs.readyState <= 1) { _revitWs.close(); }
    clearTimeout(_revitReconnect);
    _revitLastPort = port || 19780;
    _revitLastDispatch = d;
    _revitUserDisconnected = false;
    var url = 'ws://localhost:' + _revitLastPort;
    d({t:'BRIDGE_LOG', logType:'info', text:'Connecting to Revit at ' + url + '...'});
    d({t:'UPD_REVIT_DIRECT', u:{connected:false, loading:false, progress:0, reconnecting:false}});
    try { _revitWs = new WebSocket(url); } catch(e) {
      d({t:'BRIDGE_LOG', logType:'error', text:'WebSocket error: ' + e.message});
      _scheduleReconnect();
      return;
    }
    _revitWs.binaryType = 'arraybuffer';

    _revitWs.onopen = function() {
      var wasReconnect = _revitReconnectDelay > 0;
      _resetReconnectDelay();
      d({t:'UPD_REVIT_DIRECT', u:{connected:true, reconnecting:false}});
      d({t:'BRIDGE_LOG', logType:'info', text:wasReconnect ? 'Reconnected to Revit plugin.' : 'Connected to Revit plugin.'});
      _revitWs.send(JSON.stringify({type:'ping'}));
      // Auto-pull on first user-initiated connect
      if (_pullOnConnect || window._ccPullOnConnect) {
        _pullOnConnect = false;
        window._ccPullOnConnect = false;
        d({t:'BRIDGE_LOG', logType:'pull', text:'Auto-pulling model...'});
        setTimeout(function(){ _revitDirectExport(['all']); }, 300);
      }
      // On reconnect, let the connector decide what to sync.
    };

    _revitWs.onclose = function() {
      d({t:'UPD_REVIT_DIRECT', u:{connected:false, loading:false}});
      d({t:'BRIDGE_LOG', logType:'info', text:'Revit connection closed.'});
      _revitWs = null;
      _scheduleReconnect();
    };

    _revitWs.onerror = function() {
      d({t:'UPD_REVIT_DIRECT', u:{connected:false, loading:false}});
      // Only log error if not already reconnecting (avoid spam)
      if (!_revitReconnectDelay) d({t:'BRIDGE_LOG', logType:'error', text:'Could not connect to Revit. Is the plugin running?'});
      _revitWs = null;
      // onclose will also fire and trigger reconnect
    };

    _revitWs.onmessage = function(ev) {
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
    _resetReconnectDelay();
    if (_revitWs) { _revitWs.close(); _revitWs = null; }
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
    if (modelFilter) msg.modelFilter = modelFilter;
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
    if (!_revitWs || _revitWs.readyState !== 1) return;
    _revitWs.send(JSON.stringify({type:'cancel-export'}));
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
      geom.computeBoundingBox();
      var c = el.geometry.color || [0.65, 0.65, 0.65, 1.0];
      var mat = new THREE.MeshPhongMaterial({
        color: new THREE.Color(c[0], c[1], c[2]),
        opacity: c[3] != null ? c[3] : 1,
        transparent: c[3] != null && c[3] < 0.99,
        side: THREE.DoubleSide
      });
      var mesh = new THREE.Mesh(geom, mat);
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
      console.log('%c[Revit→CC] ' + msg.type, 'color:#60a5fa', msg);
    }
    switch (msg.type) {
      case 'pong':
      case 'status':
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
        break;

      case 'model-start':
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
          received: 0
        };
        d({t:'UPD_REVIT_DIRECT', u:{loading:true, progress:0, elementCount:msg.elementCount||0}});
        d({t:'BRIDGE_LOG', logType:'pull', text:'Receiving ' + (isLink ? 'linked model' : 'model') + ' "' + msg.name + '" (' + (msg.elementCount||'?') + ' elements)...'});
        break;

      case 'element-batch':
        if (!_revitBuf) break;
        var nextId = _revitBuf.elements.length + 1;
        (msg.elements || []).forEach(function(el) {
          var converted = _revitElementToMesh(el, nextId++);
          _revitBuf.elements.push(converted);
          converted.meshes.forEach(function(m) { _revitBuf.meshes.push(m); });
        });
        _revitBuf.received += (msg.elements || []).length;
        // Use batchIndex/totalBatches from Connector if available, else fall back to element count
        var prog = msg.totalBatches > 0 ? (msg.batchIndex + 1) / msg.totalBatches
          : _revitBuf.count > 0 ? _revitBuf.received / _revitBuf.count : 0;
        d({t:'UPD_REVIT_DIRECT', u:{progress: Math.min(prog, 0.99), elementCount: _revitBuf.received}});
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
        // Connector reports session expired — it will re-push a full model when ready
        d({t:'BRIDGE_LOG', logType:'info', text:'Session expired on Revit side. Connector will re-export when ready.'});
        break;

      case 'error':
        d({t:'BRIDGE_LOG', logType:'error', text:'Revit: ' + (msg.message || 'Unknown error')});
        break;

      case 'export-start':
        d({t:'BRIDGE_LOG', logType:'pull', text:'Export started — ' + (msg.totalModels||1) + ' model(s), ' + (msg.totalElements||'?') + ' elements total'});
        break;

      case 'export-end':
        d({t:'BRIDGE_LOG', logType:'pull', text:'Export complete.'});
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

  function _finalizeModelInner(msg, d) {
    var storeys = msg.storeys || [];
    var storeyData = msg.storeyData || [];
    var relatedPairs = msg.relatedPairs || {};

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

    var disc = detectDiscipline(_revitBuf.elements);
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
        discipline: existingModel.discipline || disc,
        color: existingModel.color || col,
        visible: existingModel.visible !== false,
        tag: existingModel.tag || '',
        _version: (existingModel._version || 1) + 1,
        meshes: finalMeshes,
        elements: finalElements,
        storeys: storeys,
        storeyData: storeyData,
        spatialHierarchy: {},
        relatedPairs: relatedPairs,
        stats: {elementCount:finalElements.length, source:'revit-direct', lastSync:Date.now()}
      };
      window._ccDispatch({t:'REPLACE_MODEL', id:existingModel.id, v:modelData});
      _revitModelMap[mapKey] = existingModel.id;
      d({t:'BRIDGE_LOG', logType:'pull', text:'Updated model "' + _revitBuf.rawName + '": ' + finalElements.length + ' elements (v' + modelData._version + ').'});
    } else {
      // ADD new model
      var modelId = uid();
      var modelData2 = {
        id: modelId, name: _revitBuf.name, discipline:disc, color:col, visible:true, _version:1,
        meshes:_revitBuf.meshes, elements:_revitBuf.elements, storeys:storeys,
        storeyData:storeyData, spatialHierarchy:{}, relatedPairs:relatedPairs,
        stats:{elementCount:_revitBuf.elements.length, source:'revit-direct', lastSync:Date.now()}
      };
      window._ccDispatch({t:'ADD_MODEL', v:modelData2});
      _revitModelMap[mapKey] = modelId;
      d({t:'BRIDGE_LOG', logType:'pull', text:'Model "' + _revitBuf.rawName + '" loaded: ' + _revitBuf.elements.length + ' elements.'});
    }

    d({t:'UPD_REVIT_DIRECT', u:{loading:false, progress:1}});
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

  // ── Register addon ─────────────────────────────────────────────

  window._ccRegisterAddon({
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

    init: function(dispatch, getState) {
      // Auto-reconnect on page load / re-enable. Being active at this
      // moment means the user previously enabled the bridge and expects
      // the link to be restored — the WebSocket connect doesn't need a
      // user gesture, so we can rebuild the session automatically and
      // re-pull the model that was lost when the page refreshed.
      if (typeof _revitDirectConnect !== 'function') return;
      var port = _loadDirectPort();
      window._ccPullOnConnect = true;
      // Defer slightly so React state has fully mounted before we start
      // dispatching connection state and logs into it.
      setTimeout(function() {
        try { _revitDirectConnect(port, dispatch); }
        catch(e) { console.warn('[RevitBridge] auto-reconnect failed:', e && e.message || e); }
      }, 150);
    },

    destroy: function() {
      _revitUserDisconnected = true;
      clearTimeout(_revitReconnect);
      _resetReconnectDelay();
      if (_revitWs) { _revitWs.close(); _revitWs = null; }
      _revitBuf = null;
    }
  });

  // ── Part 2: AI Bridge (LLM-powered MCP integration) ────────────
  // Uses BYOK (Bring Your Own Key) to call Anthropic/OpenAI/Google APIs
  // with tool definitions. Orchestrates push/pull between CC and Revit MCP.

  // Persist bridge config to localStorage
  function _saveBridgeConfig(bridge) {
    try {
      localStorage.setItem('cc_revit_bridge', JSON.stringify({
        provider: bridge.provider,
        apiKey: bridge.apiKey,
        mcpHost: bridge.mcpHost,
        mcpPort: bridge.mcpPort
      }));
    } catch(e) {}
  }
  function _loadBridgeConfig() {
    try {
      var raw = localStorage.getItem('cc_revit_bridge');
      return raw ? JSON.parse(raw) : null;
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
})();
