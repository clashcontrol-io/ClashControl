#!/usr/bin/env node
// Grouping v2 in the browser (docs/INTERNALS.md §21.61): the clash list
// grouped by grid intersection, by room, by property value and by location
// with an adjustable radius, levels combined in order, driven through the
// grouping row's selects; the property picker lists the Pset.Name properties
// of the clashing elements; the triage facets carry 'grid' and 'space'.
//
// Fixtures (tests/fixtures/generate-synthetic-ifc.js): `grid.ifc` = walls at
// X = 0, 10, 20, a building grid A/B/C (X = 0, 10, 20) × 1/2 (Y = 0, 10), one
// room per storey around the walls and Pset_WallCommon.FireRating on every
// wall; `walls.ifc` = walls at X = 0.2, 5.2, 10.2 — the walls clash near grid
// A and grid B on both storeys, inside the rooms.
//
// Usage: CC_CHROMIUM_EXECUTABLE=/path CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/grouping-v2.mjs
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
  '/__grid.ifc': generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 3, placeStoreys: true, withSpaces: true, withPsets: true, buildingGrid: { u: ['A', 'B', 'C'], v: ['1', '2'], spacing: 10 } }),
  '/__walls.ifc': generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 3, placeStoreys: true, offsetX: 0.2 }),
};

