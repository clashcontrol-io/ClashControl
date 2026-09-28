#!/usr/bin/env node
// ── Viewer navigation diagnostic (NOT wired into CI) ──────────────────────
//
// This is a DIAGNOSTIC tool, not a pass/fail test: it drives the real
// OrbitControls-equivalent viewer in headless Chromium the way a human
// would (mouse drags with eased motion, wheel notches, middle/right-button
// drags) and prints numeric navigation-feel metrics, so a person can eyeball
// whether the viewer's camera behavior is healthy before/after a change to
// the fly-to/orbit/pan/zoom code (index.html's "Orbit Controls (inline)"
// section, docs/INTERNALS.md §13). It exits 0 regardless of the numbers —
// viewer navigation fixes are a separate, later piece of work; wiring a
// pass/fail threshold into CI is deliberately deferred until then.
//
// Reads as: `R.<letter>_<name>` = one probe. The metrics this task asked
// for map onto these fields:
//   - pivot jump on first drag after click:
//       R.B_clickThenDrag.viewDirJumpOn1pxDrag_deg (compare to
//       .expectedFor1px_deg — a healthy viewer's first-pixel drag should
//       change view direction by roughly the expected per-pixel amount,
//       not snap by many degrees because the pivot silently moved on click)
//   - zoom anchor drift:
//       R.D_wheelZoom.anchorDriftPxPerNotch (screen-space drift, in px, of
//       the world point under the cursor across 10 wheel notches — should
//       stay near 0 if zoom is anchored under the cursor)
//   - pan ratio:
//       R.F_pan.grabbedPointMovedPx vs mouseMovedPx (and the zoomed-in
//       variant) — a 1:1 pan keeps the grabbed world point under the cursor
//       regardless of zoom level; screen-space panning is done right when
//       these two numbers match, especially when zoomed in
//   - inertia:
//       R.A_orbitDrag.cameraMovementAfterRelease_m — how far the camera
//       keeps moving after mouseup; 0 means no inertia/momentum
//
// Also reported: frame interval / theta-step-per-frame during a drag (jank
// detection), DPR during vs. after drag (a stale/wrong pixel ratio during
// interaction is a common render-quality regression), vertical-orbit phi
// clamp behavior, and wheel/mousemove handler cost in ms.
//
// Usage:
//   CC_CHROMIUM_EXECUTABLE=/path/to/chromium node tests/browser/viewer-nav-probe.mjs [outDir]
// outDir (default: tests/browser/_nav-probe-out, gitignored-by-convention —
// delete it after reading) gets 5 PNG screenshots at each probe stage plus
// nav-probe-report.json with the full R object this script prints to stdout.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { generate } from '../fixtures/generate-office-ifc.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const OUT = process.argv[2] || join(root, 'tests', 'browser', '_nav-probe-out');
await mkdir(OUT, { recursive: true });

