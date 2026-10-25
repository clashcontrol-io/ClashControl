'use strict';
// Locks the storey-units block of index.html (docs/INTERNALS.md §21.52):
// every model's storey elevations become METRES with that model's own unit
// (override > declared LENGTHUNIT > spacing heuristic on its OWN storeys),
// storeys merge across models in metres (same name within a tolerance), and
// mm/cm/m is only a display choice.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const a = src.indexOf('  // ── Storey units: every storey elevation in METRES');
const b = src.indexOf('  // ── end storey units ──');
assert.ok(a !== -1 && b > a, 'storey units block not found');
function load(state) {
  const win = { _ccLatestState: state || null };
  return new Function('window', src.slice(a, b) +
    '; return {collect:_ccCollectStoreys, elevM:_ccStoreyElevM, unit:_ccStoreyUnitScale, display:_ccDetectUnitScale,' +
    ' fmt:_ccFormatElev, geo:_ccStoreyToGeoFactor, byName:_ccStoreyElevByName, inUnit:_ccElevInUnit};')(win);
}
const U = load();

const storeys = (els) => els.map(([name, elevation]) => ({ name, elevation }));
const mmModel = (id, unit) => ({ id, stats: unit === undefined ? { unitScale: 1000 } : { unitScale: unit },
  storeyData: storeys([['Level 0', 0], ['Level 1', 3000], ['Level 2', 6000]]) });
const mModel = (id, unit) => ({ id, stats: unit === undefined ? { unitScale: 1 } : { unitScale: unit },
  storeyData: storeys([['Level 0', 0], ['Level 1', 3], ['Level 2', 6]]) });

test('mm + m federation: storeys merge by name in METRES (not 1501.5 raw)', () => {
  const out = U.collect([mmModel('A'), mModel('B')], null);
  assert.deepStrictEqual(out.map((s) => [s.name, s.elevation]), [['Level 0', 0], ['Level 1', 3], ['Level 2', 6]]);
  assert.deepStrictEqual(out[1].modelIds, ['A', 'B']);
  assert.strictEqual(out[1].unitScale, null); // mixed units
});

test('each model uses its OWN unit: declared, else its own spacing heuristic', () => {
  const undeclaredMm = { id: 'C', stats: {}, storeyData: storeys([['L0', 0], ['L1', 3000]]) };
  const undeclaredM = { id: 'D', stats: {}, storeyData: storeys([['L0', 0], ['L1', 3.2]]) };
  assert.strictEqual(U.unit(undeclaredMm, null), 1000);
  assert.strictEqual(U.unit(undeclaredM, null), 1);
  assert.strictEqual(U.elevM(undeclaredMm, undeclaredMm.storeyData[1], null), 3);
  assert.strictEqual(U.elevM(undeclaredM, undeclaredM.storeyData[1], null), 3.2);
  // the first model's unit is not imposed on the second any more
  const out = U.collect([undeclaredMm, undeclaredM], null);
  assert.deepStrictEqual(out.map((s) => s.elevation), [0, 3.1]);
  const cm = { id: 'E', stats: { unitScale: 100 }, storeyData: storeys([['L1', 300]]) };
  assert.strictEqual(U.elevM(cm, cm.storeyData[0], null), 3);
});

test('unitScaleOverride forces one unit for every model', () => {
  const prefs = { unitScaleOverride: '1000' };
  const out = U.collect([mmModel('A'), mModel('B')], prefs);
  // the m model is now read as mm: its "Level 1" (0.003 m) is 2.997 m from
  // the mm model's — same name, beyond tolerance: two levels
  assert.deepStrictEqual(out.filter((s) => s.name === 'Level 1').map((s) => s.elevation), [0.003, 3]);
  assert.strictEqual(U.display([mmModel('A'), mModel('B')], prefs), 1000);
  assert.strictEqual(U.unit(mModel('B'), { unitScaleOverride: 'auto' }), 1);
});

test('same name far apart stays separate; within tolerance merges', () => {
  const A = { id: 'A', stats: { unitScale: 1 }, storeyData: storeys([['Level 1', 3]]) };
  const B = { id: 'B', stats: { unitScale: 1 }, storeyData: storeys([['Level 1', 3.4]]) };
  const C = { id: 'C', stats: { unitScale: 1 }, storeyData: storeys([['Level 1', 40]]) };
  const out = U.collect([A, B, C], null);
  assert.strictEqual(out.length, 2);
  assert.ok(Math.abs(out[0].elevation - 3.2) < 1e-12);
  assert.deepStrictEqual(out[0].modelIds, ['A', 'B']);
  assert.deepStrictEqual(out[1], { name: 'Level 1', elevation: 40, modelIds: ['C'], unitScale: 1 });
  assert.strictEqual(U.byName([A, B, C], null)['Level 1'], out[0].elevation);
});

test('single model / same-unit federation: exactly the old raw × (1/unit) metres', () => {
  // old: avg(raw) then × _ccStoreyToGeoFactor = 1/unit
  const raw = [0, 2850, 5925.5, 8800];
  const m = { id: 'A', stats: { unitScale: 1000 }, storeyData: storeys(raw.map((e, i) => ['L' + i, e])) };
  assert.deepStrictEqual(U.collect([m], null).map((s) => s.elevation), raw.map((e) => e * (1 / 1000)));
  const m2 = { id: 'B', stats: { unitScale: 1000 }, storeyData: storeys([['L1', 2851]]) };
  const old = (2850 + 2851) / 2 * (1 / 1000);
  assert.strictEqual(U.collect([m, m2], null).find((s) => s.name === 'L1').elevation, old);
  assert.strictEqual(U.geo([m]), 1); // storeys are metres now
});

test('display unit: override > dominant declared > heuristic; labels from metres', () => {
  assert.strictEqual(U.display([mmModel('A')], null), 1000);
  assert.strictEqual(U.display([mModel('B'), mmModel('A'), mmModel('C')], null), 1000);
  assert.strictEqual(U.display([mModel('B'), mmModel('A')], null), 1); // tie → first
  assert.strictEqual(U.display([{ id: 'X', storeyData: storeys([['a', 0], ['b', 300]]) }], null), 100);
  assert.strictEqual(U.display([], null), 1);
  assert.strictEqual(U.fmt(3, 1000), '3000 mm');
  assert.strictEqual(U.fmt(2.9925, 1000), '2993 mm'); // snapped: 2992.4999… would round down
  assert.strictEqual(U.fmt(3.15, 100), '315.0 cm');
  assert.strictEqual(U.fmt(3.15, 1), '3.15 m');
  assert.strictEqual(U.fmt(null, 1), '—');
  // default display unit comes from the live state
  const L = load({ models: [mmModel('A'), mModel('B'), mmModel('C')], prefs: {} });
  assert.strictEqual(L.fmt(4.2), '4200 mm');
});

test('old raw labels and new metre labels agree for a single model', () => {
  for (const [raw, us, d] of [[3000, 1000, 0], [2850, 1000, 0], [315, 100, 1], [3.15, 1, 2], [-450, 1000, 0], [12345, 1000, 0]]) {
    assert.strictEqual(U.fmt(raw * (1 / us), us), raw.toFixed(d) + ' ' + (us === 1000 ? 'mm' : us === 100 ? 'cm' : 'm'));
  }
});
