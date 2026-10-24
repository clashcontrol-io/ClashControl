const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function restoreDecisionHarness(overrides = {}) {
  const start = source.indexOf('    function _restoreCacheOrColdParse(entry, cached) {');
  const end = source.indexOf('\n    idbGetProjectData(pid)', start);
  assert.ok(start >= 0 && end > start, 'restore decision function not found');
  const deleted = [];
  const events = [];
  let coldParses = 0;
  const context = {
    window: { _ccSafetyMigrations: { record(event) { events.push(event); } } },
    _ccGeoCacheLacksSpaces: () => false,
    _ccGeoCacheV8Enabled: () => true,
    _geoDeserialize: () => ({ elements: [] }),
    _ccRestoredGeoMatchesCache: () => true,
    _idbDeleteGeoCacheKey: (key) => { deleted.push(key); },
    _ccGeoCacheKey: (id) => `v8:${id}`,
    _coldParseAndCache: async () => { coldParses++; return 'cold'; },
    Error,
    String,
    ...overrides,
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.restore = _restoreCacheOrColdParse;', context);
  return { context, deleted, events, get coldParses() { return coldParses; } };
}

test('flag-off restore keeps the established v7 deserialize path', async () => {
  let deserializes = 0;
  const h = restoreDecisionHarness({
    _ccGeoCacheV8Enabled: () => false,
    _geoDeserialize: () => { deserializes++; return 'legacy'; },
  });
  const result = await h.context.restore({ id: 'm' }, { v: 7, hasPsets: true });
  assert.equal(result, 'legacy');
  assert.equal(deserializes, 1);
  assert.equal(h.coldParses, 0);
  assert.deepEqual(h.deleted, []);
});

test('candidate deserialize exception deletes only v8 and cold-parses original bytes', async () => {
  const h = restoreDecisionHarness({
    _geoDeserialize: () => { throw new Error('corrupt geometry'); },
  });
  const result = await h.context.restore({ id: 'm' }, { v: 8, hasPsets: true });
  assert.equal(result, 'cold');
  assert.equal(h.coldParses, 1);
  assert.deepEqual(h.deleted, ['v8:m']);
  assert.equal(h.events[0].outcome, 'cold-parse-fallback');
});

test('candidate semantic mismatch also cold-parses instead of accepting geometry', async () => {
  const h = restoreDecisionHarness({ _ccRestoredGeoMatchesCache: () => false });
  const result = await h.context.restore({ id: 'm' }, { v: 8, hasPsets: true });
  assert.equal(result, 'cold');
  assert.equal(h.coldParses, 1);
  assert.deepEqual(h.deleted, ['v8:m']);
});

// IfcSpace geometry (2026-10-22): caches written before rooms kept their
// volume carry no `sp` marker, and `sp:1` caches predate the storey-frame
// room placement fix (`sp:2`); with the source IFC stored they are re-parsed
// once instead of restoring missing or displaced rooms forever.
function realLacksSpaces() {
  const start = source.indexOf('  function _ccGeoCacheLacksSpaces(cached, entry) {');
  const end = source.indexOf('\n  }\n', start) + 4;
  assert.ok(start >= 0 && end > start, '_ccGeoCacheLacksSpaces not found');
  const ctx = {};
  vm.runInNewContext(source.slice(start, end) + '\nthis.fn = _ccGeoCacheLacksSpaces;', ctx);
  return ctx.fn;
}

test('pre-spaces cache (no sp marker) cold-parses once when the source IFC is stored', async () => {
  let deserializes = 0;
  const h = restoreDecisionHarness({
    _ccGeoCacheV8Enabled: () => false,
    _ccGeoCacheLacksSpaces: realLacksSpaces(),
    _geoDeserialize: () => { deserializes++; return 'legacy'; },
  });
  assert.equal(await h.context.restore({ id: 'm', buffer: new ArrayBuffer(8) }, { v: 7, hasPsets: true }), 'cold');
  assert.equal(h.coldParses, 1);
  assert.equal(deserializes, 0);
  // sp:2 without sem:1 (written before discipline evidence / space
  // boundaries were extracted) is refreshed the same way.
  assert.equal(await h.context.restore({ id: 'm', buffer: new ArrayBuffer(8) }, { v: 7, sp: 2, hasPsets: true }), 'cold');
  assert.equal(h.coldParses, 2);
  // sp:1 (rooms written in their storey's frame were still doubled) too.
  assert.equal(await h.context.restore({ id: 'm', buffer: new ArrayBuffer(8) }, { v: 7, sp: 1, sem: 1, hasPsets: true }), 'cold');
  assert.equal(h.coldParses, 3);
  // sp:2 + sem:1 without xp:1 (16-bit positions, not the exact geometry) too.
  assert.equal(await h.context.restore({ id: 'm', buffer: new ArrayBuffer(8) }, { v: 7, sp: 2, sem: 1, hasPsets: true }), 'cold');
  assert.equal(h.coldParses, 4);
  // sp:2 + sem:1 + xp:1 without np:1 (worker-written: non-physical elements
  // drawn, stub elements missing) too.
  assert.equal(await h.context.restore({ id: 'm', buffer: new ArrayBuffer(8) }, { v: 7, sp: 2, sem: 1, xp: 1, hasPsets: true }), 'cold');
  assert.equal(h.coldParses, 5);
  assert.equal(await h.context.restore({ id: 'm', buffer: new ArrayBuffer(8) }, { v: 7, sp: 2, sem: 1, xp: 1, np: 1, hasPsets: true }), 'legacy');
  // No source bytes: the old cache is still the only geometry there is.
  assert.equal(await h.context.restore({ id: 'm' }, { v: 7, hasPsets: true }), 'legacy');
  assert.equal(h.coldParses, 5);
});

test('the serializer stamps sp:2 and both restore policies check it first', () => {
  assert.match(source, /return \{v:_ccGeoCacheV8Enabled\(\)\?8:7, sp:2, sem:1, xp:1, np:1, hasPsets:hasPsets/);
  assert.match(source, /if \(_ccGeoCacheLacksSpaces\(cached, entry\)\) return _ccColdParseParkedEntry\(entry\);/);
  assert.match(source, /if \(_ccGeoCacheLacksSpaces\(cached, entry\)\) return _coldParseAndCache\(entry\);/);
});

test('candidate never reads or overwrites the legacy cache key', () => {
  const cacheLayerStart = source.indexOf('function _ccGeoCacheV8Enabled()');
  const cacheLayerEnd = source.indexOf('// ── Geometry quantization helpers', cacheLayerStart);
  const layer = source.slice(cacheLayerStart, cacheLayerEnd);
  assert.match(layer, /_ccGeoCacheKey\(fileId, candidate\)/);
  assert.match(layer, /var record = candidate \? \{id:cacheKey/);
  assert.match(layer, /: \{id:fileId, data:data, savedAt:Date\.now\(\)\}/);
  assert.match(layer, /_idbDeleteGeoCacheKey\(cacheKey\)/);
});

test('candidate serialization is schema 8 while flag-off serialization stays schema 7', () => {
  assert.match(source, /return \{v:_ccGeoCacheV8Enabled\(\)\?8:7,/);
});

// pp:1 — the cache was written with the elements' final psets/quantities (the
// worker's lazy props merged first, or a main-thread parse). A model with no
// psets at all restores from it; a cache written before the props landed
// (no pp, no psets) still re-parses.
test('a props-complete cache (pp:1) restores even when the model has no psets', async () => {
  const markers = { v: 7, sp: 2, sem: 1, xp: 1, np: 1 };
  const h = restoreDecisionHarness({ _ccGeoCacheV8Enabled: () => false, _ccGeoCacheLacksSpaces: realLacksSpaces(), _geoDeserialize: () => 'legacy' });
  assert.equal(await h.context.restore({ id: 'm', buffer: new ArrayBuffer(8) }, Object.assign({ hasPsets: false, pp: 1 }, markers)), 'legacy');
  assert.equal(h.coldParses, 0);
  assert.equal(await h.context.restore({ id: 'm', buffer: new ArrayBuffer(8) }, Object.assign({ hasPsets: false, pp: 0 }, markers)), 'cold');
  assert.equal(h.coldParses, 1);
  const h8 = restoreDecisionHarness({ _ccGeoCacheLacksSpaces: realLacksSpaces(), _geoDeserialize: () => 'v8' });
  assert.equal(await h8.context.restore({ id: 'm', buffer: new ArrayBuffer(8) }, Object.assign({}, markers, { v: 8, hasPsets: false, pp: 1 })), 'v8');
});
