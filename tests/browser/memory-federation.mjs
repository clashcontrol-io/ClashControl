#!/usr/bin/env node
// Federation memory (safety flag leanMemory): a SYNTHETIC federation big
// enough to show where the main JS heap goes is loaded and clashed twice —
// with ?ccSafety=-leanMemory (the duplicate copies the app used to keep) and
// with the default (leanMemory on) — and must give IDENTICAL results while
// the lean run stays under heap budgets the old behaviour exceeds.
//
//   1. identity: deep model digest (element order, exact position/index/
//      normal bytes, matrices, colours, instancing keys, props, f64 volume/
//      area, scene meshes after instancing/batching), one rendered frame
//      (pixels, fixed camera) and the clash list (every field but
//      id/createdAt, model ids mapped to names) are equal
//   2. budgets (lean run): post-GC heap after load, and the peak heap while
//      detection runs and commits (sampled from Node over CDP, no forced GC), stay
//      under MEM_BUDGET_LOAD_MB / MEM_BUDGET_PEAK_MB; the -leanMemory run
//      must EXCEED them (else the fixture is too small to mean anything)
//   3. the detection result does not depend on the cache byte cap: a re-run
//      with a tiny byte cap (ClashControl.storage.bvhCache.setMaxBytes) that
//      forces evictions gives the same clash list
//   4. memory-aware loading: a multi-file batch under an artificially low
//      main-heap budget (_ccIfcLoadMem.limitBytes) loads one file at a time
//      (never two parses at once, no sharding) and is digest-identical to
//      the same batch with the normal budget, which stays parallel
//
// Prints the heap per phase (after load, after detection, detection peak)
// for both runs. Generated files only (tests/fixtures generators); nothing
// is written to the repo.
//   CC_CHROMIUM_EXECUTABLE=/path CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/memory-federation.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { deepModelDigest, diffDigests } from './model-digest.mjs';
import { offlineDepsEnabled, routeOfflineDeps } from './_offline-deps.mjs';

