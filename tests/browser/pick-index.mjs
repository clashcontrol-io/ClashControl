// Scene pick index (viewer-pick-index.js) in the real viewer: every pick and
// snap must equal the full-scene raycast path, and hover must get cheaper.
//
// Fixtures: tests/fixtures/generate-synthetic-ifc.js generateShardIfc (many
// element types, shared representations → InstancedMesh, colours incl. a
// transparent style, rooms per storey, openings). Model A is loaded with
// window._ccForceBatch (BatchedMesh), model B plain; both overlap so rays see
// occlusion and equal-distance ties.
//
// For a grid of screen points × states (plain, section box, section plane,
// ghosted model, hidden model, spaces shown, orthographic, floor plan, after
// park/restore, after a model replace) it compares, with the index and with
// S.scenePick.bruteForce (the full-scene raycast):
//   - all hits (click / occluders / walk), the raw nearest + first visible hit
//     (hover), firstVisible (orbit pivot / drag-edit), firstVisibleOn (snap
//     occlusion ray), the rooms-layer pass of the click pick;
//   - the measure snap through real mousemove events (_ccHoverSnap).
// Then a large generated federation reports hover cost (median ms per hover
// query, brute force vs indexed) and asserts the index is faster.
//
// Run:  CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 \
//       node tests/browser/pick-index.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const { generateShardIfc } = require('../fixtures/generate-synthetic-ifc.js');

