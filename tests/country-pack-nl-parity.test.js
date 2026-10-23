'use strict';
// Country-pack migration parity: the Dutch rule data (ILS v2 / NL-SfB, RVB BIM
// Norm, accessibility thresholds and space-role words) moved out of the addons
// into regulations/nl.json. With the nl pack registered and active, every
// engine must produce EXACTLY what the built-in Dutch engines produced before
// the move. The golden file was captured from the pre-migration engines on the
// synthetic corpus below (CC_UPDATE_GOLDEN=1 rewrites it — only ever do that
// against the pre-migration code).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { countryWindow, loadAddon } = require('./_country-pack.js');

const GOLDEN = path.join(__dirname, 'fixtures', 'country-pack-nl-parity.golden.json');

// ── Minimal THREE stand-in for accessibility.js's bounding-box helper ──────
function V(x, y, z) { return { x, y, z, clone() { return V(this.x, this.y, this.z); } }; }
function Box3() { this.min = V(Infinity, Infinity, Infinity); this.max = V(-Infinity, -Infinity, -Infinity); }
Box3.prototype.setFromObject = function (m) { this.min = V(...m._min); this.max = V(...m._max); return this; };
Box3.prototype.isEmpty = function () { return this.max.x < this.min.x; };
Box3.prototype.copy = function (b) { this.min = b.min.clone(); this.max = b.max.clone(); return this; };
Box3.prototype.union = function (b) {
  this.min = V(Math.min(this.min.x, b.min.x), Math.min(this.min.y, b.min.y), Math.min(this.min.z, b.min.z));
  this.max = V(Math.max(this.max.x, b.max.x), Math.max(this.max.y, b.max.y), Math.max(this.max.z, b.max.z));
  return this;
};
Box3.prototype.getSize = function () { return V(this.max.x - this.min.x, this.max.y - this.min.y, this.max.z - this.min.z); };
const THREE = { Box3, Vector3: function () { return V(0, 0, 0); } };
function mesh(sx, sy, sz) { return { geometry: {}, _min: [0, 0, 0], _max: [sx, sy, sz], updateWorldMatrix() {} }; }

