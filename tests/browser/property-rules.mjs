#!/usr/bin/env node
// User-authored property rules and colour by property (docs/INTERNALS.md
// §21.62), in the real app on the generated federation:
//   - two rules authored through the Data Quality panel's editor, run →
//     each rule's count equals an independent count over the loaded
//     elements; an issue created from one carries its rule and count;
//     the CSV lists every failing element of both rules; the IDS export of
//     the rules, parsed and run by the IDS engine, fails the same elements;
//     the rules are project state (serialised by the project codec);
//   - Navigator → Property → colour by a property: the legend lists every
//     value with a count equal to an independent count, "(none)" included,
//     Σ == the visible elements; a numeric property gets the ramp; the 3D
//     meshes carry the legend colours.
//
// Fixture: tests/fixtures/generate-building-ifc.js at ci scale (writes
// Pset_*Common FireRating / IsExternal / LoadBearing / System and
// BaseQuantities) — synthetic geometry only.
//
// Run: CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/property-rules.mjs
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { offlineDepsEnabled, routeOfflineDeps } from './_offline-deps.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const { generateBuilding } = require(join(root, 'tests/fixtures/generate-building-ifc.js'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

let failures = 0;
function ok(msg) { console.log('PROPERTY RULES OK — ' + msg); }
function fail(msg) { console.error('PROPERTY RULES FAIL: ' + msg); failures++; }
function check(cond, msg, detail) { if (cond) ok(msg); else fail(msg + (detail ? ' — ' + detail : '')); }

