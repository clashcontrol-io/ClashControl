#!/usr/bin/env node
// A model restored from the geometry cache (park → restore, project reopen,
// project switch) must be the SAME geometry as a fresh load: world-space
// vertex positions and indices byte-identical, and an identical clash list.
// The cache used to store 16-bit positions per mesh bbox (up to ~0.8 mm off
// on a 100 m run), so clash results could change after a reopen.
// Fixture: generated architecture + structure + MEP federation (far georef
// by default, where any precision loss shows) plus a generated model whose
// shapes are reused by many elements (geometry sharing).
// gs:1 caches store each shared geometry once: after a restore the meshes
// must share BufferGeometry objects exactly like the fresh load (same
// partition of meshes by geometry, same instancing / batching), the rendered
// frame must be pixel-identical, and the stored record must be smaller than
// the per-mesh layout of the same model.
// Usage: CC_CHROMIUM_EXECUTABLE=/path CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/cache-restore-exact.mjs
// (CC_PIXELS_DUMP=/path/frame.png also writes both compared frames.)
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
const { generateShardIfc } = require(join(root, 'tests/fixtures/generate-synthetic-ifc.js'));
const gen = generateBuilding({ scale: process.env.CC_GEN_SCALE || 'ci', seed: 4242, georef: process.env.CC_GEN_GEOREF || 'far' });
const files = new Map();
for (const k of ['architecture', 'structure', 'mep']) files.set('/__gen/' + gen.fileNames[k], Buffer.from(gen.files[k]));
files.set('/__gen/shared-shapes.ifc', Buffer.from(generateShardIfc({ storeys: 4, perStorey: 900, seed: 11, smallShare: true })));
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
// Model version comparison: every element's geometry signature
// (model-diff-core.js via _ccElementGeoSig), per model and element — a
// restored model compared with its fresh load must show no change.
const geoSigs = () => page.evaluate(() => {
  const out = {};
  for (const m of window._ccLatestState.models) {
    const o = {};
    for (const el of m.elements) o[el.expressId] = window._ccElementGeoSig(el);
    out[m.name] = o;
  }
  return out;
});
const clashList = () => page.evaluate(() => window._ccLatestState.clashes.map((c) => {
  const o = {}; Object.keys(c).sort().forEach((k) => { if (!/^(id|createdAt|_?updatedAt|_runId|_runCount|_seenRuns|_lastSeen|_delta|_prev[A-Z]|history|_hist)/.test(k)) o[k] = c[k]; }); return JSON.stringify(o);
}).sort());

