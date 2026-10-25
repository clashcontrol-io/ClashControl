'use strict';
// Parking/restoring ONE model reads only what that restore needs
// (docs/INTERNALS.md §21.53): never the project's other stored IFC files, and
// not even this model's own file when its geometry cache is current. Runs the
// production _ccRestoreModelGeometry from index.html with stubs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extract(name) {
  const start = src.indexOf('  function ' + name + '(');
  assert.ok(start !== -1, name + ' not found');
  return src.slice(start, src.indexOf('\n  }\n', start) + 4);
}

function harness(overrides) {
  const calls = { getEntry: 0, cold: 0, deserialize: 0, scans: 0 };
  const ctx = Object.assign({
    window: { _ccSafetyMigrations: { record() {} } },
    _ccGeoCacheV8Enabled: () => true,
    _geoDeserialize: () => { calls.deserialize++; return { elements: [], from: 'cache' }; },
    _ccRestoredGeoMatchesCache: () => true,
    _idbDeleteGeoCacheKey: () => {},
    _ccGeoCacheKey: (id) => 'v8:' + id,
    _ccColdParseParkedEntry: (entry) => { calls.cold++; return Promise.resolve({ elements: [], from: 'cold', entry }); },
    _ccIfcHasBytes: () => { calls.scans++; return false; },
    Promise, Error, String, Uint8Array,
  }, overrides || {});
  vm.runInNewContext(extract('_ccGeoCacheLacksSpaces') + '\n' + extract('_ccRestoreModelGeometry') + '\nthis.restore = _ccRestoreModelGeometry;', ctx);
  const getEntry = () => { calls.getEntry++; return Promise.resolve({ id: 'm', name: 'm.ifc', buffer: new Uint8Array(4) }); };
  return { restore: (cached) => ctx.restore('m', cached, getEntry), calls };
}

const CURRENT = { v: 8, hasPsets: true, sp: 2, sem: 1, xp: 1, np: 1, st: 1, gr: 1 };

test('a current geometry cache restores without reading the stored file', async () => {
  const h = harness();
  const r = await h.restore(CURRENT);
  assert.equal(r.from, 'cache');
  assert.equal(h.calls.getEntry, 0, 'the IFC record was read although the cache sufficed');
});

test('no cache → the file is read once and cold-parsed', async () => {
  const h = harness();
  const r = await h.restore(null);
  assert.equal(r.from, 'cold');
  assert.equal(h.calls.getEntry, 1);
});

test('a cache without grid flag (gr) reads the file to scan it, then restores from cache when it has no grid', async () => {
  const h = harness();
  const r = await h.restore(Object.assign({}, CURRENT, { gr: undefined }));
  assert.equal(r.from, 'cache');
  assert.equal(h.calls.getEntry, 1);
  assert.equal(h.calls.scans, 1);
});

test('an old cache (missing space flags) with a stored file cold-parses, as before', async () => {
  const h = harness();
  const r = await h.restore(Object.assign({}, CURRENT, { sp: 1 }));
  assert.equal(r.from, 'cold');
});

test('a cache that fails validation falls back to the file', async () => {
  const h = harness({ _ccRestoredGeoMatchesCache: () => false });
  const r = await h.restore(CURRENT);
  assert.equal(r.from, 'cold');
  assert.equal(h.calls.getEntry, 1);
});

test('park/restore/reload-in-full use a single-file get, never the project\'s whole file list', () => {
  const slice = (needle, n) => src.slice(src.indexOf(needle), src.indexOf(needle) + n);
  for (const [needle, n] of [['window._ccRestoreParkedModel = function', 2600], ['function _ccModelIsRestorable', 700], ['window._ccReloadModelFull = function', 600]]) {
    const body = slice(needle, n);
    assert.doesNotMatch(body, /idbGetProjectFiles\(/, needle);
    assert.match(body, /idbGetProjectFile\(/, needle);
  }
  // the sidecar (stored with the IFC) is fetched only when the record may have one
  assert.match(slice('window._ccRestoreParkedModel = function', 2600), /entryP \|\| _ccFileSidecar\[id\] !== false \? getEntry\(\)/);
});
