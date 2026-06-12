// ── ClashControl Addon: 3D Tiles world context ──────────────────
// Streams Google Photorealistic 3D Tiles (or any Cesium-style 3D Tiles
// tileset) into the scene UNDER the loaded IFC models, georeferenced via
// the same lat/lon the geoplace addon uses. NASA-AMMOS 3DTilesRendererJS,
// ESM-loaded on demand — its bare `three` import resolves through the
// page's import map, so it shares the core r180 instance (the splat
// addon precedent). The IFC never moves: the planet is transformed so
// the anchor lat/lon sits at the scene origin, Y-up.
//
// Public API:
//   window._ccLoadTiles3D({ key, lat, lon, height })  → Promise
//   window._ccUnloadTiles3D()
//   window._ccTiles3DActive()
(function() {
  'use strict';

  var TILES_CDN = 'https://cdn.jsdelivr.net/npm/3d-tiles-renderer@0.4.28';
  var _tiles = null;
  var _frameHandler = null;
  var _pump = null;       // keeps frames ticking while tiles are streaming
  var _tilesCam = null;   // proxy camera with clamped far plane = context range
  var _anchorFrame = null, _anchorOrigin = null, _north = 0;
  var _offset = { x: 0, z: 0 }; // world XZ alignment nudge (metres) — shared with the geoplace basemap
  // Vertical placement (metres), tiles-ONLY. The basemap is a flat plane
  // pinned to the model floor, so it never needs height correction; the 3D
  // context does — PDOK heights are ellipsoidal (NAP ≈ ellipsoid − ~43 m)
  // and the geoid offset varies by location, so no constant lands it right.
  // Default is AUTO: once tiles stream in, the ground near the anchor is
  // measured from the actual geometry and aligned to the model floor (see
  // _autoSnapHeight). The manual nudge is an override that turns auto off.
  var _heightOffset = (function(){ try { return Number(localStorage.getItem('cc_tiles3d_height')) || 0; } catch(_) { return 0; } })();
  var _autoHeight = (function(){ try { var v = localStorage.getItem('cc_tiles3d_height_auto'); return v == null ? true : v === '1'; } catch(_) { return true; } })();

  // Anchor ENU frame inverted (planet → local), Z-up → Y-up, optional
  // north rotation about the anchor (which maps to local 0,0,0 at that
  // stage — same sign convention as the geoplace basemap: rotation.y =
  // -deg), then translated to the shared anchor world point.
  function _applyGroupMatrix(group) {
    var THREE3 = window.THREE;
    group.matrix.copy(_anchorFrame).invert()
      .premultiply(new THREE3.Matrix4().makeRotationX(-Math.PI / 2));
    if (_north) {
      group.matrix.premultiply(new THREE3.Matrix4().makeRotationY(-_north * Math.PI / 180));
    }
    if (_anchorOrigin) {
      group.matrix.premultiply(new THREE3.Matrix4().makeTranslation(
        Number(_anchorOrigin.x), Number(_anchorOrigin.y) || 0, Number(_anchorOrigin.z) || 0));
    }
    // Alignment nudge: world-space. XZ matches the geoplace basemap offset
    // 1:1; Y is tiles-only (the basemap needs no height correction).
    if (_offset.x || _offset.z || _heightOffset) {
      group.matrix.premultiply(new THREE3.Matrix4().makeTranslation(_offset.x, _heightOffset, _offset.z));
    }
    group.matrix.decompose(group.position, group.quaternion, group.scale);
    group.matrixAutoUpdate = false;
    group.updateMatrix();
  }
  // Live north dial — rotates the streamed world about the anchor.
  window._ccSetTiles3DNorth = function(deg) {
    if (!_tiles || !_anchorFrame) return;
    _north = Number(deg) || 0;
    _applyGroupMatrix(_tiles.group);
    _inv(3);
  };
  window._ccTiles3DNorth = function() { return _north; };
  // Live alignment nudge — slides the streamed world in world XZ (metres),
  // mirroring the geoplace basemap offset so the two layers stay glued.
  window._ccSetTiles3DOffset = function(x, z) {
    _offset = { x: Number(x) || 0, z: Number(z) || 0 };
    if (_tiles && _anchorFrame) { _applyGroupMatrix(_tiles.group); _inv(3); }
  };
  window._ccTiles3DOffset = function() { return { x: _offset.x, z: _offset.z }; };
  // Manual vertical override — raises/lowers the streamed world in world Y
  // (metres) and turns auto-snap OFF (the user has taken the wheel).
  // Persisted so a reload lands at the same height.
  window._ccSetTiles3DHeight = function(m) {
    _heightOffset = Number(m) || 0;
    _autoHeight = false;
    try {
      localStorage.setItem('cc_tiles3d_height', String(_heightOffset));
      localStorage.setItem('cc_tiles3d_height_auto', '0');
    } catch(_) {}
    if (_tiles && _anchorFrame) { _applyGroupMatrix(_tiles.group); _inv(3); }
  };
  window._ccTiles3DHeight = function() { return _heightOffset; };
  window._ccTiles3DHeightAuto = function() { return _autoHeight; };
  // Re-enable auto-snap (the reset button) — re-measures and re-lands the
  // context on the model floor.
  window._ccResetTiles3DHeightAuto = function() {
    _autoHeight = true;
    try { localStorage.setItem('cc_tiles3d_height_auto', '1'); } catch(_) {}
    _autoSnapHeight(true);
  };

  // Measure the local PDOK ground near the anchor: the lowest point of any
  // tile mesh whose centre is within R metres of the anchor (in XZ). PDOK
  // "gebouwen" is buildings only, so a building's base ≈ ground (AHN) — good
  // enough to seat the context. Returns null when no geometry is near yet.
  var _wbox = null, _wctr = null;
  function _measurePdokGround() {
    var THREE3 = window.THREE;
    if (!_tiles || !_anchorOrigin || !THREE3) return null;
    if (!_wbox) { _wbox = new THREE3.Box3(); _wctr = new THREE3.Vector3(); }
    try { _tiles.group.updateMatrixWorld(true); } catch (_) {}
    var ax = Number(_anchorOrigin.x) + _offset.x;
    var az = Number(_anchorOrigin.z) + _offset.z;
    var R2 = 150 * 150, minY = Infinity, n = 0;
    _tiles.group.traverse(function(o) {
      if (!o.isMesh || !o.geometry) return;
      _wbox.setFromObject(o);
      if (_wbox.isEmpty()) return;
      _wbox.getCenter(_wctr);
      var dx = _wctr.x - ax, dz = _wctr.z - az;
      if (dx * dx + dz * dz <= R2 && _wbox.min.y < minY) { minY = _wbox.min.y; n++; }
    });
    return (n > 0 && isFinite(minY)) ? minY : null;
  }

  // Auto-snap: align the measured PDOK ground to the model floor
  // (_anchorOrigin.y, where the 2D basemap also sits). Debounced because
  // tiles stream in bursts; converges as more ground near the anchor loads,
  // then stops (delta < 5 cm). No-op once the user takes manual control.
  var _snapT = null;
  function _autoSnapHeight(force) {
    if (!_autoHeight && !force) return;
    if (_snapT) clearTimeout(_snapT);
    _snapT = setTimeout(function() {
      _snapT = null;
      if ((!_autoHeight && !force) || !_tiles || !_anchorOrigin) return;
      var g = _measurePdokGround();
      if (g == null) return;
      var delta = (Number(_anchorOrigin.y) || 0) - g;
      if (Math.abs(delta) < 0.05) return;
      _heightOffset += delta;
      try { localStorage.setItem('cc_tiles3d_height', String(_heightOffset)); } catch(_) {}
      _applyGroupMatrix(_tiles.group);
      _inv(4);
    }, 400);
  }

  // ── Site clearing ────────────────────────────────────────────────
  // Carves the context geometry away inside the loaded models' footprint
  // (+ margin) with 4 vertical clip planes (clipIntersection — a fragment
  // is discarded only when it's inside ALL planes, i.e. inside the prism).
  // PDOK/Google tiles merge many buildings into one mesh, so hiding whole
  // meshes can't isolate "the old existing building" — clipping can. The
  // prism is infinite vertically so towers disappear fully; the basemap
  // plane is untouched (it's the map, not a building).
  var _clearM = (function(){ try { var v = localStorage.getItem('cc_tiles3d_clear'); return v == null ? -1 : Number(v); } catch(_) { return -1; } })(); // <0 = off
  var _clipPlanes = null;
  function _buildClipPlanes() {
    var THREE3 = window.THREE, S = _S3();
    if (!S || !S.map) return null;
    var box = new THREE3.Box3();
    Object.keys(S.map).forEach(function(id) {
      try { box.expandByObject(S.map[id]); } catch (_) {}
    });
    if (box.isEmpty()) return null;
    var m = Math.max(0, _clearM);
    // Outward normals; constant = signed distance such that "inside the
    // prism" is the negative side of every plane.
    return [
      new THREE3.Plane(new THREE3.Vector3( 1, 0, 0), -(box.max.x + m)),
      new THREE3.Plane(new THREE3.Vector3(-1, 0, 0),  (box.min.x - m)),
      new THREE3.Plane(new THREE3.Vector3(0, 0,  1), -(box.max.z + m)),
      new THREE3.Plane(new THREE3.Vector3(0, 0, -1),  (box.min.z - m))
    ];
  }
  function _applyClipping(root) {
    if (!root) return;
    root.traverse(function(o) {
      if (!o.isMesh || !o.material) return;
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(function(mat) {
        mat.clippingPlanes = _clipPlanes;
        mat.clipIntersection = !!_clipPlanes;
        mat.needsUpdate = true;
      });
    });
  }
  // marginM < 0 (or null/undefined) = off; >= 0 = clear footprint + margin.
  window._ccSetTiles3DClearing = function(marginM) {
    _clearM = (marginM == null || Number(marginM) < 0) ? -1 : Number(marginM);
    try { localStorage.setItem('cc_tiles3d_clear', String(_clearM)); } catch (_) {}
    _clipPlanes = _clearM >= 0 ? _buildClipPlanes() : null;
    if (_tiles) { _applyClipping(_tiles.group); _inv(3); }
  };
  window._ccTiles3DClearing = function() { return _clearM; };
  var _rangeM = (function(){ try { return Number(localStorage.getItem('cc_tiles3d_range')) || 3000; } catch(_) { return 3000; } })();

  // Context range: tiles are culled/LOD'd against a CLONE of the viewer
  // camera whose far plane is clamped to the range — tiles beyond it are
  // never considered visible, so they are never downloaded. Keeps Google
  // tile quota (billed per request) and memory proportional to what the
  // user actually wants to see.
  window._ccSetTiles3DRange = function(meters) {
    _rangeM = Number(meters) > 0 ? Number(meters) : Infinity;
    try { localStorage.setItem('cc_tiles3d_range', String(_rangeM === Infinity ? 0 : _rangeM)); } catch(_) {}
    _inv(3);
  };
  window._ccTiles3DRange = function() { return _rangeM; };

  // Live detail dial — maps to the renderer's screen-space error target
  // (lower = sharper = more tiles). Takes effect on the next update, no
  // reload: tiles refine or coarsen in place as you change it.
  var _DETAIL = { low: 28, standard: 16, high: 8 };
  var _detail = (function(){ try { return localStorage.getItem('cc_tiles3d_detail') || 'standard'; } catch(_) { return 'standard'; } })();
  window._ccSetTiles3DDetail = function(level) {
    if (!_DETAIL[level]) return;
    _detail = level;
    try { localStorage.setItem('cc_tiles3d_detail', level); } catch(_) {}
    if (_tiles) { _tiles.errorTarget = _DETAIL[level]; _inv(4); }
  };
  window._ccTiles3DDetail = function() { return _detail; };

  function _S3() { return window._ccState3d || null; }

  // Masks tiles outside `radius` metres of the site anchor (scene origin —
  // the tiles group is transformed so the anchor sits there). Implements
  // the renderer's calculateTileViewError plugin contract: inView=false
  // tiles are neither rendered NOR downloaded, so a small building never
  // pulls in half the country. Reads the live range so widening it while
  // viewing streams the additional ring immediately.
  function _SiteRadiusPlugin(getRadius, anchorECEF) {
    this.name = 'CC_SITE_RADIUS';
    this._getRadius = getRadius;
    // Anchor directly in the tiles' native (ECEF) frame — computed from the
    // lat/lon frame at setup, so no group-matrix inversion races.
    this._origin = anchorECEF;
  }
  _SiteRadiusPlugin.prototype.init = function(tiles) { this._tiles = tiles; };
  _SiteRadiusPlugin.prototype.calculateTileViewError = function(tile, target) {
    var r = this._getRadius();
    if (!isFinite(r)) return false; // no-op at ∞
    if (!this._origin) return false;
    var bv = tile.engineData && tile.engineData.boundingVolume;
    if (!bv || !bv.distanceToPoint) return false;
    if (bv.distanceToPoint(this._origin) > r) { target.inView = false; return true; }
    return false;
  };
  function _inv(n) { if (typeof window._ccInvalidate === 'function') window._ccInvalidate(n || 2); }

  var _attrEl = null;
  function _showAttribution(text) {
    _hideAttribution();
    if (!text) return;
    var el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:30;' +
      'font:var(--text-2xs, 10px)/1.4 var(--font-body, sans-serif);' +
      'color:var(--text-muted);background:var(--bg-secondary);' +
      'border:1px solid var(--border-subtle);opacity:.85;' +
      'padding:1px 6px;border-radius:var(--radius-xs, 4px);pointer-events:none';
    document.body.appendChild(el);
    _attrEl = el;
  }
  function _hideAttribution() { if (_attrEl) { try { _attrEl.remove(); } catch(_){} _attrEl = null; } }

  function _teardown() {
    _hideAttribution();
    if (_pump) { clearInterval(_pump); _pump = null; }
    if (_frameHandler) {
      window.removeEventListener('cc-render-frame', _frameHandler);
      _frameHandler = null;
      window._ccHasFrameListener = Math.max(0, (window._ccHasFrameListener || 1) - 1);
    }
    if (_tiles) {
      try { if (_tiles.group && _tiles.group.parent) _tiles.group.parent.remove(_tiles.group); } catch (_) {}
      try { _tiles.dispose(); } catch (_) {}
      _tiles = null;
    }
    _inv(2);
  }

  window._ccUnloadTiles3D = function() {
    _teardown();
    try { localStorage.removeItem('cc_tiles3d_on'); } catch (_) {}
    if (window._ccToast) window._ccToast('3D world context removed.');
  };
  window._ccTiles3DActive = function() { return !!_tiles; };

  // Free Dutch national 3D layer: Kadaster 3D Basisvoorziening via PDOK
  // (OGC API 3D GeoVolumes). Buildings are LoD 2.2 from BAG + AHN. No key.
  var PDOK_NL_TILESET = 'https://api.pdok.nl/kadaster/3d-basisvoorziening/ogc/v1_0/collections/gebouwen/3dtiles';

  window._ccLoadTiles3D = function(opts) {
    opts = opts || {};
    var S = _S3();
    if (!S || !S.scene || !S.camera || !S.renderer) return Promise.reject(new Error('Viewer not ready'));
    var lat = Number(opts.lat), lon = Number(opts.lon);
    if (!isFinite(lat) || !isFinite(lon)) return Promise.reject(new Error('3D tiles need a latitude/longitude — set one in Geo Placement first.'));
    if (opts.preset === 'nl') {
      opts.url = PDOK_NL_TILESET;
      opts.attribution = '3D: Kadaster / PDOK (CC-BY 4.0)';
      // PDOK tiles are ECEF, so heights are ellipsoidal. NL geoid offset is
      // ~+43 m (NAP ≈ ellipsoid − 43); anchoring at 0 floats the whole
      // context ~43 m above the model. Overridable via opts.height.
      if (!isFinite(Number(opts.height))) opts.height = 43;
    }
    var key = (opts.key || '').trim();
    var ion = opts.ion && opts.ion.token ? opts.ion : null;
    if (!key && !ion && !opts.url) return Promise.reject(new Error('A tile source is needed: PDOK (NL), a Cesium ion token, a Google Map Tiles API key, or a tileset URL.'));
    _teardown();

    // Validate a custom/preset tileset URL up front: fetch it, require a
    // 3D Tiles document (has .root), and fall back to <url>/tileset.json
    // (OGC API 3D GeoVolumes serves either shape). Failures produce a
    // console line + toast naming the real cause — previously a bad URL
    // died silently behind the "streaming in" toast.
    function _resolveTilesetUrl(u) {
      function probe(x) {
        return fetch(x, { mode: 'cors' }).then(function(r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          var ct = (r.headers.get('content-type') || '').toLowerCase();
          return r.json().catch(function() { throw new Error('not JSON (' + ct + ')'); });
        }).then(function(j) {
          if (!j || !j.root) throw new Error('JSON but not a 3D Tiles tileset (no .root)');
          console.log('[Tiles3D] tileset OK at', x);
          return x;
        });
      }
      return probe(u).catch(function(e1) {
        var alt = u.replace(/\/+$/, '') + '/tileset.json';
        return probe(alt).catch(function(e2) {
          throw new Error('tileset unreachable — ' + u + ': ' + (e1.message || e1) + ' | ' + alt + ': ' + (e2.message || e2));
        });
      });
    }

    var _urlReady = opts.url ? _resolveTilesetUrl(opts.url).then(function(u) { opts.url = u; })
      : Promise.resolve();

    // Decoder modules resolve through the page's import map (same pinned
    // three version as the core); THREE_JSM must match the import map in
    // index.html when bumping three.
    var THREE_JSM = 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/';
    return Promise.all([
      import(TILES_CDN + '/build/index.js'),
      import(TILES_CDN + '/build/index.plugins.js'),
      import('three/addons/libs/meshopt_decoder.module.js'),
      import('three/addons/loaders/DRACOLoader.js'),
      import('three/addons/loaders/KTX2Loader.js'),
      _urlReady
    ]).then(function(mods) {
      var core = mods[0], plugins = mods[1];
      var MeshoptDecoder = mods[2].MeshoptDecoder, DRACOLoader = mods[3].DRACOLoader, KTX2Loader = mods[4].KTX2Loader;
      var THREE3 = window.THREE;
      var tiles;
      if (opts.url) {
        tiles = new core.TilesRenderer(opts.url);
      } else if (ion) {
        // Cesium ion (free community tier). Default asset: Cesium OSM
        // Buildings (96188) — worldwide building massing, no Google key.
        tiles = new core.TilesRenderer();
        tiles.registerPlugin(new plugins.CesiumIonAuthPlugin({
          apiToken: ion.token, assetId: String(ion.assetId || '96188'), autoRefreshToken: true
        }));
        if (!opts.attribution) opts.attribution = '3D: Cesium ion / OSM Buildings (© OpenStreetMap contributors)';
      } else {
        tiles = new core.TilesRenderer();
        tiles.registerPlugin(new plugins.GoogleCloudAuthPlugin({ apiToken: key, autoRefreshToken: true }));
      }

      // Anchor frame: East-North-Up at the lat/lon, inverted (planet →
      // local), then Z-up → Y-up, then translated to opts.origin — the
      // world point the anchor should sit at (the geoplace basemap puts
      // the same lat/lon at the model bbox centre, so both layers agree).
      var frame = new THREE3.Matrix4();
      var height = isFinite(Number(opts.height)) ? Number(opts.height) : 0;
      // Signature is (lat, lon, height, target). For grid-north/true-north
      // rotation later, getOrientedEastNorthUpFrame adds az/el/roll args.
      core.WGS84_ELLIPSOID.getEastNorthUpFrame(
        lat * Math.PI / 180, lon * Math.PI / 180, height, frame
      );
      // The anchor's ECEF position — the radius plugin masks against this
      // in the tiles' native frame, no group-matrix inversion needed.
      var anchorECEF = new THREE3.Vector3().setFromMatrixPosition(frame);
      try { tiles.registerPlugin(new _SiteRadiusPlugin(function(){ return _rangeM; }, anchorECEF)); } catch (_) {}
      if (plugins.TileCompressionPlugin) { try { tiles.registerPlugin(new plugins.TileCompressionPlugin()); } catch (_) {} }
      // Compressed glTF payloads: PDOK serves EXT_meshopt_compression glbs,
      // Google serves Draco + KTX2 textures. Without these decoders every
      // tile fails to parse ("setMeshoptDecoder must be called before
      // loading compressed files") and nothing ever appears. autoDispose
      // (plugin default) releases the Draco/KTX workers on teardown.
      try {
        tiles.registerPlugin(new plugins.GLTFExtensionsPlugin({
          meshoptDecoder: MeshoptDecoder,
          dracoLoader: new DRACOLoader().setDecoderPath(THREE_JSM + 'libs/draco/gltf/'),
          ktxLoader: new KTX2Loader().setTranscoderPath(THREE_JSM + 'libs/basis/').detectSupport(S.renderer)
        }));
      } catch (e) { console.warn('[Tiles3D] glTF decoder setup failed:', e && (e.message || e)); }
      // NO TilesFadePlugin: it animates tile opacity over continuous
      // frames, but this viewer renders on demand — when the pump stops,
      // fading tiles freeze near-invisible ("everything loaded, nothing
      // visible").

      // Keep the anchor pieces so the north rotation can be changed live
      // (window._ccSetTiles3DNorth) without reloading the tileset —
      // project-north Revit exports often need a manual dial-in.
      _anchorFrame = frame.clone();
      _anchorOrigin = (opts.origin && isFinite(Number(opts.origin.x))) ? opts.origin : null;
      _north = isFinite(Number(opts.north)) ? Number(opts.north) : 0;
      if (opts.offset) _offset = { x: Number(opts.offset.x) || 0, z: Number(opts.offset.z) || 0 };
      _applyGroupMatrix(tiles.group);
      tiles.group.userData._ccTiles3D = true;

      _tilesCam = S.camera.clone();
      tiles.setCamera(_tilesCam);
      tiles.setResolutionFromRenderer(_tilesCam, S.renderer);
      tiles.errorTarget = _DETAIL[_detail] || 16;
      // Keep streaming bounded even at large ranges — the viewer also holds
      // a multi-million-triangle federation, so the world context must stay
      // a guest, not a squatter: byte AND tile-count caps.
      try {
        if (tiles.lruCache) {
          tiles.lruCache.maxBytesSize = 384 * 1024 * 1024;
          tiles.lruCache.maxSize = 3000;
          tiles.lruCache.minSize = 900;
        }
      } catch (_) {}
      try { tiles.downloadQueue.maxJobs = 12; } catch (_) {}

      // Streaming progress must keep the render-on-demand loop alive.
      var _firstContent = false;
      tiles.addEventListener('load-model', function(ev) {
        if (!_firstContent) { _firstContent = true; console.log('[Tiles3D] first tile content in the scene'); }
        // Site clearing applies per tile as it streams in.
        if (_clipPlanes && ev && ev.scene) _applyClipping(ev.scene);
        _autoSnapHeight();
        _inv(10);
      });
      tiles.addEventListener('load-tileset', function() {
        console.log('[Tiles3D] tileset loaded — streaming content');
        _inv(3);
      });
      tiles.addEventListener('tiles-load-end', function() { _autoSnapHeight(); _inv(5); });
      // One definitive status line 10 s in — separates "nothing downloads"
      // (masking/frustum) from "downloads but fails" (failed>0) from
      // "renders but invisible" (visible>0).
      setTimeout(function() {
        if (!_tiles || _tiles !== tiles) return;
        try {
          var st = tiles.stats || {};
          console.log('[Tiles3D] 10s status:', JSON.stringify({
            downloading: st.downloading, parsing: st.parsing, failed: st.failed,
            inFrustum: st.inFrustum, used: st.used, active: st.active, visible: st.visible,
            loadProgress: Math.round((tiles.loadProgress || 0) * 100) / 100,
            groupChildren: tiles.group.children.length
          }));
        } catch (e) { console.warn('[Tiles3D] status failed:', e.message || e); }
      }, 10000);
      // Failures used to be invisible — the toast said "streaming in" and
      // nothing ever appeared. Surface the first error loudly.
      var _errToasted = false;
      tiles.addEventListener('load-error', function(ev) {
        var msg = (ev && ev.error && (ev.error.message || ev.error)) || 'unknown error';
        console.warn('[Tiles3D] load error:', msg, ev && ev.url ? String(ev.url) : '');
        if (!_errToasted && window._ccToast) {
          _errToasted = true;
          window._ccToast('3D world context: tile load failed — ' + msg, 'error');
        }
        _inv(1);
      });

      S.scene.add(tiles.group);
      _tiles = tiles;
      // Restore a persisted site clearing — planes are rebuilt from the
      // currently loaded models, applied per tile as content streams in.
      _clipPlanes = _clearM >= 0 ? _buildClipPlanes() : null;

      // Core fires cc-render-frame before every rendered frame.
      _frameHandler = function() {
        if (!_tiles) return;
        try {
          // The core flips localClippingEnabled off when no section is
          // active — re-assert it while site clearing is on (model
          // materials carry no clip planes then, so this is a no-op for
          // the IFC itself).
          if (_clipPlanes) S.renderer.localClippingEnabled = true;
          S.camera.updateMatrixWorld();
          // Mirror the live camera into the tiles proxy, clamping the far
          // plane to the context range (drives both culling and LOD).
          _tilesCam.position.copy(S.camera.position);
          _tilesCam.quaternion.copy(S.camera.quaternion);
          _tilesCam.fov = S.camera.fov;
          _tilesCam.aspect = S.camera.aspect;
          _tilesCam.near = S.camera.near;
          _tilesCam.far = (_rangeM === Infinity) ? S.camera.far : Math.min(S.camera.far, _rangeM);
          _tilesCam.updateProjectionMatrix();
          _tilesCam.updateMatrixWorld(true);
          _tiles.setResolutionFromRenderer(_tilesCam, S.renderer);
          _tiles.update();
        } catch (err) {
          // A throwing update() means NOTHING streams — say so once
          // instead of swallowing it every frame.
          if (!_frameErrLogged) {
            _frameErrLogged = true;
            console.warn('[Tiles3D] update() failing:', err && (err.message || err));
            if (window._ccToast) window._ccToast('3D world context: renderer error — ' + (err && (err.message || err)), 'error');
          }
        }
      };
      var _frameErrLogged = false;
      window.addEventListener('cc-render-frame', _frameHandler);
      // CRITICAL: the core only dispatches cc-render-frame when
      // _ccHasSplats or _ccHasFrameListener is truthy — without this flag
      // the handler above never runs, tiles.update() is never called and
      // the root tileset never even starts loading (the exact silent
      // nothing-streams failure seen in live testing).
      window._ccHasFrameListener = (window._ccHasFrameListener || 0) + 1;
      // Render-on-demand pump: tiles.update() only runs on rendered frames,
      // so once the camera stops moving the streaming pipeline would stall
      // mid-download. Tick frames while work is pending (plus a grace
      // window for the initial tileset fetch, which stats don't count).
      var _pumpT0 = Date.now();
      _pump = setInterval(function() {
        if (!_tiles) return;
        var st = _tiles.stats || {};
        if (Date.now() - _pumpT0 < 15000 || (st.downloading || 0) + (st.parsing || 0) > 0) _inv(1);
      }, 300);
      try { localStorage.setItem('cc_tiles3d_on', '1'); } catch (_) {}
      _showAttribution(opts.attribution || (key ? 'Map data: Google' : null));
      _inv(5);
      if (window._ccToast) window._ccToast('3D world context streaming in — give it a few seconds.');
      return tiles;
    });
  };

  // The world context belongs to the project that loaded it — drop it on
  // project switch (quietly: no toast, and clear the restore flag).
  window.addEventListener('cc-project-switch', function() {
    if (!_tiles) return;
    _teardown();
    try { localStorage.removeItem('cc_tiles3d_on'); } catch (_) {}
  });

  if (typeof window._ccRegisterAddon === 'function') {
    window._ccRegisterAddon({
      id: 'tiles',
      alwaysOn: true,
      name: '3D world context (Google 3D Tiles)',
      description: 'Streams photorealistic 3D Tiles of the real world around your georeferenced IFC — Cesium-style global context in the browser. Bring your own Google Map Tiles API key (or any 3D Tiles tileset URL); the model never moves.'
    });
  }
})();
