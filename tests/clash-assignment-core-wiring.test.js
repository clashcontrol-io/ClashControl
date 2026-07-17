'use strict';
// assignmentCoreV2 graduated from a flagged migration (boot-time equivalence
// check against an inline legacy implementation, opt-out flag) to the sole
// implementation — see MEMORY.md Architecture Decisions. This locks the
// simplified wiring: index.html's assignment functions are a direct,
// unconditional delegation to window._ccClashAssignmentCore, nothing else.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

function adapterWindow(candidate) {
  const start = source.indexOf('var _ccAssignmentCore = window._ccClashAssignmentCore;');
  const end = source.indexOf('\n\n', source.indexOf('function _ccApplyAssignmentRules(clashes, rules)', start));
  assert.ok(start >= 0 && end > start, 'assignment wiring block not found');
  const window = { _ccClashAssignmentCore: candidate };
  const api = new Function('window', source.slice(start, end) + '; return {_ccMatchAssignmentRule, _ccApplyAssignmentRules};')(window);
  return { window, api };
}

function sample() { return { _delta: 'new', disciplines: ['mep', 'structural'], elemAStorey: 'Level 2' }; }
const rules = [{ id: 'r', discipline1: 'mep', discipline2: 'structural', storey: 'Level 2', assignee: 'alice', priority: 'high' }];

test('assignment helper loads before the app and is available offline', () => {
  const helper = source.indexOf('<script src="clash-assignment-core.js" defer></script>');
  const main = source.indexOf('window.onload = function() {');
  assert.ok(helper >= 0 && main > helper);
  assert.match(worker, /'clash-assignment-core\.js'/);
  assert.match(worker, /var CACHE = 'clashcontrol-v\d+\.\d+\.\d+/);
});

test('no flag, gate, or opt-out remains for this migration', () => {
  assert.doesNotMatch(source, /isEnabled\('assignmentCoreV2'\)/);
  assert.doesNotMatch(source, /_ccAssignmentCoreStatus/);
  assert.doesNotMatch(source, /_ccAssignmentCoreActive/);
  assert.doesNotMatch(source, /_ccValidateAssignmentCore/);
});

test('_ccMatchAssignmentRule and _ccApplyAssignmentRules delegate directly and unconditionally to the module', () => {
  const { api } = adapterWindow({
    matchAssignmentRule: (r, c) => rules[0],
    applyAssignmentRules: (clashes, r) => clashes.map((c) => Object.assign({}, c, { assignee: 'alice' })),
  });
  assert.equal(api._ccMatchAssignmentRule(rules, sample()), rules[0]);
  assert.equal(api._ccApplyAssignmentRules([sample()], rules)[0].assignee, 'alice');
});

test('a missing module surfaces a real error rather than silently falling back to anything', () => {
  const { api } = adapterWindow(undefined);
  assert.throws(() => api._ccMatchAssignmentRule(rules, sample()), TypeError);
});
