#!/usr/bin/env node
// Intersection exceptions and "A requires B" (docs/INTERNALS.md §9
// "Intersection exceptions"): rules.exceptions files straight MEP
// penetrations and flush fittings in their own review buckets and marks
// structural penetrations without an opening / provision — post-
// classification on the final clash list, so:
//   - with every rule off the result is exactly today's (no key, or an
//     explicit all-off object, give the identical list);
//   - with the rules on, the planted cases land where their manifest says,
//     and nothing else about any clash changes;
//   - every narrow-phase path (JS, stateless WASM, cached WASM Engine, worker
//     pool on JS and on WASM) gives the identical annotated list;
//   - the bucket bar counts the new buckets (Σ == raw) and shows them in one
//     click; the run modal has the "Exceptions and required provisions" rows.
//
// Fixture: tests/fixtures/generate-building-ifc.js at ci scale with the
// opt-in planted cases (penetrations: true) — synthetic geometry only.
//
// Run: CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/penetration-rules.mjs
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
function ok(msg) { console.log('PENETRATION RULES OK — ' + msg); }
function fail(msg) { console.error('PENETRATION RULES FAIL: ' + msg); failures++; }
function check(cond, msg, detail) { if (cond) ok(msg); else fail(msg + (detail ? ' — ' + detail : '')); }

const gen = generateBuilding({ scale: 'ci', seed: 4242, georef: 'local', penetrations: true });
const planted = gen.manifest.cases.filter((c) => c.exceptions);
if (planted.length !== 5) { console.error('fixture: expected 5 planted exception cases, got ' + planted.length); process.exit(1); }
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
const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(() => { try { localStorage.setItem('cc_consent_banner_seen', '1'); localStorage.setItem('cc_data_consent', 'denied'); localStorage.setItem('cc_data_consent_explicit', '1'); } catch (e) {} });
if (offlineDepsEnabled()) await routeOfflineDeps(ctx, root);
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const BASE = { hard: true, maxGap: 50, minGap: 0, excludeSameDiscipline: false, selfClashModels: 'none', fullRerun: true };
const OFF = { penetration: { on: false }, fitting: { on: false }, requireProvision: { on: false } };
const SETS = {
  none: undefined,
  off: OFF,
  penetration: { ...OFF, penetration: { on: true, minProtrusionMm: 20, angleDeg: 5 } },
  fitting: { ...OFF, fitting: { on: true, flushMm: 20 } },
  require: { ...OFF, requireProvision: { on: true, withinMm: 50 } },
  require20: { ...OFF, requireProvision: { on: true, withinMm: 20 } },
  all: { penetration: { on: true, minProtrusionMm: 20, angleDeg: 5 }, fitting: { on: true, flushMm: 20 }, requireProvision: { on: true, withinMm: 50 } },
};

