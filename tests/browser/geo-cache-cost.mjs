#!/usr/bin/env node
// Geometry-cache cost on a SYNTHETIC federation with reused geometry
// (tests/fixtures generators only; nothing is written to the repo): a dense
// generated building (no reuse by construction) plus generated models whose
// shapes are shared by many elements. Per run, in a fresh browser context:
//   - load the federation, wait until every geometry cache record is written
//   - serialise ms: main-thread _geoSerialize time at commit (sum of the
//     'cc:geoSerialize' User Timing entries)
//   - cache size: geometry buffer bytes in the stored records and the
//     records' own size stamp (`bytes`)
//   - restore: park every model, then restore them one after the other from
//     the cache: wall time, main-thread busy time (CDP TaskDuration) and the
//     _geoDeserialize part of it ('cc:geoDeserialize'), checking no model
//     was re-parsed. Wall time includes waiting for frames rendered in the
//     GPU process, so it swings with other load on the machine.
//   - heap after restore (post-GC, performance.memory)
// Prints the median of GEO_COST_RUNS (default 3) runs. With
// GEO_COST_REF_ROOT=<another checkout> the same runs are made against that
// code as well (its _geoSerialize must record the same User Timing entry).
//   CC_CHROMIUM_EXECUTABLE=/path CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/geo-cache-cost.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { offlineDepsEnabled, routeOfflineDeps } from './_offline-deps.mjs';

const require = createRequire(import.meta.url);
const { generateBuilding } = require('../fixtures/generate-building-ifc.js');
const { generateShardIfc } = require('../fixtures/generate-synthetic-ifc.js');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };
const RUNS = +(process.env.GEO_COST_RUNS || 3);

const files = new Map();
const gen = generateBuilding({ scale: process.env.GEO_COST_SCALE || 'medium', seed: 4242, georef: 'local', dense: 0.3 });
for (const k of Object.keys(gen.files)) files.set('/__gen/fed-' + k + '.ifc', Buffer.from(gen.files[k]));
const SHARED = +(process.env.GEO_COST_SHARED || 3);
for (let i = 0; i < SHARED; i++) files.set('/__gen/fed-shared-' + i + '.ifc', Buffer.from(generateShardIfc({ storeys: 8, perStorey: 1500, seed: 11 + i, smallShare: true })));
const FED = [...files.keys()];
let fedBytes = 0; for (const k of FED) fedBytes += files.get(k).length;

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

const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE,
  args: ['--enable-precise-memory-info', '--js-flags=--expose-gc --max-old-space-size=8192'] });

async function run(port) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (offlineDepsEnabled()) await routeOfflineDeps(context, root);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.mg, null, { timeout: 60_000 });
  const r = await page.evaluate(async (names) => {
    const gcMB = async () => { for (let i = 0; i < 4; i++) { gc(); await new Promise((res) => setTimeout(res, 40)); } return performance.memory.usedJSHeapSize / 1048576; };
    const idb = async (fn) => { const db = await new Promise((res) => { const q = indexedDB.open('ClashControlFiles'); q.onsuccess = () => res(q.result); }); try { return await fn(db); } finally { db.close(); } };
    const req = (q) => new Promise((res) => { q.onsuccess = () => res(q.result); });
    const fs = await Promise.all(names.map(async (n) => new File([await (await fetch(n)).arrayBuffer()], n.split('/').pop())));
    window.ClashControl.loadFiles(fs);
    const t0 = performance.now();
    for (;;) {
      const s = window._ccLatestState;
      if (s && s.models.length === names.length && window._ccModelLoading === false) {
        const keys = await idb((db) => req(db.transaction('geoCache', 'readonly').objectStore('geoCache').getAllKeys()));
        if (keys.length >= names.length) break;
      }
      if (performance.now() - t0 > 1_500_000) throw new Error('load / cache write timed out');
      await new Promise((res) => setTimeout(res, 250));
    }
    await new Promise((res) => setTimeout(res, 1500));
    const ser = performance.getEntriesByName('cc:geoSerialize');
    const recs = await idb((db) => req(db.transaction('geoCache', 'readonly').objectStore('geoCache').getAll()));
    const len = (o) => ['pos', 'n8', 'nrm', 'idx', 'qpos', 'qnrm'].reduce((n, k) => n + (o && o[k] ? o[k].byteLength : 0), 0);
    let geoBytes = 0, stamp = 0, meshes = 0, geoms = 0;
    for (const rec of recs) {
      const d = rec.data; stamp += rec.bytes || 0; meshes += d.meshData.length;
      if (d.gs === 1) { geoms += d.geoData.length; for (const g of d.geoData) geoBytes += len(g); }
      else { geoms += d.meshData.length; for (const md of d.meshData) geoBytes += len(md); }
    }
    // distinct geometries among the live meshes = what the cache must hold
    let live = 0; const seen = new Set();
    for (const m of window._ccLatestState.models) for (const e of m.elements) for (const ms of e.meshes) { live++; seen.add(ms.geometry); }
    const heapLoad = await gcMB();
    const ids = window._ccLatestState.models.map((m) => m.id);
    for (const id of ids) {
      await window.ClashControl.parkModel(id);
      while (!(window._ccLatestState.parkedModels || []).some((p) => p.id === id)) await new Promise((res) => setTimeout(res, 20));
    }
    const heapParked = await gcMB();
    window.__geoCost = { ids, serBefore: performance.getEntriesByName('cc:geoSerialize').length };
    return { serialiseMs: ser.reduce((n, e) => n + e.duration, 0), serialiseN: ser.length, geoMB: geoBytes / 1048576, stampMB: stamp / 1048576,
      records: recs.length, meshes, geoms, live, liveGeoms: seen.size, heapLoad, heapParked };
  }, FED);
  // Main-thread busy time of the restore (CDP Performance.TaskDuration): the
  // wall time also waits for frames rendered in the GPU process (SwiftShader
  // in headless runs), which swings with any other load on the machine.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const task = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration').value * 1000;
  const t0 = await task();
  Object.assign(r, await page.evaluate(async () => {
    const { ids, serBefore } = window.__geoCost;
    const tr = performance.now();
    for (const id of ids) {
      await window.ClashControl.restoreModel(id);
      while (!window._ccLatestState.models.some((m) => m.id === id)) await new Promise((res) => setTimeout(res, 5));
    }
    return { restoreMs: performance.now() - tr,
      deserialiseMs: performance.getEntriesByName('cc:geoDeserialize').reduce((n, e) => n + e.duration, 0),
      reparsed: performance.getEntriesByName('cc:geoSerialize').length - serBefore };
  }));
  r.restoreBusyMs = (await task()) - t0;
  r.heapRestore = await page.evaluate(async () => { await new Promise((res) => setTimeout(res, 1000)); for (let i = 0; i < 4; i++) { gc(); await new Promise((res) => setTimeout(res, 40)); } return performance.memory.usedJSHeapSize / 1048576; });
  r.errors = errors.length;
  await context.close();
  return r;
}

