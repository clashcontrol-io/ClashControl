// Occlusion culling differential (flag `occlusionCulling`, docs/OCCLUSION_CULLING.md).
//
// For every view it renders the app's own frame twice through tick() — once
// with occlusion culling on, once off — captures each frame right after
// render() (the app's screenshot hook) and requires the two PNGs to be
// IDENTICAL (zero tolerance). It also requires the "on" frame to have
// actually run the pass and reports triangles/draw calls submitted on vs off.
// A third capture (on again) guards against state leaking out of the pass.
//
// Depth self-test: the proof needs per-sample MSAA depth. Software GL
// (SwiftShader) evaluates depth at the pixel centre instead, so there the
// pass refuses to run (stats.why 'msaa-center-depth'). The generated-fixture
// scenarios override that (ignoreSelfTest) to exercise the proof anyway — their
// geometry has no steep sub-pixel slivers — and one view checks the refusal.
// The probe scenario honours the self-test unless CC_OCCL_IGNORE_SELFTEST=1.
//
// Scenarios (fixtures generated in memory by tests/fixtures/generate-office-ifc.js):
//   office     — committed office architecture + MEP: opening fitAll, interior
//                views, Hidden Line style (FrontSide), section plane, section
//                box, isolate (ghosted rest), hidden facade
//   batched    — the same architecture forced into BatchedMesh (_ccForceBatch)
//   instanced  — columns as IfcMappedItem -> InstancedMesh
//   verify     — the per-device verification behind the flag's default 'auto' mode
//                (self-test refusal, persistence, version change, verified, mismatch)
//   large      — 6 storeys x 3 bays (CC_OCCL_LARGE=NxB) with fit-out (desks, partitions) + MEP;
//                also a detection run: the pass stands down (why 'detecting') and
//                the clash list is identical with the pass on vs off;
//                also measures orbit frame time / triangles on vs off
// Optional: CC_PROBE_FILE=/abs/model.ifc or CC_PROBE_FILES=a.ifc,b.ifc adds a
// "probe" scenario on your own files (nothing about them is written anywhere
// unless you pass an output path).
//
// Run:
//   [CC_CHROMIUM_EXECUTABLE=/path/to/chromium CC_BROWSER_OFFLINE_DEPS=1] \
//   node tests/browser/occlusion-culling.mjs [out.json]
// Env: CC_OCCL_W/CC_OCCL_H viewport (default 1280x720), CC_OCCL_ONLY=office,large
// Timings under SwiftShader (software GL) are indicative only; triangle and
// draw-call counts do not depend on the GPU.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const root = process.env.CC_REPO_ROOT || fileURLToPath(new URL('../..', import.meta.url));
const { generate } = require(join(root, 'tests/fixtures/generate-office-ifc.js'));
const W = Number(process.env.CC_OCCL_W || 1280), H = Number(process.env.CC_OCCL_H || 720);
const ONLY = process.env.CC_OCCL_ONLY ? process.env.CC_OCCL_ONLY.split(',') : null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

// In-memory fixtures served at /__fx__/<name>
const fx = {};
const office = generate();
fx['office-architecture.ifc'] = office.architecture;
fx['office-mep.ifc'] = office.mep;
fx['instanced-architecture.ifc'] = generate({ mappedColumns: true }).architecture;
// CC_OCCL_LARGE=<storeys>x<bays> (default 6x3) for a bigger measurement run
const [LN, LB] = (process.env.CC_OCCL_LARGE || '6x3').split('x').map(Number);
fx['large-architecture.ifc'] = generate({ nlev: LN, bays: LB, fitOut: true }).architecture;
fx['large-mep.ifc'] = generate({ nlev: LN }).mep;
const probeFiles = process.env.CC_PROBE_FILES ? process.env.CC_PROBE_FILES.split(',')
  : process.env.CC_PROBE_FILE ? [process.env.CC_PROBE_FILE] : [];

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let m = path.match(/^\/__fx__\/(.+)$/);
    if (m && fx[m[1]] != null) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(fx[m[1]]); }
    m = path.match(/^\/__probe__\/(\d+)$/);
    if (m) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(await readFile(probeFiles[+m[1]])); }
    const file = normalize(join(root, path === '/' ? 'index.html' : path.slice(1)));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(8768, '127.0.0.1', r));

const executablePath = process.env.CC_CHROMIUM_EXECUTABLE || undefined; // CI: Playwright's own Chromium
// One browser per scenario: with --single-process, closing a context can take the browser down.
let browser = null;

let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL: ' + msg); };

