#!/usr/bin/env node
// IFC grids as data, end to end in the browser: an IfcGrid loads into
// model.gridLines the same way on the worker and the main-thread fallback
// parse paths, never becomes a clashable element, draws in the grid overlay
// (toggled by the View menu's "Show grids"), and each clash is located by it
// ("Grid A-1 · Level 0") in its row and in the clash report.
//
// Fixtures (tests/fixtures/generate-synthetic-ifc.js): `grid.ifc` = walls at
// X = 0, 10, 20 plus a building grid A/B/C (X = 0, 10, 20) × 1/2 (Y = 0, 10)
// on Level 0; `walls.ifc` = walls at X = 0.2, 5.2, 10.2, so walls clash near
// grid A and grid B on both storeys.
//
// Usage: CC_CHROMIUM_EXECUTABLE=/path CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/grid-lines.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSyntheticIfc } from '../fixtures/generate-synthetic-ifc.js';
import { offlineDepsEnabled, routeOfflineDeps } from './_offline-deps.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };
const FIX = {
  '/__grid.ifc': generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 3, buildingGrid: { u: ['A', 'B', 'C'], v: ['1', '2'], spacing: 10 } }),
  '/__walls.ifc': generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 3, offsetX: 0.2 }),
};

let failed = false;
function fail(msg) { console.error('GRID FAIL: ' + msg); failed = true; }
function ok(msg) { console.log('GRID OK — ' + msg); }

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (FIX[p]) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(FIX[p]); }
    const file = normalize(join(root, p === '/' ? 'index.html' : p.slice(1)));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({
  executablePath: process.env.CC_CHROMIUM_EXECUTABLE,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];

async function newPage(forceFallback) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  if (offlineDepsEnabled()) await routeOfflineDeps(context, root);
  const page = await context.newPage();
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => errors.push(String(e)));
  if (forceFallback) await page.addInitScript(() => { window.Worker = class { constructor() { throw new Error('forced fallback for grid test'); } }; });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.mg, null, { timeout: 60_000 });
  return page;
}

async function load(page, url, name) {
  await page.evaluate(async ({ url, name }) => {
    const buf = await (await fetch(url)).arrayBuffer();
    window.ClashControl.loadFiles([new File([buf], name)]);
    const base = name.replace(/\.ifc$/i, '');
    const t0 = performance.now();
    await new Promise((resolve, reject) => {
      const iv = setInterval(() => {
        const s = window._ccLatestState, m = s && s.models.find((x) => x.name === base);
        if (m && (m.elements || []).length && !window._ccModelLoading) { clearInterval(iv); resolve(); }
        if (performance.now() - t0 > 60_000) { clearInterval(iv); reject(new Error('timed out loading ' + name)); }
      }, 50);
    });
  }, { url, name });
}

function gridReport(page) {
  return page.evaluate(() => {
    const m = window._ccLatestState.models.find((x) => x.name === 'grid');
    const lines = (m.gridLines || []).map((g) => ({ name: g.name, fam: g.fam, elev: g.elev, pts: g.pts.map((v) => Math.round(v * 1000) / 1000) }));
    const gridEls = m.elements.filter((e) => e.props && e.props.ifcType === 'IfcGrid');
    const S = window._ccState3d;
    return {
      lines,
      clashable: gridEls.filter((e) => e.meshes && e.meshes.length).length,
      overlay: { children: S.gridOverlay.children.length, visible: S.gridOverlay.visible },
    };
  });
}