// ── Deterministic synthetic corpus covering every rule branch ─────────────
function corpus() {
  const els = [];
  let id = 1;
  function add(modelId, props, meshes) {
    const el = { expressId: id, _modelId: modelId, props: Object.assign({ globalId: 'G' + id }, props), meshes: meshes || [] };
    id++; els.push(el); return el;
  }
  const storeyNames = ['00 Begane grond', '-01 Kelder', 'Level 1', '', '01', '1e verdieping'];
  storeyNames.forEach((n) => add('m1', { ifcType: 'IfcBuildingStorey', name: n }));
  const spaces = [
    { name: 'Gang 1', longName: 'Gang', objectType: 'Verkeersruimte', psets: { Pset_SpaceCommon: { IsExternal: 'false' } },
      quantities: { NetFloorArea: 12, GrossFloorArea: 13, Height: 2.6 }, box: [1.1, 2.6, 6] },
    { name: 'Corridor B', box: [2.4, 2.6, 9], quantities: { 'Net Floor Area': 20 } },
    { name: 'Toilet mindervalide', longName: 'WC', objectType: 'Sanitair', quantities: { netarea: 4, 'gross floor area': 5, FinishCeilingHeight: 2.4 }, box: [1.6, 2.4, 2.2] },
    { name: 'Hal', objectType: 'Entree', box: [3, 2.6, 3] },
    { name: 'Hallway', box: [1.0, 2.6, 7] },
    { name: 'WC', box: [1.2, 2.4, 1.4] },
    { name: 'Office', box: [5, 2.6, 5], psets: { Pset_SpaceCommon: { IsExternal: 'true' } } },
    { name: 'Badkamer', box: [1.4, 2.4, 2.0] },
    { name: 'Escape route', box: [1.3, 2.6, 12] },
    { name: 'Accessible bathroom', box: [1.55, 2.4, 1.9] },
    { name: '', objectType: 'Vluchtroute', box: [1.25, 2.6, 8] },
    { name: 'Restroom', box: [1.5, 2.4, 1.5] }
  ];
  spaces.forEach((s) => add('m1', { ifcType: 'IfcSpace', name: s.name, longName: s.longName, objectType: s.objectType,
    psets: s.psets || {}, quantities: s.quantities || {}, storey: '00 Begane grond' }, [mesh(s.box[0], s.box[1], s.box[2])]));
  const fire = ['60', 'REI 90', 'EI-30', 'abc', '45', 'R120', null];
  const mats = ['Beton C30/37', 'Gipsblokken', 'Kalkzandsteen', 'masonry brick', 'Hout', '', 'Steel S235'];
  const codes = ['21.12', '22', 'XX', '(23)', '21', null, '28.1', '2'];
  for (let i = 0; i < 28; i++) {
    const ps = { Pset_WallCommon: {} };
    if (fire[i % fire.length]) ps.Pset_WallCommon.FireRating = fire[i % fire.length];
    if (i % 3 === 0) ps.Pset_WallCommon.LoadBearing = i % 2 ? 'TRUE' : 'true';
    if (i % 4 === 0) ps.Pset_WallCommon.IsExternal = 'true';
    if (i % 8 === 0) ps.Pset_WallCommon.ThermalTransmittance = '0.2';
    if (i % 5 === 0) ps.Pset_WallCommon.AcousticRating = '45';
    const code = codes[i % codes.length];
    if (code && i % 2) ps['NL-SfB'] = { Code: code };
    else if (code) ps.Pset_Classification = { 'NL/SfB': code };
    add(i < 20 ? 'm1' : 'm2', { ifcType: i % 6 === 5 ? 'IfcWallStandardCase' : 'IfcWall', name: i % 7 === 6 ? '' : 'Wand ' + i,
      description: i % 3 ? 'Binnenwand' : ('Wand ' + i), material: mats[i % mats.length], storey: i % 9 ? '00 Begane grond' : '',
      objectType: i % 5 === 4 ? '21 Buitenwand' : (i % 5 === 3 ? 'Type (22)' : ''), psets: ps,
      quantities: i % 2 ? { Width: 0.2 } : {} });
  }
  const doorNames = ['D-001', 'D001', 'Deur 3', '', 'D_12', 'door 5', 'D-1', 'D 0042'];
  doorNames.forEach((n, i) => add('m1', { ifcType: i % 3 === 2 ? 'IfcDoorStandardCase' : 'IfcDoor', name: n,
    objectType: i % 2 ? '(32) Buitendeur' : 'Binnendeur', material: 'Hout', storey: '00 Begane grond',
    psets: { Pset_DoorCommon: Object.assign({ IsExternal: i % 2 ? 'true' : 'false' }, i % 3 ? { FireRating: '30' } : {}) },
    quantities: i === 0 ? { ClearWidth: 0.93 } : i === 1 ? { Width: 0.8, ThresholdHeight: 0.03 } : i === 2 ? { OverallWidth: 0.85, StepHeight: -0.015 } : {} },
    [mesh(i % 2 ? 0.9 : 0.78, 2.1, 0.1)]));
  [[6, 0.5, 1.2], [12, 1.0, 1.5], [3, 0.4, 1.2]].forEach((b, i) => add('m1', { ifcType: i === 1 ? 'IfcRampFlight' : 'IfcRamp', name: 'Helling ' + i },
    [mesh(b[0], b[1], b[2])]));
  const renov = ['Nieuw', 'bestaand', 'foo', null, 'te slopen', 'Existing', 'to be demolished', 'Gepland', null, 'Retained'];
  ['IfcPipeSegment', 'IfcDuctSegment', 'IfcCableCarrierSegment', 'IfcFlowSegment', 'IfcPipeFitting', 'IfcCableSegment', 'IfcDuctFitting', 'IfcPipeSegment', 'IfcDuctSegment', 'IfcPipeSegment'].forEach((t, i) => {
    const ps = {};
    if (renov[i]) ps[i % 2 ? 'Pset_ManufacturerTypeInformation' : 'Pset_Status'] = i % 3 ? { RenovationStatus: renov[i] } : { Status: renov[i] };
    if (i % 2) ps.Classificatie = { NLSfB: i % 4 === 1 ? '52.10' : '57' };
    add('m2', { ifcType: t, name: t + ' ' + i, description: 'leiding', material: 'PVC', storey: 'Level 1', objectType: 'Systeem', psets: ps });
  });
  ['IfcSlab', 'IfcRoof', 'IfcColumn', 'IfcBeam', 'IfcMember', 'IfcWindow', 'IfcStair', 'IfcCovering', 'IfcCurtainWall', 'IfcFurnishingElement',
    'IfcBuildingElementProxy', 'IfcFooting', 'IfcLightFixture', 'IfcSanitaryTerminal', 'IfcRailing', 'IfcPlate', 'IfcFlowTerminal', 'IfcOutlet'].forEach((t, i) => {
    const ps = {};
    if (i % 2) ps.Pset_Common = { IsExternal: 'false', LoadBearing: 'true', FireRating: '60', ThermalTransmittance: '1.1', AcousticRating: 'x' };
    if (i % 3 === 0) ps.Pset_Classification = { ClassificationCode: ['23', '27', '28', '28', '28', '31', '24', '43', '21', '90', '--', '16', '63', '53', '34', '28', '57', '62'][i] };
    add(i % 2 ? 'm1' : 'm2', { ifcType: t, name: i % 4 === 3 ? '123' : t.replace('Ifc', '') + ' ' + i, description: i % 2 ? 'x' : '',
      material: i % 3 ? 'Beton' : '', storey: i % 5 ? 'Level 1' : '', objectType: i % 4 ? '(' + (20 + i) + ') type' : '', psets: ps });
  });
  return els;
}