async function newPage() {
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--no-zygote', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  if (process.env.CC_BROWSER_OFFLINE_DEPS === '1') {
    const local = async (route, file, ct) => route.fulfill({ status: 200, body: await readFile(join(root, 'node_modules', file)), headers: { 'content-type': ct || 'text/javascript', 'access-control-allow-origin': '*' } });
    await context.route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
    await context.route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
    await context.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
    await context.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
    await context.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.worker.min.js'));
    await context.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', (r) => local(r, 'three/' + new URL(r.request().url()).pathname.split('/three@0.180.0/')[1]));
    await context.route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', (r) => { const s = new URL(r.request().url()).pathname.split('/web-ifc@0.0.77/')[1]; return local(r, 'web-ifc/' + s, s.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); });
    await context.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/css' }));
    await context.route('https://fonts.gstatic.com/**', (r) => r.abort());
    await context.route('https://gc.zgo.at/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  }
  const page = await context.newPage();
  page.on('pageerror', (e) => fail('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'warning' && /\[occlusion\]/.test(m.text())) fail('console: ' + m.text()); });
  await page.goto('http://127.0.0.1:8768/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.mg && window._ccOcclusion, null, { timeout: 60_000 });
  return page;
}

async function load(page, urls, forceBatch) {
  await page.evaluate(async ({ urls, forceBatch }) => {
    if (forceBatch) window._ccForceBatch = true;
    const fs = [];
    for (const u of urls) fs.push(new File([await (await fetch(u)).arrayBuffer()], u.split('/').pop().replace(/^\d+$/, (d) => 'model-' + d + '.ifc')));
    window.ClashControl.loadFiles(fs);
  }, { urls, forceBatch: !!forceBatch });
  await page.waitForFunction((n) => { const s = window._ccLatestState; return s && s.models.length === n && s.models.every((m) => (m.elements || []).length >= 2); }, urls.length, { timeout: 900_000 });
  await page.waitForFunction(() => window._ccModelLoading === false, null, { timeout: 900_000 });
  await page.waitForTimeout(1500);
  return page.evaluate(() => {
    const kinds = { mesh: 0, instanced: 0, batched: 0, tris: 0 };
    window._ccState3d.mg.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry; const t = g && g.attributes.position ? (g.index ? g.index.count : g.attributes.position.count) / 3 : 0;
      if (o.isBatchedMesh) kinds.batched++; else if (o.isInstancedMesh) { kinds.instanced++; kinds.tris += t * o.count; } else if (o.userData.expressId != null) { kinds.mesh++; kinds.tris += t; }
    });
    return { kinds, elements: window._ccLatestState.models.reduce((a, m) => a + (m.elements || []).length, 0) };
  });
}

// Runs in the page: put the view in place (setup), let it settle, then capture on/off/on.
async function captureView(page, view) {
  return page.evaluate(async (view) => {
    const S = window._ccState3d, oc = window._ccOcclusion;
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const frames = async (n) => { for (let i = 0; i < n; i++) await raf(); };
    const b = window._ccViewport.getBounds(), c = b.center, sz = b.size;
    const setView = (pos, tgt) => { S.camera.position.set(pos[0], pos[1], pos[2]); S.orbit.target.set(tgt[0], tgt[1], tgt[2]); S.orbit.sync(); S.orbit.apply(); };
    const interior = (ang, off, eye) => {
      const eyeY = b.min[1] + (eye || 1.6);
      const px = c[0] + (off || [0, 0])[0] * sz[0], pz = c[2] + (off || [0, 0])[1] * sz[2];
      setView([px, eyeY, pz], [px + Math.cos(ang) * 3, eyeY, pz + Math.sin(ang) * 3]);
    };
    const els = () => window._ccLatestState.models.flatMap((m) => (m.elements || []).map((e) => ({ m, e })));
    const byName = (re) => els().filter(({ e }) => re.test((e.props && e.props.name) || '')).map(({ m, e }) => ({ modelId: m.id, expressId: e.expressId }));
    const setup = view.setup || [];
    for (const step of setup) {
      if (step === 'fitAll') { window._ccViewport.fitAll(1.0); await new Promise((r) => setTimeout(r, 2500)); }
      else if (step.interior) interior(step.interior.angle, step.interior.offset, step.interior.eye);
      else if (step.orbit) { // above the model, looking down at the centre
        S.orbit.target.set(c[0], c[1], c[2]); S.orbit.sph.theta = step.orbit.theta; S.orbit.sph.phi = step.orbit.phi;
        S.orbit.sph.r = Math.hypot(sz[0], sz[1], sz[2]) * (step.orbit.r || 0.9); S.orbit.apply();
      }
      else if (step.style) { window._ccDispatch({ t: 'UPD_PREFS', u: { renderStyle: step.style } }); await new Promise((r) => setTimeout(r, 600)); }
      else if (step.section) { window._ccDispatch({ t: 'SECTION', axis: step.section.axis, pos: step.section.pos }); await new Promise((r) => setTimeout(r, 600)); }
      else if (step.sectionBox) {
        const f = step.sectionBox; // fractions of the model bounds
        const lo = [0, 1, 2].map((i) => b.min[i] + f[0][i] * sz[i]), hi = [0, 1, 2].map((i) => b.min[i] + f[1][i] * sz[i]);
        window._ccDispatch({ t: 'SECTION_BOX', v: { enabled: true, min: lo, max: hi } }); await new Promise((r) => setTimeout(r, 600));
      }
      else if (step.ortho) { // same construction as the toolbar's ortho toggle (_ccToggleOrtho)
        const T = window.THREE, el2 = S.renderer.domElement.parentElement, aspect = el2.clientWidth / el2.clientHeight;
        const dist = S.camera.position.distanceTo(S.orbit.target), hh = dist * Math.tan(T.MathUtils.degToRad(55 / 2));
        const nc = new T.OrthographicCamera(-hh * aspect, hh * aspect, hh, -hh, -10000, 10000);
        nc.position.copy(S.camera.position); nc.quaternion.copy(S.camera.quaternion); nc.zoom = 1; nc.updateProjectionMatrix();
        S._occlTestPersp = S.camera; S.camera = nc; S.orbit.camera = nc; S.orbit.sync(); S.orbit.apply();
      }
      else if (step.floorPlan != null) {
        const st = window._ccLatestState.models.flatMap((m) => m.storeys || []).sort((a, b2) => (a.elevation || 0) - (b2.elevation || 0))[step.floorPlan];
        window._ccDispatch({ t: 'FLOOR_PLAN', v: { storeyId: st.id, storeyName: st.name, elevation: st.elevation || 0, cutHeight: 1.2 } });
        await new Promise((r) => setTimeout(r, 1500));
      }
      else if (step.isolate) { window._ccIsolate(byName(new RegExp(step.isolate))); await new Promise((r) => setTimeout(r, 300)); }
      else if (step.hide) { window._ccTempHide(byName(new RegExp(step.hide))); await new Promise((r) => setTimeout(r, 300)); }
    }
    // settle: fresh frustum/LOD pass for this camera, no animation in flight
    let key = '';
    for (let i = 0; i < 60; i++) {
      S._forceCull = true; S._lastCullCamKey = ''; window._ccInvalidate(3); await frames(3);
      const p = S.camera.position, q = S.camera.quaternion, k = [p.x, p.y, p.z, q.x, q.y, q.z, q.w].map((v) => v.toFixed(6)).join();
      if (k === key) break; key = k;
    }
    oc.adaptive = false;
    oc.ignoreSelfTest = !!view.ignoreSelfTest;
    const shot = (on) => new Promise((resolve) => {
      if (view.auto) oc.setMode(on ? 'auto' : 'off'); else oc.setEnabled(on);
      window._ccPendingScreenshot = (url) => {
        const info = S.renderer.info.render;
        resolve({ url, tris: info.triangles, calls: info.calls, stats: oc.stats });
      };
      window._ccInvalidate(1);
    });
    await frames(2);
    const on1 = await shot(true); await frames(2);
    const off = await shot(false); await frames(2);
    const on2 = await shot(true); await frames(2);
    // steady-state cost of the pass for this view (first use pays JIT + adjacency)
    let passMin = Infinity;
    for (let i = 0; i < 4; i++) { const r = await shot(true); if (r.stats && r.stats.ran) passMin = Math.min(passMin, r.stats.ms); await frames(1); }
    let diffPx = 0;
    if (on1.url !== off.url) {
      const dec = async (u) => { const img = new Image(); img.src = u; await img.decode(); const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height; const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0); return cx.getImageData(0, 0, img.width, img.height).data; };
      const a = await dec(on1.url), bb = await dec(off.url);
      for (let i = 0; i < a.length; i += 4) if (a[i] !== bb[i] || a[i + 1] !== bb[i + 1] || a[i + 2] !== bb[i + 2] || a[i + 3] !== bb[i + 3]) diffPx++;
    }
    // teardown of view-specific state
    for (const step of setup) {
      if (step.style) window._ccDispatch({ t: 'UPD_PREFS', u: { renderStyle: 'shaded' } });
      if (step.section) window._ccDispatch({ t: 'SECTION', axis: null });
      if (step.sectionBox) window._ccDispatch({ t: 'SECTION_BOX', v: { enabled: false } });
      if (step.isolate) window._ccUnisolate();
      if (step.hide) window._ccTempUnhide();
      if (step.floorPlan != null) window._ccDispatch({ t: 'FLOOR_PLAN', v: null });
      if (step.ortho && S._occlTestPersp) { const pc = S._occlTestPersp; pc.position.copy(S.camera.position); pc.quaternion.copy(S.camera.quaternion); S.camera = pc; S.orbit.camera = pc; S.orbit.sync(); S.orbit.apply(); delete S._occlTestPersp; }
    }
    await new Promise((r) => setTimeout(r, 400));
    const canvas = S.renderer.domElement;
    return {
      view: view.name, canvas: canvas.width + 'x' + canvas.height,
      identical: on1.url === off.url, identicalOnOn: on1.url === on2.url, diffPx,
      trianglesOn: on1.tris, trianglesOff: off.tris, callsOn: on1.calls, callsOff: off.calls,
      stats: on1.stats, statsOff: off.stats, passMsSteady: isFinite(passMin) ? +passMin.toFixed(2) : null,
    };
  }, view);
}

// Orbit the camera N frames with culling on/off; average frame time + triangles.
async function orbitPerf(page, frames) {
  return page.evaluate(async (N) => {
    const S = window._ccState3d, oc = window._ccOcclusion;
    const b = window._ccViewport.getBounds(), c = b.center, sz = b.size;
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const out = {};
    for (const mode of ['off', 'on', 'interior-off', 'interior-on']) {
      oc.setEnabled(mode.endsWith('on')); oc.adaptive = true;
      const inside = mode.startsWith('interior');
      let tris = 0, calls = 0, occlMs = 0, ran = 0, culled = 0;
      const times = [];
      await raf();
      let last = performance.now();
      for (let i = 0; i < N; i++) {
        const a = i / N * Math.PI * 2;
        if (inside) {
          const eyeY = b.min[1] + 1.6;
          S.camera.position.set(c[0] + Math.cos(a) * sz[0] * 0.2, eyeY, c[2] + Math.sin(a) * sz[2] * 0.2);
          S.orbit.target.set(S.camera.position.x + Math.cos(a * 2) * 3, eyeY, S.camera.position.z + Math.sin(a * 2) * 3);
          S.orbit.sync(); S.orbit.apply();
        } else {
          S.orbit.target.set(c[0], c[1], c[2]); S.orbit.sph.theta = a; S.orbit.sph.phi = 1.0; S.orbit.sph.r = Math.hypot(sz[0], sz[1], sz[2]) * 0.9; S.orbit.apply();
        }
        S._forceCull = true; S._lastCullCamKey = '';
        window._ccInvalidate(1);
        await raf();
        const now = performance.now(); times.push(now - last); last = now;
        tris += S.renderer.info.render.triangles; calls += S.renderer.info.render.calls;
        const st = oc.stats; if (st && st.ran) { ran++; occlMs += st.ms; culled += st.culled; }
      }
      times.sort((x, y) => x - y);
      out[mode] = { frames: N, msMedian: +times[N >> 1].toFixed(2), msMean: +(times.reduce((x, y) => x + y, 0) / N).toFixed(2),
        trianglesMean: Math.round(tris / N), callsMean: Math.round(calls / N), occlPassRan: ran, occlPassMsMean: ran ? +(occlMs / ran).toFixed(3) : 0, culledMean: ran ? Math.round(culled / ran) : 0 };
    }
    oc.setEnabled(true); oc.adaptive = true;
    return out;
  }, frames);
}

// Eye 1.6 m above the model's lowest point. The "centre" views put the
// camera inside the office's corridor wall (an element around the lens: the
// pass must not cull through it); the others stand in a room.
// Detection must never compete with the pass: frames rendered while a run is
// live report why:'detecting', and the clash list is identical with the pass
// forced on vs off (field for field; fields that differ between two
// identical off-runs, e.g. ids/timestamps, are excluded).
async function detectionCheck(page) {
  return page.evaluate(async () => {
    const oc = window._ccOcclusion, raf = () => new Promise((r) => requestAnimationFrame(r));
    const rules = { hard: true, maxGap: 0.05, excludeSameDiscipline: false, selfClashModels: 'none', fullRerun: true };
    const run = async (mode) => {
      oc.setMode(mode); oc.adaptive = false; oc.ignoreSelfTest = true;
      for (let i = 0; i < 4; i++) await raf();
      const frames = [];
      const onFrame = () => { const active = window._ccDetectionActive(); queueMicrotask(() => frames.push({ active, why: oc.stats && oc.stats.why, ran: !!(oc.stats && oc.stats.ran) })); };
      window._ccHasFrameListener = true; window.addEventListener('cc-render-frame', onFrame);
      let live = true;
      const pump = () => { if (!live) return; window._ccInvalidate(1); requestAnimationFrame(pump); };
      pump();
      // deterministic probes of the frame's pass while the run is live: right
      // after it starts, and inside its progress events
      const probes = [];
      const probe = () => { const active = window._ccDetectionActive(); const st = oc.probe(); probes.push({ active, why: st && st.why, ran: !!(st && st.ran) }); };
      window.addEventListener('cc-detect-progress', probe);
      let result;
      try { const p = window.ClashControl.runDetection(rules); probe(); result = await p; }
      finally { live = false; window.removeEventListener('cc-render-frame', onFrame); window.removeEventListener('cc-detect-progress', probe); window._ccHasFrameListener = false; }
      // after the run: the pass must be back once the app has committed the
      // result (state.detecting is cleared by the reducer, which can land a
      // tick after the API promise resolves)
      for (let i = 0; i < 100 && window._ccDetectionActive(); i++) await new Promise((r) => setTimeout(r, 20));
      probe();
      frames.push(...probes.map((x) => Object.assign({ probe: true }, x)));
      await raf(); await raf();
      return { result: result || [], frames };
    };
    const off1 = await run('off'), off2 = await run('off'), on = await run('force');
    const keys = new Set(); [off1, off2, on].forEach((r) => r.result.forEach((c) => Object.keys(c).forEach((k) => keys.add(k))));
    const valuesOf = (list, k) => list.map((c) => JSON.stringify(c[k] === undefined ? null : c[k])).sort().join('\n');
    const volatile = [...keys].filter((k) => valuesOf(off1.result, k) !== valuesOf(off2.result, k));
    const canon = (list) => list.map((c) => JSON.stringify(Object.keys(c).filter((k) => !volatile.includes(k)).sort().map((k) => [k, c[k] === undefined ? null : c[k]]))).sort();
    const a = canon(off1.result), b = canon(on.result);
    let firstDiff = null;
    if (a.length !== b.length) firstDiff = 'count ' + a.length + ' vs ' + b.length;
    else for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { firstDiff = a[i].slice(0, 300) + ' VS ' + b[i].slice(0, 300); break; }
    const during = on.frames.filter((f) => f.active);
    const after = on.frames.filter((f) => f.probe && !f.active).pop();
    return { clashes: on.result.length, fieldsCompared: [...keys].length - volatile.length, volatile, identical: !firstDiff, firstDiff,
      framesDuringDetection: during.length, whysDuringDetection: [...new Set(during.map((f) => f.why))], ranDuringDetection: during.filter((f) => f.ran).length,
      naturalFramesDuring: during.filter((f) => !f.probe).length, probesDuring: during.filter((f) => f.probe).length,
      afterRun: after || null };
  });
}

const interiorViews = [
  { name: 'interior, in a room, +X', setup: [{ interior: { angle: 0, offset: [-0.25, -0.25] } }] },
  { name: 'interior, in a room, -X', setup: [{ interior: { angle: Math.PI, offset: [0.25, 0.25] } }] },
  { name: 'interior, in a room, +Z', setup: [{ interior: { angle: Math.PI / 2, offset: [-0.3, -0.3] } }] },
  { name: 'interior, in a room, -Z', setup: [{ interior: { angle: -Math.PI / 2, offset: [0.25, 0.25] } }] },
  { name: 'interior, in a room, diagonal', setup: [{ interior: { angle: 0.6, offset: [-0.35, -0.3] } }] },
  { name: 'interior, centre (inside a wall), +X', setup: [{ interior: { angle: 0 } }] },
];
const scenarios = [
  { name: 'office', urls: ['/__fx__/office-architecture.ifc', '/__fx__/office-mep.ifc'], mustCull: true, ignoreSelfTest: true, views: [
    { name: 'opening (fitAll)', setup: ['fitAll'] },
    ...interiorViews,
    { name: 'from above (orbit)', setup: [{ orbit: { theta: 0.7, phi: 0.5 } }] },
    { name: 'interior, Hidden Line style (FrontSide)', setup: [{ style: 'standard' }, { interior: { angle: 0 } }] },
    { name: 'interior, X-ray style', setup: [{ style: 'xray' }, { interior: { angle: 0 } }] },
    { name: 'section plane (y 0.5), interior', setup: [{ section: { axis: 'y', pos: 0.5 } }, { interior: { angle: 0 } }] },
    { name: 'section plane (x 0.5), opening', setup: ['fitAll', { section: { axis: 'x', pos: 0.5 } }] },
    { name: 'section box, from above', setup: [{ sectionBox: [[0.1, 0, 0.1], [0.9, 0.6, 0.9]] }, { orbit: { theta: 0.7, phi: 0.6 } }] },
    { name: 'isolate (rest ghosted), interior', setup: [{ isolate: 'Column|Corridor' }, { interior: { angle: 0 } }] },
    { name: 'facades hidden, opening', setup: [{ hide: 'Facade South' }, 'fitAll'] },
    { name: 'orthographic, from above', setup: [{ orbit: { theta: 0.7, phi: 0.6, r: 1.6 } }, { ortho: true }] },
    { name: 'floor plan (lowest storey)', setup: [{ floorPlan: 0 }] },
    // the depth self-test is honoured when not overridden (on software GL it fails and the pass stays off)
    { name: 'opening, depth self-test honoured', setup: ['fitAll'], ignoreSelfTest: false },
  ] },
  { name: 'batched', urls: ['/__fx__/office-architecture.ifc'], forceBatch: true, needKind: 'batched', ignoreSelfTest: true, views: [
    { name: 'opening (fitAll)', setup: ['fitAll'] },
    ...interiorViews.slice(0, 3),
    { name: 'isolate (batch ghosted, split-outs), interior', setup: [{ isolate: 'Column' }, { interior: { angle: 0 } }] },
  ] },
  { name: 'instanced', urls: ['/__fx__/instanced-architecture.ifc'], needKind: 'instanced', ignoreSelfTest: true, views: [
    { name: 'opening (fitAll)', setup: ['fitAll'] },
    ...interiorViews.slice(0, 3),
  ] },
  { name: 'large', urls: ['/__fx__/large-architecture.ifc', '/__fx__/large-mep.ifc'], mustCull: true, perf: 48, detect: true, ignoreSelfTest: true, views: [
    { name: 'opening (fitAll)', setup: ['fitAll'] },
    ...interiorViews,
    { name: 'from above (orbit)', setup: [{ orbit: { theta: 0.7, phi: 0.5 } }] },
  ] },
];
if (probeFiles.length) scenarios.push({ name: 'probe', urls: probeFiles.map((_, i) => '/__probe__/' + i), perf: 24, ignoreSelfTest: process.env.CC_OCCL_IGNORE_SELFTEST === '1', views: [
  { name: 'opening (fitAll)', setup: ['fitAll'] }, ...interiorViews, { name: 'from above (orbit)', setup: [{ orbit: { theta: 0.7, phi: 0.5 } }] },
] });

// ── Per-device verification ('auto' mode, the flag's default) ──────────
// (a) where the depth self-test fails the verdict is 'refused' and culling
//     never runs; (d) the verdict persists across reloads for the same key and
//     a different app version is a different key (pending again); (b) with the
//     self-test overridden the offscreen check passes -> 'verified', culling is
//     active in auto mode and frames stay identical; (c) an injected pixel
//     mismatch -> 'refused', culling off, and that refusal persists.
async function deviceVerification() {
  const out = { steps: [] };
  const page = await newPage();
  const ctx = page.context();
  const office = ['/__fx__/office-architecture.ifc', '/__fx__/office-mep.ifc'];
  const status = (p) => p.evaluate(() => window._ccOcclusion.status());
  const settled = async (p, want) => (await p.waitForFunction((w) => {
    const st = window._ccOcclusion.status();
    return (w ? w.includes(st.state) : st.state !== 'pending') ? st : null;
  }, want || null, { timeout: 180_000 })).jsonValue();
  const note = (step, st, extra) => { out.steps.push({ step, ...st, ...(extra || {}) }); console.log(`verify ${step}: ${st.state}${st.why ? ' (' + st.why + ')' : ''}${st.source ? ' [' + st.source + ']' : ''} active=${st.active}`); };
  const autoView = (name, setup, ign) => ({ name, setup, auto: true, ignoreSelfTest: ign });
  const checkFrames = async (p, label, views, expectActive) => {
    for (const v of views) {
      const r = await captureView(p, v);
      const st = r.stats || {};
      console.log(`${r.identical ? 'SAME' : 'DIFF'}  verify / ${label} / ${r.view}: tris on/off ${r.trianglesOn}/${r.trianglesOff}, ${st.ran ? 'culled ' + st.culled : 'pass not run (' + st.why + ')'}`);
      if (!r.identical) fail(`verify / ${label} / ${r.view}: frames differ by ${r.diffPx} px`);
      if (expectActive === false && st.ran) fail(`verify / ${label} / ${r.view}: culling ran although not verified`);
      if (expectActive === true && !st.ran) fail(`verify / ${label} / ${r.view}: culling did not run although verified (${st.why})`);
      out.steps.push({ step: label + ' / ' + r.view, identical: r.identical, ran: !!st.ran, culled: st.culled || 0 });
    }
  };

  const st0 = await status(page);
  if (st0.mode !== 'auto') fail('flag default should be auto mode, got ' + st0.mode);
  await load(page, office);
  const st1 = await settled(page);
  const selfTest = await page.evaluate(() => window._ccOcclusion.selfTest);
  note('(a) after load', st1, { selfTest });
  if (selfTest && !selfTest.ok) {
    if (st1.state !== 'refused' || st1.why !== 'msaa-center-depth') fail('(a) expected refused/msaa-center-depth, got ' + JSON.stringify(st1));
    await checkFrames(page, '(a) refused', [autoView('opening', ['fitAll'], false), autoView('in a room, +X', [{ interior: { angle: 0, offset: [-0.25, -0.25] } }], false)], false);
  } else if (st1.state === 'refused') fail('(a) self-test passed but verdict refused: ' + st1.why);

  // (d) persistence for the same key, and a version change -> new key
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window._ccOcclusion && window._ccState3d && window._ccState3d.mg, null, { timeout: 60_000 });
  const st2 = await status(page);
  note('(d) reload, same key', st2);
  if (st2.state !== st1.state || st2.source !== 'stored' || st2.key !== st1.key) fail('(d) verdict did not persist across reload: ' + JSON.stringify(st2));
  const vpage = await ctx.newPage();
  await vpage.addInitScript(() => {
    let v; Object.defineProperty(window, 'CC_VERSION', { configurable: true, get() { return v; }, set(x) { v = Object.assign({}, x, { v: x.v + '-next' }); } });
  });
  await vpage.goto('http://127.0.0.1:8768/', { waitUntil: 'domcontentloaded' });
  await vpage.waitForFunction(() => window._ccOcclusion && window._ccState3d && window._ccState3d.mg, null, { timeout: 60_000 });
  const st3 = await status(vpage);
  note('(d) new app version', st3);
  if (st3.key === st1.key || st3.state !== 'pending' || !/app=[^|]*-next/.test(st3.key)) fail('(d) a new app version must start pending under a new key: ' + JSON.stringify(st3));
  await vpage.close();

  // (b) self-test overridden: the offscreen check passes and auto mode culls
  await load(page, office);
  await page.evaluate(() => { const oc = window._ccOcclusion; oc.ignoreSelfTest = true; oc.verifyBudgetMs = 10000; oc.reverify({ forget: true }); });
  const st4 = await settled(page, ['verified', 'refused']);
  note('(b) self-test overridden', st4);
  if (st4.state !== 'verified' || !st4.active) fail('(b) expected verified + active, got ' + JSON.stringify(st4));
  else await checkFrames(page, '(b) verified', [autoView('opening', ['fitAll'], true), autoView('in a room, +X', [{ interior: { angle: 0, offset: [-0.25, -0.25] } }], true), autoView('in a room, -X', [{ interior: { angle: Math.PI, offset: [0.25, 0.25] } }], true)], true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window._ccOcclusion && window._ccState3d && window._ccState3d.mg, null, { timeout: 60_000 });
  const st5 = await status(page);
  note('(d) reload after verified', st5);
  if (st5.state !== 'verified' || st5.source !== 'stored' || !st5.active) fail('(d) verified verdict did not persist: ' + JSON.stringify(st5));

  // (c) injected mismatch -> refused, culling off, refusal persists
  await load(page, office);
  await page.evaluate(() => { const oc = window._ccOcclusion; oc.ignoreSelfTest = true; oc.verifyBudgetMs = 10000; oc.injectMismatch = true; oc.reverify({ forget: true }); });
  const st6 = await settled(page, ['verified', 'refused']);
  note('(c) injected mismatch', st6);
  if (st6.state !== 'refused' || !/pixel-mismatch/.test(st6.why) || st6.active) fail('(c) expected refused/pixel-mismatch, got ' + JSON.stringify(st6));
  await page.evaluate(() => { window._ccOcclusion.injectMismatch = false; });
  await checkFrames(page, '(c) refused', [autoView('in a room, +X', [{ interior: { angle: 0, offset: [-0.25, -0.25] } }], true)], false);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window._ccOcclusion && window._ccState3d && window._ccState3d.mg, null, { timeout: 60_000 });
  const st7 = await status(page);
  note('(c) reload after refusal', st7);
  if (st7.state !== 'refused' || st7.source !== 'stored' || !/pixel-mismatch/.test(st7.why)) fail('(c) refusal did not persist: ' + JSON.stringify(st7));
  await browser.close();
  return out;
}

