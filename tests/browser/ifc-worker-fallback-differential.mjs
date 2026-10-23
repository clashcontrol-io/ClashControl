#!/usr/bin/env node
// REWRITE_UI_PLAN.md Phase 7 — differential fixture the plan calls a
// PREREQUISITE for ever splitting the IFC worker into a real static file
// ("compare complete model fingerprints before removing the serialized
// worker"). This does NOT do that split — it builds and runs the
// comparison harness the split would need, on the worker as it exists
// today (assembled via .toString() at runtime — see _getIFCWorkerUrl).
//
// Loads the SAME fixture IFC twice in the SAME page: once through the real
// Worker path, once forced through the main-thread fallback (same trick
// smoke.mjs uses — stub out window.Worker so the constructor throws), then
// compares window._ccSafetyMigrations.modelFingerprint() output between the
// two resulting models. That fingerprint (box bounds + mesh count + IFC
// type per element, order-independent) already exists precisely for this
// kind of before/after equivalence check — see safety-migrations.js.
//
// Coverage: an external review of the browser-first large-model plan
// (2026-07-17) flagged that this harness only ever exercised one small
// two-wall fixture — not enough to trust before touching the loader's
// worker-transfer protocol (see the zero-copy input-buffer transfer change
// in the same commit as this expansion). Runs a case matrix instead of one
// fixture: the original two-wall smoke case, the committed multi-storey
// fixture, and four cases generated on the fly via
// generate-synthetic-ifc.js's opt-in extensions — quantities (IfcElement
// Quantity), unit conversion (millimetre IfcSIUnit — exercises geoFactor),
// IFC4 georeferencing (IfcSite RefLatitude/Longitude compound values +
// IfcMapConversion/IfcProjectedCRS), and a deliberately null-valued
// ("degenerate") property record — spec-valid STEP, not invalid syntax
// that could make the two parse paths crash differently instead of
// diverge measurably.
//
// Usage: CC_CHROMIUM_EXECUTABLE=/path node tests/browser/ifc-worker-fallback-differential.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSyntheticIfc, generateSemanticIfc } from '../fixtures/generate-synthetic-ifc.js';
import { deepModelDigest, diffDigests } from './model-digest.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const offline = process.env.CC_BROWSER_OFFLINE_DEPS === '1';
const generatedDir = join(root, 'tests', 'fixtures', '_generated-differential');

function fail(msg) {
  console.error('DIFFERENTIAL FAIL: ' + msg);
  process.exitCode = 1;
}

const CASES = [
  { name: 'baseline (two-wall smoke)', url: '/tests/fixtures/smoke-clash.ifc' },
  // Provision for void: the office architecture model carries IfcOpeningElement /
  // IfcRelVoidsElement voids; both load paths must extract identical opening boxes.
  { name: 'openings (IfcRelVoidsElement)', url: '/tests/fixtures/office-architecture.ifc', expectOpenings: 3 },
  { name: 'multi-storey', url: '/tests/fixtures/multi-storey-smoke.ifc' },
  {
    name: 'quantities (IfcElementQuantity)',
    generate: { storeyCount: 1, wallsPerStorey: 2, withQuantities: true },
  },
  {
    name: 'unit conversion (millimetre IfcSIUnit)',
    generate: { storeyCount: 1, wallsPerStorey: 2, lengthUnit: 'MILLIMETRE' },
  },
  {
    name: 'georeferencing (RefLat/Lon + IfcMapConversion)',
    generate: {
      storeyCount: 1, wallsPerStorey: 2,
      geo: { lat: [52, 5, 0], lon: [4, 18, 0], elev: 10.5 },
      mapConversion: { eastings: 150000, northings: 450000, epsg: 'RD_New' },
    },
  },
  // IfcPostalAddress.Country (IfcSite.SiteAddress + IfcBuilding.BuildingAddress):
  // the country-pack resolver's strongest signal — both paths must read it.
  {
    name: 'postal address (IfcPostalAddress.Country)',
    generate: { storeyCount: 1, wallsPerStorey: 2, postalAddress: { site: 'Nederland', building: 'Netherlands' } },
    expectAddress: ['Nederland', 'Netherlands'],
  },
  {
    name: 'degenerate record (null-valued property)',
    generate: { storeyCount: 1, wallsPerStorey: 2, withPsets: true },
  },
  // IfcSpace rooms: web-ifc's StreamAllMeshes never yields them, so both
  // paths stream them in a separate by-id pass — fingerprint covers their
  // boxes and mesh counts.
  {
    name: 'spaces (IfcSpace rooms)',
    generate: { storeyCount: 2, wallsPerStorey: 2, withSpaces: true },
    expectSpaces: 2,
  },
  // Discipline/role evidence (IfcRelDefinesByType type objects,
  // IfcRelAssignsToGroup systems, classification references) on an IFC2X3
  // MEP export, and IfcRelSpaceBoundary records written with a systematic
  // offset: both paths must extract identical records and reach identical
  // classifications and boundary placement.
  { name: 'semantics (IFC2X3 MEP: types, systems, classification)', generateSemantic: { kind: 'vent' }, expectSemantics: true },
  { name: 'space boundaries (offset frame)', generateSemantic: { kind: 'arch', boundaryOffset: [-13374.845, -13743.122, 0] }, expectBoundaries: 12 },
];

