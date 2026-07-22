// Real-browser probe answering the two questions an external review asked
// after the V7 P6 "control plane" pass (byte-accurate residency ledger,
// auto-park, GeometryHandle first slice) but before any deeper migration:
//
//   1. Does the residency ledger's reclaimableBytes estimate for a model
//      roughly track the REAL heap/RSS movement when that model is parked
//      and restored?
//   2. Does repeated detection return memory near baseline instead of
//      climbing run over run?
//
// Same harness shape as memory-local.mjs (single-process Chromium so JS heap
// + WASM linear memory + GPU/SwiftShader all live in one measured PID, exact
// pinned-CDN-version offline mirror via local node_modules bytes). Loads TWO
// synthetic multi-storey models (different sizes so they don't trigger the
// same-footprint duplicate-model warning) so one can be hidden/parked while
// state stays valid, then drives the real Park/Restore + repeated-detection
// flow through the actual public API (window.ClashControl.*) — not a mock.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { generateSyntheticIfc } from '../fixtures/generate-synthetic-ifc.js';

async function readRssBytes(pid) {
  if (!pid) return null;
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}
async function getBrowserPid(browserHandle) {
  try {
    const cdp = await browserHandle.newBrowserCDPSession();
    const info = await cdp.send('SystemInfo.getProcessInfo');
    const entry = (info.processInfo || []).find((p) => p.type === 'browser') || info.processInfo?.[0];
    return entry ? entry.id : null;
  } catch {
    return null;
  }
}

const root = fileURLToPath(new URL('../..', import.meta.url));
const MIME = {
  '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript',
  '.json':'application/json', '.wasm':'application/wasm', '.png':'image/png',
  '.svg':'image/svg+xml', '.ifc':'application/octet-stream', '.css':'text/css',
};

// Two distinct synthetic fixtures: different storey/wall counts (=> different
// plan-view extents) so they don't trip the "same footprint, probably a
// duplicate load" confirm() dialog. B is deliberately the larger one, so
// there's a real byte delta for the ledger to estimate and for us to check
// against actual heap/RSS movement.
//
// Sizes are production-representative: ~31k total elements, matching the
// real-world ~30k-element federations this probe is meant to stand in for
// (the first pass through this harness used a ~10.2k-element fixture, which
// wasn't quite large enough to separate a real signal from measurement
// noise for the ledger-vs-observed-delta comparison).
const fixtureA = generateSyntheticIfc({ storeyCount: 5, wallsPerStorey: 200 });
const fixtureB = generateSyntheticIfc({ storeyCount: 30, wallsPerStorey: 1000, storeyHeight: 4 });

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/__fixture-a__.ifc') { res.writeHead(200, {'content-type':'application/octet-stream'}); return res.end(fixtureA); }
    if (path === '/__fixture-b__.ifc') { res.writeHead(200, {'content-type':'application/octet-stream'}); return res.end(fixtureB); }
    const rel = path === '/' ? 'index.html' : path.slice(1);
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, {'content-type':MIME[extname(file)] || 'application/octet-stream'});
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(8768, '127.0.0.1', resolve));

const executablePath = process.env.CC_CHROMIUM_EXECUTABLE;
if (!executablePath) throw new Error('CC_CHROMIUM_EXECUTABLE is required');
const browser = await chromium.launch({
  executablePath,
  args:['--no-sandbox','--disable-setuid-sandbox','--single-process','--no-zygote',
    '--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader',
    '--enable-precise-memory-info','--js-flags=--expose-gc'],
});
const browserPid = await getBrowserPid(browser);
// Engine-only baseline -- RSS of the single-process Chromium + SwiftShader
// renderer before any page has been navigated to. Separates "this is just
// what a headless-Chromium process costs" from "the app's own boot code/WASM
// costs this much", which the earlier pass conflated into one ~390MB number.
await new Promise((resolve) => setTimeout(resolve, 300));
const engineOnlyRssBytes = await readRssBytes(browserPid);

async function local(route, file, contentType='text/javascript') {
  await route.fulfill({status:200, body:await readFile(join(root, 'node_modules', file)),
    headers:{'content-type':contentType,'access-control-allow-origin':'*'}});
}

const context = await browser.newContext({serviceWorkers:'block'});
await context.route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
await context.route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
await context.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
await context.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
await context.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.worker.min.js'));
await context.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', async (route) => {
  const suffix = new URL(route.request().url()).pathname.split('/three@0.180.0/')[1];
  await local(route, 'three/' + suffix);
});
await context.route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', async (route) => {
  const suffix = new URL(route.request().url()).pathname.split('/web-ifc@0.0.77/')[1];
  await local(route, 'web-ifc/' + suffix, suffix.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
});
await context.route('https://fonts.googleapis.com/**', (r) => r.fulfill({status:200,body:'',contentType:'text/css'}));
await context.route('https://fonts.gstatic.com/**', (r) => r.abort());
await context.route('https://gc.zgo.at/**', (r) => r.fulfill({status:200,body:'',contentType:'text/javascript'}));

