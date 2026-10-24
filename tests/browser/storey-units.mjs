// Storey elevations in METRES per model (docs/INTERNALS.md §21.52), in a
// real browser:
//  * federation of a MILLIMETRE model and a METRE model of the same
//    3-storey building (tests/fixtures/generate-synthetic-ifc.js
//    {units:'mm'} vs default, side by side via offsetX):
//    - the sidebar lists Level 0/1/2 once each with the right label
//      (display unit = the first model's mm: 0 / 3000 / 6000 mm);
//    - opening the plan of Level 1 from the sidebar cuts at 3 + 1.2 m: the
//      clip plane, the cut poché height and the cut chains of BOTH models'
//      Level-1 walls (and nothing of Level 0 / Level 2);
//    - the plan banner shows the cut height (4200 mm);
//    - a sheet of Level 1 sits at 3 m and its DXF title block says
//      "Elev: 3000 mm" with geometry from both models;
//  * single-unit regressions: the mm model alone and the m model alone give
//    the same cut (4.2 m) and their own labels (3000 mm / 3.00 m).
// CC_STOREY_ROOT=/dir serves the app from another checkout (to show the
// checks fail on a build without per-model units).
//
// Run:  CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/storey-units.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { offlineDepsEnabled, routeOfflineDeps } from './_offline-deps.mjs';

const require = createRequire(import.meta.url);
const { generateSyntheticIfc } = require('../fixtures/generate-synthetic-ifc.js');
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const appRoot = process.env.CC_STOREY_ROOT || repoRoot;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

// Same building twice: 3 storeys 3 m apart, 2 walls per storey (x ∈ [-2, 12]
// for the mm model; the m model is shifted to x ∈ [28, 42]).
const FILES = {
  'bldg-mm.ifc': generateSyntheticIfc({ storeyCount: 3, wallsPerStorey: 2, units: 'mm', placeStoreys: true }),
  'bldg-m.ifc': generateSyntheticIfc({ storeyCount: 3, wallsPerStorey: 2, offsetX: 30, placeStoreys: true }),
};

let failed = false;
function fail(msg) { console.error('STOREY UNITS FAIL: ' + msg); failed = true; }
function ok(msg) { console.log('STOREY UNITS OK — ' + msg); }
const near = (a, b, tol = 1e-6) => typeof a === 'number' && Math.abs(a - b) <= tol;

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.startsWith('/__fixture/')) {
      const body = FILES[p.slice('/__fixture/'.length)];
      if (!body) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(body);
    }
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = normalize(join(appRoot, rel));
    if (!file.startsWith(normalize(appRoot))) { res.writeHead(403); return res.end(); }
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
const dialogs = [];

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  if (offlineDepsEnabled()) await routeOfflineDeps(context, repoRoot);
  const page = await context.newPage();
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.mg, null, { timeout: 60_000 });
  return page;
}

async function load(page, names) {
  for (const name of names) {
    await page.evaluate(async (name) => {
      const buf = await (await fetch('/__fixture/' + name)).arrayBuffer();
      window.ClashControl.loadFiles([new File([buf], name)]);
      const base = name.replace(/\.ifc$/i, '');
      const t0 = performance.now();
      await new Promise((resolve, reject) => {
        const iv = setInterval(() => {
          const m = window._ccLatestState.models.find((x) => x.name === base);
          if (m && (m.elements || []).length && (m.storeyData || []).length && !window._ccModelLoading) { clearInterval(iv); resolve(); }
          if (performance.now() - t0 > 60_000) { clearInterval(iv); reject(new Error('timed out loading ' + name)); }
        }, 50);
      });
    }, name);
  }
  await page.waitForTimeout(500);
}

// Sidebar "Levels" rows: [{name, label}] in display order.
function sidebarLevels(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('button[title="Open plan"], button[title="Exit plan"]')];
    return btns.map((b) => {
      const row = b.parentElement;
      const spans = [...row.querySelectorAll('span')];
      return { name: (spans[0] && spans[0].textContent || '').trim(), label: (spans[1] && spans[1].textContent || '').trim() };
    });
  });
}

// Opens the plan of `storey` from its sidebar row and reports the cut.
async function openPlan(page, storey) {
  const clicked = await page.evaluate((storey) => {
    const b = [...document.querySelectorAll('button[title="Open plan"]')].find((x) => {
      const s = x.parentElement.querySelector('span'); return s && s.textContent.trim() === storey;
    });
    if (!b) return false;
    b.click(); return true;
  }, storey);
  if (!clicked) return null;
  await page.waitForFunction(() => window._ccPlanChainsWorld && window._ccLatestState.floorPlan, null, { timeout: 15_000 });
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const S = window._ccState3d, fp = window._ccLatestState.floorPlan;
    const pl = S.renderer.clippingPlanes && S.renderer.clippingPlanes[0];
    const pc = window._ccPlanChainsWorld;
    // chains: [{pts:[x0,z0,x1,z1,…], closed, layer}] in world metres
    const xs = [];
    ((pc && pc.chains) || []).forEach((c) => { for (let i = 0; i < c.pts.length; i += 2) xs.push(c.pts[i]); });
    const banner = [...document.querySelectorAll('span')].map((s) => s.textContent).find((t) => /^3D Section:/.test(t || '')) || '';
    return {
      fpElevation: fp.elevation, clip: pl ? pl.constant : null, chainY: pc ? pc.y : null,
      nPts: xs.length, mmSide: xs.filter((x) => x < 15).length, mSide: xs.filter((x) => x > 25).length, banner,
    };
  });
}

async function closePlan(page) {
  await page.evaluate(() => window._ccDispatch({ t: 'FLOOR_PLAN', v: null }));
  await page.waitForTimeout(200);
}

