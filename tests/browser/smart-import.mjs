#!/usr/bin/env node
// Real-browser check for "smart import": the discipline / sub-discipline /
// role engine (clash-discipline-core.js + the loader's semantic records), the
// automatic clash matrix it drives, provision/zone handling in detection and
// IfcRelSpaceBoundary placement + adjacency.
//
// Fixture: a small federation from tests/fixtures/generate-synthetic-ifc.js
// generateSemanticIfc — struct (slab + .PROVISIONFORVOID. proxy), vent / plumb
// / elec (IFC2X3: generic IfcFlowSegment typed by IfcDuctSegmentType /
// IfcPipeSegmentType / IfcCableCarrierSegmentType, IfcSystem membership,
// NL-SfB classification refs), firecomp (fire-compartment proxies) and arch
// (two rooms, walls, floor, second-level space boundaries written with a
// deliberate -13.4 km / -13.7 km offset). Asserts:
//  * every element's discipline/sub-discipline and its provenance (stated
//    system / classification, inferred type object) — also with NO names at
//    all, and with Dutch names (hints from locales/nl.json);
//  * the default matrix runs cross-trade MEP pairs (duct × drain pipe, duct ×
//    cable tray) and skips same-trade ones (duct × duct from the plumbing
//    model); the legacy top-level matrix would have skipped them all;
//  * provision clashes are classified provision:'inside', zone clashes
//    roleGroup:'zone', both hidden by default behind counts, never dropped;
//    excluded + classified + reported == raw; left-out groups are reported;
//  * generic role suggestions from geometry (unnamed provision, compartment
//    marker), real equipment never suggested, a German-named model via a
//    test locale pack;
//  * the pre-run suggestions panel: interactive runs only (API runs never
//    blocked), keyboard focus + Escape, choices → rule fields, remembered;
//  * boundaries are placed (offset detected and verified), drawn on the
//    rooms layer, adjacency is right; scattered boundaries are refused with
//    a structured loader warning and never drawn;
//  * worker == main-thread fallback for every semantic field.
//
// Usage: CC_CHROMIUM_EXECUTABLE=/path CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/smart-import.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { generateSemanticIfc } = require('../fixtures/generate-synthetic-ifc.js');
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const offline = process.env.CC_BROWSER_OFFLINE_DEPS === '1';
const genDir = join(repoRoot, 'tests', 'fixtures', '_generated-smart-import');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.css': 'text/css' };
const OFFSET = [-13374.845, -13743.122, 0];

let failed = false;
function fail(msg) { console.error('SMART-IMPORT FAIL: ' + msg); failed = true; }
function ok(msg) { console.log('SMART-IMPORT OK — ' + msg); }
function check(cond, msg, detail) { if (cond) ok(msg); else fail(msg + (detail !== undefined ? ' — got ' + JSON.stringify(detail) : '')); }

const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = normalize(join(repoRoot, rel));
    if (!file.startsWith(normalize(repoRoot))) { res.writeHead(403); return res.end(); }
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
      await local(route, 'three/' + new URL(route.request().url()).pathname.split('/three@0.180.0/')[1]);
    });
    await ctx.route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', async (route) => {
      const suffix = new URL(route.request().url()).pathname.split('/web-ifc@0.0.77/')[1];
      await local(route, 'web-ifc/' + suffix, suffix.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
    });
    await ctx.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/css' }));
    await ctx.route('https://fonts.gstatic.com/**', (route) => route.abort());
    await ctx.route('https://gc.zgo.at/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  }
  if (forceFallback) {
    await page.addInitScript(() => {
      const Real = window.Worker;
      // Only the IFC parse worker is broken (a Blob URL built from the loader
      // source); the detection worker pool keeps working.
      window.Worker = function(url, o) {
        if (window.__ccIfcWorkerBlocked && String(url).indexOf('blob:') === 0 && !window.__ccAllowWorker) throw new Error('forced fallback for smart-import test');
        return new Real(url, o);
      };
    });
  }
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccState3d && window._ccState3d.mg, null, { timeout: 60_000 });
  // Pack data (locale name hints + country classification tables) is fetched at boot.
  await page.waitForFunction(() => {
    const c = window._ccClashDisciplineCore;
    return c && c.hintSources().indexOf('locale:nl') >= 0 && c.classificationTables().some((t) => t.name === 'NL-SfB');
  }, null, { timeout: 30_000 });
  return page;
}

