// Pressure-test dimension table + seeded greedy covering arrays.
//
// A "combo" is one value per dimension. The harness (tests/pressure/harness.mjs)
// executes a combo against the real app and checks every invariant
// (tests/pressure/invariants.mjs) that applies to it. Which combos run is
// decided here:
//   fast    — the first N rows of a seeded PAIRWISE covering array over the
//             fast-tier value subsets (greedy, so the first rows cover the
//             most pairs);
//   nightly — a complete pairwise covering array over every value, plus a
//             3-wise requirement on {engine.path, run.kind, cancel, failure}
//             sharded over seeds: seed s must cover the triples whose ordinal
//             is ≡ s (mod 3), so any 3 consecutive seeds cover all of them;
//   soak    — uniformly random rows.
// Pure module (no browser, no fs) — unit-tested by tests/pressure.test.js.

import { mulberry32, hashSeed, shuffle } from './rng.mjs';

// Each dimension: name, values (values[0] is NOT special — `def` is the
// default, i.e. what the shipped app does / the neutral setting; shrinking
// resets dims to it), optional per-tier value subsets, and optional
// `adapter` map value -> feature name. A value whose adapter is absent from
// the running app is reported "SKIPPED (absent)" and run as `def`.
export const DIMS = [
  // ── fixture (generated federation, tests/fixtures/generate-building-ifc.js) ──
  { name: 'fixture.seed', values: [4242, 1337], def: 4242 },
  { name: 'fixture.scale', values: ['ci', '3x3x2', 'medium'], def: 'ci', tiers: { fast: ['ci', '3x3x2'] } },
  { name: 'fixture.georef', values: ['local', 'none', 'far'], def: 'local' },
  // ── which models, in which order, plus a duplicate/reload extra ──
  { name: 'models.subset', values: ['ASM', 'AS', 'AM', 'SM', 'A', 'S', 'M'], def: 'ASM' },
  { name: 'models.order', values: ['012', '021', '102', '120', '201', '210'], def: '012' },
  { name: 'models.extra', values: ['none', 'dup-load', 'reload'], def: 'none' },
  { name: 'load.path', values: ['worker', 'fallback', 'sharded'], def: 'worker', adapter: { sharded: 'shardedLoad' } },
  // ── rules ──
  { name: 'rules.hard', values: [true, false], def: true },
  { name: 'rules.maxGap', values: [50, 0, 30, 100], def: 50 },
  { name: 'rules.minGap', values: [0, 10], def: 0 },
  { name: 'rules.duplicates', values: [false, true], def: false },
  { name: 'rules.self', values: ['none', 'all'], def: 'none' },
  { name: 'rules.excludeSameDiscipline', values: [true, false], def: true },
  { name: 'rules.minOverlapVolM3', values: [0, 0.05], def: 0 },
  { name: 'rules.tolerance', values: ['none', 'beam-duct-200'], def: 'none' },
  { name: 'rules.useSemanticFilter', values: [true, false], def: true },
  { name: 'rules.includeSpaces', values: [false, true], def: false },
  { name: 'roles.exclusion', values: ['none', 'leave-out'], def: 'none', adapter: { 'leave-out': 'roleExclusion' } },
  // ── display-only (I7: must not change the clash signature, must keep smart re-runs smart) ──
  { name: 'display.hideProvided', values: [true, false], def: true },
  { name: 'display.hideContacts', values: [true, false], def: true },
  { name: 'display.tab', values: ['clashes', 'issues', 'models'], def: 'clashes' },
  { name: 'display.style', values: ['standard', 'wireframe', 'shaded'], def: 'standard' },
  { name: 'display.section', values: ['off', 'plane', 'box'], def: 'off' },
  { name: 'display.showSpaces', values: [false, true], def: false },
  { name: 'display.occlusion', values: ['default', 'off'], def: 'default' },
  { name: 'display.locale', values: ['en', 'ja'], def: 'en' },
  { name: 'display.filter', values: ['none', 'status', 'bucket'], def: 'none', adapter: { bucket: 'bucketFilter' } },
  // ── engine / run / cancel / failure (3-wise group) ──
  { name: 'engine.path', values: ['auto', 'js', 'wasm', 'engine', 'pool-wasm', 'pool-js', 'native'], def: 'auto' },
  { name: 'run.kind', values: ['full', 'smart'], def: 'full' },
  { name: 'edits.count', values: [0, 1, 3, 8], def: 0 },
  { name: 'cancel', values: ['none', 'first', 'mid', 'last', 'abort-load'], def: 'none' },
  { name: 'failure', values: ['none', 'spawn', 'mid-crash', 'no-wasm', 'idb-quota', 'ls-quota', 'addon-404'], def: 'none' },
  { name: 'storage', values: ['normal', 'low-bvh-cap', 'evict', 'autosave-gate'], def: 'normal', adapter: { 'low-bvh-cap': 'bvhCap', evict: 'bvhEvict', 'autosave-gate': 'autosaveGate' } },
  // ── round-trips (B4) ──
  { name: 'roundtrip', values: ['none', 'project', 'bcf-shown', 'bcf-all', 'undo-redo'], def: 'none' },
];

