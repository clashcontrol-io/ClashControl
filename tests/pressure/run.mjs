#!/usr/bin/env node
// Pressure-test runner: executes a tier's combos (tests/pressure/dims.mjs)
// against the real app in one long-lived Chromium and checks every invariant
// (tests/pressure/invariants.mjs) on each. Failures are written as replayable
// repro files and (unless --no-shrink) shrunk with ddmin (tests/pressure/shrink.mjs).
//
//   CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 node tests/pressure/run.mjs --tier fast --seed 1
//   node tests/pressure/run.mjs --tier nightly --seed 7
//   node tests/pressure/run.mjs --combo /path/to/combo.json          (replay one combo)
//   options: --count N (cap combos), --from N (skip the first N, resume), --only <combo id>, --shrink [--shrink-max 5 --max-tests 60], --no-i3, --no-oracle, --trace,
//            --repeat-every N (re-execute every Nth combo, I16 cross-execution digest)
//   env:     CC_PRESSURE_OUT (default <os.tmpdir()>/cc-pressure), CC_PRESSURE_FILES
//            (comma-separated IFC paths used instead of the generated federation; reports name them by hash)
//
// No timing asserts. Infra problems (browser crash, page never boots, missing
// deps) are retried; an invariant failure is never retried.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { combosFor, makeCombo } from './dims.mjs';
import { startHarness, InfraError } from './harness.mjs';
import { executeCombo, Fixtures, loadOracleSrc } from './invariants.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(n);
const tier = arg('--tier', 'fast');
const seed = +arg('--seed', 1);
const comboFile = arg('--combo', null);
const count = arg('--count', null);
const only = arg('--only', null);
const repeatEvery = +arg('--repeat-every', tier === 'nightly' ? 10 : 0);
const OUT = join(process.env.CC_PRESSURE_OUT || join(tmpdir(), 'cc-pressure'), String(comboFile ? 'replay' : seed));
const COMBO_TIMEOUT_MS = +(process.env.CC_PRESSURE_COMBO_TIMEOUT_MS || 10 * 60_000);

const log = (...a) => console.log(...a);

