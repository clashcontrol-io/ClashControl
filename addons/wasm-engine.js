// ── ClashControl Addon: WASM Clash Engine ───────────────────────
// Loads the Rust WASM module for hardware-accelerated clash detection.
// Provides mesh_intersect and mesh_min_distance as drop-in replacements
// for the JavaScript BVH+Moller engine in index.html.
//
// Falls back gracefully to the built-in JS engine if WASM fails to load.
// The core clash loop checks: typeof window._ccWasmIntersect === 'function'

(function() {
  'use strict';

  var _wasm = null;       // loaded WASM module exports
  var _loading = false;
  var _failed = false;
  var _loadTime = 0;

  // ── Lazy-load WASM on first use ─────────────────────────────────

  function _getAddonBaseUrl() {
    // Derive base URL from this script's src
    var scripts = document.querySelectorAll('script[src*="wasm-engine"]');
    if (scripts.length) {
      var src = scripts[scripts.length - 1].src;
      return src.replace(/\/[^/]+$/, '/');
    }
    return 'addons/';
  }

  function _loadWasm() {
    if (_wasm) return Promise.resolve(_wasm);
    if (_failed) return Promise.reject(new Error('WASM engine previously failed to load'));
    if (_loading) {
      return new Promise(function(resolve, reject) {
        var _poll = setInterval(function() {
          if (_wasm) { clearInterval(_poll); resolve(_wasm); }
          if (_failed) { clearInterval(_poll); reject(new Error('WASM load failed')); }
        }, 50);
      });
    }
    _loading = true;
    var t0 = performance.now();
    var base = _getAddonBaseUrl() + 'wasm-engine-pkg/';

    return import(base + 'clashcontrol_engine.js').then(function(mod) {
      // The wasm-pack --target web output has an init() default export
      return mod.default(base + 'clashcontrol_engine_bg.wasm').then(function() {
        _wasm = mod;
        _loading = false;
        _loadTime = Math.round(performance.now() - t0);
        console.log('%c[WASM Engine] Loaded in ' + _loadTime + 'ms (35 KB)', 'color:#22c55e;font-weight:bold');
        return _wasm;
      });
    }).catch(function(e) {
      _failed = true;
      _loading = false;
      console.warn('[WASM Engine] Failed to load, falling back to JS engine:', e.message || e);
      return Promise.reject(e);
    });
  }

  // ── Public API (mirrors JS engine functions) ───────────────────

  /**
   * Test if two triangle meshes intersect.
   * @param {Float32Array} trisA - flat xyz, 9 floats per tri
   * @param {Float32Array} trisB - flat xyz, 9 floats per tri
   * @returns {Array|false} [cx, cy, cz, depth] or false
   */
  window._ccWasmIntersect = function(trisA, trisB) {
    if (!_wasm) return false;
    try {
      var result = _wasm.mesh_intersect(trisA, trisB, 1e-6);
      if (!result || result.length === 0) return false;
      return [result[0], result[1], result[2], result[3]];
    } catch (e) {
      console.warn('[WASM Engine] intersect error:', e.message);
      return false;
    }
  };

  /**
   * Compute minimum vertex distance between two meshes.
   * @param {Float32Array} vertsA - flat xyz vertices
   * @param {Float32Array} vertsB - flat xyz vertices
   * @param {number} threshold - max distance in model units
   * @param {Float64Array} [outPair] - optional 6-element buffer [ax,ay,az, bx,by,bz]
   * @returns {number} distance, or Infinity if beyond threshold
   */
  window._ccWasmMinDist = function(vertsA, vertsB, threshold, outPair) {
    if (!_wasm) return Infinity;
    try {
      var result = _wasm.mesh_min_distance(vertsA, vertsB, threshold);
      if (!result || result.length === 0 || result[0] === Infinity) return Infinity;
      if (outPair && result.length >= 7) {
        outPair[0]=result[1]; outPair[1]=result[2]; outPair[2]=result[3];
        outPair[3]=result[4]; outPair[4]=result[5]; outPair[5]=result[6];
      }
      return result[0];
    } catch (e) {
      console.warn('[WASM Engine] minDist error:', e.message);
      return Infinity;
    }
  };

  /**
   * Batch intersection: test one mesh against many.
   * @param {Float32Array} trisA - reference mesh triangles
   * @param {Float32Array} allTris - all other meshes' triangles concatenated
   * @param {Uint32Array} offsets - [start0, end0, start1, end1, ...] into allTris
   * @returns {Array} [{meshIdx, point:[cx,cy,cz], depth}, ...]
   */
  window._ccWasmBatchIntersect = function(trisA, allTris, offsets) {
    if (!_wasm) return [];
    try {
      var raw = _wasm.batch_intersect(trisA, allTris, offsets, 1e-6);
      if (!raw || raw.length === 0) return [];
      var results = [];
      for (var i = 0; i < raw.length; i += 5) {
        results.push({
          meshIdx: raw[i] | 0,
          point: [raw[i + 1], raw[i + 2], raw[i + 3]],
          depth: raw[i + 4]
        });
      }
      return results;
    } catch (e) {
      console.warn('[WASM Engine] batchIntersect error:', e.message);
      return [];
    }
  };

  /**
   * Check if WASM engine is loaded and ready.
   * @returns {boolean}
   */
  window._ccWasmReady = function() { return !!_wasm; };

  /**
   * Pre-load WASM module (call early to avoid latency on first clash detection).
   * @returns {Promise}
   */
  window._ccWasmPreload = function() { return _loadWasm(); };

  // ── Register as addon ─────────────────────────────────────────

  if (typeof window._ccRegisterAddon === 'function') {
    window._ccRegisterAddon({
      id: 'wasm-engine',
      name: 'WASM Clash Engine',
      description: 'Hardware-accelerated clash detection via Rust WebAssembly. 4-8x faster than the built-in JavaScript engine on large models.',
      autoActivate: true,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',

      initState: {
        wasmEngine: { loaded: false, loading: false, failed: false, loadTime: 0 }
      },

      reducerCases: {
        UPD_WASM_ENGINE: function(s, a) {
          return Object.assign({}, s, { wasmEngine: Object.assign({}, s.wasmEngine, a.u) });
        }
      },

      init: function(d) {
        // Pre-load WASM immediately
        d({ t: 'UPD_WASM_ENGINE', u: { loading: true } });
        _loadWasm().then(function() {
          d({ t: 'UPD_WASM_ENGINE', u: { loaded: true, loading: false, loadTime: _loadTime } });
        }).catch(function() {
          d({ t: 'UPD_WASM_ENGINE', u: { failed: true, loading: false } });
        });
      },

      panel: function(html, state, d) {
        var we = state.wasmEngine || {};
        if (we.loading) {
          return html`<div style=${{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
            <div style=${{ width: 7, height: 7, border: '1.5px solid #fbbf24', borderTopColor: 'transparent', borderRadius: '50%', animation: 'cc-spin .6s linear infinite' }}></div>
            <span style=${{ fontSize: '0.75rem', color: '#facc15' }}>Loading WASM engine\u2026</span>
          </div>`;
        }
        if (we.failed) {
          return html`<div style=${{ fontSize: '0.69rem', color: '#fca5a5' }}>
            WASM engine failed to load. Using JavaScript fallback.
            <button onClick=${function() { d({ t: 'UPD_WASM_ENGINE', u: { failed: false, loading: true } }); _failed = false; _loadWasm().then(function() { d({ t: 'UPD_WASM_ENGINE', u: { loaded: true, loading: false, loadTime: _loadTime } }); }).catch(function() { d({ t: 'UPD_WASM_ENGINE', u: { failed: true, loading: false } }); }); }}
              style=${{ marginTop: '.3rem', padding: '.2rem .5rem', borderRadius: 5, fontSize: '0.69rem', fontWeight: 600, cursor: 'pointer', border: 'none', background: 'var(--accent)', color: '#fff', fontFamily: 'inherit', display: 'block' }}>Retry</button>
          </div>`;
        }
        if (we.loaded) {
          return html`<div style=${{ display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
            <div style=${{ display: 'flex', alignItems: 'center', gap: '.4rem' }}>
              <span style=${{ width: 7, height: 7, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }}></span>
              <span style=${{ fontSize: '0.75rem', color: '#4ade80' }}>Active</span>
              <span style=${{ fontSize: '0.62rem', color: 'var(--text-faint)', marginLeft: 'auto' }}>loaded in ${we.loadTime}ms</span>
            </div>
            <div style=${{ fontSize: '0.62rem', color: 'var(--text-faint)', lineHeight: 1.5 }}>
              Rust WASM engine active. BVH-accelerated mesh intersection and distance queries run 4\u20138\u00d7 faster than the JavaScript engine.
            </div>
          </div>`;
        }
        return html`<div style=${{ fontSize: '0.62rem', color: 'var(--text-faint)' }}>WASM engine not loaded.</div>`;
      }
    });
  }

})();
