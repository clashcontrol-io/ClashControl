// Trends per discipline pair / severity / assignee (docs/INTERNALS.md §21.60), in the real app.
//
// On a generated architecture + structure + MEP federation
// (tests/fixtures/generate-building-ifc.js, scale ci, seed 4242, synthetic only):
//   (a) a first run writes a history entry with breakdowns whose per-pair
//       totals equal the clash list's "Trades" facet counts and add up to the run;
//   (b) statuses / assignees are changed, the MEP file is reloaded with one
//       element moved and a second run commits: its entry's per-pair
//       total / open / new / resolved equal the clash list (counted again from
//       state.clashes) and the clash list's Trades facet;
//   (c) the Trends view (clash panel → Trends): one card per pair with an
//       aria-label carrying the numbers, the Table view shows the same numbers
//       as the clash list, a click on a pair filters the list by it (and the
//       card says so), a second click clears it;
//   (d) Export history (CSV / JSON): header, one run row per run, one row per
//       pair of the last run with the list's numbers;
//   (e) an old history entry without breakdowns (an older project file) still
//       loads and renders (note + gaps, no page error).
//
// Run: CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/run-trends.mjs
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
function fail(msg) { console.error('RUN-TRENDS FAIL: ' + msg); failures++; }
function ok(msg) { console.log('RUN-TRENDS OK — ' + msg); }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const gen = generateBuilding({ scale: 'ci', seed: 4242, georef: 'local' });
const files = new Map();
for (const k of ['structure', 'mep', 'architecture']) files.set('/__gen/' + k, Buffer.from(gen.files[k]));