async function main() {
  await mkdir(OUT, { recursive: true });
  let combos, fileExtra = {};
  if (comboFile) {
    const c = JSON.parse(await readFile(comboFile, 'utf8'));
    if (c.edits) fileExtra.edits = c.edits;
    if (c.extraGen) fileExtra.extraGen = c.extraGen;
    combos = [c.combo ? c.combo : c];
    combos = combos.map((x) => (x.dims ? makeCombo(x.dims, { tier: x.tier, runSeed: x.runSeed, index: x.index, seed: x.seed }) : x));
  } else combos = combosFor(tier, seed, count ? { count: +count } : {});
  if (only) combos = combos.filter((c) => c.id === only);
  const from = +arg('--from', 0);
  if (from) combos = combos.slice(from);
  const externalFiles = process.env.CC_PRESSURE_FILES ? process.env.CC_PRESSURE_FILES.split(',').filter(Boolean) : null;
  const t0 = Date.now();
  const h = await startHarness({ log });
  const env = Object.assign({ fixtures: new Fixtures(h, { externalFiles }), oracleSrc: await loadOracleSrc(), canon: new Map(), i3: !flag('--no-i3'), oracle: !flag('--no-oracle'), trace: flag('--trace'), log }, fileExtra);
  const results = [];
  const healthBase = new Map(); // page boot -> {listeners, gl, n}
  log(`pressure ${comboFile ? 'replay ' + comboFile : 'tier=' + tier + ' seed=' + seed}: ${combos.length} combos${externalFiles ? ' (external files, named by hash)' : ''}; out ${OUT}`);
  try {
    for (let k = 0; k < combos.length; k++) {
      const combo = combos[k];
      let res = null, tries = 0;
      for (;;) {
        tries++;
        try {
          res = await withTimeout(executeCombo(h, combo, env), COMBO_TIMEOUT_MS);
          break;
        } catch (e) {
          if (e instanceof InfraError && tries < 3) {
            log(`  [infra] ${combo.id}: ${e.message} — retry ${tries}`);
            await h.restartBrowser();
            continue;
          }
          if (e && e.name === 'Timeout') {
            res = { id: combo.id, status: 'FAIL', checks: [{ inv: 'I8.hang', ok: false, detail: 'combo did not finish within ' + COMBO_TIMEOUT_MS + ' ms (run or load never settled)' }], notes: [] };
            await h.restartBrowser();
          } else if (e instanceof InfraError) {
            res = { id: combo.id, status: 'INFRA', checks: [], notes: [e.message] };
          } else {
            res = { id: combo.id, status: 'FAIL', checks: [{ inv: 'harness/app exception', ok: false, detail: String((e && e.stack) || e).slice(0, 2000) }], notes: [] };
            try { if (h.cur) h.cur.dead = true; } catch (_) {}
          }
          break;
        }
      }
      // I15: health drift between combos (after a reset the page should look the same)
      if (res.status !== 'INFRA' && h.cur && !h.cur.dead) {
        try {
          await h.cur.ev(() => window.__ccH.reset());
          const hs = await h.health(h.cur);
          const base = healthBase.get(h.cur.boot);
          if (!base || base.n < 2) healthBase.set(h.cur.boot, { listeners: hs.listeners, gl: hs.glContexts, n: (base ? base.n : 0) + 1 });
          else {
            const lw = hs.listeners.window.n - base.listeners.window.n, ld = hs.listeners.document.n - base.listeners.document.n, gl = hs.glContexts - base.gl;
            const ok = lw <= 0 && ld <= 0 && gl <= 0;
            res.checks.push({ inv: 'I15.health', ok, detail: ok ? undefined : `after reset: window listeners +${lw}, document listeners +${ld}, WebGL contexts +${gl} vs the page's warm baseline (${JSON.stringify(diffBy(base.listeners, hs.listeners))})` });
            if (!ok) { res.status = 'FAIL'; h.cur.dead = true; log('  health drift -> fresh page'); }
          }
        } catch (e) { if (!(e instanceof InfraError)) throw e; }
      }
      // I16 across executions
      if (repeatEvery && (k + 1) % repeatEvery === 0 && res.digest) {
        try {
          const again = await withTimeout(executeCombo(h, combo, env), COMBO_TIMEOUT_MS);
          const ok = again.digest === res.digest;
          res.checks.push({ inv: 'I16.digest', ok, detail: ok ? undefined : 'the same combo executed twice gave different normalized results (' + res.digest + ' vs ' + again.digest + ')' });
          if (!ok) res.status = 'FAIL';
        } catch (e) { res.notes.push('I16 repeat failed: ' + e.message); }
      }
      res.dims = combo.dims;
      results.push(res);
      const fails = res.checks.filter((c) => c.ok === false);
      const skips = res.checks.filter((c) => c.skipped).length;
      log(`${String(k + 1).padStart(3)}/${combos.length} ${res.status.padEnd(5)} ${combo.id.padEnd(18)} ${(res.ms ? Math.round(res.ms / 100) / 10 + 's' : '').padStart(6)} ${short(combo.dims)}${skips ? '  [' + skips + ' skipped]' : ''}${res.notes && res.notes.length ? '  notes: ' + res.notes.join(' | ').slice(0, 200) : ''}`);
      for (const f of fails) log(`        ✗ ${f.inv}: ${String(f.detail).slice(0, 600)}`);
      if (res.status !== 'PASS') await writeRepro(combo, res);
    }
  } finally {
    await h.close();
  }
  const wallMs = Date.now() - t0;
  const summary = summarize(results, wallMs);
  await writeFile(join(OUT, `report-${comboFile ? 'replay' : tier}.json`), JSON.stringify({ tier, seed, wallMs, summary, results }, null, 2));
  log(`\n${summary.text}`);
  log(`report: ${join(OUT, `report-${comboFile ? 'replay' : tier}.json`)}`);
  const failed = results.filter((r) => r.status === 'FAIL');
  if (failed.length && flag('--shrink')) {
    const { shrinkCombo } = await import('./shrink.mjs');
    const h2 = await startHarness({ log });
    const env2 = { fixtures: new Fixtures(h2, { externalFiles }), oracleSrc: await loadOracleSrc(), canon: new Map() };
    try {
      for (const r of failed.slice(0, +(arg('--shrink-max', 5)))) {
        const combo = combos.find((c) => c.id === r.id);
        log(`shrinking ${r.id} …`);
        const s = await shrinkCombo(h2, env2, { combo, failing: r.checks.filter((c) => c.ok === false) }, { maxTests: +(arg('--max-tests', 60)), log });
        const out = join(OUT, `shrunk-${r.id}.json`);
        await writeFile(out, JSON.stringify({ combo: s.combo, edits: s.edits, extraGen: s.extraGen, confirmed: s.confirmed, shrinkTests: s.tests, minimalDims: s.dims, failing: s.checks, original: combo.dims }, null, 2));
        log(`  -> ${JSON.stringify(s.dims)}${s.edits ? ' edits ' + JSON.stringify(s.edits.map((e) => e.k)) : ''}${s.extraGen ? ' fixture ' + JSON.stringify(s.extraGen) : ''} (${s.confirmed ? 'confirmed' : 'not confirmed'}): ${out}`);
      }
    } finally { await h2.close(); }
  } else if (failed.length && !comboFile) {
    log('failures were written as repro files; shrink them with: node tests/pressure/shrink.mjs <repro.json> (or rerun with --shrink)');
  }
  process.exit(results.every((r) => r.status === 'PASS') ? 0 : 1);
}

