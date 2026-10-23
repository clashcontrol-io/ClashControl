#!/usr/bin/env node
// Real-browser check for IfcSpace (rooms): spaces load WITH geometry on both
// the worker and the main-thread fallback parse paths, are hidden by default,
// the "Show spaces" toggle (toolbar Style menu) shows them, a wall inside a
// room stays pickable while they're shown, an empty spot inside a room picks
// the room, default detection ignores them (same clash count as the same
// model without spaces) while rules.includeSpaces brings space clashes in,
// and the floor-plan cut never draws them.
//
// Fixture: tests/fixtures/generate-synthetic-ifc.js with {withSpaces:true}
// (one room per storey enclosing every wall of that storey).
//
// Optional: CC_SPACES_FILE=/path/to/any.ifc additionally loads a local IFC
// that contains IfcSpace entities (never committed) and reports: IfcSpace
// count in the file vs. spaces loaded with geometry, hidden-by-default,
// toggle, a pick from inside a room, and the load time. Set
// CC_SPACES_FILE_FALLBACK=1 to also load it through the main-thread fallback.
// CC_SPACES_ROOT=/dir serves the app from another checkout (e.g. a baseline
// build) for load-time comparisons; with CC_SPACES_TIMING_ONLY=1 only the
// timing of CC_SPACES_FILE is measured (works against builds without spaces).
//
// Usage: CC_CHROMIUM_EXECUTABLE=/path CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/spaces.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSyntheticIfc } from '../fixtures/generate-synthetic-ifc.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appRoot = process.env.CC_SPACES_ROOT || repoRoot;
const offline = process.env.CC_BROWSER_OFFLINE_DEPS === '1';
const extFile = process.env.CC_SPACES_FILE || null;
const timingOnly = process.env.CC_SPACES_TIMING_ONLY === '1';
const generatedDir = join(repoRoot, 'tests', 'fixtures', '_generated-spaces');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };

let failed = false;
function fail(msg) { console.error('SPACES FAIL: ' + msg); failed = true; }
function ok(msg) { console.log('SPACES OK — ' + msg); }

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/__cc_external.ifc' && extFile) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      return res.end(await readFile(extFile));
    }
    const base = p.startsWith('/tests/fixtures/_generated-spaces/') ? repoRoot : appRoot;
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = normalize(join(base, rel));
    if (!file.startsWith(normalize(base))) { res.writeHead(403); return res.end(); }
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

async function newPage() {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  if (offline) {
    const local = async (route, file, ct) => route.fulfill({
      status: 200, body: await readFile(join(repoRoot, 'node_modules', file)),
      headers: { 'content-type': ct || 'text/javascript', 'access-control-allow-origin': '*' },
    });
    const ctx = page.context();
    await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
    await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
    await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
    await ctx.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
    await ctx.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', async (route) => {
      const suffix = new URL(route.request().url()).pathname.split('/three@0.180.0/')[1];
      await local(route, 'three/' + suffix);
    });
    await ctx.route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', async (route) => {
      const suffix = new URL(route.request().url()).pathname.split('/web-ifc@0.0.77/')[1];
      await local(route, 'web-ifc/' + suffix, suffix.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    });
    await ctx.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/css' }));
    await ctx.route('https://fonts.gstatic.com/**', (route) => route.abort());
    await ctx.route('https://gc.zgo.at/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  }
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.mg, null, { timeout: 60_000 });
  return page;
}