const root = fileURLToPath(new URL('../..', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ifc': 'application/octet-stream', '.css': 'text/css',
};

let allOk = true;
function fail(msg) { console.error('PICK INDEX FAIL: ' + msg); allOk = false; }

const BIG = process.env.CC_PICK_BIG ? +process.env.CC_PICK_BIG : 1500; // elements per storey, large federation
// Each model gets its own GUID prefix (same length), so they load as separate
// models; b2 keeps b's prefix and file name (it replaces b).
const shard = (o, tag) => generateShardIfc(o).replace(/'3Shard/g, "'3Shd" + tag);
const virtualFiles = new Map([
  ['/__synthetic/a.ifc', shard({ storeys: 2, perStorey: 90, seed: 3 }, 'A')],
  ['/__synthetic/b.ifc', shard({ storeys: 2, perStorey: 90, seed: 11 }, 'B')],
  ['/__synthetic/b2.ifc', shard({ storeys: 2, perStorey: 70, seed: 19 }, 'B')],
  ['/__synthetic/big1.ifc', shard({ storeys: 4, perStorey: BIG, seed: 101 }, 'X')],
  ['/__synthetic/big2.ifc', shard({ storeys: 4, perStorey: BIG, seed: 202 }, 'Y')],
  ['/__synthetic/big3.ifc', shard({ storeys: 4, perStorey: BIG, seed: 303 }, 'Z')],
]);
const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (virtualFiles.has(urlPath)) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(virtualFiles.get(urlPath));
    }
    const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const localChromium = process.env.CC_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(localChromium ? {
  executablePath: localChromium,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
} : {});
const errors = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
// Overlapping synthetic models trip the same-footprint confirm(); they are meant to overlap.
page.on('dialog', (d) => d.accept());
if (process.env.CC_PICK_DEBUG) page.on('console', (m) => { if (m.type() !== 'debug') console.log('[page]', m.type(), m.text().slice(0, 200)); });
if (process.env.CC_BROWSER_OFFLINE_DEPS === '1') {
  const ctx = page.context();
  async function local(route, file, contentType) {
    await route.fulfill({
      status: 200,
      body: await readFile(join(root, 'node_modules', file)),
      headers: { 'content-type': contentType || 'text/javascript', 'access-control-allow-origin': '*' },
    });
  }
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
  await ctx.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', (r) => local(r, 'three/' + new URL(r.request().url()).pathname.split('/three@0.180.0/')[1]));
  await ctx.route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', (r) => { const s = new URL(r.request().url()).pathname.split('/web-ifc@0.0.77/')[1]; return local(r, 'web-ifc/' + s, s.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); });
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/css' }));
  await ctx.route('https://fonts.gstatic.com/**', (r) => r.abort());
  await ctx.route('https://gc.zgo.at/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadFile(url, name, { batch, expectModels }) {
  await page.evaluate(async ([url, name, batch]) => {
    window._ccForceBatch = !!batch;
    const buf = await (await fetch(url)).arrayBuffer();
    window.ClashControl.loadFiles([new File([buf], name)]);
  }, [url, name, batch]);
  try {
    await page.waitForFunction((n) => { const s = window._ccLatestState; return s && s.models.length === n && window._ccModelLoading === false && s.models.every((m) => (m.meshes || []).length); }, expectModels, { timeout: 300_000 });
  } catch (e) {
    console.error('load state', await page.evaluate(() => JSON.stringify({ n: window._ccLatestState.models.map((m) => [m.name, (m.meshes || []).length]), loading: window._ccModelLoading, modal: [...document.querySelectorAll('[role=dialog]')].map((d) => d.textContent.slice(0, 200)) })));
    throw e;
  }
  await sleep(600);
  await page.evaluate(() => { window._ccForceBatch = false; });
}

// In-page helpers.
async function installHelpers() {
  await page.evaluate(() => {
    const T = window.THREE;
    function ser(h) {
      if (!h) return null;
      return [h.object.uuid, h.instanceId, h.batchId, h.faceIndex, h.distance, h.point.x, h.point.y, h.point.z];
    }
    window.__pk = {
      frameAll() {
        const S = window._ccState3d, b = window._ccElemsBBox();
        const c = b.getCenter(new T.Vector3()), sz = b.getSize(new T.Vector3());
        S.orbit.target.copy(c); S.orbit.sph.theta = 0.6; S.orbit.sph.phi = 0.75; S.orbit.sph.r = sz.length() * 0.55;
        S.orbit.apply(); S.camera.updateMatrixWorld(true);
        return { min: b.min.toArray(), max: b.max.toArray() };
      },
      // Compare index vs brute force for an nx × ny grid of screen points.
      compareGrid(nx, ny) {
        const S = window._ccState3d, P = S.scenePick;
        S.camera.updateMatrixWorld(true);
        if (S.camera.updateProjectionMatrix) S.camera.updateProjectionMatrix();
        const opts = { planes: window._ccActivePlanes, isGhost: S._isGhostMat };
        const out = { rays: 0, hits: 0, visible: 0, mismatches: [], candidates: 0, entries: 0 };
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
          const ndc = { x: -0.96 + 1.92 * i / (nx - 1), y: -0.96 + 1.92 * j / (ny - 1) };
          const rc = new T.Raycaster(); rc.setFromCamera(ndc, S.camera);
          const run = (brute) => {
            P.bruteForce = brute;
            try {
              const all = P.all(rc);
              const f = P.first(rc, [{}, P.visiblePred(opts)]);
              const fv = P.firstVisible(rc, opts);
              const on = f[1] ? P.firstVisibleOn(rc, f[1].object, opts) : null;
              rc.layers.set(3); // rooms layer: the click pick's spaces pass
              const sp = P.all(rc).slice(0, 3);
              rc.layers.set(0);
              return { key: JSON.stringify([all.map(ser), f.map(ser), ser(fv), ser(on), sp.map(ser)]), all: all.length, vis: !!f[1] };
            } finally { P.bruteForce = false; }
          };
          const a = run(true), b = run(false);
          out.rays++;
          if (a.all) out.hits++;
          if (a.vis) out.visible++;
          const st = P.stats(); out.candidates += st.lastQueryCandidates; out.entries = st.entries;
          if (a.key !== b.key) out.mismatches.push({ ndc, brute: a.key.slice(0, 300), index: b.key.slice(0, 300) });
        }
        return out;
      },
      async hoverSnap(x, y, brute) {
        const S = window._ccState3d, el = S.renderer.domElement;
        S.scenePick.bruteForce = !!brute;
        try {
          window._ccHoverSnap = null;
          await new Promise((r) => setTimeout(r, 70)); // hover handler is throttled to 50 ms
          el.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
          const s = window._ccHoverSnap;
          return s ? JSON.stringify({ type: s.type, p: [s.point.x, s.point.y, s.point.z], src: s.srcObj && s.srcObj.uuid }) : null;
        } finally { S.scenePick.bruteForce = false; }
      },
      // Median ms of the hover query (raw nearest + first visible) over a grid.
      hoverCost(nx, ny, brute, reps) {
        const S = window._ccState3d, P = S.scenePick;
        const opts = { planes: window._ccActivePlanes, isGhost: S._isGhostMat };
        const rcs = [];
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
          const rc = new T.Raycaster(); rc.setFromCamera({ x: -0.9 + 1.8 * i / (nx - 1), y: -0.9 + 1.8 * j / (ny - 1) }, S.camera); rcs.push(rc);
        }
        P.bruteForce = !!brute;
        const times = [];
        let hits = 0;
        try {
          P.first(rcs[0], [{}, P.visiblePred(opts)]); // warm (index build)
          // performance.now() is coarse without cross-origin isolation: time
          // `reps` repeats of each ray and take the per-query mean per ray.
          for (const rc of rcs) {
            const t0 = performance.now();
            let f = null;
            for (let r = 0; r < reps; r++) f = P.first(rc, [{}, P.visiblePred(opts)]);
            times.push((performance.now() - t0) / reps);
            if (f[0]) hits++;
          }
        } finally { P.bruteForce = false; }
        times.sort((a, b) => a - b);
        return { median: times[times.length >> 1], p90: times[Math.floor(times.length * 0.9)], n: times.length, hits };
      },
    };
  });
}

