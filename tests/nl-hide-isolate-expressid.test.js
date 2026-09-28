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
  // window._ccTempHide/_ccIsolate are now thin wrappers (pushing an undo
  // entry) around _ccTempHideCore/_ccIsolateCore, which hold the actual
  // per-item logic. _ccTempHideCore's param is `targets` (bare expressIds
  // OR {expressId, modelId} refs — see the element-modelid-scoping-wiring
  // tests for why: two loaded models can share a bare expressId, so hide/
  // isolate needed a model-scoped form). It still folds everything into id
  // lookup objects (idAny/idScoped) before ever touching the scene graph,
  // so a duplicate id in the incoming array is still harmless.
  const hideCoreBody = html.slice(html.indexOf('function _ccTempHideCore(targets) {'), html.indexOf('window._ccTempHide = function'));
  assert.match(hideCoreBody, /idAny\[t\] = true;/);
  assert.match(hideCoreBody, /idScoped\[t\.expressId\]\[t\.modelId\] = true;/);
  // _ccIsolateCore delegates to ghostOthers, which is exercised elsewhere;
  // this test only needs to confirm _ccTempHideCore's own fold, already
  // shown above, plus that _ccIsolateCore exists and is a thin delegate (no
  // per-item logic of its own that could be sensitive to duplicates).
  const isolateCoreBody = html.slice(html.indexOf('function _ccIsolateCore(targets) {'), html.indexOf('function _ccUnisolateCore'));
  assert.match(isolateCoreBody, /ghostOthers\(targets\)/);
});