// Loads `url` as `name` (optionally through the main-thread fallback) and
// waits until the model is in state and the loading strip has settled.
async function load(page, url, name, forceFallback, timeoutMs) {
  return page.evaluate(async ({ url, name, forceFallback, timeoutMs }) => {
    if (forceFallback) window.Worker = class BrokenWorker { constructor() { throw new Error('forced fallback for spaces test'); } };
    const buf = await (await fetch(url)).arrayBuffer();
    const t0 = performance.now();
    window.ClashControl.loadFiles([new File([buf], name)]);
    const base = name.replace(/\.ifc$/i, '');
    await new Promise((resolve, reject) => {
      const iv = setInterval(() => {
        const s = window._ccLatestState;
        const m = s && s.models.find((x) => x.name === base);
        if (m && (m.elements || []).length && !window._ccModelLoading) { clearInterval(iv); resolve(); }
        if (performance.now() - t0 > timeoutMs) { clearInterval(iv); reject(new Error('timed out loading ' + name)); }
      }, 50);
    });
    const ms = Math.round(performance.now() - t0);
    const m = window._ccLatestState.models.find((x) => x.name === base);
    return { ms, statsLoadTime: (m.stats || {}).loadTime || null, elementCount: m.elements.length };
  }, { url, name, forceFallback, timeoutMs });
}

function spaceReport(page, name) {
  return page.evaluate((base) => {
    const m = window._ccLatestState.models.find((x) => x.name === base);
    const spaces = m.elements.filter((e) => e.props && e.props.ifcType === 'IfcSpace');
    const withGeo = spaces.filter((e) => e.meshes && e.meshes.length && !e.box.isEmpty());
    const S = window._ccState3d;
    const meshes = withGeo.flatMap((e) => e.meshes);
    return {
      spaces: spaces.length,
      withGeo: withGeo.length,
      allMarked: meshes.every((mm) => mm.userData._ccSpace && mm.layers.mask === (1 << 3) && mm.material && mm.material._isCCSpaceMat && mm.material.depthWrite === false && !mm.castShadow),
      inScene: meshes.every((mm) => !!mm.parent),
      noInstKey: meshes.every((mm) => !mm.userData._instKey && !mm.userData._batchRef && !mm.userData._instanceRef),
      cameraShowsSpaces: S.camera.layers.isEnabled(3),
      pref: !!window._ccLatestState.prefs.showSpaces,
      fingerprint: window._ccSafetyMigrations.modelFingerprint([Object.assign({}, m, { id: 'fixed' })]),
    };
  }, name.replace(/\.ifc$/i, ''));
}

async function waitFrames(page, n = 6) {
  await page.evaluate((n) => new Promise((r) => { let i = 0; (function f() { if (++i >= n) r(); else requestAnimationFrame(f); })(); }), n);
}

// Points the camera at `target` from `eye`, then clicks the canvas centre
// through the real mouseup pick handler. Returns the picked ifcType.
async function clickThrough(page, eye, target) {
  await page.evaluate(({ eye, target }) => {
    const S = window._ccState3d;
    S.orbit.target.set(target[0], target[1], target[2]);
    S.camera.position.set(eye[0], eye[1], eye[2]);
    S.camera.lookAt(S.orbit.target);
    S.camera.updateMatrixWorld(true);
    S.orbit.sync();
    S._forceCull = true;
    window._ccDispatch({ t: 'UPD_PREFS', u: {} });
  }, { eye, target });
  await waitFrames(page, 12);
  return page.evaluate(async () => {
    const S = window._ccState3d;
    const c = S.renderer.domElement, r = c.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    window._ccSelectedEl = null;
    c.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, button: 0, bubbles: true }));
    c.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, button: 0, bubbles: true }));
    await new Promise((res) => setTimeout(res, 400));
    // Independent layer-0 raycast (what a building element pick sees).
    const rc = new window.THREE.Raycaster();
    rc.setFromCamera(new window.THREE.Vector2(0, 0), S.camera);
    const hit0 = rc.intersectObjects(S.mg.children, true).filter((h) => h.object.visible && h.object.userData.expressId != null)[0];
    const sel = window._ccSelectedEl;
    return { picked: sel && sel.props ? sel.props.ifcType : null, layer0Hit: !!hit0 };
  });
}