// A denser fixture than the committed office pair (more storeys -> more
// elements on screen), generated on the fly so this diagnostic never needs
// its own committed binary/geometry fixture.
const { architecture } = generate({ nlev: 10, seed: 1337 });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
const server = createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    const body = p === '/__model.ifc' ? architecture : await readFile(normalize(join(root, p === '/' ? 'index.html' : p.slice(1))));
    res.writeHead(200, { 'Content-Type': MIME[extname(p === '/' ? 'x.html' : p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  executablePath: process.env.CC_CHROMIUM_EXECUTABLE,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

if (process.env.CC_BROWSER_OFFLINE_DEPS === '1') {
  const local = async (route, file, ct) => route.fulfill({
    status: 200, body: await readFile(join(root, 'node_modules', file)),
    headers: { 'content-type': ct || 'text/javascript', 'access-control-allow-origin': '*' },
  });
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
  await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.worker.min.js'));
  await ctx.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', (r) => local(r, 'three/' + new URL(r.request().url()).pathname.split('/three@0.180.0/')[1]));
  await ctx.route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', (r) => {
    const s = new URL(r.request().url()).pathname.split('/web-ifc@0.0.77/')[1];
    return local(r, 'web-ifc/' + s, s.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  });
  await ctx.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/css' }));
  await ctx.route('https://fonts.gstatic.com/**', (r) => r.abort());
  await ctx.route('https://gc.zgo.at/**', (r) => r.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
}

const page = await ctx.newPage();
page.on('dialog', (d) => d.accept());
await page.addInitScript(() => { try { localStorage.setItem('cc_privacy_consent', 'denied'); } catch (e) {} });
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 120_000 });
await page.evaluate(async () => {
  const b = await (await fetch('/__model.ifc')).arrayBuffer();
  window.ClashControl.loadFiles([new File([b], 'model.ifc')]);
});
await page.waitForFunction(() => {
  const s = window._ccLatestState;
  return s && s.models.length === 1 && (s.models[0].elements || []).length > 10;
}, null, { timeout: 180_000 });
await page.waitForTimeout(3000);
await page.getByText('No thanks').click({ timeout: 3000 }).catch(() => {});
await page.waitForTimeout(300);

const R = {};
R.elements = await page.evaluate(() => window._ccLatestState.models[0].elements.length);

await page.evaluate(() => {
  const S = window._ccState3d;
  window.__cam = () => {
    const c = S.camera, o = S.orbit;
    const d = c.getWorldDirection(new c.position.constructor());
    return { px: c.position.x, py: c.position.y, pz: c.position.z, dx: d.x, dy: d.y, dz: d.z, tx: o.target.x, ty: o.target.y, tz: o.target.z, r: o.sph.r, phi: o.sph.phi, theta: o.sph.theta, dpr: S.renderer.getPixelRatio(), ux: c.up.x, uy: c.up.y, uz: c.up.z };
  };
  window.__frames = []; window.__recording = false;
  (function loop(t) { if (window.__recording) window.__frames.push(Object.assign({ t: performance.now() }, window.__cam())); requestAnimationFrame(loop); })();
  window.__rec = (on) => { if (on) { window.__frames = []; } window.__recording = on; return window.__frames; };
  window.__proj = (x, y, z) => {
    const c = S.camera;
    const v = new c.position.constructor(x, y, z).project(c);
    const el = S.renderer.domElement.getBoundingClientRect();
    return { sx: el.left + (v.x + 1) / 2 * el.width, sy: el.top + (1 - v.y) / 2 * el.height, inFront: v.z < 1 };
  };
  window.__canvas = () => { const r = S.renderer.domElement.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; };
  window.__bboxOnScreen = () => {
    const b = window._ccViewport.getBounds();
    if (!b) return null;
    const cs = [];
    for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) cs.push(window.__proj(x, y, z));
    const cv = window.__canvas();
    const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    const c = window.__proj(cx, cy, cz);
    return { centerOnCanvas: c.sx >= cv.l && c.sx <= cv.l + cv.w && c.sy >= cv.t && c.sy <= cv.t + cv.h, center: [Math.round(c.sx), Math.round(c.sy)], cornersVisible: cs.filter((p) => p.inFront && p.sx >= cv.l && p.sx <= cv.l + cv.w && p.sy >= cv.t && p.sy <= cv.t + cv.h).length };
  };
  window.__wheelCost = []; let _ws = 0;
  window.addEventListener('wheel', () => { _ws = performance.now(); }, { capture: true, passive: true });
  window.addEventListener('wheel', () => { window.__wheelCost.push(performance.now() - _ws); }, { passive: true });
  window.__mmCost = []; let _ms = 0;
  window.addEventListener('mousemove', () => { _ms = performance.now(); }, { capture: true, passive: true });
  window.addEventListener('mousemove', () => { window.__mmCost.push(performance.now() - _ms); }, { passive: true });
});

const cv = await page.evaluate(() => window.__canvas());
R.canvas = cv;
const cx = Math.round(cv.l + cv.w / 2), cy = Math.round(cv.t + cv.h / 2);
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
const sleep = (ms) => page.waitForTimeout(ms);
const fit = async () => { await page.keyboard.press('Escape'); await page.evaluate(() => { try { window._ccViewport.fitAll(); } catch (e) {} }); await sleep(1200); };
function stats(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: a.length, mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), p50: +q(.5).toFixed(2), p95: +q(.95).toFixed(2), max: +s[s.length - 1].toFixed(2) };
}
const ang = (a, b) => +(Math.acos(Math.max(-1, Math.min(1, a.dx * b.dx + a.dy * b.dy + a.dz * b.dz))) * 180 / Math.PI).toFixed(2);

