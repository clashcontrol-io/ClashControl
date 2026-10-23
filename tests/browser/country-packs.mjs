#!/usr/bin/env node
// Country packs in the real app: a model with no country signal stays
// IFC-neutral (no regional code, no accessibility thresholds, no national
// data standard counted, no national CRS default / 3D layer), a model located
// in the Netherlands (site lat/lon, or a postal address) activates the nl pack
// automatically WITHOUT saving the choice, and a Settings pick of "none" keeps
// an NL model neutral.
//
// Usage: CC_CHROMIUM_EXECUTABLE=/path [CC_BROWSER_OFFLINE_DEPS=1] node tests/browser/country-packs.mjs
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSyntheticIfc } from '../fixtures/generate-synthetic-ifc.js';
import { offlineDepsEnabled, routeOfflineDeps } from './_offline-deps.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const genDir = join(root, 'tests', 'fixtures', '_generated-country-packs');
let failed = false;
function check(cond, msg) {
  if (cond) console.log('COUNTRY-PACKS OK — ' + msg);
  else { console.error('COUNTRY-PACKS FAIL: ' + msg); failed = true; }
}

await mkdir(genDir, { recursive: true });
const FIX = {
  neutral: generateSyntheticIfc({ storeyCount: 1, wallsPerStorey: 2 }),
  nlSite: generateSyntheticIfc({ storeyCount: 1, wallsPerStorey: 2, geo: { lat: [52, 22, 0], lon: [4, 54, 0], elev: 2 } }),
  nlAddress: generateSyntheticIfc({ storeyCount: 1, wallsPerStorey: 2, postalAddress: { building: 'Nederland' } }),
};
for (const [k, v] of Object.entries(FIX)) await writeFile(join(genDir, k + '.ifc'), v);

const server = createServer(async (req, res) => {
  const p = req.url.split('?')[0];
  try {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(1));
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    const ct = (p === '/' || p.endsWith('.html')) ? 'text/html' : p.endsWith('.json') ? 'application/json'
      : p.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
    res.writeHead(200, { 'content-type': ct });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port + '/';

const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE });
const errors = [];

async function open(storage) {
  const context = await browser.newContext();
  if (offlineDepsEnabled()) await routeOfflineDeps(context, root);
  if (storage) await context.addInitScript((s) => { for (const k in s) localStorage.setItem(k, s[k]); }, storage);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base);
  await page.waitForFunction(() => window._ccDispatch && window.ClashControl && window._ccGetCountryPacks && window._ccGetCountryPacks().length >= 4
    && typeof window._ccRunAccessibilityChecks === 'function' && typeof window._ccRunStandard === 'function', null, { timeout: 60000 });
  return { page, context };
}

async function load(page, name) {
  await page.evaluate(async (url) => {
    const buf = await (await fetch(url)).arrayBuffer();
    window.ClashControl.loadFiles([new File([buf], 'cp-' + url.split('/').pop())]);
  }, '/tests/fixtures/_generated-country-packs/' + name + '.ifc');
  await page.waitForFunction(() => { const s = window._ccLatestState; return s && s.models.length && s.models.every((m) => (m.elements || []).length > 0); }, null, { timeout: 60000 });
  await page.waitForTimeout(300);
}

function snapshot(page) {
  return page.evaluate(() => {
    const s = window._ccLatestState;
    const els = []; s.models.forEach((m) => (m.elements || []).forEach((el) => { el._modelId = m.id; els.push(el); }));
    const acc = window._ccRunAccessibilityChecks(els);
    const stds = window._ccDataQualityStandards().map((e) => ({ key: e.key, app: window._ccStandardApplicability(e, window._ccRunStandard(e, e.std.scope === 'models' ? s.models : els)) }));
    const score = window._ccComputeQualityScore(els, s.models, { force: true });
    let saved = null; try { saved = localStorage.getItem('cc_regulation_region'); } catch (e) {}
    return {
      region: window._ccGetRegulationRegion(),
      resolution: window._ccGetRegionResolution(),
      saved,
      accThresholds: acc.thresholds,
      accGroups: Object.keys(acc.groups),
      stds,
      categories: score.breakdown.categories.map((c) => c.label),
      defaultCrs: window._ccDefaultCRS(),
      crs: window._ccCRSList().map((c) => c.epsg),
      tiles: window._ccTiles3DPresets().map((t) => t.id),
      visibility: window._ccVisibilityPresets ? window._ccVisibilityPresets().map((p) => p.key) : [],
    };
  });
}

