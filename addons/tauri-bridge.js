// ── ClashControl Addon: Tauri native clash engine ────────────────
// Inert in the browser. Inside the ClashControl desktop app (Tauri, see
// docs/TAURI.md Phase 2) this connects the core's narrow-phase worker-pool
// layer to the multi-core Rust engine behind the Tauri commands in
// desktop/src-tauri/src/engine_cmds.rs — the SAME BVH + Moller code the WASM
// addon runs, so results are bit-identical to the browser.
//
// Trust model (identical to addons/wasm-engine.js): before anything is
// published, the native commands are diffed against the pure-JS reference
// (window._ccJsMeshIntersectRef) on fixed cases — hard hit/miss, every raw
// point, depth, min-distance and closest pair, batch ordering, unknown ids.
// Only after ALL cases match is `window._ccNativeNarrow` published; the core
// (index.html, _ccNarrowPoolCreate) then uses it in place of the Web Worker
// pool. Any IPC/decode/protocol error drops the run's pool (the core finishes
// the remaining pairs on the main thread with WASM/JS) and unpublishes the
// native path for the rest of the session.
//
// Wire format (little-endian, raw bytes, see engine/src/native.rs `wire`):
//   register_meshes  body [u32 n][n x (u32 id, u32 nFloats)][f32 data...] -> n
//   intersect_batch / min_dist_batch  body [u32 a,u32 b]*m -> f64 stream
//        [m][k_0, v_0...][k_1, v_1...]...  (k = -1: an id was not registered)
//   engine_info -> {api, threads, meshes, floats, ...}
// Core contract consumed: a pool object shaped like the worker pool
// ({dead, ready, readyP, results:Map, stats, addWindow, terminate, fail}),
// records Float64Array(12): [status(b0 hard done, b1 hard hit, b2 soft done),
// hx,hy,hz,hDepth, dist, p0..p5].

