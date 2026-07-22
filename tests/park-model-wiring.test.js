'use strict';
// Wiring lock for the "park inactive models" memory-relief feature (see the
// PARK_MODEL / UNPARK_MODEL reducer cases and the _ccParkModel /
// _ccRestoreParkedModel orchestration in index.html). Parking disposes a
// model's resident geometry (scene meshes + the large off-scene
// element.meshes[] proxy set) while KEEPING its IndexedDB geoCache + source
// file, so it can be restored with the SAME model id — every clash/issue
// reference stays valid. These are string-presence wiring checks (same style as
// large-candidate-warning.test.js): the logic lives deep inside the 38k-line
// single-file app alongside real Three.js/IDB dependencies not worth mocking.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

function sliceFrom(needle, span) {
  const i = html.indexOf(needle);
  assert.ok(i !== -1, 'expected to find: ' + needle);
  return html.slice(i, i + span);
}

test('action constants PARK_MODEL and UNPARK_MODEL are declared', () => {
  assert.match(html, /PARK_MODEL:'PARK_MODEL'/);
  assert.match(html, /UNPARK_MODEL:'UNPARK_MODEL'/);
});

test('INIT state and the project-switch reset both seed parkedModels:[]', () => {
  // Two occurrences: the INIT literal and the LOAD_PROJECT_STATE reset.
  const count = (html.match(/parkedModels:\[\]/g) || []).length;
  assert.ok(count >= 2, 'expected parkedModels:[] in INIT and the project reset, found ' + count);
});

test('PARK_MODEL reducer removes the model, pushes a stub, and clears its caches', () => {
  const body = sliceFrom('case A.PARK_MODEL:', 900);
  assert.match(body, /_clearElCaches\(_pkm\)/);                         // free BVH/pair caches
  assert.match(body, /models:s\.models\.filter\(function\(m\)\{return m\.id!==a\.id;\}\)/); // drop from models
  assert.match(body, /parkedModels:_restParked/);                      // push stub
  // The stub must be geometry-free (metadata only).
  assert.match(body, /elementCount:\(_pkm\.elements\|\|\[\]\)\.length/);
  assert.doesNotMatch(body, /meshes:_pkm\.meshes/);
});

test('parking does NOT delete the geoCache or source file (that is what makes restore possible)', () => {
  const body = sliceFrom('window._ccParkModel = function', 900);
  assert.doesNotMatch(body, /idbDeleteGeoCache/);
  assert.doesNotMatch(body, /idbDeleteFile/);
});

test('parking is refused for models that cannot be restored (guards against data loss)', () => {
  const body = sliceFrom('window._ccParkModel = function', 900);
  assert.match(body, /_ccModelIsRestorable\(model\)/);
  const guard = sliceFrom('function _ccModelIsRestorable', 700);
  assert.match(guard, /source === 'revit-direct'/);   // live models: not restorable
  assert.match(guard, /idbGetGeoCache\(model\.id\)/);  // else require a cache…
  assert.match(guard, /idbGetProjectFiles/);           // …or a stored source file
});

test('restore rebuilds with the SAME id (preserving clash/issue references) via the geoCache fast path', () => {
  const body = sliceFrom('window._ccRestoreParkedModel = function', 3200);
  assert.match(body, /idbGetGeoCache\(id\)/);            // fast path, not a re-parse with a new id
  assert.match(body, /_ccRestoreModelGeometry\(entry, cached\)/);
  assert.match(body, /id: id, name: stub\.name/);        // restored model keeps the original id
  assert.match(body, /A\.ADD_MODEL, v: restoredModel/);
  assert.match(body, /A\.UNPARK_MODEL, id: id/);
});

test('a concurrent restore of the same model dedupes on a single promise', () => {
  const body = sliceFrom('window._ccRestoreParkedModel = function', 400);
  assert.match(body, /if \(_ccRestoringModels\[id\]\) return _ccRestoringModels\[id\]/);
});

