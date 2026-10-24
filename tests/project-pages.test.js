'use strict';
// Project autosave record pages (storage-core planProjectPages /
// assembleProjectRecord / foldProjectRows; docs/INTERNALS.md §21.53): a save
// puts only the pages whose clone references changed, and reading header +
// pages gives back exactly what one record held before.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../storage-core.js');

const clone = (n, tag) => Array.from({ length: n }, (_, i) => ({ id: (tag || 'c') + i, status: 'open', point: [i, 0, 0] }));

// What the IDB store would hold after applying a plan (key -> record).
function apply(store, pid, plan, extra) {
  const inRange = (k, r) => Array.isArray(k) && cmp(k, r.lower) >= 0 && cmp(k, r.upper) <= 0;
  for (const r of plan.deletes) for (const k of [...store.keys()]) if (inRange(JSON.parse(k), r)) store.delete(k);
  for (const p of plan.puts) store.set(JSON.stringify(p.key), { id: p.key, items: p.items, bytes: core.estimateRecordBytes({ id: p.key, items: p.items }) });
  store.set(JSON.stringify(pid), Object.assign({ id: pid }, extra || {}, { _ccPages: plan.header, bytes: 10 }));
}
// IndexedDB key order for the keys used here: number < string < array.
function cmp(a, b) {
  const t = (x) => Array.isArray(x) ? 3 : typeof x === 'string' ? 2 : 1;
  if (t(a) !== t(b)) return t(a) - t(b);
  if (t(a) === 3) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i], b[i]); if (c) return c; }
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
function read(store, pid) {
  const header = store.get(JSON.stringify(pid));
  const pages = [...store.values()].filter((r) => Array.isArray(r.id) && r.id[0] === pid);
  return core.assembleProjectRecord(header, pages);
}

test('first save (no memo) writes every page, after clearing the project\'s page range', () => {
  const plan = core.planProjectPages('p1', { clashes: clone(300), issues: clone(5, 'i') }, null, 128);
  assert.equal(plan.full, true);
  assert.deepEqual(plan.deletes, [{ lower: ['p1'], upper: ['p1', []] }]);
  assert.deepEqual(plan.puts.map((p) => p.key), [['p1', 'c', 0], ['p1', 'c', 1], ['p1', 'c', 2], ['p1', 'i', 0]]);
  assert.deepEqual(plan.header, { v: 1, size: 128, clashes: 300, issues: 5 });
});

test('one status edit puts exactly one page of bounded size', () => {
  const cl = clone(13716), is = clone(40, 'i');
  const p0 = core.planProjectPages('p', { clashes: cl, issues: is }, null);
  const edited = cl.slice(); edited[5000] = Object.assign({}, cl[5000], { status: 'resolved' });
  const p1 = core.planProjectPages('p', { clashes: edited, issues: is }, p0.memo);
  assert.equal(p1.full, false);
  assert.equal(p1.deletes.length, 0);
  assert.equal(p1.puts.length, 1);
  assert.deepEqual(p1.puts[0].key, ['p', 'c', Math.floor(5000 / core.PROJECT_PAGE_SIZE)]);
  assert.ok(p1.puts[0].items.length <= core.PROJECT_PAGE_SIZE);
  assert.strictEqual(p1.puts[0].items[5000 % core.PROJECT_PAGE_SIZE], edited[5000]);
  // nothing changed → nothing put
  assert.equal(core.planProjectPages('p', { clashes: edited, issues: is }, p1.memo).puts.length, 0);
});

test('an insertion rewrites the pages it shifts; a shorter list deletes the tail pages', () => {
  const cl = clone(500);
  const p0 = core.planProjectPages('p', { clashes: cl }, null, 100);
  const ins = cl.slice(0, 250).concat([{ id: 'new' }], cl.slice(250));
  const p1 = core.planProjectPages('p', { clashes: ins }, p0.memo, 100);
  assert.deepEqual(p1.puts.map((p) => p.key[2]), [2, 3, 4, 5]);
  const p2 = core.planProjectPages('p', { clashes: ins.slice(0, 150) }, p1.memo, 100);
  assert.deepEqual(p2.puts.map((p) => p.key[2]), [1]);
  assert.deepEqual(p2.deletes, [{ lower: ['p', 'c', 2], upper: ['p', 'c', Infinity] }]);
});

test('a memo of another project or page size never counts', () => {
  const p0 = core.planProjectPages('a', { clashes: clone(10) }, null);
  assert.equal(core.planProjectPages('b', { clashes: clone(10) }, p0.memo).full, true);
  assert.equal(core.planProjectPages('a', { clashes: clone(10) }, p0.memo, 7).full, true);
});

test('header + pages reassemble to exactly the stored lists, through a series of edits', () => {
  const store = new Map();
  let cl = clone(1000), is = clone(130, 'i'), memo = null;
  const extra = { rules: { maxGap: 50 }, modelMeta: [{ id: 'm' }] };
  for (let step = 0; step < 8; step++) {
    if (step === 2) cl = cl.slice(0, 600);
    else if (step === 3) cl = cl.concat(clone(400, 'n'));
    else if (step === 4) is = [];
    else if (step === 5) cl = cl.slice().reverse();
    else if (step) { cl = cl.slice(); cl[step * 37] = Object.assign({}, cl[step * 37], { status: 's' + step }); }
    const plan = core.planProjectPages('p', { clashes: cl, issues: is }, memo, 128);
    apply(store, 'p', plan, extra);
    memo = plan.memo;
    const got = read(store, 'p');
    assert.deepEqual(got.clashes, cl, 'clashes after step ' + step);
    assert.deepEqual(got.issues, is, 'issues after step ' + step);
    assert.deepEqual(got.rules, extra.rules);
    assert.equal(got._ccPages, undefined);
    assert.ok(got.bytes > 10);
  }
  // no stray pages left behind
  const pages = [...store.values()].filter((r) => Array.isArray(r.id));
  assert.equal(pages.length, Math.ceil(cl.length / 128) + Math.ceil(is.length / 128));
});

test('a project saved before pages existed is read back as it is', () => {
  const legacy = { id: 'old', clashes: [{ id: 'a' }], issues: [], rules: {}, bytes: 99 };
  assert.strictEqual(core.assembleProjectRecord(legacy, [{ id: ['old', 'c', 0], items: [{ id: 'zzz' }] }]), legacy);
  assert.equal(core.assembleProjectRecord(null, []), null);
});

test('storage accounting folds header + pages into one row per project', () => {
  const rows = core.foldProjectRows([{ id: 'a', bytes: 10 }, { id: ['a', 'c', 0], bytes: 100 }, { id: ['a', 'i', 0], bytes: 5 }, { id: 'b', bytes: 7 }, { id: ['b', 'c', 0], bytes: 1 }]);
  assert.deepEqual(rows, [{ id: 'a', bytes: 115 }, { id: 'b', bytes: 8 }]);
  const rep = core.buildStorageReport({ projects: rows });
  assert.equal(rep.idb.sessionBytes, 123);
  assert.equal(rep.perProject.length, 2);
});
