'use strict';
// Locks the CRS-aware geo-placement wiring in addons/geoplace.js:
// the EPSG registry/resolver, the reprojection call shape, and the
// _ccGeoplaceFromCRS flow + its guard rails. The actual datum math is
// proj4's job — here proj4 is stubbed so we assert WHAT we hand it and
// HOW we treat the result, not the geodesy.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Load the addon into a fake window. With no _ccRegisterAddon the IIFE
// returns before registering, but only AFTER defining every window._cc*
// helper — which is all we exercise.
function loadAddon(proj4Stub) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'addons', 'geoplace.js'), 'utf8');
  const window = {};
  const documentStub = { createElement: () => ({}), head: { appendChild() {} } };
  if (proj4Stub) window.proj4 = proj4Stub; // present → loadProj4 resolves without touching the DOM
  new Function('window', 'document', src)(window, documentStub);
  return window;
}

function makeProj4(returnLonLat) {
  const calls = [];
  const fn = function (fromDef, toDef, coords) { calls.push({ fromDef, toDef, coords }); return returnLonLat; };
  fn.calls = calls;
  return fn;
}

test('CRS registry exposes the expected systems', () => {
  const w = loadAddon();
  const list = w._ccCRSList();
  const byEpsg = Object.fromEntries(list.map(c => [c.epsg, c.label]));
  for (const epsg of ['28992', '31370', '2056', '27700', '25831', '25832', '3857', '4326']) {
    assert.ok(byEpsg[epsg], 'missing CRS ' + epsg);
  }
  assert.match(byEpsg['28992'], /RD New/);
});

test('resolveEpsg handles EPSG codes, URNs, names, and misses', () => {
  const w = loadAddon();
  assert.equal(w._ccCRSResolve('EPSG:28992'), '28992');
  assert.equal(w._ccCRSResolve('urn:ogc:def:crs:EPSG::28992'), '28992');
  assert.equal(w._ccCRSResolve('28992'), '28992');
  assert.equal(w._ccCRSResolve('Amersfoort / RD New'), '28992');
  assert.equal(w._ccCRSResolve('Belge Lambert 72'), '31370');
  assert.equal(w._ccCRSResolve('OSGB 1936 / British National Grid'), '27700');
  assert.equal(w._ccCRSResolve('CH1903+ / LV95'), '2056');
  assert.equal(w._ccCRSResolve('EPSG:99999'), null); // numeric but not in registry
  assert.equal(w._ccCRSResolve('Some Local Grid'), null);
  assert.equal(w._ccCRSResolve(''), null);
  assert.equal(w._ccCRSResolve(null), null);
});

test('reproject hands proj4 the registry def + WGS84 target and returns {lat,lon}', async () => {
  const proj4 = makeProj4([4.9041, 52.3676]); // proj4 returns [lon, lat]
  const w = loadAddon(proj4);
  const out = await w._ccReprojectToWGS84(121000, 487000, '28992');
  assert.deepEqual(out, { lon: 4.9041, lat: 52.3676 });
  assert.equal(proj4.calls.length, 1);
  const call = proj4.calls[0];
  assert.match(call.fromDef, /\+proj=sterea/);
  assert.match(call.fromDef, /x_0=155000/);
  assert.equal(call.toDef, 'WGS84');
  assert.deepEqual(call.coords, [121000, 487000]);
});

test('reproject rejects unknown CRS and non-numeric input', async () => {
  const w = loadAddon(makeProj4([0, 0]));
  await assert.rejects(() => w._ccReprojectToWGS84(1, 2, '00000'), /Unknown CRS/);
  await assert.rejects(() => w._ccReprojectToWGS84('x', 2, '28992'), /not numeric/);
});

test('geoplaceFromCRS reprojects then places with source + elevation', async () => {
  const proj4 = makeProj4([4.9041, 52.3676]);
  const w = loadAddon(proj4);
  const placed = [];
  w._ccGeoplaceModel = function (modelId, geo) { placed.push({ modelId, geo }); return Promise.resolve('ok'); };
  const mc = { eastings: 121000, northings: 487000, orthogonalHeight: 12.5, epsg: 'EPSG:28992' };
  const res = await w._ccGeoplaceFromCRS('m1', mc, null); // null → auto-detect from epsg
  assert.equal(res, 'ok');
  assert.equal(placed.length, 1);
  assert.equal(placed[0].modelId, 'm1');
  assert.equal(placed[0].geo.refLat, 52.3676);
  assert.equal(placed[0].geo.refLon, 4.9041);
  assert.equal(placed[0].geo.refElev, 12.5);
  assert.equal(placed[0].geo.source, 'CRS:28992');
});

test('geoplaceFromCRS: explicit CRS key overrides the IFC epsg', async () => {
  const proj4 = makeProj4([4.35, 50.85]);
  const w = loadAddon(proj4);
  const placed = [];
  w._ccGeoplaceModel = function (modelId, geo) { placed.push({ modelId, geo }); return Promise.resolve('ok'); };
  await w._ccGeoplaceFromCRS('m1', { eastings: 150000, northings: 170000, epsg: 'EPSG:28992' }, '31370');
  assert.match(proj4.calls[0].fromDef, /\+proj=lcc/); // Belgian Lambert, not RD New
  assert.equal(placed[0].geo.source, 'CRS:31370');
});

test('geoplaceFromCRS guards: missing E/N, unrecognised CRS, out-of-range result', async () => {
  const w = loadAddon(makeProj4([200, 100])); // proj4 returns nonsense → out of range
  w._ccGeoplaceModel = () => { throw new Error('should not be called'); };

  await assert.rejects(() => w._ccGeoplaceFromCRS('m1', { epsg: 'EPSG:28992' }, null), /No projected Eastings/);
  await assert.rejects(() => w._ccGeoplaceFromCRS('m1', { eastings: 1, northings: 2, epsg: 'EPSG:99999' }, null), /Unrecognised CRS/);
  await assert.rejects(() => w._ccGeoplaceFromCRS('m1', { eastings: 1, northings: 2 }, '28992'), /out-of-range/);
});
