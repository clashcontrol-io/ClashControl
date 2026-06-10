// ClashControl geoplace addon — places the IFC in a real-world context
// v1 path: read IfcSite RefLatitude/Longitude from the loaded model (or take
// a manual lat/lon from the user), then render a textured raster basemap
// plane under the model. No proj4js, no IfcMapConversion yet — those are
// v1.1 when a paying user needs them.
//
// IFC origin leads: the model never moves. The basemap is positioned in IFC
// space at the model's bbox centre, oriented to the model's true north
// (defaults to 0 — manual override in the UI).
(function(){
  if (typeof window === 'undefined') return;

  var THREE = window.THREE;

  function getScene() {
    var S3 = window._ccState3d;
    return S3 && S3.scene ? S3.scene : null;
  }
  function invalidate(n) {
    if (typeof window._ccInvalidate === 'function') window._ccInvalidate(n||2);
  }

  // ── Tile provider config ───────────────────────────────────────
  // All tiles go through our same-origin /api/tile proxy. The proxy
  // handles provider selection server-side based on MAPTILER_KEY:
  // - MAPTILER_KEY set  → MapTiler satellite (production)
  // - MAPTILER_KEY unset → OpenStreetMap (dev / demo)
  // Going through the proxy also gives us aggressive edge caching and
  // CORS/CORP headers that some upstream tile servers omit.
  function tileURL(z, x, y) {
    return '/api/tile?z=' + z + '&x=' + x + '&y=' + y;
  }

  // ── lat/lon → web-mercator metres ─────────────────────────────
  var R = 6378137;
  function lonToMercX(lon) { return R * lon * Math.PI / 180; }
  function latToMercY(lat) {
    var s = Math.sin(lat * Math.PI / 180);
    return R * 0.5 * Math.log((1 + s) / (1 - s));
  }
  function lonToTileX(lon, z) { return Math.floor((lon + 180) / 360 * Math.pow(2, z)); }
  function latToTileY(lat, z) {
    var r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1/Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
  }
  function tileXToLon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
  function tileYToLat(y, z) {
    var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  // ── Basemap rendering ──────────────────────────────────────────
  var _basemap = null; // current THREE.Mesh
  var _basemapForId = null; // modelId the basemap was built for

  function clearBasemap() {
    if (_basemap && _basemap.parent) _basemap.parent.remove(_basemap);
    if (_basemap) {
      if (_basemap.geometry) _basemap.geometry.dispose();
      if (_basemap.material) {
        if (_basemap.material.map) _basemap.material.map.dispose();
        _basemap.material.dispose();
      }
    }
    _basemap = null;
    _basemapForId = null;
    invalidate(2);
  }

  // Build a basemap by stitching a 3×3 (or larger) grid of tiles onto a
  // textured plane, centred at the given lat/lon and sized to span the
  // model's bbox plus a margin.
  function buildBasemap(modelId, lat, lon, radiusM, opts) {
    opts = opts || {};
    var scene = getScene(); if (!scene) return Promise.reject(new Error('Scene not ready'));
    var zoom = opts.zoom || 18; // ~0.6 m/pixel at lat 0
    // How many tiles do we need each way to cover radiusM at this zoom?
    // Tile width in metres at this zoom and latitude:
    var metresPerTile = 40075016.686 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    var halfTiles = Math.max(1, Math.ceil(radiusM / metresPerTile));
    var totalSide = halfTiles * 2 + 1;
    if (totalSide > 11) {
      // Cap at 11×11 = 121 tiles to keep network + memory bounded
      // Bigger radius → drop a zoom level.
      while (totalSide > 11 && zoom > 10) {
        zoom -= 1;
        metresPerTile = 40075016.686 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
        halfTiles = Math.max(1, Math.ceil(radiusM / metresPerTile));
        totalSide = halfTiles * 2 + 1;
      }
    }
    var cx = lonToTileX(lon, zoom);
    var cy = latToTileY(lat, zoom);

    // The grid is centred on the whole TILE containing (lat,lon), not on
    // the point itself — at z18/lat52 a tile is ~94 m, so treating the
    // canvas centre as the anchor drifts the map up to ~47 m per axis.
    // Compute the anchor's offset from the canvas centre in ground metres
    // so the typed coordinate is what lands on the model.
    var nTiles = Math.pow(2, zoom);
    var fracX = (lon + 180) / 360 * nTiles - cx;   // 0..1 inside centre tile
    var rlat = lat * Math.PI / 180;
    var fracY = (1 - Math.log(Math.tan(rlat) + 1/Math.cos(rlat)) / Math.PI) / 2 * nTiles - cy;
    var anchorOffE = (fracX - 0.5) * metresPerTile;        // anchor east of canvas centre
    var anchorOffN = (0.5 - fracY) * metresPerTile;        // north (tile y grows south)

    var tileSize = 256;
    var canvasSize = totalSide * tileSize;
    var canvas = document.createElement('canvas');
    canvas.width = canvasSize; canvas.height = canvasSize;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, canvasSize, canvasSize);

    var pending = [];
    for (var dy = -halfTiles; dy <= halfTiles; dy++) {
      for (var dx = -halfTiles; dx <= halfTiles; dx++) {
        (function(dx, dy){
          var tx = cx + dx, ty = cy + dy;
          var img = new Image();
          img.crossOrigin = 'anonymous';
          var p = new Promise(function(resolve){
            img.onload = function(){
              var px = (dx + halfTiles) * tileSize;
              var py = (dy + halfTiles) * tileSize;
              try { ctx.drawImage(img, px, py); resolve(true); }
              catch(e){ console.warn('[Geoplace] drawImage failed (tainted canvas?)', e); resolve(false); }
            };
            img.onerror = function(){ resolve(false); }; // missing tile → leave the bg
          });
          img.src = tileURL(zoom, tx, ty);
          pending.push(p);
        })(dx, dy);
      }
    }

    var loaded = 0, failed = 0;
    var origPending = pending.length;
    pending = pending.map(function(p){ return p.then(function(ok){ if (ok) loaded++; else failed++; }); });
    return Promise.all(pending).then(function(){
      console.log('[Geoplace] tiles z=' + zoom + ' totalSide=' + totalSide + ' loaded=' + loaded + '/' + origPending + (failed?' (' + failed + ' failed)':''));
      // Plane size in metres equals total tiles × metresPerTile.
      var planeSize = totalSide * metresPerTile;
      // Plane is centred on the model bbox centre, sitting at Y = refElev (or 0).
      var tex = new THREE.CanvasTexture(canvas);
      // Use core's shim so this works on both r128 (tex.encoding) and r152+
      // (tex.colorSpace). Falls back gracefully if the shim isn't loaded yet.
      if (typeof window._ccSetSRGBTexture === 'function') window._ccSetSRGBTexture(tex);
      else if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      else if ('encoding' in tex && THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
      tex.minFilter = THREE.LinearFilter;
      tex.generateMipmaps = false;

      var geom = new THREE.PlaneGeometry(planeSize, planeSize, 1, 1);
      geom.rotateX(-Math.PI / 2); // lay flat (Three.js Y-up; default plane is XY)
      // Opaque + depthWrite on — keeps fillrate cost low and lets the render-
      // on-demand loop skip frames when nothing changes. Transparent planes
      // forced constant overdraw on every redraw the model triggered.
      var mat = new THREE.MeshBasicMaterial({map:tex, depthWrite:true});
      var mesh = new THREE.Mesh(geom, mat);
      mesh.userData.isReference = true;
      mesh.userData.isBasemap = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      // Position so the anchor (lat,lon) — not the canvas centre — sits at
      // the model bbox centre, just below ground so the model doesn't
      // z-fight with the plane. Rotation (true north) is about the mesh
      // origin, so rotate the anchor offset along with it.
      if (opts.trueNorthDeg) {
        mesh.rotation.y = -opts.trueNorthDeg * Math.PI / 180;
      }
      var bbox = _getModelBBox(modelId);
      if (bbox && !bbox.isEmpty()) {
        var c = bbox.getCenter(new THREE.Vector3());
        var th = mesh.rotation.y || 0;
        // Local anchor offset (E, -N) in plane space, rotated into world.
        var ax = anchorOffE * Math.cos(th) - anchorOffN * Math.sin(th);
        var az = -anchorOffE * Math.sin(th) - anchorOffN * Math.cos(th);
        mesh.position.set(c.x - ax, bbox.min.y - 0.05, c.z - az);
      }
      mesh.updateMatrix();
      clearBasemap();
      scene.add(mesh);
      _basemap = mesh;
      _basemapForId = modelId;
      invalidate(2);
      return mesh;
    });
  }

  function _getModelBBox(modelId) {
    var S3 = window._ccState3d;
    if (!S3 || !S3.map || !S3.map[modelId]) return null;
    var box = new THREE.Box3();
    box.setFromObject(S3.map[modelId]);
    return box;
  }

  // ── Public API ────────────────────────────────────────────────
  // Apply / refresh a basemap for the given model
  window._ccGeoplaceModel = function(modelId, geo) {
    // geo: {refLat, refLon, refElev?, trueNorthDeg?, radiusM?}
    if (geo.refLat == null || geo.refLon == null) {
      return Promise.reject(new Error('refLat / refLon required'));
    }
    // North rotation comes from the loaded IFC (IfcMapConversion grid
    // rotation wins over TrueNorth, which is often left default). The
    // fresh model value overrides any previously persisted trueNorthDeg —
    // the model is the source of truth, and this self-heals projects that
    // saved a value under an older sign convention.
    if (typeof window._ccModelNorthDeg === 'function') {
      var _tn = window._ccModelNorthDeg(modelId);
      if (_tn != null) geo = Object.assign({}, geo, {trueNorthDeg: _tn});
    }
    var radiusM = geo.radiusM;
    if (!radiusM) {
      var bbox = _getModelBBox(modelId);
      if (bbox && !bbox.isEmpty()) {
        var sz = bbox.getSize(new THREE.Vector3());
        radiusM = Math.max(sz.x, sz.z) * 1.5 + 50;
      } else {
        radiusM = 200;
      }
    }
    var georef = {
      refLat:geo.refLat, refLon:geo.refLon, refElev:geo.refElev||0,
      trueNorthDeg:geo.trueNorthDeg||0, radiusM:radiusM, source:geo.source||'manual'
    };
    if (window._ccDispatch) {
      window._ccDispatch({t:'SET_MODEL_GEO', id:modelId, u:georef});
      // Persist on the model so modelMeta saves it to IndexedDB and the
      // basemap survives a page refresh.
      window._ccDispatch({t:'UPD_MODEL', id:modelId, u:{georef:georef}});
    }
    return buildBasemap(modelId, geo.refLat, geo.refLon, radiusM, {
      trueNorthDeg: geo.trueNorthDeg||0
    });
  };

  window._ccGeoplaceClear = function() {
    var modelId = _basemapForId;
    clearBasemap();
    if (window._ccDispatch) {
      window._ccDispatch({t:'CLR_MODEL_GEO'});
      if (modelId) window._ccDispatch({t:'UPD_MODEL', id:modelId, u:{georef:null}});
    }
  };

  // Read georef from a freshly-loaded IFC model (looks at
  // model.spatialHierarchy.sites[0].georef)
  window._ccGetModelGeoref = function(model) {
    if (!model || !model.spatialHierarchy) return null;
    var sites = model.spatialHierarchy.sites || [];
    for (var i = 0; i < sites.length; i++) {
      if (sites[i].georef && sites[i].georef.refLat != null && sites[i].georef.refLon != null) {
        return sites[i].georef;
      }
    }
    return null;
  };

  // ── Addon registration ────────────────────────────────────────
  var register = window._ccRegisterAddon;
  if (typeof register !== 'function') return;

  register({
    id: 'geoplace',
    name: 'Geo Placement',
    description: 'Place the model on a real-world basemap. Reads IfcSite lat/lon when present, or accepts manual coordinates.',
    autoActivate: true,
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5b8def" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',

    initState: {
      modelGeo: null // {modelId, refLat, refLon, refElev, trueNorthDeg, radiusM, source}
    },

    reducerCases: {
      'SET_MODEL_GEO': function(s, a) {
        var g = Object.assign({}, a.u, {modelId:a.id});
        return Object.assign({}, s, {modelGeo: g});
      },
      'CLR_MODEL_GEO': function(s) {
        return Object.assign({}, s, {modelGeo: null});
      }
    },

    init: function() {
      console.log('[Geoplace] Addon ready');
      _autoRestore();
      // The basemap belongs to the project that placed it: detach on
      // project switch (visuals + live state only — the persisted georef
      // stays with the model, so switching back restores it).
      window.addEventListener('cc-project-switch', function(){
        clearBasemap();
        if (window._ccDispatch) window._ccDispatch({t:'CLR_MODEL_GEO'});
        _autoRestore();
      });
    },

    destroy: function() {
      clearBasemap();
    }
  });

  // Auto-restore a basemap if a loaded model has a saved georef (persisted
  // via modelMeta → IndexedDB). Polls briefly because model rehydration
  // runs asynchronously after addon init / project switch.
  function _autoRestore() {
      var attempts = 0;
      var iv = setInterval(function(){
        attempts++;
        var s = window._ccLatestState;
        var S3 = window._ccState3d;
        if (!s || !s.models || !S3 || !S3.map) {
          if (attempts > 60) clearInterval(iv); // give up after ~30s
          return;
        }
        var target = null;
        for (var i = 0; i < s.models.length; i++) {
          var m = s.models[i];
          if (m.georef && m.georef.refLat != null && S3.map[m.id]) { target = m; break; }
        }
        // Wait until we either find a target with a ready scene group, or
        // we're sure none of the loaded models had a saved georef.
        if (!target) {
          var anyPending = s.models.some(function(m){
            return m.georef && m.georef.refLat != null && !S3.map[m.id];
          });
          if (!anyPending) clearInterval(iv);
          if (attempts > 60) clearInterval(iv);
          return;
        }
        clearInterval(iv);
        if (_basemapForId === target.id) return; // already up
        window._ccGeoplaceModel(target.id, target.georef).catch(function(err){
          console.warn('[Geoplace] auto-restore failed:', err);
        });
      }, 500);
  }
})();
