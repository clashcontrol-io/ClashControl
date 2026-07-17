'use strict';
// disciplineCoreV2 graduated from a flagged migration (boot-time equivalence
// check against an inline legacy implementation, opt-out flag) to the sole
// implementation — see MEMORY.md Architecture Decisions. This locks the
// simplified wiring: index.html's discipline functions are a direct,
// unconditional delegation to window._ccClashDisciplineCore, nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

function adapterWindow(candidate) {
  const start = source.indexOf('var _ccDisciplineCore = window._ccClashDisciplineCore;');
  const end = source.indexOf('function ModelSidebar(props)', start);
  assert.ok(start >= 0 && end > start, 'discipline wiring block not found');
  const window = { _ccClashDisciplineCore: candidate };
  new Function('window', source.slice(start, end))(window);
  return window;
}

function el(type) { return { props: { ifcType: type } }; }

test('discipline module loads before the application and is precached for offline use', () => {
  const helper = source.indexOf('<script src="clash-discipline-core.js" defer></script>');
  const main = source.indexOf('window.onload = function() {');
  assert.ok(helper >= 0 && main > helper);
  for (const file of ['safety-migrations.js', 'section-clipping.js', 'renderer-contract.js', 'clash-discipline-core.js']) {
    assert.match(worker, new RegExp("'" + file.replace('.', '\\.') + "'"));
  }
  assert.match(worker, /var CACHE = 'clashcontrol-v\d+\.\d+\.\d+/);
});

test('no flag, gate, or opt-out remains for this migration', () => {
  // The string 'disciplineCoreV2' may still appear in an explanatory
  // comment about the graduation history — assert against the actual
  // functional wiring (a flag check, a status export, a gate variable),
  // not the bare substring.
  assert.doesNotMatch(source, /isEnabled\('disciplineCoreV2'\)/);
  assert.doesNotMatch(source, /_ccDisciplineCoreStatus/);
  assert.doesNotMatch(source, /_ccDisciplineCoreActive/);
  assert.doesNotMatch(source, /_ccDisciplineCoreRequested/);
  assert.doesNotMatch(source, /_ccValidateDisciplineCore/);
});

test('window._ccElementDiscipline (and siblings) delegate directly and unconditionally to the module', () => {
  let calls = 0;
  const candidate = {
    elementDiscipline: (...args) => { calls++; return 'e:' + JSON.stringify(args); },
    disciplinePairEnabled: (...args) => { calls++; return 'p:' + JSON.stringify(args); },
    matrixSkipsSameDiscipline: (...args) => { calls++; return 'm:' + JSON.stringify(args); },
    detectDiscipline: (...args) => { calls++; return 'd:' + JSON.stringify(args); },
  };
  const window = adapterWindow(candidate);

  const elResult = window._ccElementDiscipline(el('IfcBeam'), 'mep');
  assert.equal(elResult, candidate.elementDiscipline(el('IfcBeam'), 'mep'));

  window._ccDisciplinePairEnabled('mep', 'structural', {});
  window._ccMatrixSkipsSameDiscipline(el('IfcBeam'), {}, el('IfcDoor'), {}, false, {});
  window._ccDetectDiscipline([el('IfcBeam')], 'name');

  // 1 (already-called elementDiscipline for elResult) + 1 (the direct
  // window._ccElementDiscipline call) + 3 (pair/matrix/detect) = 5.
  assert.equal(calls, 5);
});

test('a missing module surfaces a real error rather than silently falling back to anything', () => {
  // No legacy fallback exists anymore — this is the deliberate tradeoff of
  // graduating: if the module somehow fails to load, callers get a clear
  // TypeError from calling a method on undefined, not a silent behavior
  // change back to some other implementation.
  const window = adapterWindow(undefined);
  assert.throws(() => window._ccElementDiscipline(el('IfcBeam'), 'mep'), TypeError);
});
