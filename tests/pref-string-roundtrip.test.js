'use strict';
// _ccPersistUI stores string prefs raw and everything else as JSON;
// _ccLoadPref used to JSON.parse every value, so a string pref (navInputMode,
// autoRerun, …) silently fell back to its default after every reload.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const load = src.slice(src.indexOf('  var _ccLoadPref = function(key,fallback){'), src.indexOf('  // ── Standards localStorage helpers'));
const persist = src.slice(src.indexOf('  function _ccPersistUI(key,val){'), src.indexOf('\n', src.indexOf('  function _ccPersistUI(key,val){')));
assert.ok(load.length > 50 && persist.length > 30, 'markers moved');
const store = new Map();
const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
const api = new Function('localStorage', load + '\n' + persist + '\nreturn { load: _ccLoadPref, persist: _ccPersistUI };')(localStorage);

test('string, boolean, number and object prefs survive persist → load', () => {
  for (const [k, v, fb] of [['navInputMode', 'mouse', 'orbit'], ['autoRerun', 'off', 'replaced'], ['showMarkers', true, false], ['zoomSens', 1.5, 1], ['lightSettings', { a: 1 }, null]]) {
    api.persist(k, v);
    assert.deepEqual(api.load(k, fb), v, k);
  }
});
test('a missing pref or a corrupt non-string value gives the fallback', () => {
  assert.equal(api.load('nothing', 'x'), 'x');
  store.set('cc_broken', '{not json');
  assert.equal(api.load('broken', false), false);
});