export const TRIPLE_DIMS = ['engine.path', 'run.kind', 'cancel', 'failure'];
export const EDIT_KINDS = ['move', 'openings', 'delete-model', 'park', 'restore', 'replace', 'rule-change', 'deny', 'status'];

export const TIERS = {
  fast: { combos: 24, pairwise: true, triples: false },
  nightly: { combos: Infinity, pairwise: true, triples: true, tripleShards: 3 },
  soak: { combos: 1000, random: true },
};

export function dimByName(name, dims = DIMS) { return dims.find((d) => d.name === name); }

export function defaults(dims = DIMS) {
  const o = {};
  for (const d of dims) o[d.name] = d.def;
  return o;
}

// Dims restricted to a tier's value subsets (dims with a single value drop
// out of the pair requirement naturally).
export function dimsForTier(tier, dims = DIMS) {
  return dims.map((d) => (d.tiers && d.tiers[tier] ? Object.assign({}, d, { values: d.tiers[tier].slice() }) : d));
}

// ── covering arrays ──
const pairKey = (i, a, j, b) => i + ',' + a + ',' + j + ',' + b;
const tripleKey = (i, a, j, b, k, c) => i + ',' + a + ',' + j + ',' + b + ',' + k + ',' + c;

export function allPairs(dims) {
  const out = [];
  for (let i = 0; i < dims.length; i++) for (let j = i + 1; j < dims.length; j++)
    for (let a = 0; a < dims[i].values.length; a++) for (let b = 0; b < dims[j].values.length; b++) out.push(pairKey(i, a, j, b));
  return out;
}

export function allTriples(dims, names, shard) {
  const idx = names.map((n) => dims.findIndex((d) => d.name === n)).filter((i) => i >= 0).sort((x, y) => x - y);
  const out = [];
  let ordinal = 0;
  for (let p = 0; p < idx.length; p++) for (let q = p + 1; q < idx.length; q++) for (let r = q + 1; r < idx.length; r++) {
    const [i, j, k] = [idx[p], idx[q], idx[r]];
    for (let a = 0; a < dims[i].values.length; a++) for (let b = 0; b < dims[j].values.length; b++) for (let c = 0; c < dims[k].values.length; c++) {
      if (!shard || ordinal % shard.of === shard.index) out.push(tripleKey(i, a, j, b, k, c));
      ordinal++;
    }
  }
  return out;
}

// Seeded greedy covering array (AETG-style): each new row starts from a
// random still-uncovered tuple and fills the remaining dims (in random order)
// with the value covering the most still-uncovered pairs/triples; the best of
// `candidates` such rows is kept. Rows are value-index arrays.
export function coveringArray(dims, opts = {}) {
  const rnd = mulberry32(opts.seed == null ? 1 : opts.seed);
  const maxRows = opts.maxRows == null ? Infinity : opts.maxRows;
  const nCand = opts.candidates || 24;
  const n = dims.length;
  const uncP = new Set(allPairs(dims));
  const uncT = new Set(opts.triples ? allTriples(dims, opts.triples, opts.shard) : []);
  const tripleSets = [];
  if (opts.triples) {
    const idx = opts.triples.map((nm) => dims.findIndex((d) => d.name === nm)).filter((i) => i >= 0).sort((x, y) => x - y);
    for (let p = 0; p < idx.length; p++) for (let q = p + 1; q < idx.length; q++) for (let r = q + 1; r < idx.length; r++) tripleSets.push([idx[p], idx[q], idx[r]]);
  }
  const TW = 3; // a triple is worth 3 pairs: keeps the 3-wise group from trailing
  function gainOf(row, i, v) {
    let g = 0;
    for (let j = 0; j < n; j++) {
      if (j === i || row[j] < 0) continue;
      if (uncP.has(i < j ? pairKey(i, v, j, row[j]) : pairKey(j, row[j], i, v))) g++;
    }
    for (const t of tripleSets) {
      if (!t.includes(i)) continue;
      const vals = t.map((d) => (d === i ? v : row[d]));
      if (vals.some((x) => x < 0)) continue;
      if (uncT.has(tripleKey(t[0], vals[0], t[1], vals[1], t[2], vals[2]))) g += TW;
    }
    return g;
  }
  function scoreRow(row) {
    let s = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (uncP.has(pairKey(i, row[i], j, row[j]))) s++;
    for (const t of tripleSets) if (uncT.has(tripleKey(t[0], row[t[0]], t[1], row[t[1]], t[2], row[t[2]]))) s += TW;
    return s;
  }
  const rows = [];
  while ((uncP.size || uncT.size) && rows.length < maxRows) {
    const pool = uncT.size ? Array.from(uncT) : Array.from(uncP);
    let best = null, bestScore = -1;
    for (let c = 0; c < nCand; c++) {
      const row = new Array(n).fill(-1);
      const seedKey = pool[Math.floor(rnd() * pool.length)].split(',').map(Number);
      for (let s = 0; s < seedKey.length; s += 2) row[seedKey[s]] = seedKey[s + 1];
      for (const i of shuffle(rnd, [...Array(n).keys()])) {
        if (row[i] >= 0) continue;
        let bv = [], bg = -1;
        for (let v = 0; v < dims[i].values.length; v++) {
          const g = gainOf(row, i, v);
          if (g > bg) { bg = g; bv = [v]; } else if (g === bg) bv.push(v);
        }
        row[i] = bv[Math.floor(rnd() * bv.length)];
      }
      const sc = scoreRow(row);
      if (sc > bestScore) { bestScore = sc; best = row; }
    }
    rows.push(best);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) uncP.delete(pairKey(i, best[i], j, best[j]));
    for (const t of tripleSets) uncT.delete(tripleKey(t[0], best[t[0]], t[1], best[t[1]], t[2], best[t[2]]));
  }
  return rows;
}

