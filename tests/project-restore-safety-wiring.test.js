'use strict';
// Bug 1: reopening a saved project file must never destroy an
// already-loaded model's geometry, and must never duplicate issues or
// selection/search sets. project-codec.js's restoreProject() re-dispatches
// ADD_MODEL with a placeholder (meshes:[], elements:[], _stub:true) for
// every saved model -- even ones already loaded with real geometry -- and
// re-dispatches ADD_ISSUE / ADD_SELSET / ADD_SEARCHSET for every saved
// record on every reopen. This extracts the ADD_MODEL reducer case (by
// source markers) and evaluates it directly, plus checks the dedupe guards
// on the other reducer cases by source inspection.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function buildAddModelReducer() {
  const start = src.indexOf('case A.ADD_MODEL:');
  const end = src.indexOf('case A.DEL_MODEL:', start);
  assert.ok(start !== -1 && end !== -1, 'ADD_MODEL reducer case not found');
  let body = src.slice(start, end).replace('case A.ADD_MODEL:', '');
  body += '\nreturn s;'; // fallthrough if nothing matched (shouldn't happen)
  // eslint-disable-next-line no-new-func
  return new Function('s', 'a', '_clearElCaches', body);
}

test('a project-restore stub (empty meshes/elements) never overwrites an already-loaded model\'s geometry', () => {
  const run = buildAddModelReducer();
  const loadedModel = {
    id: 'm1', name: 'Architecture.ifc', discipline: 'architectural', color: '#fff',
    visible: true, meshes: [{id: 1}, {id: 2}], elements: [{id: 1}, {id: 2}, {id: 3}],
  };
  const s = { models: [loadedModel], modelMeta: null };
  const stubAction = { v: { id: 'm1', name: 'Architecture.ifc', discipline: 'architectural', color: '#fff', visible: true, tag: '', meshes: [], elements: [], _stub: true } };
  const result = run(s, stubAction, function(){});
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].meshes.length, 2, 'meshes must be preserved, not wiped to []');
  assert.equal(result.models[0].elements.length, 3, 'elements must be preserved, not wiped to []');
});

test('a stub restore still merges display metadata (discipline/color/tag/visibility) onto the loaded model', () => {
  const run = buildAddModelReducer();
  const loadedModel = {
    id: 'm1', name: 'MEP.ifc', discipline: 'mep', color: '#111',
    visible: true, meshes: [{id: 1}], elements: [{id: 1}],
  };
  const s = { models: [loadedModel], modelMeta: null };
  const stubAction = { v: { id: 'm1', name: 'MEP.ifc', discipline: 'mep', color: '#f00', visible: false, tag: 'renamed', meshes: [], elements: [] } };
  const result = run(s, stubAction, function(){});
  assert.equal(result.models[0].color, '#f00');
  assert.equal(result.models[0].tag, 'renamed');
  assert.equal(result.models[0].meshes.length, 1);
});

test('a genuinely new (non-loaded, matched by name) model with real geometry still replaces the stale placeholder normally', () => {
  const run = buildAddModelReducer();
  const staleStub = { id: 'm1', name: 'Structure.ifc', discipline: null, color: null, visible: true, meshes: [], elements: [] };
  const s = { models: [staleStub], modelMeta: null };
  const realLoad = { v: { id: 'm2', name: 'Structure.ifc', discipline: 'structural', color: '#0f0', visible: true, meshes: [{id: 1}], elements: [{id: 1}] } };
  const result = run(s, realLoad, function(){});
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].meshes.length, 1, 'a real load must populate geometry when the existing record was itself empty');
});

test('ADD_ISSUE dedupes by id (project restore re-dispatch) and then by bcfGuid (BCF re-import)', () => {
  const start = src.indexOf('case A.ADD_ISSUE:');
  const region = src.slice(start, start + 500);
  assert.ok(region.includes("s.issues.some(function(i){return i.id===a.v.id;})"), 'expected id-dedupe guard');
  assert.ok(region.includes('bcfGuid'), 'expected bcfGuid-dedupe guard');
});

test('ADD_SELSET and ADD_SEARCHSET dedupe by id so a project restore does not double them up', () => {
  const selStart = src.indexOf("case 'ADD_SELSET':");
  const selRegion = src.slice(selStart, selStart + 400);
  assert.ok(selRegion.includes('(s.selectionSets||[]).some(function(x){return x.id===a.v.id;})'));

  const searchStart = src.indexOf("case 'ADD_SEARCHSET':");
  const searchRegion = src.slice(searchStart, searchStart + 400);
  assert.ok(searchRegion.includes('(s.searchSets||[]).some(function(x){return x.id===a.v.id;})'));
});
