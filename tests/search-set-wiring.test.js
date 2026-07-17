'use strict';
// Locks the Wave 4 "search sets" reducer + UI + project round-trip wiring
// (index.html). Companion to search-set-resolver.test.js, which locks the
// pure _resolveSearchSet matching logic - this file locks that the reducer
// state/actions and the NavigatorPanel UI actually connect to it, and that
// a saved project restores the QUERY (not a stale ref list).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractCaseReturn(caseLabel) {
  const marker = "case '" + caseLabel + "': return ";
  const start = src.indexOf(marker);
  assert.ok(start !== -1, marker + ' not found');
  const exprStart = start + marker.length;
  const end = src.indexOf(';\n', exprStart);
  assert.ok(end !== -1, caseLabel + ' case not terminated on its own line');
  return new Function('s', 'a', 'return ' + src.slice(exprStart, end) + ';');
}

function extractAddSearchset() {
  const marker = "case 'ADD_SEARCHSET': {";
  const start = src.indexOf(marker);
  assert.ok(start !== -1, marker + ' not found');
  const braceOpen = start + marker.length - 1; // position of the opening '{'
  const end = src.indexOf('\n      }', braceOpen);
  assert.ok(end !== -1, 'ADD_SEARCHSET case not terminated');
  const body = src.slice(braceOpen, end + '\n      }'.length); // include the closing '}'
  return new Function('s', 'a', 'uid', body);
}

function qset(id, name, query) { return { id: id, name: name, query: query || {} }; }

test('ADD_SEARCHSET appends a new set with the given query, defaulting id/name/color/createdAt', () => {
  const fn = extractAddSearchset();
  const uid = () => 'generated-id';
  const s = { searchSets: [] };
  const next = fn(s, { v: { name: 'Fire doors', query: { ifcType: 'IfcDoor' } } }, uid);
  assert.equal(next.searchSets.length, 1);
  assert.equal(next.searchSets[0].name, 'Fire doors');
  assert.deepEqual(next.searchSets[0].query, { ifcType: 'IfcDoor' });
  assert.equal(next.searchSets[0].id, 'generated-id');
  assert.ok(next.searchSets[0].createdAt);
});

test('ADD_SEARCHSET does not mutate other sets already in state', () => {
  const fn = extractAddSearchset();
  const s = { searchSets: [qset('a', 'Existing', { storey: 'L1' })] };
  const next = fn(s, { v: { id: 'b', name: 'New', query: {} } }, () => 'x');
  assert.equal(next.searchSets.length, 2);
  assert.deepEqual(next.searchSets[0], s.searchSets[0]);
});

test('DEL_SEARCHSET removes only the matching set', () => {
  const fn = extractCaseReturn('DEL_SEARCHSET');
  const s = { searchSets: [qset('a', 'A'), qset('b', 'B')] };
  const next = fn(s, { id: 'a' });
  assert.deepEqual(next.searchSets.map((x) => x.id), ['b']);
});

test('REN_SEARCHSET renames only the matching set, query untouched', () => {
  const fn = extractCaseReturn('REN_SEARCHSET');
  const s = { searchSets: [qset('a', 'Old name', { ifcType: 'IfcWall' })] };
  const next = fn(s, { id: 'a', name: 'New name' });
  assert.equal(next.searchSets[0].name, 'New name');
  assert.deepEqual(next.searchSets[0].query, { ifcType: 'IfcWall' });
});

test('UPD_SEARCHSET_QUERY replaces the query on the matching set only, name untouched', () => {
  const fn = extractCaseReturn('UPD_SEARCHSET_QUERY');
  const s = { searchSets: [qset('a', 'MEP risers', { ifcType: 'IfcDuctSegment' }), qset('b', 'B', { storey: 'L2' })] };
  const next = fn(s, { id: 'a', query: { ifcType: 'IfcPipeSegment' } });
  assert.deepEqual(next.searchSets.find((x) => x.id === 'a').query, { ifcType: 'IfcPipeSegment' });
  assert.equal(next.searchSets.find((x) => x.id === 'a').name, 'MEP risers');
  assert.deepEqual(next.searchSets.find((x) => x.id === 'b').query, { storey: 'L2' }, 'the other set must be untouched');
});

