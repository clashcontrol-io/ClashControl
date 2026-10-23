// Browser side of the pressure-test harness: one static server, one
// long-lived Chromium, pages per "page class" (a page class is whatever can
// only be set up by booting the app differently: a missing WASM package, every
// addon 404ing). Everything else — engine path, failure injection, display
// state, locale, safety flags — is switched in-page, and the page is reset
// (not reloaded) between combos. The page is reloaded when its class changes,
// when it crashed, or when its health counters drift (I15 still reports the
// drift as a failure).
//
// In-page pieces:
//   window.__ccP  (addInitScript, runs before the app): health counters —
//                 Worker construct/terminate, WebGL contexts, window/document
//                 listeners, errors/unhandled rejections; download capture
//                 (Blob URLs + anchor clicks), alert/confirm capture, and the
//                 storage-failure switches (localStorage quota / IDB write).
//   window.__ccH  (installed after boot): engine-path switching (same modes as
//                 tests/browser/office-clash-parity.mjs), detection runs with
//                 an ordered field-for-field signature, cancel hooks, state
//                 reset, model loading (worker / forced main-thread fallback /
//                 abort), edits, display state.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { offlineDepsEnabled, routeOfflineDeps } from '../browser/_offline-deps.mjs';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.ifc': 'application/octet-stream',
};

export class InfraError extends Error {
  constructor(msg, cause) { super(msg); this.name = 'InfraError'; this.cause = cause; }
}

// Page classes: anything that needs a fresh boot.
export const PAGE_CLASSES = {
  default: { query: '', routes: [] },
  'no-wasm': { query: '', routes: [{ match: '**/addons/wasm-engine-pkg/**', status: 404 }] },
  'addon-404': { query: '', routes: [{ match: (u) => /\/addons\/[^/]+\.js(\?|$)/.test(u.pathname), status: 404 }] },
};
export function pageClassFor(dims) {
  if (dims.failure === 'no-wasm') return 'no-wasm';
  if (dims.failure === 'addon-404') return 'addon-404';
  return 'default';
}