await shot('00-loaded');
R.initialBBox = await page.evaluate(() => window.__bboxOnScreen());

// A) human orbit drag: 1.2s ease-in-out horizontal arc, then release; record 1s after release
await page.mouse.move(cx, cy); await sleep(100);
const c0 = await page.evaluate(() => window.__cam());
await page.evaluate(() => window.__rec(true));
await page.mouse.down();
const dprAfterDown = await page.evaluate(() => window._ccState3d.renderer.getPixelRatio());
for (let i = 1; i <= 72; i++) {
  const t = i / 72; const e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  await page.mouse.move(cx + Math.round(e * 300), cy + Math.round(Math.sin(t * Math.PI) * 40)); await sleep(16);
}
const tRelease = await page.evaluate(() => performance.now());
await page.mouse.up(); await sleep(1000);
let fr = await page.evaluate(() => window.__rec(false));
const after = fr.filter((f) => f.t > tRelease);
const moved = after.length > 1 ? Math.hypot(after.at(-1).px - after[0].px, after.at(-1).py - after[0].py, after.at(-1).pz - after[0].pz) : 0;
const dts = fr.slice(1).map((f, i) => f.t - fr[i].t);
const steps = fr.filter((f) => f.t <= tRelease).slice(1).map((f, i, arr) => Math.abs(f.theta - (i ? arr[i - 1].theta : fr[0].theta)));
R.A_orbitDrag = {
  dprIdle: c0.dpr, dprDuringDrag: dprAfterDown, dprAfterRelease: (await page.evaluate(() => window.__cam())).dpr,
  frameInterval: stats(dts), thetaStepPerFrame: stats(steps.filter((s) => s > 0)), framesWithNoCameraChangeDuringDrag: steps.filter((s) => s === 0).length,
  cameraMovementAfterRelease_m: +moved.toFixed(4), totalThetaDeg: +((fr.at(-1).theta - c0.theta) * 180 / Math.PI).toFixed(1),
  radPerPx: +((fr.at(-1).theta - c0.theta) / 300).toFixed(5), mousemoveHandler_ms: stats(await page.evaluate(() => window.__mmCost.splice(0))),
};
await shot('01-after-orbit');

// B) plain click on model (no drag): does camera move / fly? does pivot jump on next drag?
await fit();
const hitPt = await page.evaluate(() => { const b = window._ccViewport.getBounds(); return window.__proj(b.min[0] + (b.max[0] - b.min[0]) * 0.15, (b.min[1] + b.max[1]) / 2, b.max[2]); });
const clickX = Math.round(hitPt.sx), clickY = Math.round(hitPt.sy);
const beforeClick = await page.evaluate(() => window.__cam());
await page.mouse.click(clickX, clickY); await sleep(1500);
const afterClick = await page.evaluate(() => window.__cam());
await page.mouse.move(clickX, clickY); await page.mouse.down(); await page.mouse.move(clickX + 1, clickY); await sleep(80);
const after1px = await page.evaluate(() => window.__cam()); await page.mouse.up();
R.B_clickThenDrag = {
  cameraMovedByClick_m: +Math.hypot(afterClick.px - beforeClick.px, afterClick.py - beforeClick.py, afterClick.pz - beforeClick.pz).toFixed(3),
  viewDirChangeByClick_deg: ang(beforeClick, afterClick), pivotMovedByClick_m: +Math.hypot(afterClick.tx - beforeClick.tx, afterClick.ty - beforeClick.ty, afterClick.tz - beforeClick.tz).toFixed(3),
  viewDirJumpOn1pxDrag_deg: ang(afterClick, after1px), expectedFor1px_deg: +(0.007 * 180 / Math.PI).toFixed(2),
};
await shot('02-after-click-1px');

