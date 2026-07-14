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