try {
  await page.goto(`http://127.0.0.1:${port}/?ccSafety=detectWorkerPool`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 120_000 });
  await page.evaluate(() => window._ccDispatch({ t: 'UPD_PREFS', u: { preRunDontAsk: true } }));
  const names = [...files.keys()];
  await page.evaluate(async (names) => {
    const fs = await Promise.all(names.map(async (k) => new File([await (await fetch(k)).arrayBuffer()], k.split('/').pop())));
    window.ClashControl.loadFiles(fs);
  }, names);
  await page.waitForFunction((n) => { const s = window._ccLatestState; return s && s.models.length === n && window._ccModelLoading === false; }, names.length, { timeout: 300_000 });
  await page.waitForFunction(() => typeof window._ccWasmIntersect === 'function' && window._ccWasmEngine, null, { timeout: 60_000 })
    .catch(() => fail('WASM narrow phase / cached engine never became ready'));

  // runs: every path with the rules off (no key) and all on; the single-rule
  // sets on the JS path. Results serialized without the run-varying fields.
  const runs = await page.evaluate(async ({ BASE, SETS }) => {
    const orig = { _ccWasmIntersect: window._ccWasmIntersect, _ccWasmMinDist: window._ccWasmMinDist, _ccWasmBatchIntersect: window._ccWasmBatchIntersect, _ccWasmEngine: window._ccWasmEngine };
    function setMode(mode) {
      for (const k of Object.keys(orig)) { if (orig[k]) window[k] = orig[k]; else delete window[k]; }
      const P = window._ccNarrowPool;
      P.disabled = !mode.startsWith('pool'); P.minCandidates = 0; P.minCandidatesHardOnly = 0; P.forceJs = false; P.maxWorkers = 0;
      if (mode === 'js' || mode === 'pool-js') { for (const k of Object.keys(orig)) delete window[k]; P.forceJs = mode === 'pool-js'; }
      else if (mode === 'wasm') delete window._ccWasmEngine;
    }
    const ser = (res) => (res || []).map((c) => JSON.stringify(c, (k, v) => (k === 'id' || k === 'createdAt' ? undefined : v)));
    async function run(set) {
      const r = Object.assign({}, BASE, { exceptions: SETS[set] });
      const res = await window.ClashControl.runDetection(r);
      return { clashes: ser(res), pool: window._ccNarrowPool.last, counts: res && res._ccExceptions || null };
    }
    const out = {};
    for (const mode of ['js', 'wasm', 'engine', 'pool-js', 'pool']) {
      setMode(mode);
      out[mode + ':none'] = await run('none');
      out[mode + ':all'] = await run('all');
    }
    setMode('js');
    for (const set of ['off', 'penetration', 'fitting', 'require', 'require20']) out['js:' + set] = await run(set);
    setMode('engine');
    return out;
  }, { BASE, SETS });

  // 1. off == today, on every path
  const ref = runs['js:none'].clashes;
  check(ref.length > 0 && runs['js:off'].clashes.length === ref.length && runs['js:off'].clashes.every((c, i) => c === ref[i]),
    'rules off (explicit all-off object) gives exactly the list without the key (' + ref.length + ' clashes)');
  check(!ref.some((s) => /"exception"|"missingProvision"/.test(s)), 'rules off: no clash carries an annotation');
  for (const mode of ['wasm', 'engine', 'pool-js', 'pool']) {
    for (const set of ['none', 'all']) {
      const a = runs['js:' + set].clashes, b = runs[mode + ':' + set].clashes;
      check(a.length === b.length && b.every((c, i) => c === a[i]),
        'path "' + mode + '" with rules ' + (set === 'none' ? 'off' : 'on') + ' reports exactly what the JS path does (' + a.length + ' clashes)' + (mode.startsWith('pool') ? ' — pool used: ' + !!(runs[mode + ':' + set].pool && runs[mode + ':' + set].pool.used) : ''));
    }
  }
  check(runs['pool:all'].pool && runs['pool:all'].pool.used && runs['pool-js:all'].pool && runs['pool-js:all'].pool.used, 'the worker pool really ran the pairs');

  // 2. with the rules on, nothing but the annotation changes
  const strip = (s) => { const o = JSON.parse(s); delete o.exception; delete o.missingProvision; return JSON.stringify(o); };
  for (const set of ['penetration', 'fitting', 'require', 'require20', 'all']) {
    const a = runs['js:' + set].clashes;
    check(a.length === ref.length && a.every((c, i) => strip(c) === ref[i]), 'rules "' + set + '": same clashes, same fields — only exception / missingProvision added');
  }

  // 3. the planted cases land where the manifest says
  const buckets = await page.evaluate(({ runs, SETS, BASE, planted }) => {
    const core = window._ccClashClassificationCore, out = {};
    for (const set of ['none', 'penetration', 'fitting', 'require', 'require20', 'all']) {
      const list = runs['js:' + set].clashes.map((s) => JSON.parse(s));
      const rules = Object.assign({}, BASE, { exceptions: SETS[set] });
      out[set] = planted.map((p) => {
        const hit = list.filter((c) => (c.elemAName === p.a.name && c.elemBName === p.b.name) || (c.elemAName === p.b.name && c.elemBName === p.a.name));
        return hit.map((c) => ({ type: c.type, bucket: core.reviewBucket(c, rules), exception: c.exception || null, missing: !!c.missingProvision, opening: c.opening || null }));
      });
      const counts = core.bucketCounts(list, rules);
      out[set + ':sum'] = Object.values(counts).reduce((a, b) => a + b, 0) === list.length;
    }
    return out;
  }, { runs, SETS, BASE, planted });
  planted.forEach((p, i) => {
    const e = p.exceptions, got = (set) => buckets[set][i];
    const one = (set) => got(set).length === 1 ? got(set)[0] : null;
    check(got('none').length === 1, p.id + ' "' + p.name + '": one clash', JSON.stringify(got('none')));
    if (!one('none')) return;
    check(one('none').bucket === e.off, p.id + ' rules off -> ' + e.off, JSON.stringify(one('none')));
    check(one('penetration').bucket === e.penetration, p.id + ' straight-penetration exception on -> ' + e.penetration, JSON.stringify(one('penetration')));
    check(one('fitting').bucket === e.fitting, p.id + ' flush-fitting exception on -> ' + e.fitting, JSON.stringify(one('fitting')));
    check(one('require').missing === e.missingProvision && (!e.missingProvision || one('require').bucket === 'review'),
      p.id + ' required provision (50 mm): ' + (e.missingProvision ? 'missing, stays in review' : 'present'), JSON.stringify(one('require')));
    check(one('require20').missing === !!(e.missingProvision || e.missingWithinMm20), p.id + ' required provision (20 mm): ' + ((e.missingProvision || e.missingWithinMm20) ? 'missing' : 'present'), JSON.stringify(one('require20')));
    const allExp = e.missingProvision ? 'review' : (e.penetration !== e.off ? e.penetration : e.fitting);
    check(one('all').bucket === allExp, p.id + ' every rule on -> ' + allExp + ' (a missing provision wins over the exception)', JSON.stringify(one('all')));
  });
  for (const set of Object.keys(buckets).filter((k) => k.endsWith(':sum'))) check(buckets[set], 'bucket counts add up to the raw total (' + set.replace(':sum', '') + ')');
  const cAll = runs['js:all'].counts || {};
  check(cAll.penetration >= 2 && cAll.fitting >= 1 && cAll.missingProvision >= 2, 'run reports its annotation counts', JSON.stringify(cAll));

  // 4. UI: bucket bar shows the new buckets with counts, one click shows them;
  // the missing-provision tag gives a suggested view; run modal rows
  const ui = await page.evaluate(async ({ BASE, SETS }) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window._ccDispatch({ t: 'UPD_RULES', u: { exceptions: SETS.all } });
    await window.ClashControl.runDetection(Object.assign({}, BASE, { exceptions: SETS.all }));
    window._ccDispatch({ t: 'TAB', v: 'clashes' });
    await wait(700);
    const st = window._ccLatestState, core = window._ccClashClassificationCore;
    const pen = document.querySelector('[data-cc-bucket="penetration"]'), fit = document.querySelector('[data-cc-bucket="fitting"]');
    const out = { penText: pen && pen.textContent, fitText: fit && fit.textContent, pressedBefore: pen && pen.getAttribute('aria-pressed') };
    const penIds = st.clashes.filter((c) => core.reviewBucket(c, st.rules) === 'penetration').map((c) => c.id);
    out.penCount = penIds.length;
    out.inReviewBefore = window.ClashControl.review.summary().items.some((i) => i.ids.some((id) => penIds.indexOf(id) !== -1));
    if (pen) pen.click();
    await wait(400);
    const pen2 = document.querySelector('[data-cc-bucket="penetration"]');
    out.pressedAfter = pen2 && pen2.getAttribute('aria-pressed');
    out.showBuckets = (window._ccLatestState.filters.showBuckets || []).slice();
    out.missingTag = !!document.querySelector('[data-cc-missing-provision]') || st.clashes.some((c) => c.missingProvision);
    const tcore = window._ccClashTriageCore;
    out.view = !!(tcore && tcore.SUGGESTED.find((v) => v.id === 'missing-provision'));
    // run modal
    window._ccDispatch({ t: 'SHOW_RUN_MODAL', v: true });
    await wait(400);
    const adv = [...document.querySelectorAll('button')].find((b) => /Show advanced/.test(b.getAttribute('title') || ''));
    if (adv) adv.click();
    await wait(300);
    const disc = [...document.querySelectorAll('[data-cc-disclosure] > button')].find((b) => /Exceptions and required provisions/.test(b.textContent));
    out.disclosure = !!disc;
    if (disc && disc.getAttribute('aria-expanded') !== 'true') disc.click();
    await wait(300);
    const box = document.querySelector('[data-cc-exceptions]');
    out.rows = box ? box.querySelectorAll('[data-cc-exception]').length : 0;
    out.inputs = box ? box.querySelectorAll('input[type=number]').length : 0;
    const sw = box && box.querySelector('[data-cc-exception="fitting"] [role=switch]');
    if (sw) sw.click();
    await wait(200);
    out.fittingAfterToggle = window._ccLatestState.rules.exceptions && window._ccLatestState.rules.exceptions.fitting.on;
    window._ccDispatch({ t: 'SHOW_RUN_MODAL', v: false });
    return out;
  }, { BASE, SETS });
  check(/straight penetrations/.test(ui.penText || '') && /fittings set flush/.test(ui.fitText || ''), 'bucket bar shows the new buckets with their counts', JSON.stringify(ui));
  check(ui.penCount > 0 && !ui.inReviewBefore && ui.pressedBefore === 'false', 'penetrations are filed out of the review list by default');
  check(ui.pressedAfter === 'true' && ui.showBuckets.indexOf('penetration') !== -1, 'one click shows the penetration bucket', JSON.stringify({ pressed: ui.pressedAfter, show: ui.showBuckets }));
  check(ui.missingTag && ui.view, 'missing provisions are marked and have a suggested view');
  check(ui.disclosure && ui.rows === 3 && ui.inputs === 4, 'run modal: "Exceptions and required provisions" with three rules and their values (4 fields while all are on)', JSON.stringify({ d: ui.disclosure, rows: ui.rows, inputs: ui.inputs }));
  check(ui.fittingAfterToggle === false, 'a rule toggles from the run modal');
  if (pageErrors.length) fail('page errors: ' + pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  fail('harness: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('PENETRATION RULES: all checks passed');