function short(d) {
  return [d['fixture.scale'], d['fixture.georef'], d['models.subset'] + '/' + d['models.order'], d['models.extra'] !== 'none' ? d['models.extra'] : '', d['load.path'] !== 'worker' ? d['load.path'] : '',
    'h' + (d['rules.hard'] ? 1 : 0) + 'g' + d['rules.maxGap'] + (d['rules.minGap'] ? 'm' + d['rules.minGap'] : '') + (d['rules.duplicates'] ? 'D' : '') + (d['rules.self'] === 'all' ? 'S' : '') + (d['rules.minOverlapVolM3'] ? 'V' : '') + (d['rules.tolerance'] !== 'none' ? 'T' : ''),
    d['engine.path'], d['run.kind'] + (d['run.kind'] === 'smart' ? 'E' + d['edits.count'] : ''), d.cancel !== 'none' ? 'cancel:' + d.cancel : '', d.failure !== 'none' ? 'fail:' + d.failure : '', d.roundtrip !== 'none' ? 'rt:' + d.roundtrip : ''].filter(Boolean).join(' ');
}

function diffBy(a, b) {
  const o = {};
  for (const t of ['window', 'document']) for (const [k, v] of Object.entries(b[t].by)) { const w = (a[t].by[k] || 0); if (v > w) o[t + ':' + k] = v - w; }
  return o;
}

function summarize(results, wallMs) {
  const by = {};
  for (const r of results) for (const c of r.checks) {
    const k = c.inv.split('=')[0];
    const b = by[k] = by[k] || { pass: 0, fail: 0, skipped: 0 };
    if (c.skipped) b.skipped++; else if (c.ok) b.pass++; else b.fail++;
  }
  const n = { PASS: 0, FAIL: 0, INFRA: 0 };
  for (const r of results) n[r.status] = (n[r.status] || 0) + 1;
  const lines = [`${results.length} combos in ${(wallMs / 1000).toFixed(0)} s — PASS ${n.PASS}, FAIL ${n.FAIL}, INFRA ${n.INFRA}`];
  for (const [k, v] of Object.entries(by).sort()) lines.push(`  ${k.padEnd(28)} pass ${String(v.pass).padStart(4)}  fail ${String(v.fail).padStart(3)}  skipped ${v.skipped}`);
  return { counts: n, byInvariant: by, text: lines.join('\n') };
}

async function writeRepro(combo, res) {
  const file = join(OUT, `repro-${combo.id}.json`);
  await writeFile(file, JSON.stringify({ combo, failing: res.checks.filter((c) => c.ok === false), notes: res.notes, replay: `node tests/pressure/run.mjs --combo ${file}`, shrink: `node tests/pressure/shrink.mjs ${file}` }, null, 2));
  console.log(`        repro: ${file}`);
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([p.finally(() => clearTimeout(t)), new Promise((_, rej) => { t = setTimeout(() => { const e = new Error('timeout'); e.name = 'Timeout'; rej(e); }, ms); })]);
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(2); });
