'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../clash-assignment-core');

function rule(id, d1, d2, storey, assignee, priority) {
  return { id, discipline1:d1, discipline2:d2, storey, assignee:assignee||'', priority:priority||'' };
}
function clash(id, disciplines, storey, extra) {
  return Object.assign({ id, _delta:'new', disciplines, elemAStorey:storey||'', elemBStorey:'' }, extra);
}

test('assignment core is an immutable two-function contract', () => {
  assert.equal(core.contractVersion, 1);
  assert.equal(Object.isFrozen(core), true);
  assert.equal(typeof core.matchAssignmentRule, 'function');
  assert.equal(typeof core.applyAssignmentRules, 'function');
});

test('matching remains unordered, storey-aware and first-match-wins', () => {
  const first = rule('first','mep','structural','Level 2','alice','high');
  const second = rule('second','structural','mep','any','bob','low');
  assert.equal(core.matchAssignmentRule([first,second], clash('c',['structural','mep'],'Level 2')), first);
  assert.equal(core.matchAssignmentRule([first,second], clash('c',['mep','structural'],'Level 3')), second);
  assert.equal(core.matchAssignmentRule([first], clash('c',['mep','mep'],'Level 2')), null);
});

test('any-side behavior and empty inputs remain unchanged', () => {
  const blanket = rule('all','any','any','any','owner','');
  assert.equal(core.matchAssignmentRule([blanket], clash('c',['civil','other'],'Roof')), blanket);
  assert.equal(core.matchAssignmentRule([], clash('c',['mep','structural'])), null);
  assert.equal(core.matchAssignmentRule(null, clash('c',['mep','structural'])), null);
});

test('only new unassigned matches are copied and stamped', () => {
  const rules = [rule('r','mep','structural','any','alice','high')];
  const fresh = clash('fresh',['mep','structural']);
  const persisting = clash('persisting',['mep','structural'],'',{_delta:'persisting'});
  const assigned = clash('assigned',['mep','structural'],'',{assignee:'owner'});
  const miss = clash('miss',['civil','other']);
  const out = core.applyAssignmentRules([fresh,persisting,assigned,miss], rules);
  assert.notEqual(out[0], fresh);
  assert.equal(out[0].assignee, 'alice');
  assert.equal(out[0].priority, 'high');
  assert.equal(out[1], persisting);
  assert.equal(out[2], assigned);
  assert.equal(out[3], miss);
});

test('empty rules return the original array reference', () => {
  const clashes = [clash('c',['mep','structural'])];
  assert.equal(core.applyAssignmentRules(clashes, []), clashes);
  assert.equal(core.applyAssignmentRules(clashes, null), clashes);
});