try {
  // ── 1. No country signal: IFC-neutral ─────────────────────────────
  {
    const { page, context } = await open();
    await load(page, 'neutral');
    const s = await snapshot(page);
    check(s.region === null && s.resolution.reason === 'none', 'model without a country signal: no regional code (' + JSON.stringify(s.resolution) + ')');
    check(JSON.stringify(s.accThresholds) === '{}' && s.accGroups.length === 0, 'accessibility has no thresholds and runs no check');
    check(s.stds.length >= 2 && s.stds.every((x) => !x.app.applicable), 'no national data standard applies');
    check(!s.categories.some((l) => /ILS|RVB/.test(l)), 'quality score has only IFC-neutral categories: ' + s.categories.join(', '));
    check(s.defaultCrs === null && s.tiles.length === 0, 'no national CRS default and no national 3D layer');
    check(!s.visibility.includes('workplace-window-view-NL'), 'no national visibility preset');
    await page.evaluate(() => window._ccDispatch({ t: 'TAB', v: 'accessibility' }));
    await page.waitForTimeout(400);
    const note = await page.evaluate(() => document.body.innerText.includes('No regional code applies to this model'));
    check(note, 'Accessibility panel asks to choose a regional code or enter thresholds');
    await context.close();
  }

  // ── 2. IfcSite in the Netherlands: nl activates, not saved ────────
  {
    const { page, context } = await open();
    await load(page, 'nlSite');
    const s = await snapshot(page);
    check(s.region === 'nl' && s.resolution.reason === 'site', 'NL site location activates the nl pack (' + JSON.stringify(s.resolution) + ')');
    check(s.saved === null, 'the automatic choice is not saved');
    check(s.accThresholds.doorClearWidth === 0.85 && s.accGroups.length === 5, 'nl accessibility thresholds apply');
    check(s.stds.filter((x) => x.app.applicable && x.app.reason === 'region').length === 2, 'ILS and RVB apply by region');
    check(s.categories.includes('ILS / NL-SfB') && s.categories.includes('RVB BIM Norm'), 'quality score shows the Dutch standards');
    check(s.defaultCrs === '28992' && s.crs[0] === '28992', 'RD New is the default CRS');
    check(s.tiles.includes('nl-pdok'), 'the PDOK 3D layer is offered');
    check(s.visibility.includes('workplace-window-view-NL'), 'the Dutch workplace visibility preset is offered');
    await page.evaluate(() => window._ccDispatch({ t: 'TAB', v: 'accessibility' }));
    await page.waitForTimeout(400);
    const txt = await page.evaluate(() => document.body.innerText);
    check(/Thresholds: Nederland/.test(txt), 'Accessibility panel names the pack as the threshold source');
    await context.close();
  }

  // ── 3. Postal address only ────────────────────────────────────────
  {
    const { page, context } = await open();
    await load(page, 'nlAddress');
    const s = await snapshot(page);
    check(s.region === 'nl' && s.resolution.reason === 'address' && s.resolution.detail === 'Nederland', 'IfcPostalAddress.Country activates nl (' + JSON.stringify(s.resolution) + ')');
    await context.close();
  }

  // ── 4. Settings "none" keeps an NL model neutral ──────────────────
  {
    const { page, context } = await open({ cc_regulation_region: 'none' });
    await load(page, 'nlSite');
    const s = await snapshot(page);
    check(s.region === null && s.resolution.reason === 'user-none', 'a saved "none" overrides the model location');
    check(s.stds.every((x) => !x.app.applicable) && s.accGroups.length === 0, 'and keeps every check IFC-neutral');
    await context.close();
  }
  check(errors.length === 0, 'no uncaught page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
} finally {
  await browser.close();
  server.close();
  await rm(genDir, { recursive: true, force: true });
}
if (failed) process.exit(1);
console.log('COUNTRY-PACKS OK — all checks passed');
