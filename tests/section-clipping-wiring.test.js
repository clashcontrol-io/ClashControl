const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('BatchedMesh section candidate is default-off and isolated to its named flag', () => {
  const start = source.indexOf('function _ccApplySectionMaterialPlanes');
  const end = source.indexOf('window._ccApplySectionMaterialPlanes =', start);
  const helper = source.slice(start, end);
  assert.match(helper, /isEnabled\('batchedSectionsV2'\)/);
  assert.match(helper, /modelRoot: S\.mg/);
  assert.match(helper, /scene: S\.scene/);
  assert.match(helper, /migration:'batchedSectionsV2'/);
});

test('section plane, section box and clear paths all use the guarded material helper', () => {
  const calls = [...source.matchAll(/_ccApplySectionMaterialPlanes\(S, ([^,]+), '([^']+)'\)/g)]
    .map((m) => [m[1].trim(), m[2]]);
  assert.deepEqual(calls, [
    ['planes', 'section'],
    ['[]', 'clear'],
    ['planes', 'box'],
  ]);
});

test('new helper has an inline legacy fallback for stale offline service workers', () => {
  const start = source.indexOf('function _ccApplySectionMaterialPlanes');
  const end = source.indexOf('window._ccApplySectionMaterialPlanes =', start);
  const helper = source.slice(start, end);
  assert.match(helper, /if \(!api\)/);
  assert.match(helper, /return \{path:'inline-legacy'\}/);
  assert.match(helper, /obj\.userData\._isCCBatch/);
});

test('section clipping helper is loaded before the main application script', () => {
  const helper = source.indexOf('<script src="section-clipping.js" defer></script>');
  const main = source.indexOf('window.onload = function() {');
  assert.ok(helper >= 0 && main > helper);
});
