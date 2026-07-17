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
import { generateSyntheticIfc } from '../fixtures/generate-synthetic-ifc.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const offline = process.env.CC_BROWSER_OFFLINE_DEPS === '1';
const generatedDir = join(root, 'tests', 'fixtures', '_generated-differential');

function fail(msg) {
  console.error('DIFFERENTIAL FAIL: ' + msg);
  process.exitCode = 1;
}

const CASES = [
  { name: 'baseline (two-wall smoke)', url: '/tests/fixtures/smoke-clash.ifc' },
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
  {
    name: 'degenerate record (null-valued property)',
    generate: { storeyCount: 1, wallsPerStorey: 2, withPsets: true },
  },
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
    };
  }, { forceFallbackInner: forceFallback, fixtureUrlInner: fixtureUrl });
  await page.close();
  return result;
}

let allOk = true;
try {
  await mkdir(generatedDir, { recursive: true });
  const resolvedCases = [];
  for (const c of CASES) {
    if (c.url) { resolvedCases.push({ name: c.name, url: c.url }); continue; }
    const fileName = c.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.ifc';
    const filePath = join(generatedDir, fileName);
    await writeFile(filePath, generateSyntheticIfc(c.generate));
    resolvedCases.push({ name: c.name, url: '/tests/fixtures/_generated-differential/' + fileName });
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
    const workerComparable = { fingerprint: workerResult.fingerprint, unitScale: workerResult.unitScale, georef: workerResult.georef, mapConversion: workerResult.mapConversion };
    const fallbackComparable = { fingerprint: fallbackResult.fingerprint, unitScale: fallbackResult.unitScale, georef: fallbackResult.georef, mapConversion: fallbackResult.mapConversion };
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
    console.log('DIFFERENTIAL OK — [' + c.name + '] worker and fallback are fingerprint-identical (' +
      workerResult.elementCount + ' elements' +
      (workerResult.unitScale != null ? ', unitScale=' + workerResult.unitScale : '') +
      (workerResult.georef ? ', georef=' + JSON.stringify(workerResult.georef) : '') +
      (workerResult.mapConversion ? ', mapConversion=' + JSON.stringify(workerResult.mapConversion) : '') +
      ')');
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
