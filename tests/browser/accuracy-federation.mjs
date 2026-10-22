// Clash ACCURACY of the real app against ground truth, on a generated
// federation (tests/fixtures/generate-building-ifc.js: architecture +
// structure + MEP with 22 planted cases) — and the large-model load/detect
// benchmark when scaled up.
//
// What it does (one browser page, real file-load path, real detection):
//   1. generates the federation in memory (CC_GEN_SCALE, default 'ci';
//      CC_GEN_GEOREF none|local|far, default 'local'; CC_GEN_SEED);
//   2. loads all three models via window.ClashControl.loadFiles and prints
//      per-model load timings (model.stats.loadTime + stats.phases);
//   3. runs three detections — default rules (hard + 50 mm clearance),
//      hard-only, and 50 mm clearance-only — timing each;
//   4. computes ground truth IN THE PAGE with the exact oracle
//      (tests/_oracle-exact.js injected as a script) on the app's own world
//      triangles (window._ccGetWorldTris) for every cross-model, in-scope
//      element pair whose AABBs are within 50 mm (+1 mm) — all of them at CI
//      scale; a seeded sample above CC_ORACLE_MAX_PAIRS (default 6000), plus a
//      sample of the app-reported pairs, in which case precision/recall are
//      sample estimates;
//   5. scores each run's clash list against that truth (confusion matrix,
//      precision/recall per category, distance error, missed + spurious pairs)
//      and separately against the planted-case manifest (analytic intent).
//
// It RECORDS engine discrepancies; it only fails (exit 1) on harness errors:
// generation/load failure, page exceptions, or an empty detection.
// Report: $CC_ACCURACY_REPORT (default <os.tmpdir()>/cc-accuracy-federation-report.json).
//
// Run:  CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 node tests/browser/accuracy-federation.mjs
//       CC_GEN_SCALE=large ...   (or e.g. CC_GEN_SCALE=12x8x6)
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const { generateBuilding } = require(join(root, 'tests/fixtures/generate-building-ifc.js'));

const SCALE = process.env.CC_GEN_SCALE || 'ci';
const GEOREF = process.env.CC_GEN_GEOREF || 'local';
const SEED = +(process.env.CC_GEN_SEED || 4242);
const MAX_PAIRS = +(process.env.CC_ORACLE_MAX_PAIRS || 6000);
const REPORT_PATH = process.env.CC_ACCURACY_REPORT || join(tmpdir(), 'cc-accuracy-federation-report.json');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css' };

let harnessOk = true;
function harnessFail(msg) { console.error('ACCURACY HARNESS ERROR: ' + msg); harnessOk = false; }

// ── 1. generate ──
const tGen = Date.now();
const gen = generateBuilding({ scale: SCALE, seed: SEED, georef: GEOREF });
const genMs = Date.now() - tGen;
const virtualFiles = new Map();
for (const k of ['architecture', 'structure', 'mep']) virtualFiles.set('/__gen/' + gen.fileNames[k], Buffer.from(gen.files[k]));
const totalBytes = Object.values(gen.stats.bytes).reduce((s, v) => s + v, 0);
console.log(`generated federation scale=${JSON.stringify(gen.stats.scale)} georef=${GEOREF} seed=${SEED}: ${gen.stats.products} products, ${(totalBytes / 1048576).toFixed(2)} MB, repeated geometry (signature) ${(gen.stats.repeatedGeometryShare * 100).toFixed(2)} %, ${gen.manifest.cases.length} planted cases, ${genMs} ms`);

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (virtualFiles.has(urlPath)) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(virtualFiles.get(urlPath)); }
    const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ executablePath: process.env.CC_CHROMIUM_EXECUTABLE, args: ['--js-flags=--max-old-space-size=8192'] });
const pageErrors = [], consoleErrors = [];