// ───────────────────────── in-page: before the app ─────────────────────────
function inPageInit() {
  const P = window.__ccP = {
    errors: [], rejections: [], consoleErrors: [], alerts: [], confirms: [], downloads: [],
    workers: { created: 0, terminated: 0, live: new Set(), failed: 0 },
    gl: { contexts: 0, seen: new WeakSet() },
    listeners: { window: new Map(), document: new Map() },
    inject: { ls: false, idb: false },
    blobs: new Map(),
  };
  // Workers: count construction / termination (live = constructed and not terminated).
  const RealWorker = window.Worker;
  function W(url, opts) {
    const w = new RealWorker(url, opts);
    P.workers.created++; P.workers.live.add(w);
    try { w.__ccOrigin = { url: String(url).slice(0, 60), stack: String(new Error().stack).split('\n').slice(2, 7).map((x) => x.trim().slice(0, 120)).join(' < ') }; } catch (_) {}
    const term = w.terminate.bind(w);
    w.terminate = function () { if (P.workers.live.delete(w)) P.workers.terminated++; return term(); };
    return w;
  }
  W.prototype = RealWorker.prototype;
  window.Worker = W;
  P.Worker = W; P.RealWorker = RealWorker;
  // WebGL contexts (one per canvas).
  for (const C of [window.HTMLCanvasElement, window.OffscreenCanvas]) {
    if (!C) continue;
    const orig = C.prototype.getContext;
    C.prototype.getContext = function (type, ...rest) {
      const ctx = orig.call(this, type, ...rest);
      if (ctx && /webgl/i.test(String(type)) && !P.gl.seen.has(this)) { P.gl.seen.add(this); P.gl.contexts++; }
      return ctx;
    };
  }
  // window/document listeners (unique (type, fn, capture) registrations, like the DOM dedupes them).
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  const capOf = (o) => (typeof o === 'boolean' ? o : !!(o && o.capture));
  const tgt = (t) => (t === window ? P.listeners.window : t === document ? P.listeners.document : null);
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    const m = tgt(this);
    if (m && fn) {
      let byFn = m.get(type + '|' + capOf(opts));
      if (!byFn) m.set(type + '|' + capOf(opts), byFn = new Set());
      if (!(opts && opts.once)) byFn.add(fn);
    }
    return add.call(this, type, fn, opts);
  };
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    const m = tgt(this);
    if (m) { const byFn = m.get(type + '|' + capOf(opts)); if (byFn) byFn.delete(fn); }
    return rem.call(this, type, fn, opts);
  };
  P.listenerCounts = () => {
    const c = (m) => { const o = {}; let n = 0; for (const [k, s] of m) { if (s.size) { o[k] = s.size; n += s.size; } } return { n, by: o }; };
    return { window: c(P.listeners.window), document: c(P.listeners.document) };
  };
  add.call(window, 'error', (e) => { P.errors.push(String((e && e.message) || e) + (e && e.error && e.error.stack ? ' @ ' + String(e.error.stack).split('\n').slice(1, 5).map((x) => x.trim()).join(' < ') : '')); });
  add.call(window, 'unhandledrejection', (e) => { const r = e && e.reason; P.rejections.push(String((r && (r.stack || r.message)) || r)); });
  const ce = console.error;
  console.error = function (...a) { try { P.consoleErrors.push(a.map((x) => (x && x.message) || String(x)).join(' ').slice(0, 500)); } catch (_) {} return ce.apply(this, a); };
  // Downloads: remember Blob URLs; an <a download> click on one is captured, not navigated.
  const cou = URL.createObjectURL;
  URL.createObjectURL = function (o) { const u = cou.call(URL, o); if (o instanceof Blob) { P.blobs.set(u, o); if (P.blobs.size > 64) P.blobs.delete(P.blobs.keys().next().value); } return u; };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && P.blobs.has(this.href)) { P.downloads.push({ name: this.download, blob: P.blobs.get(this.href) }); return; }
    return click.call(this);
  };
  window.alert = (m) => { P.alerts.push(String(m)); };
  window.confirm = (m) => { P.confirms.push(String(m)); return false; };
  // Storage failure switches.
  const setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    if (P.inject.ls) throw new DOMException('pressure-test injected quota', 'QuotaExceededError');
    return setItem.call(this, k, v);
  };
  if (window.IDBObjectStore) {
    for (const fn of ['put', 'add']) {
      const orig = IDBObjectStore.prototype[fn];
      IDBObjectStore.prototype[fn] = function (...a) {
        const req = orig.apply(this, a);
        if (P.inject.idb) { try { this.transaction.abort(); } catch (_) {} }
        return req;
      };
    }
  }
  // Lazily created, deliberately long-lived singletons (one each, reused):
  // the section-cut and section-hatch workers. Everything else must be
  // terminated by whoever started it.
  const SINGLETON = /_getSectionCutWorker|_getSectionHatchWorker/;
  P.liveWorkers = () => {
    const live = [...P.workers.live].map((w) => w.__ccOrigin || { url: '?', stack: '' });
    const single = live.filter((o) => SINGLETON.test(o.stack));
    const kinds = new Set(single.map((o) => (o.stack.match(SINGLETON) || [''])[0]));
    // a second instance of a singleton is a leak too
    return live.filter((o) => !SINGLETON.test(o.stack)).concat(single.length > kinds.size ? single.slice(kinds.size) : []);
  };
  P.health = () => ({
    workersLive: P.liveWorkers().length, workersCreated: P.workers.created, glContexts: P.gl.contexts,
    listeners: P.listenerCounts(), errors: P.errors.length, rejections: P.rejections.length, consoleErrors: P.consoleErrors.length,
  });
}