try {
  const page = await newPage(false);
  let workerFellBack = false;
  page.on('console', (m) => { if (m.text().includes('[IFC Worker fallback]')) workerFellBack = true; });
  await load(page, '/__grid.ifc', 'grid.ifc');
  const w = await gridReport(page);
  if (workerFellBack) fail('worker path fell back to the main thread');
  const names = w.lines.map((l) => l.fam + ':' + l.name).sort().join(',');
  if (names !== 'U:A,U:B,U:C,V:1,V:2') fail('worker gridLines: ' + names);
  else ok('worker path: 5 grid lines, families U (A, B, C) and V (1, 2)');
  const b = w.lines.find((l) => l.name === 'B');
  if (!b || b.pts[0] !== 10 || b.pts[2] !== 10 || b.pts[1] !== 5 || b.pts[3] !== -15) fail('axis B not at scene x = 10 from z = 5 to -15: ' + JSON.stringify(b));
  else ok('axis B at scene x = 10 (IFC Y mapped to scene -z)');
  if (w.clashable) fail(w.clashable + ' IfcGrid elements carry meshes');
  if (w.overlay.children !== 10 || !w.overlay.visible) fail('overlay: ' + JSON.stringify(w.overlay));
  else ok('overlay draws 5 lines + 5 tags, visible by default');

  const fb = await newPage(true);
  await load(fb, '/__grid.ifc', 'grid.ifc');
  const f = await gridReport(fb);
  if (JSON.stringify(f.lines) !== JSON.stringify(w.lines)) fail('fallback gridLines differ from the worker: ' + JSON.stringify(f.lines));
  else ok('main-thread fallback gives the same grid lines');
  await fb.context().close();

  // View menu toggle: hides the overlay, persists, shows it again.
  const tog = await page.evaluate(async () => {
    const S = window._ccState3d, out = {};
    window._ccDispatch({ t: 'UPD_PREFS', u: { showGridLines: false } });
    await new Promise((r) => setTimeout(r, 200));
    out.hidden = !S.gridOverlay.visible; out.saved = localStorage.getItem('cc_showGridLines');
    window._ccDispatch({ t: 'UPD_PREFS', u: { showGridLines: true } });
    await new Promise((r) => setTimeout(r, 200));
    out.shown = S.gridOverlay.visible;
    return out;
  });
  if (!tog.hidden || !tog.shown || tog.saved !== 'false') fail('Show grids toggle: ' + JSON.stringify(tog));
  else ok('Show grids hides and shows the overlay, choice persisted');

  await load(page, '/__walls.ifc', 'walls.ifc');
  const det = await page.evaluate(async () => {
    const res = await window.ClashControl.runDetection({ modelA: 'all', modelB: 'all', excludeSameDiscipline: false });
    await new Promise((r) => setTimeout(r, 300));
    const st = window._ccLatestState;
    const where = st.clashes.map((c) => ({ x: Math.round(c.point[0] * 10) / 10, storey: c.elemAStorey || c.elemBStorey, grid: window._ccGridBayForPoint(c.point) }));
    return { n: (res || []).length, where };
  });
  const want = new Set(['A-1|Level 0', 'B-1|Level 0', 'A-1|Level 1', 'B-1|Level 1']);
  const got = new Set(det.where.map((c) => c.grid + '|' + c.storey));
  if (!det.n || [...want].some((k) => !got.has(k)) || got.size !== want.size) fail('clash grid positions: ' + JSON.stringify(det.where));
  else ok(det.n + ' clashes located at A-1 / B-1 on Level 0 and Level 1');

  const ui = await page.evaluate(async () => {
    window._ccDispatch({ t: 'TAB', v: 'clashes' });
    const c = window._ccLatestState.clashes.find((x) => window._ccGridBayForPoint(x.point) === 'B-1');
    window._ccDispatch({ t: 'ACTIVE', id: c.id });
    await new Promise((r) => setTimeout(r, 600));
    const text = document.body.innerText;
    let report = '';
    const open = window.open;
    window.open = () => ({ document: { open() {}, write(h) { report += h; }, close() {} }, focus() {} });
    try { window.ClashControl.clashReport(); } finally { window.open = open; }
    return { row: /Grid B-1 · Level [01]/.test(text), report: /Grid [AB]-1 · Level [01]/.test(report), reportLen: report.length };
  });
  if (!ui.row) fail('active clash row does not show "Grid B-1 · Level n"');
  else ok('clash row shows its location "Grid B-1 · Level n"');
  if (ui.reportLen && !ui.report) fail('clash report rows lack the grid location');
  else if (ui.reportLen) ok('clash report lists the grid location');
  else console.log('GRID NOTE — clash report not captured (window.open stub unused)');

  if (errors.length) fail('page errors: ' + errors.slice(0, 3).join(' | '));
} catch (e) {
  fail(e && e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? 'GRID LINES: FAIL' : 'GRID LINES: PASS');
process.exit(failed ? 1 : 0);
