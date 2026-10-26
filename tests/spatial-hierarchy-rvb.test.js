'use strict';
// Locks the additive loader changes backing the RVB BIM Norm v1.1 checks:
//   - extractStoreys() now flags whether Elevation was actually set
//     (previously defaulted silently to 0, indistinguishable from a real
//     ground-floor elevation of 0.0)
//   - extractSpatialHierarchy() now reads IfcZone (id/name/objectType) and
//     stamps _hasName on project/site/building/zone entries, so a
//     safeStr(...)||'IfcProject'-style fallback name can't be mistaken for a
//     real one
// Extracted the same way tests/ifc-units.test.js pulls a slice out of the
// inline script. Only IFC/safeStr/_extractAxis/extractStoreys/
// extractSpatialHierarchy are needed; a minimal fake web-ifc `api` stands in
// for the real WASM module (same style as bcf-export.test.js's fake JSZip).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function loadFns() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const start = html.indexOf('var IFC = {');
  assert.ok(start !== -1, 'IFC constants map not found');
  const end = html.indexOf('function resolveMaterialName', start);
  assert.ok(end !== -1, 'resolveMaterialName boundary not found');
  const src = html.slice(start, end);
  const fn = new Function('window', src + '; return {extractStoreys: extractStoreys, extractSpatialHierarchy: extractSpatialHierarchy, IFC: IFC};');
  return fn({});
}

// A minimal fake web-ifc API: `lines` maps expressID -> line object, `byType`
// maps IFC type constant -> array of expressIDs.
function fakeApi(byType, lines) {
  return {
    GetLineIDsWithType(modelID, type) {
      const ids = byType[type] || [];
      return { size: () => ids.length, get: (i) => ids[i] };
    },
    GetLine(modelID, id) { return lines[id]; },
  };
}

test('extractStoreys: hasElevation is true when Elevation is explicitly set, including 0.0', () => {
  const { extractStoreys, IFC } = loadFns();
  const api = fakeApi(
    { [IFC.IFCBUILDINGSTOREY]: [1, 2] },
    { 1: { Name: 'Ground', Elevation: { value: 0 } }, 2: { Name: 'Roof' /* no Elevation */ } },
  );
  const { data } = extractStoreys(api, 0);
  const ground = data.find((s) => s.name === 'Ground');
  const roof = data.find((s) => s.name === 'Roof');
  assert.equal(ground.hasElevation, true, 'an explicit 0.0 elevation must not read as unset');
  assert.equal(ground.elevation, 0);
  assert.equal(roof.hasElevation, false, 'a genuinely missing Elevation must be distinguishable from 0.0');
});

test('extractSpatialHierarchy: _hasName is false when the fallback name kicked in', () => {
  const { extractSpatialHierarchy, IFC } = loadFns();
  const api = fakeApi(
    { [IFC.IFCPROJECT]: [10], [IFC.IFCSITE]: [20], [IFC.IFCBUILDING]: [30] },
    { 10: {}, 20: {}, 30: {} }, // no Name on any of them
  );
  const h = extractSpatialHierarchy(api, 0);
  assert.equal(h.project.name, 'IfcProject');
  assert.equal(h.project._hasName, false);
  assert.equal(h.sites[0].name, 'IfcSite');
  assert.equal(h.sites[0]._hasName, false);
  assert.equal(h.buildings[0].name, 'IfcBuilding');
  assert.equal(h.buildings[0]._hasName, false);
});

test('extractSpatialHierarchy: _hasName is true and the real name is kept when Name is set', () => {
  const { extractSpatialHierarchy, IFC } = loadFns();
  const api = fakeApi(
    { [IFC.IFCPROJECT]: [10] },
    { 10: { Name: 'Headquarters Renovation' } },
  );
  const h = extractSpatialHierarchy(api, 0);
  assert.equal(h.project.name, 'Headquarters Renovation');
  assert.equal(h.project._hasName, true);
});

