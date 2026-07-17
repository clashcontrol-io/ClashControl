#!/usr/bin/env node
// Differential correctness + performance check for the Rust/WASM
// broad-phase sweep (engine/src/broadphase.rs, browser-first large-model
// plan Phase 4), run per explicit instruction: "test it locally before and
// after you've done the rewrite. If it's worse or fails, fix it or revert
// it."
//
// Loads real fixtures, runs clash detection twice per rule configuration
// in the SAME page/session — once with the WASM sweep available (the new
// path), once with window._ccWasmSweepAndPrune stubbed out to force the
// JS-only _sweepAndPrune fallback (the pre-existing, oracle path) — and
// asserts the two produce the EXACT same clash set (order-independent, by
// element-pair identity) across a spread of rule configurations that
// exercise the self-clash rule's different input shapes
// (selfClashModels/selfClashGroup/excludeSelf/duplicates), cross-model
// federation, and type exclusion.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSyntheticIfc } from '../fixtures/generate-synthetic-ifc.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
function dirname(p) { return p.replace(/\/[^/]*$/, ''); }
const offline = process.env.CC_BROWSER_OFFLINE_DEPS === '1';
const generatedDir = join(root, 'tests', 'fixtures', '_generated-wasm-diff');

let allOk = true;
function fail(msg) { console.error('WASM SWEEP DIFF FAIL: ' + msg); allOk = false; }

const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  try {
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
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE });
const errors = [];

function clashKey(c) {
  // Order-independent identity: sorted pair of expressIds + type +
  // sameModel. Not comparing geometry (points/depth/distance) here since
  // that comes from the UNCHANGED narrow-phase engine either way — this
  // test is specifically about whether the WASM sweep finds the SAME
  // candidate pairs as the JS sweep, not re-verifying narrow-phase math.
  const a = c.eA ? c.eA.expressId : (c.elA && c.elA.expressId);
  const b = c.eB ? c.eB.expressId : (c.elB && c.elB.expressId);
  const ids = [a, b].sort((x, y) => x - y);
  return ids[0] + ':' + ids[1] + ':' + c.type + ':' + (c.sameModel ? 1 : 0);
}

async function runBoth(page, fixtureUrls, rulesOverride) {
  const result = await page.evaluate(async ({ fixtureUrlsInner, rulesOverrideInner }) => {
    // Fresh load for each configuration so results aren't polluted by a
    // prior run's merged clash history.
    const files = [];
    for (const u of fixtureUrlsInner) {
      const buf = await (await fetch(u)).arrayBuffer();
      files.push(new File([buf], u.split('/').pop()));
    }
    window.ClashControl.loadFiles(files);
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const s = window._ccLatestState;
        if (s && s.models.length === fixtureUrlsInner.length && window._ccModelLoading === false) { clearInterval(iv); resolve(); }
        if (Date.now() - t0 > 60000) { clearInterval(iv); reject(new Error('timed out waiting for models to load')); }
      }, 100);
    });
    // Wait for the WASM engine specifically (not just model load) so the
    // "WASM path" run is actually exercising Rust, not silently falling
    // back because the module hadn't finished loading yet.
    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (typeof window._ccWasmSweepAndPrune === 'function') { clearInterval(iv); resolve(); }
        if (Date.now() - t0 > 30000) { clearInterval(iv); reject(new Error('WASM engine never became ready')); }
      }, 50);
    });

    const wasmResult = await window.ClashControl.runDetection(rulesOverrideInner);

    // Force the JS-only fallback and re-run against the SAME loaded models.
    const realSweep = window._ccWasmSweepAndPrune;
    delete window._ccWasmSweepAndPrune;
    const jsResult = await window.ClashControl.runDetection(rulesOverrideInner);
    window._ccWasmSweepAndPrune = realSweep;

    function toKeys(list) {
      return (list || []).map((c) => {
        const a = c.eA ? c.eA.expressId : (c.elA && c.elA.expressId);
        const b = c.eB ? c.eB.expressId : (c.elB && c.elB.expressId);
        const ids = [a, b].sort((x, y) => x - y);
        return ids[0] + ':' + ids[1] + ':' + c.type + ':' + (c.sameModel ? 1 : 0);
      }).sort();
    }
    return { wasmKeys: toKeys(wasmResult), jsKeys: toKeys(jsResult), wasmCount: (wasmResult || []).length, jsCount: (jsResult || []).length };
  }, { fixtureUrlsInner: fixtureUrls, rulesOverrideInner: rulesOverride });
  return result;
}