let failed = false;
function fail(msg) { console.error('GROUPING FAIL: ' + msg); failed = true; }
function ok(msg) { console.log('GROUPING OK — ' + msg); }
async function axe(page, label, include) {
  await page.addScriptTag({ path: join(root, 'node_modules/axe-core/axe.min.js') }).catch(() => {});
  const res = await page.evaluate(async (sel) => {
    if (!window.axe) return null;
    const r = await window.axe.run({ include: sel.map((s) => [s]) }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
    return r.violations.map((v) => ({ id: v.id, n: v.nodes.length, sample: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }));
  }, include);
  if (res == null) console.log('GROUPING NOTE — axe-core not installed, a11y check skipped');
  else if (res.length) fail('axe (' + label + '): ' + JSON.stringify(res));
  else ok('axe (' + label + '): 0 violations on ' + include.join(', '));
}

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

// The list's current groups: [label, [clash ids]] (window.__ccListGroups, ?ccRenderCount=1).
function listGroups(page) {
  return page.evaluate(() => {
    const g = window.__ccListGroups;
    return g && g.groups ? g.groups.map((x) => [x.label, x.items.map((c) => c.id)]) : null;
  });
}
async function waitGroups(page, pred, what) {
  for (let i = 0; i < 100; i++) {
    const g = await listGroups(page);
    if (g && pred(g)) return g;
    await page.waitForTimeout(100);
  }
  const g = await listGroups(page);
  fail(what + ': ' + JSON.stringify(g));
  return g;
}

try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  if (offlineDepsEnabled()) await routeOfflineDeps(context, root);
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: 'reduce' }); // theme switches settle at once (axe)
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => { try { localStorage.setItem('cc_preRunDontAsk', 'true'); } catch (e) {} });
  await page.goto(`http://127.0.0.1:${port}/?ccRenderCount=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.mg, null, { timeout: 60_000 });
  await load(page, '/__grid.ifc', 'grid.ifc');
  await load(page, '/__walls.ifc', 'walls.ifc');
  // the grid model's psets arrive lazily: wait for them
  await page.waitForFunction(() => {
    const m = window._ccLatestState.models.find((x) => x.name === 'grid');
    return m && m.elements.some((e) => e.props && e.props.psets && e.props.psets.Pset_WallCommon);
  }, null, { timeout: 60_000 });

  const det = await page.evaluate(async () => {
    const res = await window.ClashControl.runDetection({ modelA: 'all', modelB: 'all', excludeSameDiscipline: false });
    await new Promise((r) => setTimeout(r, 300));
    window._ccDispatch({ t: 'TAB', v: 'clashes' });
    // every clash listed (no review-bucket narrowing), flat "All" view first
    window._ccDispatch({ t: 'UPD_FILTERS', u: { showBuckets: ['review', 'contact', 'graze', 'adjacent', 'embedded', 'finish', 'twice', 'handled', 'zone', 'provision', 'provided', 'openshape', 'penetration', 'fitting'] } });
    window._ccDispatch({ t: 'CLASH_GROUP_BY', v: [] });
    await new Promise((r) => setTimeout(r, 400));
    const st = window._ccLatestState;
    return { n: (res || []).length, ids: st.clashes.map((c) => c.id), grid: st.clashes.map((c) => window._ccGridBayForPoint(c.point)) };
  });
  if (!det.n) throw new Error('no clashes detected');
  ok(det.n + ' clashes at ' + [...new Set(det.grid)].sort().join(' / '));
  const wantGrid = [...new Set(det.grid)].map((g) => 'Grid ' + g).sort();

  // ── level 1 = grid, through the grouping row's select ──
  await page.waitForSelector('[data-cc-group-level="0"]', { timeout: 20_000 });
  await page.selectOption('[data-cc-group-level="0"]', 'grid');
  let g = await waitGroups(page, (x) => x.length && x.every((e) => /^Grid /.test(e[0])), 'group by grid');
  const gotGrid = g.map((e) => e[0]).sort();
  if (JSON.stringify(gotGrid) !== JSON.stringify(wantGrid)) fail('grid groups ' + JSON.stringify(gotGrid) + ' != ' + JSON.stringify(wantGrid));
  else ok('grouped by grid intersection: ' + gotGrid.join(', '));
  const sumIds = (x) => x.reduce((a, e) => a + e[1].length, 0);
  if (sumIds(g) !== det.ids.length) fail('grid groups hold ' + sumIds(g) + ' of ' + det.ids.length + ' clashes');
  const persisted = await page.evaluate(() => localStorage.getItem('cc_clashGroupBy'));
  if (persisted !== '["grid"]') fail('clashGroupBy not persisted: ' + persisted);
  // a header shows the location value
  const headerText = await page.evaluate(() => document.body.innerText);
  if (g.some((e) => e[1].length > 1) && !wantGrid.some((w) => headerText.includes(w))) fail('no group header shows a grid label');
  else ok('group headers show the grid label');

  // ── then by room ──
  await page.selectOption('[data-cc-group-level="1"]', 'space');
  g = await waitGroups(page, (x) => x.length && x.every((e) => / │ /.test(e[0])), 'group by grid then room');
  const rooms = [...new Set(g.map((e) => e[0].split(' │ ')[1]))].sort();
  if (JSON.stringify(rooms) !== JSON.stringify(['Room 0.01', 'Room 1.01'])) fail('rooms ' + JSON.stringify(rooms));
  else ok('levels combine in order: "' + g[0][0] + '" … rooms ' + rooms.join(', '));
  if (sumIds(g) !== det.ids.length) fail('grid × room groups hold ' + sumIds(g) + ' clashes');

  // ── room alone (drop level 1 = grid) ──
  await page.selectOption('[data-cc-group-level="0"]', 'none');
  g = await waitGroups(page, (x) => x.length && x.every((e) => /^Room /.test(e[0])), 'group by room');
  ok('grouped by room: ' + g.map((e) => e[0] + ' (' + e[1].length + ')').join(', '));
  // every clash is in the room whose box holds its point (Room s.01 spans storey s)
  const where = await page.evaluate((groups) => {
    const byId = new Map(window._ccLatestState.clashes.map((c) => [c.id, c]));
    return groups.map(([label, ids]) => [label, ids.map((id) => Math.floor(byId.get(id).point[1] / 3 + 1e-6))]);
  }, g);
  if (!where.every(([label, ys]) => ys.every((s) => label === 'Room ' + Math.min(s, 1) + '.01'))) fail('clash heights vs rooms: ' + JSON.stringify(where));

  // ── property picker: lists Pset.Name of the clashing elements, picks one ──
  await page.selectOption('[data-cc-group-level="0"]', 'property');
  await page.waitForSelector('[data-cc-group-prop-select]', { timeout: 10_000 });
  const names = await page.evaluate(() => [...document.querySelectorAll('[data-cc-group-prop-select] option')].map((o) => o.value).filter(Boolean));
  if (!names.includes('Pset_WallCommon.FireRating')) fail('property picker: ' + JSON.stringify(names));
  else ok('property picker lists ' + names.length + ' properties incl. Pset_WallCommon.FireRating');
  await page.selectOption('[data-cc-group-prop-select]', 'Pset_WallCommon.FireRating');
  g = await waitGroups(page, (x) => x.length === 1 && x[0][0] === '60min', 'group by Pset_WallCommon.FireRating');
  if (g && g.length === 1 && g[0][1].length === det.ids.length) ok('grouped by property value: "60min" holds every clash (side A, else side B)');
  const picker = await page.$('[data-cc-group-prop-picker]');
  if (picker) fail('property picker still open after a pick');

  // ── location (nearby) with an adjustable radius ──
  await page.selectOption('[data-cc-group-level="0"]', 'nearby');
  g = await waitGroups(page, (x) => x.length && x.every((e) => /^Area /.test(e[0])), 'group by location');
  const nDefault = g.length;
  await page.waitForSelector('[data-cc-nearby-radius]');
  await page.fill('[data-cc-nearby-radius]', '30');
  await page.press('[data-cc-nearby-radius]', 'Enter');
  g = await waitGroups(page, (x) => x.length === 1, 'location radius 30 m → one area');
  const pref = await page.evaluate(() => ({ s: window._ccLatestState.prefs.nearbyRadiusM, ls: localStorage.getItem('cc_nearbyRadiusM') }));
  if (pref.s !== 30 || pref.ls !== '30') fail('nearbyRadiusM pref: ' + JSON.stringify(pref));
  else ok('location radius 1.5 m → ' + nDefault + ' areas, 30 m → 1 area (pref saved)');

  // ── a11y of the grouping row: level selects, radius input, open property picker (light + dark) ──
  await page.selectOption('[data-cc-group-level="1"]', 'property');
  await page.waitForSelector('[data-cc-group-prop-select]', { timeout: 10_000 });
  await axe(page, 'light', ['[data-cc-grouping]']);
  await page.evaluate(() => window._ccDispatch({ t: 'UPD_PREFS', u: { theme: 'dark' } }));
  await page.waitForTimeout(300);
  await axe(page, 'dark', ['[data-cc-grouping]']);
  await page.evaluate(() => window._ccDispatch({ t: 'UPD_PREFS', u: { theme: 'light' } }));
  await page.press('[data-cc-group-prop-select]', 'Escape');
  await page.waitForTimeout(200);
  const grpAfter = await page.evaluate(() => JSON.stringify(window._ccLatestState.clashGroupBy));
  if (await page.$('[data-cc-group-prop-picker]')) fail('Escape does not close the property picker');
  else if (grpAfter !== '["nearby"]') fail('the cancelled picker changed the grouping: ' + grpAfter);
  else ok('Escape closes the property picker without changing the grouping');

  // ── grid / room facets ──
  const fac = await page.evaluate(() => {
    const st = window._ccLatestState;
    const f = window.__ccReference.facets(st);
    return { grid: f.grid, space: f.space };
  });
  const fg = Object.keys(fac.grid || {}).sort(), fs = Object.keys(fac.space || {}).sort();
  if (JSON.stringify(fg) !== JSON.stringify(wantGrid.map((w) => w.slice(5)))) fail('grid facet values ' + JSON.stringify(fac.grid));
  else if (JSON.stringify(fs) !== JSON.stringify(['Room 0.01', 'Room 1.01'])) fail('room facet values ' + JSON.stringify(fac.space));
  else ok('facets: grid ' + JSON.stringify(fac.grid) + ', room ' + JSON.stringify(fac.space));

  if (errors.length) fail('page errors: ' + errors.slice(0, 3).join(' | '));
} catch (e) {
  fail(e && e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}
console.log(failed ? 'GROUPING V2: FAIL' : 'GROUPING V2: PASS');
process.exit(failed ? 1 : 0);