try {
  if (!timingOnly) {
    await mkdir(generatedDir, { recursive: true });
    await writeFile(join(generatedDir, 'rooms.ifc'), generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 3, withSpaces: true }));
    await writeFile(join(generatedDir, 'norooms.ifc'), generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 3 }));
    const roomsUrl = '/tests/fixtures/_generated-spaces/rooms.ifc';
    const noRoomsUrl = '/tests/fixtures/_generated-spaces/norooms.ifc';

    // ── Worker path ──
    const page = await newPage();
    let workerFellBack = false;
    page.on('console', (m) => { if (m.text().includes('[IFC Worker fallback]')) workerFellBack = true; });
    await load(page, roomsUrl, 'rooms.ifc', false, 60_000);
    await waitFrames(page);
    const w = await spaceReport(page, 'rooms.ifc');
    if (workerFellBack) fail('worker path fell back to the main thread');
    if (w.spaces !== 2 || w.withGeo !== 2) fail('worker path: expected 2 rooms with geometry, got ' + w.withGeo + '/' + w.spaces);
    else ok('worker path loads 2/2 rooms with geometry');
    if (!w.allMarked || !w.inScene || !w.noInstKey) fail('room meshes not on the space layer / shared space material / scene, or instanced: ' + JSON.stringify(w));
    if (w.pref || w.cameraShowsSpaces) fail('rooms must be hidden by default');
    else ok('rooms hidden by default (camera does not render the space layer)');
    const storeys = await page.evaluate(() => window._ccLatestState.models[0].elements.filter((e) => e.props.ifcType === 'IfcSpace').map((e) => e.props.storey).sort());
    if (JSON.stringify(storeys) !== JSON.stringify(['Level 0', 'Level 1'])) fail('rooms did not get their storey via IfcRelAggregates: ' + JSON.stringify(storeys));
    else ok('rooms are assigned to their storey (IfcRelAggregates)');

    // ── Toggle through the real UI (toolbar Style menu) ──
    await page.locator('button[aria-haspopup="menu"]', { hasText: 'Style' }).first().click();
    await page.locator('#cc-show-spaces').click();
    await waitFrames(page);
    const shown = await spaceReport(page, 'rooms.ifc');
    if (!shown.pref || !shown.cameraShowsSpaces) fail('Show spaces toggle did not show the rooms');
    else ok('Show spaces toggle renders the space layer');
    const persisted = await page.evaluate(() => localStorage.getItem('cc_showSpaces'));
    if (persisted !== 'true') fail('showSpaces pref not persisted (got ' + persisted + ')');
    await page.keyboard.press('Escape');

    // ── Picking with rooms shown ──
    const geo = await page.evaluate(() => {
      const els = window._ccLatestState.models[0].elements;
      const walls = els.filter((e) => e.props.ifcType === 'IfcWall' && e.props.storey === 'Level 0').map((e) => e.box).sort((a, b) => a.min.x - b.min.x);
      const room = els.find((e) => e.props.ifcType === 'IfcSpace' && e.props.storey === 'Level 0').box;
      const c = (b) => [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2];
      return { wall0: c(walls[0]), gapX: (walls[0].max.x + walls[1].min.x) / 2, room: c(room), roomTop: room.max.y };
    });
    const wallPick = await clickThrough(page, [geo.wall0[0], geo.roomTop + 30, geo.wall0[2] + 0.01], geo.wall0);
    if (wallPick.picked !== 'IfcWall') fail('click on a wall inside a shown room picked ' + wallPick.picked);
    else ok('a wall inside a shown room is still picked (not the room)');
    const roomPick = await clickThrough(page, [geo.gapX, geo.roomTop + 30, geo.room[2] + 0.01], [geo.gapX, geo.room[1], geo.room[2]]);
    if (roomPick.layer0Hit) fail('test setup: the gap between walls hit a building element');
    else if (roomPick.picked !== 'IfcSpace') fail('click where only the room is hit picked ' + roomPick.picked);
    else ok('a click hitting only the room selects the room');

    // Hidden rooms are never pickable.
    await page.evaluate(() => window._ccDispatch({ t: 'UPD_PREFS', u: { showSpaces: false } }));
    const hiddenPick = await clickThrough(page, [geo.gapX, geo.roomTop + 30, geo.room[2] + 0.01], [geo.gapX, geo.room[1], geo.room[2]]);
    if (hiddenPick.picked === 'IfcSpace') fail('a hidden room was picked');
    else ok('hidden rooms are not pickable');

    // Navigator-style selection of a hidden room force-shows it.
    const forced = await page.evaluate(() => {
      const m = window._ccLatestState.models[0];
      const sp = m.elements.find((e) => e.props.ifcType === 'IfcSpace');
      window._highlightById(sp.expressId, true, m.id);
      const on = sp.meshes.every((mm) => mm.layers.isEnabled(4));
      window._highlightRefs([{ modelId: m.id, expressId: m.elements.find((e) => e.props.ifcType === 'IfcWall').expressId }], false);
      const off = sp.meshes.every((mm) => !mm.layers.isEnabled(4));
      return { on, off };
    });
    if (!forced.on || !forced.off) fail('selecting a hidden room did not force-show it (or never released it): ' + JSON.stringify(forced));
    else ok('selecting a hidden room shows it until the selection changes');

    // Bounds ignore rooms (unless a model has nothing else).
    const bounds = await page.evaluate(() => {
      const b = window._ccViewport.getBounds();
      const walls = window._ccLatestState.models[0].elements.filter((e) => e.props.ifcType === 'IfcWall');
      const mz = Math.max(...walls.map((e) => e.box.max.z)), nz = Math.min(...walls.map((e) => e.box.min.z));
      return { bz: [b.min[2], b.max[2]], wz: [nz, mz] };
    });
    if (Math.abs(bounds.bz[0] - bounds.wz[0]) > 1e-6 || Math.abs(bounds.bz[1] - bounds.wz[1]) > 1e-6) fail('model bounds include rooms: ' + JSON.stringify(bounds));
    else ok('fit/section bounds ignore rooms');

    // ── Detection: rooms excluded by default, included on request ──
    const withRooms = await page.evaluate(async () => (await window.ClashControl.runDetection({ selfClashModels: 'all', excludeSelf: false, includeSpaces: false })).length);
    const withSpaceClashes = await page.evaluate(async () => {
      const r = await window.ClashControl.runDetection({ selfClashModels: 'all', excludeSelf: false, includeSpaces: true, fullRerun: true });
      const types = window._ccLatestState.models[0].elements.reduce((acc, e) => { acc[e.expressId] = e.props.ifcType; return acc; }, {});
      return r.filter((c) => types[c.elemA] === 'IfcSpace' || types[c.elemB] === 'IfcSpace' || /Space/.test(JSON.stringify([c.typeA, c.typeB]))).length;
    });
    await page.close();

    const pageNo = await newPage();
    await load(pageNo, noRoomsUrl, 'norooms.ifc', false, 60_000);
    const withoutRooms = await pageNo.evaluate(async () => (await window.ClashControl.runDetection({ selfClashModels: 'all', excludeSelf: false })).length);
    await pageNo.close();
    if (withRooms !== withoutRooms) fail('default detection count changed with rooms present: ' + withRooms + ' vs ' + withoutRooms);
    else ok('default detection ignores rooms (' + withRooms + ' clashes with and without rooms)');
    if (withSpaceClashes < 1) fail('includeSpaces:true produced no room clashes');
    else ok('includeSpaces:true brings room clashes in (' + withSpaceClashes + ')');

    // ── Main-thread fallback parity ──
    const fbPage = await newPage();
    await load(fbPage, roomsUrl, 'rooms.ifc', true, 60_000);
    const f = await spaceReport(fbPage, 'rooms.ifc');
    if (f.withGeo !== 2 || !f.allMarked) fail('fallback path: rooms missing geometry/marking: ' + JSON.stringify({ withGeo: f.withGeo, allMarked: f.allMarked }));
    else if (JSON.stringify(f.fingerprint) !== JSON.stringify(w.fingerprint)) fail('worker and fallback fingerprints differ with rooms present');
    else ok('main-thread fallback loads the same rooms (fingerprint-identical to the worker path)');

    // ── Floor plan: rooms never enter the cut outlines ──
    // Rooms span x ∈ [-2.5, 12.5] (walls only [-2, 12]), so any cut vertex at
    // x = -2.5 or 12.5 can only come from a room.
    const plan = await fbPage.evaluate(async () => {
      window._ccDispatch({ t: 'UPD_PREFS', u: { showSpaces: true } });
      const st = window._ccLatestState.models[0].storeyData.find((x) => x.name === 'Level 0');
      window._ccDispatch({ t: 'FLOOR_PLAN', v: { storeyName: 'Level 0', elevation: st ? st.elevation : 0 } });
      await new Promise((r) => setTimeout(r, 1500));
      const pc = window._ccPlanChainsWorld;
      const nums = (JSON.stringify(pc && pc.chains) || '').match(/-?\d+(\.\d+)?(e-?\d+)?/g) || [];
      const roomEdge = nums.map(Number).filter((v) => Math.abs(v + 2.5) < 1e-3 || Math.abs(v - 12.5) < 1e-3).length;
      return { n: nums.length, roomEdge };
    });
    if (!plan.n) fail('floor plan produced no cut chains (test setup)');
    else if (plan.roomEdge) fail('floor plan cut contains room outline vertices');
    else ok('floor plan cut has no room outlines');
    await fbPage.close();

    // ── Rooms written in their storey's frame (doubled placement) ──
    // The same building far from its storey origin, once with rooms written
    // normally and once with each room's footprint in storey coordinates
    // plus its own placement next to it. Both must put every room exactly
    // around its storey's walls, on the worker and the fallback path.
    await writeFile(join(generatedDir, 'rooms-own.ifc'), generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 3, withSpaces: true, offsetX: 120 }));
    await writeFile(join(generatedDir, 'rooms-parent.ifc'), generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 3, withSpaces: true, offsetX: 120, spaceFrame: 'parent' }));
    const roomBoxes = (pg, base) => pg.evaluate((base) => {
      const m = window._ccLatestState.models.find((x) => x.name === base);
      const r = (b) => [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((v) => Math.round(v * 1000) / 1000);
      const rooms = m.elements.filter((e) => e.props.ifcType === 'IfcSpace').sort((a, b) => a.props.storey < b.props.storey ? -1 : 1);
      const walls = m.elements.filter((e) => e.props.ifcType === 'IfcWall');
      const enclosed = rooms.every((sp) => walls.filter((w) => w.props.storey === sp.props.storey).every((w) => sp.box.min.x <= w.box.min.x && sp.box.max.x >= w.box.max.x && sp.box.min.z <= w.box.min.z && sp.box.max.z >= w.box.max.z));
      return { boxes: rooms.map((e) => r(e.box)), enclosed, walls: walls.map((w) => r(w.box)) };
    }, base);
    for (const fb of [false, true]) {
      const pg = await newPage();
      await load(pg, '/tests/fixtures/_generated-spaces/rooms-own.ifc', 'rooms-own.ifc', fb, 60_000);
      await load(pg, '/tests/fixtures/_generated-spaces/rooms-parent.ifc', 'rooms-parent.ifc', fb, 60_000);
      const own = await roomBoxes(pg, 'rooms-own'), par = await roomBoxes(pg, 'rooms-parent');
      const label = fb ? 'fallback' : 'worker';
      if (!own.enclosed || own.boxes.length !== 2) fail(label + ': normally written rooms do not enclose their walls (test setup): ' + JSON.stringify(own));
      else if (JSON.stringify(par.boxes) !== JSON.stringify(own.boxes) || !par.enclosed) fail(label + ': rooms written in the storey frame land elsewhere: ' + JSON.stringify({ own: own.boxes, parent: par.boxes }));
      else ok(label + ': rooms written in the storey frame land exactly where normally written rooms do');
      await pg.close();
    }
  }

  // ── Optional: a local IFC with IfcSpace (never committed) ──
  if (extFile) {
    const text = await readFile(extFile, 'latin1');
    const declared = (text.match(/=\s*IFCSPACE\s*\(/g) || []).length;
    const runs = [{ fallback: false }].concat(process.env.CC_SPACES_FILE_FALLBACK === '1' ? [{ fallback: true }] : []);
    for (const run of runs) {
      const page = await newPage();
      const t = await load(page, '/__cc_external.ifc', 'external.ifc', run.fallback, 900_000);
      const label = run.fallback ? 'external (fallback)' : 'external (worker)';
      console.log('SPACES INFO — ' + label + ': load ' + t.ms + ' ms (stats.loadTime ' + t.statsLoadTime + ' ms), ' + t.elementCount + ' elements');
      if (!timingOnly) {
        await waitFrames(page);
        const r = await spaceReport(page, 'external.ifc');
        console.log('SPACES INFO — ' + label + ': IfcSpace in file ' + declared + ', loaded ' + r.spaces + ', with geometry ' + r.withGeo);
        // Some rooms legitimately have no body (no Representation) and web-ifc
        // can return an empty mesh for a degenerate brep, so this is a share,
        // not an exact count; the info line above carries the exact numbers.
        if (r.withGeo < declared * 0.9) fail(label + ': only ' + r.withGeo + ' of ' + declared + ' IfcSpace got geometry');
        if (!r.allMarked) fail(label + ': room meshes not marked');
        if (r.cameraShowsSpaces) fail(label + ': rooms visible by default');
        await page.evaluate(() => window._ccDispatch({ t: 'UPD_PREFS', u: { showSpaces: true } }));
        await waitFrames(page);
        const r2 = await spaceReport(page, 'external.ifc');
        if (!r2.cameraShowsSpaces) fail(label + ': toggle did not show rooms');
        // From inside rooms, look horizontally: a building element must win
        // over the enclosing room whenever one is hit.
        const rooms = await page.evaluate(() => window._ccLatestState.models[0].elements
          .filter((e) => e.props.ifcType === 'IfcSpace' && e.meshes.length)
          .map((e) => ({ min: [e.box.min.x, e.box.min.y, e.box.min.z], max: [e.box.max.x, e.box.max.y, e.box.max.z] }))
          .filter((b) => (b.max[0] - b.min[0]) > 2 && (b.max[2] - b.min[2]) > 2 && (b.max[1] - b.min[1]) > 2)
          .slice(0, 8));
        let elementPicks = 0, badPicks = 0;
        for (const b of rooms) {
          const eye = [(b.min[0] + b.max[0]) / 2, b.min[1] + 1.5, (b.min[2] + b.max[2]) / 2];
          const res = await clickThrough(page, eye, [eye[0] + 1, eye[1], eye[2] + 0.01]);
          if (res.layer0Hit && res.picked === 'IfcSpace') badPicks++;
          if (res.picked && res.picked !== 'IfcSpace') elementPicks++;
        }
        console.log('SPACES INFO — ' + label + ': picks from inside ' + rooms.length + ' rooms: ' + elementPicks + ' building elements, ' + badPicks + ' rooms stealing an element hit');
        if (badPicks) fail(label + ': a room stole a pick from a building element');
        if (rooms.length && !elementPicks) fail(label + ': no pick from inside a room reached a building element');
      }
      await page.close();
    }
  }

  const realErrors = errors.filter((e) => !/favicon|404/.test(e));
  if (realErrors.length) fail('page errors: ' + JSON.stringify(realErrors.slice(0, 10)));
} catch (e) {
  fail(e && e.stack || String(e));
} finally {
  await browser.close();
  server.close();
  await rm(generatedDir, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log('SPACES OK — all checks passed');
