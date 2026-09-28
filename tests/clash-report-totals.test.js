'use strict';
// _ccClashReport (index.html) had three bugs:
//  1. counts.open + counts.inProg + counts.resolved + counts.autoRes didn't
//     add up to clashes.length whenever a clash had status confirmed/
//     denied/accepted_needs_check (STAT, ~index.html:776) — those statuses
//     were never counted anywhere. Fixed with a counts.other bucket.
//  2. a cluster row's "Open" column folded in_progress into the same
//     count as open, so it never matched what "Open" meant anywhere else
//     in the report (its own status card, the Issues panel, etc).
//  3. a cluster row's Storey column read c.storey, which is an ISSUE
//     field — clashes carry elemAStorey/elemBStorey — so it read
//     undefined ("—") on every single row.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

// The counting/labeling logic is small and self-contained enough to extract
// and test directly, without dragging in the whole HTML-report string built
// around it (window.open/popup writing isn't node-testable anyway).
// Anchored to start searching from _ccClashReport itself — "var SEV_RANK ="
// also appears verbatim in the unrelated _ccModelMatrixGrid earlier in the
// file, and a plain html.indexOf() would match that one instead.
const reportStart = html.indexOf('function _ccClashReport(s) {');
assert.ok(reportStart !== -1, '_ccClashReport not found');

function extractCountsLogic() {
  const start = html.indexOf('var counts = { open:0', reportStart);
  assert.ok(start !== -1);
  const end = html.indexOf('});', start) + '});'.length;
  return html.slice(start, end);
}

function extractRowsLogic() {
  const start = html.indexOf('var SEV_RANK = { critical:4', reportStart);
  assert.ok(start !== -1);
  const end = html.indexOf('.sort(function(a,b){ return b.open - a.open || b.count - a.count; });', start)
    + '.sort(function(a,b){ return b.open - a.open || b.count - a.count; });'.length;
  return html.slice(start, end);
}

test('counts.open + inProg + resolved + autoRes + other always equals the total clash count', () => {
  const clashes = [
    { status: 'open' }, { status: 'in_progress' }, { status: 'resolved' },
    { status: 'auto_resolved' }, { status: 'confirmed' }, { status: 'denied' },
    { status: 'accepted_needs_check' }, { status: 'closed' },
  ];
  const src = 'var clashes = ' + JSON.stringify(clashes) + ';\n' + extractCountsLogic() + '\nreturn counts;';
  const counts = new Function(src)();
  const sum = counts.open + counts.inProg + counts.resolved + counts.autoRes + counts.other;
  assert.equal(sum, clashes.length);
  assert.equal(counts.open, 1);
  assert.equal(counts.inProg, 1);
  assert.equal(counts.resolved, 2); // resolved + closed
  assert.equal(counts.autoRes, 1);
  assert.equal(counts.other, 3); // confirmed, denied, accepted_needs_check
});

test('a cluster row\'s Open column counts only status===open, not in_progress', () => {
  const clashes = [
    { id: 'c1', status: 'open', elemAStorey: 'Level 1' },
    { id: 'c2', status: 'in_progress', elemAStorey: 'Level 1' },
  ];
  const src = 'var clashes = ' + JSON.stringify(clashes) + ';\n'
    + "var clusters = { k: clashes }, order = ['k'];\n"
    + 'var window = {};\n'
    + 'function _ccDeterministicSeverity(){ return "minor"; }\n'
    + extractRowsLogic()
    + '\nreturn rows;';
  const rows = new Function(src)();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].open, 1, 'only the truly-open clash should count, not the in_progress one too');
});

test('a cluster row\'s Storey reads elemAStorey/elemBStorey (clash fields), not c.storey (an issue field)', () => {
  const clashes = [{ id: 'c1', status: 'open', elemAStorey: 'Level 2', elemBStorey: 'Level 1' }];
  const src = 'var clashes = ' + JSON.stringify(clashes) + ';\n'
    + "var clusters = { k: clashes }, order = ['k'];\n"
    + 'var window = {};\n'
    + 'function _ccDeterministicSeverity(){ return "minor"; }\n'
    + extractRowsLogic()
    + '\nreturn rows;';
  const rows = new Function(src)();
  assert.equal(rows[0].storey, 'Level 2');
});

test('a generic fallback label (no title, no _ccClusterLabelFor) still gets the clash\'s number appended for uniqueness', () => {
  const clashes = [{ id: 'c1', status: 'open', number: 42 }];
  const src = 'var clashes = ' + JSON.stringify(clashes) + ';\n'
    + "var clusters = { k: clashes }, order = ['k'];\n"
    + 'var window = {};\n'
    + 'function _ccDeterministicSeverity(){ return "minor"; }\n'
    + extractRowsLogic()
    + '\nreturn rows;';
  const rows = new Function(src)();
  assert.equal(rows[0].label, 'Clash #42');
});

test('a real title is used as-is, with no number suffix appended', () => {
  const clashes = [{ id: 'c1', status: 'open', title: 'Duct vs beam', number: 42 }];
  const src = 'var clashes = ' + JSON.stringify(clashes) + ';\n'
    + "var clusters = { k: clashes }, order = ['k'];\n"
    + 'var window = {};\n'
    + 'function _ccDeterministicSeverity(){ return "minor"; }\n'
    + extractRowsLogic()
    + '\nreturn rows;';
  const rows = new Function(src)();
  assert.equal(rows[0].label, 'Duct vs beam');
});