const require = createRequire(import.meta.url);
const { generateBuilding } = require('../fixtures/generate-building-ifc.js');
const { generateShardIfc } = require('../fixtures/generate-synthetic-ifc.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };

// Budgets (MB of used JS heap, performance.memory incl. typed arrays) for the
// default federation below. Measured (headless Chromium, 2026-10-23):
//                         code before this work   leanMemory
//   after load (post-GC)        614 MB              425 MB
//   detection peak              837 MB              614 MB
//   after detection (GC)        823 MB              544 MB
// The budgets sit between the two; they apply to the default fixture only
// (a custom MEM_FED_DENSE needs explicit MEM_BUDGET_*_MB).
const DENSE = +(process.env.MEM_FED_DENSE || 0.3);
const BUDGET_LOAD = +(process.env.MEM_BUDGET_LOAD_MB || (process.env.MEM_FED_DENSE ? 0 : 520));
const BUDGET_PEAK = +(process.env.MEM_BUDGET_PEAK_MB || (process.env.MEM_FED_DENSE ? 0 : 700));

let failed = false;
function fail(msg) { console.error('MEMORY-FEDERATION FAIL: ' + msg); failed = true; process.exitCode = 1; }
function ok(msg) { console.log('MEMORY-FEDERATION OK — ' + msg); }

// ── the federation: architecture + structure + MEP of a 20-storey building
// (triangle-dense extrusions) and a model with shared shapes (instancing,
// geometry reused by 2-3 plain meshes, rooms, openings) ──
const files = new Map();
const gen = generateBuilding({ scale: 'large', seed: 4242, georef: 'local', dense: DENSE });
for (const k of Object.keys(gen.files)) files.set('/__gen/fed-' + k + '.ifc', Buffer.from(gen.files[k]));
files.set('/__gen/fed-shared.ifc', Buffer.from(generateShardIfc({ storeys: 10, perStorey: 1500, seed: 11, smallShare: true })));
const FED = [...files.keys()];
// the small batch for the scheduling case
const ci = generateBuilding({ scale: 'ci', seed: 7, georef: 'local' });
for (const k of Object.keys(ci.files)) files.set('/__gen/batch-' + k + '.ifc', Buffer.from(ci.files[k]));
files.set('/__gen/batch-shared.ifc', Buffer.from(generateShardIfc({ storeys: 3, perStorey: 400, seed: 5, smallShare: true })));
const BATCH = [...files.keys()].filter((k) => k.startsWith('/__gen/batch-'));
let fedBytes = 0; for (const k of FED) fedBytes += files.get(k).length;

// MEM_FED_REF_ROOT=<another checkout of the app>: the reference run loads
// that code (e.g. the commit before this work) instead of ?ccSafety=-leanMemory,
// so identity and the "before" numbers are measured against the real old code.
const refRoot = process.env.MEM_FED_REF_ROOT || null;
function serve(dir) {
  const server = createServer(async (req, res) => {
    try {
      const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (files.has(p)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(files.get(p)); }
      const file = normalize(join(dir, p === '/' ? 'index.html' : p.slice(1)));
      if (!file.startsWith(normalize(dir))) { res.writeHead(403); return res.end(); }
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}
const server = await serve(root);
const port = server.address().port;
const refServer = refRoot ? await serve(refRoot) : null;
// --enable-precise-memory-info: performance.memory unquantised; --expose-gc: post-GC numbers.
const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE,
  args: ['--enable-precise-memory-info', '--js-flags=--expose-gc --max-old-space-size=8192'] });
const errors = [];

// Peak heap, sampled from Node over CDP (Runtime.getHeapUsage is answered
// through a V8 interrupt, so it also samples during long synchronous work —
// an in-page timer would miss exactly those spikes).
function peakSampler(cdp) {
  let peak = 0, n = 0, maxGap = 0, last = 0, on = true;
  const loop = (async () => {
    while (on) {
      const t = Date.now();
      try { const u = await cdp.send('Runtime.getHeapUsage'); if (u.usedSize > peak) peak = u.usedSize; n++; } catch { /* page busy closing */ }
      if (last) maxGap = Math.max(maxGap, Date.now() - last);
      last = Date.now();
      const wait = 10 - (Date.now() - t);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  })();
  return { async stop() { on = false; await loop; return { peakMB: peak / 1048576, samples: n, maxGapMs: maxGap }; } };
}

async function openPage(query, atPort) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (offlineDepsEnabled()) await routeOfflineDeps(context, root);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('crash', () => errors.push('page crashed'));
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://127.0.0.1:${atPort || port}/${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.mg, null, { timeout: 60_000 });
  await page.waitForFunction(() => typeof window._ccWasmIntersect === 'function', null, { timeout: 30_000 }).catch(() => console.log('note: WASM narrow phase not ready — runs use the JS engine'));
  await page.evaluate(() => {
    window.__mem = {
      async gcMB() { for (let i = 0; i < 4; i++) { gc(); await new Promise((r) => setTimeout(r, 40)); } return performance.memory.usedJSHeapSize / 1048576; },
      // in-page sampling: runs whenever the main thread yields (between
      // detection chunks); CDP adds samples where V8 can be interrupted
      peak: 0, timer: null,
      startPeak() { this.peak = performance.memory.usedJSHeapSize; clearInterval(this.timer); this.timer = setInterval(() => { const u = performance.memory.usedJSHeapSize; if (u > this.peak) this.peak = u; }, 5); },
      stopPeak() { clearInterval(this.timer); const u = performance.memory.usedJSHeapSize; if (u > this.peak) this.peak = u; return this.peak / 1048576; },
    };
  });
  const cdp = await context.newCDPSession(page);
  return { page, context, cdp };
}

async function loadAll(page, names, knob) {
  return page.evaluate(async ({ names, knob }) => {
    if (knob) Object.assign(window._ccIfcLoadMem, knob);
    const fs = await Promise.all(names.map(async (n) => new File([await (await fetch(n)).arrayBuffer()], n.split('/').pop())));
    const t0 = performance.now();
    window.ClashControl.loadFiles(fs);
    await new Promise((resolve, reject) => {
      let idleAt = 0;
      const w = setInterval(() => {
        const s = window._ccLatestState;
        if (s && s.models.length === names.length && window._ccModelLoading === false) {
          if (s.models.every((m) => m._propsVersion)) { clearInterval(w); resolve(); return; }
          if (!idleAt) idleAt = performance.now();
          if (performance.now() - idleAt > 15000) { clearInterval(w); reject(new Error('loaded, but props never merged into: ' + s.models.filter((m) => !m._propsVersion).map((m) => m.name).join(', '))); }
        }
        if (performance.now() - t0 > (+window.__loadTimeoutMs || 1_500_000)) { clearInterval(w); reject(new Error('load timed out: ' + JSON.stringify({ models: s && s.models.map((m) => [m.name, m.elements.length, !!m._propsVersion]), loading: window._ccModelLoading, msg: window._ccModelLoadMsg }))); }
      }, 50);
    });
    const lm = window._ccIfcLoadMem ? window._ccIfcLoadMem.last : null; // absent on reference code
    return { ms: Math.round(performance.now() - t0), parallelPeak: window._ccLoadPreview.parallelPeak(),
      serial: lm ? lm.serial : null, decisions: lm ? lm.decisions : null,
      sharded: window._ccLatestState.models.filter((m) => m.stats && m.stats.shards).length,
      order: window._ccLatestState.models.map((m) => m.name) };
  }, { names, knob: knob || null });
}

// Detection with fixed rules; returns canonical rows (model ids → names).
async function detect(page, extra) {
  return page.evaluate(async (extra) => {
    function canon(v) {
      if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
      if (Array.isArray(v)) return v.map(canon);
      const o = {};
      for (const k of Object.keys(v).sort()) { const c = canon(v[k]); if (c !== undefined) o[k] = c; }
      return o;
    }
    const names = new Map(window._ccLatestState.models.map((m) => [m.id, 'model:' + m.name]));
    const t0 = performance.now();
    const res = await window.ClashControl.runDetection(Object.assign({ excludeSameDiscipline: false, selfClashModels: 'none', hard: true, minGap: 0, maxGap: 50, fullRerun: true }, extra || {}));
    const ms = performance.now() - t0;
    const rows = (res || []).map((c) => { const x = Object.assign({}, c); delete x.id; delete x.createdAt;
      return JSON.stringify(canon(x), (k, val) => (typeof val === 'string' && names.has(val) ? names.get(val) : val)); });
    return { ms: Math.round(ms), rows, cache: window.ClashControl.storage && window.ClashControl.storage.bvhCache ? window.ClashControl.storage.bvhCache.stats() : null };
  }, extra || null);
}

// One full run: load the federation, GC, digest, detect (peak sampled), GC.
async function fullRun(label, query, atPort) {
  const { page, context, cdp } = await openPage(query, atPort);
  const r = { label };
  r.bootMB = await page.evaluate(() => window.__mem.gcMB());
  let ps = peakSampler(cdp);
  await page.evaluate(() => window.__mem.startPeak());
  r.load = await loadAll(page, FED);
  r.loadPeak = await ps.stop(); r.loadPeakMB = Math.max(r.loadPeak.peakMB, await page.evaluate(() => window.__mem.stopPeak()));
  await page.waitForTimeout(3000); // preview grace period + idle-time cache writes
  // Settled heap: the geo-cache write (serialized geometry streamed to its
  // worker in idle-time chunks) can still be in flight 3 s after a fast
  // load; wait until two post-GC readings agree (≤ 40 s) instead of
  // measuring whatever is mid-flight.
  r.afterLoadMB = await page.evaluate(async () => {
    let a = await window.__mem.gcMB();
    for (let t = 0; t < 26; t++) {
      await new Promise((res) => setTimeout(res, 1500));
      const b = await window.__mem.gcMB();
      if (Math.abs(b - a) < 8) return b;
      a = b;
    }
    return a;
  });
  r.digest = await page.evaluate(deepModelDigest);
  // Pixels: one frame of the loaded federation from a fixed camera, read
  // back in the same task as the render (no preserveDrawingBuffer needed).
  r.pixels = await page.evaluate(async () => {
    const S = window._ccState3d, b = new window.THREE.Box3();
    for (const m of window._ccLatestState.models) for (const e of m.elements) b.union(e.box);
    const c = b.getCenter(new window.THREE.Vector3()), d = b.getSize(new window.THREE.Vector3()).length();
    S.camera.position.set(c.x + d * 0.6, c.y + d * 0.45, c.z + d * 0.6); S.camera.lookAt(c); S.camera.updateMatrixWorld();
    if (S.orbit && S.orbit.target) { S.orbit.target.copy(c); if (S.orbit.sync) S.orbit.sync(); }
    S._forceCull = true; window.invalidate && window.invalidate(3);
    await new Promise((res) => setTimeout(res, 500));
    S.renderer.render(S.scene, S.camera);
    const url = S.renderer.domElement.toDataURL('image/png');
    let h = 2166136261; for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return { hash: h.toString(16), len: url.length };
  });
  r.counts = await page.evaluate(() => {
    let el = 0, tris = 0, batches = 0; const ms = window._ccLatestState.models;
    for (const m of ms) { el += m.elements.length; for (const e of m.elements) for (const me of e.meshes) tris += me.geometry.index ? me.geometry.index.count / 3 : 0; batches += m.meshes.filter((x) => x.isBatchedMesh).length; }
    return { models: ms.length, elements: el, tris: Math.round(tris), batches };
  });
  await page.evaluate(() => window.__mem.gcMB());
  ps = peakSampler(cdp);
  await page.evaluate(() => window.__mem.startPeak());
  r.det = await detect(page); // the in-page stop sample follows the commit, before any GC
  r.detectPeak = await ps.stop(); r.detectPeakMB = Math.max(r.detectPeak.peakMB, await page.evaluate(() => window.__mem.stopPeak()));
  r.afterDetectMB = await page.evaluate(() => window.__mem.gcMB());
  if (query === '' && !atPort) {
    // 3. the byte cap never changes the answer
    const cap = await page.evaluate(() => window.ClashControl.storage.bvhCache.setMaxBytes(4 * 1048576));
    r.capped = await detect(page);
    r.capped.capMB = cap / 1048576;
    await page.evaluate(() => window.ClashControl.storage.bvhCache.setMaxBytes(null));
  }
  await context.close();
  return r;
}

const REF = refRoot ? 'the reference code' : '-leanMemory';
const mb = (x) => (x == null ? '-' : Math.round(x) + ' MB');
try {
  console.log('federation: ' + FED.length + ' synthetic files, ' + (fedBytes / 1048576).toFixed(1) + ' MB IFC');
  const old = refServer ? await fullRun('reference code', '', refServer.address().port) : await fullRun('-leanMemory', '?ccSafety=-leanMemory');
  const lean = await fullRun('leanMemory', '');
  console.log('  ' + lean.counts.models + ' models, ' + lean.counts.elements + ' elements, ' + lean.counts.tris + ' triangles, ' + lean.counts.batches + ' BatchedMesh; ' + lean.det.rows.length + ' clashes');
  console.log('  heap per phase       ' + (refServer ? 'reference code' : '   -leanMemory') + '     leanMemory');
  for (const [k, n] of [['bootMB', 'boot (post-GC)'], ['loadPeakMB', 'load peak'], ['afterLoadMB', 'after load (post-GC)'], ['detectPeakMB', 'detection peak'], ['afterDetectMB', 'after detection (GC)']]) {
    console.log('  ' + n.padEnd(22) + mb(old[k]).padStart(12) + mb(lean[k]).padStart(15));
  }
  console.log('  peak sampling (samples / max gap): load ' + old.loadPeak.samples + '/' + old.loadPeak.maxGapMs + ' ms, ' + lean.loadPeak.samples + '/' + lean.loadPeak.maxGapMs +
    ' ms; detection ' + old.detectPeak.samples + '/' + old.detectPeak.maxGapMs + ' ms, ' + lean.detectPeak.samples + '/' + lean.detectPeak.maxGapMs + ' ms');
  console.log('  load ' + old.load.ms + ' / ' + lean.load.ms + ' ms; detection ' + old.det.ms + ' / ' + lean.det.ms + ' ms; cache ' + JSON.stringify(lean.det.cache));

  // 1. identity
  const d = diffDigests(old.digest, lean.digest);
  if (d.length) fail('loaded models differ from ' + REF + ':\n  ' + d.join('\n  '));
  else ok('loaded federation deep-digest identical to ' + REF + ' (' + lean.counts.elements + ' elements)');
  if (old.pixels.hash !== lean.pixels.hash) fail('rendered frame differs from ' + REF + ': ' + JSON.stringify(old.pixels) + ' vs ' + JSON.stringify(lean.pixels));
  else if (!(lean.pixels.len > 20000)) fail('rendered frame looks empty: ' + JSON.stringify(lean.pixels));
  else ok('rendered frame pixel-identical to ' + REF + ' (' + lean.counts.batches + ' BatchedMesh)');
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  if (!(lean.det.rows.length > 100)) fail('fixture too small: ' + lean.det.rows.length + ' clashes');
  if (!same(old.det.rows, lean.det.rows)) fail('clash list differs from ' + REF + ' (' + old.det.rows.length + ' vs ' + lean.det.rows.length + ' rows)');
  else ok('clash list identical to ' + REF + ' (' + lean.det.rows.length + ' clashes)');
  // 3. byte cap
  if (!(lean.capped.cache.byteEvictions > 0)) fail('the tiny byte cap evicted nothing: ' + JSON.stringify(lean.capped.cache));
  else if (!same(lean.capped.rows, lean.det.rows)) fail('clash list differs under a ' + lean.capped.capMB + ' MB cache byte cap');
  else ok('clash list identical under a ' + lean.capped.capMB + ' MB cache byte cap (' + lean.capped.cache.byteEvictions + ' byte evictions)');
  // 2. budgets
  if (BUDGET_LOAD && BUDGET_PEAK) {
    if (!(lean.afterLoadMB <= BUDGET_LOAD)) fail('heap after load ' + mb(lean.afterLoadMB) + ' > budget ' + BUDGET_LOAD + ' MB');
    if (!(lean.detectPeakMB <= BUDGET_PEAK)) fail('detection peak ' + mb(lean.detectPeakMB) + ' > budget ' + BUDGET_PEAK + ' MB');
    if (!(old.afterLoadMB > BUDGET_LOAD) || !(old.detectPeakMB > BUDGET_PEAK)) fail(REF + ' stays within the budgets (after load ' + mb(old.afterLoadMB) + ', detection peak ' + mb(old.detectPeakMB) + ') — the federation is too small to mean anything');
    if (!failed) ok('heap budgets: after load ' + mb(lean.afterLoadMB) + ' <= ' + BUDGET_LOAD + ' MB (old ' + mb(old.afterLoadMB) + '), detection peak ' + mb(lean.detectPeakMB) + ' <= ' + BUDGET_PEAK + ' MB (old ' + mb(old.detectPeakMB) + ')');
  } else console.log('note: MEM_BUDGET_LOAD_MB / MEM_BUDGET_PEAK_MB unset — budgets not asserted');

  // 4. memory-aware loading
  const sched = [];
  for (const [label, knob] of [['normal budget', null], ['low budget', { limitBytes: 1048576 }]]) {
    const { page, context } = await openPage('');
    const res = await loadAll(page, BATCH, knob);
    res.digest = await page.evaluate(deepModelDigest);
    await context.close();
    sched.push([label, res]);
  }
  const [hi, lo] = [sched[0][1], sched[1][1]];
  if (!(hi.parallelPeak >= 2) || hi.serial) fail('normal budget did not load in parallel: ' + JSON.stringify({ peak: hi.parallelPeak, serial: hi.serial }));
  else if (!(lo.parallelPeak === 1) || !lo.serial || lo.sharded) fail('low budget did not load serially: ' + JSON.stringify({ peak: lo.parallelPeak, serial: lo.serial, sharded: lo.sharded }));
  else {
    const dd = diffDigests(hi.digest, lo.digest);
    if (dd.length || JSON.stringify(hi.order) !== JSON.stringify(lo.order)) fail('serial load differs from the parallel one:\n  ' + dd.join('\n  ') + '\n  order ' + hi.order + ' vs ' + lo.order);
    else ok('low heap budget: ' + BATCH.length + ' files loaded one at a time (' + lo.ms + ' ms), identical to the parallel load (' + hi.parallelPeak + ' at once, ' + hi.ms + ' ms)');
  }
  if (errors.length) fail('page errors: ' + JSON.stringify(errors.slice(0, 8)));
} finally {
  await browser.close();
  server.close();
  if (refServer) refServer.close();
}
if (!failed) console.log('MEMORY-FEDERATION OK — all cases');
