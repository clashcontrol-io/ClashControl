const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('fresh geometry-cache payloads are saved off the main thread, in idle-time chunks', () => {
  // Every save of a freshly serialised payload goes through the worker path.
  assert.equal((source.match(/idbSaveGeoCacheFresh\((?:entry\.id|modelId), _geoSerialize\(result\)\)/g) || []).length, 3);
  assert.doesNotMatch(source, /idbSaveGeoCache\((?:entry\.id|modelId), _geoSerialize\(result\)\)/);
  const start = source.indexOf('function idbSaveGeoCacheFresh(');
  const fn = source.slice(start, source.indexOf('\n  function idbSaveGeoCache(', start));
  // chunked protocol, buffers transferred, idle-scheduled, DB opened on main first, main-thread fallback
  assert.match(fn, /t: 'begin'/); assert.match(fn, /t: 'mesh', items: mc \}, tl\)/); assert.match(fn, /t: 'el'/); assert.match(fn, /t: 'end'/);
  assert.match(fn, /_ccIdle\(function\(\) \{ _openIDB\(\)\.then\(start, fallback\); \}, 5000\)/);
  assert.match(fn, /resolve\(idbSaveGeoCache\(fileId, m\.record \? m\.record\.data : data\)\)/);
});

test('a payload read back from the cache is re-saved on the main thread (its buffers back the live scene)', () => {
  assert.match(source, /cached\.hasPsets = true;\s*\n\s*idbSaveGeoCache\(modelId, cached\);/);
});