const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const KEYS = [['serialiseMs', 'serialise at commit (ms, main thread)'], ['geoMB', 'cache geometry buffers (MB)'], ['stampMB', 'cache records, size stamp (MB)'],
  ['restoreMs', 'restore all from cache (ms, wall)'], ['restoreBusyMs', 'restore: main-thread busy (ms)'], ['deserialiseMs', '_geoDeserialize in that restore (ms)'], ['heapRestore', 'heap after restore (MB, post-GC)'], ['heapLoad', 'heap after fresh load (MB, post-GC)']];
const servers = [];
const fmt = (r) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(1) : v])));
// Runs alternate between the two code versions so background load on the
// machine hits both alike.
async function measureAll(targets) {
  const out = {};
  for (const [label, dir] of targets) { const sv = await serve(dir); servers.push(sv); out[label] = { port: sv.address().port, runs: [] }; }
  for (let i = 0; i < RUNS; i++) for (const [label] of targets) {
    const r = await run(out[label].port); out[label].runs.push(r); console.log(label + ' run ' + (i + 1) + ': ' + fmt(r));
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.runs]));
}
let failed = false;
try {
  console.log('federation: ' + FED.length + ' synthetic files, ' + (fedBytes / 1048576).toFixed(1) + ' MB IFC');
  const targets = [['current', root]];
  if (process.env.GEO_COST_REF_ROOT) targets.unshift(['reference', process.env.GEO_COST_REF_ROOT]);
  const out = await measureAll(targets);
  const c = out.current[0];
  console.log('meshes ' + c.live + ', distinct geometries ' + c.liveGeoms + ' (' + (100 * (1 - c.liveGeoms / c.live)).toFixed(1) + ' % of meshes reuse a geometry)');
  console.log('\nmedian of ' + RUNS + (out.reference ? '                       reference   current' : ''));
  for (const [k, name] of KEYS) {
    const cur = med(out.current.map((r) => r[k]));
    console.log('  ' + name.padEnd(40) + (out.reference ? med(out.reference.map((r) => r[k])).toFixed(1).padStart(10) : '') + cur.toFixed(1).padStart(10));
  }
  for (const [label, rs] of Object.entries(out)) for (const r of rs) {
    if (r.reparsed) { failed = true; console.error(label + ': ' + r.reparsed + ' model(s) re-parsed instead of restoring from the cache'); }
    if (r.serialiseN !== FED.length) { failed = true; console.error(label + ': expected ' + FED.length + ' cache serialisations, saw ' + r.serialiseN); }
    if (r.errors) { failed = true; console.error(label + ': ' + r.errors + ' page errors'); }
  }
} catch (e) { failed = true; console.error(e && e.stack || e); }
finally { await browser.close(); servers.forEach((s) => s.close()); }
process.exit(failed ? 1 : 0);