// Geometry sharing per model: distinct BufferGeometry objects among the
// element meshes, the partition of meshes by geometry (element order, first
// appearance numbering) and what instancing / batching built from it.
const sharing = () => page.evaluate(() => {
  const out = {};
  for (const m of window._ccLatestState.models) {
    const id = new Map(), part = [];
    let meshes = 0;
    for (const el of m.elements.slice().sort((a, b) => a.expressId - b.expressId)) {
      for (const ms of (el.meshes || [])) { if (!id.has(ms.geometry)) id.set(ms.geometry, id.size); part.push(id.get(ms.geometry)); meshes++; }
    }
    let h = 2166136261; for (const x of part) h = Math.imul(h ^ x, 16777619);
    const scene = m.meshes || [];
    const batchGeoms = scene.filter((x) => x.isBatchedMesh).reduce((n, b) => n + new Set(b.userData.batchGeomIds.filter((g) => g != null)).size, 0);
    out[m.name] = { meshes, geometries: id.size, partition: (h >>> 0).toString(36), scene: scene.length,
      instanced: scene.filter((x) => x.isInstancedMesh).length, batches: scene.filter((x) => x.isBatchedMesh).length, batchGeoms };
  }
  return out;
});
// One frame from a fixed camera on the shared-shapes model (the generated
// building is far-georeferenced, so a camera over both sees nothing), read
// back in the same task as the render.
const pixels = () => page.evaluate(async () => {
  const S = window._ccState3d, b = new window.THREE.Box3();
  for (const m of window._ccLatestState.models) if (m.name === 'shared-shapes') for (const e of m.elements) if (!e.box.isEmpty()) b.union(e.box);
  const c = b.getCenter(new window.THREE.Vector3()), d = b.getSize(new window.THREE.Vector3()).length();
  S.camera.position.set(c.x + d * 0.5, c.y + d * 0.35, c.z + d * 0.5); S.camera.lookAt(c);
  S.camera.near = d * 0.001; S.camera.far = d * 10; S.camera.updateProjectionMatrix(); S.camera.updateMatrixWorld();
  if (S.orbit && S.orbit.target) { S.orbit.target.copy(c); if (S.orbit.sync) S.orbit.sync(); }
  // re-run the frustum/LOD cull for this camera (it is skipped while the
  // camera is unchanged, and restored meshes are new objects)
  S._lastCullCamKey = ''; S._forceCull = true; window._ccInvalidate(10);
  await new Promise((res) => setTimeout(res, 500));
  S.renderer.render(S.scene, S.camera);
  const url = S.renderer.domElement.toDataURL('image/png');
  let h = 2166136261; for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return { hash: h.toString(16), len: url.length, url: window.__ccDumpPixels ? url : undefined };
});
// The stored cache records: geometry bytes as stored, and what the per-mesh
// layout (one copy per mesh, before gs:1) would hold for the same meshes.
const cacheBytes = () => page.evaluate(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('ClashControlFiles'); r.onsuccess = () => res(r.result); });
  const recs = await new Promise((res) => { const q = db.transaction('geoCache', 'readonly').objectStore('geoCache').getAll(); q.onsuccess = () => res(q.result); });
  db.close();
  const len = (o) => ['pos', 'n8', 'nrm', 'idx'].reduce((n, k) => n + (o && o[k] ? o[k].byteLength : 0), 0);
  let stored = 0, perMesh = 0, gs = 0, meshes = 0, geos = 0;
  for (const r of recs) {
    const d = r.data; if (d.gs === 1) gs++;
    meshes += d.meshData.length; geos += d.gs === 1 ? d.geoData.length : d.meshData.length;
    if (d.gs === 1) { for (const g of d.geoData) stored += len(g); for (const md of d.meshData) perMesh += len(d.geoData[md.g]); }
    else for (const md of d.meshData) { stored += len(md); perMesh += len(md); }
  }
  return { records: recs.length, gs, meshes, geometries: geos, storedMB: +(stored / 1048576).toFixed(2), perMeshMB: +(perMesh / 1048576).toFixed(2) };
});

