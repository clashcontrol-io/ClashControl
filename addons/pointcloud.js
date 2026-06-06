// ClashControl pointcloud addon — reference layers
// Loads PLY / PCD / XYZ / LAS files as THREE.Points and adds them to the
// scene as reference geometry. Reference layers are excluded from clash
// detection (they never live in s.models) but participate in fit-all.
//
// LAZ is intentionally not supported in v1 — convert via CloudCompare /
// las2las → .las and retry.
(function(){
  if (typeof window === 'undefined') return;

  var THREE = window.THREE;
  var loaderCache = {}; // url → Promise<void>

  function loadScriptOnce(url) {
    if (loaderCache[url]) return loaderCache[url];
    loaderCache[url] = new Promise(function(resolve, reject){
      var s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = function(){ resolve(); };
      s.onerror = function(){ reject(new Error('Failed to load ' + url)); };
      document.head.appendChild(s);
    });
    return loaderCache[url];
  }

  // ── State3D access ─────────────────────────────────────────────
  function getScene() {
    var S3 = window._ccState3d;
    return S3 && S3.scene ? S3.scene : null;
  }
  function invalidate(n) {
    if (typeof window._ccInvalidate === 'function') window._ccInvalidate(n||2);
  }

  // ── Reference scene group ──────────────────────────────────────
  // Owned by the addon, not by state. Keeps THREE objects out of redux.
  var _refMg = null;
  var _objects = {}; // id → THREE.Points
  function refMg() {
    if (_refMg) return _refMg;
    var sc = getScene();
    if (!sc) return null;
    _refMg = new THREE.Group();
    _refMg.name = 'cc-reference-layers';
    _refMg.userData.isReference = true;
    sc.add(_refMg);
    return _refMg;
  }

  // ── Parsers ───────────────────────────────────────────────────
  function parsePLY(buf) {
    return loadScriptOnce('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/PLYLoader.js')
      .then(function(){
        var geom = new THREE.PLYLoader().parse(buf);
        geom.computeBoundingBox();
        return geom;
      });
  }
  function parsePCD(buf) {
    return loadScriptOnce('https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/PCDLoader.js')
      .then(function(){
        var pcd = new THREE.PCDLoader().parse(buf, '');
        var geom = pcd.geometry;
        geom.computeBoundingBox();
        return geom;
      });
  }
  function parseXYZ(buf) {
    var text = new TextDecoder('utf-8').decode(new Uint8Array(buf));
    var lines = text.split(/\r?\n/);
    var pos = []; var col = []; var hasCol = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') continue;
      var parts = line.split(/[\s,]+/);
      if (parts.length < 3) continue;
      var x = +parts[0], y = +parts[1], z = +parts[2];
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
      pos.push(x, y, z);
      if (parts.length >= 6) {
        hasCol = true;
        col.push((+parts[3])/255, (+parts[4])/255, (+parts[5])/255);
      }
    }
    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (hasCol) geom.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geom.computeBoundingBox();
    return Promise.resolve(geom);
  }

  // Minimal LAS 1.0–1.4 parser, point data record formats 0–3.
  // Reads XYZ, applies scale + offset, optionally reads RGB for formats 2/3.
  function parseLAS(buf) {
    var dv = new DataView(buf);
    if (dv.getUint8(0) !== 0x4C || dv.getUint8(1) !== 0x41 || dv.getUint8(2) !== 0x53 || dv.getUint8(3) !== 0x46) {
      return Promise.reject(new Error('Not a LAS file (bad signature). LAZ is not supported in v1 — convert to LAS via CloudCompare.'));
    }
    var versionMajor = dv.getUint8(24);
    var versionMinor = dv.getUint8(25);
    var headerSize = dv.getUint16(94, true);
    var pointDataOffset = dv.getUint32(96, true);
    var pointDataFormat = dv.getUint8(104) & 0x7F; // mask compression bit
    var pointDataRecordLength = dv.getUint16(105, true);
    // legacy 32-bit count (header offset 107); 1.4 also has 64-bit at 247
    var pointCount = dv.getUint32(107, true);
    if (versionMajor === 1 && versionMinor >= 4 && pointCount === 0 && headerSize >= 247 + 8) {
      // LAS 1.4 — 64-bit point count
      var lo = dv.getUint32(247, true), hi = dv.getUint32(251, true);
      pointCount = hi * 0x100000000 + lo;
    }
    var scaleX = dv.getFloat64(131, true);
    var scaleY = dv.getFloat64(139, true);
    var scaleZ = dv.getFloat64(147, true);
    var offX = dv.getFloat64(155, true);
    var offY = dv.getFloat64(163, true);
    var offZ = dv.getFloat64(171, true);

    if (pointDataFormat > 5) {
      return Promise.reject(new Error('LAS point format ' + pointDataFormat + ' not supported in v1 (need 0–5).'));
    }
    var hasRGB = (pointDataFormat === 2 || pointDataFormat === 3 || pointDataFormat === 5);
    var rgbOffset = (pointDataFormat === 2) ? 20 : (pointDataFormat === 3 || pointDataFormat === 5) ? 28 : 0;

    var pos = new Float32Array(pointCount * 3);
    var col = hasRGB ? new Float32Array(pointCount * 3) : null;

    // Center coordinates around the centroid to avoid float32 precision loss
    // for survey coords (e.g. EPSG eastings ~155000). The translation goes on
    // the Points object's position.
    var cx = 0, cy = 0, cz = 0;
    var minX=Infinity, minY=Infinity, minZ=Infinity;
    var maxX=-Infinity, maxY=-Infinity, maxZ=-Infinity;

    // Two-pass: first collect, then center. Keeps memory at ~2x but simpler.
    var raw = new Float64Array(pointCount * 3);
    var off = pointDataOffset;
    for (var i = 0; i < pointCount; i++) {
      var xi = dv.getInt32(off, true);
      var yi = dv.getInt32(off + 4, true);
      var zi = dv.getInt32(off + 8, true);
      var x = xi * scaleX + offX;
      var y = yi * scaleY + offY;
      var z = zi * scaleZ + offZ;
      raw[i*3] = x; raw[i*3+1] = y; raw[i*3+2] = z;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
      if (hasRGB) {
        // LAS RGB is 16-bit per channel; common files store 8-bit values in
        // the high byte while a few use the full 16-bit range. Detect and
        // normalise.
        var r = dv.getUint16(off + rgbOffset, true);
        var g = dv.getUint16(off + rgbOffset + 2, true);
        var b = dv.getUint16(off + rgbOffset + 4, true);
        col[i*3]   = (r > 255 ? r / 65535 : r / 255);
        col[i*3+1] = (g > 255 ? g / 65535 : g / 255);
        col[i*3+2] = (b > 255 ? b / 65535 : b / 255);
      }
      off += pointDataRecordLength;
    }
    cx = (minX + maxX) / 2;
    cy = (minY + maxY) / 2;
    cz = (minZ + maxZ) / 2;
    for (var j = 0; j < pointCount; j++) {
      pos[j*3]   = raw[j*3]   - cx;
      pos[j*3+1] = raw[j*3+1] - cy;
      pos[j*3+2] = raw[j*3+2] - cz;
    }

    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (col) geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geom.computeBoundingBox();
    // Stash the world-space origin so the geoplace addon (or future
    // alignment tools) can restore real-world coords later.
    geom.userData = geom.userData || {};
    geom.userData.lasOrigin = [cx, cy, cz];
    return Promise.resolve(geom);
  }

  function parseFile(file) {
    var ext = file.name.split('.').pop().toLowerCase();
    return file.arrayBuffer().then(function(buf){
      if (ext === 'ply') return parsePLY(buf);
      if (ext === 'pcd') return parsePCD(buf);
      if (ext === 'xyz' || ext === 'txt' || ext === 'pts') return parseXYZ(buf);
      if (ext === 'las') return parseLAS(buf);
      if (ext === 'laz') return Promise.reject(new Error('LAZ is not supported yet. Convert to LAS or PLY first (CloudCompare → File → Save As → LAS).'));
      return Promise.reject(new Error('Unsupported point cloud format: .' + ext));
    });
  }

  // ── Public API ────────────────────────────────────────────────
  window._ccLoadPointCloud = function(file) {
    var mg = refMg();
    if (!mg) return Promise.reject(new Error('Scene not ready'));
    return parseFile(file).then(function(geom){
      var hasColor = !!geom.getAttribute('color');
      var mat = new THREE.PointsMaterial({
        size: 0.02,                // metres; we live in metres throughout the app
        sizeAttenuation: true,
        vertexColors: hasColor,
        color: hasColor ? 0xffffff : 0x9ec5fe
      });
      var pts = new THREE.Points(geom, mat);
      pts.userData.isReference = true;
      pts.frustumCulled = true;
      if (geom.userData && geom.userData.lasOrigin) {
        // Restore the world origin so the cloud sits in true coords if a
        // model has been geoplaced. For now (no geoplace yet) we drop it on
        // the scene origin; uncommenting below would place it at LAS coords.
        // pts.position.fromArray(geom.userData.lasOrigin);
      }
      var id = 'pc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6);
      pts.userData.refId = id;
      mg.add(pts);
      _objects[id] = pts;

      var entry = {
        id: id,
        name: file.name,
        ext: file.name.split('.').pop().toLowerCase(),
        kind: 'pointcloud',
        visible: true,
        pointSize: 0.02,
        opacity: 1,
        pointCount: geom.getAttribute('position').count,
        hasColor: hasColor,
        origin: geom.userData && geom.userData.lasOrigin ? geom.userData.lasOrigin.slice() : null
      };
      if (window._ccDispatch) window._ccDispatch({t:'ADD_REFERENCE_LAYER', v: entry});

      // Fit camera if this is the first scene object
      if (window._ccResetView && (!window._ccLatestState || !window._ccLatestState.models || window._ccLatestState.models.length === 0)) {
        setTimeout(window._ccResetView, 50);
      }
      invalidate(3);
      return entry;
    });
  };

  window._ccRemovePointCloud = function(id) {
    var obj = _objects[id];
    if (!obj) return;
    if (_refMg) _refMg.remove(obj);
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) obj.material.dispose();
    delete _objects[id];
    if (window._ccDispatch) window._ccDispatch({t:'DEL_REFERENCE_LAYER', id: id});
    invalidate(2);
  };

  window._ccUpdateReferenceLayer = function(id, updates) {
    var obj = _objects[id];
    if (!obj) return;
    if (updates.visible !== undefined) obj.visible = !!updates.visible;
    if (updates.pointSize !== undefined && obj.material) {
      obj.material.size = +updates.pointSize;
      obj.material.needsUpdate = true;
    }
    if (updates.opacity !== undefined && obj.material) {
      var op = Math.max(0, Math.min(1, +updates.opacity));
      obj.material.opacity = op;
      obj.material.transparent = op < 1;
      obj.material.needsUpdate = true;
    }
    if (window._ccDispatch) window._ccDispatch({t:'UPD_REFERENCE_LAYER', id: id, u: updates});
    invalidate(2);
  };

  // Used by fit-all / reset-view in the core to include reference geometry
  // in the world bbox calculation.
  window._ccGetReferenceLayerBBox = function() {
    if (!_refMg || _refMg.children.length === 0) return null;
    var box = new THREE.Box3();
    _refMg.children.forEach(function(c){
      if (!c.visible) return;
      var b = new THREE.Box3().setFromObject(c);
      if (!b.isEmpty()) box.union(b);
    });
    return box.isEmpty() ? null : box;
  };

  // ── Addon registration ────────────────────────────────────────
  var register = window._ccRegisterAddon;
  if (typeof register !== 'function') return;

  register({
    id: 'pointcloud',
    name: 'Point Cloud Reference',
    description: 'Load PLY, PCD, XYZ, or LAS scans as reference layers. They render alongside the model but are excluded from clash detection.',
    autoActivate: true,
    icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ec5fe" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="7" r="1.2"/><circle cx="12" cy="5" r="1.2"/><circle cx="18" cy="8" r="1.2"/><circle cx="5" cy="13" r="1.2"/><circle cx="11" cy="11" r="1.2"/><circle cx="17" cy="14" r="1.2"/><circle cx="7" cy="18" r="1.2"/><circle cx="14" cy="19" r="1.2"/><circle cx="19" cy="17" r="1.2"/></svg>',

    initState: {
      referenceLayers: []
    },

    reducerCases: {
      'ADD_REFERENCE_LAYER': function(s, a) {
        return Object.assign({}, s, {referenceLayers: (s.referenceLayers||[]).concat([a.v])});
      },
      'DEL_REFERENCE_LAYER': function(s, a) {
        return Object.assign({}, s, {referenceLayers: (s.referenceLayers||[]).filter(function(r){return r.id !== a.id;})});
      },
      'UPD_REFERENCE_LAYER': function(s, a) {
        return Object.assign({}, s, {referenceLayers: (s.referenceLayers||[]).map(function(r){
          return r.id === a.id ? Object.assign({}, r, a.u) : r;
        })});
      }
    },

    init: function() {
      // Nothing to do on init — the scene group is created lazily on first load.
      console.log('[PointCloud] Addon ready');
    },

    destroy: function() {
      Object.keys(_objects).forEach(function(id){ window._ccRemovePointCloud(id); });
      if (_refMg && _refMg.parent) _refMg.parent.remove(_refMg);
      _refMg = null;
    }
  });
})();