const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  try {
    // Same containment guard as the sibling harnesses (smoke.mjs,
    // perf-local.mjs, memory-local.mjs) — reject any resolved path that
    // escapes root, since p comes straight from the request URL.
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    const ct = (p === '/' || p.endsWith('.html')) ? 'text/html'
      : p.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
    res.writeHead(200, { 'content-type': ct });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
// Bind explicitly to loopback only — same as every sibling harness — rather
// than the default all-interfaces bind, which would briefly expose this
// static file server (and the containment guard above, its only defense)
// to the network for the life of the test run.
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE });
const errors = [];

async function loadAndFingerprint(forceFallback, fixtureUrl) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (offline) {
    const local = async (route, file, ct) => route.fulfill({
      status: 200, body: await readFile(join(root, 'node_modules', file)),
      headers: { 'content-type': ct || 'text/javascript', 'access-control-allow-origin': '*' },
    });
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
    await page.context().route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', async (route) => {
      const suffix = new URL(route.request().url()).pathname.split('/three@0.180.0/')[1];
      await local(route, 'three/' + suffix);
    });
    await page.context().route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', async (route) => {
      const suffix = new URL(route.request().url()).pathname.split('/web-ifc@0.0.77/')[1];
      await local(route, 'web-ifc/' + suffix, suffix.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    });
    await page.context().route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/css' }));
    await page.context().route('https://fonts.gstatic.com/**', (route) => route.abort());
    await page.context().route('https://gc.zgo.at/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  }
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 60_000 });
  const result = await page.evaluate(async ({ forceFallbackInner, fixtureUrlInner }) => {
    if (forceFallbackInner) {
      window.Worker = class BrokenWorker { constructor() { throw new Error('forced fallback for differential test'); } };
    }
    const buf = await (await fetch(fixtureUrlInner)).arrayBuffer();
    window.ClashControl.loadFiles([new File([buf], 'differential.ifc')]);
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const s = window._ccLatestState;
        const m = s && s.models.find((x) => x.name.indexOf('differential') === 0);
        if (m && (m.elements || []).length > 0) { clearInterval(iv); resolve(); }
        if (Date.now() - t0 > 60000) { clearInterval(iv); reject(new Error('timed out waiting for model')); }
      }, 100);
    });
    const model = window._ccLatestState.models.find((x) => x.name.indexOf('differential') === 0);
    // modelFingerprint()'s key is `${model.id}:${expressId}` — model.id is a
    // session-random uid() assigned at load time (not derived from file
    // content), so it will always legitimately differ between two separate
    // loadFiles() calls even for byte-identical output. Fix it to a constant
    // so the comparison is actually about parse correctness, not session
    // randomness that was never a signal to begin with.
    const fixedIdModel = Object.assign({}, model, { id: 'fixed' });
    return {
      fingerprint: window._ccSafetyMigrations.modelFingerprint([fixedIdModel]),
      elementCount: (model.elements || []).length,
      meshCount: (model.meshes || []).length,
      unitScale: (model.stats || {}).unitScale != null ? model.stats.unitScale : null,
      georef: (model.spatialHierarchy && model.spatialHierarchy.sites && model.spatialHierarchy.sites[0] && model.spatialHierarchy.sites[0].georef) || null,
      mapConversion: (model.spatialHierarchy && model.spatialHierarchy.mapConversion) || null,
      addresses: model.spatialHierarchy ? [].concat(model.spatialHierarchy.sites || [], model.spatialHierarchy.buildings || [])
        .map((x) => (x.address && x.address.country) || null) : null,
      openings: model.elements.filter((e) => e.props && e.props.openings && e.props.openings.length)
        .map((e) => [e.expressId, e.props.openings]).sort((a, b) => a[0] - b[0]),
      semantics: model.elements.map((e) => {
        const p = e.props || {};
        return [e.expressId, p.predefinedType || null, p.typeObject || null, p.groups || null, p.classification || null, e._ccCls || null];
      }).filter((r) => r[1] || r[2] || r[3] || r[4]).sort((a, b) => a[0] - b[0]),
      disciplineInfo: model.disciplineInfo ? Object.assign({}, model.disciplineInfo, { sig: undefined }) : null,
      boundaries: model._ccBoundaries ? { total: model._ccBoundaries.total, placed: model._ccBoundaries.placed, frame: model._ccBoundaries.frame,
        offset: model._ccBoundaries.offset, spaceToEls: model._ccBoundaries.spaceToEls,
        geometry: model._ccBoundaries.geometry ? Array.from(model._ccBoundaries.geometry).map((v) => Math.round(v * 1e4)) : null } : null,
    };
  }, { forceFallbackInner: forceFallback, fixtureUrlInner: fixtureUrl });
  await page.close();
  return result;
}