// ───────────────────────── in-page: after boot ─────────────────────────
// Installed with page.evaluate(installHelpers) once the app is up.
function installHelpers() {
  const st = () => window._ccLatestState;
  const d = (a) => window._ccDispatch(a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wasmKeys = ['_ccWasmIntersect', '_ccWasmMinDist', '_ccWasmBatchIntersect', '_ccWasmEngine', '_ccWasmModuleUrls'];
  const orig = {};
  for (const k of wasmKeys) orig[k] = window[k];
  const P0 = window._ccNarrowPool;
  const poolDefaults = { minCandidates: P0.minCandidates, minCandidatesHardOnly: P0.minCandidatesHardOnly, nativeMinCandidates: P0.nativeMinCandidates, disabled: P0.disabled, forceJs: P0.forceJs, maxWorkers: P0.maxWorkers };
  const s0 = st();
  const H = window.__ccH = {
    orig, poolDefaults,
    bootRules: JSON.parse(JSON.stringify(s0.rules)),
    bootPrefs: { renderStyle: s0.prefs.renderStyle, showSpaces: !!s0.prefs.showSpaces },
    bootLocale: window._ccGetLocale ? window._ccGetLocale() : '',
    native: null, nativeErr: null,
    wasmReady: () => typeof orig._ccWasmIntersect === 'function' && !!orig._ccWasmEngine,
    async ensureNative(bridgeSrc) {
      if (H.native || H.nativeErr) return H.nativeErr;
      try {
        const urls = orig._ccWasmModuleUrls && orig._ccWasmModuleUrls();
        if (!urls) throw new Error('no WASM module (page class without WASM)');
        const mod = await import(urls.js);
        await mod.default({ module_or_path: urls.wasm });
        const eng = new mod.Engine();
        const enc = (rs) => { const o = [rs.length]; rs.forEach((r) => { if (r === undefined) o.push(-1); else { o.push(r.length); for (const x of r) o.push(x); } }); return new Float64Array(o).buffer; };
        window.__natCalls = { register: 0, intersect: 0, mindist: 0, within: 0 };
        window.__TAURI_INTERNALS__ = { invoke: async (cmd, args) => {
          if (cmd === 'engine_info') return { api: 1, threads: 4, meshes: 0, floats: 0, within: true };
          if (cmd === 'register_meshes') {
            window.__natCalls.register++;
            const dv = new DataView(args.buffer, args.byteOffset, args.byteLength), n = dv.getUint32(0, true);
            let off = 4 + 8 * n;
            for (let i = 0; i < n; i++) { const id = dv.getUint32(4 + 8 * i, true), len = dv.getUint32(8 + 8 * i, true); eng.register(id, new Float32Array(args.buffer.slice(args.byteOffset + off, args.byteOffset + off + len * 4))); off += len * 4; }
            return n;
          }
          if (cmd === 'unregister_mesh') return eng.unregister(args.id);
          if (cmd === 'clear_meshes') { eng.clear(); return null; }
          if (cmd === 'min_dist_within_batch') {
            window.__natCalls.within++;
            const seed = new Float64Array(args.buffer.slice(args.byteOffset, args.byteOffset + 8))[0];
            const u = new Uint32Array(args.buffer.slice(args.byteOffset + 8, args.byteOffset + args.byteLength)), out = [];
            for (let i = 0; i < u.length; i += 2) out.push(eng.min_distance_within(u[i], u[i + 1], seed));
            return enc(out);
          }
          if (cmd === 'intersect_batch' || cmd === 'min_dist_batch') {
            window.__natCalls[cmd === 'intersect_batch' ? 'intersect' : 'mindist']++;
            const u = new Uint32Array(args.buffer.slice(args.byteOffset, args.byteOffset + args.byteLength)), out = [];
            for (let i = 0; i < u.length; i += 2) out.push(cmd === 'intersect_batch' ? eng.intersect(u[i], u[i + 1]) : eng.min_distance(u[i], u[i + 1]));
            return enc(out);
          }
          throw new Error('command not allowed: ' + cmd);
        } };
        (0, eval)(bridgeSrc);
        for (let i = 0; i < 200 && !window._ccNativeNarrow; i++) await sleep(50);
        if (!window._ccNativeNarrow) throw new Error('bridge did not publish the native path (self-check failed?)');
        H.native = window._ccNativeNarrow;
      } catch (e) { H.nativeErr = String((e && e.message) || e); }
      return H.nativeErr;
    },
    // Engine paths (office-clash-parity.mjs modes) + 'auto' = the app as shipped.
    setMode(mode) {
      for (const k of wasmKeys) { if (orig[k]) window[k] = orig[k]; else delete window[k]; }
      const P = window._ccNarrowPool;
      Object.assign(P, poolDefaults);
      delete window._ccNativeNarrow;
      if (mode === 'auto') return;
      P.disabled = !(mode.startsWith('pool') || mode === 'native'); P.minCandidates = 0; P.minCandidatesHardOnly = 0; P.nativeMinCandidates = 0; P.forceJs = false; P.maxWorkers = 0;
      if (mode === 'native' && H.native) window._ccNativeNarrow = H.native;
      if (mode === 'js' || mode === 'pool-js') { for (const k of wasmKeys) delete window[k]; P.forceJs = mode === 'pool-js'; }
      else if (mode === 'wasm') delete window._ccWasmEngine;
    },
    // One detection run through the public API (commits to state like the UI).
    // opts.full -> fullRerun; opts.cancel 'first'|'mid'|'last' cancels on progress.
    async run(rules, opts) {
      opts = opts || {};
      const r = Object.assign({}, rules, { fullRerun: !!opts.full });
      let fired = null, events = 0;
      const onProg = () => {
        const p = window._ccDetectProgress; events++;
        if (fired || !opts.cancel || !p) return;
        const hit = opts.cancel === 'first' ? true : opts.cancel === 'mid' ? (p.done >= p.total / 2 && p.done < p.total) : p.done >= p.total;
        if (hit) { fired = { done: p.done, total: p.total }; window._ccCancelDetection(); }
      };
      window.addEventListener('cc-detect-progress', onProg);
      const before = st().clashes.map((c) => c.id + ':' + c.status).join(',');
      let res, err = null;
      try { res = await window.ClashControl.runDetection(r); } catch (e) { err = String((e && e.stack) || e); }
      H.lastRes = res || [];
      window.removeEventListener('cc-detect-progress', onProg);
      await sleep(0);
      const prof = Object.assign({}, window._ccDetectProfile || {});
      delete prof.narrow_pool;
      const clashes = (res || []).map((c) => JSON.stringify(c, (k, v) => (k === 'id' || k === 'createdAt' ? undefined : v)));
      return {
        err, outcome: res && res._ccOutcome, clashes, n: clashes.length, fired, events,
        stateUnchanged: st().clashes.map((c) => c.id + ':' + c.status).join(',') === before,
        detecting: !!st().detecting,
        prof: { smart: !!prof.smart_rerun, changed: prof.changed_elements, hard: prof.hard_tests, soft: prof.soft_tests, cand: prof.candidates, reemits: prof.pair_cache_reemits, elements: prof.elements },
        pool: window._ccNarrowPool.last ? JSON.parse(JSON.stringify(window._ccNarrowPool.last)) : null,
        engineQueries: window._ccWasmEngine && window._ccWasmEngine.stats ? window._ccWasmEngine.stats().queries : null,
      };
    },
    // Cross-load normalisation: model ids -> model names, per-row JSON.
    normalized(rows) {
      const names = {};
      for (const m of st().models) names[m.id] = m.name;
      return rows.map((s) => {
        const c = JSON.parse(s);
        for (const k of ['modelAId', 'modelBId', 'modelId']) if (c[k] && names[c[k]]) c[k] = names[c[k]];
        return c;
      });
    },
    async reset() {
      try { if (st().detecting || window._ccDetectionActive()) window._ccCancelDetection(); } catch (_) {}
      try { if (window._ccModelLoading) window._ccAbortLoading(); } catch (_) {}
      window.Worker = window.__ccP.Worker;
      window.__ccP.inject.ls = false; window.__ccP.inject.idb = false;
      H.setMode('auto');
      const S = window._ccSafetyMigrations;
      if (S && S._setFlagsForTest) S._setFlagsForTest(S.readFlags({ search: location.search, storage: null }));
      for (const m of st().models.concat(st().parkedModels || [])) d({ t: 'DEL_MODEL', id: m.id });
      for (const i of st().issues.slice()) d({ t: 'DEL_ISSUE', id: i.id });
      for (const v of (st().viewpoints || []).slice()) d({ t: 'DEL_VIEWPOINT', id: v.id });
      d({ t: 'SET_CLASHES', v: [] });
      d({ t: 'UPD_RULES', u: JSON.parse(JSON.stringify(H.bootRules)) });
      d({ t: 'RESET_FILTERS' });
      d({ t: 'TAB', v: 'clashes' });
      d({ t: 'SECTION', axis: null });
      d({ t: 'SECTION_BOX', v: null });
      d({ t: 'UPD_PREFS', u: { renderStyle: H.bootPrefs.renderStyle, showSpaces: H.bootPrefs.showSpaces } });
      if (window._ccSetLocale && (window._ccGetLocale() || '') !== (H.bootLocale || '')) window._ccSetLocale(H.bootLocale || '', { persist: false });
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k === 'cc_denied_clashes' || k === 'cc_detection_runs' || /^cc_typePairMemo:/.test(k)) localStorage.removeItem(k);
        }
      } catch (_) {}
      if (window._ccPairCacheClearForModel) window._ccPairCacheClearForModel('__pressure_reset__');
      if (orig._ccWasmEngine && orig._ccWasmEngine.clear) { try { orig._ccWasmEngine.clear(); } catch (_) {} }
      window._ccUndoStack && (window._ccUndoStack.length = 0);
      window._ccRedoStack && (window._ccRedoStack.length = 0);
      window.__ccP.downloads.length = 0; window.__ccP.alerts.length = 0; window.__ccP.confirms.length = 0;
      for (let i = 0; i < 100 && (st().models.length || st().clashes.length || st().detecting || window._ccModelLoading); i++) await sleep(20);
      await sleep(50);
      return { models: st().models.length, clashes: st().clashes.length, loading: !!window._ccModelLoading };
    },
    // files: [{url, name}] in load order. opts.fallback: force the main-thread
    // loader (Worker constructor throws). opts.abort: 'start'|'first-model'.
    async load(files, opts) {
      opts = opts || {};
      const bufs = await Promise.all(files.map(async (f) => new File([await (await fetch(f.url)).arrayBuffer()], f.name)));
      const nm = (n) => String(n).replace(/\.(ifc|ifczip)$/i, '');
      const want = new Set(files.map((f) => nm(f.name)));
      // a file whose model is already loaded REPLACES it: wait for the new elements
      const prevEls = new Map(st().models.filter((m) => want.has(m.name)).map((m) => [m.name, m.elements]));
      const RealW = window.Worker;
      if (opts.fallback) window.Worker = class { constructor() { throw new Error('pressure: forced main-thread loader'); } };
      const t0 = performance.now();
      let aborted = null;
      try {
        window.ClashControl.loadFiles(bufs);
        if (opts.abort) {
          if (opts.abort === 'first-model') { for (let i = 0; i < 1500 && !st().models.some((m) => (m.elements || []).length); i++) await sleep(10); }
          else await sleep(0);
          window._ccAbortLoading();
          aborted = { models: st().models.length };
          for (let i = 0; i < 300 && window._ccModelLoading; i++) await sleep(20);
          await sleep(800);
          const a = st().models.map((m) => m.name + ':' + (m.elements || []).length).sort().join(',');
          await sleep(1000);
          const b = st().models.map((m) => m.name + ':' + (m.elements || []).length).sort().join(',');
          return { aborted, loading: !!window._ccModelLoading, loadMsg: window._ccModelLoadMsg || '', settledModels: b, grewAfterAbort: a !== b, ms: performance.now() - t0, workers: window.__ccP.liveWorkers() };
        }
        const deadline = performance.now() + (opts.timeoutMs || 240000);
        for (;;) {
          const s = st();
          const got = new Set(s.models.filter((m) => (m.elements || []).length > 0 && m.elements !== prevEls.get(m.name)).map((m) => m.name));
          if (window._ccModelLoading === false && [...want].every((n) => got.has(n))) break;
          if (performance.now() > deadline) return { timeout: true, models: s.models.map((m) => m.name + ':' + (m.elements || []).length), loading: window._ccModelLoading };
          await sleep(50);
        }
      } finally { if (opts.fallback) window.Worker = RealW; }
      await sleep(50);
      return { ms: performance.now() - t0, models: st().models.map((m) => ({ id: m.id, name: m.name, elements: m.elements.length, discipline: m.discipline })) };
    },
    async reloadModel(name) {
      const m = st().models.find((x) => x.name === name);
      if (!m || typeof window._ccReloadModelFull !== 'function') return { skipped: 'no _ccReloadModelFull' };
      const els0 = m.elements, n0 = m.elements.length;
      window._ccReloadModelFull(m.id);
      for (let i = 0; i < 3000; i++) {
        const x = st().models.find((y) => y.name === name);
        if (x && x.elements !== els0 && x.elements.length && !window._ccModelLoading) break;
        await sleep(20);
      }
      const x = st().models.find((y) => y.name === name);
      return { sameId: !!x && x.id === m.id, elements: x ? x.elements.length : 0, before: n0, reloaded: !!x && x.elements !== els0, models: st().models.length };
    },
    models() { return st().models.map((m) => ({ id: m.id, name: m.name, elements: (m.elements || []).length, discipline: m.discipline, visible: m.visible !== false })); },
    // Geometry digest of one model (engine-frame world triangles + boxes, by expressId).
    modelDigest(name) {
      const m = st().models.find((x) => x.name === name);
      if (!m) return null;
      let h = 0x811c9dc5, n = 0;
      const mix = (v) => { const x = Math.round(v * 1e6); h = Math.imul(h ^ (x & 0xffff), 0x01000193); h = Math.imul(h ^ (x >>> 16), 0x01000193); };
      for (const el of m.elements.slice().sort((a, b) => a.expressId - b.expressId)) {
        mix(el.expressId);
        const t = window._ccGetWorldTris(el);
        if (t) { n += t.length; for (let i = 0; i < t.length; i++) mix(t[i]); }
      }
      return { h: (h >>> 0).toString(16), n, elements: m.elements.length };
    },
    // Park/restore comparison. The geometry cache stores positions quantized to
    // 16 bits over each mesh's own bounding box (index.html _geoSerialize), so a
    // restored element may move by up to ~extent/65535: compare against that
    // bound, and report the largest deviation seen.
    snapModel(name) {
      const m = st().models.find((x) => x.name === name);
      if (!m) return false;
      const snap = new Map();
      for (const el of m.elements) { const t = window._ccGetWorldTris(el); snap.set(el.expressId, t ? Float32Array.from(t) : null); }
      (H._snaps = H._snaps || {})[name] = snap;
      return true;
    },
    compareModel(name) {
      const m = st().models.find((x) => x.name === name), snap = H._snaps && H._snaps[name];
      if (!m || !snap) return { error: 'missing model or snapshot' };
      let worst = 0, worstAbs = 0, bad = [], n = 0;
      for (const el of m.elements) {
        const a = snap.get(el.expressId), b = window._ccGetWorldTris(el);
        n++;
        if (!a || !b || a.length !== b.length) { bad.push(el.expressId + ': triangles ' + (a && a.length) + ' -> ' + (b && b.length)); continue; }
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < a.length; i++) { const k = i % 3; if (a[i] < mn[k]) mn[k] = a[i]; if (a[i] > mx[k]) mx[k] = a[i]; }
        const bound = 2 * Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) / 65535 + 1e-6;
        let d = 0;
        for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
        if (d > worstAbs) worstAbs = d;
        if (d / bound > worst) worst = d / bound;
        if (d > bound) bad.push(el.expressId + ': moved ' + d.toExponential(2) + ' m > bound ' + bound.toExponential(2));
      }
      return { elements: n, before: snap.size, worstOverBound: +worst.toFixed(3), worstAbsM: worstAbs, bad: bad.slice(0, 5), badCount: bad.length };
    },
    parked() { return (st().parkedModels || []).map((m) => ({ id: m.id, name: m.name })); },
    // ── edits ──
    elementsWithGeometry(modelIdx) {
      const m = st().models[modelIdx];
      return m ? m.elements.filter((e) => e.box && e.meshes && e.meshes.length && (e.props || {}).ifcType !== 'IfcSpace').length : 0;
    },
    editMove(modelIdx, elIdx, dy) {
      const m = st().models[modelIdx];
      const els = m.elements.filter((e) => e.box && e.meshes && e.meshes.length && (e.props || {}).ifcType !== 'IfcSpace');
      const el = els[elIdx % els.length];
      el.meshes.forEach((me) => { me.matrix.elements[13] += dy; me.matrixWorld.elements[13] += dy; me.position.y += dy; });
      el.box.min.y += dy; el.box.max.y += dy;
      delete el._wvCache; delete el._triCache; delete el._bvhCache; delete el._topo; delete el._fbox;
      return { model: m.name, expressId: el.expressId, globalId: (el.props || {}).globalId, dy };
    },
    editOpenings(modelIdx, elIdx) {
      const m = st().models[modelIdx];
      const els = m.elements.filter((e) => e.box && e.meshes && e.meshes.length && (e.props || {}).ifcType !== 'IfcSpace');
      const el = els[elIdx % els.length];
      const b = el.box, c = [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2];
      const h = [(b.max.x - b.min.x) * 0.3, (b.max.y - b.min.y) * 0.3, (b.max.z - b.min.z) * 0.3];
      el.props.openings = [c[0], c[1], c[2], 1, 0, 0, 0, 1, 0, 0, 0, 1, h[0], h[1], h[2]];
      return { model: m.name, expressId: el.expressId, globalId: el.props.globalId };
    },
    editClash(idx, status, assignee) {
      const cs = st().clashes;
      if (!cs.length) return null;
      const c = cs[idx % cs.length];
      const u = { status };
      if (assignee != null) u.assignee = assignee;
      d({ t: 'UPD_CLASH', id: c.id, u });
      return { id: c.id, globalIdA: c.globalIdA, globalIdB: c.globalIdB, status, assignee: assignee == null ? c.assignee : assignee, type: c.type, point: c.point };
    },
    deleteModel(idx) { const m = st().models[idx]; if (!m) return null; d({ t: 'DEL_MODEL', id: m.id }); return m.name; },
    async park(idx) {
      const m = st().models[idx]; if (!m) return null;
      await window.ClashControl.parkModel(m.id);
      for (let i = 0; i < 1500 && !window.ClashControl.isModelParked(m.id); i++) await sleep(20);
      return { name: m.name, parked: window.ClashControl.isModelParked(m.id) };
    },
    async restore() {
      const p = (st().parkedModels || [])[0]; if (!p) return null;
      await window.ClashControl.restoreModel(p.id);
      for (let i = 0; i < 3000; i++) { const m = st().models.find((x) => x.id === p.id); if (m && (m.elements || []).length && !window._ccModelLoading) break; await sleep(20); }
      const m = st().models.find((x) => x.id === p.id);
      return { name: p.name, restored: !!m, elements: m ? m.elements.length : 0 };
    },
    // ── display-only state (I7) ──
    async display(dv) {
      d({ t: 'TAB', v: dv.tab === 'models' ? 'navigator' : dv.tab });
      d({ t: 'UPD_RULES', u: { hideProvidedOpenings: dv.hideProvided, hideContacts: dv.hideContacts } });
      d({ t: 'UPD_PREFS', u: { renderStyle: dv.style, showSpaces: dv.showSpaces } });
      if (dv.section === 'plane') d({ t: 'SECTION', axis: 'y', pos: 0.5 });
      else if (dv.section === 'box' && window._ccModelSectionBoxSpec) { const b = window._ccModelSectionBoxSpec(); if (b) d({ t: 'SECTION_BOX', v: b }); }
      if (dv.occlusion === 'off') {
        const S = window._ccSafetyMigrations;
        if (S && S._setFlagsForTest) S._setFlagsForTest(S.readFlags({ search: '?ccSafety=-occlusionCulling', storage: null }));
      }
      if (dv.locale && dv.locale !== 'en' && window._ccSetLocale) {
        window._ccSetLocale(dv.locale, { persist: false });
        for (let i = 0; i < 100 && window._ccGetLocale() !== dv.locale; i++) await sleep(20);
      }
      if (dv.filter === 'status') d({ t: 'UPD_FILTERS', u: { status: 'open' } });
      if (window._ccInvalidate) window._ccInvalidate(3);
      await sleep(120);
      return { tab: st().tab, locale: window._ccGetLocale ? window._ccGetLocale() : null };
    },
    // ── I6: the clash list's counts add up ──
    async listCounts() {
      d({ t: 'TAB', v: 'clashes' });
      const T = window._cc_t || ((k, f) => f);
      const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nounPl = T('statsBar.clashes', 'clashes'), noun = T('statsBar.clash', 'clash');
      const headRe = new RegExp('(\\d+) (?:' + esc(nounPl) + '|' + esc(noun) + ') · ');
      // big lists render later than small ones: poll for the summary line (no timing assert)
      let txt = '', head = null;
      for (let i = 0; i < 80; i++) {
        await sleep(i ? 125 : 250);
        txt = document.body.innerText;
        head = txt.match(headRe);
        if (head || !st().clashes.length) break;
      }
      const s = st();
      const num = (re) => { const m = txt.match(re); return m ? +m[1] : 0; };
      return {
        raw: s.clashes.length,
        denied: s.clashes.filter((c) => c.status === 'denied').length,
        headline: head ? +head[1] : (s.clashes.length ? null : 0),
        // the list notices end in " —" (the detection funnel toast reuses the same words)
        provided: num(new RegExp('(\\d+) ' + esc(T('opening.passThrough', 'pass through provided openings')) + ' —')),
        contact: num(new RegExp('(\\d+) ' + esc(T('contact.only', 'only touch (contact)')) + ' —')),
        provision: num(new RegExp('(\\d+) ' + esc(T('provision.passThrough', 'inside provisions / reservations')) + ' —')),
        // "Clashes with 5× zones / compartments · 2× duplicates … —" (classify-only suggestion groups)
        groups: (() => { const m = txt.match(new RegExp(esc(T('roles.classifiedPrefix', 'Clashes with')) + ' ([^\\n]*?) —')); return m ? (m[1].match(/(\d+)×/g) || []).reduce((a, x) => a + parseInt(x, 10), 0) : 0; })(),
        stateProvided: s.clashes.filter((c) => c.opening === 'provided' && c.status !== 'denied').length,
        stateContact: s.clashes.filter((c) => c.type === 'contact' && c.status !== 'denied').length,
        overlap: s.clashes.filter((c) => c.type === 'contact' && c.opening === 'provided' && c.status !== 'denied').length,
        hideProvided: s.rules.hideProvidedOpenings !== false, hideContacts: s.rules.hideContacts !== false,
      };
    },
  };
  return { wasmReady: H.wasmReady(), bootRules: H.bootRules, bootPrefs: H.bootPrefs };
}