// C) pivot: zoom toward a corner then orbit -> does model swing off-screen?
await fit();
const corner = await page.evaluate(() => { const b = window._ccViewport.getBounds(); return window.__proj(b.max[0], (b.min[1] + b.max[1]) / 2, b.max[2]); });
await page.mouse.move(Math.round(corner.sx), Math.round(corner.sy));
for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -100); await sleep(60); }
await sleep(300);
const beforeOrbitC = await page.evaluate(() => ({ cam: window.__cam(), bb: window.__bboxOnScreen() }));
await page.mouse.down();
for (let i = 1; i <= 30; i++) { await page.mouse.move(Math.round(corner.sx) + i * 5, Math.round(corner.sy)); await sleep(16); }
await page.mouse.up(); await sleep(300);
R.C_orbitAfterZoomToCorner = {
  before: beforeOrbitC.bb, after: await page.evaluate(() => window.__bboxOnScreen()),
  pivotScreen: await page.evaluate(() => { const c = window.__cam(); return window.__proj(c.tx, c.ty, c.tz); }), cursor: [Math.round(corner.sx) + 150, Math.round(corner.sy)],
};
await shot('03-orbit-after-corner-zoom');

// D) wheel zoom anchor stability + reversibility
await fit();
const tgt = await page.evaluate(() => { const b = window._ccViewport.getBounds(); return { w: [b.min[0] + (b.max[0] - b.min[0]) * 0.3, (b.min[1] + b.max[1]) / 2, b.max[2]] }; });
const p0 = await page.evaluate((w) => window.__proj(...w), tgt.w);
await page.mouse.move(Math.round(p0.sx), Math.round(p0.sy));
const z0 = await page.evaluate(() => window.__cam());
const drift = [];
for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, -100); await sleep(50); const p = await page.evaluate((w) => window.__proj(...w), tgt.w); drift.push(Math.round(Math.hypot(p.sx - p0.sx, p.sy - p0.sy))); }
const zIn = await page.evaluate(() => window.__cam());
for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 100); await sleep(50); }
const zOut = await page.evaluate(() => window.__cam());
R.D_wheelZoom = {
  anchorDriftPxPerNotch: drift, cameraDistanceBackToStart_m: +Math.hypot(zOut.px - z0.px, zOut.py - z0.py, zOut.pz - z0.pz).toFixed(3),
  pivotDriftAfterInOut_m: +Math.hypot(zOut.tx - z0.tx, zOut.ty - z0.ty, zOut.tz - z0.tz).toFixed(3), r: [+z0.r.toFixed(2), +zIn.r.toFixed(2), +zOut.r.toFixed(2)],
  wheelHandler_ms: stats(await page.evaluate(() => window.__wheelCost.splice(0))),
};
await page.evaluate(() => window.__rec(true)); await page.mouse.wheel(0, -100); await sleep(400);
fr = await page.evaluate(() => window.__rec(false));
R.D_wheelZoom.framesOverWhichOneNotchIsApplied = new Set(fr.map((f) => f.px.toFixed(5))).size;
await page.evaluate(() => window.__rec(true));
for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, -4); await sleep(8); }
await sleep(200);
fr = await page.evaluate(() => window.__rec(false));
R.D_wheelZoom.trackpad40x4px_rChange = +(fr[0].r - fr.at(-1).r).toFixed(3);
const bx = await page.evaluate(() => window.__cam()); await page.mouse.wheel(120, 0); await sleep(200);
const ax = await page.evaluate(() => window.__cam());
R.D_wheelZoom.horizontalScrollMovesCamera_m = +Math.hypot(ax.px - bx.px, ax.py - bx.py, ax.pz - bx.pz).toFixed(4);

