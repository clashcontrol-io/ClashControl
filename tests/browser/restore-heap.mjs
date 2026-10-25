#!/usr/bin/env node
// Heap after a geometry-cache restore vs heap after a fresh load of the same
// SYNTHETIC federation (tests/fixtures generators only). One browser context:
//   1. fresh load of the files, wait until every geometry cache record is
//      written and the heap has settled          -> fresh
//   2. park every model, restore every model from the cache -> restore
//   3. project reopen: a NEW page in the same context (IndexedDB kept) restores
//      the project from the cache                 -> reopen
// Asserts restore and reopen are within a small margin of fresh, and that
// neither re-parsed an IFC (no 'cc:geoSerialize' entry).
//
// How the heap is read (and why — docs/INTERNALS.md §6 "Heap after a restore"):
//   - CDP HeapProfiler.collectGarbage, then Runtime.getHeapUsage (the page's
//     main isolate). A gc() called from page JS keeps more alive: after a
//     page RELOAD the previous document's whole heap stays in the same
//     isolate until a memory-reducing GC (the one CDP runs) collects it, so a
//     reload-then-gc() reading counted the old page too (~+125 MB on the
//     6-file federation of geo-cache-cost.mjs, appearing only under CPU load).
//     The reopen therefore runs in a new page, and every reading uses the
//     CDP GC.
//   - nothing the harness itself holds (File objects, records read back from
//     IndexedDB, mesh lists) is in scope when a reading is taken.
//   - settled: two readings 1 s apart within 0.5 MB.
// Env: RESTORE_HEAP_RUNS (default 1; median), RESTORE_HEAP_SHARED (shared-shape
// models next to the medium building, default 1), RESTORE_HEAP_REF_ROOT
// (another checkout, measured interleaved for comparison only).
//   CC_CHROMIUM_EXECUTABLE=/path CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/restore-heap.mjs
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
const RUNS = +(process.env.RESTORE_HEAP_RUNS || 1);
// margin: restore / reopen may exceed fresh by at most this much
const MARGIN_REL = 0.03, MARGIN_MB = 2;

const files = new Map();
const gen = generateBuilding({ scale: 'medium', seed: 4242, georef: 'local', dense: 0.3 });
for (const k of Object.keys(gen.files)) files.set('/__gen/rh-' + k + '.ifc', Buffer.from(gen.files[k]));
const SHARED = +(process.env.RESTORE_HEAP_SHARED ?? 1);
for (let i = 0; i < SHARED; i++) files.set('/__gen/rh-shared-' + i + '.ifc', Buffer.from(generateShardIfc({ storeys: 8, perStorey: 1500, seed: 11 + i, smallShare: true })));
const FED = [...files.keys()];

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
  args: ['--enable-precise-memory-info', '--js-flags=--max-old-space-size=8192'] });

// Main-isolate heap after a memory-reducing GC, once two readings 1 s apart agree.
async function settledHeapMB(page) {
  const cdp = await page.context().newCDPSession(page);
  const read = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize / 1048576; };
  let prev = await read();
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(1000);
    const v = await read();
    if (Math.abs(v - prev) < 0.5) { prev = v; break; }
    prev = v;
  }
  await cdp.detach();
  return prev;
}
const allModelsIn = (n) => window._ccLatestState && window._ccLatestState.models.length === n && window._ccModelLoading === false && !window._ccLatestState.switchingProject;

