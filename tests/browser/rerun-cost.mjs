// Re-run cost is proportional to what changed (smart re-runs).
//
// On a generated two-model federation (tests/fixtures/generate-building-ifc.js,
// structure + MEP, synthetic only), in the real app:
//   (a) an UNCHANGED re-run (same rules, nothing edited) takes < 15 % of the
//       first (full) run's time and returns an identical clash list: every
//       field except the per-run `id`/`createdAt`, in the same order — and the
//       committed review state (ids included, classification, severity,
//       buckets, titles) is identical too;
//   (b) moving ONE element re-runs only the pairs touching it
//       (profile changed_elements = 1, pairs_recomputed <= that element's
//       broad-phase neighbours) and the re-run time stays proportional (well
//       under the first run);
//   (c) that smart re-run equals a forced full re-run (rules.fullRerun)
//       field for field, in order.
// The first run is the first detection on the freshly loaded models; re-run
// times are medians of CC_RERUN_REPEATS (default 3) runs. Wall times are
// measured around window.ClashControl.runDetection (detection + commit to
// state), engine times are the run profile's total_ms.
//
// Run: CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/rerun-cost.mjs
//      CC_GEN_SCALE=large (default) | medium | ci | SxBXxBY
//      CC_RERUN_CPU_PROFILE=1  prints the top self-time functions of an unchanged re-run
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
const REPEATS = Math.max(1, +(process.env.CC_RERUN_REPEATS || 3));
const SETTLE_MS = +(process.env.CC_RERUN_SETTLE_MS || 0);

