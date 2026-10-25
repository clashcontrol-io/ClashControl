// Automatic re-check on model change (docs/INTERNALS.md §21.59), in the real app.
//
// On a generated structure + MEP federation (tests/fixtures/generate-building-ifc.js,
// scale ci, seed 4242, synthetic only):
//   (a) a first load with no previous run never runs (pref 'any', so the load
//       itself would qualify);
//   (b) with the default pref ('replaced'): run once, then reload the MEP file
//       (same name) with ONE element moved → one automatic run happens after
//       the batch settled, it is a smart run (1 changed element, only its
//       pairs recomputed), the clash list it commits equals a manual forced
//       full re-run, and one toast says it was an automatic re-check;
//   (c) a plain load of another model under 'replaced' does not run;
//   (d) with the pref Off a reload does not run.
//
// Run: CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/auto-rerun.mjs
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

// How far the one element moves (m, along its local x = y = z): 0.5 gives it new clashes (pairs recomputed).
const MOVE_M = +(process.env.CC_AUTORR_MOVE_M || 0.5);

let failures = 0;
function fail(msg) { console.error('AUTO-RERUN FAIL: ' + msg); failures++; }
function ok(msg) { console.log('AUTO-RERUN OK — ' + msg); }

const gen = generateBuilding({ scale: 'ci', seed: 4242, georef: 'local' });
const files = new Map();
for (const k of ['structure', 'mep', 'architecture']) files.set('/__gen/' + k, Buffer.from(gen.files[k]));

