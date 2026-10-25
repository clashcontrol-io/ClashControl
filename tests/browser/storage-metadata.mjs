#!/usr/bin/env node
// Storage metadata without reading stored data: the IndexedDB v4 'cc_meta'
// key indexes let the storage report and the budget check size every
// project from index keys alone (no record deserialisation — stored IFC
// buffers and geometry caches are never pulled into memory for it), a v3
// database upgrades in place, unstamped legacy records are read one by one,
// and a project's files are found through the projectId index.
// Usage: CC_CHROMIUM_EXECUTABLE=/path CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/storage-metadata.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../..', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ifc': 'application/octet-stream', '.css': 'text/css',
};
const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(8767, '127.0.0.1', r));

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

try {
  // ── Seed a v3 database (the layout before the metadata indexes) on the
  //    app's origin, before the app opens it. ──
  await page.goto('http://127.0.0.1:8767/version.json');
  await page.evaluate(async () => {
    await new Promise((res, rej) => { const d = indexedDB.deleteDatabase('ClashControlFiles'); d.onsuccess = res; d.onerror = rej; d.onblocked = res; });
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('ClashControlFiles', 3);
      r.onupgradeneeded = () => { const d = r.result; ['ifcFiles', 'projects', 'geoCache'].forEach((n) => d.createObjectStore(n, { keyPath: 'id' })); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const big = (n) => new Uint8Array(n);
    const tx = db.transaction(['ifcFiles', 'projects', 'geoCache'], 'readwrite');
    tx.objectStore('ifcFiles').put({ id: 'fa', name: 'a.ifc', buffer: big(1 << 20).buffer, projectId: 'pA', savedAt: 1000, bytes: (1 << 20) + 100 });
    tx.objectStore('ifcFiles').put({ id: 'fb', name: 'b.ifc', buffer: big(1 << 20).buffer, projectId: 'pB', savedAt: 2000, bytes: (1 << 20) + 100 });
    tx.objectStore('ifcFiles').put({ id: 'fc', name: 'legacy.ifc', buffer: big(4096).buffer, projectId: 'pA', savedAt: 3000 }); // no bytes stamp
    tx.objectStore('geoCache').put({ id: 'v8:fa', sourceId: 'fa', schema: 8, data: { meshData: [big(1 << 19)] }, savedAt: 1500, bytes: (1 << 19) + 50 });
    tx.objectStore('projects').put({ id: 'pA', clashes: [], bytes: 300 });
    await new Promise((res) => { tx.oncomplete = res; });
    db.close();
  });

  // Count every record read on the stores that hold buffers / geometry.
  await page.addInitScript(() => {
    window.__idbReads = { get: [], getAll: [], cursor: 0 };
    const S = IDBObjectStore.prototype, I = IDBIndex.prototype;
    const g = S.get, ga = S.getAll, oc = S.openCursor, ig = I.get, iga = I.getAll, ioc = I.openCursor;
    S.get = function (k) { window.__idbReads.get.push(this.name + ':' + k); return g.apply(this, arguments); };
    S.getAll = function () { window.__idbReads.getAll.push(this.name); return ga.apply(this, arguments); };
    S.openCursor = function () { window.__idbReads.cursor++; return oc.apply(this, arguments); };
    I.get = function () { window.__idbReads.get.push(this.objectStore.name + '#' + this.name); return ig.apply(this, arguments); };
    I.getAll = function () { window.__idbReads.getAll.push(this.objectStore.name + '#' + this.name); return iga.apply(this, arguments); };
    I.openCursor = function () { window.__idbReads.cursor++; return ioc.apply(this, arguments); };
  });
  await page.goto('http://127.0.0.1:8767/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 60_000 });

  // ── Upgrade: v4 with the metadata indexes, records intact ──
  const up = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('ClashControlFiles'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const tx = db.transaction(['ifcFiles', 'geoCache', 'projects'], 'readonly');
    const out = { version: db.version, ifcIdx: [...tx.objectStore('ifcFiles').indexNames], geoIdx: [...tx.objectStore('geoCache').indexNames], projIdx: [...tx.objectStore('projects').indexNames] };
    out.keys = await new Promise((res) => { const r = tx.objectStore('ifcFiles').getAllKeys(); r.onsuccess = () => res(r.result); });
    db.close();
    return out;
  });
  report('v3 database upgrades to v4 with metadata indexes, records kept',
    up.version >= 4 && up.ifcIdx.includes('cc_meta') && up.ifcIdx.includes('projectId') && up.geoIdx.includes('cc_meta') && up.projIdx.includes('cc_meta') && up.keys.length === 3,
    JSON.stringify(up));

  // ── Storage report reads metadata only ──
  const r = await page.evaluate(async () => {
    window.__idbReads = { get: [], getAll: [], cursor: 0 };
    const rep = await window.ClashControl.storage.report();
    return { reads: window.__idbReads, perProject: rep && rep.perProject.map((p) => ({ id: p.projectId, ifc: p.ifcBytes, geo: p.geoBytes })) };
  });
  const byId = Object.fromEntries((r.perProject || []).map((p) => [p.id, p]));
  report('storage report: no getAll/cursor over stored records', r.reads.getAll.length === 0 && r.reads.cursor === 0, JSON.stringify(r.reads));
  report('storage report: only the unstamped legacy record is read', r.reads.get.length === 1 && r.reads.get[0] === 'ifcFiles:fc', JSON.stringify(r.reads.get));
  report('storage report: sizes per project from the index (incl. legacy + geometry cache)',
    byId.pA && byId.pB && byId.pA.ifc >= (1 << 20) + 100 + 4096 && byId.pB.ifc === (1 << 20) + 100 && byId.pA.geo === (1 << 19) + 50,
    JSON.stringify(r.perProject));

  // ── Budget enforcement reads metadata only too ──
  const b = await page.evaluate(async () => {
    window.__idbReads = { get: [], getAll: [], cursor: 0 };
    await window._ccStorageEnforceBudget();
    return window.__idbReads;
  });
  report('budget check: no getAll/cursor over stored records', b.getAll.length === 0 && b.cursor === 0, JSON.stringify(b));

  // ── One project's files via the projectId index ──
  const pf = await page.evaluate(async () => {
    window.__idbReads = { get: [], getAll: [], cursor: 0 };
    await window._ccDeleteProjectStorage('pB');
    const db = await new Promise((res, rej) => { const q = indexedDB.open('ClashControlFiles'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const keys = await new Promise((res) => { const q = db.transaction('ifcFiles', 'readonly').objectStore('ifcFiles').getAllKeys(); q.onsuccess = () => res(q.result); });
    db.close();
    return { reads: window.__idbReads, keys };
  });
  report('project delete reads only that project\'s files (projectId index)',
    pf.reads.getAll.every((x) => x === 'ifcFiles#projectId' || x.indexOf('ifcFiles') < 0) && !pf.keys.includes('fb') && pf.keys.includes('fa') && pf.keys.includes('fc'),
    JSON.stringify(pf));

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