// ───────────────────────── Node side ─────────────────────────
export async function startHarness(opts = {}) {
  const virtual = new Map();
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (virtual.has(urlPath)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(virtual.get(urlPath)); }
      const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
      const file = normalize(join(ROOT, rel));
      if (!file.startsWith(normalize(ROOT))) { res.writeHead(403); return res.end(); }
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const bridgeSrc = await readFile(join(ROOT, 'addons', 'tauri-bridge.js'), 'utf8');
  const h = new Harness({ server, port, virtual, bridgeSrc, log: opts.log || (() => {}), singleProcess: !!opts.singleProcess });
  await h.launch();
  return h;
}

class Harness {
  constructor(o) { Object.assign(this, o); this.browser = null; this.cur = null; this.pageBoots = 0; }
  async launch() {
    const args = ['--js-flags=--max-old-space-size=8192'];
    if (this.singleProcess) args.push('--single-process', '--no-zygote');
    this.browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE, args });
    this.browser.on('disconnected', () => { this.browserDead = true; });
    this.browserDead = false;
  }
  serve(path, buf) { this.virtual.set(path, buf); }
  url(path) { return 'http://127.0.0.1:' + this.port + path; }
  async close() {
    try { if (this.cur) await this.cur.ctx.close(); } catch (_) {}
    try { await this.browser.close(); } catch (_) {}
    this.server.close();
  }
  async restartBrowser() {
    try { if (this.cur) await this.cur.ctx.close(); } catch (_) {}
    this.cur = null;
    try { await this.browser.close(); } catch (_) {}
    await this.launch();
  }
  // A ready page of the given class (reuses the current one when possible).
  async page(cls, { fresh = false } = {}) {
    if (this.browserDead) await this.restartBrowser();
    if (this.cur && this.cur.cls === cls && !fresh && !this.cur.dead) return this.cur;
    if (this.cur) { try { await this.cur.ctx.close(); } catch (_) {} this.cur = null; }
    const spec = PAGE_CLASSES[cls];
    if (!spec) throw new Error('unknown page class ' + cls);
    let ctx, page;
    try {
      ctx = await this.browser.newContext();
      if (offlineDepsEnabled()) await routeOfflineDeps(ctx, ROOT);
      for (const r of spec.routes) await ctx.route(r.match, (route) => route.fulfill({ status: r.status, body: '' }));
      await ctx.addInitScript({ content: '(' + inPageInit.toString() + ')();' });
      page = await ctx.newPage();
    } catch (e) { throw new InfraError('browser: cannot open a page: ' + e.message, e); }
    const P = { cls, ctx, page, nodeErrors: [], dead: false, boot: ++this.pageBoots, h: this };
    page.on('pageerror', (e) => P.nodeErrors.push('pageerror: ' + e.message));
    page.on('crash', () => { P.dead = true; });
    try {
      await page.goto(this.url('/' + spec.query), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccLatestState, null, { timeout: 90_000 });
    } catch (e) { try { await ctx.close(); } catch (_) {} throw new InfraError('page never booted (' + cls + '): ' + e.message, e); }
    if (cls !== 'no-wasm' && cls !== 'addon-404') {
      await page.waitForFunction(() => typeof window._ccWasmIntersect === 'function' && window._ccWasmEngine, null, { timeout: 45_000 })
        .catch(() => { throw new InfraError('WASM narrow phase never became ready on a default page (missing deps?)'); });
    } else {
      await page.waitForTimeout(1500); // let the (failing) addon loads settle
    }
    P.boot = await page.evaluate(installHelpers);
    P.ev = (fn, arg) => this._ev(P, fn, arg);
    this.cur = P;
    return P;
  }
  async _ev(P, fn, arg) {
    try { return await P.page.evaluate(fn, arg); } catch (e) {
      const m = String(e && e.message || e);
      if (P.dead || this.browserDead || /Target (page, context or browser )?closed|crash|Execution context was destroyed|browser has been closed/i.test(m)) { P.dead = true; throw new InfraError('page/browser died: ' + m, e); }
      throw e;
    }
  }
  async ensureNative(P) { return P.ev((src) => window.__ccH.ensureNative(src), this.bridgeSrc); }
  async health(P) { return P.ev(() => window.__ccP.health()); }
  async errors(P) {
    const inPage = await P.ev(() => ({ errors: window.__ccP.errors.slice(), rejections: window.__ccP.rejections.slice(), consoleErrors: window.__ccP.consoleErrors.slice() }));
    return Object.assign(inPage, { node: P.nodeErrors.slice() });
  }
  async clearErrors(P) {
    P.nodeErrors.length = 0;
    await P.ev(() => { window.__ccP.errors.length = 0; window.__ccP.rejections.length = 0; window.__ccP.consoleErrors.length = 0; });
  }
}