const page = await context.newPage();
const errors = [];
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

async function settle() {
  await page.waitForTimeout(200);
  await page.evaluate(() => { if (typeof gc === 'function') { gc(); gc(); } });
  await page.waitForTimeout(100);
}
async function sample(label) {
  await settle();
  const inPage = await page.evaluate((name) => {
    const state = window._ccLatestState || {};
    const renderer = window._ccState3d && window._ccState3d.renderer;
    const info = renderer && renderer.info;
    return {
      label: name,
      heapBytes: performance.memory ? performance.memory.usedJSHeapSize : null,
      models: (state.models || []).length,
      parkedModels: (state.parkedModels || []).length,
      elements: (state.models || []).reduce((n, m) => n + (m.elements || []).length, 0),
      clashes: (state.clashes || []).length,
      // Three.js's OWN internal bookkeeping of live GPU-buffer-backed
      // geometries/textures/programs -- deterministic (not GC-timing-
      // dependent like performance.memory), so this is a much more precise
      // signal for "did dispose() actually run" than raw JS heap bytes.
      rendererGeometries: info && info.memory ? info.memory.geometries : null,
      rendererTextures: info && info.memory ? info.memory.textures : null,
      rendererPrograms: info && info.programs ? info.programs.length : null,
    };
  }, label);
  inPage.rssBytes = await readRssBytes(browserPid);
  return inPage;
}
function mb(bytes) { return bytes == null ? null : Math.round(bytes / 1048576 * 10) / 10; }