try {
  // CC_GEO_V8=1: the same checks with the v8 (validated) geometry cache on
  await page.goto('http://127.0.0.1:8768/' + (process.env.CC_GEO_V8 === '1' ? '?ccSafety=geoCacheV8' : ''), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 60_000 });
  const names = [...files.keys()];
  await page.evaluate(async (names) => {
    const fs = [];
    for (const n of names) fs.push(new File([await (await fetch(n)).arrayBuffer()], n.split('/').pop()));
    window.ClashControl.loadFiles(fs);
  }, names);
  await page.waitForFunction((n) => window._ccLatestState && window._ccLatestState.models.length === n && window._ccModelLoading === false, names.length, { timeout: 300_000 });
  // Wait until every model's geometry cache is written.
  const cacheKeys = await page.evaluate(async (n) => {
    const t0 = Date.now();
    for (;;) {
      const db = await new Promise((res) => { const r = indexedDB.open('ClashControlFiles'); r.onsuccess = () => res(r.result); });
      const keys = await new Promise((res) => { const q = db.transaction('geoCache', 'readonly').objectStore('geoCache').getAllKeys(); q.onsuccess = () => res(q.result); });
      db.close();
      if (keys.length >= n || Date.now() - t0 > 120000) return keys.length;
      await new Promise((r) => setTimeout(r, 500));
    }
  }, names.length);
  if (cacheKeys < names.length) throw new Error('geometry caches not written: ' + cacheKeys + ' of ' + names.length);
  const d0 = await digest();
  const g0 = await geoSigs();
  const s0 = await sharing();
  const cb = await cacheBytes();
  report('every cache record stores shared geometries once (gs:1) and is smaller than the per-mesh layout',
    cb.gs === cb.records && cb.records === names.length && cb.geometries < cb.meshes && cb.storedMB < cb.perMeshMB, JSON.stringify(cb));
  report('the fixture shares geometry (>= 30 % of meshes reuse one) and is batched (BatchedMesh adds a shared geometry once)', Object.values(s0).some((x) => x.geometries <= 0.7 * x.meshes && x.batches > 0), JSON.stringify(s0));
  await page.evaluate(() => window.ClashControl.runDetection({ fullRerun: true }));
  await page.waitForFunction(() => !window._ccLatestState.detecting && window._ccLatestState.clashes.length > 0, null, { timeout: 300_000 });
  const c0 = await clashList();
  // the frame is taken with the same clash state the restored models see
  if (process.env.CC_PIXELS_DUMP) await page.evaluate(() => { window.__ccDumpPixels = true; });
  const p0 = await pixels();
  if (p0.url) { (await import('node:fs')).writeFileSync(process.env.CC_PIXELS_DUMP, Buffer.from(p0.url.split(',')[1], 'base64')); delete p0.url; }

  // Park + restore every model: geometry comes back from the cache (a
  // cold re-parse would serialise again — counted via the 'cc:geoSerialize'
  // User Timing entry _geoSerialize records).
  const serialisedBefore = await page.evaluate(() => performance.getEntriesByName('cc:geoSerialize').length);
  const ids = await page.evaluate(() => window._ccLatestState.models.map((m) => m.id));
  // "Can it be restored?" (asked at park time) reads keys + the stored
  // validator verdict, never a geometry record (§6)
  const verdicts = await page.evaluate(async () => {
    const S = IDBObjectStore.prototype, g = S.get;
    window.__geoGets = 0;
    if (!S.__ccCounted) { S.get = function () { if (this.name === 'geoCache') window.__geoGets++; return g.apply(this, arguments); }; S.__ccCounted = true; }
    const db = await new Promise((res) => { const r = indexedDB.open('ClashControlFiles'); r.onsuccess = () => res(r.result); });
    const rows = await new Promise((res) => { const q = db.transaction('geoOk', 'readonly').objectStore('geoOk').getAll(); q.onsuccess = () => res(q.result); });
    db.close();
    return { v8: window._ccSafetyMigrations.isEnabled('geoCacheV8'), version: db.version, rows: rows.map((r) => r.ok) };
  });
  // v8 records are validated: each carries its verdict; unversioned ones are
  // never validated (restorable = the record exists), so none is stored
  report('geometry cache verdicts: v8 → one stored with each record (ok), else none', verdicts.version >= 5 &&
    (verdicts.v8 ? verdicts.rows.length === names.length && verdicts.rows.every((x) => x === 1) : verdicts.rows.length === 0), JSON.stringify(verdicts));
  const parkReads = [];
  for (const id of ids) {
    await page.evaluate(() => { window.__geoGets = 0; });
    const parked = await page.evaluate((id) => window.ClashControl.parkModel(id), id);
    parkReads.push(await page.evaluate(() => window.__geoGets));
    if (!parked) throw new Error('could not park ' + id);
    await page.waitForFunction((id) => (window._ccLatestState.parkedModels || []).some((p) => p.id === id), id, { timeout: 60_000 });
    await page.evaluate((id) => window.ClashControl.restoreModel(id), id);
    await page.waitForFunction((id) => !(window._ccLatestState.parkedModels || []).length && window._ccLatestState.models.some((m) => m.id === id), id, { timeout: 180_000 });
  }
  report('parking read no geometry record (keys + verdict only)', parkReads.every((n) => n === 0), JSON.stringify(parkReads));
  const serialisedAfter = await page.evaluate(() => performance.getEntriesByName('cc:geoSerialize').length);
  report('every model was restored from its cache (no re-parse)', serialisedBefore === names.length && serialisedAfter === serialisedBefore, serialisedBefore + ' -> ' + serialisedAfter + ' serialisations');
  const d1 = await digest();
  const same = Object.keys(d0).length === Object.keys(d1).length && Object.keys(d0).every((k) => d1[k] && d1[k].h === d0[k].h && d1[k].vertices === d0[k].vertices && d1[k].elements === d0[k].elements);
  report('restored geometry is byte-identical to the fresh load (world positions + indices)', same, JSON.stringify({ fresh: d0, restored: d1 }));
  const g1 = await geoSigs();
  const sigDiff = [];
  for (const k of Object.keys(g0)) for (const id of Object.keys(g0[k])) if (!g1[k] || g1[k][id] !== g0[k][id]) sigDiff.push(k + '#' + id);
  report('version comparison: restored geometry signatures equal the fresh load (no false changes)', Object.keys(g0).length === names.length && sigDiff.length === 0 && Object.values(g0).every((o) => Object.values(o).some((x) => x)),
    sigDiff.length + ' differ' + (sigDiff.length ? ': ' + sigDiff.slice(0, 5).join(', ') : ''));
  const s1 = await sharing();
  report('restored models share geometry exactly like the fresh load (partition, instancing, batching)', JSON.stringify(s1) === JSON.stringify(s0), JSON.stringify({ fresh: s0, restored: s1 }));
  const p1 = await pixels();
  if (p1.url) { (await import('node:fs')).writeFileSync(process.env.CC_PIXELS_DUMP.replace(/\.png$/, '-restored.png'), Buffer.from(p1.url.split(',')[1], 'base64')); delete p1.url; }
  report('rendered frame after restore is pixel-identical to the fresh load', p1.hash === p0.hash && p0.len > 60000, JSON.stringify({ fresh: p0, restored: p1 }));

  await page.evaluate(() => window.ClashControl.runDetection({ fullRerun: true }));
  await page.waitForFunction(() => !window._ccLatestState.detecting, null, { timeout: 300_000 });
  await page.waitForTimeout(500);
  const c1 = await clashList();
  const diff = c0.filter((x, i) => x !== c1[i]).length;
  if (diff) { const a = JSON.parse(c0[0]), b = JSON.parse(c1[0]); console.log('FIELD DIFF', JSON.stringify(Object.keys(Object.assign({}, a, b)).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => [k, a[k], b[k]])).slice(0, 1500)); }
  report('clash results after restore are identical to the fresh load', c0.length === c1.length && diff === 0, c0.length + ' vs ' + c1.length + ' clashes, ' + diff + ' differ');
  // a v8 record stored before verdicts existed is read + validated as before
  // (last: a park / restore changes the model order the checks above compare)
  if (verdicts.v8) {
  const legacy = await page.evaluate(async (id) => {
    const db = await new Promise((res) => { const r = indexedDB.open('ClashControlFiles'); r.onsuccess = () => res(r.result); });
    await new Promise((res) => { const tx = db.transaction('geoOk', 'readwrite'); tx.objectStore('geoOk').clear(); tx.oncomplete = res; });
    db.close();
    window.__geoGets = 0;
    const parked = await window.ClashControl.parkModel(id);
    const reads = window.__geoGets;
    // restore once the park is in the state (as the loop above does)
    await new Promise((res) => { (function w() { if ((window._ccLatestState.parkedModels || []).some((p) => p.id === id)) res(); else setTimeout(w, 50); })(); });
    await window.ClashControl.restoreModel(id);
    return { parked, reads };
  }, ids[0]);
  await page.waitForFunction((id) => !(window._ccLatestState.parkedModels || []).length && window._ccLatestState.models.some((m) => m.id === id), ids[0], { timeout: 180_000 });
  report('a cache record without a stored verdict is read and validated once at park (as before)', legacy.parked === true && legacy.reads === 1, JSON.stringify(legacy));
  }
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
