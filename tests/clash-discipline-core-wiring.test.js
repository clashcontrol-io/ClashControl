'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../clash-discipline-core');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

function adapterWindow(candidate, enabled) {
  const start = source.indexOf('var _DISC_TYPE_MAP = {};');
  const end = source.indexOf('function ModelSidebar(props)', start);
  const diagnostics = [];
  const window = {
    _ccClashDisciplineCore: candidate,
    _ccSafetyMigrations: {
      isEnabled: (name) => name === 'disciplineCoreV2' && enabled,
      record: (entry) => diagnostics.push(entry),
    },
  };
  new Function('window', source.slice(start, end))(window);
  return { window, diagnostics };
}

function el(type) { return { props: { ifcType: type } }; }

test('discipline module loads before the application and is precached for offline use', () => {
  const helper = source.indexOf('<script src="clash-discipline-core.js"></script>');
  const main = source.indexOf('window.onload = function() {');
  assert.ok(helper >= 0 && main > helper);
  for (const file of ['safety-migrations.js', 'section-clipping.js', 'renderer-contract.js', 'clash-discipline-core.js']) {
    assert.match(worker, new RegExp("'" + file.replace('.', '\\.') + "'"));
  }
  assert.match(worker, /var CACHE = 'clashcontrol-v\d+\.\d+\.\d+/);
});

test('flag-off path never validates or calls a candidate', () => {
  let calls = 0;
  const broken = {
    contractVersion: 1,
    typeMap: core.typeMap,
    elementDiscipline: () => { calls++; return 'broken'; },
    disciplinePairEnabled: () => { calls++; return false; },
    matrixSkipsSameDiscipline: () => { calls++; return true; },
    detectDiscipline: () => { calls++; return 'broken'; },
  };
  const result = adapterWindow(broken, false);
  assert.equal(result.window._ccDisciplineCoreStatus.active, false);
  assert.equal(result.window._ccElementDiscipline(el('IfcBeam'), 'mep'), 'structural');
  assert.equal(calls, 0);
  assert.deepEqual(result.diagnostics, []);
});

test('opt-in activates the extracted module only after exact contract validation', () => {
  const result = adapterWindow(core, true);
  assert.equal(result.window._ccDisciplineCoreStatus.requested, true);
  assert.equal(result.window._ccDisciplineCoreStatus.active, true);
  assert.equal(result.window._ccDisciplineCoreStatus.validation.equal, true);
  assert.equal(result.window._ccElementDiscipline(el('IfcBeam'), 'mep'), 'structural');
  assert.equal(result.diagnostics.at(-1).migration, 'disciplineCoreV2');
  assert.equal(result.diagnostics.at(-1).outcome, 'candidate');
});

test('mismatch leaves the exact inline legacy implementation active', () => {
  const broken = Object.assign({}, core, { elementDiscipline: () => 'mep' });
  const result = adapterWindow(broken, true);
  assert.equal(result.window._ccDisciplineCoreStatus.active, false);
  assert.equal(result.window._ccDisciplineCoreStatus.validation.equal, false);
  assert.equal(result.window._ccElementDiscipline(el('IfcBeam'), 'mep'), 'structural');
  assert.equal(result.diagnostics.at(-1).outcome, 'fallback');
});
