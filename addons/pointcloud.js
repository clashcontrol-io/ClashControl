// ClashControl pointcloud addon — reference layers
// Loads PLY / PCD / XYZ / LAS / PTS / PTX files as THREE.Points and adds
// them to the scene as reference geometry. Reference layers are excluded
// from clash detection (they never live in s.models) but participate in
// fit-all. LAZ is intentionally not supported in v1 — convert via
// CloudCompare / las2las → .las and retry.
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
  // PLYLoader + PCDLoader are now preloaded by index.html's ESM bootstrap
  // and attached to THREE.* there. We no longer need to inject the legacy
  // examples/js script — that path 404s on three@0.180+ anyway. We DO keep
  // a defensive lazy-load fallback in case the bootstrap ever drops them.
  function _ensureLoader(name, esmPath) {
    if (typeof THREE !== 'undefined' && typeof THREE[name] === 'function') return Promise.resolve();
    return import(/* @vite-ignore */ esmPath).then(function(mod){
      THREE[name] = mod[name];
    });
  }
  function parsePLY(buf) {
    return _ensureLoader('PLYLoader', 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/loaders/PLYLoader.js')
      .then(function(){
        var geom = new THREE.PLYLoader().parse(buf);
        geom.computeBoundingBox();
        return geom;
      });
  }
  function parsePCD(buf) {
    return _ensureLoader('PCDLoader', 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/loaders/PCDLoader.js')
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

  // ── Centering helper (shared by ASCII parsers) ────────────────
  // Keeps survey-scale coords inside Float32 precision by recentring on
  // the bbox midpoint; the offset is stashed on geom.userData.lasOrigin so
  // the geoplace addon can restore real-world coords later.
  function _finishGeom(rawF64, colF32, ptCount) {
    var minX=Infinity, minY=Infinity, minZ=Infinity;
    var maxX=-Infinity, maxY=-Infinity, maxZ=-Infinity;
    for (var i = 0; i < ptCount; i++) {
      var x = rawF64[i*3], y = rawF64[i*3+1], z = rawF64[i*3+2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
    var pos = new Float32Array(ptCount * 3);
    for (var j = 0; j < ptCount; j++) {
      pos[j*3]   = rawF64[j*3]   - cx;
      pos[j*3+1] = rawF64[j*3+1] - cy;
      pos[j*3+2] = rawF64[j*3+2] - cz;
    }
    var geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (colF32) geom.setAttribute('color', new THREE.BufferAttribute(colF32, 3));
    geom.computeBoundingBox();
    geom.userData = geom.userData || {};
    geom.userData.lasOrigin = [cx, cy, cz];
    return geom;
  }

  // Leica PTS — ASCII point format. Spec (Leica/Cyclone):
  //   line 0: integer point count
  //   line N: x y z [intensity] [r g b]
  // intensity is an integer 0..255 (or sometimes -2048..2047 from older
  // Cyclone exports); RGB are 8-bit channels. We detect column count and
  // fall back gracefully if the header count is wrong (multi-scan PTS
  // files concatenate several headered blocks back-to-back).
  function parsePTS(buf) {
    var text = new TextDecoder('utf-8').decode(new Uint8Array(buf));
    var lines = text.split(/\r?\n/);
    // Two-pass: scan everything, then centre — same pattern as parseLAS.
    var raw = []; var col = []; var hasCol = false; var hasInt = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === '#') continue;
      var parts = line.split(/[\s,]+/);
      // Single-number lines are PTS section headers — skip them. A real
      // point row always has at least 3 columns.
      if (parts.length < 3) continue;
      var x = +parts[0], y = +parts[1], z = +parts[2];
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) continue;
      raw.push(x, y, z);
      if (parts.length >= 7) {
        // x y z intensity r g b
        hasCol = true; hasInt = true;
        col.push((+parts[4])/255, (+parts[5])/255, (+parts[6])/255);
      } else if (parts.length >= 6) {
        // x y z r g b
        hasCol = true;
        col.push((+parts[3])/255, (+parts[4])/255, (+parts[5])/255);
      } else if (parts.length === 4) {
        // x y z intensity → grayscale fallback so the cloud isn't flat
        hasCol = true; hasInt = true;
        var v = (+parts[3]);
        // Normalise both 0..255 and 0..1 conventions
        var g = v > 1 ? v / 255 : v;
        if (g < 0) g = 0; else if (g > 1) g = 1;
        col.push(g, g, g);
      }
    }
    var ptCount = raw.length / 3;
    var rawF64 = new Float64Array(raw);
    var colF32 = hasCol ? new Float32Array(col) : null;
    return Promise.resolve(_finishGeom(rawF64, colF32, ptCount));
  }

  // Leica PTX — gridded ASCII format. Spec (Leica/Cyclone):
  //   cols, rows                       ← scan-pattern dimensions
  //   sx sy sz                         ← scanner position
  //   rx ry rz                         ← scanner X-axis (right vector)
  //   ux uy uz                         ← scanner Y-axis (up vector)
  //   fx fy fz                         ← scanner Z-axis (forward vector)
  //   4 lines of 4 floats each         ← 4×4 transform matrix (column-major)
  //   x y z [intensity] [r g b]        ← rows*cols point lines
  // Missing returns are encoded as "0 0 0" (with intensity 0 and rgb 0 0 0
  // when present). Multiple scans can be concatenated back-to-back.
  function parsePTX(buf) {
    var text = new TextDecoder('utf-8').decode(new Uint8Array(buf));
    var lines = text.split(/\r?\n/);
    var raw = []; var col = []; var hasCol = false;
    var i = 0, N = lines.length;
    function nextNonEmpty() {
      while (i < N) {
        var ln = lines[i].trim();
        if (ln && ln.charAt(0) !== '#') return ln;
        i++;
      }
      return null;
    }
    var _mTmp = [0,0,0,0, 0,0,0,0, 0,0,0,0, 0,0,0,0];
    while (i < N) {
      var hdr = nextNonEmpty();
      if (hdr === null) break;
      var cols = parseInt(hdr, 10);
      i++;
      var rowsLine = nextNonEmpty();
      if (rowsLine === null) break;
      var rows = parseInt(rowsLine, 10);
      i++;
      if (!isFinite(cols) || !isFinite(rows) || cols <= 0 || rows <= 0) break;
      // Skip scanner position + 3 axis vectors (4 lines, 3 floats each — we
      // could expose these as metadata later).
      for (var sk = 0; sk < 4; sk++) { if (nextNonEmpty() === null) break; i++; }
      // Read 4x4 transform — column-major in the file.
      var mtxOK = true;
      for (var c = 0; c < 4; c++) {
        var mLine = nextNonEmpty();
        if (mLine === null) { mtxOK = false; break; }
        var ms = mLine.split(/[\s,]+/);
        if (ms.length < 4) { mtxOK = false; break; }
        _mTmp[c*4 + 0] = +ms[0];
        _mTmp[c*4 + 1] = +ms[1];
        _mTmp[c*4 + 2] = +ms[2];
        _mTmp[c*4 + 3] = +ms[3];
        i++;
      }
      if (!mtxOK) break;
      // Apply transform inline so the scan ends up in the file's declared
      // world frame. Column-major → row-major access for the multiply.
      function tx(x, y, z, m) {
        var w = m[3]*x + m[7]*y + m[11]*z + m[15];
        if (w === 0) w = 1;
        return [
          (m[0]*x + m[4]*y + m[8]*z  + m[12]) / w,
          (m[1]*x + m[5]*y + m[9]*z  + m[13]) / w,
          (m[2]*x + m[6]*y + m[10]*z + m[14]) / w
        ];
      }
      var expected = rows * cols;
      var read = 0;
      while (read < expected && i < N) {
        var pLine = lines[i].trim();
        i++;
        if (!pLine) { read++; continue; } // blank line = missing return
        var parts = pLine.split(/[\s,]+/);
        if (parts.length < 3) { read++; continue; }
        var px = +parts[0], py = +parts[1], pz = +parts[2];
        read++;
        if (!isFinite(px) || !isFinite(py) || !isFinite(pz)) continue;
        // Encoded missing return — Leica writes 0,0,0,0,0,0,0 for no-hit pixels
        if (px === 0 && py === 0 && pz === 0) continue;
        var w = tx(px, py, pz, _mTmp);
        raw.push(w[0], w[1], w[2]);
        if (parts.length >= 7) {
          // x y z intensity r g b
          hasCol = true;
          col.push((+parts[4])/255, (+parts[5])/255, (+parts[6])/255);
        } else if (parts.length >= 6) {
          // x y z r g b
          hasCol = true;
          col.push((+parts[3])/255, (+parts[4])/255, (+parts[5])/255);
        } else if (parts.length === 4) {
          // x y z intensity → grayscale
          hasCol = true;
          var v = (+parts[3]);
          var g = v > 1 ? v / 255 : v;
          if (g < 0) g = 0; else if (g > 1) g = 1;
          col.push(g, g, g);
        } else if (hasCol) {
          // Keep colour buffer aligned with positions if some lines lack RGB.
          col.push(1, 1, 1);
        }
      }
    }
    var ptCount = raw.length / 3;
    var rawF64 = new Float64Array(raw);
    var colF32 = hasCol ? new Float32Array(col) : null;
    return Promise.resolve(_finishGeom(rawF64, colF32, ptCount));
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
      if (ext === 'xyz' || ext === 'txt') return parseXYZ(buf);
      if (ext === 'pts') return parsePTS(buf);
      if (ext === 'ptx') return parsePTX(buf);
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

  // Reference layers are per-project scene content — drop them on project
  // switch (same policy as tiles.js/geoplace.js) so project A's scans don't
  // bleed into project B or accumulate GPU memory across switches.
  window.addEventListener('cc-project-switch', function() {
    try { Object.keys(_objects).forEach(function(id){ window._ccRemovePointCloud(id); }); } catch(_){}
  });

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