const gen = generateBuilding({ scale: 'ci', seed: 4242, georef: 'local' });
const files = new Map();
for (const k of Object.keys(gen.files)) files.set('/__gen/' + k + '.ifc', Buffer.from(gen.files[k]));
const server = createServer(async (req, res) => {
  try {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (files.has(p)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(files.get(p)); }
    const file = normalize(join(root, p === '/' ? 'index.html' : p.slice(1)));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-GB', acceptDownloads: true });
await ctx.addInitScript(() => { try { localStorage.setItem('cc_consent_banner_seen', '1'); localStorage.setItem('cc_data_consent', 'denied'); localStorage.setItem('cc_data_consent_explicit', '1'); localStorage.setItem('cc_locale', ''); } catch (e) {} });
if (offlineDepsEnabled()) await routeOfflineDeps(ctx, root);
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// Independent reference: value of Pset.Name on an element (no app code).
const REF = `(p, key) => {
  const i = key.indexOf('.'), ps = key.slice(0, i), nm = key.slice(i + 1);
  if (/^(qto_|basequantities$)/i.test(ps)) { const q = p.quantities || {}; for (const k of Object.keys(q)) if (k.toLowerCase() === nm.toLowerCase() && q[k] != null && String(q[k]).trim()) return String(q[k]).trim(); }
  let v = null; const g = (p.psets || {})[Object.keys(p.psets || {}).find((s) => s.toLowerCase() === ps.toLowerCase())] || {};
  for (const k of Object.keys(g)) if (k.toLowerCase() === nm.toLowerCase() && g[k] != null && String(g[k]).trim()) v = String(g[k]).trim();
  return v;
}`;

try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 120_000 });
  const names = [...files.keys()];
  await page.evaluate(async (names) => {
    const fs = await Promise.all(names.map(async (k) => new File([await (await fetch(k)).arrayBuffer()], k.split('/').pop())));
    window.ClashControl.loadFiles(fs);
  }, names);
  await page.waitForFunction((n) => { const s = window._ccLatestState; return s && s.models.length === n && window._ccModelLoading === false; }, names.length, { timeout: 300_000 });
  await page.waitForFunction(() => typeof window._ccRunPropertyRules === 'function', null, { timeout: 30_000 });

  // ── 1. author two rules through the editor ──
  await page.evaluate(() => window._ccDispatch({ t: 'TAB', v: 'dataquality' }));
  await page.waitForSelector('[data-cc-dq-rules] [data-cc-rule-add]', { timeout: 10_000 });
  async function author(r) {
    await page.click('[data-cc-dq-rules] [data-cc-rule-add]');
    await page.waitForSelector('[data-cc-rule-editor]');
    await page.fill('[data-cc-rule-field=types]', r.types);
    await page.fill('[data-cc-rule-field=prop]', r.prop);
    await page.selectOption('[data-cc-rule-field=op]', r.op);
    if (r.value != null) await page.fill('[data-cc-rule-field=value]', r.value);
    await page.selectOption('[data-cc-rule-field=severity]', r.severity);
    await page.fill('[data-cc-rule-field=stage]', r.stage || '');
    await page.click('[data-cc-rule-save]');
    await page.waitForSelector('[data-cc-rule-editor]', { state: 'detached' });
  }
  // a missing-property rule and a numeric one on a quantity stored with the element
  await author({ types: 'IfcWall', prop: 'Pset_WallCommon.FireRating', op: 'exists', severity: 'critical', stage: 'Stage A' });
  await author({ types: 'IfcWall, IfcSlab', prop: 'BaseQuantities.Width', op: 'gte', value: '0.2', severity: 'minor' });
  const rules = await page.evaluate(() => window._ccLatestState.propertyRules);
  check(rules.length === 2 && rules[0].op === 'exists' && rules[0].severity === 'critical' && rules[0].stage === 'Stage A' && rules[1].appliesTo.join() === 'IfcWall,IfcSlab' && rules[1].value === '0.2',
    'two rules authored through the editor are project state', JSON.stringify(rules));
  check(await page.evaluate(() => { const c = window._ccProjectCodec.serializeProject(window._ccLatestState, 'v', 't'); return JSON.stringify(c.propertyRules) === JSON.stringify(window._ccLatestState.propertyRules); }),
    'the project codec serialises the rules');

  // independent expected failures per rule
  const want = await page.evaluate(({ REF, rules }) => {
    const val = new Function('return ' + REF)();
    const out = {};
    for (const r of rules) {
      const types = r.appliesTo.map((t) => t.toUpperCase());
      const ids = [];
      for (const m of window._ccLatestState.models) for (const el of m.elements) {
        const p = el.props || {};
        if (types.length && !types.includes(String(p.ifcType || '').toUpperCase())) continue;
        const v = val(p, r.prop);
        const pass = r.op === 'exists' ? v != null : (v != null && parseFloat(v) >= parseFloat(r.value));
        if (!pass) ids.push(m.id + ':' + el.expressId);
      }
      out[r.id] = ids.sort();
    }
    return out;
  }, { REF, rules });
  check(want[rules[0].id].length > 0 && want[rules[1].id].length > 0, 'the fixture has failures for both rules (' + want[rules[0].id].length + ', ' + want[rules[1].id].length + ')');

  // ── 2. run → listed with the right counts ──
  await page.evaluate(() => { const b = [...document.querySelectorAll('.cc-left-panel button')].find((x) => /^(Run checks|Re-check)$/.test(x.textContent.trim())); b.click(); });
  await page.waitForSelector('[data-cc-rule-results]', { timeout: 60_000 });
  for (const r of rules) {
    const shown = await page.evaluate((id) => { const e = document.querySelector('[data-cc-rule-results] [data-cc-check="' + id + '"] [data-cc-check-count]'); return e ? +e.getAttribute('data-cc-check-count') : null; }, r.id);
    check(shown === want[r.id].length, 'rule "' + r.prop + '" lists ' + shown + ' failures, independent count ' + want[r.id].length);
  }
  const engine = await page.evaluate((rules) => {
    const els = []; window._ccLatestState.models.forEach((m) => m.elements.forEach((el) => { el._modelId = m.id; els.push(el); }));
    const res = window._ccRunPropertyRules(els, rules), out = {};
    rules.forEach((r) => { out[r.id] = res[r.id].refs.map((x) => x.modelId + ':' + x.expressId).sort(); });
    return out;
  }, rules);
  check(rules.every((r) => JSON.stringify(engine[r.id]) === JSON.stringify(want[r.id])), 'the engine fails exactly the independently computed elements');

  // ── 3. an issue from one rule ──
  const nIssues = await page.evaluate(() => window._ccLatestState.issues.length);
  await page.evaluate((id) => { const row = document.querySelector('[data-cc-rule-results] [data-cc-check="' + id + '"]'); [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '+issue').click(); }, rules[0].id);
  await page.waitForFunction((n) => window._ccLatestState.issues.length === n + 1, nIssues, { timeout: 5000 }).catch(() => {});
  const issue = await page.evaluate(() => window._ccLatestState.issues[window._ccLatestState.issues.length - 1]);
  check(issue && issue.source === 'data_quality' && issue.dqCheck === rules[0].id && issue.priority === 'high' && (issue.qualityGids || []).length === want[rules[0].id].length && issue.title.indexOf('(' + want[rules[0].id].length + ')') > 0,
    'an issue created from the critical rule carries the rule, high priority and all ' + want[rules[0].id].length + ' failing elements', issue && JSON.stringify({ t: issue.title, p: issue.priority, n: (issue.qualityGids || []).length }));

  // ── 4. CSV lists every failing element of both rules ──
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }),
    page.evaluate(() => [...document.querySelectorAll('.cc-left-panel button')].find((x) => x.textContent.trim() === 'Export CSV').click())]);
  const csv = await readFile(await dl.path(), 'utf8');
  const lines = csv.split('\r\n');
  for (const r of rules) {
    const label = await page.evaluate((id) => document.querySelector('[data-cc-dq-rules] [data-cc-rule="' + id + '"] [data-cc-data]').textContent, r.id);
    const n = lines.filter((l) => l.startsWith('"' + label.replace(/"/g, '""') + '"')).length;
    check(n === want[r.id].length, 'CSV has one row per failing element of "' + label + '" (' + n + ')');
  }
  check(lines.some((l) => /"critical"/.test(l)) && lines.some((l) => /"minor"/.test(l)), 'CSV carries the rule severities');

  // ── 5. IDS export of the rules → parse → run fails the same elements ──
  const [idsDl] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }),
    page.evaluate(() => [...document.querySelectorAll('[data-cc-dq-rules] button')].find((x) => x.textContent.trim() === 'Export as IDS').click())]);
  const idsXml = await readFile(await idsDl.path(), 'utf8');
  const viaIds = await page.evaluate((xml) => {
    const parsed = window._ccParseIDS(xml), out = {};
    for (const sp of parsed.specs) {
      const r = window._ccRunIDS([sp], window._ccLatestState.models);
      out[sp.identifier] = r.results.map((x) => x.modelId + ':' + x.elementId).sort();
    }
    return { n: parsed.specs.length, out };
  }, idsXml);
  check(viaIds.n === 2 && rules.every((r) => JSON.stringify(viaIds.out[r.id]) === JSON.stringify(want[r.id])), 'the exported IDS (rules only) fails the same elements in the IDS engine');

  // ── 6. colour by property: legend counts == elements ──
  async function colourBy(key) {
    await page.evaluate(() => window._ccDispatch({ t: 'TAB', v: 'navigator' }));
    await page.waitForSelector('[data-cc-nav-view=byProperty]', { timeout: 10_000 });
    await page.click('[data-cc-nav-view=byProperty]');
    await page.waitForSelector('[data-cc-prop-key]');
    await page.selectOption('[data-cc-prop-key]', key);
    const pressed = await page.getAttribute('[data-cc-prop-color-btn]', 'aria-pressed');
    if (pressed !== 'true') await page.click('[data-cc-prop-color-btn]');
    await page.waitForSelector('[data-cc-color-legend=byProperty] [data-cc-legend-count]', { timeout: 10_000 });
    await page.waitForTimeout(300);
    const legend = await page.evaluate(() => [...document.querySelectorAll('[data-cc-color-legend=byProperty] [data-cc-legend-count]')].map((e) => ({ v: e.getAttribute('data-cc-legend-value'), n: +e.getAttribute('data-cc-legend-count'), bg: getComputedStyle(e.querySelector('[data-cc-swatch]')).backgroundColor })));
    const ref = await page.evaluate(({ REF, key }) => {
      const val = new Function('return ' + REF)();
      const by = {}; let none = 0, total = 0;
      for (const m of window._ccLatestState.models) { if (m.visible === false) continue; for (const el of m.elements) { total++; const v = val(el.props || {}, key); if (v == null) none++; else by[v] = (by[v] || 0) + 1; } }
      return { by, none, total };
    }, { REF, key });
    return { legend, ref };
  }
  const cat = await colourBy('Pset_WallCommon.FireRating');
  const catNone = cat.legend.find((x) => x.v === '');
  const catVals = cat.legend.filter((x) => x.v !== '');
  check(catVals.length === Object.keys(cat.ref.by).length && catVals.every((x) => cat.ref.by[x.v] === x.n),
    'categorical legend: every value with its element count (' + catVals.map((x) => x.v + ' ' + x.n).join(', ') + ')');
  check(catNone && catNone.n === cat.ref.none, '"(none)" counts the elements without the property (' + (catNone && catNone.n) + ')');
  check(cat.legend.reduce((a, x) => a + x.n, 0) === cat.ref.total, 'legend counts add up to the visible elements (' + cat.ref.total + ')');
  const amber = (c) => { const m = c.match(/\d+/g).map(Number); const [r, g, b] = m.map((x) => x / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx - mn < 0.25 || mx !== r) return false; const h = (60 * ((g - b) / (mx - mn)) + 360) % 360; return h >= 20 && h <= 65; };
  check(!cat.legend.some((x) => amber(x.bg)), 'no amber / orange / yellow in the property palette');
  // 3D: meshes of a valued element carry the legend colour
  const meshOk = await page.evaluate(({ REF, key, legend }) => {
    const val = new Function('return ' + REF)();
    const S = window._ccState3d, colours = {};
    legend.forEach((x) => { const m = x.bg.match(/\d+/g).map(Number); colours[x.v] = ((m[0] << 16) | (m[1] << 8) | m[2]); });
    const byKey = {};
    for (const m of window._ccLatestState.models) for (const el of m.elements) byKey[m.id + '_' + el.expressId] = val(el.props || {}, key);
    let seen = 0, okN = 0;
    S.mg.traverse((o) => {
      if (!o.isMesh || !o.material || o.isBatchedMesh || o.isInstancedMesh || o.userData._ccSpace) return;
      const mid = o.parent && o.parent.userData.modelId, eid = o.userData.expressId;
      if (eid == null || !mid) return;
      const v = byKey[mid + '_' + eid];
      if (v == null || colours[v] == null) return;
      seen++;
      if (o.material.color.getHex() === colours[v]) okN++;
    });
    return { seen, okN };
  }, { REF, key: 'Pset_WallCommon.FireRating', legend: cat.legend });
  check(meshOk.seen === 0 || meshOk.okN === meshOk.seen, '3D meshes with a value carry its legend colour (' + meshOk.okN + '/' + meshOk.seen + ')');

  const num = await colourBy('BaseQuantities.Width');
  check(num.legend.reduce((a, x) => a + x.n, 0) === num.ref.total, 'numeric legend counts add up to the visible elements (' + num.ref.total + ')');
  const numNone = num.legend.find((x) => x.v === '');
  check(numNone && numNone.n === num.ref.none, 'numeric "(none)" count matches (' + (numNone && numNone.n) + ')');
  const valued = Object.values(num.ref.by).reduce((a, b) => a + b, 0);
  check(num.legend.filter((x) => x.v !== '').reduce((a, x) => a + x.n, 0) === valued && num.legend.length - 1 <= 8, 'numeric values grouped into at most 8 ramp steps');
  check(!num.legend.some((x) => amber(x.bg)), 'no amber in the numeric ramp');

  // clearing restores the scene
  await page.click('[data-cc-prop-color-btn]');
  await page.waitForFunction(() => !document.querySelector('[data-cc-color-legend]') && window._ccLatestState.colorByClass === null, null, { timeout: 5000 }).catch(() => {});
  check(await page.evaluate(() => window._ccLatestState.colorByClass === null && !document.querySelector('[data-cc-color-legend]')), 'pressing Colour again clears it');
  check(pageErrors.length === 0, 'no page errors', pageErrors.join(' | '));
} catch (e) {
  fail('harness: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('PROPERTY RULES: all checks passed');