// Cancellation case — the last of the six named coverage topics from the
// 2026-07-17 Known Issues note ("expand its coverage (multi-storey,
// quantities, unit conversion, georeferencing, malformed records,
// cancellation) before attempting the actual extraction"). Verifies a
// cancel-then-successful-reload produces the SAME fingerprint as a clean
// load with no cancellation in its history — i.e. an aborted in-flight
// load leaves no residue (partial elements, a stale _ccLoadGeneration,
// leftover worker state) that could silently corrupt the retry.
async function loadCancelReloadAndFingerprint(fixtureUrl) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (offline) {
    const local = async (route, file, ct) => route.fulfill({
      status: 200, body: await readFile(join(root, 'node_modules', file)),
      headers: { 'content-type': ct || 'text/javascript', 'access-control-allow-origin': '*' },
    });
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
    await page.context().route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', async (route) => {
      const suffix = new URL(route.request().url()).pathname.split('/three@0.180.0/')[1];
      await local(route, 'three/' + suffix);
    });
    await page.context().route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', async (route) => {
      const suffix = new URL(route.request().url()).pathname.split('/web-ifc@0.0.77/')[1];
      await local(route, 'web-ifc/' + suffix, suffix.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    });
    await page.context().route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/css' }));
    await page.context().route('https://fonts.gstatic.com/**', (route) => route.abort());
    await page.context().route('https://gc.zgo.at/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  }
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 60_000 });
  const result = await page.evaluate(async (fixtureUrlInner) => {
    const realWorker = window.Worker;
    // 1. Start a load that never responds, then cancel it — same technique
    // smoke.mjs's own cancellation case and load-cancel-load-loop.mjs use.
    window.Worker = class HangingWorker { postMessage() {} terminate() {} };
    const buf = await (await fetch(fixtureUrlInner)).arrayBuffer();
    window.ClashControl.loadFiles([new File([buf], 'cancel-reload.ifc')]);
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (window._ccModelLoading === true) { clearInterval(iv); resolve(); }
        if (Date.now() - t0 > 10000) { clearInterval(iv); reject(new Error('never entered loading state')); }
      }, 50);
    });
    window._ccAbortLoading();
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const coordinator = window._ccRuntime && window._ccRuntime.services.get('loadCoordinator');
        if (window._ccModelLoading === false && coordinator && coordinator.activeCount() === 0) { clearInterval(iv); resolve(); }
        if (Date.now() - t0 > 10000) { clearInterval(iv); reject(new Error('cancel never settled')); }
      }, 50);
    });
    // 2. Restore the real Worker and load the SAME fixture for real.
    window.Worker = realWorker;
    window.ClashControl.loadFiles([new File([buf], 'cancel-reload.ifc')]);
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const s = window._ccLatestState;
        const m = s && s.models.find((x) => x.name.indexOf('cancel-reload') === 0);
        if (m && (m.elements || []).length > 0) { clearInterval(iv); resolve(); }
        if (Date.now() - t0 > 60000) { clearInterval(iv); reject(new Error('timed out waiting for post-cancel reload')); }
      }, 100);
    });
    const model = window._ccLatestState.models.find((x) => x.name.indexOf('cancel-reload') === 0);
    const fixedIdModel = Object.assign({}, model, { id: 'fixed' });
    return {
      fingerprint: window._ccSafetyMigrations.modelFingerprint([fixedIdModel]),
      elementCount: (model.elements || []).length,
      unitScale: (model.stats || {}).unitScale != null ? model.stats.unitScale : null,
      georef: (model.spatialHierarchy && model.spatialHierarchy.sites && model.spatialHierarchy.sites[0] && model.spatialHierarchy.sites[0].georef) || null,
      mapConversion: (model.spatialHierarchy && model.spatialHierarchy.mapConversion) || null,
    };
  }, fixtureUrl);
  await page.close();
  return result;
}