async function loadAll(page, files, fallback) {
  return page.evaluate(async ({ files, fallback }) => {
    if (fallback) window.__ccIfcWorkerBlocked = true;
    const fs = [];
    for (const f of files) fs.push(new File([await (await fetch(f.url)).arrayBuffer()], f.name));
    window.ClashControl.loadFiles(fs);
    const names = files.map((f) => f.name.replace(/\.ifc$/i, ''));
    const t0 = performance.now();
    await new Promise((resolve, reject) => {
      const iv = setInterval(() => {
        const s = window._ccLatestState;
        if (s && names.every((n) => s.models.some((m) => m.name === n && m.elements && m.elements.length)) && !window._ccModelLoading) { clearInterval(iv); resolve(); }
        if (performance.now() - t0 > 120000) { clearInterval(iv); reject(new Error('timed out loading ' + names.join(','))); }
      }, 50);
    });
    window.__ccIfcWorkerBlocked = false;
  }, { files, fallback });
}

// Everything the semantic layer produced, keyed by model name + element name/type.
function semanticReport(page) {
  return page.evaluate(() => {
    const core = window._ccClashDisciplineCore;
    return window._ccLatestState.models.map((m) => {
      const els = m.elements.map((e) => {
        const p = e.props || {}, c = e._ccCls || null;
        return {
          eid: e.expressId, type: p.ifcType, name: p.name || '',
          key: c ? core.elementMatrixKey(e, m.discipline) : null,
          src: c ? c.src : null, stated: c ? c.stated : null, ev: c ? c.ev : null,
          role: c ? c.role : null, roleSrc: c ? c.roleSrc : null,
          typeObject: p.typeObject ? [p.typeObject.cls, p.typeObject.name, p.typeObject.predef] : null,
          groups: p.groups ? p.groups.map((g) => [g.cls, g.name, g.predef]) : null,
          classification: p.classification ? p.classification.map((x) => [x.sys, x.code]) : null,
          predefinedType: p.predefinedType || null,
        };
      }).sort((a, b) => a.eid - b.eid);
      const bd = m._ccBoundaries;
      return {
        name: m.name, discipline: m.discipline, info: m.disciplineInfo ? { key: m.disciplineInfo.key, src: m.disciplineInfo.src, shares: m.disciplineInfo.shares, roles: m.disciplineInfo.roles, role: m.disciplineInfo.role } : null,
        els,
        boundaries: bd ? { total: bd.total, placed: bd.placed, frame: bd.frame, offset: bd.offset && bd.offset.map((v) => Math.round(v * 1000) / 1000), scale: bd.scale,
          geo: bd.geometry ? bd.geometry.length : 0, spaceToEls: bd.spaceToEls, elToSpaces: bd.elToSpaces, warning: bd.warning && bd.warning.code } : null,
        warnings: (m.loaderWarnings || []).map((w) => w.code),
      };
    }).sort((a, b) => (a.name < b.name ? -1 : 1));
  });
}

async function detect(page, rules) {
  return page.evaluate(async (rules) => {
    const r = await window.ClashControl.runDetection(rules);
    const byId = {}; window._ccLatestState.models.forEach((m) => { byId[m.id] = m; });
    const nm = (mid, eid) => { const m = byId[mid]; const el = m && m.elements.find((e) => e.expressId === eid); return (m ? m.name : '?') + '/' + (el && el.props ? el.props.name || el.props.ifcType : eid); };
    return (r || []).map((c) => ({ a: nm(c.modelAId, c.elemA), b: nm(c.modelBId, c.elemB), type: c.type, provision: c.provision || null, roleGroup: c.roleGroup || null, title: c.title }))
      .map((c) => Object.assign(c, { pair: [c.a, c.b].sort().join(' × ') })).sort((x, y) => (x.pair < y.pair ? -1 : 1));
  }, rules);
}

const el = (rep, model, name) => { const m = rep.find((x) => x.name === model); return m && m.els.find((e) => e.name === name); };