let failures = 0;
function fail(msg) { console.error('RERUN FAIL: ' + msg); failures++; }
function ok(msg) { console.log('RERUN OK — ' + msg); }
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const gen = generateBuilding({ scale: process.env.CC_GEN_SCALE || 'large', seed: 4242, georef: 'local' });
const files = new Map();
const KINDS = ['structure', 'mep'];
for (const k of KINDS) files.set('/__gen/' + gen.fileNames[k], Buffer.from(gen.files[k]));

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
const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE, args: ['--js-flags=--max-old-space-size=8192'] });
const pageErrors = [];

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (offlineDepsEnabled()) await routeOfflineDeps(context, root);
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 60_000 });
  await page.waitForFunction(() => typeof window._ccWasmIntersect === 'function', null, { timeout: 30_000 }).catch(() => console.log('note: WASM narrow phase not ready — runs use the JS engine'));
  await page.evaluate(async (names) => {
    const fs = await Promise.all(names.map(async (n) => new File([await (await fetch('/__gen/' + n)).arrayBuffer()], n)));
    window.ClashControl.loadFiles(fs);
  }, KINDS.map((k) => gen.fileNames[k]));
  await page.waitForFunction((n) => {
    const s = window._ccLatestState;
    return s && s.models.length === n && s.models.every((m) => (m.elements || []).length > 0) && window._ccModelLoading === false;
  }, KINDS.length, { timeout: 180_000, polling: 300 });

  // In-page helpers: run detection, canonical clash signature (every field but
  // the per-run id/createdAt, keys sorted, in result order) and the committed
  // review state (ids included).
  await page.evaluate(() => {
    function canon(v) {
      if (v === null || typeof v !== 'object') return typeof v === 'function' ? undefined : v;
      if (Array.isArray(v)) return v.map(canon);
      const o = {};
      for (const k of Object.keys(v).sort()) { const c = canon(v[k]); if (c !== undefined) o[k] = c; }
      return o;
    }
    window.__rc = {
      async run(rules) {
        const t0 = performance.now();
        const res = await window.ClashControl.runDetection(Object.assign({ excludeSameDiscipline: false, selfClashModels: 'none', hard: true, minGap: 0, maxGap: 50 }, rules || {}));
        const ms = performance.now() - t0;
        const prof = Object.assign({}, window._ccDetectProfile);
        const rows = (res || []).map((c) => { const x = Object.assign({}, c); delete x.id; delete x.createdAt; return JSON.stringify(canon(x)); });
        return { ms, prof, rows };
      },
      state() {
        const s = window._ccLatestState;
        const core = window._ccClashClassificationCore;
        const clashes = s.clashes.map((c) => {
          const x = Object.assign({}, c); delete x.createdAt; delete x.updatedAt; delete x._trainFV; delete x._lastSeen; delete x._runCount; delete x._delta; delete x._prevDepth; delete x._prevPoint; // the reconciler's run-to-run history
          x.__bucket = core && core.reviewBucket ? core.reviewBucket(c, s.rules) : null;
          return JSON.stringify(canon(x));
        });
        return clashes;
      },
    };
  });
  const run = (rules) => page.evaluate((r) => window.__rc.run(r), rules || {});
  const sameRows = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  function firstDiff(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] === b[i]) continue;
      let keys = '';
      try {
        const x = JSON.parse(a[i]), y = JSON.parse(b[i]);
        keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]))
          .map((k) => k + ': ' + JSON.stringify(x[k]) + ' vs ' + JSON.stringify(y[k])).join('; ');
      } catch { keys = String(a[i]).slice(0, 300) + ' vs ' + String(b[i]).slice(0, 300); }
      return '#' + i + ' (' + a.length + ' vs ' + b.length + ' rows): ' + keys.slice(0, 1500);
    }
    return 'none';
  }

  // CPU profile of one run (CC_RERUN_CPU_PROFILE=1): top inclusive / self time.
  async function profiled(label, rules) {
    if (process.env.CC_RERUN_CPU_PROFILE !== '1') return run(rules);
    console.log('--- CPU profile: ' + label);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await cdp.send('Profiler.start');
    const result = await run(rules);
    const { profile } = await cdp.send('Profiler.stop');
    const self = new Map();
    const dt = profile.timeDeltas || [];
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    (profile.samples || []).forEach((id, i) => {
      const n = byId.get(id); const k = (n.callFrame.functionName || '(anon)') + ':' + n.callFrame.lineNumber;
      self.set(k, (self.get(k) || 0) + (dt[i] || 0) / 1000);
    });
    // inclusive time per function (a function counted once per sample even when recursive)
    const parent = new Map();
    for (const n of profile.nodes) for (const c of (n.children || [])) parent.set(c, n.id);
    const incl = new Map();
    (profile.samples || []).forEach((id, i) => {
      const seen = new Set();
      for (let cur = id; cur != null; cur = parent.get(cur)) {
        const n = byId.get(cur); const k = (n.callFrame.functionName || '(anon)') + ':' + n.callFrame.lineNumber;
        if (seen.has(k)) continue; seen.add(k);
        incl.set(k, (incl.get(k) || 0) + (dt[i] || 0) / 1000);
      }
    });
    console.log('top inclusive time (ms):', [...incl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => k + ' ' + v.toFixed(1)).join('\n  '));
    console.log('top self time (ms):', [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => k + ' ' + v.toFixed(1)).join('\n  '));
    return result;
  }

  // ── first run: the first detection on the freshly loaded models (cold, what the user waits for) ──
  const full = await run({ fullRerun: true });
  const tFirst = full.ms, eFirst = full.prof.total_ms;
  console.log(`first run: ${full.rows.length} clash rows, ${full.prof.candidates} candidate pairs, ${Math.round(tFirst)} ms (engine ${eFirst} ms)`);
  if (full.rows.length < 50) fail('fixture too small for a timing comparison: ' + full.rows.length + ' clashes');
  // forced full re-runs with every per-element cache warm (reference only)
  const warm = [];
  for (let i = 0; i < REPEATS; i++) {
    const r = await run({ fullRerun: true });
    warm.push(r);
    if (!sameRows(r.rows, full.rows)) fail('forced full re-run #' + i + ' differs from the first run: ' + firstDiff(r.rows, full.rows));
  }
  const tWarm = median(warm.map((r) => r.ms)), eWarm = median(warm.map((r) => r.prof.total_ms));
  console.log(`forced full re-run (caches warm): median ${Math.round(tWarm)} ms (engine ${eWarm} ms)`);
  const stateFull = await page.evaluate(() => window.__rc.state());

  // ── (a) unchanged re-run ──
  const same = [];
  for (let i = 0; i < REPEATS; i++) {
    const r = await run({});
    same.push(r);
    if (!r.prof.smart_rerun || r.prof.changed_elements !== 0) fail('unchanged re-run should be smart with 0 changed elements, got ' + JSON.stringify({ s: r.prof.smart_rerun, c: r.prof.changed_elements }));
    if (!sameRows(r.rows, full.rows)) fail('unchanged re-run #' + i + ' clash list differs from the full run: ' + firstDiff(r.rows, full.rows));
  }
  const tSame = median(same.map((r) => r.ms)), eSame = median(same.map((r) => r.prof.total_ms));
  const stateSame = await page.evaluate(() => window.__rc.state());
  if (!sameRows(stateSame, stateFull)) fail('committed review state after an unchanged re-run differs (ids/classification/severity/buckets/titles): ' + firstDiff(stateSame, stateFull));
  else ok('committed review state identical after unchanged re-runs (' + stateSame.length + ' clashes, ids included)');
  const ratio = eSame / Math.max(1, eFirst), wallRatio = tSame / tFirst;
  console.log('unchanged re-run profile:', JSON.stringify(same[same.length - 1].prof));
  console.log(`unchanged re-run: median ${Math.round(tSame)} ms wall (${(wallRatio * 100).toFixed(1)} % of the first run), engine ${eSame} ms (${(ratio * 100).toFixed(1)} %; ${(eSame / Math.max(1, eWarm) * 100).toFixed(1)} % of a warm full re-run)`);
  if (!(ratio < 0.15 && wallRatio < 0.15)) fail(`unchanged re-run took ${(ratio * 100).toFixed(1)} % (engine) / ${(wallRatio * 100).toFixed(1)} % (wall) of the first run (limit 15 %)`);
  else ok(`unchanged re-run ${(ratio * 100).toFixed(1)} % of the first run's engine time, identical clash list (${full.rows.length} rows)`);

  await profiled('unchanged re-run', {});

  // ── (b) move ONE element (CC_RERUN_REPEATS times, 30 mm further each time) ──
  await page.evaluate(() => {
    const st = window._ccLatestState;
    const mep = st.models.find((m) => /mep/i.test(m.name)) || st.models[1];
    function neighbours(el, pad) {
      let n = 0;
      for (const m of st.models) for (const o of m.elements) {
        if (o === el || !o.box || o.box.isEmpty()) continue;
        if (m === mep) continue; // selfClashModels:'none'
        const a = el.box, b = o.box;
        if (a.min.x - pad > b.max.x || b.min.x - pad > a.max.x || a.min.y - pad > b.max.y || b.min.y - pad > a.max.y || a.min.z - pad > b.max.z || b.min.z - pad > a.max.z) continue;
        n++;
      }
      return n;
    }
    // an element with several neighbours (a duct / pipe run)
    let el = null, best = -1;
    for (const e of mep.elements) {
      if (!e.box || e.box.isEmpty() || !e.meshes || !e.meshes.length) continue;
      const n = neighbours(e, 0.06); if (n > best && n <= 40) { best = n; el = e; }
    }
    window.__rcMove = function() {
      const dx = 0.03;
      el.meshes.forEach((m) => { m.position.x += dx; m.updateMatrix(); m.updateMatrixWorld(true); });
      el.box.min.x += dx; el.box.max.x += dx;
      // superset of its broad-phase candidates after the move (gap 50 mm + generous slack)
      return { neighbours: neighbours(el, 0.06) };
    };
  });
  const moves = [];
  for (let i = 0; i < REPEATS; i++) {
    if (SETTLE_MS) await page.waitForTimeout(SETTLE_MS);
    const moved = await page.evaluate(() => window.__rcMove());
    const mv = await (i === 0 ? profiled('one element moved', {}) : run({}));
    moves.push(mv);
    console.log(`after moving one element (${moved.neighbours} neighbours within 60 mm): ${Math.round(mv.ms)} ms (engine ${mv.prof.total_ms} ms), changed_elements=${mv.prof.changed_elements}, pairs_recomputed=${mv.prof.pairs_recomputed}, carried=${mv.prof.pair_cache_reemits}`);
    if (mv.prof.changed_elements !== 1) fail('expected exactly 1 changed element, got ' + mv.prof.changed_elements);
    if (!(typeof mv.prof.pairs_recomputed === 'number' && mv.prof.pairs_recomputed >= 1 && mv.prof.pairs_recomputed <= moved.neighbours)) {
      fail(`pairs recomputed (${mv.prof.pairs_recomputed}) must be >= 1 and <= the moved element's neighbours (${moved.neighbours})`);
    }
  }
  const mv = moves[moves.length - 1];
  const tMove = median(moves.map((r) => r.ms));
  if (moves.every((r) => r.prof.pairs_recomputed >= 1 && r.prof.pairs_recomputed <= 40)) ok(`moving one element recomputed only its own pairs (${moves.map((r) => r.prof.pairs_recomputed).join(', ')})`);
  // proportional: the unchanged cost + the warm per-pair cost for the recomputed pairs (x4 slack) + 150 ms
  const perPair = tWarm / Math.max(1, full.prof.candidates);
  const budget = tSame + 4 * perPair * (mv.prof.pairs_recomputed || 0) + 150;
  if (!(tMove <= budget && tMove < 0.3 * tFirst)) fail(`re-run after moving one element took ${Math.round(tMove)} ms (budget ${Math.round(budget)} ms, first run ${Math.round(tFirst)} ms)`);
  else ok(`one-element re-run median ${Math.round(tMove)} ms (budget ${Math.round(budget)} ms, ${(tMove / tFirst * 100).toFixed(1)} % of the first run)`);

  // ── (c) equals a full re-run ──
  const stateMove = await page.evaluate(() => window.__rc.state());
  const fr = await run({ fullRerun: true });
  if (!sameRows(mv.rows, fr.rows)) fail('smart re-run after moving one element differs from a full re-run: ' + firstDiff(mv.rows, fr.rows));
  else ok(`smart re-run == full re-run (${fr.rows.length} rows, field for field, in order)`);
  const stateFr = await page.evaluate(() => window.__rc.state());
  if (!sameRows(stateMove, stateFr)) fail('committed state after the smart re-run differs from the full re-run: ' + firstDiff(stateMove, stateFr));
  if (sameRows(mv.rows, full.rows)) console.log('note: the move did not change the clash list');
  // and an unchanged re-run after the move is cheap and identical again
  const again = await run({});
  if (!sameRows(again.rows, fr.rows) || again.prof.changed_elements !== 0) fail('unchanged re-run after the move differs from the full run');

  console.log(`\nSUMMARY first ${Math.round(tFirst)} ms | warm full ${Math.round(tWarm)} ms | unchanged ${Math.round(tSame)} ms (${(ratio * 100).toFixed(1)} %) | one element moved ${Math.round(tMove)} ms (${mv.prof.pairs_recomputed} pairs) | full re-run ${Math.round(fr.ms)} ms`);
  if (pageErrors.length) fail('page errors: ' + pageErrors.slice(0, 5).join(' | '));
} catch (e) {
  fail('harness error: ' + (e && e.stack || e));
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nrerun-cost: all checks passed');
