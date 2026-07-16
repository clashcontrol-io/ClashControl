'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../clash-classification-core');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

function loadAdapter(candidate, enabled) {
  const start = source.indexOf('  function _ccLegacyClassifyClashes(');
  const marker = source.indexOf('window._ccClassificationCoreStatus = Object.freeze', start);
  const end = source.indexOf('\n', marker);
  const diagnostics = [];
  const window = {
    _ccClashClassificationCore:candidate,
    _ccSafetyMigrations:{
      isEnabled:(name) => enabled && name === 'classificationCoreV2',
      record:(entry) => diagnostics.push(entry),
    },
  };
  const api = new Function('window', source.slice(start, end) + ';return {classifyClashes};')(window);
  return {window, diagnostics, api};
}

function sample() {
  return [{id:'c',type:'hard',elemAType:'IfcDuctSegment',elemBType:'IfcBeam',disciplines:['MEP','Structural'],point:[0,0,0],elemAStorey:'L1'}];
}

test('classification helper loads before the app and is available offline', () => {
  const helper = source.indexOf('<script src="clash-classification-core.js" defer></script>');
  const main = source.indexOf('window.onload = function() {');
  assert.ok(helper >= 0 && main > helper);
  assert.match(worker, /'clash-classification-core\.js'/);
  assert.match(worker, /var CACHE = 'clashcontrol-v\d+\.\d+\.\d+/);
});

test('flag-off never calls or validates candidate code', () => {
  let calls = 0;
  const broken = {contractVersion:1,classifyClashes:()=>{calls++;}};
  const loaded = loadAdapter(broken, false);
  const input = sample();
  loaded.api.classifyClashes(input);
  assert.equal(loaded.window._ccClassificationCoreStatus.active, false);
  assert.equal(input[0].aiSeverity, 'critical');
  assert.equal(calls, 0);
  assert.deepEqual(loaded.diagnostics, []);
});

test('valid opt-in activates candidate after complete mutation comparison', () => {
  const loaded = loadAdapter(core, true);
  const input = sample();
  loaded.api.classifyClashes(input);
  assert.equal(loaded.window._ccClassificationCoreStatus.active, true);
  assert.equal(loaded.window._ccClassificationCoreStatus.validation.equal, true);
  assert.equal(input[0].aiSeverity, 'critical');
  assert.equal(loaded.diagnostics.at(-1).outcome, 'candidate');
});

test('candidate mismatch falls back to exact inline classification', () => {
  const broken = {contractVersion:1,classifyClashes:(items)=>{items[0].aiSeverity='wrong';}};
  const loaded = loadAdapter(broken, true);
  const input = sample();
  loaded.api.classifyClashes(input);
  assert.equal(loaded.window._ccClassificationCoreStatus.active, false);
  assert.equal(input[0].aiSeverity, 'critical');
  assert.equal(loaded.diagnostics.at(-1).outcome, 'fallback');
});
