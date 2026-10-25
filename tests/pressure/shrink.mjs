#!/usr/bin/env node
// Shrinks a failing pressure-test combo (a repro file written by run.mjs) to a
// minimal reproduction with ddmin (tests/pressure/ddmin.mjs), in three stages:
//   1. dims     — reset as many non-default dims to their defaults as possible;
//   2. edits    — the smallest sub-sequence of the combo's edit plan;
//   3. elements — the generated federation reduced: background building off
//                 (planted cases only), then a ddmin over the planted case ids
//                 (generate-building-ifc.js `cases`), else smaller bay/storey
//                 grids. The default generator output is untouched by this.
// "Still failing" = at least one of the originally failing invariants fails
// again. The result is written to $CC_PRESSURE_OUT/<seed>/shrunk-<id>.json and
// replays with `node tests/pressure/run.mjs --combo <file>` (dims) — the edits
// and fixture reductions are carried in the file and honoured by replay.
//
//   CC_CHROMIUM_EXECUTABLE=... CC_BROWSER_OFFLINE_DEPS=1 node tests/pressure/shrink.mjs <repro.json> [--max-tests 80]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { ddmin } from './ddmin.mjs';
import { makeCombo, nonDefaultDims, defaults } from './dims.mjs';
import { startHarness, InfraError } from './harness.mjs';
import { executeCombo, Fixtures, loadOracleSrc, planEdits } from './invariants.mjs';

export async function shrinkCombo(h, env, repro, opts = {}) {
  const combo0 = makeCombo(repro.combo.dims, { tier: repro.combo.tier, runSeed: repro.combo.runSeed, index: repro.combo.index, seed: repro.combo.seed });
  const failingInv = new Set((repro.failing || []).map((c) => c.inv.split('=')[0]));
  const log = opts.log || console.log;
  let tests = 0;
  const maxTests = opts.maxTests || 80;
  const baseEnv = Object.assign({}, env, {
    i3: [...failingInv].some((x) => x.startsWith('I3')),
    oracle: [...failingInv].some((x) => x === 'I5.oracle'),
  });
  async function fails(dimsValues, extra) {
    if (tests >= maxTests) return false;
    tests++;
    const c = makeCombo(dimsValues, { tier: combo0.tier, runSeed: combo0.runSeed, index: combo0.index, seed: combo0.seed });
    const e = Object.assign({}, baseEnv, extra || {});
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await executeCombo(h, c, e);
        const hit = r.checks.filter((x) => x.ok === false && failingInv.has(x.inv.split('=')[0]));
        log(`    shrink test ${tests}: ${hit.length ? 'FAILS' : 'passes'} (${nonDefaultDims(c).length} dims${e.edits ? ', ' + e.edits.length + ' edits' : ''}${e.extraGen ? ', ' + JSON.stringify(e.extraGen) : ''})`);
        if (hit.length) last = { combo: c, env: e, checks: hit };
        return hit.length > 0;
      } catch (err) {
        if (err instanceof InfraError && attempt < 3) { await h.restartBrowser(); continue; }
        log('    shrink test error: ' + (err && err.message));
        return false;
      }
    }
  }
  let last = null;
  // 1. dims
  const nd = nonDefaultDims(combo0);
  log(`  stage 1: ${nd.length} non-default dims`);
  const pickDims = (names) => { const o = defaults(); for (const n of names) o[n] = combo0.dims[n]; return o; };
  const r1 = await ddmin(nd, (sub) => fails(pickDims(sub)));
  let dims = pickDims(r1.result);
  // 2. edits
  let edits = null;
  if (dims['run.kind'] === 'smart' && dims['edits.count'] > 0) {
    const plan = planEdits(combo0, dims['edits.count'], 3);
    log(`  stage 2: ${plan.length} edits`);
    const r2 = await ddmin(plan, (sub) => fails(dims, { edits: sub }));
    edits = r2.result;
  }
  // 3. elements (generated fixtures only)
  let extraGen = null;
  if (!env.fixtures.externalFiles) {
    const withEdits = edits ? { edits } : {};
    log('  stage 3: fixture reduction');
    if (await fails(dims, Object.assign({ extraGen: { background: false } }, withEdits))) {
      const fx = await env.fixtures.get(dims, {});
      const ids = fx.manifest.cases.map((c) => c.id);
      const r3 = await ddmin(ids, (sub) => fails(dims, Object.assign({ extraGen: { background: false, cases: sub } }, withEdits)));
      extraGen = { background: false, cases: r3.result };
    } else {
      for (const scale of ['1x1x1', '1x2x1', '2x1x1', '1x2x2', '2x2x1']) {
        if (await fails(dims, Object.assign({ extraGen: { scale, cases: [] } }, withEdits))) { extraGen = { scale, cases: [] }; break; }
        if (await fails(dims, Object.assign({ extraGen: { scale } }, withEdits))) { extraGen = { scale }; break; }
      }
    }
  }
  // final confirmation run
  const ok = await fails(dims, Object.assign({}, edits ? { edits } : {}, extraGen ? { extraGen } : {}));
  return { confirmed: ok, tests, combo: makeCombo(dims, { tier: combo0.tier, runSeed: combo0.runSeed, index: combo0.index, seed: combo0.seed }), dims: nonDefaultDims({ dims }), edits, extraGen, checks: last ? last.checks : null };
}

async function main() {
  const file = process.argv[2];
  if (!file) { console.error('usage: node tests/pressure/shrink.mjs <repro.json> [--max-tests N]'); process.exit(2); }
  const i = process.argv.indexOf('--max-tests');
  const maxTests = i > 0 ? +process.argv[i + 1] : 80;
  const repro = JSON.parse(await readFile(file, 'utf8'));
  const h = await startHarness({});
  const externalFiles = process.env.CC_PRESSURE_FILES ? process.env.CC_PRESSURE_FILES.split(',').filter(Boolean) : null;
  const env = { fixtures: new Fixtures(h, { externalFiles }), oracleSrc: await loadOracleSrc(), canon: new Map() };
  let res;
  try { res = await shrinkCombo(h, env, repro, { maxTests }); } finally { await h.close(); }
  const out = join(dirname(file), 'shrunk-' + (repro.combo.id || res.combo.id) + '.json');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify({ combo: res.combo, edits: res.edits, extraGen: res.extraGen, confirmed: res.confirmed, shrinkTests: res.tests, minimalDims: res.dims, failing: res.checks, original: repro.combo.dims }, null, 2));
  console.log(`shrunk to dims ${JSON.stringify(res.dims)}${res.edits ? ' edits ' + JSON.stringify(res.edits.map((e) => e.k)) : ''}${res.extraGen ? ' fixture ' + JSON.stringify(res.extraGen) : ''} — ${res.confirmed ? 'confirmed' : 'NOT confirmed'} after ${res.tests} tests`);
  console.log(`minimal repro: ${out}  (replay: node tests/pressure/run.mjs --combo ${out})`);
}

if (import.meta.url === 'file://' + process.argv[1]) main().catch((e) => { console.error(e && e.stack || e); process.exit(2); });