// The MEP file with ONE product moved (same technique as auto-rerun.mjs /
// rerun-cost.mjs): a new placement relative to its own, appended entities.
function movedVariant(text, expressId, dx) {
  const lines = text.split('\n');
  const re = new RegExp('^#' + expressId + '=IFC[A-Z]+\\(');
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) throw new Error('product #' + expressId + ' not found');
  const m = lines[i].match(/^(#\d+=IFC[A-Z]+\('[^']*',[^,]*,'[^']*',[^,]*,[^,]*,)(#\d+)(,.*)$/);
  if (!m) throw new Error('cannot parse product line: ' + lines[i]);
  let max = 0;
  for (const l of lines) { const n = /^#(\d+)=/.exec(l); if (n) max = Math.max(max, +n[1]); }
  const pt = max + 1, ax = max + 2, lp = max + 3;
  lines[i] = m[1] + '#' + lp + m[3];
  const add = [`#${pt}=IFCCARTESIANPOINT((${dx.toFixed(4)},${dx.toFixed(4)},${dx.toFixed(4)}));`, `#${ax}=IFCAXIS2PLACEMENT3D(#${pt},$,$);`, `#${lp}=IFCLOCALPLACEMENT(${m[2]},#${ax});`];
  const end = lines.findIndex((l) => l.trim() === 'ENDSEC;' && lines.slice(0, lines.indexOf(l)).some((x) => x.trim() === 'DATA;'));
  lines.splice(end, 0, ...add);
  return lines.join('\n');
}

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
const pageErrors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  if (offlineDepsEnabled()) await routeOfflineDeps(context, root);
  await context.addInitScript(() => { try { localStorage.setItem('cc_welcome_seen', '1'); localStorage.setItem('cc_tour_done', '1'); localStorage.setItem('cc_consent_banner_seen', '1'); } catch (e) {} });
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  // ?ccRenderCount=1 exposes window.__ccReference.facets: the clash list's facet counts
  await page.goto(`http://127.0.0.1:${port}/?ccRenderCount=1`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccLatestState && window._ccClashHistoryCore, null, { timeout: 60_000 });

  await page.evaluate(() => {
    window.__rt = {
      async load(list) {
        const fs = await Promise.all(list.map(async ([p, name]) => new File([await (await fetch(p)).arrayBuffer()], name)));
        window.ClashControl.loadFiles(fs);
      },
      // the clash list counted again from state.clashes, per Trades facet key
      fromList() {
        const s = window._ccLatestState, T = window._ccClashTriageCore;
        const ctx = { trade: (c, side) => { const i = side === 'A' ? 0 : 1; return (c.trades && c.trades[i]) || (c.disciplines && c.disciplines[i]) || 'other'; } };
        const out = {};
        for (const c of s.clashes) {
          const k = T.facetValues(c, ctx).trade;
          const o = out[k] || (out[k] = { total: 0, open: 0, new: 0, resolved: 0 });
          o.total++;
          if (c.status === 'open' || c.status === 'in_progress') o.open++;
          if (c._delta === 'new') o.new++;
          if (c._delta === 'auto_resolved') o.resolved++;
        }
        return out;
      },
      facetTrade() { return window.__ccReference.facets(window._ccLatestState).trade; },
      last() { const h = window._ccLatestState.runHistory; return h[h.length - 1]; },
    };
  });
  const waitModels = (n) => page.waitForFunction((n) => {
    const s = window._ccLatestState;
    return s && s.models.length === n && s.models.every((m) => (m.elements || []).length > 0) && window._ccModelLoading === false;
  }, n, { timeout: 180_000, polling: 300 });
  const sortObj = (o) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));

  // ── (a) first run ──
  await page.evaluate(() => {
    window._ccDispatch({ t: 'UPD_PREFS', u: { autoRerun: 'off', preRunDontAsk: true } });
    window._ccDispatch({ t: 'UPD_RULES', u: { excludeSameDiscipline: false, selfClashModels: 'none', hard: true, minGap: 0, maxGap: 50 } });
  });
  await page.evaluate(() => window.__rt.load([['/__gen/architecture', 'building-architecture.ifc'], ['/__gen/structure', 'building-structure.ifc'], ['/__gen/mep', 'building-mep.ifc']]));
  await waitModels(3);
  const r1 = await page.evaluate(async () => {
    const res = await window.ClashControl.runDetection({});
    await new Promise((r) => setTimeout(r, 300));
    return { rows: res.length, entry: window.__rt.last(), list: window.__rt.fromList(), facet: window.__rt.facetTrade(), n: window._ccLatestState.clashes.length };
  });
  console.log(`run 1: ${r1.n} clashes, ${Object.keys(r1.entry.byPair || {}).length} discipline pairs`);
  if (r1.n < 10) fail('fixture too small: ' + r1.n + ' clashes');
  if (r1.entry.v !== 1 || !r1.entry.byPair || !r1.entry.bySeverity || !r1.entry.byAssignee || !r1.entry.byBucket) fail('run 1 entry has no breakdowns: ' + JSON.stringify(Object.keys(r1.entry)));
  else {
    const sum = (m) => Object.values(m).reduce((a, v) => a + (typeof v === 'number' ? v : v.total), 0);
    if (sum(r1.entry.byPair) !== r1.entry.total || sum(r1.entry.bySeverity) !== r1.entry.total || sum(r1.entry.byBucket) !== r1.entry.total) fail('run 1 breakdowns do not add up to ' + r1.entry.total);
    else ok(`run 1 breakdowns add up to the run (${r1.entry.total}) per pair / severity / bucket`);
    if (!same(sortObj(r1.entry.byPair), sortObj(r1.list))) fail('run 1 per-pair numbers differ from the clash list: ' + JSON.stringify({ entry: r1.entry.byPair, list: r1.list }));
    const ft = Object.fromEntries(Object.entries(r1.entry.byPair).map(([k, v]) => [k, v.total]));
    if (!same(sortObj(ft), sortObj(r1.facet))) fail('run 1 per-pair totals differ from the Trades facet: ' + JSON.stringify({ entry: ft, facet: r1.facet }));
    else ok('run 1 per-pair numbers == clash list == Trades facet (' + Object.keys(ft).length + ' pairs)');
  }

  // ── (b) statuses / assignees changed, one MEP element moved, second run ──
  const pick = await page.evaluate(() => {
    const s = window._ccLatestState, mep = s.models.find((m) => /mep/i.test(m.name));
    const ids = new Set(mep.elements.map((e) => e.expressId));
    const counts = new Map();
    for (const c of s.clashes) for (const [mid, id] of [[c.modelAId, c.elemA], [c.modelBId, c.elemB]]) if (mid === mep.id && ids.has(id)) counts.set(id, (counts.get(id) || 0) + 1);
    let best = null, bn = Infinity;
    for (const [id, n] of counts) if (n < bn) { bn = n; best = id; }
    // statuses: the first 3 clashes in progress for "Ann", the next 2 for "Bob", one resolved
    const cl = s.clashes.slice(0, 6);
    cl.slice(0, 3).forEach((c) => window._ccDispatch({ t: 'UPD_CLASH', id: c.id, u: { status: 'in_progress', assignee: 'Ann' } }));
    cl.slice(3, 5).forEach((c) => window._ccDispatch({ t: 'UPD_CLASH', id: c.id, u: { assignee: 'Bob' } }));
    if (cl[5]) window._ccDispatch({ t: 'UPD_CLASH', id: cl[5].id, u: { status: 'resolved' } });
    return best == null ? mep.elements[0].expressId : best;
  });
  files.set('/__gen/mep-moved', Buffer.from(movedVariant(Buffer.from(gen.files.mep).toString('latin1'), pick, 0.5), 'latin1'));
  await page.evaluate(() => window.__rt.load([['/__gen/mep-moved', 'building-mep.ifc']]));
  await page.waitForFunction(() => !window._ccModelLoading, null, { timeout: 180_000, polling: 300 });
  await waitModels(3);
  const r2 = await page.evaluate(async () => {
    await window.ClashControl.runDetection({});
    await new Promise((r) => setTimeout(r, 300));
    const s = window._ccLatestState;
    return { entry: window.__rt.last(), list: window.__rt.fromList(), facet: window.__rt.facetTrade(), runs: s.runHistory.length,
      open: s.clashes.filter((c) => c.status === 'open' || c.status === 'in_progress').length, n: s.clashes.length };
  });
  console.log('run 2 entry:', JSON.stringify({ total: r2.entry.total, open: r2.entry.open, newCount: r2.entry.newCount, autoResolved: r2.entry.autoResolved, byAssignee: r2.entry.byAssignee }));
  if (r2.runs !== 2) fail('expected 2 history entries, got ' + r2.runs);
  if (!(r2.entry.newCount > 0 || r2.entry.autoResolved > 0)) fail('the moved element changed nothing (no new / no longer found clashes)');
  if (!same(sortObj(r2.entry.byPair), sortObj(r2.list))) fail('run 2 per-pair numbers differ from the clash list: ' + JSON.stringify({ entry: r2.entry.byPair, list: r2.list }));
  else ok(`run 2 per-pair total / open / new / resolved == clash list (${r2.entry.newCount} new, ${r2.entry.autoResolved} no longer found)`);
  const ft2 = Object.fromEntries(Object.entries(r2.entry.byPair).map(([k, v]) => [k, v.total]));
  if (!same(sortObj(ft2), sortObj(r2.facet))) fail('run 2 per-pair totals differ from the Trades facet: ' + JSON.stringify({ entry: ft2, facet: r2.facet }));
  else ok('run 2 per-pair totals == Trades facet');
  const asg = r2.entry.byAssignee || {};
  if (!(asg.Ann >= 1) || Object.values(asg).reduce((a, b) => a + b, 0) !== r2.open) fail('run 2 open per assignee wrong: ' + JSON.stringify(asg) + ' open ' + r2.open);
  else ok('run 2 open per assignee adds up (' + JSON.stringify(asg) + ')');

  // ── (c) the Trends view ──
  await page.evaluate(() => { window._ccDispatch({ t: 'TRIAGE_UPD', u: { view: 'list', facets: {} } }); window._ccDispatch({ t: 'TAB', v: 'clashes' }); });
  await page.waitForSelector('[data-cc-trends-details]', { timeout: 10_000 });
  await page.evaluate(() => { const d = document.querySelector('[data-cc-trends-details]'); d.open = true; d.dispatchEvent(new Event('toggle')); });
  await page.waitForSelector('[data-cc-trends] [data-cc-trend-section="pair"]', { timeout: 10_000 });
  const cards = await page.evaluate(() => [...document.querySelectorAll('[data-cc-trend-section="pair"] [data-cc-trend-key]')].map((b) => ({ key: b.getAttribute('data-cc-trend-key'), aria: (b.querySelector('svg[role=img]') || {}).getAttribute ? b.querySelector('svg[role=img]').getAttribute('aria-label') : null })));
  const pairKeys = Object.keys(r2.entry.byPair);
  const shown = Math.min(pairKeys.length, 12);
  if (cards.length !== shown) fail(`expected ${shown} pair cards, got ${cards.length}`);
  else if (!cards.every((c) => c.aria && /run 1 — /.test(c.aria) && /run 2 — total \d+, open \d+, new \d+, resolved \d+/.test(c.aria))) fail('pair chart aria-labels lack the numbers: ' + JSON.stringify(cards.slice(0, 2)));
  else {
    const c0 = cards[0], e0 = r2.entry.byPair[c0.key];
    if (!c0.aria.includes(`run 2 — total ${e0.total}, open ${e0.open}, new ${e0.new}, resolved ${e0.resolved}`)) fail('first card aria-label numbers differ from the entry: ' + c0.aria);
    else ok(`${cards.length} pair cards, aria-labels carry every run's numbers`);
  }
  if (process.env.CC_TRENDS_SHOT) await page.evaluate(() => document.querySelector('[data-cc-trend-section="pair"]').scrollIntoView());
  if (process.env.CC_TRENDS_SHOT) await page.locator('.cc-left-panel').screenshot({ path: process.env.CC_TRENDS_SHOT + '-chart.png' }).catch(() => {});
  await page.click('[data-cc-trends-view="table"]');
  if (process.env.CC_TRENDS_SHOT) await page.locator('.cc-left-panel').screenshot({ path: process.env.CC_TRENDS_SHOT + '-table.png' }).catch(() => {});
  const table = await page.evaluate(() => {
    const out = {};
    for (const tr of document.querySelectorAll('[data-cc-trend-table="pair"] [data-cc-trend-row]')) {
      const o = {};
      for (const td of tr.querySelectorAll('td[data-f]')) o[td.getAttribute('data-f')] = parseInt(td.textContent, 10); // "12 (−3)": value + change vs the run before
      out[tr.getAttribute('data-cc-trend-row')] = o;
    }
    return out;
  });
  if (!same(sortObj(table), sortObj(r2.list))) fail('Trends table per-pair numbers differ from the clash list: ' + JSON.stringify({ table, list: r2.list }));
  else ok('Trends table per pair == clash list (' + Object.keys(table).length + ' rows)');
  await page.click('[data-cc-trends-view="chart"]');
  const k0 = cards[0] && cards[0].key;
  if (k0) {
    await page.click(`[data-cc-trend-section="pair"] [data-cc-trend-key="${k0}"]`);
    const f1 = await page.evaluate((k) => ({ facets: (window._ccLatestState.triage.facets || {}).trade, pressed: document.querySelector(`[data-cc-trend-key="${k}"]`).getAttribute('aria-pressed') }), k0);
    if (!same(f1.facets, [k0]) || f1.pressed !== 'true') fail('a pair click did not filter the list by it: ' + JSON.stringify(f1));
    await page.click(`[data-cc-trend-section="pair"] [data-cc-trend-key="${k0}"]`);
    const f2 = await page.evaluate(() => (window._ccLatestState.triage.facets || {}).trade || null);
    if (f2) fail('a second pair click did not clear the filter: ' + JSON.stringify(f2));
    else if (same(f1.facets, [k0])) ok('pair card filters the clash list by its pair and clears it again');
  }

  // ── (d) export ──
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), page.click('[data-cc-history-export="csv"]')]);
  const csv = await readFile(await dl.path(), 'utf8');
  const rows = csv.trimEnd().split('\r\n').map((l) => l.split(','));
  const want = ['run', 'timestamp', 'dimension', 'key', 'total', 'open', 'new', 'resolved'];
  if (!same(rows[0], want)) fail('CSV header: ' + rows[0].join(','));
  const runRows = rows.filter((r) => r[2] === 'run');
  const csvPairs = Object.fromEntries(rows.filter((r) => r[0] === '2' && r[2] === 'pair').map((r) => [r[3], { total: +r[4], open: +r[5], new: +r[6], resolved: +r[7] }]));
  if (runRows.length !== 2 || +runRows[1][4] !== r2.entry.total || +runRows[1][5] !== r2.entry.open) fail('CSV run rows: ' + JSON.stringify(runRows));
  else if (!same(sortObj(csvPairs), sortObj(r2.list))) fail('CSV per-pair rows differ from the clash list: ' + JSON.stringify(csvPairs));
  else if (!/^clash-history-\d{4}-\d\d-\d\d\.csv$/.test(dl.suggestedFilename())) fail('CSV file name: ' + dl.suggestedFilename());
  else ok(`CSV: header, 2 run rows, ${Object.keys(csvPairs).length} pair rows of run 2 == clash list (${rows.length - 1} rows in all)`);
  const [dj] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), page.click('[data-cc-history-export="json"]')]);
  const js = JSON.parse(await readFile(await dj.path(), 'utf8'));
  if (js.format !== 'clashcontrol-run-history' || js.runs.length !== 2 || !same(sortObj(js.runs[1].byPair), sortObj(r2.list))) fail('JSON export: ' + JSON.stringify({ format: js.format, runs: js.runs && js.runs.length }));
  else ok('JSON export: 2 runs, run 2 per pair == clash list');

  // ── (e) an older project's history (no breakdowns) still renders ──
  await page.evaluate(() => {
    const h = window._ccLatestState.runHistory;
    window._ccDispatch({ t: 'LOAD_PROJECT_STATE', data: { runHistory: [{ ts: h[0].ts - 60000, total: 7, open: 7, newCount: 7, persisting: 0, autoResolved: 0 }].concat(h) } });
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-cc-trends] svg[role=img]').length > 0 && /before this version/.test(document.querySelector('[data-cc-trends]').textContent), null, { timeout: 5000 })
    .then(() => ok('older entries without breakdowns render (note shown, gaps)'), () => fail('the Trends view did not render with an old entry'));
  const gap = await page.evaluate(() => { const s = document.querySelector('[data-cc-trend-section="pair"] svg[role=img]'); return s && s.getAttribute('aria-label'); });
  if (!gap || !/run 1 — no breakdown/.test(gap)) fail('old run not a gap in the pair chart: ' + gap);
} catch (e) {
  fail('harness: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (pageErrors.length) fail('page errors: ' + pageErrors.slice(0, 3).join(' | '));
if (failures) { console.error(`RUN-TRENDS: ${failures} failure(s)`); process.exit(1); }
console.log('RUN-TRENDS OK');
