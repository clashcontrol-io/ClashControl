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

  function _S3() { return window._ccState3d || null; }
  function _inv(n) { if (typeof window._ccInvalidate === 'function') window._ccInvalidate(n || 2); }

  function _teardown() {
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

  window._ccLoadTiles3D = function(opts) {
    opts = opts || {};
    var S = _S3();
    if (!S || !S.scene || !S.camera || !S.renderer) return Promise.reject(new Error('Viewer not ready'));
    var lat = Number(opts.lat), lon = Number(opts.lon);
    if (!isFinite(lat) || !isFinite(lon)) return Promise.reject(new Error('3D tiles need a latitude/longitude — set one in Geo Placement first.'));
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
      if (plugins.TileCompressionPlugin) { try { tiles.registerPlugin(new plugins.TileCompressionPlugin()); } catch (_) {} }
      if (plugins.TilesFadePlugin) { try { tiles.registerPlugin(new plugins.TilesFadePlugin()); } catch (_) {} }

      // Anchor lat/lon at the scene origin, Y-up: take the East-North-Up
      // frame at the anchor, invert (planet → local), then Z-up → Y-up.
      var frame = new THREE3.Matrix4();
      var height = isFinite(Number(opts.height)) ? Number(opts.height) : 0;
      core.WGS84_ELLIPSOID.getEastNorthUpFrame(
        lat * Math.PI / 180, lon * Math.PI / 180, height, 0, 0, 0, frame
      );
      tiles.group.matrix.copy(frame).invert()
        .premultiply(new THREE3.Matrix4().makeRotationX(-Math.PI / 2));
      tiles.group.matrix.decompose(tiles.group.position, tiles.group.quaternion, tiles.group.scale);
      tiles.group.matrixAutoUpdate = false;
      tiles.group.updateMatrix();
      tiles.group.userData._ccTiles3D = true;

      tiles.setCamera(S.camera);
      tiles.setResolutionFromRenderer(S.camera, S.renderer);
      tiles.errorTarget = 12;

      // Streaming progress must keep the render-on-demand loop alive.
      tiles.addEventListener('load-model', function() { _inv(2); });
      tiles.addEventListener('load-tile-set', function() { _inv(3); });
      tiles.addEventListener('tiles-load-end', function() { _inv(2); });

      S.scene.add(tiles.group);
      _tiles = tiles;

      // Core fires cc-render-frame before every rendered frame.
      _frameHandler = function() {
        if (!_tiles) return;
        try {
          S.camera.updateMatrixWorld();
          _tiles.setResolutionFromRenderer(S.camera, S.renderer);
          _tiles.update();
        } catch (_) {}
      };
      window.addEventListener('cc-render-frame', _frameHandler);
      try { localStorage.setItem('cc_tiles3d_on', '1'); } catch (_) {}
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