async function newPage() {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  if (process.env.CC_BROWSER_OFFLINE_DEPS === '1') {
    async function local(route, file, contentType) {
      await route.fulfill({ status: 200, body: await readFile(join(root, 'node_modules', file)), headers: { 'content-type': contentType || 'text/javascript', 'access-control-allow-origin': '*' } });
    }
    const c = page.context();
    await c.route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
    await c.route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
    await c.route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
    await c.route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
    await c.route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', async (route) => { const s = new URL(route.request().url()).pathname.split('/three@0.180.0/')[1]; await local(route, 'three/' + s); });
    await c.route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', async (route) => { const s = new URL(route.request().url()).pathname.split('/web-ifc@0.0.77/')[1]; await local(route, 'web-ifc/' + s, s.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'); });
    await c.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/css' }));
    await c.route('https://fonts.gstatic.com/**', (route) => route.abort());
    await c.route('https://gc.zgo.at/**', (route) => route.fulfill({ status: 200, body: '', contentType: 'text/javascript' }));
  }
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ClashControl && typeof window._ccDispatch === 'function', null, { timeout: 60_000 });
  return page;
}

const report = { scale: gen.stats.scale, georef: GEOREF, seed: SEED, products: gen.stats.products, bytes: gen.stats.bytes, repeatedGeometryShareSignature: gen.stats.repeatedGeometryShare, timings: {}, runs: {}, planted: {}, oracle: {} };
const pct = (x) => (x * 100).toFixed(1) + ' %';

