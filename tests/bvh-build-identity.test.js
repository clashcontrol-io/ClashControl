'use strict';
// _buildBVHNode sorts each node's triangle range with _bvhStableSort (a
// hand-written stable merge sort) instead of the comparator TypedArray sort.
// The tree — node boxes, split sizes, leaf ranges and the index ORDER inside
// every leaf (which decides traversal order, hence tie-breaks of hit points
// and closest points) — must be exactly the one the comparator sort built.
// This suite rebuilds the reference with the original comparator sort and
// compares node for node on meshes with many key ties, -0, infinities and
// NaN (the NaN case uses the comparator sort with NaN last, _ccNanLastCmp —
// the order the Rust engine's `nan_last` gives; the old a - b comparator was
// no consistent order with NaN, and made Rust's sort panic).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const s = src.indexOf('  function _bvhStableSort(');
const e = src.indexOf('  function _getBVH(el)');
assert.ok(s !== -1 && e > s, 'BVH builder markers are stale');
const cur = new Function(src.slice(s, e) + '; return { _buildBVHForTris, _bvhStableSort, _ccNanLastCmp };')();
// the comparator sort: a - b (one order on keys without NaN), NaN last
const refSrc = src.slice(s, e).replace('_bvhStableSort(indices, lo, hi, keys, axis);',
  'indices.subarray(lo, hi).sort(keys.nan ? function(a,b){ return _ccNanLastCmp(keys[a*3+axis], keys[b*3+axis]); } : function(a,b){ return keys[a*3+axis] - keys[b*3+axis]; });');
assert.notStrictEqual(refSrc, src.slice(s, e), 'sort call site not found');
const ref = new Function(refSrc + '; return { _buildBVHForTris };')();

function rng(seed) {
  let a = seed | 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function mesh(n, seed, quant, specials) {
  const r = rng(seed), t = new Float32Array(n * 9);
  for (let i = 0; i < t.length; i++) t[i] = quant ? Math.round(r() * quant) / quant * 10 - 5 : r() * 10 - 5;
  if (specials) for (let i = 0; i < specials.length; i++) t[Math.floor(r() * t.length)] = specials[i];
  return t;
}
function sameTree(a, b, where) {
  for (const k of ['mnx', 'mny', 'mnz', 'mxx', 'mxy', 'mxz', 'lo', 'hi', 'cnt']) {
    if (!Object.is(a[k], b[k])) return where + '.' + k + ': ' + a[k] + ' vs ' + b[k];
  }
  if (a.lo !== undefined) {
    for (let i = a.lo; i < a.hi; i++) if (a.idx[i] !== b.idx[i]) return where + ' leaf idx[' + i + ']';
    return null;
  }
  return sameTree(a.left, b.left, where + 'L') || sameTree(a.right, b.right, where + 'R');
}

test('stable merge sort builds the comparator-sort tree exactly', () => {
  const cases = [
    [1, 0], [3, 0], [4, 0], [5, 0], [17, 0], [33, 2], [100, 0], [1000, 0], [1000, 1], [5000, 3], [20000, 0], [20000, 50], [70000, 7],
  ];
  for (const [n, q] of cases) {
    const t = mesh(n, n * 31 + q, q);
    const d = sameTree(cur._buildBVHForTris(t).root, ref._buildBVHForTris(t).root, 'root');
    assert.strictEqual(d, null, `n=${n} quant=${q}: ${d}`);
  }
});

test('degenerate keys: -0, infinities (stable sort) and NaN (comparator fallback)', () => {
  const sets = [[-0, 0, -0, 0], [Infinity, -Infinity, Infinity, 1e30, -1e30], [NaN, 0, NaN], [NaN, Infinity, -Infinity, -0]];
  for (let k = 0; k < sets.length; k++) for (const n of [6, 64, 3000]) {
    const t = mesh(n, 7 + k * 13 + n, k % 2 ? 4 : 0, sets[k].concat(sets[k], sets[k]));
    const d = sameTree(cur._buildBVHForTris(t).root, ref._buildBVHForTris(t).root, 'root');
    assert.strictEqual(d, null, `set ${k} n=${n}: ${d}`);
  }
});

test('NaN keys: a stable sort puts them last, NaN == NaN, the rest ascending (= Rust nan_last)', () => {
  const cmp = cur._ccNanLastCmp, v = [NaN, -1, -0, 0, 1, Infinity, -Infinity];
  for (const a of v) for (const b of v) {
    if (a === a && b === b) assert.strictEqual(cmp(a, b), a < b ? -1 : a > b ? 1 : 0);
    assert.strictEqual(cmp(a, b), -cmp(b, a) || 0);
  }
  const r = rng(5);
  for (const n of [5, 17, 300, 3000]) {
    const keys = new Float64Array(n * 3);
    for (let i = 0; i < keys.length; i++) keys[i] = r() < 0.3 ? NaN : Math.floor(r() * 6);
    keys.nan = true; // set by _buildBVHForTris when any key is NaN
    const idx = new Int32Array(n); for (let i = 0; i < n; i++) idx[i] = i;
    cur._bvhStableSort(idx, 0, n, keys, 1);
    const k = Array.from(idx, (i) => keys[i * 3 + 1]);
    const firstNaN = k.findIndex((x) => x !== x);
    if (firstNaN !== -1) assert.ok(k.slice(firstNaN).every((x) => x !== x), 'NaN last');
    const fin = firstNaN === -1 ? k : k.slice(0, firstNaN);
    for (let i = 1; i < fin.length; i++) assert.ok(fin[i - 1] <= fin[i], 'ascending');
    for (let i = 1; i < n; i++) if (Object.is(k[i - 1], k[i]) || (k[i] !== k[i] && k[i - 1] !== k[i - 1])) assert.ok(idx[i - 1] < idx[i], 'stable on ties');
  }
});

test('the sort itself is the stable order of the keys', () => {
  const r = rng(99);
  for (const n of [2, 15, 16, 17, 31, 32, 33, 1000, 4097]) {
    const keys = new Float64Array(n * 3);
    for (let i = 0; i < keys.length; i++) keys[i] = Math.floor(r() * 8);
    for (let axis = 0; axis < 3; axis++) {
      const idx = new Int32Array(n + 4); for (let i = 0; i < idx.length; i++) idx[i] = (i * 7) % n;
      const want = Array.from(idx.subarray(2, n + 2)).map((v, p) => [v, p]).sort((a, b) => (keys[a[0] * 3 + axis] - keys[b[0] * 3 + axis]) || (a[1] - b[1])).map((x) => x[0]);
      const before = [idx[0], idx[1], idx[n + 2], idx[n + 3]];
      cur._bvhStableSort(idx, 2, n + 2, keys, axis);
      assert.deepStrictEqual(Array.from(idx.subarray(2, n + 2)), want, `n=${n} axis=${axis}`);
      assert.deepStrictEqual([idx[0], idx[1], idx[n + 2], idx[n + 3]], before, 'outside the range untouched');
    }
  }
});