// The MEP file with ONE product moved: a new placement relative to its own
// (so nothing shared moves) re-pointed from the product line only; every
// existing #id stays the same, new entities are appended after the max id.
function movedVariant(text, expressId, dx) {
  const lines = text.split('\n');
  const re = new RegExp('^#' + expressId + '=IFC[A-Z]+\\(');
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) throw new Error('product #' + expressId + ' not found');
  // ObjectPlacement is the 6th attribute: ('gid',$,'name',$,$,#P,...)
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (offlineDepsEnabled()) await routeOfflineDeps(context, root);
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function' && window._ccLatestState, null, { timeout: 60_000 });
  await page.waitForFunction(() => typeof window._ccWasmIntersect === 'function', null, { timeout: 30_000 }).catch(() => console.log('note: WASM narrow phase not ready — runs use the JS engine'));

  await page.evaluate(() => {
    function canon(v) {
      if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
      if (Array.isArray(v)) return v.map(canon);
      const o = {};
      for (const k of Object.keys(v).sort()) { const c = canon(v[k]); if (c !== undefined) o[k] = c; }
      return o;
    }
    window.__ar = {
      // path → File named `name` (a same-name file replaces the loaded model)
      async load(list) {
        const fs = await Promise.all(list.map(async ([p, name]) => new File([await (await fetch(p)).arrayBuffer()], name)));
        window.ClashControl.loadFiles(fs);
      },
      // committed review state of the clashes the last run FOUND (an
      // auto-resolved one — no longer found — stays one run, then goes),
      // minus the reconciler's run-to-run history
      state() {
        const s = window._ccLatestState;
        return s.clashes.filter((c) => c.status !== 'auto_resolved').map((c) => {
          const x = Object.assign({}, c);
          for (const k of ['createdAt', 'updatedAt', '_trainFV', '_lastSeen', '_runCount', '_delta', '_prevDepth', '_prevPoint']) delete x[k];
          return JSON.stringify(canon(x));
        });
      },
      info() {
        const s = window._ccLatestState, a = window._ccAutoRerun;
        return { runs: a.runs, last: a.last, pending: !!a.pending, history: (s.runHistory || []).length, detecting: !!s.detecting,
          loading: !!window._ccModelLoading, tab: s.tab, models: s.models.map((m) => m.name + ':' + (m.elements || []).length), auto: s.lastAutoRerun };
      },
    };
  });
  const info = () => page.evaluate(() => window.__ar.info());
  async function settle(ms) {
    // the batch is done (models + props), nothing pending / running, then a quiet window
    await page.waitForFunction(() => !window._ccModelLoading && !window._ccAutoRerun.pending && !window._ccLatestState.detecting, null, { timeout: 120_000, polling: 200 });
    await page.waitForTimeout(ms || 1500);
    await page.waitForFunction(() => !window._ccAutoRerun.pending && !window._ccLatestState.detecting, null, { timeout: 120_000, polling: 200 });
  }
  const waitModels = (n) => page.waitForFunction((n) => {
    const s = window._ccLatestState;
    return s && s.models.length === n && s.models.every((m) => (m.elements || []).length > 0) && window._ccModelLoading === false;
  }, n, { timeout: 180_000, polling: 300 });

  // ── (a) first load, no previous run, pref 'any' ──
  await page.evaluate(() => window._ccDispatch({ t: 'UPD_PREFS', u: { autoRerun: 'any' } }));
  await page.evaluate(() => window.__ar.load([['/__gen/structure', 'building-structure.ifc'], ['/__gen/mep', 'building-mep.ifc']]));
  await waitModels(2);
  await settle(2000);
  let st = await info();
  if (st.runs !== 0 || st.history !== 0) fail('a first load with no previous run must not run: ' + JSON.stringify(st));
  else ok('first load with no previous run: no automatic run (' + (st.last && st.last.skipped) + ')');

  // ── (b) run once, then reload MEP with one element moved ──
  await page.evaluate(() => {
    window._ccDispatch({ t: 'UPD_PREFS', u: { autoRerun: 'replaced' } });
    window._ccDispatch({ t: 'UPD_RULES', u: { excludeSameDiscipline: false, selfClashModels: 'none', hard: true, minGap: 0, maxGap: 50 } });
  });
  await page.waitForFunction(() => window._ccLatestState.prefs.autoRerun === 'replaced' && window._ccLatestState.rules.maxGap === 50);
  const first = await page.evaluate(async () => {
    const res = await window.ClashControl.runDetection({});
    await new Promise((r) => setTimeout(r, 300));
    // a MEP element in a clash with structure, with few neighbours: its move changes few pairs
    const s = window._ccLatestState, mep = s.models.find((m) => /mep/i.test(m.name));
    const ids = new Set(mep.elements.map((e) => e.expressId));
    const counts = new Map();
    for (const c of res) for (const [mid, id] of [[c.modelAId, c.elemA], [c.modelBId, c.elemB]]) if (mid === mep.id && ids.has(id)) counts.set(id, (counts.get(id) || 0) + 1);
    let pick = null, best = Infinity;
    for (const [id, n] of counts) if (n < best) { best = n; pick = id; }
    if (pick == null) pick = mep.elements[0].expressId;
    return { rows: res.length, pick, history: s.runHistory.length };
  });
  console.log(`first run: ${first.rows} clashes; moving MEP #${first.pick}`);
  if (first.rows < 10) fail('fixture too small: ' + first.rows + ' clashes');
  files.set('/__gen/mep-moved', Buffer.from(movedVariant(Buffer.from(gen.files.mep).toString("latin1"), first.pick, MOVE_M), 'latin1'));
  await page.evaluate(() => { window.__arTab = window._ccLatestState.tab; });
  await page.evaluate(() => window.__ar.load([['/__gen/mep-moved', 'building-mep.ifc']]));
  await page.waitForFunction(() => window._ccAutoRerun.runs >= 1 && !window._ccLatestState.detecting && window._ccLatestState.lastAutoRerun, null, { timeout: 120_000, polling: 200 });
  st = await info();
  const prof = await page.evaluate(() => Object.assign({}, window._ccDetectProfile));
  console.log('automatic run:', JSON.stringify({ last: st.last, history: st.history, auto: st.auto && { reason: st.auto.reason, delta: st.auto.delta } }));
  console.log('profile:', JSON.stringify({ smart: prof.smart_rerun, changed: prof.changed_elements, recomputed: prof.pairs_recomputed, carried: prof.pair_cache_reemits, candidates: prof.candidates }));
  if (st.runs !== 1 || st.history !== first.history + 1) fail('expected exactly one automatic run after the reload: ' + JSON.stringify(st));
  else ok('one automatic run after the same-name reload (reason ' + st.last.reason + ')');
  if (!prof.smart_rerun || prof.changed_elements !== 1) fail('the automatic run must be a smart run with 1 changed element: ' + JSON.stringify({ s: prof.smart_rerun, c: prof.changed_elements }));
  else if (!(prof.pairs_recomputed >= 0 && prof.pairs_recomputed <= 40 && prof.pairs_recomputed < prof.candidates / 4 && prof.pair_cache_reemits > 0)) fail(`pairs recomputed ${prof.pairs_recomputed} of ${prof.candidates} candidates`);
  else ok(`smart run: 1 changed element, ${prof.pairs_recomputed} of ${prof.candidates} pairs recomputed, ${prof.pair_cache_reemits} carried`);
  const tabNow = await page.evaluate(() => window._ccLatestState.tab);
  const tabBefore = await page.evaluate(() => window.__arTab);
  if (tabNow !== tabBefore) fail(`the automatic run switched the tab (${tabBefore} → ${tabNow})`);
  const toast = await page.waitForFunction(() => /Re-checked after model update/.test(document.body.innerText), null, { timeout: 5000 }).then(() => true, () => false);
  if (!toast) fail('no "Re-checked after model update" toast');
  else ok('toast: ' + await page.evaluate(() => (document.body.innerText.match(/Re-checked after model update[^\n]*/) || [''])[0]));
  // equals a manual run: a forced full re-run finds the same clashes, and
  // they commit to the same review state (ids, classification, severity …)
  const stateAuto = await page.evaluate(() => window.__ar.state());
  const full = await page.evaluate(async () => {
    const res = await window.ClashControl.runDetection({ fullRerun: true });
    await new Promise((r) => setTimeout(r, 300));
    return { rows: res.length, smart: window._ccDetectProfile.smart_rerun };
  });
  const stateFull = await page.evaluate(() => window.__ar.state());
  const same = stateAuto.length === full.rows && stateAuto.length === stateFull.length && stateAuto.every((x, i) => x === stateFull[i]);
  if (!same) {
    const i = stateAuto.findIndex((x, k) => x !== stateFull[k]);
    fail(`automatic run state differs from a manual full re-run (${stateAuto.length} vs ${stateFull.length}) at #${i}: ${String(stateAuto[i]).slice(0, 400)} vs ${String(stateFull[i]).slice(0, 400)}`);
  } else ok(`automatic run == manual full re-run (${stateAuto.length} committed clashes, ${full.rows} found, field for field)`);

  // ── (c) a plain load under 'replaced' does not run ──
  const before = await info();
  await page.evaluate(() => window.__ar.load([['/__gen/architecture', 'building-architecture.ifc']]));
  await waitModels(3);
  await settle(2000);
  st = await info();
  if (st.runs !== before.runs || st.history !== before.history) fail('a plain load under "replaced" must not run: ' + JSON.stringify(st));
  else ok('plain model load under "When a model is replaced": no run (' + (st.last && st.last.skipped) + ')');

  // ── (d) pref Off: a reload does not run ──
  await page.evaluate(() => window._ccDispatch({ t: 'UPD_PREFS', u: { autoRerun: 'off' } }));
  await page.waitForFunction(() => window._ccLatestState.prefs.autoRerun === 'off');
  await page.evaluate(() => window.__ar.load([['/__gen/mep', 'building-mep.ifc']]));
  await page.waitForFunction((v) => window._ccLatestState.models.find((m) => /mep/i.test(m.name))._version > v, 1, { timeout: 120_000 }).catch(() => {});
  await settle(2500);
  st = await info();
  if (st.runs !== before.runs || st.history !== before.history) fail('pref Off must not run: ' + JSON.stringify(st));
  else ok('pref Off: the reload did not run (' + (st.last && st.last.skipped) + ')');
  // the persisted pref
  const persisted = await page.evaluate(() => localStorage.getItem('cc_autoRerun'));
  if (persisted !== 'off') fail('pref not persisted: ' + persisted);

  if (pageErrors.length) fail('page errors: ' + pageErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail('harness error: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nauto-rerun: all checks passed');
