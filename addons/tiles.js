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
    if (_frameHandler) { window.removeEventListener('cc-render-frame', _frameHandler); _frameHandler = null; }
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
    if (!key && !opts.url) return Promise.reject(new Error('Google Map Tiles API key required (or a custom tileset URL).'));
    _teardown();

    return Promise.all([
      import(TILES_CDN + '/build/index.js'),
      import(TILES_CDN + '/build/index.plugins.js')
    ]).then(function(mods) {
      var core = mods[0], plugins = mods[1];
      var THREE3 = window.THREE;
      var tiles;
      if (opts.url) {
        tiles = new core.TilesRenderer(opts.url);
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
      if (plugins.TilesFadePlugin) { try { tiles.registerPlugin(new plugins.TilesFadePlugin()); } catch (_) {} }

      tiles.group.matrix.copy(frame).invert()
        .premultiply(new THREE3.Matrix4().makeRotationX(-Math.PI / 2));
      if (opts.origin && isFinite(Number(opts.origin.x))) {
        tiles.group.matrix.premultiply(new THREE3.Matrix4().makeTranslation(
          Number(opts.origin.x), Number(opts.origin.y) || 0, Number(opts.origin.z) || 0));
      }
      tiles.group.matrix.decompose(tiles.group.position, tiles.group.quaternion, tiles.group.scale);
      tiles.group.matrixAutoUpdate = false;
      tiles.group.updateMatrix();
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
      tiles.addEventListener('load-model', function() { _inv(2); });
      tiles.addEventListener('load-tileset', function() {
        console.log('[Tiles3D] tileset loaded — streaming content');
        _inv(3);
      });
      tiles.addEventListener('tiles-load-end', function() { _inv(2); });
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

      // Core fires cc-render-frame before every rendered frame.
      _frameHandler = function() {
        if (!_tiles) return;
        try {
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
        } catch (_) {}
      };
      window.addEventListener('cc-render-frame', _frameHandler);
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

  if (typeof window._ccRegisterAddon === 'function') {
    window._ccRegisterAddon({
      id: 'tiles',
      alwaysOn: true,
      name: '3D world context (Google 3D Tiles)',
      description: 'Streams photorealistic 3D Tiles of the real world around your georeferenced IFC — Cesium-style global context in the browser. Bring your own Google Map Tiles API key (or any 3D Tiles tileset URL); the model never moves.'
    });
  }
})();
