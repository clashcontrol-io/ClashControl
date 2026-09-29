// window._ccIlsApplicability (addons/data-quality.js): the Dutch ILS /
// NL-SfB section only counts as issues when the project uses NL-SfB (same
// >=20% rule as the quality score), a model's IfcSite is in the
// Netherlands, or the regulation region is NL.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'addons', 'data-quality.js'), 'utf8');
function load(region) {
  const window = { _ccGetRegulationRegion: () => region };
  vm.runInNewContext(SRC, { window, console, document: {}, localStorage: { getItem() { return null; }, setItem() {} } });
  return window._ccIlsApplicability;
}
const ils = (total, missing) => ({ _total: total, noNLSfB: { count: missing } });
const site = (lat, lon) => ({ spatialHierarchy: { sites: [{ georef: { refLat: lat, refLon: lon } }] } });

test('non-Dutch project without NL-SfB: not applicable', () => {
  const r = load(null)(ils(100, 100), [site(48.85, 2.35)]); // Paris
  assert.deepStrictEqual({ ...r }, { applicable: false, reason: 'none' });
});

test('NL-SfB adopted on >=20% of elements: applicable', () => {
  assert.strictEqual(load(null)(ils(100, 80), []).reason, 'nlsfb');
  assert.strictEqual(load(null)(ils(100, 81), []).applicable, false);
});

test('IfcSite in the Netherlands: applicable', () => {
  assert.strictEqual(load(null)(ils(10, 10), [site(52.37, 4.9)]).reason, 'site-in-nl'); // Amsterdam
});

test('regulation region NL: applicable', () => {
  assert.strictEqual(load('nl')(ils(10, 10), []).reason, 'region-nl');
});

test('models without georef do not crash', () => {
  assert.strictEqual(load(null)(ils(10, 10), [{}, { spatialHierarchy: {} }]).applicable, false);
});
