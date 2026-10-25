'use strict';
// IfcSpace (rooms): source-level wiring guards for the pieces the real-browser
// test (tests/browser/spaces.mjs) can't cheaply cover on every path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generateSyntheticIfc } = require('./fixtures/generate-synthetic-ifc.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function slice(startNeedle, endNeedle) {
  const s = src.indexOf(startNeedle);
  assert.ok(s >= 0, 'not found: ' + startNeedle);
  const e = src.indexOf(endNeedle, s + startNeedle.length);
  assert.ok(e > s, 'end not found: ' + endNeedle);
  return src.slice(s, e);
}

test('both IFC loaders stream IfcSpace geometry in a separate by-id pass', () => {
  const fallback = slice('function loadIFC(buffer, fallbackColor', 'api.CloseModel(modelID);');
  assert.match(fallback, /api\.StreamMeshes\(modelID, _spaceIds, function\(ifcMesh\) \{ _onIfcMesh\(ifcMesh, true\); \}\)/);
  assert.match(fallback, /_ccIfcStubIds\(_spaceIds, _spaceGeoEids, _np, storeyMap, _scopeSet\)/, 'geometry-less rooms are still re-added, rooms with geometry are not duplicated');
  const worker = slice('function _ifcWorkerMain() {', "_emit({type:'result'");
  // (the worker also records each room's global stream position for the sharded load)
  assert.match(worker, /api\.StreamMeshes\(modelID, _spaceIds, function\(ifcMesh\) \{ (_curG = _spPos\[ifcMesh\.expressID\]; )?_onIfcMesh\(ifcMesh, true\); \}\)/);
  assert.doesNotMatch(worker, /_ccMarkSpaceMesh/, 'the worker source is stringified — it must not reference main-thread helpers');
});

test('decoded room meshes are marked (layer, shared material, no instancing key) on every path', () => {
  assert.match(src, /if \(isSpace\) _ccMarkSpaceMesh\(mesh\);\n\s*else mesh\.userData\._instKey = geoExpId/);
  assert.match(src, /if \(_isSp\) _ccMarkSpaceMesh\(mesh\);\n\s*else mesh\.userData\._instKey = geoId/);
  const deser = slice('function _geoDeserialize(cached) {', 'function _ccGeoCacheLacksSpaces');
  assert.ok(deser.indexOf('_ccMarkSpaceElements(elements);') < deser.indexOf('_buildInstancedMeshes(elements, meshes)'));
  const strip = slice('function stripNonPhysicalGeometry(elements, meshes) {', '\n  }\n');
  assert.match(strip, /_ccMarkSpaceElements\(elements\);/);
  assert.match(strip, /el\.props\.ifcType !== 'IfcSpace'/);
});

test('rooms stay out of instancing, batching, render styles, ghosting, bounds and default detection', () => {
  assert.match(slice('function _buildInstancedMeshes(', '\n  }\n'), /if \(!ik \|\| m\.userData\._ccSpace\) return;/);
  assert.match(slice('function _ccBatchPathological(', '\n  }\n'), /m\.userData\._ccSpace\) return;/);
  assert.match(src, /if \(obj\.userData\._ccSpace\) continue; \/\/ rooms keep their own translucent look/);
  assert.match(slice('function ghostOthers(targets) {', 'function unghostAll(){'), /if\(obj\.userData\._ccSpace\) return;/);
  assert.match(slice('function _elemsBBox() {', 'window._ccElemsBBox'), /_ccIsSpaceEl\(el\)/);
  const spaceFilter = /if \(!rules\.includeSpaces && el\.props && el\.props\.ifcType === 'IfcSpace'\) return;/g;
  assert.equal((slice('function _sweepAndPrune(', 'function _sweepAndPruneWasm(').match(spaceFilter) || []).length, 1);
  assert.equal((slice('function _sweepAndPruneWasm(', 'var _singleModelScope').match(spaceFilter) || []).length, 1);
  assert.match(src, /var _NON_PHYSICAL_TYPES = \{IfcSpace:true,/, 'floor-plan poché still skips rooms');
});

test('picking: building elements first, rooms only on a second space-layer pass while shown', () => {
  const pick = slice('function _pickHitOk(h){', '// Helper: resolve expressId from a hit');
  assert.match(pick, /if \(!hits\.length && S\._spacesShown\) \{\n\s*raycaster\.layers\.set\(_CC_SPACE_LAYER\);/);
  assert.match(pick, /finally \{ raycaster\.layers\.set\(0\); \}/);
});

test('showSpaces is a persisted pref, hidden by default', () => {
  assert.match(src, /showSpaces:_ccLoadPref\('showSpaces',false\)/);
  assert.match(src, /'navInputMode','showSpaces'[,\]]/);
});

test('fixture generator: withSpaces is opt-in and the default output is unchanged', () => {
  const plain = generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 3 });
  assert.doesNotMatch(plain, /IFCSPACE/);
  const rooms = generateSyntheticIfc({ storeyCount: 2, wallsPerStorey: 3, withSpaces: true });
  assert.equal((rooms.match(/=IFCSPACE\(/g) || []).length, 2);
});