try {
  await mkdir(genDir, { recursive: true });
  const kinds = ['struct', 'vent', 'plumb', 'elec', 'firecomp', 'arch'];
  const files = [];
  for (const k of kinds) {
    await writeFile(join(genDir, k + '.ifc'), generateSemanticIfc({ kind: k, boundaryOffset: OFFSET }));
    files.push({ url: '/tests/fixtures/_generated-smart-import/' + k + '.ifc', name: 'm-' + k + '.ifc' });
  }
  for (const k of ['vent', 'plumb', 'elec']) {
    await writeFile(join(genDir, k + '-unnamed.ifc'), generateSemanticIfc({ kind: k, names: false }));
    await writeFile(join(genDir, k + '-nl.ifc'), generateSemanticIfc({ kind: k, nameLang: 'nl' }));
  }
  await writeFile(join(genDir, 'firecomp-nl.ifc'), generateSemanticIfc({ kind: 'firecomp', nameLang: 'nl' }));
  await writeFile(join(genDir, 'firecomp-de.ifc'), generateSemanticIfc({ kind: 'firecomp', nameLang: 'de' }));
  await writeFile(join(genDir, 'vent-de.ifc'), generateSemanticIfc({ kind: 'vent', nameLang: 'de' }));
  await writeFile(join(genDir, 'struct-geo.ifc'), generateSemanticIfc({ kind: 'struct', geoProvision: true }));
  await writeFile(join(genDir, 'vent-equip.ifc'), generateSemanticIfc({ kind: 'vent', equipmentProxy: true }));
  await writeFile(join(genDir, 'firecomp-geo.ifc'), generateSemanticIfc({ kind: 'firecomp', names: false, geoZoneMarker: true }));
  await writeFile(join(genDir, 'arch-noise.ifc'), generateSemanticIfc({ kind: 'arch', boundaryOffset: OFFSET, boundaryNoise: true }));

  // ── Federation, worker path ──
  const page = await newPage(false);
  await loadAll(page, files, false);
  const rep = await semanticReport(page);
  const disc = Object.fromEntries(rep.map((m) => [m.name, m.discipline]));
  check(disc['m-struct'] === 'structural' && disc['m-arch'] === 'architectural' && disc['m-vent'] === 'mep' && disc['m-plumb'] === 'mep' && disc['m-elec'] === 'mep',
    'model disciplines detected (struct / arch / 3× MEP)', disc);
  const riser = el(rep, 'm-vent', 'Supply air riser'), drain = el(rep, 'm-plumb', 'Waste water pipe'), stray = el(rep, 'm-plumb', 'Extract air duct'), tray = el(rep, 'm-elec', 'Cable tray');
  check(riser && riser.key === 'mep.ventilation' && riser.stated && riser.src === 'system', 'vent riser: mep.ventilation, stated by its IfcSystem', riser);
  check(drain && drain.key === 'mep.plumbing' && drain.stated, 'drain pipe: mep.plumbing, stated (system / NL-SfB 52.20)', drain);
  check(stray && stray.key === 'mep.ventilation' && stray.src === 'type-object', 'stray duct in the plumbing model: ventilation, inferred from IfcDuctSegmentType', stray);
  check(tray && tray.key === 'mep.electrical' && tray.stated, 'cable tray: mep.electrical, stated', tray);
  check(riser && riser.typeObject && riser.typeObject[0] === 'IfcDuctSegmentType' && riser.classification && riser.classification[0][0] === 'NL-SfB' && riser.classification[0][1] === '57.51',
    'type object + classification extracted into props', riser);
  const prov = el(rep, 'm-struct', 'Provision for shaft');
  check(prov && prov.role === 'provision' && prov.roleSrc === 'predefined-type', 'provision proxy: role provision, stated by .PROVISIONFORVOID.', prov);
  const zones = rep.find((m) => m.name === 'm-firecomp').els;
  check(zones.length === 2 && zones.every((z) => z.role === 'zone'), 'fire-compartment proxies: role zone (name hints)', zones.map((z) => [z.role, z.roleSrc]));

  // ── Boundaries ──
  const arch = rep.find((m) => m.name === 'm-arch');
  const b = arch.boundaries;
  check(b && b.total === 12 && b.placed === 12 && b.frame === 'offset' && b.geo > 0, 'space boundaries placed with a detected, verified offset (12/12)', b);
  check(b && Math.abs(b.offset[0] - 13374.845) < 0.01 && Math.abs(b.offset[1] - 13743.122) < 0.01, 'detected correction cancels the written offset exactly', b && b.offset);
  const archEls = Object.fromEntries(arch.els.map((e) => [e.name, e.eid]));
  const room1 = archEls['Office 1'], room2 = archEls['Office 2'], wallM = archEls['Wall M'];
  const bound1 = (b.spaceToEls[room1] || []).map((id) => arch.els.find((e) => e.eid === id).name).sort();
  check(JSON.stringify(bound1) === JSON.stringify(['Floor slab', 'Wall M', 'Wall N', 'Wall S', 'Wall W']), 'room 1 is bounded by walls S/N/W/M and the floor slab', bound1);
  const sep = (b.elToSpaces[wallM] || []).slice().sort((x, y) => x - y);
  check(JSON.stringify(sep) === JSON.stringify([room1, room2].sort((x, y) => x - y)), 'Wall M separates rooms 1 and 2', sep);
  const scene = await page.evaluate(() => {
    const S = window._ccState3d, out = [];
    S.mg.traverse((o) => { if (o.userData && o.userData._ccBoundary) out.push({ layer: o.layers.mask, inMeshes: window._ccLatestState.models.some((m) => (m.meshes || []).indexOf(o) >= 0), raycast: o.raycast.toString().length < 20 }); });
    return out;
  });
  check(scene.length === 1 && scene[0].layer === (1 << 3) && !scene[0].inMeshes && scene[0].raycast, 'boundary lines live on the rooms layer, outside model.meshes, never raycast', scene);

  // ── Detection: default rules ──
  const hardRules = { hard: true, maxGap: 0 };
  const res = await detect(page, hardRules);
  const pairs = res.map((c) => c.pair);
  const has = (a, b) => res.find((c) => c.pair === [a, b].sort().join(' × '));
  check(has('m-vent/Supply air duct', 'm-plumb/Waste water pipe'), 'cross-trade pair duct × drain pipe is tested by default (auto matrix)', pairs);
  check(has('m-vent/Supply air duct', 'm-elec/Cable tray'), 'cross-trade pair duct × cable tray is tested by default', pairs);
  check(!has('m-vent/Supply air duct', 'm-plumb/Extract air duct'), 'same-trade pair duct × duct (different models) is skipped by default', pairs);
  const zoneClashes = res.filter((c) => /m-firecomp/.test(c.pair));
  check(zoneClashes.length > 0 && zoneClashes.every((c) => c.roleGroup === 'zone'), 'zone clashes are computed and labelled roleGroup:zone (default "classify only")', zoneClashes.map((c) => [c.pair, c.roleGroup]));
  const inProv = res.filter((c) => c.provision === 'inside');
  check(inProv.length === 2 && inProv.some((c) => /Floor slab/.test(c.pair)) && inProv.some((c) => /Provision for shaft/.test(c.pair)),
    'riser × slab and riser × provision proxy are classified provision:inside (kept, not dropped)', res.map((c) => [c.pair, c.provision]));
  check(inProv.every((c) => / — inside provision/.test(c.title)), 'provision clashes get a provision title', inProv.map((c) => c.title));
  const ui = await page.evaluate(() => new Promise((r) => setTimeout(() => {
    window._ccDispatch({ t: 'TAB', v: 'clashes' });
    setTimeout(() => r(document.body.innerText), 600);
  }, 200)));
  check(/2 inside provisions \/ reservations/.test(ui), 'clash list hides them behind a "2 inside provisions" count', ui.slice(0, 0));
  check(new RegExp(zoneClashes.length + '× zones and compartments').test(ui), 'classified zone clashes are hidden behind a count', ui.slice(0, 0));

  // Inspector: discipline & role card (plain, no provenance), room adjacency; model card mix.
  const insp = await page.evaluate(async () => {
    window._ccDispatch({ t: 'SET_WORKSPACE', v: 'coordinate' });
    // Pin the selection (the viewer re-publishes its own selection on every
    // render; a real click would go through the 3D picker).
    async function pick(modelName, elName) {
      const m = window._ccLatestState.models.find((x) => x.name === modelName);
      const e = m.elements.find((x) => x.props && x.props.name === elName);
      const sel = { expressId: e.expressId, modelId: m.id, props: e.props, modelName: m.name };
      Object.defineProperty(window, '_ccSelectedEl', { get: () => sel, set: () => {}, configurable: true });
      window.dispatchEvent(new Event('cc-element-selected'));
      await new Promise((r) => setTimeout(r, 900));
      return document.body.innerText;
    }
    const roomTxt = await pick('m-arch', 'Office 1');
    const riserTxt = await pick('m-vent', 'Supply air riser');
    delete window._ccSelectedEl; window._ccSelectedEl = null;
    return { roomTxt, riserTxt };
  });
  check(/Bounded by \(5\)/.test(insp.roomTxt), 'inspector lists what bounds a room (5 elements)');
  check(/MEP · Ventilation/.test(insp.riserTxt) && !/\b(stated|inferred)\b/.test(insp.riserTxt), 'inspector shows the sub-discipline plainly (no stated/inferred provenance)',
    (insp.riserTxt.match(/DISCIPLINE & ROLE[\s\S]{0,300}/i) || [insp.riserTxt.slice(0, 400)])[0]);

  // Legacy matrix (top-level keys only) for contrast: every MEP × MEP pair skipped.
  const legacy = await page.evaluate(() => {
    const core = window._ccClashDisciplineCore;
    return core.disciplinePairEnabled('mep', 'mep', { excludeSameDiscipline: true }) === false &&
      core.disciplinePairEnabled('mep.ventilation', 'mep.plumbing', { excludeSameDiscipline: true }) === true &&
      core.disciplinePairEnabled('mep.ventilation', 'mep.plumbing', { excludeSameDiscipline: true, disciplineMatrix: { 'mep:mep': false } }) === false;
  });
  check(legacy, 'matrix precedence: legacy mep:mep off, trades on, a saved mep:mep override still wins');

  // ── Invariant: excluded + classified + reported == raw ──
  const allInclude = { roleChoices: { provision: 'include', zone: 'include', duplicate: 'include', proxy: 'include' } };
  const raw = await detect(page, Object.assign({}, hardRules, allInclude));
  const withZoneOut = await detect(page, Object.assign({}, hardRules, { roleChoices: { zone: 'exclude' } }));
  const st = await page.evaluate(() => ({ excluded: window._ccLatestState.lastRunExcluded, rules: window._ccLatestState.rules }));
  const zoneOut = raw.filter((c) => /m-firecomp/.test(c.pair)).length;
  const hidden = withZoneOut.filter((c) => c.provision === 'inside').length; // provisions: default 'classify'; other groups present are 'include'
  const visible = withZoneOut.length - hidden;
  check(zoneOut > 0 && visible + hidden + zoneOut === raw.length,
    'invariant: reported (' + visible + ') + classified (' + hidden + ') + excluded (' + zoneOut + ') == raw (' + raw.length + ')');
  check(st.excluded && st.excluded.zone === 2, 'left-out zones are reported with the result (state.lastRunExcluded)', st.excluded);
  const banner = await page.evaluate(() => new Promise((r) => { window._ccDispatch({ t: 'TAB', v: 'clashes' }); setTimeout(() => { const b = document.querySelector('[data-cc-excluded]'); r(b ? b.innerText : JSON.stringify({ tab: window._ccLatestState.tab, ws: window._ccLatestState.workspace })); }, 700); }));
  check(banner && /2 zones and compartments/.test(banner) && /Include and run again/.test(banner), 'results header shows what was left out, with "Include and run again"', banner);

  // ── Pre-run suggestions panel (interactive entry point) ──
  await page.evaluate(() => window._ccDispatch({ t: 'UPD_RULES', u: { roleChoices: {}, roleChoicesRemembered: false } }));
  // API runs never ask.
  const apiAsked = await page.evaluate(async () => { const p = window.ClashControl.runDetection({ hard: true, maxGap: 0 }); const asked = !!window._ccLatestState.preRun; await p; return asked || !!window._ccLatestState.preRun; });
  check(!apiAsked, 'API / automation runs never open the pre-run panel');
  await page.evaluate(() => window._ccRunDetectionInteractive({ hard: true, maxGap: 0 }));
  await page.waitForSelector('[data-cc-prerun]', { timeout: 10_000 });
  const groupsShown = await page.$$eval('[data-cc-group]', (els) => els.map((e) => e.getAttribute('data-cc-group')));
  check(['provision', 'zone', 'space'].every((g) => groupsShown.includes(g)), 'pre-run panel lists the suggestion groups', groupsShown);
  const focusInside = await page.evaluate(() => !!document.activeElement && !!document.activeElement.closest('[data-cc-prerun]'));
  check(focusInside, 'pre-run panel takes keyboard focus');
  await page.keyboard.press('Escape');
  const closed = await page.evaluate(() => !window._ccLatestState.preRun && !document.querySelector('[data-cc-prerun]'));
  check(closed, 'Escape closes the panel without running');
  await page.evaluate(() => window._ccRunDetectionInteractive({ hard: true, maxGap: 0 }));
  await page.waitForSelector('[data-cc-prerun]', { timeout: 10_000 });
  await page.selectOption('[data-cc-group="zone"] select', 'exclude');
  await page.check('[data-cc-prerun] input[type=checkbox] >> nth=0');
  await page.click('[data-cc-prerun-run]');
  await page.waitForFunction(() => !window._ccLatestState.detecting && window._ccLatestState.lastRunExcluded && window._ccLatestState.lastRunExcluded.zone === 2, null, { timeout: 60_000 });
  const after = await page.evaluate(() => ({ rc: window._ccLatestState.rules.roleChoices, rem: window._ccLatestState.rules.roleChoicesRemembered }));
  check(after.rc.zone === 'exclude' && after.rem === true, 'panel choices become rule fields and are remembered for the project', after);
  await page.evaluate(() => window._ccRunDetectionInteractive({ hard: true, maxGap: 0 }));
  await page.waitForTimeout(400);
  const askedAgain = await page.evaluate(() => !!window._ccLatestState.preRun);
  check(!askedAgain, 'a remembered project choice is not asked again');
  await page.waitForFunction(() => !window._ccLatestState.detecting, null, { timeout: 60_000 });
  await page.close();

  // ── Generic roles from geometry (no names, no predefined types) ──
  {
    const pg = await newPage(false);
    await loadAll(pg, [
      { url: '/tests/fixtures/_generated-smart-import/struct-geo.ifc', name: 'g-struct.ifc' },
      { url: '/tests/fixtures/_generated-smart-import/vent-equip.ifc', name: 'g-vent.ifc' },
      { url: '/tests/fixtures/_generated-smart-import/plumb.ifc', name: 'g-plumb.ifc' },
      { url: '/tests/fixtures/_generated-smart-import/elec.ifc', name: 'g-elec.ifc' },
      { url: '/tests/fixtures/_generated-smart-import/firecomp-geo.ifc', name: 'g-firecomp.ifc' },
      { url: '/tests/fixtures/_generated-smart-import/arch.ifc', name: 'g-arch.ifc' },
    ], false);
    const sug = await pg.evaluate(() => {
      const core = window._ccClashDisciplineCore, ms = window._ccLatestState.models;
      const idx = core.suggestRoles(ms), out = [];
      ms.forEach((m) => m.elements.forEach((e) => { const r = idx.byEl.get(e); if (r) out.push({ m: m.name, n: (e.props && e.props.name) || '', t: e.props.ifcType, g: r.group, conf: r.conf, src: r.src }); }));
      return out;
    });
    const geoProv = sug.find((x) => x.m === 'g-struct' && x.n === '' && x.t === 'IfcBuildingElementProxy');
    check(geoProv && geoProv.g === 'provision' && geoProv.src === 'geometry' && geoProv.conf === 'medium', 'unnamed proxy crossed by duct, drain and tray: provision from geometry (medium)', geoProv);
    const marker = sug.find((x) => x.m === 'g-firecomp' && x.g === 'zone');
    check(marker && marker.src === 'geometry', 'unnamed thin plate inside a wall: zone (compartment marker) from geometry', sug.filter((x) => x.m === 'g-firecomp'));
    const equip = sug.find((x) => x.n === 'Fan unit FU-01');
    check(!equip, 'a proxy that is real equipment (in a supply-air system) is not suggested at all', equip);
    const unk = sug.filter((x) => x.m === 'g-firecomp' && x.g === 'proxy');
    check(unk.length === 2 && unk.every((x) => x.conf === 'low'), 'unnamed proxies without evidence: unclassified, low confidence (default: include)', unk);
    await pg.close();
  }

  // ── A non-English named model via a (test) locale pack ──
  {
    const pd = await newPage(false);
    await loadAll(pd, [{ url: '/tests/fixtures/_generated-smart-import/firecomp-de.ifc', name: 'de-firecomp.ifc' },
      { url: '/tests/fixtures/_generated-smart-import/vent-de.ifc', name: 'de-vent.ifc' }], false);
    const before = await semanticReport(pd);
    const pack = JSON.parse(await readFile(join(repoRoot, 'tests', 'fixtures', 'locale-de-hints.json'), 'utf8'));
    await pd.evaluate((h) => { window._ccClashDisciplineCore.registerHints('locale:de', h); window._ccReclassifyModels('test'); }, pack.disciplineHints);
    await pd.waitForTimeout(300);
    const after2 = await semanticReport(pd);
    const zb = before.find((m) => m.name === 'de-firecomp').els, za = after2.find((m) => m.name === 'de-firecomp').els;
    check(zb.every((e) => !e.role) && za.every((e) => e.role === 'zone' && e.roleSrc === 'name'), 'German "Brandabschnitt" proxies become zones once a German hint pack is installed (UI language unchanged)', { before: zb.map((e) => e.role), after: za.map((e) => e.role) });
    await pd.close();
  }

  // ── Unnamed + Dutch-named MEP models: evidence without (English) names ──
  for (const variant of ['unnamed', 'nl']) {
    const p2 = await newPage(false);
    await loadAll(p2, ['vent', 'plumb', 'elec'].map((k) => ({ url: '/tests/fixtures/_generated-smart-import/' + k + '-' + variant + '.ifc', name: variant + '-' + k + '.ifc' })), false);
    const r2 = await semanticReport(p2);
    const keys = r2.map((m) => m.els.map((e) => e.key).sort().join(',')).join(' | ');
    check(keys === 'mep.electrical | mep.plumbing,mep.ventilation | mep.ventilation,mep.ventilation',
      variant + ' MEP models: same sub-disciplines from stated/type evidence', keys);
    const res2 = await detect(p2, hardRules);
    check(res2.length === 2, variant + ': the two cross-trade clashes are found', res2.map((c) => c.pair));
    await p2.close();
  }
  {
    const p3 = await newPage(false);
    await loadAll(p3, [{ url: '/tests/fixtures/_generated-smart-import/firecomp-nl.ifc', name: 'nl-firecomp.ifc' }], false);
    const r3 = await semanticReport(p3);
    check(r3[0].els.every((e) => e.role === 'zone' && e.roleSrc === 'name'), 'Dutch-named compartments ("Brandcompartiment") are zones via the nl pack hints', r3[0].els.map((e) => [e.role, e.roleSrc]));
    await p3.close();
  }

  // ── Scattered boundaries: refused, never drawn ──
  {
    const p4 = await newPage(false);
    await loadAll(p4, [{ url: '/tests/fixtures/_generated-smart-import/arch-noise.ifc', name: 'noise.ifc' }], false);
    const r4 = await semanticReport(p4);
    const nb = r4[0].boundaries;
    check(nb && nb.placed === 0 && nb.geo === 0 && r4[0].warnings.indexOf('space-boundaries-unplaced') >= 0,
      'inconsistent boundaries are not placed and raise a structured loader warning', nb);
    check(nb && Object.keys(nb.spaceToEls).length === 2, 'adjacency still comes from the relations when geometry is refused', nb && nb.spaceToEls);
    await p4.close();
  }

  // ── Worker == main-thread fallback (every semantic field) ──
  const diffFiles = ['vent', 'arch', 'struct'].map((k) => ({ url: '/tests/fixtures/_generated-smart-import/' + k + '.ifc', name: 'd-' + k + '.ifc' }));
  const pw = await newPage(false);
  await loadAll(pw, diffFiles, false);
  const repW = await semanticReport(pw);
  await pw.close();
  const pf = await newPage(true);
  let fellBack = false;
  pf.on('console', (m) => { if (m.text().includes('[IFC Worker fallback]')) fellBack = true; });
  await loadAll(pf, diffFiles, true);
  const repF = await semanticReport(pf);
  await pf.close();
  check(fellBack, 'fallback page really parsed on the main thread');
  check(JSON.stringify(repW) === JSON.stringify(repF), 'worker and main-thread fallback produce identical semantics, classifications and boundaries',
    JSON.stringify(repW) === JSON.stringify(repF) ? undefined : { worker: repW, fallback: repF });

  if (errors.length) fail('browser emitted uncaught page or console errors: ' + JSON.stringify(errors.slice(0, 10)));
} catch (e) {
  fail(String(e && e.stack || e));
} finally {
  await browser.close();
  server.close();
  await rm(genDir, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log('SMART-IMPORT OK — all checks passed');
