'use strict';
// Wiring lock for the P6.4 safe slice (docs/V7_RELEASE_PLAN.md): opt-in cache
// clear for the non-interactive "run once and export" flow.
//
// This is NOT the plan's full P6.4 ask. A genuine stateful streaming Wasm
// sweep cursor requires changing the compiled Rust/WASM broad-phase engine
// itself -- no toolchain, no way to rebuild or verify a WASM binary in this
// environment, and the JS clash-detection algorithm is explicitly flagged
// (CLAUDE.md) as geometrically sensitive code not to change without live
// verification. That part is intentionally NOT built here (see MEMORY.md /
// the final report) -- attempting it blind would repeat exactly the kind of
// rushed, unverified geometry change this plan's own guardrail ledger warns
// against. This test locks only the safe, JS-only slice that IS built: an
// opt-in post-detection cache flush.
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

test('_ccCommitDetectionResult takes an opts param and clears caches only when opts.clearCachesAfter is set', () => {
  const body = sliceFrom('function _ccCommitDetectionResult(result, dispatch, detectionSettings, opts) {', 3200);
  assert.match(body, /if \(opts && opts\.clearCachesAfter\) \{/);
  assert.match(body, /_flushGeoCache\(st\.models\)/);
});

test('the cache-clear step is guarded so a missing _flushGeoCache or empty state never throws', () => {
  const body = sliceFrom('function _ccCommitDetectionResult(result, dispatch, detectionSettings, opts) {', 3200);
  assert.match(body, /typeof _flushGeoCache === 'function' && st && st\.models/);
  assert.match(body, /try \{[\s\S]*?catch\(e\) \{\}/);
});

test('the public ClashControl.runDetection() API accepts an opts param and forwards it to commit', () => {
  const body = sliceFrom('runDetection:     function(rulesOverride, opts){', 1000);
  assert.match(body, /_ccCommitDetectionResult\(result, window\._ccDispatch, undefined, opts\)/);
});

test('existing detection call sites are unaffected -- none pass a 4th arg, so clearCachesAfter defaults to falsy everywhere except the new opt-in path', () => {
  // Every OTHER call site in the file must still call with at most 3 args
  // (result, dispatch[, detectionSettings]) -- if one of them started
  // passing a 4th positional argument by accident, it would silently start
  // clearing caches mid-interactive-session, which must never be the default.
  const calls = [...html.matchAll(/(function )?_ccCommitDetectionResult\(([^)]*)\)/g)]
    .filter((m) => !m[1]) // exclude the function DEFINITION line itself
    .map((m) => m[2]);
  assert.ok(calls.length >= 6, 'expected multiple call sites to check');
  const nonDefault = calls.filter((argsStr) => argsStr.split(',').length > 3 && !argsStr.includes('undefined, opts'));
  assert.deepEqual(nonDefault, [], 'no pre-existing call site may pass a 4th positional arg');
});

test('detectClashesAsync itself is untouched by this slice -- the candidate array is still fully materialized in one shot (documented, not silently fixed)', () => {
  // Smell-test: _makeCompactCandidates must still exist with its documented
  // "entire flat array" shape. If a future change makes this genuinely
  // streaming, this assertion (and the plan doc) should be updated together
  // -- not left claiming a partial fix solved the full problem.
  assert.match(html, /function _makeCompactCandidates\(items, flat\) \{/);
  const body = sliceFrom('function _makeCompactCandidates(items, flat) {', 300);
  assert.match(body, /length: flat\.length \/ 3/);
});

// ClashControl.storage.bvhCache: an explicit cap over the automatic sizing
// (tests/pressure storage=low-bvh-cap) and eviction stats. Run the real LRU
// block in a sandbox.
test('the BVH LRU honours an explicit cap, counts evictions and drops the evicted caches', () => {
  const vm = require('node:vm');
  const start = html.indexOf('  var _bvhCacheMaxCached = null;');
  const end = html.indexOf('  // ── BVH (Bounding Volume Hierarchy) for triangles');
  assert.ok(start !== -1 && end > start);
  const ctx = { window: {}, navigator: {}, performance: {} };
  vm.runInNewContext(html.slice(start, end) + '\nthis.api = { setO: function(n){ _bvhCacheMaxOverride = n; }, max: _BVH_CACHE_MAX_FN, evict: _bvhLRUEvict, lru: _bvhLRU, ev: function(){ return _bvhEvictions; } };', ctx);
  const { api } = ctx;
  assert.equal(api.max(), 300, 'automatic sizing without performance.memory');
  api.setO(2);
  assert.equal(api.max(), 2);
  const els = [0, 1, 2].map((i) => ({ id: i, _triCache: [i], _bvhCache: {}, _wvCache: [], _topo: {} }));
  for (const el of els) { api.evict(); api.lru.set(el, true); }
  assert.equal(api.lru.size, 2);
  assert.equal(api.ev(), 1);
  assert.equal(els[0]._triCache, undefined, 'evicted element re-extracts on next touch');
  assert.equal(els[0]._bvhCache, undefined);
  assert.deepEqual(els[2]._triCache, [2]);
  api.setO(null);
  assert.equal(api.max(), 300, 'null returns to automatic sizing');
});

test('ClashControl.storage.bvhCache exposes stats() and setMax() (trims at once)', () => {
  const body = sliceFrom('bvhCache: {', 900);
  assert.match(body, /stats: function\(\)\{ return \{ size: _bvhLRU\.size, max: _BVH_CACHE_MAX_FN\(\), override: _bvhCacheMaxOverride, evictions: _bvhEvictions,\s+bytes: _bvhLRUBytes, maxBytes: _bvhCacheBytesCap, bytesOverride: _bvhCacheBytesOverride, byteEvictions: _bvhByteEvictions, peakBytes: _bvhCacheBytesPeak \}; \}/);
  assert.match(body, /while \(_bvhLRU\.size > _bvhCacheMaxOverride\) _bvhLRUEvict1\(\);/);
  // leanMemory byte cap: explicit override trims at once
  assert.match(sliceFrom('bvhCache: {', 1600), /setMaxBytes: function\(n\)\{[\s\S]*while \(_bvhLRUBytes > _bvhCacheBytesCap && _bvhLRU\.size\) _bvhLRUEvict1\(\);/);
});
