'use strict';
// classificationCoreV2 graduated from a flagged migration (boot-time
// equivalence check against an inline legacy implementation, opt-out flag)
// to the sole implementation — see MEMORY.md Architecture Decisions. This
// locks the simplified wiring: index.html's classifyClashes is a direct,
// unconditional delegation to window._ccClashClassificationCore.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

function loadAdapter(candidate) {
  const start = source.indexOf('var _ccClassificationCore = window._ccClashClassificationCore;');
  const end = source.indexOf('\n\n', source.indexOf('function classifyClashes(clashes)', start));
  assert.ok(start >= 0 && end > start, 'classification wiring block not found');
  const window = { _ccClashClassificationCore: candidate };
  const api = new Function('window', source.slice(start, end) + ';return {classifyClashes};')(window);
  return { window, api };
}

function sample() {
  return [{ id: 'c', type: 'hard', elemAType: 'IfcDuctSegment', elemBType: 'IfcBeam', disciplines: ['MEP', 'Structural'], point: [0, 0, 0], elemAStorey: 'L1' }];
}

test('classification helper loads before the app and is available offline', () => {
  const helper = source.indexOf('<script src="clash-classification-core.js" defer></script>');
  const main = source.indexOf('window.onload = function() {');
  assert.ok(helper >= 0 && main > helper);
  assert.match(worker, /'clash-classification-core\.js'/);
  assert.match(worker, /var CACHE = 'clashcontrol-v\d+\.\d+\.\d+/);
});

test('no flag, gate, or opt-out remains for this migration', () => {
  assert.doesNotMatch(source, /isEnabled\('classificationCoreV2'\)/);
  assert.doesNotMatch(source, /_ccClassificationCoreStatus/);
  assert.doesNotMatch(source, /_ccClassificationCoreActive/);
  assert.doesNotMatch(source, /_ccValidateClassificationCore/);
});

test('classifyClashes delegates directly and unconditionally to the module', () => {
  const { api } = loadAdapter({ classifyClashes: (items) => { items[0].aiSeverity = 'from-module'; } });
  const input = sample();
  api.classifyClashes(input);
  assert.equal(input[0].aiSeverity, 'from-module');
});

test('a missing module surfaces a real error rather than silently falling back to anything', () => {
  const { api } = loadAdapter(undefined);
  assert.throws(() => api.classifyClashes(sample()), TypeError);
});