const samples = [];
const findings = [];
try {
  await page.goto('http://127.0.0.1:8768/', {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, {timeout:180_000});
  samples.push(await sample('boot'));

  // Separate "the app's own boot code/WASM costs this much" from "this is
  // just what a headless single-process Chromium + SwiftShader renderer
  // costs before any page navigates" -- the earlier pass only had the
  // latter folded into one ~390MB number with no baseline to subtract.
  findings.push({
    check: 'boot RSS baseline: how much is bare-Chromium-process vs app boot cost',
    engineOnlyRssMB: mb(engineOnlyRssBytes),
    appBootRssMB: mb(samples[0].rssBytes),
    appBootOwnCostMB: (engineOnlyRssBytes != null && samples[0].rssBytes != null)
      ? mb(samples[0].rssBytes - engineOnlyRssBytes) : null,
  });

  // Load both fixtures as two separate models.
  await page.evaluate(async (urls) => {
    const files = await Promise.all(urls.map(async (u) => {
      const buffer = await (await fetch(u)).arrayBuffer();
      return new File([buffer], u.split('/').pop());
    }));
    window.ClashControl.loadFiles(files);
  }, ['/__fixture-a__.ifc', '/__fixture-b__.ifc']);
  await page.waitForFunction(() => window._ccLatestState && window._ccLatestState.models.length === 2 && window._ccModelLoading === false, null, {timeout:400_000});
  samples.push(await sample('both-loaded'));

  const modelBId = await page.evaluate(() => {
    const models = window._ccLatestState.models;
    // B is the larger fixture (more elements) — sort descending, take the first.
    return models.slice().sort((a, b) => (b.elements||[]).length - (a.elements||[]).length)[0].id;
  });

  // Read the ledger's OWN estimate for model B before touching anything —
  // this is the number we're checking against real observed movement.
  const ledgerBefore = await page.evaluate((id) => {
    const ledger = window.ClashControl.residencyLedger();
    return ledger && ledger.perModel[id] ? ledger.perModel[id] : null;
  }, modelBId);
  if (!ledgerBefore) throw new Error('residency ledger returned nothing for model B');

  // Count model B's OWN distinct scene geometries before parking (same
  // dedup-by-uuid approach the memory report itself uses) -- the precise,
  // deterministic number we expect renderer.info.memory.geometries to drop
  // by after park, if dispose() genuinely ran on all of them.
  const modelBGeometryCount = await page.evaluate((id) => {
    const S = window._ccState3d;
    const group = S && S.map && S.map[id]; // per-model THREE.Group (userData.modelId lives HERE, not per-mesh)
    if (!group) return null;
    const seen = new Set();
    group.traverse((o) => { if (o.isMesh && o.geometry) seen.add(o.geometry.uuid); });
    return seen.size;
  }, modelBId);

  // Hide model B (the precondition for park/auto-park), sample.
  await page.evaluate((id) => window._ccDispatch({t:'UPD_MODEL', id, u:{visible:false}}), modelBId);
  samples.push(await sample('model-b-hidden'));

  // Park model B via the real public API, sample.
  const parked = await page.evaluate((id) => window.ClashControl.parkModel(id), modelBId);
  await page.waitForFunction(() => (window._ccLatestState.parkedModels||[]).length === 1, null, {timeout:180_000});
  samples.push(await sample('model-b-parked'));

  const beforeParkHeap = samples[samples.length - 2].heapBytes;
  const afterParkHeap = samples[samples.length - 1].heapBytes;
  const beforeParkRss = samples[samples.length - 2].rssBytes;
  const afterParkRss = samples[samples.length - 1].rssBytes;
  const heapDrop = (beforeParkHeap != null && afterParkHeap != null) ? beforeParkHeap - afterParkHeap : null;
  const rssDrop = (beforeParkRss != null && afterParkRss != null) ? beforeParkRss - afterParkRss : null;

  findings.push({
    check: 'park reclaims real memory, roughly tracking the ledger estimate',
    ledgerEstimateMB: mb(ledgerBefore.reclaimableBytes),
    observedHeapDropMB: mb(heapDrop),
    observedRssDropMB: mb(rssDrop),
    parkReturnedTrue: parked === true,
  });

  // Deterministic check: does Three.js's own live-geometry counter actually
  // drop by model B's exact geometry count when parked? This does not depend
  // on GC timing at all -- renderer.info.memory.geometries only decrements
  // when geometry.dispose() genuinely runs, so this is a precise yes/no on
  // whether Park's disposal step works, independent of the noisy heap/RSS
  // numbers above.
  const rendererGeomsHidden = samples[samples.length - 2].rendererGeometries;
  const rendererGeomsParked = samples[samples.length - 1].rendererGeometries;
  const rendererGeomDrop = (rendererGeomsHidden != null && rendererGeomsParked != null)
    ? rendererGeomsHidden - rendererGeomsParked : null;
  findings.push({
    check: 'park disposes exactly model B\'s own geometries from renderer.info (deterministic, not GC-timing-dependent)',
    modelBOwnGeometryCount: modelBGeometryCount,
    rendererGeometriesBeforePark: rendererGeomsHidden,
    rendererGeometriesAfterPark: rendererGeomsParked,
    rendererGeometryDrop: rendererGeomDrop,
    dropMatchesModelBGeometryCount: rendererGeomDrop === modelBGeometryCount,
  });

  // Investigate the one-time cost of the FIRST restore specifically: is the
  // heap/RSS growth explained by shader/program recompilation (a legitimate
  // one-time warm-up) or by something that should have stayed flat (more
  // geometries/textures than model B's own footprint)? Captured BEFORE the
  // restore call so it's the true parked-state baseline, not accidentally
  // re-reading the post-restore sample.
  const beforeRestoreSample = samples[samples.length - 1]; // model-b-parked

  // Restore model B via the real public API, sample.
  const restored = await page.evaluate((id) => window.ClashControl.restoreModel(id), modelBId);
  await page.waitForFunction(() => window._ccLatestState.models.length === 2 && (window._ccLatestState.parkedModels||[]).length === 0, null, {timeout:180_000});
  samples.push(await sample('model-b-restored'));

  const restoredElementCount = samples[samples.length - 1].elements;
  const originalElementCount = samples[1].elements; // 'both-loaded'
  findings.push({
    check: 'restore brings the model back with the SAME element count (no data loss) and clashes still computable',
    restoreReturnedTrue: restored === true,
    originalTotalElements: originalElementCount,
    restoredTotalElements: restoredElementCount,
    elementCountMatches: restoredElementCount === originalElementCount,
  });

  // Re-run detection after restore to confirm the restored model still
  // participates correctly (functional check, not just memory).
  await page.evaluate(() => window.ClashControl.runDetection());
  await page.waitForFunction(() => window._ccLatestState.detecting === false, null, {timeout:180_000});
  samples.push(await sample('after-post-restore-detection'));

  const restoredSample = samples.find((s) => s.label === 'model-b-restored');
  findings.push({
    check: 'first restore\'s one-time heap growth — is it program/shader recompilation, or unexplained extra geometry/texture retention?',
    heapBeforeFirstRestoreMB: mb(beforeRestoreSample.heapBytes),
    heapAfterFirstRestoreMB: mb(restoredSample.heapBytes),
    heapGrowthMB: mb(restoredSample.heapBytes - beforeRestoreSample.heapBytes),
    rendererGeometriesBeforeRestore: beforeRestoreSample.rendererGeometries,
    rendererGeometriesAfterRestore: restoredSample.rendererGeometries,
    rendererProgramsBeforeRestore: beforeRestoreSample.rendererPrograms,
    rendererProgramsAfterRestore: restoredSample.rendererPrograms,
    rendererTexturesBeforeRestore: beforeRestoreSample.rendererTextures,
    rendererTexturesAfterRestore: restoredSample.rendererTextures,
    note: 'geometries returning to the pre-park count with programs/textures flat would mean the extra heap is JS-side (geoCache/property rehydration), not GPU-side',
  });

  // Repeated park<->restore cycles: does each cycle's heap cost compound
  // (a real leak — dangerous, since Park/Restore's whole purpose is being
  // safe to do repeatedly), or is it a one-time cost that stays flat on
  // subsequent cycles (e.g. one-time material/shader-cache warm-up)?
  const cycleHeaps = [];
  for (let i = 0; i < 3; i++) {
    await page.evaluate((id) => window._ccDispatch({t:'UPD_MODEL', id, u:{visible:false}}), modelBId);
    await page.evaluate((id) => window.ClashControl.parkModel(id), modelBId);
    await page.waitForFunction(() => (window._ccLatestState.parkedModels||[]).length === 1, null, {timeout:180_000});
    const afterPark = await sample('cycle-' + (i + 1) + '-parked');
    await page.evaluate((id) => window.ClashControl.restoreModel(id), modelBId);
    await page.waitForFunction(() => window._ccLatestState.models.length === 2 && (window._ccLatestState.parkedModels||[]).length === 0, null, {timeout:180_000});
    const afterRestore = await sample('cycle-' + (i + 1) + '-restored');
    cycleHeaps.push({ cycle: i + 1, parkedHeapMB: mb(afterPark.heapBytes), restoredHeapMB: mb(afterRestore.heapBytes) });
  }
  findings.push({
    check: 'repeated park<->restore cycles (3x) — does the restore heap cost compound, or stay flat?',
    cycleHeaps,
    note: 'if restoredHeapMB keeps climbing cycle over cycle, that is a real leak; if it plateaus, the cost is one-time warm-up',
  });

  // Open question surfaced by the numbers above: the plateau isn't just
  // "flat", it's flat at a level several times higher than the ORIGINAL
  // fresh-load heap for the exact same element count -- i.e. restore's
  // rebuild-from-geoCache path appears to retain meaningfully more resident
  // JS heap per element than a fresh IFC parse of the same data. This is not
  // a leak (it plateaus, doesn't keep climbing) but it is not yet explained,
  // and is recorded here rather than silently absorbed into "no leak found".
  const freshLoadHeapMB = mb(samples.find((s) => s.label === 'both-loaded').heapBytes);
  const plateauHeapMB = cycleHeaps[cycleHeaps.length - 1].restoredHeapMB;
  findings.push({
    check: 'OPEN QUESTION: does the park/restore rebuild path cost more resident heap per element than a fresh load of the same data?',
    freshLoadHeapMB,
    plateauedRestoreHeapMB: plateauHeapMB,
    ratio: freshLoadHeapMB ? Math.round((plateauHeapMB / freshLoadHeapMB) * 100) / 100 : null,
    note: 'both states hold the SAME 31k total elements; if the ratio is well above 1, restore is retaining something a fresh load does not -- worth a follow-up investigation, not resolved by this probe',
  });

  // Repeated-detection memory scenario: run detection N times, check heap
  // doesn't climb run over run (the reviewer's step 3).
  const detectionHeaps = [];
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.ClashControl.runDetection());
    await page.waitForFunction(() => window._ccLatestState.detecting === false, null, {timeout:180_000});
    const s = await sample('detection-run-' + (i + 1));
    detectionHeaps.push(s.heapBytes);
  }
  const firstRunHeap = detectionHeaps[0];
  const lastRunHeap = detectionHeaps[detectionHeaps.length - 1];
  const growthMB = (firstRunHeap != null && lastRunHeap != null) ? mb(lastRunHeap - firstRunHeap) : null;
  findings.push({
    check: 'repeated detection (6 runs) does not accumulate heap growth run-over-run',
    heapPerRunMB: detectionHeaps.map(mb),
    netGrowthAcross6RunsMB: growthMB,
  });

  if (errors.length) throw new Error(errors.join(' | '));

  const result = {
    generatedAt: new Date().toISOString(),
    scope: 'real Chromium (--single-process --no-zygote), real web-ifc WASM parse, real Park/Restore/Detection public API — not mocked',
    fixtures: { a: 'synthetic 5 storeys x 200 walls (~1k elements)', b: 'synthetic 30 storeys x 1000 walls (~30k elements, parked/restored)' },
    findings,
    samples,
  };
  const json = JSON.stringify(result, null, 2) + '\n';
  if (process.argv[2]) await writeFile(process.argv[2], json);
  console.log(json);
} finally {
  await context.close();
  await browser.close();
  server.close();
}