const grid = [14, 9];
async function checkState(label) {
  await page.evaluate(() => { if (!window._ccLatestState.measureMode) window._ccDispatch({ t: 'MEASURE_MODE', v: 'distance' }); });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const res = await page.evaluate(([nx, ny]) => window.__pk.compareGrid(nx, ny), grid);
  // Snap through real hover events on a coarser grid.
  const rect = await page.evaluate(() => { const r = window._ccState3d.renderer.domElement.getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; });
  let snapMism = 0, snaps = 0;
  for (let i = 0; i < 5; i++) for (let j = 0; j < 4; j++) {
    const x = rect[0] + rect[2] * (0.1 + 0.8 * i / 4), y = rect[1] + rect[3] * (0.15 + 0.7 * j / 3);
    const a = await page.evaluate(([x, y]) => window.__pk.hoverSnap(x, y, true), [x, y]);
    const b = await page.evaluate(([x, y]) => window.__pk.hoverSnap(x, y, false), [x, y]);
    if (a) snaps++;
    if (a !== b) { snapMism++; if (snapMism <= 2) console.error(`  snap ${label} @${x.toFixed(0)},${y.toFixed(0)}: brute ${a} index ${b}`); }
  }
  console.log(`  ${label.padEnd(18)} rays ${res.rays}, hit ${res.hits}, visible ${res.visible}, snaps ${snaps}, mismatches ${res.mismatches.length}+${snapMism}, avg candidates ${(res.candidates / res.rays).toFixed(1)} of ${res.entries}`);
  if (res.mismatches.length) { fail(`${label}: ${res.mismatches.length} pick mismatches`); console.error(JSON.stringify(res.mismatches[0])); }
  if (snapMism) fail(`${label}: ${snapMism} snap mismatches`);
  if (!res.hits) fail(`${label}: no ray hit anything (fixture/camera)`);
  if (label === 'plain' && res.hits < res.rays / 3) fail(`plain: only ${res.hits}/${res.rays} rays hit (framing)`);
  if (label === 'plain' && !snaps) fail('plain: no hover snap');
  return res;
}

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.scenePick && window._ccViewerPickIndex, null, { timeout: 60_000 });
  await installHelpers();

  await loadFile('/__synthetic/a.ifc', 'a.ifc', { batch: true, expectModels: 1 });
  await loadFile('/__synthetic/b.ifc', 'b.ifc', { batch: false, expectModels: 2 });
  const kinds = await page.evaluate(() => { const k = { batch: 0, inst: 0, mesh: 0 }; window._ccState3d.mg.traverse((o) => { if (o.isBatchedMesh) k.batch++; else if (o.isInstancedMesh) k.inst++; else if (o.isMesh) k.mesh++; }); return k; });
  console.log('scene objects', JSON.stringify(kinds));
  if (!kinds.batch) fail('model A did not take the BatchedMesh path');
  if (!kinds.inst) fail('no InstancedMesh in the fixture');

  await page.evaluate(() => { window._ccDispatch({ t: 'MEASURE_MODE', v: 'distance' }); });
  const box = await page.evaluate(() => window.__pk.frameAll());
  const lo = box.min, hi = box.max, f = (a, b, t) => a + (b - a) * t;

  await checkState('plain');

  await page.evaluate(([lo, hi]) => window._ccDispatch({ t: 'SECTION_BOX', v: { enabled: true, min: lo, max: hi } }),
    [[0, 1, 2].map((i) => f(lo[i], hi[i], 0.2)), [0, 1, 2].map((i) => f(lo[i], hi[i], 0.7))]);
  await sleep(600);
  await checkState('section box');
  await page.evaluate(() => window._ccDispatch({ t: 'SECTION_BOX', v: { enabled: false } }));
  await page.evaluate(() => window._ccDispatch({ t: 'SECTION', axis: 'y', pos: 0.4 }));
  await sleep(600);
  await checkState('section plane');
  await page.evaluate(() => window._ccDispatch({ t: 'SECTION', axis: null, pos: 0.5 }));
  await sleep(400);

  // Ghost everything but a handful of model A's elements (batched split-outs
  // are added to the model group → index rebuild via childadded).
  await page.evaluate(() => {
    const st = window._ccLatestState, S = window._ccState3d;
    const a = st.models[0];
    S._ghostOthers(a.elements.slice(0, 25).map((e) => ({ expressId: e.expressId, modelId: a.id })));
  });
  await sleep(300);
  await checkState('ghosted');
  await page.evaluate(() => window._ccState3d._unghostAll());
  await sleep(300);
  await checkState('unghosted');

  await page.evaluate(() => { const m = window._ccLatestState.models[1]; window._ccDispatch({ t: 'UPD_MODEL', id: m.id, u: { visible: false } }); });
  await sleep(400);
  await checkState('hidden model');
  await page.evaluate(() => { const m = window._ccLatestState.models[1]; window._ccDispatch({ t: 'UPD_MODEL', id: m.id, u: { visible: true } }); });
  await sleep(400);

  await page.evaluate(() => window._ccDispatch({ t: 'UPD_PREFS', u: { showSpaces: true } }));
  await sleep(500);
  await checkState('spaces shown');
  await page.evaluate(() => window._ccDispatch({ t: 'UPD_PREFS', u: { showSpaces: false } }));
  await sleep(300);

  // Orthographic camera (same construction as the toolbar's ortho toggle).
  await page.evaluate(() => {
    const S = window._ccState3d, T = window.THREE, el2 = S.renderer.domElement.parentElement, aspect = el2.clientWidth / el2.clientHeight;
    const dist = S.camera.position.distanceTo(S.orbit.target), hh = dist * Math.tan(T.MathUtils.degToRad(55 / 2));
    const nc = new T.OrthographicCamera(-hh * aspect, hh * aspect, hh, -hh, -10000, 10000);
    nc.position.copy(S.camera.position); nc.quaternion.copy(S.camera.quaternion); nc.zoom = 1; nc.updateProjectionMatrix();
    S._pkPersp = S.camera; S.camera = nc; S.orbit.camera = nc; S.orbit.sync(); S.orbit.apply();
  });
  await sleep(300);
  await checkState('orthographic');
  await page.evaluate(() => { const S = window._ccState3d; S.camera = S._pkPersp; S.orbit.camera = S._pkPersp; S.orbit.sync(); S.orbit.apply(); });

  await page.evaluate(() => {
    const st = window._ccLatestState.models.flatMap((m) => m.storeys || []).sort((a, b) => (a.elevation || 0) - (b.elevation || 0))[0];
    window._ccDispatch({ t: 'FLOOR_PLAN', v: { storeyId: st.id, storeyName: st.name, elevation: st.elevation || 0, cutHeight: 1.2 } });
  });
  await sleep(1500);
  await checkState('floor plan');
  await page.evaluate(() => window._ccDispatch({ t: 'FLOOR_PLAN', v: null }));
  await sleep(1200);
  await page.evaluate(() => window.__pk.frameAll());

  // Park / restore model B.
  const bId = await page.evaluate(() => window._ccLatestState.models[1].id);
  await page.evaluate((id) => window._ccDispatch({ t: 'UPD_MODEL', id, u: { visible: false } }), bId);
  const parked = await page.evaluate((id) => window.ClashControl.parkModel(id), bId);
  if (parked) {
    await page.waitForFunction(() => (window._ccLatestState.parkedModels || []).length === 1, null, { timeout: 180_000 });
    await checkState('parked');
    await page.evaluate((id) => window.ClashControl.restoreModel(id), bId);
    await page.waitForFunction(() => window._ccLatestState.models.length === 2 && (window._ccLatestState.parkedModels || []).length === 0 && window._ccModelLoading === false, null, { timeout: 180_000 });
    await page.evaluate(() => { const m = window._ccLatestState.models.find((x) => x.visible === false); if (m) window._ccDispatch({ t: 'UPD_MODEL', id: m.id, u: { visible: true } }); });
    await sleep(800);
    await checkState('restored');
  } else {
    fail('model B could not be parked (no cached geometry?)');
    await page.evaluate((id) => window._ccDispatch({ t: 'UPD_MODEL', id, u: { visible: true } }), bId);
  }

  // Model replace: same file name, different content → same model id, new
  // scene group (the scene-graph path REPLACE_MODEL / live sync takes).
  const before = await page.evaluate(() => { const S = window._ccState3d; return S.mg.children.map((g) => g.uuid).join(','); });
  await page.evaluate(async () => {
    const buf = await (await fetch('/__synthetic/b2.ifc')).arrayBuffer();
    window.ClashControl.loadFiles([new File([buf], 'b.ifc')]);
  });
  await page.waitForFunction((b) => { const S = window._ccState3d, s = window._ccLatestState; return window._ccModelLoading === false && s.models.length === 2 && S.mg.children.map((g) => g.uuid).join(',') !== b; }, before, { timeout: 300_000 });
  await sleep(800);
  await checkState('model replaced');
  const st = await page.evaluate(() => window._ccState3d.scenePick.stats());
  console.log('index stats', JSON.stringify(st));

  // ── Hover cost on a large generated federation ──────────────────
  await page.evaluate(() => { window._ccDispatch({ t: 'MEASURE_MODE', v: null }); window._ccLatestState.models.map((m) => m.id).forEach((id) => window._ccDispatch({ t: 'DEL_MODEL', id })); });
  await page.waitForFunction(() => window._ccLatestState.models.length === 0, null, { timeout: 60_000 });
  await sleep(500);
  await loadFile('/__synthetic/big1.ifc', 'big1.ifc', { batch: true, expectModels: 1 });
  await loadFile('/__synthetic/big2.ifc', 'big2.ifc', { batch: false, expectModels: 2 });
  await loadFile('/__synthetic/big3.ifc', 'big3.ifc', { batch: false, expectModels: 3 });
  await page.evaluate(() => window.__pk.frameAll());
  await sleep(400);
  const fed = await page.evaluate(() => { const k = { batch: 0, batchInst: 0, inst: 0, mesh: 0 }; window._ccState3d.mg.traverse((o) => { if (o.isBatchedMesh) { k.batch++; k.batchInst += o.userData.batchExprIds.length; } else if (o.isInstancedMesh) k.inst++; else if (o.isMesh) k.mesh++; }); k.elements = window._ccLatestState.models.reduce((n, m) => n + (m.elements || []).length, 0); return k; });
  const t0 = Date.now();
  const idxCost = await page.evaluate(() => window.__pk.hoverCost(12, 8, false, 200));
  const buildInfo = await page.evaluate(() => window._ccState3d.scenePick.stats());
  const bfCost = await page.evaluate(() => window.__pk.hoverCost(12, 8, true, 10));
  const fedCheck = await page.evaluate(() => window.__pk.compareGrid(10, 7));
  console.log(`federation: ${JSON.stringify(fed)}; index build ${buildInfo.buildMs.toFixed(0)} ms total over ${buildInfo.builds} model builds (${buildInfo.entries} entries, ${buildInfo.nodes} nodes)`);
  console.log(`hover cost (median ms per hover query): brute force ${bfCost.median.toFixed(3)} (p90 ${bfCost.p90.toFixed(3)}), indexed ${idxCost.median.toFixed(3)} (p90 ${idxCost.p90.toFixed(3)}) — ${(bfCost.median / Math.max(idxCost.median, 1e-6)).toFixed(0)}x; ${idxCost.hits}/${idxCost.n} rays hit`);
  console.log(`federation identity: ${fedCheck.rays} rays, ${fedCheck.mismatches.length} mismatches, avg candidates ${(fedCheck.candidates / fedCheck.rays).toFixed(1)} of ${fedCheck.entries} (${Date.now() - t0} ms)`);
  if (fedCheck.mismatches.length) fail('federation: pick mismatches ' + JSON.stringify(fedCheck.mismatches[0]));
  if (!(idxCost.median < bfCost.median)) fail('indexed hover is not cheaper than brute force');
  if (!idxCost.hits) fail('federation: no hover ray hit');

  if (errors.length) fail('page errors: ' + errors.slice(0, 3).join(' | '));
} catch (e) {
  fail(e && e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}
if (allOk) console.log('PICK INDEX OK — picks and snaps identical to the full-scene raycast in every state; hover cheaper');
process.exit(allOk ? 0 : 1);