test('extractSpatialHierarchy: reads IfcZone id/name/objectType', () => {
  const { extractSpatialHierarchy, IFC } = loadFns();
  const api = fakeApi(
    { [IFC.IFCZONE]: [40, 41] },
    { 40: { Name: 'Fire Compartment 1', ObjectType: 'Fire' }, 41: {} },
  );
  const h = extractSpatialHierarchy(api, 0);
  assert.equal(h.zones.length, 2);
  assert.equal(h.zones[0].name, 'Fire Compartment 1');
  assert.equal(h.zones[0].objectType, 'Fire');
  assert.equal(h.zones[0]._hasName, true);
  assert.equal(h.zones[1].name, 'IfcZone');
  assert.equal(h.zones[1]._hasName, false);
});

test('extractSpatialHierarchy: a model with no zones returns an empty zones array, not undefined', () => {
  const { extractSpatialHierarchy } = loadFns();
  const api = fakeApi({}, {});
  const h = extractSpatialHierarchy(api, 0);
  assert.deepEqual(h.zones, []);
});

// The parts of an aggregate element (IfcRoof -> IfcSlab, IfcStair -> flights
// and landings, nested assemblies) and elements contained in an IfcSpace get
// the storey of the element / space above them; they used to land in
// "(No storey)". Direct containment wins; site / building level stays none.
test('extractStoreys: aggregate parts and space contents inherit the storey above them', () => {
  const { extractStoreys, IFC } = loadFns();
  const ref = (v) => ({ value: v });
  const api = fakeApi(
    { [IFC.IFCBUILDINGSTOREY]: [1, 2], [IFC.IFCRELCONTAINEDINSPATIALSTRUCTURE]: [100, 101, 102, 103], [IFC.IFCRELAGGREGATES]: [201, 200, 202, 203, 204, 205] },
    {
      1: { Name: 'L0', Elevation: 0 }, 2: { Name: 'L1', Elevation: 3 },
      100: { RelatingStructure: ref(2), RelatedElements: [ref(10), ref(20), ref(33)] }, // roof 10, stair 20 and part 33 on L1
      101: { RelatingStructure: ref(50), RelatedElements: [ref(60)] },                 // furniture 60 in space 50
      102: { RelatingStructure: ref(90), RelatedElements: [ref(70)] },                 // 70 contained in the building
      103: { RelatingStructure: ref(1), RelatedElements: [ref(34)] },                  // 34 contained in L0 directly
      200: { RelatingObject: ref(10), RelatedObjects: [ref(11), ref(12)] },            // roof slabs
      201: { RelatingObject: ref(20), RelatedObjects: [ref(21), ref(22)] },            // stair flight + landing (rel listed first)
      202: { RelatingObject: ref(22), RelatedObjects: [ref(23)] },                     // a part of a part
      203: { RelatingObject: ref(1), RelatedObjects: [ref(50)] },                      // space 50 in L0
      204: { RelatingObject: ref(30), RelatedObjects: [ref(31), ref(34)] },            // assembly 30 nowhere; 34 contained in L0 wins
      205: { RelatingObject: ref(40), RelatedObjects: [ref(41)] },                     // cycle 40 <-> 41, no storey
      // a malformed cycle must not hang
    },
  );
  api.GetLineIDsWithType = ((orig) => (m, t) => (t === IFC.IFCRELAGGREGATES ? { size: () => 7, get: (i) => [201, 200, 202, 203, 204, 205, 206][i] } : orig(m, t)))(api.GetLineIDsWithType);
  const lines = { 206: { RelatingObject: ref(41), RelatedObjects: [ref(40)] } };
  const getLine = api.GetLine; api.GetLine = (m, id) => lines[id] || getLine(m, id);
  const { map } = extractStoreys(api, 0);
  assert.equal(map[11], 'L1'); assert.equal(map[12], 'L1');
  assert.equal(map[21], 'L1'); assert.equal(map[22], 'L1'); assert.equal(map[23], 'L1', 'parts of parts too, whatever the relation order');
  assert.equal(map[33], 'L1', 'direct containment kept');
  assert.equal(map[50], 'L0', 'rooms aggregated into their storey');
  assert.equal(map[60], 'L0', 'contents of a space');
  assert.equal(map[34], 'L0', 'direct containment wins over the parent');
  assert.equal(map[70], undefined, 'contained in the building: no storey');
  assert.equal(map[31], undefined, 'an assembly with no storey gives none');
  assert.equal(map[40], undefined); assert.equal(map[41], undefined);
});
