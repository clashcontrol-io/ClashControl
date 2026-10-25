// Seeded randomness for the pressure-test harness (tests/pressure/*).
//
// Everything the harness randomises — the covering array, each combo's edit
// sequence, which clashes get a status edit, where a cancel lands, the oracle
// sample — draws from a mulberry32 stream seeded by hashSeed(runSeed, ...parts),
// so a combo replays bit-for-bit from (seed, combo index) or from its JSON file.
// Same mulberry32 as tests/fixtures/generate-building-ifc.js.

export function mulberry32(seed) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a over the UTF-16 code units of a string -> uint32.
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Combine a run seed with any number of labels/numbers into one uint32 seed.
// Order-sensitive, stable across Node versions (no Math.random, no hashing of
// object key order: parts are stringified individually).
export function hashSeed(...parts) {
  let h = 0x9e3779b9;
  for (const p of parts) {
    const s = typeof p === 'string' ? 's:' + p : typeof p === 'number' ? 'n:' + p : 'j:' + JSON.stringify(p);
    h = Math.imul(h ^ fnv1a(s), 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
  }
  return h >>> 0;
}

export function rngFor(...parts) { return mulberry32(hashSeed(...parts)); }

export function pick(rnd, arr) { return arr[Math.floor(rnd() * arr.length)]; }

export function shuffle(rnd, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// k distinct items (order = sampled order); k >= arr.length returns a shuffle.
export function sample(rnd, arr, k) { return shuffle(rnd, arr).slice(0, Math.max(0, k)); }

// Short stable digest for a JSON-able value (report keys, determinism checks).
export function digest(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return fnv1a(s).toString(16).padStart(8, '0') + fnv1a('x' + s).toString(16).padStart(8, '0');
}
