'use strict';
// Language-/country-specific name data moved out of the addons into country
// packs (naming section): Revit model-name discipline hints
// (addons/revit-bridge.js _revitDiscipline) and national classification
// systems in property names / ObjectType (addons/smart-bridge.js _classOf).
// The addons keep English generic defaults only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { countryWindow } = require('./_country-pack.js');

function slice(file, from, to) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'addons', file), 'utf8');
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a !== -1 && b !== -1, from + ' … ' + to + ' not found in ' + file);
  return src.slice(a, b);
}
function load(file, from, to, names, regions) {
  const window = countryWindow({ regions, active: null });
  return new Function('window', slice(file, from, to) + '; return {' + names.join(',') + '};')(window);
}

const revit = (regions) => load('revit-bridge.js', '  var _REVIT_NAME_HINTS = {', '\n  function _finalizeModelInner(', ['_revitDiscipline'], regions)._revitDiscipline;
const classOf = (regions) => load('smart-bridge.js', '  function _packNaming() {', '\n  // Classification for one element', ['_classOf'], regions)._classOf;

test('Revit model-name discipline: English without packs, pack fragments when registered', () => {
  const en = revit([]);
  assert.equal(en('Office HVAC model', []), 'mep');
  assert.equal(en('Structural frame', []), 'structural');
  assert.equal(en('Architecture', []), 'architectural');
  assert.equal(en('Bouwkundig model', []), undefined);
  assert.equal(en('W-installaties', []), 'mep', '"installat" is also an English fragment');
  const nl = revit(['nl']);
  assert.equal(nl('Bouwkundig model', []), 'architectural');
  assert.equal(nl('Constructief model', []), 'structural');
  assert.equal(nl('E-install verlichting', []), 'mep');
  assert.equal(nl('Leidingwerk', []), 'mep');
});

test('classification systems: generic names without packs, national systems from packs', () => {
  const en = classOf([]);
  assert.deepStrictEqual(en({ psets: { Pset: { Uniclass: 'Ss_25_10' } } }), { system: 'Uniclass', code: 'Ss_25_10' });
  assert.deepStrictEqual(en({ psets: { 'NL-SfB': { Code: '21.12' } } }), null);
  assert.equal(en({ objectType: '(21) Buitenwand' }), null, 'no national ObjectType convention in the core');
  assert.deepStrictEqual(en({ psets: { Classification: { Nummer: '21' } } }), null);
  const nl = classOf(['nl']);
  assert.deepStrictEqual(nl({ psets: { 'NL-SfB': { Code: '21.12' } } }), { system: 'NL-SfB', code: '21.12' });
  assert.deepStrictEqual(nl({ psets: { Pset: { NLSfB: '22' } } }), { system: 'NL-SfB', code: '22' });
  assert.deepStrictEqual(nl({ psets: { Classification: { Nummer: '21' } } }), { system: 'Classification', code: '21' });
  assert.deepStrictEqual(nl({ objectType: '(21.1) Buitenwand' }), { system: 'NL-SfB', code: '21.1' });
  assert.deepStrictEqual(nl({ objectType: '28.10 Kolom' }), { system: 'NL-SfB', code: '28.10' });
  assert.deepStrictEqual(nl({ psets: { Pset: { Uniclass: 'Ss_25' } } }), { system: 'Uniclass', code: 'Ss_25' });
});