// Parallel / progressive-preview equivalence: the SAME set of files dropped
// in ONE loadFiles call, once with the default loader (files one after
// another, no preview) and once with ?ccSafety=progressivePreview,parallelLoad
// (several workers at once, geometry streamed to the main thread in batches
// and drawn as a display-only preview). Every model must be identical
// element-for-element: order, triangle/index/normal bytes, mesh matrices,
// props (after the lazy psets merge) and float64 volume/area.
async function loadSetDeep(query, urls) {
  const page = await browser.newPage();
  page.on('dialog', (d) => d.accept()); // duplicate-model overlap prompts between fixtures
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (offline) {
    const local = async (route, file, ct) => route.fulfill({
      status: 200, body: await readFile(join(root, 'node_modules', file)),
      headers: { 'content-type': ct || 'text/javascript', 'access-control-allow-origin': '*' },
    });
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
    await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
    await page.context().route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', async (route) => {
      const suffix = new URL(route.request().url()).pathname.split('/three@0.180.0/')[1];
      await local(route, 'three/' + suffix);
    });
    await page.context().route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', async (route) => {
      const suffix = new URL(route.request().url()).pathname.split('/web-ifc@0.0.77/')[1];
      await local(route, 'web-ifc/' + suffix, suffix.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    });
    await page.context().route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/css' }));
    await page.context().route('https://fonts.gstatic.com/**', (route) => route.abort());
    await page.context().route('https://gc.zgo.at/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  }
  await page.goto(`http://127.0.0.1:${port}/${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 60_000 });
  const meta = await page.evaluate(async (list) => {
    const files = [];
    for (let i = 0; i < list.length; i++) files.push(new File([await (await fetch(list[i])).arrayBuffer()], 'set' + i + '-' + list[i].split('/').pop()));
    let previewBatches = 0;
    const iv = setInterval(() => { const pi = window._ccLoadPreview && window._ccLoadPreview.info(); if (pi && pi.batches > previewBatches) previewBatches = pi.batches; }, 5);
    window.ClashControl.loadFiles(files);
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const w = setInterval(() => {
        const s = window._ccLatestState;
        const ms = s ? s.models.filter((m) => m.name.indexOf('set') === 0) : [];
        if (ms.length === list.length && window._ccModelLoading === false && ms.every((m) => m._propsVersion)) { clearInterval(w); resolve(); }
        if (Date.now() - t0 > 120000) { clearInterval(w); reject(new Error('timed out waiting for the file set: ' + JSON.stringify(ms.map((m) => [m.name, !!m._propsVersion])) + ' loading=' + window._ccModelLoading)); }
      }, 50);
    });
    clearInterval(iv);
    const pi = window._ccLoadPreview.info();
    return { order: window._ccLatestState.models.map((m) => m.name), previewBatches, parallelPeak: window._ccLoadPreview.parallelPeak(),
      previewLeft: pi.live, previewInScene: pi.inScene,
      previewInState: window._ccLatestState.models.some((m) => (m.meshes || []).some((x) => x.userData && x.userData._ccLoadPreview)) };
  }, urls);
  const digest = await page.evaluate(deepModelDigest, 'set');
  await page.close();
  return { meta, digest };
}

let allOk = true;
try {
  await mkdir(generatedDir, { recursive: true });
  const resolvedCases = [];
  for (const c of CASES) {
    if (c.url) { resolvedCases.push({ name: c.name, url: c.url, expectOpenings: c.expectOpenings }); continue; }
    const fileName = c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.ifc';
    const filePath = join(generatedDir, fileName);
    await writeFile(filePath, c.generateSemantic ? generateSemanticIfc(c.generateSemantic) : generateSyntheticIfc(c.generate));
    resolvedCases.push({ name: c.name, url: '/tests/fixtures/_generated-differential/' + fileName, expectSpaces: c.expectSpaces,
      expectSemantics: c.expectSemantics, expectBoundaries: c.expectBoundaries, expectAddress: c.expectAddress });
  }

  for (const c of resolvedCases) {
    const workerResult = await loadAndFingerprint(false, c.url);
    const fallbackResult = await loadAndFingerprint(true, c.url);
    // modelFingerprint() itself only covers box/mesh/type per element — it
    // does NOT include unit scale, georeferencing or map-conversion data,
    // so a worker/fallback divergence limited to those fields would pass
    // silently if only the fingerprint were compared. Extend parity to the
    // full result payload for the fields those extra fixture cases exist
    // to exercise.
    const pickCmp = (r) => ({ fingerprint: r.fingerprint, unitScale: r.unitScale, georef: r.georef, mapConversion: r.mapConversion, addresses: r.addresses, openings: r.openings,
      semantics: r.semantics, disciplineInfo: r.disciplineInfo, boundaries: r.boundaries });
    const workerComparable = pickCmp(workerResult);
    const fallbackComparable = pickCmp(fallbackResult);
    const same = JSON.stringify(workerComparable) === JSON.stringify(fallbackComparable);
    if (!same) {
      console.error('Worker result:', JSON.stringify(workerComparable, null, 1));
      console.error('Fallback result:', JSON.stringify(fallbackComparable, null, 1));
      fail('[' + c.name + '] worker and main-thread-fallback IFC parses produced different results');
      allOk = false;
      continue;
    }
    if (workerResult.elementCount === 0) {
      fail('[' + c.name + '] worker path parsed zero elements — fixture or harness is broken, not a real pass');
      allOk = false;
      continue;
    }
    if (c.expectOpenings != null && workerResult.openings.length !== c.expectOpenings) {
      fail('[' + c.name + '] expected ' + c.expectOpenings + ' host elements with openings, got ' + workerResult.openings.length);
      allOk = false;
      continue;
    }
    if (c.expectAddress && JSON.stringify(workerResult.addresses) !== JSON.stringify(c.expectAddress)) {
      fail('[' + c.name + '] expected IfcPostalAddress countries ' + JSON.stringify(c.expectAddress) + ', got ' + JSON.stringify(workerResult.addresses));
      allOk = false;
      continue;
    }
    if (c.expectSemantics && !(workerResult.semantics.length && workerResult.semantics.every((r) => r[2] && r[3] && r[4] && r[5]))) {
      fail('[' + c.name + '] expected type objects, systems, classifications and a classification on every MEP element');
      allOk = false;
      continue;
    }
    if (c.expectBoundaries != null && !(workerResult.boundaries && workerResult.boundaries.placed === c.expectBoundaries)) {
      fail('[' + c.name + '] expected ' + c.expectBoundaries + ' placed space boundaries, got ' + JSON.stringify(workerResult.boundaries && workerResult.boundaries.placed));
      allOk = false;
      continue;
    }
    if (c.expectSpaces != null) {
      const spacesWithGeo = workerResult.fingerprint.filter((r) => r.ifcType === 'IfcSpace' && r.meshCount > 0).length;
      if (spacesWithGeo !== c.expectSpaces) {
        fail('[' + c.name + '] expected ' + c.expectSpaces + ' IfcSpace elements with geometry, got ' + spacesWithGeo);
        allOk = false;
        continue;
      }
    }
    console.log('DIFFERENTIAL OK — [' + c.name + '] worker and fallback are fingerprint-identical (' +
      workerResult.elementCount + ' elements' +
      (workerResult.unitScale != null ? ', unitScale=' + workerResult.unitScale : '') +
      (workerResult.openings.length ? ', ' + workerResult.openings.length + ' hosts with openings' : '') +
      (workerResult.georef ? ', georef=' + JSON.stringify(workerResult.georef) : '') +
      (workerResult.mapConversion ? ', mapConversion=' + JSON.stringify(workerResult.mapConversion) : '') +
      ')');
  }

  // Parallel + progressive preview == default sequential load.
  {
    const setUrls = ['/tests/fixtures/office-architecture.ifc', '/tests/fixtures/office-mep.ifc', '/tests/fixtures/multi-storey-smoke.ifc']
      .concat(resolvedCases.filter((c) => /spaces|semantics|space boundaries|unit conversion/.test(c.name)).map((c) => c.url));
    const seq = await loadSetDeep('?ccSafety=-progressivePreview,-parallelLoad', setUrls);
    const par = await loadSetDeep('?ccSafety=progressivePreview,parallelLoad', setUrls);
    const diffs = diffDigests(seq.digest, par.digest);
    const orderSame = JSON.stringify(seq.meta.order) === JSON.stringify(par.meta.order);
    if (diffs.length || !orderSame) {
      console.error('order', seq.meta.order, par.meta.order); console.error(diffs.join('\n'));
      fail('[parallel+preview] a parallel, progressively previewed load differs from the sequential load');
      allOk = false;
    } else if (!(par.meta.previewBatches > 0) || !(par.meta.parallelPeak > 1)) {
      fail('[parallel+preview] the flagged path did not actually run (preview batches ' + par.meta.previewBatches + ', parallel peak ' + par.meta.parallelPeak + ')');
      allOk = false;
    } else if (par.meta.previewLeft || par.meta.previewInScene || par.meta.previewInState || seq.meta.previewBatches) {
      fail('[parallel+preview] preview not torn down / leaked into state: ' + JSON.stringify(par.meta) + ' / sequential batches ' + seq.meta.previewBatches);
      allOk = false;
    } else {
      const n = Object.values(seq.digest).reduce((t, m) => t + m.elements, 0);
      console.log('DIFFERENTIAL OK — [parallel+preview] ' + setUrls.length + ' files, ' + n + ' elements identical (triangles, matrices, props, volume/area; ' +
        par.meta.previewBatches + ' preview batches, ' + par.meta.parallelPeak + ' parses at once)');
    }
  }

  // Cancellation case, run against the baseline fixture: a cancel-then-
  // reload must produce the exact same result as a clean load with no
  // cancellation in its history.
  {
    const baselineUrl = resolvedCases[0].url;
    const cleanResult = await loadAndFingerprint(false, baselineUrl);
    const cancelReloadResult = await loadCancelReloadAndFingerprint(baselineUrl);
    const cleanComparable = { fingerprint: cleanResult.fingerprint, unitScale: cleanResult.unitScale, georef: cleanResult.georef, mapConversion: cleanResult.mapConversion };
    const cancelComparable = { fingerprint: cancelReloadResult.fingerprint, unitScale: cancelReloadResult.unitScale, georef: cancelReloadResult.georef, mapConversion: cancelReloadResult.mapConversion };
    const same = JSON.stringify(cleanComparable) === JSON.stringify(cancelComparable);
    if (!same) {
      console.error('Clean load result:', JSON.stringify(cleanComparable, null, 1));
      console.error('Cancel-then-reload result:', JSON.stringify(cancelComparable, null, 1));
      fail('[cancellation] a cancel-then-reload produced a different result than a clean load');
      allOk = false;
    } else if (cancelReloadResult.elementCount === 0) {
      fail('[cancellation] post-cancel reload parsed zero elements');
      allOk = false;
    } else {
      console.log('DIFFERENTIAL OK — [cancellation] cancel-then-reload matches a clean load (' + cancelReloadResult.elementCount + ' elements)');
    }
  }

  if (errors.length) {
    fail('browser emitted uncaught page or console errors: ' + JSON.stringify(errors.slice(0, 10)));
    allOk = false;
  }

  if (allOk) console.log('DIFFERENTIAL OK — all ' + resolvedCases.length + ' fixture cases are worker/fallback fingerprint-identical');
} finally {
  await browser.close();
  server.close();
  await rm(generatedDir, { recursive: true, force: true });
}
if (!allOk) process.exit(1);