test('the sidebar Park button is hidden for live Revit-direct models', () => {
  assert.match(html, /!\(m\.stats&&m\.stats\.source==='revit-direct'\) && html`<button onClick=\$\{function\(e\)\{e\.stopPropagation\(\);if\(window\._ccParkModel\)window\._ccParkModel\(m\.id\);/);
});

test('a Parked section renders stubs with a Restore action', () => {
  assert.match(html, /\(s\.parkedModels\|\|\[\]\)\.length > 0/);
  assert.match(html, /window\._ccRestoreParkedModel\(pm\.id\)/);
});

test('_ccEnsureModelActive auto-restores a parked model before geometry actions', () => {
  const body = sliceFrom('window._ccEnsureModelActive = function', 300);
  assert.match(body, /_ccIsModelParked\(id\)/);
  assert.match(body, /_ccRestoreParkedModel\(id\)/);
});

// ── Automatic parking under memory pressure ────────────────────────────────
test('autoParkInactive is a persisted pref (default on) with a reducer + action', () => {
  assert.match(html, /SET_AUTOPARK:'SET_AUTOPARK'/);
  assert.match(html, /autoParkInactive:_ccLoadPref\('autoParkInactive',true\)/); // default ON
  assert.match(html, /case A\.SET_AUTOPARK:.*_ccPersistUI\('autoParkInactive',_ap\)/s);
});

test('the auto-park pass only sheds HIDDEN, non-live models and never the active view', () => {
  const body = sliceFrom('function _ccAutoParkPass()', 1600);
  assert.match(body, /s\.autoParkInactive === false\) return/);          // respects the opt-out
  assert.match(body, /if \(s\.detecting\) return/);                       // never mid-detection
  assert.match(body, /usedJSHeapSize \/ performance\.memory\.jsHeapSizeLimit < _AUTOPARK_RATIO\) return/); // only under pressure
  assert.match(body, /if \(models\.length < 2\) return/);                 // never empty the only view
  assert.match(body, /m\.visible === false/);                            // only models not in view
  assert.match(body, /source === 'revit-direct'/);                       // never a live model
  assert.match(body, /\{ auto: true \}/);                                // parks via the guarded _ccParkModel
});

// V7 P6.1: the sort target moved from element count to the byte-accurate
// residency ledger's reclaimableBytes — a large façade element can carry more
// triangles than thousands of simple pipes, so element count was a weak proxy.
// See tests/residency-ledger.test.js for the ledger's own unit coverage.
test('the auto-park pass targets the model with the largest RECLAIMABLE BYTE footprint first, via the residency ledger', () => {
  const body = sliceFrom('function _ccAutoParkPass()', 1600);
  assert.match(body, /_ccComputeResidencyLedger\(hidden\)/);
  assert.match(body, /hidden\.sort\(function\(a,b\)\{/);
  assert.match(body, /reclaimableBytes/);
  assert.doesNotMatch(body, /\(b\.elements\|\|\[\]\)\.length\) - \(\(a\.elements\|\|\[\]\)\.length\)/,
    'must no longer sort by raw element count now that the byte ledger exists');
});

test('the heap poller drives the auto-park pass every tick (not one-shot)', () => {
  const body = sliceFrom('var _MEM_WARN_BYTES = 5', 700);
  assert.match(body, /window\._ccAutoParkPass\(\)/);
  // the auto-park call must come before the one-shot _memWarnFiredRef guard,
  // so it keeps working after the 5 GB modal has fired once.
  assert.ok(body.indexOf('_ccAutoParkPass()') < body.indexOf('_memWarnFiredRef.current) return'),
    'auto-park must run before the one-shot warn guard');
});

test('auto-park is silent on models it cannot restore (skips, no scary toast)', () => {
  const body = sliceFrom('window._ccParkModel = function', 1100);
  assert.match(body, /var auto = !!\(opts && opts\.auto\)/);
  assert.match(body, /if \(!auto && window\._ccToast\)/); // the "can't park" warning is manual-only
});

test('smart reload: _highlightById auto-restores a parked model before highlighting', () => {
  const body = sliceFrom('_highlightById = function(expressId, alsoGhost, modelId, keepPivot) {', 1100);
  assert.match(body, /_ccIsModelParked && window\._ccIsModelParked\(modelId\)/);
  assert.match(body, /_ccRestoreParkedModel\(modelId\)\.then\(function\(ok\)\{/);
  assert.match(body, /window\._highlightById\(expressId, alsoGhost, modelId, keepPivot\)/); // re-run after restore
});

test('the sidebar exposes an auto-park on/off toggle wired to SET_AUTOPARK', () => {
  assert.match(html, /A\.SET_AUTOPARK,v:e\.target\.checked/);
  assert.match(html, /Auto-park hidden models under memory pressure/);
});