function models(els) {
  const byModel = (mid) => els.filter((e) => e._modelId === mid);
  return [
    { id: 'm1', name: 'Bouwkundig', elements: byModel('m1'),
      spatialHierarchy: { project: { name: 'P', _hasName: true },
        sites: [{ name: 'Terrein', _hasName: true, georef: { refLat: 52.1, refLon: 5.1, refElev: 1.2 } }, { name: 'IfcSite', _hasName: false }],
        buildings: [{ name: 'Gebouw A', _hasName: true }, { name: 'IfcBuilding', _hasName: false }],
        zones: [{ name: 'BC1', objectType: 'Brandcompartiment', _hasName: true }, { name: 'IfcZone', objectType: '', _hasName: false }] },
      storeyData: [{ name: '00 Begane grond', hasElevation: true }, { name: '01', hasElevation: false }] },
    { id: 'm2', name: 'Installaties', elements: byModel('m2'),
      spatialHierarchy: { project: { name: 'IfcProject', _hasName: false }, sites: [{ name: 'S', _hasName: true, georef: { refLat: 52, refLon: null, refElev: null } }],
        buildings: [], zones: [] }, storeyData: [{ name: 'Level 1', hasElevation: true }] },
    { id: 'm3', name: 'Leeg' }
  ];
}

// Elements are referenced from results by identity; serialize them as ids.
function plain(v) {
  return JSON.parse(JSON.stringify(v, function (k, x) {
    if (k === 'el' && x && typeof x === 'object' && x.expressId != null) return { $el: x._modelId + ':' + x.expressId };
    if (k === 'at') return undefined;
    return x;
  }));
}

// The generic standards engine names the classification distribution
// `_classDist`; the pre-migration ILS engine called it `_nlsfbDist`.
function ilsShape(res) {
  const out = Object.assign({}, res);
  if ('_classDist' in out) { out._nlsfbDist = out._classDist; delete out._classDist; }
  return out;
}

function run(window, els, mods) {
  const out = {};
  out.ils = plain(ilsShape(window._ccRunStandard('ils', els)));
  out.ilsSubset = plain(ilsShape(window._ccRunStandard('nl:ils', els.slice(0, 20))));
  out.rvb = plain(window._ccRunStandard('rvb', mods));
  out.rvbEmpty = plain(window._ccRunStandard('nl:rvb', []));
  out.accessibility = plain(window._ccRunAccessibilityChecks(els));
  out.accessibilityOverride = plain(window._ccRunAccessibilityChecks(els, { thresholds: { doorClearWidth: 0.9 } }));
  out.score = plain(window._ccComputeQualityScore(els, mods, { force: true }));
  // Adoption gate: every element carries an NL-SfB code -> ILS folds into the score.
  const adopted = els.filter((e) => e.props.ifcType === 'IfcWall').map((e) => Object.assign({}, e, {
    props: Object.assign({}, e.props, { psets: { 'NL-SfB': { Code: '21' } } }) }));
  out.scoreAdopted = plain(window._ccComputeQualityScore(adopted, [{ id: 'mx', elements: adopted }], { force: true }));
  // No NL-SfB anywhere -> ILS is shown but stays out of the headline score.
  const bare = els.filter((e) => !/Storey|Space/.test(e.props.ifcType)).map((e) => Object.assign({}, e, { props: Object.assign({}, e.props, { psets: {}, objectType: '' }) }));
  out.scoreNotAdopted = plain(window._ccComputeQualityScore(bare, [{ id: 'my', elements: bare }], { force: true }));
  return out;
}

function engines() {
  const window = countryWindow({ regions: ['nl'], active: 'nl', window: { THREE } });
  loadAddon('data-quality.js', window);
  loadAddon('accessibility.js', window);
  return window;
}

test('nl pack: ILS / RVB / accessibility / quality score identical to the pre-migration engines', () => {
  const els = corpus();
  const mods = models(els);
  const now = run(engines(), els, mods);
  if (process.env.CC_UPDATE_GOLDEN === '1') {
    fs.writeFileSync(GOLDEN, JSON.stringify(now, null, 1) + '\n');
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  Object.keys(golden).forEach((k) => assert.deepStrictEqual(now[k], golden[k], k + ' differs from the pre-migration output'));
  assert.deepStrictEqual(Object.keys(now).sort(), Object.keys(golden).sort());
});

test('the corpus exercises every reported ILS / RVB / accessibility check', () => {
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  Object.keys(golden.ils).filter((k) => k[0] !== '_').forEach((k) => assert.ok(golden.ils[k].count > 0, 'ILS check ' + k + ' never fires'));
  Object.keys(golden.rvb).filter((k) => k[0] !== '_').forEach((k) => assert.ok(golden.rvb[k].count > 0, 'RVB check ' + k + ' never fires'));
  Object.keys(golden.accessibility.groups).forEach((k) => {
    const g = golden.accessibility.groups[k];
    assert.ok(g.fail > 0 && g.fail < g.total, 'accessibility ' + k + ' needs both passes and fails');
  });
  const ilsCat = golden.scoreNotAdopted.breakdown.categories.find((c) => c.label === 'ILS / NL-SfB');
  assert.equal(ilsCat.countsTowardScore, false);
  assert.equal(golden.scoreAdopted.breakdown.categories.find((c) => c.label === 'ILS / NL-SfB').countsTowardScore, true);
});

module.exports = { corpus, models, THREE };
