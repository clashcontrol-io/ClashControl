'use strict';
// REWRITE_UI_PLAN.md Phase 12 — lock the pre-decode storey-name extraction
// (_ccExtractStoreyNamesFromIfcText, index.html), the pure piece the storey
// scope chooser is built on. IFC-SPF is plain text, so this is a regex scan
// of the raw bytes, entirely separate from and before the real web-ifc WASM
// parse — no DOM/WASM dependency, directly unit-testable.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('function _ccExtractStoreyNamesFromIfcText(text) {');
assert.ok(start !== -1, '_ccExtractStoreyNamesFromIfcText not found');
const end = src.indexOf('window._ccExtractStoreyNamesFromIfcText', start);
assert.ok(end !== -1, 'closing point not found');
const extract = new Function(src.slice(start, end) + '; return _ccExtractStoreyNamesFromIfcText;')();

test('extracts a single storey name from a real IFC-SPF line', () => {
  const text = "#50=IFCBUILDINGSTOREY('0SmokeStorey0000000001',$,'Level 0',$,$,#51,$,$,.ELEMENT.,0.);";
  assert.deepEqual(extract(text), ['Level 0']);
});

test('extracts multiple storeys in file order', () => {
  const text = [
    "#50=IFCBUILDINGSTOREY('guid1',$,'Ground Floor',$,$,#51,$,$,.ELEMENT.,0.);",
    "#52=IFCBUILDINGSTOREY('guid2',$,'Level 1',$,$,#53,$,$,.ELEMENT.,3.);",
    "#54=IFCBUILDINGSTOREY('guid3',$,'Roof',$,$,#55,$,$,.ELEMENT.,6.);",
  ].join('\n');
  assert.deepEqual(extract(text), ['Ground Floor', 'Level 1', 'Roof']);
});

test('deduplicates repeated storey names, keeping first-seen order', () => {
  const text = [
    "#50=IFCBUILDINGSTOREY('guid1',$,'Level 1',$,$,#51,$,$,.ELEMENT.,0.);",
    "#52=IFCBUILDINGSTOREY('guid2',$,'Level 2',$,$,#53,$,$,.ELEMENT.,3.);",
    "#54=IFCBUILDINGSTOREY('guid3',$,'Level 1',$,$,#55,$,$,.ELEMENT.,0.);", // duplicate name, different GUID
  ].join('\n');
  assert.deepEqual(extract(text), ['Level 1', 'Level 2']);
});

test('an unnamed storey ($ instead of a name) is skipped, not reported as an empty string', () => {
  const text = "#50=IFCBUILDINGSTOREY('guid1',$,$,$,$,#51,$,$,.ELEMENT.,0.);\n" +
    "#52=IFCBUILDINGSTOREY('guid2',$,'Named Level',$,$,#53,$,$,.ELEMENT.,3.);";
  assert.deepEqual(extract(text), ['Named Level']);
});

test('empty or non-IFC text returns an empty array without throwing', () => {
  assert.deepEqual(extract(''), []);
  assert.deepEqual(extract(null), []);
  assert.deepEqual(extract('this is not an ifc file at all'), []);
});

test('is not confused by IFCBUILDINGSTOREYTYPE or similar longer entity names', () => {
  // A naive substring match could over-match a different entity that merely
  // starts with the same prefix — the pattern requires '(' right after the
  // exact entity name.
  const text = "#1=IFCBUILDINGSTOREYTYPE('guid',$,'Not A Real Storey',$);";
  assert.deepEqual(extract(text), []);
});
