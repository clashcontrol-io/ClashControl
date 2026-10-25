'use strict';
// Memory relief happens on the event it belongs to, not on a 2-minute timer:
// detection caches stay between runs (capped by count and bytes) and are
// dropped first when the heap is actually tight — before a model is parked —
// and render lists are disposed when a model leaves the scene.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function fn(name) {
  const start = html.indexOf('  function ' + name + '(');
  assert.ok(start !== -1, name + ' not found');
  const end = html.indexOf('\n  }\n', start) + 4;
  return html.slice(start, end);
}

function autoPark(ctx) {
  const sandbox = Object.assign({ console, Date, window: {} }, ctx);
  vm.runInNewContext(fn('_ccAutoParkPass') + '\nthis.run = _ccAutoParkPass;', sandbox);
  return sandbox;
}
const tight = { memory: { jsHeapSizeLimit: 1000, usedJSHeapSize: 900 } };
const models = [{ id: 'a', visible: true }, { id: 'b', visible: false }];

test('a tight heap drops the detection caches first and parks nothing on that pass', () => {
  const parked = [];
  const sb = autoPark({ performance: tight, _AUTOPARK_RATIO: 0.72, _AUTOPARK_COOLDOWN_MS: 0, _AUTOPARK_LAST_ACTION_MS: 0,
    _ccDropDetectCaches: () => 123, _ccAutoParkNoteAction() {}, _ccComputeResidencyLedger: () => ({ perModel: {} }) });
  sb.window._ccLatestState = { models };
  sb.window._ccParkModel = (id) => parked.push(id);
  sb.run();
  assert.deepEqual(parked, []);
});

test('with no detection caches left, the pass parks a hidden model as before', () => {
  const parked = [];
  const sb = autoPark({ performance: tight, _AUTOPARK_RATIO: 0.72, _AUTOPARK_COOLDOWN_MS: 0, _AUTOPARK_LAST_ACTION_MS: 0,
    _ccDropDetectCaches: () => 0, _ccAutoParkNoteAction() {}, _ccComputeResidencyLedger: () => ({ perModel: {} }) });
  sb.window._ccLatestState = { models };
  sb.window._ccParkModel = (id) => parked.push(id);
  sb.run();
  assert.deepEqual(parked, ['b']);
});

test('a heap with room drops nothing', () => {
  let dropped = 0;
  const sb = autoPark({ performance: { memory: { jsHeapSizeLimit: 1000, usedJSHeapSize: 100 } }, _AUTOPARK_RATIO: 0.72,
    _AUTOPARK_COOLDOWN_MS: 0, _AUTOPARK_LAST_ACTION_MS: 0, _ccDropDetectCaches: () => { dropped++; return 1; } });
  sb.window._ccLatestState = { models };
  sb.run();
  assert.equal(dropped, 0);
});

test('_ccDropDetectCaches empties the cache and reports what it released', () => {
  const lru = new Map([[{}, true], [{}, true]]);
  let wasmCleared = 0;
  const sb = { console: { info() {} }, Math, _bvhLRU: lru, _bvhLRUBytes: 5 * 1048576,
    _bvhLRUEvict1() { lru.delete(lru.keys().next().value); }, window: { _ccWasmEngine: { clear() { wasmCleared++; } } } };
  vm.runInNewContext(fn('_ccDropDetectCaches') + '\nthis.drop = _ccDropDetectCaches;', sb);
  assert.equal(sb.drop(), 5 * 1048576);
  assert.equal(lru.size, 0);
  assert.equal(wasmCleared, 1);
  assert.equal(sb.drop(), 0, 'nothing left: nothing to report');
});

test('no timer flushes the detection caches or render lists', () => {
  assert.doesNotMatch(html, /Periodic memory cleanup \(runs every 2 minutes\)/);
  assert.doesNotMatch(html, /_flushGeoCache\(_latestSRef\.current\.models\)/);
  assert.match(html, /if \(_groupsLeft && S\.renderer && S\.renderer\.renderLists\) \{ try \{ S\.renderer\.renderLists\.dispose\(\); \}/);
});
