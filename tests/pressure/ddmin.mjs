// Delta debugging (Zeller's ddmin) — pure, used by tests/pressure/shrink.mjs
// to shrink a failing combo over its non-default dims, then its edit
// sequence, then the fixture's planted cases. Unit-tested in
// tests/pressure.test.js on synthetic predicates.
//
// ddmin(items, fails) -> a 1-minimal sublist of `items` (order preserved) for
// which `await fails(sublist)` is still true. `fails(items)` is assumed true.
// Every distinct subset is evaluated at most once (results are memoised by
// index set), and the empty list is tried first: a failure that needs none of
// the items shrinks to [] immediately.

export async function ddmin(items, fails, opts = {}) {
  const memo = new Map();
  let calls = 0;
  const maxCalls = opts.maxCalls == null ? Infinity : opts.maxCalls;
  const keyOf = (sub) => sub.map((x) => items.indexOf(x)).join(',');
  async function test(sub) {
    const k = keyOf(sub);
    if (memo.has(k)) return memo.get(k);
    if (calls >= maxCalls) return false;
    calls++;
    const r = !!(await fails(sub));
    memo.set(k, r);
    if (opts.onTest) opts.onTest(sub, r);
    return r;
  }
  if (!items.length) return { result: [], calls };
  if (await test([])) return { result: [], calls };
  let cur = items.slice();
  let n = 2;
  while (cur.length >= 2) {
    const size = Math.ceil(cur.length / n);
    const chunks = [];
    for (let i = 0; i < cur.length; i += size) chunks.push(cur.slice(i, i + size));
    let reduced = false;
    for (const c of chunks) {
      if (c.length < cur.length && await test(c)) { cur = c; n = 2; reduced = true; break; }
    }
    if (!reduced && chunks.length > 2) {
      for (let i = 0; i < chunks.length; i++) {
        const comp = cur.filter((x) => !chunks[i].includes(x));
        if (await test(comp)) { cur = comp; n = Math.max(n - 1, 2); reduced = true; break; }
      }
    }
    if (!reduced) {
      if (n >= cur.length) break;
      n = Math.min(cur.length, 2 * n);
    }
  }
  // 1-minimality pass for the single-element case (ddmin above already
  // guarantees it for |cur| >= 2 once n reaches |cur|).
  if (cur.length === 1 && await test([])) cur = [];
  return { result: cur, calls };
}