// Which required tuples a set of rows misses (empty arrays = full coverage).
export function coverageReport(dims, rows, opts = {}) {
  const pairs = new Set(allPairs(dims));
  const triples = new Set(opts.triples ? allTriples(dims, opts.triples, opts.shard) : []);
  const tripleSets = [];
  if (opts.triples) {
    const idx = opts.triples.map((nm) => dims.findIndex((d) => d.name === nm)).filter((i) => i >= 0).sort((x, y) => x - y);
    for (let p = 0; p < idx.length; p++) for (let q = p + 1; q < idx.length; q++) for (let r = q + 1; r < idx.length; r++) tripleSets.push([idx[p], idx[q], idx[r]]);
  }
  const total = { pairs: pairs.size, triples: triples.size };
  for (const row of rows) {
    for (let i = 0; i < dims.length; i++) for (let j = i + 1; j < dims.length; j++) pairs.delete(pairKey(i, row[i], j, row[j]));
    for (const t of tripleSets) triples.delete(tripleKey(t[0], row[t[0]], t[1], row[t[1]], t[2], row[t[2]]));
  }
  return { total, missingPairs: [...pairs], missingTriples: [...triples] };
}

export function rowToDims(row, dims = DIMS) {
  const o = {};
  dims.forEach((d, i) => { o[d.name] = d.values[row[i]]; });
  return o;
}

// The combos a tier runs for a seed. Returns [{v, id, tier, runSeed, index, seed, dims}].
export function combosFor(tier, runSeed, opts = {}) {
  const T = TIERS[tier];
  if (!T) throw new Error('unknown tier ' + tier + ' (fast|nightly|soak)');
  const dims = dimsForTier(tier);
  let rows;
  if (T.random) {
    const rnd = mulberry32(hashSeed(runSeed, tier, 'random'));
    const n = opts.count || T.combos;
    rows = [];
    for (let k = 0; k < n; k++) rows.push(dims.map((d) => Math.floor(rnd() * d.values.length)));
  } else {
    rows = coveringArray(dims, {
      seed: hashSeed(runSeed, tier, 'covering'),
      triples: T.triples ? TRIPLE_DIMS : null,
      shard: T.triples && T.tripleShards ? { of: T.tripleShards, index: ((runSeed % T.tripleShards) + T.tripleShards) % T.tripleShards } : null,
    });
    const n = opts.count || T.combos;
    if (rows.length > n) rows = rows.slice(0, n);
  }
  return rows.map((row, index) => makeCombo(rowToDims(row, dims), { tier, runSeed, index }));
}

export function makeCombo(dimValues, meta = {}) {
  const dims = Object.assign(defaults(), dimValues);
  const index = meta.index == null ? 0 : meta.index;
  const runSeed = meta.runSeed == null ? 1 : meta.runSeed;
  const tier = meta.tier || 'custom';
  return { v: 1, id: tier + '-' + runSeed + '-' + index, tier, runSeed, index, seed: meta.seed != null ? meta.seed : hashSeed(runSeed, tier, index), dims };
}

// Dims of a combo that differ from the defaults (what ddmin shrinks over).
export function nonDefaultDims(combo) {
  return DIMS.filter((d) => JSON.stringify(combo.dims[d.name]) !== JSON.stringify(d.def)).map((d) => d.name);
}

// The app rules object a combo's rule dims stand for (over the shipped defaults).
export function rulesFor(dimsValues) {
  const r = {
    hard: dimsValues['rules.hard'], maxGap: dimsValues['rules.maxGap'], minGap: dimsValues['rules.minGap'],
    duplicates: dimsValues['rules.duplicates'],
    excludeSameDiscipline: dimsValues['rules.excludeSameDiscipline'],
    minOverlapVolM3: dimsValues['rules.minOverlapVolM3'],
    toleranceByTypePair: dimsValues['rules.tolerance'] === 'beam-duct-200' ? { 'IfcBeam:IfcDuctSegment': 200 } : {},
    useSemanticFilter: dimsValues['rules.useSemanticFilter'],
    includeSpaces: dimsValues['rules.includeSpaces'],
  };
  if (dimsValues['rules.self'] === 'all') { r.selfClashModels = 'all'; r.excludeSelf = false; } else { r.selfClashModels = 'none'; r.excludeSelf = true; }
  return r;
}