test('an unknown id is a no-op for DEL/REN/UPD_SEARCHSET_QUERY', () => {
  const s = { searchSets: [qset('a', 'A', { ifcType: 'IfcWall' })] };
  assert.deepEqual(extractCaseReturn('DEL_SEARCHSET')(s, { id: 'missing' }).searchSets, s.searchSets);
  assert.deepEqual(extractCaseReturn('REN_SEARCHSET')(s, { id: 'missing', name: 'X' }).searchSets, s.searchSets);
  assert.deepEqual(extractCaseReturn('UPD_SEARCHSET_QUERY')(s, { id: 'missing', query: {} }).searchSets, s.searchSets);
});

test('INIT state seeds searchSets as an empty array', () => {
  assert.ok(/searchSets:\[\]/.test(src), 'INIT must declare searchSets:[]');
});

test('the Search Sets panel section exists, wired to _resolveSearchSet and _highlightRefs', () => {
  const panelStart = src.indexOf('${/* Search sets — a saved QUERY');
  assert.ok(panelStart !== -1, 'Search Sets panel section not found');
  const panelEnd = src.indexOf('${/* Sidebar property panel removed', panelStart);
  assert.ok(panelEnd !== -1 && panelEnd > panelStart);
  const panelSrc = src.slice(panelStart, panelEnd);

  assert.ok(/_resolveSearchSet\(searchForm, s\.models\)/.test(panelSrc), 'the form must preview a live count while building the query');
  assert.ok(/_resolveSearchSet\(qs\.query, s\.models\)/.test(panelSrc), 'each saved set must re-resolve against s.models on every render');
  assert.ok(/d\(\{t:'ADD_SEARCHSET'/.test(panelSrc));
  assert.ok(/d\(\{t:'UPD_SEARCHSET_QUERY'/.test(panelSrc));
  assert.ok(/d\(\{t:'REN_SEARCHSET'/.test(panelSrc));
  assert.ok(/d\(\{t:'DEL_SEARCHSET'/.test(panelSrc));
  assert.ok(/_highlightRefs\(refs,true\)/.test(panelSrc), 'Isolate button');
  assert.ok(/_highlightRefs\(refs,false\)/.test(panelSrc), 'Highlight button');
});

test('the form refuses to save with zero criteria (client-side guard, not just a resolver default)', () => {
  const panelStart = src.indexOf('${/* Search sets — a saved QUERY');
  const panelEnd = src.indexOf('${/* Sidebar property panel removed', panelStart);
  const panelSrc = src.slice(panelStart, panelEnd);
  assert.ok(/_searchFormHasCriteria\(searchForm\)/.test(panelSrc));
  assert.ok(/Enter at least one filter/.test(panelSrc));
});

test('saveProject includes searchSets and loadProject restores them via ADD_SEARCHSET', () => {
  // saveProject/loadProject now delegate to project-codec.js (projectCodecV2
  // graduated to the sole implementation — see MEMORY.md Architecture
  // Decisions); the serialize/restore assertions check the module directly.
  const codecSrc = fs.readFileSync(path.join(__dirname, '..', 'project-codec.js'), 'utf8');
  assert.ok(/searchSets: state\.searchSets \|\| \[\]/.test(codecSrc), 'project-codec.js must serialize searchSets');
  assert.ok(/data\.searchSets\.forEach\(function\(searchSet\) \{ dispatch\(\{t:actions\.ADD_SEARCHSET, v:searchSet\}\); \}\)/.test(codecSrc), 'project-codec.js must restore each saved search set');
  assert.ok(/_ccRestoreProject\(data, d\)/.test(src), 'loadProject must route parsed data through the guarded restore adapter');
});
