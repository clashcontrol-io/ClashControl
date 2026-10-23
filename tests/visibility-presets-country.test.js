'use strict';
// addons/visibility.js presets: English name words in the core, extended by
// every registered country pack's naming.visibilityTerms; country-specific
// presets come from the active pack's engines.visibility.presets.
const { test } = require('node:test');
const assert = require('node:assert');
const { countryWindow, loadAddon } = require('./_country-pack.js');

function presets(opts) {
  const w = loadAddon('visibility.js', countryWindow(Object.assign({ window: { THREE: {} } }, opts)));
  const list = w._ccVisibilityPresets();
  return { w, list, byKey: Object.fromEntries(list.map((p) => [p.key, p])) };
}

test('no country pack: English-only name filters, no national presets', () => {
  const { byKey } = presets({ regions: [], active: null });
  assert.equal(byKey['exit-signs-generic'].target.namePattern, 'exit');
  assert.equal(byKey['exit-signs-EN-1838'].target.namePattern, 'exit|escape|emergency');
  assert.equal(byKey['reception-front-door-LOS'].viewer.namePattern, 'reception');
  assert.equal(byKey['workplace-window-view-NL'], undefined);
  assert.equal(byKey['exit-signs-generic'].target.name, undefined, 'word lists are compiled away');
});

test('nl pack registered: Dutch words join the matching term groups (any active region)', () => {
  const { byKey } = presets({ regions: ['nl'], active: null });
  assert.equal(byKey['exit-signs-generic'].target.namePattern, 'exit|uitgang');
  assert.equal(byKey['exit-signs-BS-5499'].target.namePattern, 'exit|escape', 'a UK preset has no term group');
  assert.equal(byKey['reception-front-door-LOS'].viewer.namePattern, 'reception|balie|receptie');
  assert.equal(byKey['smoke-detector-coverage'].target.namePattern, 'smoke|detector|rook');
  assert.equal(byKey['workplace-window-view-NL'], undefined, 'national preset only while nl is active');
});

test('nl active: the pack\'s workplace preset is offered and runnable', async () => {
  const { w, byKey } = presets({ regions: ['nl'], active: 'nl' });
  const p = byKey['workplace-window-view-NL'];
  assert.equal(p.viewer.namePattern, 'desk|werkplek|workstation');
  assert.equal(p.maxRange, 6);
  assert.equal(p.region, 'nl');
  let ran = null;
  w._ccDetectVisibility = (rule) => { ran = rule; return Promise.resolve([]); };
  await w._ccVisibilityRunPreset('workplace-window-view-NL');
  assert.equal(ran.sampleId, 'workplace-view-NL');
  await assert.rejects(() => w._ccVisibilityRunPreset('nope'), /Unknown visibility preset/);
});