try {
  const page = await newPage();
  await page.waitForFunction(() => typeof window._ccWasmIntersect === 'function', null, { timeout: 30_000 }).catch(() => console.log('note: WASM narrow phase not ready — runs use the JS engine'));
  // ── 2. load ──
  const loadTimeout = Math.max(180_000, totalBytes / 1048576 * 30_000);
  const tLoad = Date.now();
  await page.evaluate(async (names) => {
    const files = await Promise.all(names.map(async (n) => new File([await (await fetch('/__gen/' + n)).arrayBuffer()], n)));
    window.ClashControl.loadFiles(files);
  }, [gen.fileNames.architecture, gen.fileNames.structure, gen.fileNames.mep]);
  await page.waitForFunction(() => {
    const s = window._ccLatestState;
    return s && s.models.length === 3 && s.models.every((m) => (m.elements || []).length > 0) && window._ccModelLoading === false;
  }, null, { timeout: loadTimeout, polling: 500 });
  const loadWallMs = Date.now() - tLoad;
  const models = await page.evaluate(() => window._ccLatestState.models.map((m) => ({
    name: m.name, discipline: m.discipline, elements: m.elements.length, stats: Object.assign({}, m.stats, { phases: m.stats && m.stats.phases }),
  })));
  report.timings.loadWallMs = loadWallMs;
  report.timings.models = models;
  console.log(`\n=== LOAD (wall ${loadWallMs} ms for all three) ===`);
  for (const m of models) {
    const s = m.stats || {};
    const ph = s.phases ? Object.entries(s.phases).map(([k, v]) => `${k} ${typeof v === 'number' ? Math.round(v) : JSON.stringify(v)}`).join(', ') : '';
    console.log(`  ${m.name.padEnd(24)} ${String(m.discipline).padEnd(14)} ${String(m.elements).padStart(6)} elements  load ${s.loadTime} ms  geo unique ${s.geoUnique} reused ${s.geoReused} (${s.geoUnique ? pct(s.geoReused / (s.geoUnique + s.geoReused)) : '-'})  instanced ${s.instancedElements || 0}`);
    if (ph) console.log(`      phases: ${ph}`);
  }

  // ── 3. detection runs ──
  const RUNS = {
    default: { label: 'default (hard + 50 mm)', rules: { fullRerun: true } },
    hardOnly: { label: 'hard only', rules: { hard: true, maxGap: 0, fullRerun: true } },
    clearance50: { label: 'clearance 50 mm only', rules: { hard: false, minGap: 0, maxGap: 50, fullRerun: true } },
  };
  const results = {};
  for (const [key, run] of Object.entries(RUNS)) {
    const r = await page.evaluate(async (rules) => {
      const gid = new Map();
      for (const m of window._ccLatestState.models) for (const el of m.elements) gid.set(m.id + ':' + el.expressId, (el.props && el.props.globalId) || '');
      const t0 = performance.now();
      const res = await window.ClashControl.runDetection(rules);
      const ms = performance.now() - t0;
      const out = [];
      for (const c of res || []) {
        const base = { type: c.type, distance: c.distance, clearanceMm: c.clearanceMm, opening: c.opening || null, merged: false };
        out.push(Object.assign({ a: c.globalIdA, b: c.globalIdB }, base));
        // merged rows: expand every grouped partner element as its own pair
        if (c._groupedElems && c._groupedElems.length) {
          for (const e of c._groupedElems) {
            const ga = gid.get(c.modelBId + ':' + e), gb = gid.get(c.modelAId + ':' + e);
            if (ga && ga !== c.globalIdB) out.push(Object.assign({ a: c.globalIdA, b: ga }, base, { merged: true }));
            else if (gb && gb !== c.globalIdA) out.push(Object.assign({ a: gb, b: c.globalIdB }, base, { merged: true }));
          }
        }
      }
      return { ms, rows: (res || []).length, clashes: out };
    }, run.rules);
    results[key] = r;
    report.timings['detect_' + key + '_ms'] = Math.round(r.ms);
    console.log(`\n=== DETECT ${run.label}: ${r.rows} clash rows (${r.clashes.length} element pairs incl. merged partners) in ${Math.round(r.ms)} ms`);
  }
  if (!results.default.rows) harnessFail('default detection returned no clashes at all');

  // ── 4. ground truth with the exact oracle, in the page ──
  const oracleSrc = await readFile(join(root, 'tests/_oracle-exact.js'), 'utf8');
  await page.addScriptTag({ content: `(function(){var module={exports:{}};var exports=module.exports;var require=function(){throw new Error('no require')};\n${oracleSrc}\nwindow.__ccOracle=module.exports;})();` });
  const reported = new Set();
  for (const r of Object.values(results)) for (const c of r.clashes) reported.add([c.a, c.b].sort().join('|'));
  const cand = await page.evaluate(({ maxPairs, reportedKeys, seed }) => {
    const st = window._ccLatestState;
    const rules = Object.assign({}, st.rules);
    const els = [];
    for (const m of st.models) for (const el of m.elements) {
      const p = el.props || {};
      if (p.ifcType === 'IfcSpace' || p.ifcType === 'IfcOpeningElement') continue;
      const t = window._ccGetWorldTris(el);
      if (!t || !t.length) continue;
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < t.length; i += 3) for (let k = 0; k < 3; k++) { const v = t[i + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
      els.push({ el, m, mn, mx, gid: p.globalId || '' });
    }
    window.__ccEls = els;
    els.sort((a, b) => a.mn[0] - b.mn[0]);
    const pad = 0.051, pairs = [];
    for (let i = 0; i < els.length; i++) {
      const A = els[i];
      for (let j = i + 1; j < els.length && els[j].mn[0] <= A.mx[0] + pad; j++) {
        const B = els[j];
        if (A.m.id === B.m.id) continue;
        if (A.mn[1] > B.mx[1] + pad || B.mn[1] > A.mx[1] + pad || A.mn[2] > B.mx[2] + pad || B.mn[2] > A.mx[2] + pad) continue;
        if (window._ccMatrixSkipsSameDiscipline && window._ccMatrixSkipsSameDiscipline(A.el, A.m, B.el, B.m, false, rules)) continue;
        pairs.push([i, j]);
      }
    }
    // sampling above the cap: seeded uniform sample of candidates + reported pairs
    let sampled = false, chosen = pairs;
    const rep = new Set(reportedKeys);
    if (pairs.length > maxPairs) {
      sampled = true;
      let s = seed >>> 0;
      const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
      const pick = new Set();
      while (pick.size < maxPairs) pick.add(Math.floor(rnd() * pairs.length));
      const repIdx = [];
      pairs.forEach((p, k) => { if (!pick.has(k) && rep.has([els[p[0]].gid, els[p[1]].gid].sort().join('|'))) repIdx.push(k); });
      for (let k = repIdx.length - 1; k > 0; k--) { const r = Math.floor(rnd() * (k + 1)); [repIdx[k], repIdx[r]] = [repIdx[r], repIdx[k]]; }
      repIdx.slice(0, Math.floor(maxPairs / 2)).forEach((k) => pick.add(k));
      chosen = [...pick].sort((a, b) => a - b).map((k) => pairs[k]);
    }
    window.__ccPairs = chosen;
    window.__ccPrep = new Map();
    return { elements: els.length, candidates: pairs.length, chosen: chosen.length, sampled };
  }, { maxPairs: MAX_PAIRS, reportedKeys: [...reported], seed: SEED });
  console.log(`\n=== ORACLE: ${cand.elements} elements with geometry, ${cand.candidates} in-scope cross-model candidate pairs (AABB within 51 mm); evaluating ${cand.chosen}${cand.sampled ? ' (SAMPLED — precision/recall below are sample estimates)' : ' (all)'}`);
  const tOr = Date.now();
  const truth = [];
  const CHUNK = 150;
  for (let off = 0; off < cand.chosen; off += CHUNK) {
    const part = await page.evaluate(({ off, n }) => {
      const O = window.__ccOracle, out = [];
      // Truth is computed on the app's own Float32 world triangles snapped to a
      // 2^-30 m (~0.93 nm) grid: this only moves coordinates within ~8 mm of 0
      // (every larger Float32 already lies on that grid) and removes transform
      // noise such as a slab top at ±2.2e-16 instead of 0, which would
      // otherwise make an intended flush contact an "exact crossing" 1e-16 m
      // deep. The unsnapped verdict is kept too (noise-sensitive pairs).
      const SN = Math.pow(2, 30);
      const snap = (t) => { const o = new Float64Array(t.length); for (let i = 0; i < t.length; i++) o[i] = Math.round(t[i] * SN) / SN; return o; };
      const prep = (e) => {
        let m = window.__ccPrep.get(e);
        if (!m) { const t = window._ccGetWorldTris(e.el); m = { raw: O.prepareMesh(t, { assumeClosed: true }), snapped: O.prepareMesh(snap(t), { assumeClosed: true }) }; window.__ccPrep.set(e, m); }
        return m;
      };
      for (const [i, j] of window.__ccPairs.slice(off, off + n)) {
        const A = window.__ccEls[i], B = window.__ccEls[j];
        let o;
        let raw;
        try {
          const pA = prep(A), pB = prep(B);
          o = O.classifyPair(pA.snapped, pB.snapped, { assumeClosed: true });
          raw = O.classifyPair(pA.raw, pB.raw, { assumeClosed: true });
        } catch (e) { out.push({ a: A.gid, b: B.gid, error: String(e && e.message || e) }); continue; }
        const within = o.distance === 0 || O.cmpDistToRational(o, 1, 20) <= 0;
        out.push({ a: A.gid, b: B.gid, nameA: A.el.props.name, nameB: B.el.props.name, typeA: A.el.props.ifcType, typeB: B.el.props.ifcType,
          cat: o.category, d: o.distance, within, cert: o.certificate, manifold: o.edgeManifoldA && o.edgeManifoldB, ms: o.ms,
          rawCat: raw.category, rawD: raw.distance });
      }
      return out;
    }, { off, n: CHUNK });
    truth.push(...part);
    if (cand.chosen > 1000 && (off / CHUNK) % 10 === 0) process.stdout.write(`  oracle ${Math.min(off + CHUNK, cand.chosen)}/${cand.chosen} (${Math.round((Date.now() - tOr) / 1000)} s)\n`);
  }
  const oracleMs = Date.now() - tOr;
  const oracleErrors = truth.filter((t) => t.error);
  if (oracleErrors.length) harnessFail(`oracle threw on ${oracleErrors.length} pairs, e.g. ${oracleErrors[0].error}`);
  report.oracle = { elements: cand.elements, candidates: cand.candidates, evaluated: cand.chosen, sampled: cand.sampled, ms: oracleMs,
    nonManifoldPairs: truth.filter((t) => t.manifold === false).length, categories: {},
    noiseSensitivePairs: truth.filter((t) => !t.error && (t.rawCat !== t.cat || t.rawD !== t.d)).map((t) => ({ pair: `${t.nameA} x ${t.nameB}`, snapped: t.cat, unsnapped: t.rawCat, dSnapped: t.d, dUnsnapped: t.rawD })) };
  for (const t of truth) report.oracle.categories[t.cat] = (report.oracle.categories[t.cat] || 0) + 1;
  console.log(`  oracle done in ${oracleMs} ms; categories ${JSON.stringify(report.oracle.categories)}; ${report.oracle.nonManifoldPairs} pairs involve a non-edge-manifold mesh (treated as closed)`);
  console.log(`  ${report.oracle.noiseSensitivePairs.length} pairs change verdict/distance between the raw and the nm-snapped triangles (transform noise), e.g. ${report.oracle.noiseSensitivePairs.slice(0, 3).map((x) => x.pair + ': ' + x.unsnapped + '→' + x.snapped).join('; ')}`);
  // names for app-reported pairs that are not candidates (AABBs > 51 mm apart)
  const nameOf = new Map(await page.evaluate(() => window.__ccEls.map((e) => [e.gid, `${e.el.props.name} [${e.el.props.ifcType}]`])));
  report.timings.oracleMs = oracleMs;

  // ── 5. scoring ──
  const keyOf = (a, b) => [a, b].sort().join('|');
  const truthBy = new Map(truth.filter((t) => !t.error).map((t) => [keyOf(t.a, t.b), t]));
  const expectFor = (t, rules) => {
    const overlap = t.cat === 'crossing' || t.cat === 'contained';
    if (rules.hard && overlap) return 'hard';
    if ((rules.maxGap || 0) > 0 && t.within) return 'soft';
    return 'none';
  };
  const RULESETS = { default: { hard: true, maxGap: 50 }, hardOnly: { hard: true, maxGap: 0 }, clearance50: { hard: false, maxGap: 50 } };
  const CATS = ['crossing', 'contained', 'contact', 'clearance≤50mm', 'clearance>50mm', 'separate', 'not-candidate'];
  const bucket = (t) => !t ? 'not-candidate' : (t.cat === 'clearance' || t.cat === 'separate') ? (t.within ? 'clearance≤50mm' : t.cat === 'clearance' ? 'clearance>50mm' : 'separate') : t.cat;
  function prf(tp, fp, fn) { return { tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : 1, recall: tp + fn ? tp / (tp + fn) : 1 }; }
  for (const [key, res] of Object.entries(results)) {
    const rules = RULESETS[key];
    const appBy = new Map();
    for (const c of res.clashes) { const k = keyOf(c.a, c.b); if (!appBy.has(k) || (c.type === 'hard' && appBy.get(k).type !== 'hard')) appBy.set(k, c); }
    const conf = {}; for (const c of CATS) conf[c] = { hard: 0, soft: 0, none: 0 };
    let hTP = 0, hFP = 0, hFN = 0, iTP = 0, iFP = 0, iFN = 0, xTP = 0, xFP = 0, xFN = 0, sTP = 0, sFP = 0, sFN = 0, exact = 0, n = 0;
    const dErr = [], missed = [], spurious = [], wrongType = [];
    const keys = new Set([...truthBy.keys(), ...[...appBy.keys()].filter((k) => !cand.sampled || truthBy.has(k))]);
    for (const k of keys) {
      const t = truthBy.get(k), c = appBy.get(k);
      const got = c ? c.type : 'none';
      const exp = t ? expectFor(t, rules) : 'none';
      conf[bucket(t)][got === 'hard' || got === 'soft' ? got : 'none']++;
      n++; if (got === exp) exact++;
      const overlap = t && (t.cat === 'crossing' || t.cat === 'contained');
      const incl = overlap || (t && t.cat === 'contact');
      if (got === 'hard') { if (overlap) hTP++; else hFP++; if (incl) iTP++; else iFP++; if (t && t.cat === 'crossing') xTP++; else xFP++; }
      else { if (overlap && rules.hard) hFN++; if (incl && rules.hard) iFN++; if (t && t.cat === 'crossing' && rules.hard) xFN++; }
      const softExp = exp === 'soft';
      if (got === 'soft') { if (softExp) sTP++; else sFP++; } else if (softExp) sFN++;
      if (got === 'soft' && t && typeof c.clearanceMm === 'number') dErr.push(Math.abs(c.clearanceMm - (t.cat === 'clearance' || t.cat === 'separate' ? t.d * 1000 : 0)));
      const desc = { key: k, pair: (t ? `${t.nameA} [${t.typeA}] x ${t.nameB} [${t.typeB}]` : k.split('|').map((g) => nameOf.get(g) || g).join(' x ')), truth: t ? t.cat : 'not a candidate (AABB > 51 mm apart)', exactMm: t ? +(t.d * 1000).toFixed(3) : null, expected: exp, app: got, appMm: c ? (c.type === 'soft' ? c.clearanceMm : c.distance) : null, merged: c ? c.merged : false, opening: c ? c.opening : null };
      if (got === 'none' && exp !== 'none') missed.push(desc);
      else if (got !== 'none' && exp === 'none') spurious.push(desc);
      else if (got !== exp) wrongType.push(desc);
    }
    const out = {
      evaluatedPairs: n, exactOutcomeMatch: exact,
      hard_vs_overlap: prf(hTP, hFP, hFN), hard_vs_crossing_contact_contained: prf(iTP, iFP, iFN), hard_vs_crossing_only: prf(xTP, xFP, xFN),
      soft_within_50mm: prf(sTP, sFP, sFN),
      clearance_error_mm: { n: dErr.length, max: dErr.length ? Math.max(...dErr) : 0, mean: dErr.length ? dErr.reduce((s, v) => s + v, 0) / dErr.length : 0, over1mm: dErr.filter((e) => e > 1).length },
      confusion: conf, missed, spurious, wrongType,
    };
    report.runs[key] = out;
    const f = (x) => `P=${x.precision.toFixed(3)} R=${x.recall.toFixed(3)} (tp ${x.tp} fp ${x.fp} fn ${x.fn})`;
    console.log(`\n=== SCORE ${RUNS[key].label} vs oracle (${n} pairs${cand.sampled ? ', sampled' : ''}) ===`);
    if (rules.hard) {
      console.log(`  HARD vs crossing∪contained          ${f(out.hard_vs_overlap)}`);
      console.log(`  HARD vs crossing∪contact∪contained  ${f(out.hard_vs_crossing_contact_contained)}`);
      console.log(`  HARD vs crossing only               ${f(out.hard_vs_crossing_only)}`);
    }
    if (rules.maxGap) console.log(`  SOFT (≤50 mm, incl. contact)        ${f(out.soft_within_50mm)}`);
    console.log(`  exact outcome match                 ${exact}/${n}`);
    if (rules.maxGap) console.log(`  clearance error vs exact            max ${out.clearance_error_mm.max.toFixed(3)} mm, mean ${out.clearance_error_mm.mean.toFixed(3)} mm, >1 mm: ${out.clearance_error_mm.over1mm}/${out.clearance_error_mm.n}`);
    console.log('  confusion (truth row × app column):');
    console.log('    ' + 'truth'.padEnd(16) + 'hard'.padStart(7) + 'soft'.padStart(7) + 'none'.padStart(7));
    for (const c of CATS) { const m = conf[c]; if (m.hard + m.soft + m.none) console.log('    ' + c.padEnd(16) + String(m.hard).padStart(7) + String(m.soft).padStart(7) + String(m.none).padStart(7)); }
    const show = (label, arr) => {
      if (!arr.length) return;
      console.log(`  ${label}: ${arr.length}${arr.length > 25 ? ' (first 25)' : ''}`);
      for (const d of arr.slice(0, 25)) console.log(`    - ${d.pair}: truth ${d.truth}${d.exactMm != null ? ' ' + d.exactMm + ' mm' : ''}; expected ${d.expected}, app ${d.app}${d.appMm != null ? ' (' + d.appMm + ' mm)' : ''}${d.merged ? ' [merged row]' : ''}${d.opening ? ' [opening ' + d.opening + ']' : ''}`);
    };
    show('MISSED', missed); show('SPURIOUS', spurious); show('WRONG TYPE', wrongType);
  }

  // planted manifest (analytic intent) per run
  console.log('\n=== PLANTED CASES (manifest intent) — expected → app per run ===');
  const pl = [];
  for (const c of gen.manifest.cases) {
    const k = keyOf(c.a.globalId, c.b.globalId);
    const t = truthBy.get(k);
    const row = { id: c.id, name: c.name, manifest: c.category, toleranceRelation: c.toleranceRelation || null, oracle: t ? t.cat : null, oracleMm: t ? +(t.d * 1000).toFixed(4) : null, runs: {} };
    for (const [key, res] of Object.entries(results)) {
      const rules = RULESETS[key];
      const hit = res.clashes.find((x) => keyOf(x.a, x.b) === k);
      const got = hit ? hit.type : 'none';
      const within = c.category === 'clearance' || c.category === 'separate' ? (c.toleranceRelation === 'at' ? null : (c.distanceM != null ? c.distanceM <= 0.05 : null)) : true;
      let exp;
      if (rules.hard && (c.category === 'crossing' || c.category === 'contained')) exp = 'hard';
      else if (rules.maxGap && (c.category === 'contact' || c.category === 'crossing' || c.category === 'contained' || within === true)) exp = 'soft';
      else if (within === null && rules.maxGap) exp = 'soft|none';
      else exp = 'none';
      row.runs[key] = { expected: exp, app: got, appMm: hit ? (hit.type === 'soft' ? hit.clearanceMm : hit.distance) : null, opening: hit ? hit.opening : null, ok: exp.split('|').includes(got) };
    }
    pl.push(row);
    console.log(`  ${c.id} ${c.name.slice(0, 58).padEnd(58)} ${c.category.padEnd(9)} oracle=${String(row.oracle).padEnd(9)}` +
      Object.entries(row.runs).map(([k, r]) => ` ${k}:${r.expected}→${r.app}${r.appMm != null ? '(' + r.appMm + ')' : ''}${r.ok ? '' : ' ✗'}`).join(''));
  }
  report.planted = pl;
  const plantedBad = pl.reduce((s, r) => s + Object.values(r.runs).filter((x) => !x.ok).length, 0);
  console.log(`  planted outcome mismatches: ${plantedBad} of ${pl.length * 3} (case × run)`);

  // Reproducers: the app's own world triangles for every planted pair and for
  // (up to CC_ACCURACY_REPRO_MAX, default 40) mismatched background pairs, so
  // a discrepancy can be replayed against the engine kernels in Node.
  const want = new Set(gen.manifest.cases.map((c) => keyOf(c.a.globalId, c.b.globalId)));
  const reproMax = +(process.env.CC_ACCURACY_REPRO_MAX || 40);
  for (const r of Object.values(report.runs)) {
    for (const d of [...r.missed, ...r.spurious, ...r.wrongType]) {
      if (want.size >= gen.manifest.cases.length + reproMax) break;
      want.add(d.key);
    }
  }
  report.repro = await page.evaluate((keys) => {
    const byGid = new Map(window.__ccEls.map((e) => [e.gid, e]));
    const out = {};
    for (const k of keys) {
      const [a, b] = k.split('|');
      const A = byGid.get(a), B = byGid.get(b);
      if (A && B) out[k] = { nameA: A.el.props.name, nameB: B.el.props.name, a: Array.from(window._ccGetWorldTris(A.el)), b: Array.from(window._ccGetWorldTris(B.el)) };
    }
    return out;
  }, [...want]);
  await page.close();
} catch (e) {
  harnessFail(e && e.stack || String(e));
} finally {
  await browser.close();
  server.close();
}

if (pageErrors.length) { harnessFail('page errors: ' + pageErrors.slice(0, 5).join(' | ')); }
report.pageErrors = pageErrors; report.consoleErrors = consoleErrors.slice(0, 50);
await mkdir(dirname(REPORT_PATH), { recursive: true });
await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
console.log(`\nreport written to ${REPORT_PATH}`);
console.log(harnessOk ? 'ACCURACY HARNESS OK (engine discrepancies are recorded above, not failed on)' : 'ACCURACY HARNESS FAILED');
process.exit(harnessOk ? 0 : 1);
