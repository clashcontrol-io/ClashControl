(function(root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root._ccRendererContract = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  function configure(renderer, THREE, options) {
    options = options || {};
    renderer.setPixelRatio(options.pixelRatio);
    renderer.setSize(options.width, options.height);
    renderer.localClippingEnabled = false;
    options.setSRGBOutput(renderer);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;
    renderer.physicallyCorrectLights = true;
    return renderer;
  }

  function snapshot(renderer, THREE, expectedDpr) {
    var actualDpr = null;
    try { actualDpr = renderer.getPixelRatio(); } catch (_) {}
    return {
      domElement: !!renderer.domElement,
      pixelRatio: actualDpr,
      expectedPixelRatio: expectedDpr,
      localClippingEnabled: renderer.localClippingEnabled === true,
      srgb: renderer.outputColorSpace === THREE.SRGBColorSpace,
      aces: renderer.toneMapping === THREE.ACESFilmicToneMapping,
      exposure: renderer.toneMappingExposure,
      shadows: !!(renderer.shadowMap && renderer.shadowMap.enabled),
      shadowType: renderer.shadowMap && renderer.shadowMap.type,
      expectedShadowType: THREE.PCFShadowMap,
      shadowAutoUpdate: renderer.shadowMap && renderer.shadowMap.autoUpdate,
      physicallyCorrectLights: renderer.physicallyCorrectLights === true
    };
  }

  function validate(state) {
    var failures = [];
    if (!state.domElement) failures.push('dom-element');
    if (state.pixelRatio !== state.expectedPixelRatio) failures.push('pixel-ratio');
    // Initial clipping must be disabled; section/floor-plan effects own it.
    if (state.localClippingEnabled) failures.push('initial-clipping');
    if (!state.srgb) failures.push('color-space');
    if (!state.aces) failures.push('tone-mapping');
    if (state.exposure !== 1) failures.push('exposure');
    if (!state.shadows) failures.push('shadows');
    if (state.shadowType !== state.expectedShadowType) failures.push('shadow-type');
    if (state.shadowAutoUpdate !== false) failures.push('shadow-auto-update');
    if (!state.physicallyCorrectLights) failures.push('physical-lights');
    return { equal:failures.length === 0, failures:failures };
  }

  function createCandidate(options) {
    var renderer = new options.THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance'
    });
    configure(renderer, options.THREE, options);
    return renderer;
  }

  function createGuarded(options) {
    var candidate = null;
    try {
      // Construct here (rather than assigning createCandidate's return) so a
      // partially configured WebGL context can still be disposed if a setter
      // throws before the factory returns.
      candidate = new options.THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance'
      });
      configure(candidate, options.THREE, options);
      var state = snapshot(candidate, options.THREE, options.pixelRatio);
      var comparison = validate(state);
      if (!comparison.equal) {
        if (options.record) options.record({outcome:'mismatch', comparison:comparison, state:state});
        try { candidate.dispose(); } catch (_) {}
        return { path:'fallback', renderer:options.legacy(), comparison:comparison, state:state };
      }
      if (options.record) options.record({outcome:'candidate', state:state});
      return { path:'candidate', renderer:candidate, comparison:comparison, state:state };
    } catch (error) {
      try { if (candidate) candidate.dispose(); } catch (_) {}
      if (options.record) options.record({outcome:'fallback', error:String(error && error.message || error)});
      return { path:'fallback', renderer:options.legacy(), error:error };
    }
  }

  return Object.freeze({
    configure: configure,
    snapshot: snapshot,
    validate: validate,
    createCandidate: createCandidate,
    createGuarded: createGuarded
  });
}));