(function() {
  'use strict';

  var API_VERSION = 1;
  var CALL_TIMEOUT_MS = 300000;
  var REGISTER_CHUNK_FLOATS = 8 * 1024 * 1024;   // ~32 MB per register call
  var REGISTRY_RESET_FLOATS = 96 * 1024 * 1024;  // ~384 MB resident in Rust: reset between runs
  var DROP_FLUSH_MAX = 512;

  function _tauriInvoke() {
    try {
      var i = window.__TAURI_INTERNALS__;
      if (i && typeof i.invoke === 'function') return i.invoke.bind(i);
      var t = window.__TAURI__;
      if (t && t.core && typeof t.core.invoke === 'function') return t.core.invoke.bind(t.core);
    } catch (e) { /* not in Tauri */ }
    return null;
  }
  var _invokeRaw = _tauriInvoke();
  if (!_invokeRaw) return; // plain browser: nothing to do, nothing registered
  if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) return; // wire format is little-endian

  var _failed = false;      // native path permanently off for this session
  var _published = false;
  var _info = null;
  var _selfCheckMs = 0;
  var _gate = Promise.resolve(); // serialises registry-touching work across runs

  function _invoke(cmd, args, options) {
    return new Promise(function(resolve, reject) {
      var done = false;
      var timer = setTimeout(function() { if (!done) { done = true; reject(new Error(cmd + ' timed out')); } }, CALL_TIMEOUT_MS);
      var p;
      try { p = _invokeRaw(cmd, args, options); } catch (e) { clearTimeout(timer); reject(e); return; }
      Promise.resolve(p).then(function(v) { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
        function(e) { if (!done) { done = true; clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); } });
    });
  }
  function _asBuffer(r) {
    if (r instanceof ArrayBuffer) return r;
    if (r && r.buffer instanceof ArrayBuffer && typeof r.byteLength === 'number') return r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength);
    if (Array.isArray(r)) return new Uint8Array(r).buffer; // older Tauri builds return number[] for raw responses
    throw new Error('unexpected binary response');
  }

  // ── Codec ───────────────────────────────────────────────────────
  // meshes: [{id, tris:Float32Array}]
  function _encodeRegister(meshes) {
    var n = meshes.length, floats = 0, i;
    for (i = 0; i < n; i++) floats += meshes[i].tris.length;
    var head = 4 + 8 * n;
    var buf = new ArrayBuffer(head + floats * 4);
    var h = new Uint32Array(buf, 0, 1 + 2 * n);
    h[0] = n;
    var off = head;
    for (i = 0; i < n; i++) {
      h[1 + 2 * i] = meshes[i].id; h[2 + 2 * i] = meshes[i].tris.length;
      new Float32Array(buf, off, meshes[i].tris.length).set(meshes[i].tris);
      off += meshes[i].tris.length * 4;
    }
    return new Uint8Array(buf);
  }
  // pairs: flat array/Uint32Array [a0,b0,a1,b1,...]
  function _encodePairs(pairs) { return new Uint8Array(new Uint32Array(pairs).buffer); }
  // -> Array of (Float64Array | null); throws on any structural problem
  function _decodeResults(resp, expected) {
    var buf = _asBuffer(resp);
    if (buf.byteLength % 8 !== 0 || buf.byteLength < 8) throw new Error('malformed native result');
    var f = new Float64Array(buf);
    var n = f[0];
    if (n !== expected) throw new Error('native result count ' + n + ' != ' + expected);
    var out = new Array(n), p = 1;
    for (var i = 0; i < n; i++) {
      if (p >= f.length) throw new Error('truncated native result');
      var k = f[p++];
      if (k < 0) { out[i] = null; continue; }
      if (!(k === Math.floor(k)) || p + k > f.length) throw new Error('bad native record length');
      out[i] = f.subarray(p, p + k);
      p += k;
    }
    if (p !== f.length) throw new Error('trailing bytes in native result');
    return out;
  }

  // ── Persistent mesh registry (Rust side) ────────────────────────
  // Keyed by the IDENTITY of an element's world-triangle Float32Array — the
  // core replaces `el._triCache` on any geometry change and never mutates one
  // in place (same assumption as wasm-engine.js's cached engine) — so repeat
  // runs send pair ids, not floats. Ids are never reused in a session.
  var _ids = new WeakMap();
  var _live = new Map();      // id -> floats
  var _liveFloats = 0;
  var _nextId = 1;
  var _drops = [];
  var _fin = (typeof FinalizationRegistry === 'function') ? new FinalizationRegistry(function(id) { if (_live.has(id)) _drops.push(id); }) : null;

  function _resetRegistry() {
    _ids = new WeakMap(); _live.clear(); _liveFloats = 0; _drops.length = 0;
    return _invoke('clear_meshes');
  }
  // Flush garbage-collected ids (individually when few, else full reset).
  function _flushDrops() {
    if (!_drops.length) return Promise.resolve();
    if (_drops.length > DROP_FLUSH_MAX) return _resetRegistry();
    var ids = _drops.splice(0, _drops.length);
    return Promise.all(ids.map(function(id) {
      var fl = _live.get(id); _live.delete(id); _liveFloats -= (fl || 0);
      return _invoke('unregister_mesh', { id: id });
    }));
  }
  // Ensure every tris array is registered; returns Promise<ids[]>. Registers
  // the missing ones in as few calls as possible.
  function _ensure(trisList, stats) {
    var ids = new Array(trisList.length), fresh = [], seen = new Map(), i;
    for (i = 0; i < trisList.length; i++) {
      var t = trisList[i], id = _ids.get(t);
      if (id === undefined || !_live.has(id)) {
        id = seen.get(t);
        if (id === undefined) {
          if (_nextId > 0xFFFFFFF0) return Promise.reject(new Error('native id space exhausted'));
          id = _nextId++; seen.set(t, id); fresh.push({ id: id, tris: t });
        }
      }
      ids[i] = id;
    }
    var batches = [], cur = [], curF = 0;
    fresh.forEach(function(m) {
      if (cur.length && curF + m.tris.length > REGISTER_CHUNK_FLOATS) { batches.push(cur); cur = []; curF = 0; }
      cur.push(m); curF += m.tris.length;
    });
    if (cur.length) batches.push(cur);
    var chain = Promise.resolve();
    batches.forEach(function(b) {
      chain = chain.then(function() {
        return _invoke('register_meshes', _encodeRegister(b)).then(function(n) {
          if (n !== b.length) throw new Error('native registered ' + n + ' of ' + b.length);
          b.forEach(function(m) {
            _ids.set(m.tris, m.id); _live.set(m.id, m.tris.length); _liveFloats += m.tris.length;
            if (_fin) _fin.register(m.tris, m.id);
            if (stats) stats.copiedFloats += m.tris.length;
          });
        });
      });
    });
    return chain.then(function() { return ids; });
  }

  // ── Self-check against the JS reference ─────────────────────────
  function _box(x0, x1, y0, y1, z0, z1) {
    var t = [];
    function quad(P) { t.push.apply(t, P(0,0)); t.push.apply(t, P(1,0)); t.push.apply(t, P(1,1)); t.push.apply(t, P(0,0)); t.push.apply(t, P(1,1)); t.push.apply(t, P(0,1)); }
    function L(a,b,u) { return a + (b - a) * u; }
    quad(function(u,v){ return [L(x0,x1,u), L(y0,y1,v), z0]; });
    quad(function(u,v){ return [L(x0,x1,u), L(y0,y1,v), z1]; });
    quad(function(u,v){ return [L(x0,x1,u), y0, L(z0,z1,v)]; });
    quad(function(u,v){ return [L(x0,x1,u), y1, L(z0,z1,v)]; });
    quad(function(u,v){ return [x0, L(y0,y1,u), L(z0,z1,v)]; });
    quad(function(u,v){ return [x1, L(y0,y1,u), L(z0,z1,v)]; });
    return new Float32Array(t);
  }
  function _cyl(x0, x1, cy, cz, r, seg, rings) {
    var t = [];
    function p(x, ang) { return [x, cy + r * Math.cos(ang), cz + r * Math.sin(ang)]; }
    for (var k = 0; k < rings; k++) {
      var xa = x0 + (x1 - x0) * k / rings, xb = x0 + (x1 - x0) * (k + 1) / rings;
      for (var s = 0; s < seg; s++) {
        var a = 2 * Math.PI * s / seg, b = 2 * Math.PI * (s + 1) / seg;
        t.push.apply(t, p(xa, a)); t.push.apply(t, p(xb, a)); t.push.apply(t, p(xb, b));
        t.push.apply(t, p(xa, a)); t.push.apply(t, p(xb, b)); t.push.apply(t, p(xa, b));
      }
    }
    return new Float32Array(t);
  }
  function _cases() {
    var duct = _box(-1, 21, 2.5, 2.9, -6.9, -6.1), wall = _box(9.925, 10.075, 0, 3.2, -11.85, -0.15);
    return [
      [duct, wall], [wall, duct],
      [new Float32Array([0,0,0, 1,0,0, 0,1,0]), new Float32Array([50,50,50, 51,50,50, 50,51,50])],
      [new Float32Array([0,0,0, 2,0,0, 0,2,0]), new Float32Array([0.5,0.5,0, 1.5,0.5,0, 0.5,1.5,0])], // coplanar: non-hit
      [_cyl(-1, 21, 6.5, 2.7, 0.3, 24, 8), _cyl(-1, 21, 6.6, 2.8, 0.3, 24, 8)],
      [new Float32Array([-5,-5,0, 5,-5,0, -5,5,0]), new Float32Array([-0.1,-0.1,0.1, 0.1,-0.1,0.1, -0.1,0.1,0.1])],
      [new Float32Array([0,0,0, 3,0,0, 0,4,0]), new Float32Array([3,4,0, 6,4,0, 3,8,0])],
      [_box(-1, 21, 2.4, 2.6, -0.1, 0.1), _box(9, 11, -1, 5, -1, 1)]
    ];
  }
  function _same(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (!(a[i] === b[i] || (a[i] !== a[i] && b[i] !== b[i]))) return false;
    return true;
  }
  // Resolves to true only if every native answer equals the JS reference.
  function _selfCheck(ref) {
    var cases = _cases(), flat = [];
    cases.forEach(function(c) { flat.push(c[0], c[1]); });
    return _ensure(flat).then(function(ids) {
      var pairs = [];
      for (var i = 0; i < cases.length; i++) pairs.push(ids[2 * i], ids[2 * i + 1]);
      pairs.push(ids[0], 0xFFFFFFF0); // unregistered id: must come back null, never "no clash"
      var m = pairs.length / 2;
      return Promise.all([
        _invoke('intersect_batch', _encodePairs(pairs)),
        _invoke('min_dist_batch', _encodePairs(pairs))
      ]).then(function(rs) {
        var hard = _decodeResults(rs[0], m), dist = _decodeResults(rs[1], m);
        if (hard[m - 1] !== null || dist[m - 1] !== null) return 'unknown id not reported';
        for (var i = 0; i < cases.length; i++) {
          var a = cases[i][0], b = cases[i][1];
          var jr = ref.intersectRaw(a, b), nr = hard[i];
          if (!nr) return 'case ' + i + ' hard: null';
          if (!!jr !== (nr.length > 0)) return 'case ' + i + ' hit/miss mismatch';
          if (jr && (!_same(jr.pts, Array.prototype.slice.call(nr, 0, nr.length - 1)) || jr.depth !== nr[nr.length - 1])) return 'case ' + i + ' point/depth mismatch';
          var jd = ref.minDist(a, b);
          if (!dist[i] || !_same(jd, Array.prototype.slice.call(dist[i]))) return 'case ' + i + ' min-distance mismatch';
        }
        return true;
      });
    });
  }
  function _waitForRef(ms) {
    return new Promise(function(resolve) {
      var t0 = Date.now();
      (function poll() {
        var r = window._ccJsMeshIntersectRef;
        if (r && typeof r.intersectRaw === 'function' && typeof r.minDist === 'function') return resolve(r);
        if (Date.now() - t0 > ms) return resolve(null);
        setTimeout(poll, 100);
      })();
    });
  }

  // ── Worker-pool-shaped native pool (one per detection run) ──────
  function _createPool(ctx) {
    if (_failed || !ctx || typeof ctx.getWorldTris !== 'function' || typeof ctx.postProcess !== 'function') return null;
    var t0 = Date.now();
    var pool = {
      dead: false, reason: null, failed: false, ready: true,
      results: new Map(),
      stats: { workers: (_info && _info.threads) || 0, jobs: 0, jobsDone: 0, pairs: 0, pairsDone: 0, wasmWorkers: 0, engineWorkers: 0, initMs: 0, copiedFloats: 0, reason: null, native: true }
    };
    pool.readyP = Promise.resolve();
    var openWindows = [];
    function finish(reason, failed) {
      if (pool.dead) return;
      pool.dead = true; pool.reason = reason; pool.failed = !!failed; pool.stats.reason = reason;
      openWindows.forEach(function(w) { if (!w.done) { w.done = true; w.resolve(); } });
      openWindows.length = 0;
    }
    pool.terminate = function(reason) { finish(reason || 'finished', false); };
    pool.fail = function(reason) {
      if (!pool.dead) console.warn('[Native Engine] narrow-phase pool dropped, finishing on the main thread:', reason);
      finish(reason, true);
    };

    function processWindow(specs) {
      if (pool.dead) return Promise.resolve();
      var cidx = [], eA = [], eB = [], fl = [];
      specs.forEach(function(sp) {
        for (var i = 0; i < sp.cidx.length; i++) { cidx.push(sp.cidx[i]); eA.push(sp.eA[i]); eB.push(sp.eB[i]); fl.push(sp.fl[i]); }
      });
      var n = cidx.length;
      if (!n) return Promise.resolve();
      var prep = _liveFloats > REGISTRY_RESET_FLOATS ? _resetRegistry() : _flushDrops();
      return prep.then(function() {
        if (pool.dead) return;
        var tris = new Array(2 * n);
        for (var i = 0; i < n; i++) { tris[2 * i] = ctx.getWorldTris(eA[i]); tris[2 * i + 1] = ctx.getWorldTris(eB[i]); }
        return _ensure(tris, pool.stats).then(function(ids) {
          if (pool.dead) return;
          var recs = new Array(n), hardIdx = [], softCand = [], k;
          for (k = 0; k < n; k++) {
            recs[k] = new Float64Array(12);
            if (fl[k] & 1) hardIdx.push(k);
          }
          var hardPairs = [];
          hardIdx.forEach(function(j) { hardPairs.push(ids[2 * j], ids[2 * j + 1]); });
          var hardP = hardIdx.length ? _invoke('intersect_batch', _encodePairs(hardPairs)).then(function(r) { return _decodeResults(r, hardIdx.length); }) : Promise.resolve([]);
          return hardP.then(function(hard) {
            if (pool.dead) return;
            var ok = new Uint8Array(n).fill(1), hitFlag = new Uint8Array(n);
            for (var h = 0; h < hardIdx.length; h++) {
              var j = hardIdx[h], raw = hard[h];
              if (!raw) { ok[j] = 0; continue; } // unknown id: leave it to the main thread, never a silent miss
              var rec = recs[j]; rec[0] |= 1;
              if (raw.length) {
                var pts = ctx.postProcess(raw.subarray(0, raw.length - 1), raw[raw.length - 1], eA[j].box, eB[j].box, ctx.margin);
                if (pts) { rec[0] |= 2; rec[1] = pts[0]; rec[2] = pts[1]; rec[3] = pts[2]; rec[4] = pts[3]; hitFlag[j] = 1; }
              }
            }
            for (k = 0; k < n; k++) if ((fl[k] & 2) && !hitFlag[k] && ok[k]) softCand.push(k);
            if (!softCand.length) return { ok: ok, soft: [] };
            var sp = [];
            softCand.forEach(function(j2) { sp.push(ids[2 * j2], ids[2 * j2 + 1]); });
            return _invoke('min_dist_batch', _encodePairs(sp)).then(function(r) { return { ok: ok, soft: _decodeResults(r, softCand.length) }; });
          }).then(function(res) {
            if (!res || pool.dead) return;
            for (var s = 0; s < softCand.length; s++) {
              var j3 = softCand[s], r = res.soft[s];
              if (!r) { res.ok[j3] = 0; continue; }
              var rc = recs[j3];
              rc[0] |= 4;
              if (!r.length || r[0] === Infinity) rc[5] = Infinity;
              else { rc[5] = r[0]; for (var q = 0; q < 6; q++) rc[6 + q] = r[1 + q]; }
            }
            for (k = 0; k < n; k++) {
              if (res.ok[k]) pool.results.set(cidx[k], recs[k]);
            }
            pool.stats.pairsDone += n;
          });
        });
      });
    }

    // specs: [{cidx:[], eA:[], eB:[], fl:[]}] -> window {done, promise}
    pool.addWindow = function(specs) {
      var win = { done: false, resolve: null };
      win.promise = new Promise(function(res) { win.resolve = res; });
      if (!specs.length || pool.dead) { win.done = true; win.resolve(); return win; }
      openWindows.push(win);
      var nPairs = 0; specs.forEach(function(sp) { nPairs += sp.cidx.length; });
      pool.stats.jobs++; pool.stats.pairs += nPairs;
      _gate = _gate.then(function() { return processWindow(specs); }).then(function() {
        pool.stats.jobsDone++;
        if (!win.done) { win.done = true; win.resolve(); }
      }, function(e) {
        _nativeFailed('window: ' + ((e && e.message) || e));
        pool.fail('native: ' + ((e && e.message) || e));
      });
      return win;
    };
    pool.stats.initMs = Date.now() - t0;
    return pool;
  }

  function _nativeFailed(why) {
    if (_failed) return;
    _failed = true;
    console.warn('[Native Engine] error — unpublishing the native narrow phase for this session:', why);
    _unpublish();
  }
  var _api = { api: API_VERSION, createPool: _createPool, info: function() { return _info; } };
  function _publish() {
    window._ccNativeNarrow = _api; _published = true;
    dispatch({ t: 'UPD_NATIVE_ENGINE', u: { active: true, threads: _info && _info.threads, selfCheckMs: _selfCheckMs, failed: false } });
  }
  function _unpublish() {
    if (window._ccNativeNarrow === _api) delete window._ccNativeNarrow;
    _published = false;
    dispatch({ t: 'UPD_NATIVE_ENGINE', u: { active: false, failed: _failed } });
  }
  function dispatch(a) { try { if (typeof window._ccDispatch === 'function') window._ccDispatch(a); } catch (e) { /* UI only */ } }

  var _startP = null;
  function _start() {
    if (_startP) return _startP;
    var t0 = Date.now();
    _startP = _invoke('engine_info').then(function(info) {
      if (!info || info.api !== API_VERSION) throw new Error('native engine API mismatch: ' + JSON.stringify(info && info.api));
      _info = info;
      return _waitForRef(15000);
    }).then(function(ref) {
      if (!ref) throw new Error('JS reference unavailable — cannot verify native engine');
      return _selfCheck(ref);
    }).then(function(res) {
      _selfCheckMs = Date.now() - t0;
      if (res !== true) throw new Error('self-check FAILED (' + res + ')');
      return _invoke('engine_info');
    }).then(function(info) {
      // leave the registry clean of the self-check meshes
      _info = info;
      return _resetRegistry();
    }).then(function() {
      if (_failed) return false;
      _publish();
      console.log('%c[Native Engine] active: ' + _info.threads + ' threads (self-check ' + _selfCheckMs + 'ms)', 'color:#22c55e;font-weight:bold');
      return true;
    }).catch(function(e) {
      _failed = true;
      console.warn('[Native Engine] not published, using the WASM/JS engine:', (e && e.message) || e);
      dispatch({ t: 'UPD_NATIVE_ENGINE', u: { active: false, failed: true } });
      return false;
    });
    return _startP;
  }

  if (typeof window._ccRegisterAddon === 'function') {
    window._ccRegisterAddon({
      id: 'tauri-bridge',
      name: 'Native clash engine (desktop)',
      description: 'Runs the clash narrow phase natively on all CPU cores inside the ClashControl desktop app. Results are bit-identical to the browser engine.',
      alwaysOn: true,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>',
      initState: { nativeEngine: { active: false, failed: false, threads: 0, selfCheckMs: 0 } },
      reducerCases: {
        UPD_NATIVE_ENGINE: function(s, a) { return Object.assign({}, s, { nativeEngine: Object.assign({}, s.nativeEngine, a.u) }); }
      },
      init: function() { _start(); },
      destroy: function() { _unpublish(); },
      panel: function(html, state) {
        var ne = state.nativeEngine || {};
        if (window._ccNativeNarrow === _api) ne = Object.assign({}, ne, { active: true, threads: ne.threads || (_info && _info.threads) });
        if (ne.active) {
          return html`<div style=${{ fontSize: '0.75rem', color: '#4ade80' }}>Active — ${ne.threads} threads (self-check ${ne.selfCheckMs}ms)</div>`;
        }
        if (ne.failed) {
          return html`<div style=${{ fontSize: '0.69rem', color: '#fca5a5' }}>Native engine unavailable. Using the WASM/JavaScript engine.</div>`;
        }
        return html`<div style=${{ fontSize: '0.62rem', color: 'var(--text-faint)' }}>Verifying native engine…</div>`;
      }
    });
  }
  _start(); // idempotent; also covers a registry that has not mounted yet
})();
