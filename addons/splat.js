// ClashControl splat addon — Gaussian Splat as-built overlay (Phase 1 spike).
//
// Architecture: this addon is **isolated** from the core's Three.js r128.
// It lazy-loads modern Three.js + Spark.js as ESM **only when the user
// actually loads a splat**, mounts its own WebGL canvas as a sibling DOM
// element overlaid on the main canvas, and mirrors the core's camera each
// frame. The core never sees a different Three version — addon failures
// can't break the IFC viewer.
//
// Trigger: window._ccLoadSplat(url|file, {name, opacity}). On first call,
// the modern-Three + Spark bundles are fetched; subsequent calls reuse the
// loaded modules. Sibling canvas auto-attaches under the main 3D canvas;
// removed when _ccUnloadSplats() is called or the last splat is dropped.
//
// Composition: splat canvas sits BELOW the IFC canvas in the DOM stack
// (z-index lower). The IFC canvas's background is set transparent when
// splats are active. This gives "as-built ground + design model" overlay
// without depth-interleaving (which two GL contexts can't do anyway).
//
// Phase 1 goal: confirm camera-sync feels right at IFC scales. If green,
// Phase 2 adds 3D Tiles streaming + Esri Site Scan tileset URLs.
//
// Supported inputs: .splat, .ply, .ksplat, .spz (Spark handles all). No
// 3D-Tiles tileset.json streaming yet — Phase 2.

