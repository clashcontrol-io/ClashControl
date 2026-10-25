// When does a national data standard (here the Dutch ILS / NL-SfB standard
// from regulations/nl.json) count as applicable? When its country pack is the
// active regional code — chosen in Settings, or resolved from the models by
// window._ccResolveCountry (IfcPostalAddress.Country > projected CRS > IfcSite
// lat/lon) — or when the project demonstrably uses its classification
// (>= adoptionMin of the elements carry a code, same rule as the quality
// score). Otherwise its findings are informational only.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const core = require('../country-pack-core.js');
const { readPack, countryWindow, loadAddon } = require('./_country-pack.js');

const PACKS = ['be', 'ch', 'gb', 'nl'].map(readPack);
const site = (lat, lon) => ({ spatialHierarchy: { sites: [{ georef: { refLat: lat, refLon: lon } }] } });
// What the app does on every model change: resolve, then activate.
const regionFor = (models, override) => core.resolveCountry(PACKS, models, override).region;

function applicability(active, ilsRes) {
  const window = loadAddon('data-quality.js', countryWindow({ regions: ['nl'], active }));
  return window._ccStandardApplicability('ils', ilsRes);
}
const ils = (total, missing) => ({ _total: total, noNLSfB: { count: missing } });

test('non-Dutch project without NL-SfB: no region resolved, ILS not applicable', () => {
  const region = regionFor([site(48.85, 2.35)]); // Paris
  assert.equal(region, null);
  assert.deepStrictEqual({ ...applicability(region, ils(100, 100)) }, { applicable: false, reason: 'none' });
});

test('NL-SfB adopted on >=20% of elements: applicable without any region', () => {
  assert.strictEqual(applicability(null, ils(100, 80)).reason, 'adopted');
  assert.strictEqual(applicability(null, ils(100, 81)).applicable, false);
});

test('IfcSite in the Netherlands: the nl pack is resolved and ILS applies', () => {
  const r = core.resolveCountry(PACKS, [site(52.37, 4.9)]); // Amsterdam
  assert.deepStrictEqual([r.region, r.reason], ['nl', 'site']);
  assert.strictEqual(applicability(r.region, ils(10, 10)).reason, 'region');
});

test('Dutch postal address or RD New CRS resolve nl too', () => {
  assert.equal(regionFor([{ spatialHierarchy: { buildings: [{ address: { country: 'Nederland' } }] } }]), 'nl');
  assert.equal(regionFor([{ spatialHierarchy: { mapConversion: { epsg: 'EPSG:28992' } } }]), 'nl');
});

test('regional code NL chosen in Settings: applicable', () => {
  assert.equal(regionFor([site(48.85, 2.35)], { mode: 'user', region: 'nl' }), 'nl');
  assert.strictEqual(applicability('nl', ils(10, 10)).reason, 'region');
});

test('another active region does not make the Dutch standard apply', () => {
  assert.strictEqual(applicability('be', ils(10, 10)).applicable, false);
});

test('models without georef do not crash', () => {
  assert.equal(regionFor([{}, { spatialHierarchy: {} }]), null);
});

test('without the nl pack the core has no Dutch standard at all', () => {
  const window = loadAddon('data-quality.js', countryWindow({ regions: [], active: null }));
  assert.deepStrictEqual(window._ccDataQualityStandards(), []);
  assert.equal(window._ccRunStandard('ils', []), null);
  assert.deepStrictEqual({ ...window._ccStandardApplicability('ils', ils(10, 0)) }, { applicable: false, reason: 'none' });
});
