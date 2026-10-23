// Merged clash rows (index.html detectClashesAsync, "Merge related clashes"):
// every member of a row shares the row's own hub element, so the row is
// exactly hub × _groupedElems — no row ever names a pair that did not clash —
// and the row's own pair is its closest member.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('    var merged = [];\n    var mergeMap = {};');
const end = src.indexOf('    merged.forEach(function(c) {\n      if (c.mergedCount > 1)', start);
assert.ok(start > 0 && end > start, 'merge block not found');

function merge(clashes) {
  const ctx = {
    clashes,
    _clsCore: { openingVisibility: (o) => (o === 'provided' ? 1 : 2) },
    _ccProvisionVisibility: (p) => (p === 'inside' ? 1 : 2),
  };
  vm.runInNewContext(src.slice(start, end) + '\nthis.merged = merged;', ctx);
  return JSON.parse(JSON.stringify(ctx.merged)); // out of the vm realm
}
let n = 0;
function clash(a, b, x, extra) {
  return Object.assign({ id: 'c' + (n++), type: 'hard', distance: 0, point: [x, 0, 0],
    modelAId: 'M1', elemA: a, elemAType: 'IfcPipeSegment', modelBId: 'M2', elemB: b, elemBType: 'IfcSlab' }, extra || {});
}
// every pair a row stands for
function pairsOf(r) {
  const out = [[r.elemA, r.elemB]];
  for (const g of r._groupedElems || []) out.push(r._groupHub === 'A' ? [r.elemA, g] : [g, r.elemB]);
  return out.map((p) => p.join('x')).sort();
}

test('a row never chains through a member: pipes 10, 11 against slabs 20, 21', () => {
  // 10x20, 11x20 share slab 20; 11x21 shares only pipe 11 (a member) with the row
  const input = [clash(10, 20, 0), clash(11, 20, 0.1), clash(11, 21, 0.15)];
  const rows = merge(input);
  const covered = rows.flatMap(pairsOf).sort();
  assert.deepEqual(covered, ['10x20', '11x20', '11x21']);
  assert.equal(rows.length, 2);
  for (const r of rows) assert.equal(r.mergedCount, pairsOf(r).length);
});

test('hub on either side, partners all on the other side', () => {
  const rows = merge([clash(10, 20, 0), clash(10, 21, 0.1), clash(10, 22, 0.2)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]._groupHub, 'A');
  assert.deepEqual(pairsOf(rows[0]), ['10x20', '10x21', '10x22']);
  const rowsB = merge([clash(10, 20, 0), clash(11, 20, 0.1)]);
  assert.equal(rowsB[0]._groupHub, 'B');
  assert.deepEqual(pairsOf(rowsB[0]), ['10x20', '11x20']);
});

test('the closest member becomes the row pair; type and 250 mm still split rows', () => {
  const rows = merge([clash(10, 20, 0, { type: 'soft', distance: 0.049 }), clash(10, 21, 0.1, { type: 'soft', distance: 0.012 })]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].elemB, 21);
  assert.equal(rows[0].distance, 0.012);
  assert.deepEqual(rows[0].point, [0.1, 0, 0]);
  assert.deepEqual(pairsOf(rows[0]), ['10x20', '10x21']);
  assert.deepEqual(rows[0]._groupedElems, [20]);
  assert.deepEqual(rows[0]._groupedDist, [0.049]); // each member keeps its own distance
  assert.equal(merge([clash(10, 20, 0), clash(10, 21, 0.1, { type: 'soft', distance: 0.01 })]).length, 2);
  assert.equal(merge([clash(10, 20, 0), clash(10, 21, 0.3)]).length, 2);
});

test('provision / opening visibility: most visible member wins, also after a swap', () => {
  const rows = merge([clash(10, 20, 0, { type: 'soft', distance: 0.04, provision: 'inside' }), clash(10, 21, 0.1, { type: 'soft', distance: 0.01 })]);
  assert.equal(rows[0].provision, undefined);
  const rows2 = merge([clash(10, 20, 0, { type: 'soft', distance: 0.04 }), clash(10, 21, 0.1, { type: 'soft', distance: 0.01, provision: 'inside' })]);
  assert.equal(rows2[0].elemB, 21);
  assert.equal(rows2[0].provision, undefined);
});