async function newPage() {
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
  return page;
}

try {
  await mkdir(generatedDir, { recursive: true });

  // Dense self-clashing single-model fixture: many overlapping walls in one
  // storey so self-clash rule shapes actually have something to find/exclude.
  const denseFixture = generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 8 });
  await writeFile(join(generatedDir, 'dense.ifc'), denseFixture);

  const cases = [
    { name: 'default rules (excludeSelf true, single model → effective self-clash on)', fixtures: ['/tests/fixtures/_generated-wasm-diff/dense.ifc'], rules: {} },
    { name: 'selfClashModels: "all"', fixtures: ['/tests/fixtures/_generated-wasm-diff/dense.ifc'], rules: { selfClashModels: 'all' } },
    { name: 'selfClashModels: "none"', fixtures: ['/tests/fixtures/_generated-wasm-diff/dense.ifc'], rules: { selfClashModels: 'none' } },
    { name: 'selfClashGroup: "a" (legacy shape)', fixtures: ['/tests/fixtures/_generated-wasm-diff/dense.ifc'], rules: { selfClashGroup: 'a' } },
    { name: 'excludeSelf: false (legacy shape)', fixtures: ['/tests/fixtures/_generated-wasm-diff/dense.ifc'], rules: { excludeSelf: false } },
    { name: 'duplicates: true', fixtures: ['/tests/fixtures/_generated-wasm-diff/dense.ifc'], rules: { selfClashModels: 'none', duplicates: true } },
    // excludeSameDiscipline defaults true and both fixtures auto-detect as
    // the same discipline (plain IfcWall geometry, no MEP/structural
    // signal) — without disabling it, the discipline matrix (downstream of
    // the sweep, in _processCandidate) would filter out every cross-model
    // pair regardless of the sweep implementation, making a 0-0 result
    // meaningless as a differential signal either way.
    { name: 'two models, cross-model federation', fixtures: ['/tests/fixtures/smoke-clash.ifc', '/tests/fixtures/_generated-wasm-diff/dense.ifc'], rules: { excludeSelf: true, excludeSameDiscipline: false } },
    { name: 'excludeTypes filters IfcWall entirely', fixtures: ['/tests/fixtures/_generated-wasm-diff/dense.ifc'], rules: { selfClashModels: 'all', excludeTypes: ['IfcWall'] } },
  ];

  const timings = [];
  for (const c of cases) {
    const page = await newPage();
    const t0 = Date.now();
    const r = await runBoth(page, c.fixtures, c.rules);
    const elapsed = Date.now() - t0;
    timings.push({ name: c.name, elapsed });
    await page.close();

    if (r.wasmCount === 0 && r.jsCount === 0 && c.name.indexOf('excludeTypes') === -1 && c.name.indexOf('none') === -1) {
      fail('[' + c.name + '] both paths found 0 clashes — fixture/harness may be broken, not a real pass');
      continue;
    }
    const wasmSet = JSON.stringify(r.wasmKeys);
    const jsSet = JSON.stringify(r.jsKeys);
    if (wasmSet !== jsSet) {
      console.error('WASM keys:', r.wasmKeys);
      console.error('JS keys:  ', r.jsKeys);
      fail('[' + c.name + '] WASM sweep and JS sweep produced DIFFERENT clash sets (wasm=' + r.wasmCount + ', js=' + r.jsCount + ')');
    } else {
      console.log('DIFFERENTIAL OK — [' + c.name + '] WASM and JS sweeps agree (' + r.wasmCount + ' clashes)');
    }
  }

  if (errors.length) {
    fail('browser emitted uncaught page or console errors: ' + JSON.stringify(errors.slice(0, 10)));
  }

  console.log('\nTiming (both WASM+JS runs combined, per case, ms):');
  timings.forEach((t) => console.log('  ' + t.name + ': ' + t.elapsed + 'ms'));

  if (allOk) console.log('\nWASM SWEEP DIFFERENTIAL OK — all ' + cases.length + ' rule configurations agree between WASM and JS sweeps');
} finally {
  await browser.close();
  server.close();
  await rm(generatedDir, { recursive: true, force: true });
}
if (!allOk) process.exit(1);
