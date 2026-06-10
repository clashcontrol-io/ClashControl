// ClashControl splat addon — Gaussian Splat as first-class scene member.
//
// Post-bump architecture (Three.js r180): Spark's SplatMesh is now a
// THREE.Object3D that joins the same scene as the IFC meshes, the point
// clouds, and everything else. Depth-interleaves correctly, click-
// selectable, panel-grouped — same first-class treatment as point clouds.
//
// The sibling-canvas pattern from the pre-bump spike has been retired:
// one renderer, one scene, one camera, depth-mixed at the GPU. No
// camera-mirror loop, no transparent IFC hack, no z-index stacking.
//
// Trigger: window._ccLoadSplat(url|file, opts). On first call, lazy-loads
// Spark (Three is already loaded by the core); subsequent calls reuse.
//
// Supported inputs: .splat, .ply, .ksplat, .spz (Spark detects by ext).

(function(){
  if (typeof window === 'undefined') return;

  var SPARK_URL = 'https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@2.0.0/dist/spark.module.js';

  var _spark = null;       // Spark module, loaded once
  var _loadingP = null;
  var _splats = [];        // [{id, mesh, name, source}]
  var _splatGroup = null;  // THREE.Group parent for all splats, added to scene
  var _renderHookInstalled = false;

  function _loadSpark() {
    if (_spark) return Promise.resolve(_spark);
    if (_loadingP) return _loadingP;
    _loadingP = import(/* @vite-ignore */ SPARK_URL).then(function(mod){
      _spark = mod;
      return mod;
    });
    return _loadingP;
  }

  function _scene() {
    return (window._ccState3d && window._ccState3d.scene) || null;
  }
  function _invalidate(n) {
    if (typeof window._ccInvalidate === 'function') window._ccInvalidate(n||2);
  }

  // Spark's SplatMesh expects its per-frame hook to run each frame so it
  // can stream LoDs and re-sort splats by camera distance. The Spark API
  // method is `frameUpdate(camera, renderer)` — earlier code called
  // `mesh.update(...)` which doesn't exist (SplatMesh extends Object3D so
  // .update isn't there). Result: splats loaded with N gaussians but
  // never produced visible output. Probe both names so we survive future
  // Spark API renames without another silent invisibility regression.
  function _ensureRenderHook() {
    if (_renderHookInstalled) return;
    window.addEventListener('cc-render-frame', function(){
      if (!_splats.length) return;
      var s3 = window._ccState3d;
      if (!s3 || !s3.camera || !s3.renderer) return;
      for (var i = 0; i < _splats.length; i++) {
        var m = _splats[i].mesh;
        if (!m) continue;
        try {
          if (typeof m.frameUpdate === 'function') m.frameUpdate(s3.camera, s3.renderer);
          else if (typeof m.update === 'function')  m.update(s3.camera, s3.renderer);
        } catch(_){}
      }
    });
    _renderHookInstalled = true;
  }

  function _ensureGroup() {
    if (_splatGroup) return _splatGroup;
    var sc = _scene(); if (!sc) return null;
    _splatGroup = new (window.THREE.Group)();
    _splatGroup.name = 'cc-splat-layers';
    _splatGroup.userData.isSplatLayer = true;
    sc.add(_splatGroup);
    return _splatGroup;
  }

  // Public: load a splat (URL string or File) into the IFC scene.
  window._ccLoadSplat = function(src, opts) {
    opts = opts || {};
    return _loadSpark().then(function(mod){
      var grp = _ensureGroup();
      if (!grp) throw new Error('Scene not ready');
      _ensureRenderHook();

      var SplatMesh = mod.SplatMesh || (mod.default && mod.default.SplatMesh);
      if (!SplatMesh) throw new Error('Spark SplatMesh not available');

      var url;
      if (typeof src === 'string') url = src;
      else if (src && src.name) url = URL.createObjectURL(src);
      else throw new Error('Splat source must be a URL string or File');

      var mesh = new SplatMesh({ url: url });
      mesh.name = opts.name || (typeof src === 'string' ? src.split('/').pop() : src.name);
      if (opts.opacity != null) mesh.opacity = opts.opacity;

      // Default-position at the IFC bbox center so georef'd models (Dutch
      // RD ~85 km offset, US state plane, etc.) don't render the splat in
      // a different world from the camera. Override with opts.position.
      var pos = opts.position;
      if (!pos && window._ccViewport && window._ccViewport.getBounds) {
        var b = window._ccViewport.getBounds();
        if (b && b.center) pos = b.center;
      }
      if (pos && pos.length === 3) mesh.position.set(pos[0], pos[1], pos[2]);
      if (opts.scale != null) {
        if (typeof opts.scale === 'number') mesh.scale.setScalar(opts.scale);
        else if (opts.scale.length === 3) mesh.scale.set(opts.scale[0], opts.scale[1], opts.scale[2]);
      }
      if (opts.rotation && opts.rotation.length === 3) mesh.rotation.set(opts.rotation[0], opts.rotation[1], opts.rotation[2]);

      // Tag for selection/inspector/click pipelines downstream — keeps
      // splats out of clash detection (no geometry the engine can use)
      // while still being scene-graph members the viewer can manage.
      mesh.userData.isSplat = true;
      mesh.userData._ccSplatId = 'splat-' + Date.now() + '-' + Math.floor(Math.random()*9999);

      grp.add(mesh);
      _splats.push({ id: mesh.userData._ccSplatId, mesh: mesh, name: mesh.name, source: typeof src === 'string' ? src : (src.name || '(file)') });
      // Flip the gate the core render loop checks before dispatching
      // cc-render-frame. Without this, Spark's mesh.update(camera, renderer)
      // never gets called once the post-load invalidate-kick loop expires,
      // and the splat freezes mid-stream / never re-sorts on camera move.
      window._ccHasSplats = true;
      // Spark streams the splat asynchronously (fetch + WASM decode + LoD
      // pyramid). The core viewer is render-on-demand, so a one-shot
      // invalidate after add() doesn't catch the LoD frames that arrive
      // 5–10 s later. Kick invalidation every animation frame for 15 s
      // after load so each LoD reaches the screen as it becomes available.
      var deadline = Date.now() + 15000;
      (function _kick(){
        if (!_splats.length || Date.now() > deadline) return;
        _invalidate(2);
        requestAnimationFrame(_kick);
      })();
      if (window._ccToast) window._ccToast('Loading splat ' + mesh.name);
      try { window.dispatchEvent(new CustomEvent('cc-splats-changed')); } catch(_){}
      return { id: mesh.userData._ccSplatId, name: mesh.name };
    }).catch(function(err){
      console.error('[splat] load failed', err);
      if (window._ccToast) window._ccToast('Splat load failed: ' + (err.message || err));
      throw err;
    });
  };

  // Remove one (by id) or all splats.
  window._ccUnloadSplats = function(id) {
    var keep = [];
    _splats.forEach(function(s){
      if (id && s.id !== id) { keep.push(s); return; }
      try {
        if (s.mesh.parent) s.mesh.parent.remove(s.mesh);
        if (typeof s.mesh.dispose === 'function') s.mesh.dispose();
      } catch(_){}
    });
    _splats = keep;
    if (!_splats.length && _splatGroup && _splatGroup.parent) {
      _splatGroup.parent.remove(_splatGroup);
      _splatGroup = null;
      window._ccHasSplats = false;
    }
    _invalidate(3);
    try { window.dispatchEvent(new CustomEvent('cc-splats-changed')); } catch(_){}
  };

  window._ccListSplats = function() {
    return _splats.map(function(s){ return { id:s.id, name:s.name, source:s.source }; });
  };

  // Self-test on demand: Spark's hosted butterfly. Stable while their
  // docs are up. Useful for spike validation; not wired into any UI.
  window._ccTestSplat = function() {
    return window._ccLoadSplat(
      'https://sparkjs.dev/assets/splats/butterfly.spz',
      { name: 'butterfly (Spark sample)' }
    );
  };

  if (typeof window._ccRegisterAddon === 'function') {
    window._ccRegisterAddon({ id: 'splat', alwaysOn: true, name: 'Gaussian Splat overlay', description: 'Load 3D Gaussian Splat as-built captures as a first-class scene member alongside IFC and point clouds. Supports .splat/.ply/.ksplat/.spz. Phase 1: drag-drop or URL; 3D Tiles streaming + Esri ingest in Phase 2.' });
  }
})();