const report = { generatedAt: new Date().toISOString(), viewport: W + 'x' + H, scenarios: [] };
if (!ONLY || ONLY.includes('verify')) report.deviceVerification = await deviceVerification();
for (const sc of scenarios) {
  if (ONLY && !ONLY.includes(sc.name)) continue;
  const page = await newPage();
  const info = await load(page, sc.urls, sc.forceBatch);
  const gpu = await page.evaluate(() => { const gl = window._ccState3d.renderer.getContext(); const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); });
  const selfTest = await page.evaluate(async () => { const oc = window._ccOcclusion; oc.setEnabled(true); window._ccInvalidate(2); await new Promise((r) => setTimeout(r, 300)); return oc.selfTest || { ok: true, note: 'not run' }; });
  console.log(`\n== ${sc.name}: ${info.elements} elements, objects ${JSON.stringify(info.kinds)} (${gpu}), depth self-test ${JSON.stringify(selfTest)}`);
  if (sc.needKind && !info.kinds[sc.needKind]) fail(`${sc.name}: expected ${sc.needKind} objects, got ${JSON.stringify(info.kinds)}`);
  const rows = [];
  let anyCulled = false;
  for (const v of sc.views) {
    const r = await captureView(page, { ...v, ignoreSelfTest: v.ignoreSelfTest != null ? v.ignoreSelfTest : !!sc.ignoreSelfTest });
    rows.push(r);
    const st = r.stats || {};
    if (st.culled > 0) anyCulled = true;
    console.log(`${r.identical ? 'SAME' : 'DIFF'}  ${sc.name} / ${r.view}: tris on/off ${r.trianglesOn}/${r.trianglesOff}, calls ${r.callsOn}/${r.callsOff}, ` +
      (st.ran ? `culled ${st.culled}/${st.candidates} (${st.culledTris} tris), occluders ${st.occluders}/${st.occluderTris} tris, pass ${st.ms.toFixed(2)} ms (collect ${st.msCollect.toFixed(1)}, raster ${st.msRaster.toFixed(1)}, test ${st.msTest.toFixed(1)}), steady ${r.passMsSteady} ms${process.env.CC_OCCL_VERBOSE ? ' rejected ' + JSON.stringify(st.rejected) : ''}` : `pass not run (${st.why})`));
    if (!r.identical) fail(`${sc.name} / ${r.view}: culled frame differs from unculled frame in ${r.diffPx} px`);
    if (!r.identicalOnOn) fail(`${sc.name} / ${r.view}: two culled frames of the same view differ (state leak)`);
    if (r.statsOff && r.statsOff.ran) fail(`${sc.name} / ${r.view}: pass ran while disabled`);
    if (r.trianglesOn > r.trianglesOff) fail(`${sc.name} / ${r.view}: more triangles with culling on`);
    if (!st.ran && !(st.why === 'msaa-center-depth' && !selfTest.ok)) fail(`${sc.name} / ${r.view}: pass did not run (${st.why})`);
    if (st.ran && !selfTest.ok && !(v.ignoreSelfTest != null ? v.ignoreSelfTest : sc.ignoreSelfTest)) fail(`${sc.name} / ${r.view}: pass ran although the depth self-test failed`);
  }
  // Render-on-demand: at rest nothing renders, with the pass on or off.
  const idle = await page.evaluate(async () => {
    const S = window._ccState3d, oc = window._ccOcclusion, out = {};
    for (const on of [false, true]) {
      oc.setEnabled(on);
      await new Promise((r) => setTimeout(r, 1500));          // let the setEnabled invalidate drain
      const f0 = S.renderer.info.render.frame;
      await new Promise((r) => setTimeout(r, 1500));
      out[on ? 'on' : 'off'] = S.renderer.info.render.frame - f0;
    }
    return out;
  });
  console.log(`idle ${sc.name}: frames rendered in 1.5 s at rest — off ${idle.off}, on ${idle.on}`);
  if (idle.on !== 0 || idle.off !== 0) fail(`${sc.name}: frames rendered at rest (off ${idle.off}, on ${idle.on})`);
  if (sc.mustCull && !anyCulled) fail(`${sc.name}: no view culled anything — the differential is vacuous`);
  const entry = { name: sc.name, elements: info.elements, objects: info.kinds, gpu, depthSelfTest: selfTest, idleFrames: idle, views: rows.map(({ view, canvas, identical, diffPx, trianglesOn, trianglesOff, callsOn, callsOff, stats, passMsSteady }) => ({ view, canvas, identical, diffPx, trianglesOn, trianglesOff, callsOn, callsOff, stats, passMsSteady })) };
  if (sc.perf) {
    await page.evaluate((v) => { window._ccOcclusion.ignoreSelfTest = v; }, !!sc.ignoreSelfTest);
    entry.perf = await orbitPerf(page, sc.perf);
    for (const [k, v] of Object.entries(entry.perf)) console.log(`perf ${sc.name} ${k}: ${v.msMedian} ms/frame median (${v.msMean} mean), ${v.trianglesMean} tris, ${v.callsMean} calls, pass ${v.occlPassMsMean} ms x${v.occlPassRan}, culled ~${v.culledMean}`);
  }
  if (sc.detect) {
    const dc = await detectionCheck(page);
    entry.detection = dc;
    console.log(`detection ${sc.name}: ${dc.clashes} clashes, ${dc.fieldsCompared} fields compared (volatile: ${dc.volatile.join(',') || 'none'}), on vs off ${dc.identical ? 'identical' : 'DIFFERENT'}; during the run ${dc.probesDuring} pass probes + ${dc.naturalFramesDuring} rendered frames, why ${JSON.stringify(dc.whysDuringDetection)}, pass ran in ${dc.ranDuringDetection}; after the run ${JSON.stringify(dc.afterRun)}`);
    if (!dc.identical) fail(`${sc.name}: clash results differ with occlusion on vs off: ${dc.firstDiff}`);
    if (!dc.clashes) fail(`${sc.name}: detection found no clashes — comparison is vacuous`);
    if (!dc.framesDuringDetection) fail(`${sc.name}: no frame rendered during detection — cannot check the pass stands down`);
    if (dc.ranDuringDetection || dc.whysDuringDetection.some((w) => w !== 'detecting')) fail(`${sc.name}: pass did not stand down during detection: ${JSON.stringify(dc.whysDuringDetection)}`);
    if (!dc.afterRun || dc.afterRun.why === 'detecting') fail(`${sc.name}: pass still standing down after detection finished: ${JSON.stringify(dc.afterRun)}`);
  }
  report.scenarios.push(entry);
  await browser.close();
}
server.close();
if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + '\n');
if (failures) { console.error(`\nOCCLUSION FAIL — ${failures} problem(s)`); process.exit(1); }
console.log('\nOCCLUSION OK — every view pixel-identical with culling on vs off');
