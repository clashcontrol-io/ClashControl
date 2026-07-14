'use strict';
// Locks _ccMatchAssignmentRule / _ccApplyAssignmentRules (index.html) - the
// pure matching + stamping logic behind Wave 3's "stamp/auto-assignment
// rules": Revizto-style per-project templates ("discipline-pair x storey ->
// assignee/priority") applied to newly detected clashes at merge time.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFn(name) {
  const header = 'function ' + name + '(';
  const start = src.indexOf('  ' + header);
  assert.ok(start !== -1, name + ' not found');
  const end = src.indexOf('\n  }', start) + '\n  }'.length;
  return src.slice(start, end);
}

const bundle = extractFn('_ccMatchAssignmentRule') + '\n' + extractFn('_ccApplyAssignmentRules');
const { _ccMatchAssignmentRule, _ccApplyAssignmentRules } = new Function(bundle + '; return { _ccMatchAssignmentRule, _ccApplyAssignmentRules };')();

function rule(discipline1, discipline2, storey, assignee, priority) {
  return { id: 'r-' + Math.random(), discipline1: discipline1, discipline2: discipline2, storey: storey || 'any', assignee: assignee || '', priority: priority || '' };
}
function clash(disciplines, storey, extra) {
  return Object.assign({ id: 'c1', _delta: 'new', disciplines: disciplines, elemAStorey: storey || '', elemBStorey: '' }, extra);
}

test('matches a discipline pair regardless of order (rule structural+mep matches clash [mep, structural])', () => {
  const r = rule('structural', 'mep');
  assert.equal(_ccMatchAssignmentRule([r], clash(['mep', 'structural'])), r);
  assert.equal(_ccMatchAssignmentRule([r], clash(['structural', 'mep'])), r);
});

test('"any" on one side matches every discipline on that side, including a same-discipline self-clash', () => {
  const r = rule('structural', 'any');
  assert.equal(_ccMatchAssignmentRule([r], clash(['structural', 'structural'])), r);
  assert.equal(_ccMatchAssignmentRule([r], clash(['structural', 'mep'])), r);
  assert.equal(_ccMatchAssignmentRule([r], clash(['mep', 'mep'])), null, 'neither side is structural');
});

test('"any"+"any" matches every clash regardless of discipline (blanket rule)', () => {
  const r = rule('any', 'any');
  assert.equal(_ccMatchAssignmentRule([r], clash(['civil', 'other'])), r);
});

test('does not cross-match: a rule needing BOTH disciplines present must not match when only one is', () => {
  const r = rule('structural', 'mep');
  assert.equal(_ccMatchAssignmentRule([r], clash(['structural', 'structural'])), null, 'no mep side at all');
  assert.equal(_ccMatchAssignmentRule([r], clash(['mep', 'architectural'])), null, 'no structural side at all');
});

test('storey narrows the match; "any" storey matches every storey', () => {
  const withStorey = rule('mep', 'structural', 'Level 3');
  assert.equal(_ccMatchAssignmentRule([withStorey], clash(['mep', 'structural'], 'Level 3')), withStorey);
  assert.equal(_ccMatchAssignmentRule([withStorey], clash(['mep', 'structural'], 'Level 4')), null);
  const anyStorey = rule('mep', 'structural', 'any');
  assert.equal(_ccMatchAssignmentRule([anyStorey], clash(['mep', 'structural'], 'Level 99')), anyStorey);
});

test('first matching rule wins - array order is precedence order', () => {
  const first = rule('mep', 'structural', 'any', 'alice@x.com');
  const second = rule('mep', 'structural', 'any', 'bob@x.com');
  assert.equal(_ccMatchAssignmentRule([first, second], clash(['mep', 'structural'])), first);
});

test('no rules or no match returns null, not a throw', () => {
  assert.equal(_ccMatchAssignmentRule([], clash(['mep', 'structural'])), null);
  assert.equal(_ccMatchAssignmentRule(null, clash(['mep', 'structural'])), null);
  assert.equal(_ccMatchAssignmentRule([rule('civil', 'civil')], clash(['mep', 'structural'])), null);
});

test('_ccApplyAssignmentRules stamps assignee+priority on a new, unassigned clash from the matching rule', () => {
  const r = rule('mep', 'structural', 'any', 'alice@x.com', 'high');
  const out = _ccApplyAssignmentRules([clash(['mep', 'structural'])], [r]);
  assert.equal(out[0].assignee, 'alice@x.com');
  assert.equal(out[0].priority, 'high');
});

test('never touches a persisting clash (_delta !== "new"), even if it has no assignee yet', () => {
  const r = rule('mep', 'structural', 'any', 'alice@x.com');
  const c = clash(['mep', 'structural'], '', { _delta: null });
  const out = _ccApplyAssignmentRules([c], [r]);
  assert.equal(out[0], c, 'must be the exact same object - untouched');
  assert.equal(out[0].assignee, undefined);
});

test('never overrides a clash that already has an assignee (first match wins, not last write)', () => {
  const r = rule('mep', 'structural', 'any', 'alice@x.com');
  const c = clash(['mep', 'structural'], '', { assignee: 'existing@x.com' });
  const out = _ccApplyAssignmentRules([c], [r]);
  assert.equal(out[0].assignee, 'existing@x.com');
});

test('a rule with only priority set (no assignee) stamps priority alone, leaving assignee unset', () => {
  const r = rule('mep', 'structural', 'any', '', 'critical');
  const out = _ccApplyAssignmentRules([clash(['mep', 'structural'])], [r]);
  assert.equal(out[0].priority, 'critical');
  assert.equal(out[0].assignee, undefined);
});

test('clashes with no matching rule and no rules configured at all pass through unchanged (same reference)', () => {
  const c1 = clash(['mep', 'structural']);
  assert.equal(_ccApplyAssignmentRules([c1], [])[0], c1);
  assert.equal(_ccApplyAssignmentRules([c1], null)[0], c1);
  const c2 = clash(['civil', 'other']);
  assert.equal(_ccApplyAssignmentRules([c2], [rule('mep', 'structural', 'any', 'x')])[0], c2);
});

test('a mixed batch: only the new, unassigned, matching clashes get stamped', () => {
  const r = rule('mep', 'structural', 'any', 'alice@x.com');
  const newMatch = clash(['mep', 'structural'], '', { id: 'a' });
  const newNoMatch = clash(['civil', 'other'], '', { id: 'b' });
  const persisting = clash(['mep', 'structural'], '', { id: 'c', _delta: null });
  const alreadyAssigned = clash(['mep', 'structural'], '', { id: 'd', assignee: 'someone@x.com' });
  const out = _ccApplyAssignmentRules([newMatch, newNoMatch, persisting, alreadyAssigned], [r]);
  assert.equal(out.find((x) => x.id === 'a').assignee, 'alice@x.com');
  assert.equal(out.find((x) => x.id === 'b').assignee, undefined);
  assert.equal(out.find((x) => x.id === 'c').assignee, undefined);
  assert.equal(out.find((x) => x.id === 'd').assignee, 'someone@x.com');
});