// Sheet of `storey` through the storey picker's path (_ccMakeSheet with the
// level elevation the sidebar uses), then its DXF.
async function sheetDxf(page, storey) {
  const elev = await page.evaluate((storey) => {
    const fp = window._ccLatestState.floorPlan;
    return fp && fp.storeyName === storey ? fp.elevation : null;
  }, storey);
  const sheet = await page.evaluate(({ storey, elev }) => {
    const sh = window._ccMakeSheet(storey, elev);
    window._ccDispatch({ t: 'SHEET_ADD', v: sh });
    window._ccDispatch({ t: 'UNDERLAY_MODE', v: 'view2d' });
    return { elevation: sh.elevation, display: sh._storeyElevation, unit: sh._unitScale };
  }, { storey, elev });
  await page.waitForFunction(() => typeof window._ccDoExportDXF === 'function', null, { timeout: 15_000 });
  await page.waitForTimeout(500);
  const nd = dialogs.length;
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 15_000 }).catch(() => { throw new Error('no DXF download; dialogs: ' + JSON.stringify(dialogs.slice(nd))); }),
    page.evaluate(() => window._ccDoExportDXF()),
  ]);
  const txt = await readFile(await dl.path(), 'utf8');
  const elevLine = (txt.match(/Elev: [^\r\n]*/) || [''])[0];
  // x of LINE/LWPOLYLINE vertices (group code 10)
  const xs = [];
  const lines = txt.split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i++) if (lines[i].trim() === '10') xs.push(Number(lines[i + 1]));
  return { sheet, elevLine, mmSide: xs.filter((x) => x > -3 && x < 13).length, mSide: xs.filter((x) => x > 27 && x < 43).length };
}

const CUT = 3 + 1.2;
try {
  // ── mm + m federation ──
  {
    const page = await newPage();
    await load(page, ['bldg-mm.ifc', 'bldg-m.ifc']);
    const lv = await sidebarLevels(page);
    const want = [['Level 0', '0 mm'], ['Level 1', '3000 mm'], ['Level 2', '6000 mm']];
    if (JSON.stringify(lv.map((r) => [r.name, r.label])) !== JSON.stringify(want)) fail('federation sidebar levels: ' + JSON.stringify(lv));
    else ok('federation sidebar: Level 0/1/2 once each, 0 / 3000 / 6000 mm');

    const p = await openPlan(page, 'Level 1');
    if (!p) fail('no "Open plan" button for Level 1');
    else {
      if (!near(p.fpElevation, 3) || !near(p.clip, CUT) || !near(p.chainY, CUT)) fail('federation plan of Level 1 does not cut at 4.2 m: ' + JSON.stringify(p));
      else ok('federation plan of Level 1: storey at 3 m, clip + poché at 4.2 m');
      if (!p.nPts || !p.mmSide || !p.mSide) fail('federation plan of Level 1 must cut the walls of BOTH models: ' + JSON.stringify({ n: p.nPts, mm: p.mmSide, m: p.mSide }));
      else ok(`federation plan cuts both models (${p.mmSide} mm-model / ${p.mSide} m-model chain points)`);
      if (!/4200 mm/.test(p.banner)) fail('plan banner: ' + JSON.stringify(p.banner));
      else ok('plan banner: ' + p.banner);
      const d = await sheetDxf(page, 'Level 1');
      if (!near(d.sheet.elevation, 3) || d.sheet.unit !== 1000 || d.sheet.display !== 3000) fail('sheet of Level 1: ' + JSON.stringify(d.sheet));
      else ok('sheet of Level 1 at 3 m (display 3000 mm)');
      if (d.elevLine !== 'Elev: 3000 mm   Cut: 1.20 m') fail('DXF title block: ' + JSON.stringify(d.elevLine));
      else ok('DXF title block: ' + d.elevLine);
      if (!d.mmSide || !d.mSide) fail('DXF must hold both models\' Level-1 walls: ' + JSON.stringify({ mm: d.mmSide, m: d.mSide }));
      else ok('DXF holds geometry of both models');
    }
    await page.context().close();
  }
  // ── single-unit regressions ──
  for (const [file, labels] of [['bldg-mm.ifc', ['0 mm', '3000 mm', '6000 mm']], ['bldg-m.ifc', ['0.00 m', '3.00 m', '6.00 m']]]) {
    const page = await newPage();
    await load(page, [file]);
    const lv = await sidebarLevels(page);
    if (JSON.stringify(lv.map((r) => r.label)) !== JSON.stringify(labels)) fail(file + ' sidebar labels: ' + JSON.stringify(lv));
    else ok(file + ' alone: labels ' + labels.join(' / '));
    const p = await openPlan(page, 'Level 1');
    if (!p || !near(p.clip, CUT) || !near(p.chainY, CUT) || !p.nPts) fail(file + ' alone: plan of Level 1 ' + JSON.stringify(p));
    else ok(file + ' alone: plan of Level 1 cuts at 4.2 m');
    const d = await sheetDxf(page, 'Level 1');
    const wantLine = 'Elev: ' + labels[1] + '   Cut: 1.20 m';
    if (d.elevLine !== wantLine) fail(file + ' alone: DXF title ' + JSON.stringify(d.elevLine));
    else ok(file + ' alone: DXF ' + d.elevLine);
    await closePlan(page);
    await page.context().close();
  }
  if (errors.length) fail('page errors: ' + errors.slice(0, 5).join(' | '));
} catch (e) {
  fail(String(e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (failed) { console.error('STOREY UNITS: FAILED'); process.exit(1); }
console.log('STOREY UNITS: all checks passed');
