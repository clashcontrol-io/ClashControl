#!/usr/bin/env node
// A model restored from the geometry cache (park → restore, project reopen,
// project switch) must be the SAME geometry as a fresh load: world-space
// vertex positions and indices byte-identical, and an identical clash list.
// The cache used to store 16-bit positions per mesh bbox (up to ~0.8 mm off
// on a 100 m run), so clash results could change after a reopen.
// Fixture: generated architecture + structure + MEP federation (far georef
// by default, where any precision loss shows).
// Usage: CC_CHROMIUM_EXECUTABLE=/path CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/cache-restore-exact.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../..', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ifc': 'application/octet-stream', '.css': 'text/css',
};
const require = createRequire(import.meta.url);
const { generateBuilding } = require(join(root, 'tests/fixtures/generate-building-ifc.js'));
const gen = generateBuilding({ scale: process.env.CC_GEN_SCALE || 'ci', seed: 4242, georef: process.env.CC_GEN_GEOREF || 'far' });
const files = new Map();
for (const k of ['architecture', 'structure', 'mep']) files.set('/__gen/' + gen.fileNames[k], Buffer.from(gen.files[k]));
const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (files.has(urlPath)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(files.get(urlPath)); }
    const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(8768, '127.0.0.1', r));

const localChromium = process.env.CC_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(localChromium ? {
  executablePath: localChromium,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--no-zygote',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
} : {});
const page = await browser.newPage();
page.on('dialog', (d) => d.accept());
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

if (process.env.CC_BROWSER_OFFLINE_DEPS === '1') {
  async function local(route, file, contentType) {
    await route.fulfill({ status: 200, body: await readFile(join(root, 'node_modules', file)),
      headers: { 'content-type': contentType || 'text/javascript', 'access-control-allow-origin': '*' } });
  }
  await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
  await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
  await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
  await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
  await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.worker.min.js'));
  await page.context().route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', async (route) => {
    const suffix = new URL(route.request().url()).pathname.split('/three@0.180.0/')[1];
    await local(route, 'three/' + suffix);
  });
  await page.context().route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', async (route) => {
    const suffix = new URL(route.request().url()).pathname.split('/web-ifc@0.0.77/')[1];
    await local(route, 'web-ifc/' + suffix, suffix.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  });
  await page.context().route('https://fonts.googleapis.com/**', (route) => route.fulfill({status:200, body:'', contentType:'text/css'}));
  await page.context().route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.context().route('https://gc.zgo.at/**', (route) => route.fulfill({status:200, body:'', contentType:'text/javascript'}));
}

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + ' — ' + name + (detail ? ' :: ' + detail : ''));
}

// Per-model digest of the geometry clash detection sees: every element's
// meshes, world-space vertex positions (Float32 bytes) + index bytes, in order.
const digest = () => page.evaluate(() => {
  const out = {};
  const v = new window.THREE.Vector3();
  for (const m of window._ccLatestState.models) {
    let h1 = 2166136261, h2 = 5381, nV = 0;
    const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
    const mix = (x) => { h1 = Math.imul(h1 ^ x, 16777619); h2 = (Math.imul(h2, 33) + x) | 0; };
    const els = m.elements.slice().sort((a, b) => a.expressId - b.expressId);
    for (const el of els) {
      mix(el.expressId);
      for (const ms of (el.meshes || [])) {
        const g = ms.geometry, p = g.attributes.position, idx = g.index;
        ms.updateMatrixWorld(true);
        for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(ms.matrixWorld); for (const c of [v.x, v.y, v.z]) { f32[0] = c; mix(u32[0]); } nV++; }
        if (idx) for (let i = 0; i < idx.count; i++) mix(idx.getX(i));
      }
    }
    out[m.name] = { elements: m.elements.length, vertices: nV, h: (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) };
  }
  return out;
});
const clashList = () => page.evaluate(() => window._ccLatestState.clashes.map((c) => {
  const o = {}; Object.keys(c).sort().forEach((k) => { if (!/^(id|createdAt|_?updatedAt|_runId|_runCount|_seenRuns|_lastSeen|_delta|_prev[A-Z]|history|_hist)/.test(k)) o[k] = c[k]; }); return JSON.stringify(o);
}).sort());

try {
  await page.goto('http://127.0.0.1:8768/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 60_000 });
  const names = [...files.keys()];
  await page.evaluate(async (names) => {
    const fs = [];
    for (const n of names) fs.push(new File([await (await fetch(n)).arrayBuffer()], n.split('/').pop()));
    window.ClashControl.loadFiles(fs);
  }, names);
  await page.waitForFunction((n) => window._ccLatestState && window._ccLatestState.models.length === n && window._ccModelLoading === false, names.length, { timeout: 300_000 });
  // Wait until every model's geometry cache is written.
  await page.waitForFunction(async (n) => {
    const db = await new Promise((res) => { const r = indexedDB.open('ClashControlFiles'); r.onsuccess = () => res(r.result); });
    const keys = await new Promise((res) => { const q = db.transaction('geoCache', 'readonly').objectStore('geoCache').getAllKeys(); q.onsuccess = () => res(q.result); });
    db.close(); return keys.length >= n;
  }, names.length, { timeout: 120_000, polling: 500 });

  const d0 = await digest();
  await page.evaluate(() => window.ClashControl.runDetection({ fullRerun: true }));
  await page.waitForFunction(() => !window._ccLatestState.detecting && window._ccLatestState.clashes.length > 0, null, { timeout: 300_000 });
  const c0 = await clashList();

  // Park + restore every model: geometry comes back from the cache.
  const ids = await page.evaluate(() => window._ccLatestState.models.map((m) => m.id));
  for (const id of ids) {
    const parked = await page.evaluate((id) => window.ClashControl.parkModel(id), id);
    if (!parked) throw new Error('could not park ' + id);
    await page.waitForFunction((id) => (window._ccLatestState.parkedModels || []).some((p) => p.id === id), id, { timeout: 60_000 });
    await page.evaluate((id) => window.ClashControl.restoreModel(id), id);
    await page.waitForFunction((id) => !(window._ccLatestState.parkedModels || []).length && window._ccLatestState.models.some((m) => m.id === id), id, { timeout: 180_000 });
  }
  const d1 = await digest();
  const same = Object.keys(d0).length === Object.keys(d1).length && Object.keys(d0).every((k) => d1[k] && d1[k].h === d0[k].h && d1[k].vertices === d0[k].vertices && d1[k].elements === d0[k].elements);
  report('restored geometry is byte-identical to the fresh load (world positions + indices)', same, JSON.stringify({ fresh: d0, restored: d1 }));

  await page.evaluate(() => window.ClashControl.runDetection({ fullRerun: true }));
  await page.waitForFunction(() => !window._ccLatestState.detecting, null, { timeout: 300_000 });
  await page.waitForTimeout(500);
  const c1 = await clashList();
  const diff = c0.filter((x, i) => x !== c1[i]).length;
  if (diff) { const a = JSON.parse(c0[0]), b = JSON.parse(c1[0]); console.log('FIELD DIFF', JSON.stringify(Object.keys(Object.assign({}, a, b)).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => [k, a[k], b[k]])).slice(0, 1500)); }
  report('clash results after restore are identical to the fresh load', c0.length === c1.length && diff === 0, c0.length + ' vs ' + c1.length + ' clashes, ' + diff + ' differ');
  report('no uncaught page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  report('test crashed', false, String(e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
const failed = results.filter((x) => !x.ok).length;
console.log('\n--- SUMMARY: ' + (results.length - failed) + '/' + results.length + ' passed ---');
process.exit(failed ? 1 : 0);