async function run(port) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  if (offlineDepsEnabled()) await routeOfflineDeps(context, root);
  const errors = [];
  const open = async () => {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('dialog', (d) => d.accept());
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.mg, null, { timeout: 120_000 });
    return page;
  };
  const page = await open();
  await page.evaluate(async (names) => {
    const fs = await Promise.all(names.map(async (n) => new File([await (await fetch(n)).arrayBuffer()], n.split('/').pop())));
    window.ClashControl.loadFiles(fs);
  }, FED);
  // every model in, and every geometry cache record written (keys only)
  for (const t0 = Date.now(); ;) {
    const done = await page.evaluate(async (n) => {
      const s = window._ccLatestState;
      if (!(s && s.models.length === n && window._ccModelLoading === false)) return false;
      const db = await new Promise((res) => { const q = indexedDB.open('ClashControlFiles'); q.onsuccess = () => res(q.result); });
      try { return await new Promise((res) => { const q = db.transaction('geoCache', 'readonly').objectStore('geoCache').count(); q.onsuccess = () => res(q.result >= n); }); }
      finally { db.close(); }
    }, FED.length);
    if (done) break;
    if (Date.now() - t0 > 1_500_000) throw new Error('load / cache write timed out');
    await page.waitForTimeout(500);
  }
  const r = { fresh: await settledHeapMB(page) };
  r.elements = await page.evaluate(() => window._ccLatestState.models.reduce((n, m) => n + m.elements.length, 0));

  await page.evaluate(async () => {
    const ids = window._ccLatestState.models.map((m) => m.id);
    for (const id of ids) {
      await window.ClashControl.parkModel(id);
      while (!(window._ccLatestState.parkedModels || []).some((p) => p.id === id)) await new Promise((res) => setTimeout(res, 20));
    }
    window.__rhSer = performance.getEntriesByName('cc:geoSerialize').length;
  });
  r.parked = await settledHeapMB(page);
  await page.evaluate(async () => {
    const ids = window._ccLatestState.parkedModels.map((m) => m.id);
    for (const id of ids) {
      await window.ClashControl.restoreModel(id);
      while (!window._ccLatestState.models.some((m) => m.id === id)) await new Promise((res) => setTimeout(res, 5));
    }
  });
  await page.waitForFunction(allModelsIn, FED.length, { timeout: 600_000 });
  r.restore = await settledHeapMB(page);
  r.restoreReparsed = await page.evaluate(() => performance.getEntriesByName('cc:geoSerialize').length - window.__rhSer);
  r.restoreElements = await page.evaluate(() => window._ccLatestState.models.reduce((n, m) => n + m.elements.length, 0));

  // project reopen in a new page (the old one closed first)
  await page.close();
  const page2 = await open();
  await page2.waitForFunction(allModelsIn, FED.length, { timeout: 600_000 });
  r.reopen = await settledHeapMB(page2);
  r.reopenReparsed = await page2.evaluate(() => performance.getEntriesByName('cc:geoSerialize').length);
  r.reopenElements = await page2.evaluate(() => window._ccLatestState.models.reduce((n, m) => n + m.elements.length, 0));
  r.errors = errors.length;
  await context.close();
  return r;
}

const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const fmt = (r) => JSON.stringify(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(1) : v])));
const servers = [];
let failed = false;
try {
  console.log('federation: ' + FED.length + ' synthetic files');
  const targets = [['current', root]];
  if (process.env.RESTORE_HEAP_REF_ROOT) targets.unshift(['reference', process.env.RESTORE_HEAP_REF_ROOT]);
  const out = {};
  for (const [label, dir] of targets) { const sv = await serve(dir); servers.push(sv); out[label] = { port: sv.address().port, runs: [] }; }
  for (let i = 0; i < RUNS; i++) for (const [label] of targets) {
    const r = await run(out[label].port); out[label].runs.push(r); console.log(label + ' run ' + (i + 1) + ': ' + fmt(r));
  }
  console.log('\nmain-isolate heap, MB (median of ' + RUNS + ')' + (out.reference ? '      reference   current' : ''));
  for (const k of ['fresh', 'parked', 'restore', 'reopen']) {
    console.log('  ' + k.padEnd(10) + (out.reference ? med(out.reference.runs.map((r) => r[k])).toFixed(1).padStart(30) : '') + med(out.current.runs.map((r) => r[k])).toFixed(1).padStart(out.reference ? 10 : 30));
  }
  for (const r of out.current.runs) {
    const limit = r.fresh * (1 + MARGIN_REL) + MARGIN_MB;
    for (const k of ['restore', 'reopen']) {
      if (!(r[k] <= limit)) { failed = true; console.error(`${k}: heap ${r[k].toFixed(1)} MB > fresh ${r.fresh.toFixed(1)} MB + margin (${limit.toFixed(1)} MB)`); }
    }
    if (r.restoreReparsed || r.reopenReparsed) { failed = true; console.error('an IFC was re-parsed instead of restored from the cache'); }
    if (r.restoreElements !== r.elements || r.reopenElements !== r.elements) { failed = true; console.error('element count differs after restore / reopen'); }
    if (r.errors) { failed = true; console.error(r.errors + ' page errors'); }
  }
  if (!failed) console.log('\nOK: heap after restore and after reopen within ' + (MARGIN_REL * 100) + ' % + ' + MARGIN_MB + ' MB of the fresh load');
} catch (e) { failed = true; console.error(e && e.stack || e); }
finally { await browser.close(); servers.forEach((s) => s.close()); }
process.exit(failed ? 1 : 0);