(function(){
  if (typeof window === 'undefined') return;

  // ─── Module imports (lazy, one-time) ──────────────────────────────────────
  // Modern Three.js + Spark's unbundled ESM main. The import map declared in
  // index.html head maps the bare specifier 'three' to THREE_URL, so when
  // Spark's source does `import * as THREE from 'three'`, it resolves to the
  // same module instance we await here — one THREE singleton, no duplicate
  // bundle, no "Multiple instances of Three.js" warning.
  //
  // We deliberately AVOID jsdelivr's `/+esm` endpoint: that variant pre-
  // bundles every dependency (including Three), which makes the import map
  // moot and bloats the download. The package's `module` entry is the right
  // build to use.
  // ~600 KB Three + ~200 KB Spark, both edge-cached. Lazy: only fetched
  // when the user actually loads a splat.
  var THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js';
  var SPARK_URL = 'https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@2.0.0/dist/spark.module.js';

  var _modules = null; // { THREE, Spark } once loaded
  var _loadingP = null;

  function _loadModules() {
    if (_modules) return Promise.resolve(_modules);
    if (_loadingP) return _loadingP;
    _loadingP = (async function(){
      // Load THREE first so Spark's `import 'three'` resolves the already-
      // cached module via the document-level import map.
      var THREE = await import(/* @vite-ignore */ THREE_URL);
      var Spark = await import(/* @vite-ignore */ SPARK_URL);
      _modules = { THREE: THREE, Spark: Spark };
      return _modules;
    })();
    return _loadingP;
  }

  // ─── Sibling canvas + isolated renderer ───────────────────────────────────
  var _viewer = null; // { canvas, renderer, scene, camera, splats: [] }

  function _ensureViewer() {
    if (_viewer) return Promise.resolve(_viewer);
    return _loadModules().then(function(mods){
      var THREE = mods.THREE;
      var mainCanvas = document.getElementById('cc-canvas')
        || (window._ccState3d && window._ccState3d.renderer && window._ccState3d.renderer.domElement);
      if (!mainCanvas) throw new Error('Main 3D canvas not found');

      var canvas = document.createElement('canvas');
      canvas.id = 'cc-splat-canvas';
      // Sit BEHIND the IFC canvas so model elements always render on top.
      // pointer-events:none lets clicks/orbit fall through to the IFC layer.
      var s = canvas.style;
      s.position = 'absolute';
      s.left = '0'; s.top = '0';
      s.width = '100%'; s.height = '100%';
      s.zIndex = '0';
      s.pointerEvents = 'none';
      mainCanvas.parentElement.insertBefore(canvas, mainCanvas);

      // Make the IFC canvas transparent so splats show through behind it.
      // We restore the original on unload.
      _viewer = { _origMainBg: mainCanvas.style.background || '' };
      mainCanvas.style.background = 'transparent';
      // Also clear the THREE renderer's clear-color so the IFC scene draws
      // with alpha; the splat layer is the actual background.
      try {
        if (window._ccState3d && window._ccState3d.renderer) {
          var r = window._ccState3d.renderer;
          r.setClearColor(0x000000, 0); // RGBA(0,0,0,0)
          r.setClearAlpha(0);
          if (window._ccState3d.scene) window._ccState3d.scene.background = null;
          if (window._ccInvalidate) window._ccInvalidate(2);
        }
      } catch(_){}

      var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(window.devicePixelRatio || 1);
      renderer.setSize(mainCanvas.clientWidth, mainCanvas.clientHeight, false);
      renderer.setClearColor(0x141414, 1); // dark background for the splat layer

      var scene = new THREE.Scene();
      var cam = (window._ccViewport && window._ccViewport.getCamera()) || null;
      var fov = cam ? cam.fov : 55;
      var aspect = cam ? cam.aspect : (mainCanvas.clientWidth / mainCanvas.clientHeight);
      var camera = new THREE.PerspectiveCamera(fov, aspect, 0.01, 100000);

      _viewer.canvas = canvas;
      _viewer.renderer = renderer;
      _viewer.scene = scene;
      _viewer.camera = camera;
      _viewer.splats = [];
      _viewer.mainCanvas = mainCanvas;

      // Resize tracker — match the main canvas size each frame (cheap; the
      // setSize call short-circuits when dimensions haven't changed).
      _viewer._lastW = mainCanvas.clientWidth;
      _viewer._lastH = mainCanvas.clientHeight;

      // Listen to the core's per-frame event. The IFC viewer renders on
      // demand (_needsRender), so this fires only when there's actually
      // something to update — no idle-frame waste.
      window._ccHasSplats = true;
      _viewer._onFrame = function(){ _syncAndRender(); };
      window.addEventListener('cc-render-frame', _viewer._onFrame);
      // Also drive an initial render so the user sees the splat immediately
      // even before they touch the camera.
      requestAnimationFrame(_syncAndRender);
      return _viewer;
    });
  }

  function _syncAndRender() {
    if (!_viewer) return;
    var cam = window._ccViewport && window._ccViewport.getCamera();
    if (!cam) return;
    var c = _viewer.camera, r = _viewer.renderer, mc = _viewer.mainCanvas;
    // Mirror core camera state
    c.position.set(cam.position[0], cam.position[1], cam.position[2]);
    c.up.set(cam.up[0], cam.up[1], cam.up[2]);
    c.lookAt(cam.target[0], cam.target[1], cam.target[2]);
    if (cam.fov && c.fov !== cam.fov) { c.fov = cam.fov; c.updateProjectionMatrix(); }
    if (cam.aspect && Math.abs(c.aspect - cam.aspect) > 1e-4) { c.aspect = cam.aspect; c.updateProjectionMatrix(); }
    // Resize if the main canvas changed dimensions
    var w = mc.clientWidth, h = mc.clientHeight;
    if (w !== _viewer._lastW || h !== _viewer._lastH) {
      r.setSize(w, h, false);
      c.aspect = w / h; c.updateProjectionMatrix();
      _viewer._lastW = w; _viewer._lastH = h;
    }
    r.render(_viewer.scene, c);
  }

  // ─── Public API ───────────────────────────────────────────────────────────
  // Load a splat from a URL or File. Resolves with {id, name} once visible.
  window._ccLoadSplat = function(src, opts) {
    opts = opts || {};
    return _ensureViewer().then(function(v){
      var Spark = _modules.Spark;
      // Spark exposes a SplatMesh constructor that takes a URL or ArrayBuffer.
      // We support both File (drag-drop) and string URL.
      var SplatMesh = Spark.SplatMesh || Spark.default && Spark.default.SplatMesh;
      if (!SplatMesh) throw new Error('Spark SplatMesh not available');
      var url;
      if (typeof src === 'string') url = src;
      else if (src && src.name) url = URL.createObjectURL(src);
      else throw new Error('Splat source must be a URL string or File');

      var mesh = new SplatMesh({ url: url });
      if (opts.opacity != null) mesh.opacity = opts.opacity;
      // Default-position at the IFC's bbox center. Splats are at world
      // origin in their own coord system; without this they're invisible
      // for any georeferenced IFC (e.g. Dutch RD ~85km offset, US state
      // plane, anything in EPSG-projected meters). User can override with
      // opts.position to place arbitrarily.
      var pos = opts.position;
      if (!pos && window._ccViewport && window._ccViewport.getBounds) {
        var b = window._ccViewport.getBounds();
        if (b && b.center) pos = b.center;
      }
      if (pos && pos.length === 3) mesh.position.set(pos[0], pos[1], pos[2]);
      v.scene.add(mesh);
      var id = 'splat-' + Date.now() + '-' + Math.floor(Math.random()*9999);
      v.splats.push({ id: id, mesh: mesh, name: opts.name || (typeof src === 'string' ? src.split('/').pop() : src.name) });
      requestAnimationFrame(_syncAndRender);
      if (window._ccToast) window._ccToast('Loading splat ' + (opts.name || ''));
      return { id: id, name: opts.name };
    }).catch(function(err){
      console.error('[splat] load failed', err);
      if (window._ccToast) window._ccToast('Splat load failed: ' + (err.message || err));
      throw err;
    });
  };

  // Remove a single splat by id, or all splats if no id given.
  window._ccUnloadSplats = function(id) {
    if (!_viewer) return;
    var keep = [];
    _viewer.splats.forEach(function(s){
      if (id && s.id !== id) { keep.push(s); return; }
      try { _viewer.scene.remove(s.mesh); if (s.mesh.dispose) s.mesh.dispose(); } catch(_){}
    });
    _viewer.splats = keep;
    if (!_viewer.splats.length) _destroyViewer();
    else requestAnimationFrame(_syncAndRender);
  };

  function _destroyViewer() {
    if (!_viewer) return;
    window.removeEventListener('cc-render-frame', _viewer._onFrame);
    window._ccHasSplats = false;
    try { _viewer.renderer.dispose(); } catch(_){}
    if (_viewer.canvas && _viewer.canvas.parentElement) _viewer.canvas.parentElement.removeChild(_viewer.canvas);
    if (_viewer.mainCanvas) _viewer.mainCanvas.style.background = _viewer._origMainBg || '';
    try {
      if (window._ccState3d && window._ccState3d.renderer) {
        // Restore the core's original clear so the IFC viewer looks normal
        // again. The exact value comes from elsewhere; setting white-on-light
        // is a reasonable default that matches our boot palette.
        var theme = (window._ccLatestState && window._ccLatestState.prefs && window._ccLatestState.prefs.theme) || 'light';
        var bg = theme === 'light' ? 0xfafafa : 0x141414;
        window._ccState3d.renderer.setClearColor(bg, 1);
        if (window._ccState3d.scene) window._ccState3d.scene.background = new (window.THREE.Color)(bg);
        if (window._ccInvalidate) window._ccInvalidate(2);
      }
    } catch(_){}
    _viewer = null;
  }

  // Quick query helper for the UI / NL layer
  window._ccListSplats = function() {
    if (!_viewer) return [];
    return _viewer.splats.map(function(s){ return { id:s.id, name:s.name }; });
  };

  // Self-test on demand: hit Spark's own public sample. Useful for the spike.
  // Not wired into any UI — call from console: _ccTestSplat().
  // (The previous HuggingFace bicycle URL returned 404 — using Spark's hosted
  //  butterfly.spz which they publish as the documentation example. Stable as
  //  long as their docs are up.)
  window._ccTestSplat = function() {
    return window._ccLoadSplat(
      'https://sparkjs.dev/assets/splats/butterfly.spz',
      { name: 'butterfly (Spark sample)' }
    );
  };

  if (typeof window._ccRegisterAddon === 'function') {
    window._ccRegisterAddon({ id: 'splat', name: 'Gaussian Splat overlay', description: 'Load 3D Gaussian Splat as-built captures as a reference layer (.splat/.ply/.ksplat/.spz). Renders on a sibling canvas behind the IFC model. Phase 1: drag-drop or URL only; 3D Tiles streaming + Esri ingest in Phase 2.' });
  }
})();
