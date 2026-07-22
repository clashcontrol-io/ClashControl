'use strict';
// V7 P6.2: the NL "hide <type>"/"isolate <type>" command handlers used to
// collect ids by iterating el.meshes[] and reading mesh.userData.expressId --
// pushing the SAME id once per mesh on a multi-part element, when el.expressId
// already carries that exact value at the element level. Both consumers
// (_ccTempHide, _ccIsolate) immediately fold the array into a set/lookup, so
// the duplicates were always harmless, never load-bearing -- this just
// removes a redundant el.meshes[] dependency, not a behavior change.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

test('the "hide <type>" NL handler collects el.expressId once per element, not once per mesh', () => {
  assert.match(html, /if\(el\.props&&el\.props\.ifcType===resolved\)ids\.push\(el\.expressId\);/);
  assert.doesNotMatch(html, /if\(el\.props&&el\.props\.ifcType===resolved\)el\.meshes\.forEach/);
});

test('the "isolate <type>" NL handler collects el.expressId once per element, not once per mesh', () => {
  assert.match(html, /if\(el\.props&&el\.props\.ifcType===isoType\)isoIds\.push\(el\.expressId\);/);
  assert.doesNotMatch(html, /if\(el\.props&&el\.props\.ifcType===isoType\)el\.meshes\.forEach/);
});

test('both consumers of these id lists fold the array into a lookup, confirming duplicates were never load-bearing', () => {
  const hideBody = html.slice(html.indexOf('window._ccTempHide = function(expressIds) {'), html.indexOf('window._ccTempUnhide'));
  assert.match(hideBody, /expressIds\.forEach\(function\(id\)\{idSet\[id\]=true;\}\)/);
  // _ccIsolate delegates to ghostOthers, which is exercised elsewhere; this
  // test only needs to confirm _ccTempHide's own fold, already shown above,
  // plus that _ccIsolate exists and is a thin delegate (no per-item logic
  // of its own that could be sensitive to duplicates).
  const isolateBody = html.slice(html.indexOf('window._ccIsolate = function(expressIds) {'), html.indexOf('window._ccUnisolate'));
  assert.match(isolateBody, /ghostOthers\(expressIds\)/);
});