// E) top-view clamp: drag straight down a lot
await fit();
await page.mouse.move(cx, cy); await page.evaluate(() => window.__rec(true)); await page.mouse.down();
for (let i = 1; i <= 60; i++) { await page.mouse.move(cx, cy + i * 10); await sleep(16); }
await page.mouse.up(); await sleep(200);
fr = await page.evaluate(() => window.__rec(false));
const minPhi = Math.min(...fr.map((f) => f.phi)), maxPhi = Math.max(...fr.map((f) => f.phi));
R.E_verticalOrbit = { phiRangeDeg: [+(minPhi * 180 / Math.PI).toFixed(1), +(maxPhi * 180 / Math.PI).toFixed(1)], framesStuckAtClamp: fr.filter((f) => Math.abs(f.phi - minPhi) < 1e-6 || Math.abs(f.phi - maxPhi) < 1e-6).length, totalFrames: fr.length };
await shot('04-vertical-clamp');

// F) middle-button pan: does the grabbed world point stay under the cursor?
await fit();
const gp = await page.evaluate(() => { const c = window.__cam(); return [c.tx, c.ty, c.tz]; });
const g0 = await page.evaluate((w) => window.__proj(...w), gp);
await page.mouse.move(Math.round(g0.sx), Math.round(g0.sy)); await page.mouse.down({ button: 'middle' });
for (let i = 1; i <= 20; i++) { await page.mouse.move(Math.round(g0.sx) + i * 10, Math.round(g0.sy)); await sleep(16); }
await page.mouse.up({ button: 'middle' }); await sleep(200);
const g1 = await page.evaluate((w) => window.__proj(...w), gp);
R.F_pan = { mouseMovedPx: 200, grabbedPointMovedPx: Math.round(Math.hypot(g1.sx - g0.sx, g1.sy - g0.sy)) };
for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, -100); await sleep(40); }
const gp2 = await page.evaluate(() => { const c = window.__cam(); return [c.tx, c.ty, c.tz]; });
const h0 = await page.evaluate((w) => window.__proj(...w), gp2);
await page.mouse.move(Math.round(h0.sx), Math.round(h0.sy)); await page.mouse.down({ button: 'middle' });
for (let i = 1; i <= 20; i++) { await page.mouse.move(Math.round(h0.sx) + i * 10, Math.round(h0.sy)); await sleep(16); }
await page.mouse.up({ button: 'middle' }); await sleep(200);
const h1 = await page.evaluate((w) => window.__proj(...w), gp2);
R.F_pan.zoomedIn_grabbedPointMovedPx = Math.round(Math.hypot(h1.sx - h0.sx, h1.sy - h0.sy));
R.F_pan.zoomedIn_r = +(await page.evaluate(() => window.__cam().r)).toFixed(2);

// G) right-click drag (common pan in Navisworks/Solibri/BIMcollab)
const rb = await page.evaluate(() => window.__cam());
await page.mouse.move(cx, cy); await page.mouse.down({ button: 'right' });
for (let i = 1; i <= 10; i++) { await page.mouse.move(cx + i * 10, cy); await sleep(16); }
await page.mouse.up({ button: 'right' }); await sleep(300);
const ra = await page.evaluate(() => window.__cam());
R.G_rightDrag_cameraMoved_m = +Math.hypot(ra.px - rb.px, ra.py - rb.py, ra.pz - rb.pz).toFixed(4);
R.G_contextMenuOpen = await page.evaluate(() => !!document.querySelector('[role=menu],.cc-context-menu'));
await page.keyboard.press('Escape');

// H) double-click on element
await fit();
const db = await page.evaluate(() => window.__cam());
await page.mouse.dblclick(clickX, clickY); await sleep(1500);
const da = await page.evaluate(() => window.__cam());
R.H_doubleClick = { cameraMoved_m: +Math.hypot(da.px - db.px, da.py - db.py, da.pz - db.pz).toFixed(3), viewDirChange_deg: ang(db, da) };

await writeFile(`${OUT}/nav-probe-report.json`, JSON.stringify(R, null, 1));
console.log(JSON.stringify(R, null, 1));
console.log('\n(screenshots + nav-probe-report.json written to ' + OUT + ')');

await browser.close();
server.close();
