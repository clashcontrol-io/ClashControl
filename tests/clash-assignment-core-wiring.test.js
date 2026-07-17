'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const core = require('../clash-assignment-core');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

function loadAdapter(candidate, enabled) {
  const start = source.indexOf('  function _ccLegacyMatchAssignmentRule(');
  const marker = source.indexOf('window._ccAssignmentCoreStatus = Object.freeze', start);
  const end = source.indexOf('\n', marker);
  const diagnostics = [];
  const window = {
    _ccClashAssignmentCore:candidate,
    _ccSafetyMigrations:{
      isEnabled:(name) => enabled && name === 'assignmentCoreV2',
      record:(entry) => diagnostics.push(entry),
    },
  };
  const api = new Function('window', source.slice(start, end) + ';return {_ccMatchAssignmentRule,_ccApplyAssignmentRules};')(window);
  return { window, diagnostics, api };
}

function sample() { return {_delta:'new',disciplines:['mep','structural'],elemAStorey:'Level 2'}; }
const rules = [{id:'r',discipline1:'mep',discipline2:'structural',storey:'Level 2',assignee:'alice',priority:'high'}];

test('assignment helper loads before the app and is available offline', () => {
  const helper = source.indexOf('<script src="clash-assignment-core.js" defer></script>');
  const main = source.indexOf('window.onload = function() {');
  assert.ok(helper >= 0 && main > helper);
  assert.match(worker, /'clash-assignment-core\.js'/);
  assert.match(worker, /var CACHE = 'clashcontrol-v\d+\.\d+\.\d+/);
});

test('flag-off never calls or validates candidate code', () => {
  let calls = 0;
  const broken = {contractVersion:1,matchAssignmentRule:()=>{calls++;return null;},applyAssignmentRules:()=>{calls++;return [];}};
  const loaded = loadAdapter(broken, false);
  assert.equal(loaded.window._ccAssignmentCoreStatus.active, false);
  assert.equal(loaded.api._ccMatchAssignmentRule(rules, sample()), rules[0]);
  assert.equal(calls, 0);
  assert.deepEqual(loaded.diagnostics, []);
});

test('valid opt-in activates candidate and records the contract result', () => {
  const loaded = loadAdapter(core, true);
  assert.equal(loaded.window._ccAssignmentCoreStatus.active, true);
  assert.equal(loaded.window._ccAssignmentCoreStatus.validation.equal, true);
  assert.equal(loaded.api._ccApplyAssignmentRules([sample()], rules)[0].assignee, 'alice');
  assert.equal(loaded.diagnostics.at(-1).outcome, 'candidate');
});

test('candidate mismatch falls back to inline legacy policy', () => {
  const broken = Object.assign({}, core, {matchAssignmentRule:()=>null});
  const loaded = loadAdapter(broken, true);
  assert.equal(loaded.window._ccAssignmentCoreStatus.active, false);
  assert.equal(loaded.api._ccMatchAssignmentRule(rules, sample()), rules[0]);
  assert.equal(loaded.diagnostics.at(-1).outcome, 'fallback');
});
