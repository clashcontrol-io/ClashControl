#!/usr/bin/env node
// Coordination matrix v2 (docs/INTERNALS.md §9 "Coordination matrix"): one
// cell = one rule (rules.matrixRules). On the synthetic CI federation:
//   * a structure × MEP cell set to clearance 100 mm finds the extra
//     structure × MEP clearances — exactly the structure × MEP soft clashes a
//     global 100 mm run finds, and nothing for other pairs — and the result is
//     identical on every narrow-phase path (JS, stateless WASM, cached WASM
//     Engine, worker pool on JS and on WASM);
//   * the cell set to off drops every structure × MEP clash and leaves the
//     rest untouched;
//   * a cell severity becomes the severity of that pair's clashes.
//
// Run: CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/matrix-rules.mjs
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
function ok(msg) { console.log('MATRIX RULES OK — ' + msg); }
function fail(msg) { console.error('MATRIX RULES FAIL: ' + msg); failures++; }
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
const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await ctx.addInitScript(() => { try { localStorage.setItem('cc_consent_banner_seen', '1'); localStorage.setItem('cc_data_consent', 'denied'); localStorage.setItem('cc_data_consent_explicit', '1'); } catch (e) {} });
if (offlineDepsEnabled()) await routeOfflineDeps(ctx, root);
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const BASE = { hard: true, maxGap: 0, minGap: 0, selfClashModels: 'none', fullRerun: true };
const CELL = 'mep:structural';
function isStructMep(c) {
  const t = c.trades || [];
  const tops = t.map((x) => String(x || '').split('.')[0]).sort().join(':');
  return tops === 'mep:structural';
}
// what makes a clash the same finding across runs (ids, cluster groups and
// the run-wide classification aside)
function key(c) { return [c.elemA, c.elemB, c.modelAId, c.modelBId, c.type, c.distance, (c.point || []).join(',')].join('|'); }

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

  const runs = await page.evaluate(async ({ BASE, CELL }) => {
    const orig = { _ccWasmIntersect: window._ccWasmIntersect, _ccWasmMinDist: window._ccWasmMinDist, _ccWasmBatchIntersect: window._ccWasmBatchIntersect, _ccWasmEngine: window._ccWasmEngine };
    function setMode(mode) {
      for (const k of Object.keys(orig)) { if (orig[k]) window[k] = orig[k]; else delete window[k]; }
      const P = window._ccNarrowPool;
      P.disabled = !mode.startsWith('pool'); P.minCandidates = 0; P.minCandidatesHardOnly = 0; P.forceJs = false; P.maxWorkers = 0;
      if (mode === 'js' || mode === 'pool-js') { for (const k of Object.keys(orig)) delete window[k]; P.forceJs = mode === 'pool-js'; }
      else if (mode === 'wasm') delete window._ccWasmEngine;
    }
    const strip = (res) => (res || []).map((c) => JSON.stringify(c, (k, v) => (k === 'id' || k === 'createdAt' ? undefined : v)));
    async function run(rules) {
      const res = await window.ClashControl.runDetection(Object.assign({}, BASE, rules));
      return strip(res);
    }
    const out = { cell: {} };
    const clearanceCell = { matrixRules: { [CELL]: { mode: 'clearance', gapMm: 100, severity: null, note: '' } } };
    for (const mode of ['js', 'wasm', 'engine', 'pool-js', 'pool']) {
      setMode(mode);
      out.cell[mode] = { clashes: await run(clearanceCell), pool: window._ccNarrowPool.last };
    }
    setMode('engine');
    out.base = await run({});
    out.global100 = await run({ maxGap: 100 });
    out.off = await run({ matrixRules: { [CELL]: { mode: 'off', gapMm: null, severity: null, note: '' } } });
    // the committed result is classified in place (state follows on the next render)
    const sevRes = await window.ClashControl.runDetection(Object.assign({}, BASE, { matrixRules: { [CELL]: { mode: 'clearance', gapMm: 100, severity: 'critical', note: '' } } }));
    out.sev = (sevRes || []).map((c) => ({ trades: c.trades, type: c.type, sev: c.aiSeverity, src: c._sevSource }));
    return out;
  }, { BASE, CELL });

  const ref = runs.cell.js.clashes;
  for (const mode of ['wasm', 'engine', 'pool-js', 'pool']) {
    const same = runs.cell[mode].clashes.length === ref.length && runs.cell[mode].clashes.every((c, i) => c === ref[i]);
    check(same, 'clearance cell: path "' + mode + '" reports exactly what the JS path does (' + ref.length + ' clashes)' + (mode.startsWith('pool') ? ' — pool used: ' + !!(runs.cell[mode].pool && runs.cell[mode].pool.used) : ''));
  }
  check(runs.cell.pool.pool && runs.cell.pool.pool.used && runs.cell['pool-js'].pool && runs.cell['pool-js'].pool.used, 'the worker pool really ran the pairs', JSON.stringify({ pool: runs.cell.pool.pool, poolJs: runs.cell['pool-js'].pool }));

  const cell = ref.map((s) => JSON.parse(s));
  const base = runs.base.map((s) => JSON.parse(s));
  const g100 = runs.global100.map((s) => JSON.parse(s));
  const off = runs.off.map((s) => JSON.parse(s));
  const softCell = cell.filter((c) => c.type === 'soft');
  check(base.filter((c) => c.type === 'soft').length === 0, 'baseline (max gap 0) has no clearance clashes');
  check(softCell.length > 0 && softCell.every(isStructMep), 'the cell finds extra clearances, all structure × MEP (' + softCell.length + ')',
    JSON.stringify(softCell.filter((c) => !isStructMep(c)).slice(0, 3).map((c) => c.trades)));
  check(softCell.every((c) => c.requiredClearanceMm === 100 && Math.abs(c.distance) <= 100), 'each carries the cell clearance (required 100 mm, gap within it)');
  // structure × MEP: exactly what a global 100 mm run finds for those pairs
  // (clearances, and the contacts a clearance run reports); every other pair
  // exactly as the baseline
  const keysOf = (arr, pred) => arr.filter(pred).map(key).sort();
  const kc = keysOf(cell, isStructMep), kw = keysOf(g100, isStructMep);
  check(kc.length === kw.length && kc.every((k, i) => k === kw[i]), 'structure × MEP findings = those of a global 100 mm run (' + kw.length + ')', 'cell ' + kc.length + ' vs global ' + kw.length);
  const ko = keysOf(cell, (c) => !isStructMep(c)), kb = keysOf(base, (c) => !isStructMep(c));
  check(ko.length === kb.length && ko.every((k, i) => k === kb[i]), 'every other pair exactly as without the cell (' + kb.length + ')');
  check(keysOf(cell, (c) => c.type === 'hard').join() === keysOf(base, (c) => c.type === 'hard').join(), 'hard clashes unchanged by a clearance cell');

  const baseStructMep = base.filter(isStructMep);
  check(baseStructMep.length > 0, 'the baseline has structure × MEP clashes to drop (' + baseStructMep.length + ')');
  check(off.length > 0 && !off.some(isStructMep), 'an off cell drops every structure × MEP clash');
  const rest = (arr) => arr.filter((c) => !isStructMep(c)).map(key).sort().join('\n');
  check(rest(off) === rest(base), 'an off cell leaves every other pair as it was (' + off.length + ')');

  const sevPair = runs.sev.filter((c) => isStructMep(c) && (c.type === 'hard' || c.type === 'soft'));
  check(sevPair.length > 0 && sevPair.every((c) => c.sev === 'critical' && c.src === 'rule'), 'a cell severity is the severity of that pair\'s clashes (rule-derived, ' + sevPair.length + ')',
    JSON.stringify(sevPair.filter((c) => c.sev !== 'critical').slice(0, 3)));
  const otherSev = runs.sev.filter((c) => !isStructMep(c));
  check(otherSev.length === 0 || otherSev.some((c) => c.sev !== 'critical'), 'other pairs keep their own severity');

  if (pageErrors.length) fail('page errors: ' + pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  fail('harness: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('MATRIX RULES: all checks passed');
