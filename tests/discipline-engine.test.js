'use strict';
// Sub-disciplines, provenance, roles, pack-driven hints / classification
// tables and the sub-discipline-aware clash matrix (clash-discipline-core.js
// contract v2). The language- and country-specific knowledge is DATA: the
// Dutch tokens come from locales/nl.json, NL-SfB from regulations/nl.json, a
// German hint pack from a test fixture — registered here exactly the way the
// loaders register them in the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../clash-discipline-core');
const nlLocale = require('../locales/nl.json');
const nlCountry = require('../regulations/nl.json');
const deFixture = require('./fixtures/locale-de-hints.json');

function el(ifcType, props) { return { props: Object.assign({ ifcType: ifcType }, props || {}) }; }
const T = (cls, name, predef) => ({ cls, name: name || '', predef: predef || '' });
const SYS = (name, extra) => Object.assign({ cls: 'IfcSystem', name, objectType: '', predef: '' }, extra || {});
const REF = (sys, code) => ({ sys, code, name: '' });

test('built-in hints are English only; Dutch and NL-SfB are not hard-coded', () => {
  const flat = JSON.stringify(core.defaultHints).toLowerCase();
  for (const nl of ['bouwkundig', 'installatie', 'constructie', 'sanitair', 'elektra', 'terrein', 'sparing', 'brandcompartiment']) {
    assert.ok(!flat.includes(nl), nl + ' must live in locales/nl.json, not in code');
  }
  assert.deepEqual(core.classificationTables(), [], 'no classification table before a country pack registers one');
  // Without the Dutch pack a Dutch file name says nothing.
  assert.equal(core.detectDiscipline([], 'Constructie model'), 'architectural');
});

test('registering packs: every source applies, malformed hints are refused', () => {
  assert.equal(core.registerHints('locale:nl', nlLocale.disciplineHints), true);
  assert.equal(core.registerHints('locale:bad', { subDisciplines: { teleportation: ['x'] } }), false);
  assert.equal(core.registerHints('locale:bad2', { roles: { provision: ['<script>'] } }), false);
  assert.ok(core.hintSources().includes('locale:nl'));
  assert.ok(!core.hintSources().includes('locale:bad'));
  nlCountry.classifications.forEach((t) => assert.equal(core.registerClassificationTable(t), true));
  assert.equal(core.registerClassificationTable({ id: 'x', name: 'X', source: 's', map: { 1: 'mep.teleport' } }), false);
  assert.equal(core.registerClassificationTable({ id: 'y', name: 'Y', source: 's', codePattern: '(a+)+$', map: { 1: 'mep' } }), false, 'nested quantifiers rejected');
  assert.deepEqual(core.classificationTables().map((t) => t.name), ['NL-SfB']);
  assert.equal(core.detectDiscipline([], 'Constructie model'), 'structural');
});

test('a non-active locale pack still teaches the engine (German model, Dutch UI)', () => {
  // The app registers EVERY pack carrying disciplineHints, whatever the UI
  // language; the German fixture is "installed" next to the Dutch pack.
  const before = core.classifyElement(el('IfcBuildingElementProxy', { name: 'Brandabschnitt EG' }), { modelDisc: 'architectural' });
  assert.equal(before.role, null);
  assert.equal(core.registerHints('locale:de', deFixture.disciplineHints), true);
  const zone = core.classifyElement(el('IfcBuildingElementProxy', { name: 'Brandabschnitt EG' }), { modelDisc: 'architectural' });
  assert.equal(zone.role, 'zone');
  assert.equal(zone.roleSrc, 'name');
  const duct = core.classifyElement(el('IfcFlowSegment', { groups: [SYS('Zuluft 1.OG')] }), { modelDisc: 'mep' });
  assert.deepEqual([duct.d, duct.sub, duct.src, duct.stated], ['mep', 'ventilation', 'system', true]);
  assert.equal(core.detectDiscipline([], 'Projekt_Tragwerk.ifc'), 'structural');
  assert.equal(core.detectDiscipline([], 'Projekt_TGA.ifc'), 'mep');
  // Dutch still works side by side.
  assert.equal(core.classifyElement(el('IfcBuildingElementProxy', { name: 'Sparing 300x300' }), {}).role, 'provision');
});

test('hint matching: word prefix, not substring; multi-word tokens as substrings; Unicode words', () => {
  assert.deepEqual(core.matchHint('Supply air duct', 'subDisciplines').key, 'ventilation');
  assert.deepEqual(core.matchHint('Domestic hot water', 'subDisciplines').key, 'plumbing', 'more plumbing tokens than heating');
  assert.deepEqual(core.matchHint('Chilled water', 'subDisciplines').key, 'heating', 'tie → heating ranks before plumbing');
  assert.equal(core.matchHint('Lüftung Abluft', 'subDisciplines').key, 'ventilation');
  assert.equal(core.matchHint('mark-revision', 'disciplines'), null, '"mark" is not the "ark" prefix');
});

test('IFC2X3 MEP export: generic IfcFlowSegment resolved by its type object (inferred)', () => {
  const duct = core.classifyElement(el('IfcFlowSegment', { typeObject: T('IfcDuctSegmentType', 'Rect') }), { modelDisc: 'mep' });
  assert.deepEqual([duct.d, duct.sub, duct.src, duct.stated], ['mep', 'ventilation', 'type-object', false]);
  const tray = core.classifyElement(el('IfcFlowSegment', { typeObject: T('IFCCABLECARRIERSEGMENTTYPE') }), { modelDisc: 'mep' });
  assert.equal(tray.sub, 'electrical', 'upper-case STEP class names are canonicalised');
  const wc = core.classifyElement(el('IfcFlowTerminal', { typeObject: T('IfcSanitaryTerminalType') }), {});
  assert.equal(wc.sub, 'plumbing');
  const pipe = core.classifyElement(el('IfcFlowSegment', { typeObject: T('IfcPipeSegmentType') }), { modelDisc: 'mep' });
  assert.deepEqual([pipe.sub, pipe.src], ['piping', 'type-object'], 'a pipe without a system is piping (trade unknown)');
});

test('stated beats inferred: the system decides which trade a pipe belongs to', () => {
  const heat = core.classifyElement(el('IfcFlowSegment', { typeObject: T('IfcPipeSegmentType'), groups: [SYS('(56.31 LT-R) retour 117')] }), {});
  assert.deepEqual([heat.sub, heat.src, heat.stated], ['heating', 'system', true]);
  assert.match(heat.ev, /NL-SfB 56\.31/);
  const sprinkler = core.classifyElement(el('IfcFlowSegment', { typeObject: T('IfcPipeSegmentType'), groups: [SYS('(53.72) water, brand, droog')] }), {});
  assert.equal(sprinkler.sub, 'fire');
  const ifc4 = core.classifyElement(el('IfcPipeSegment', { groups: [SYS('', { cls: 'IfcDistributionSystem', predef: 'DOMESTICCOLDWATER' })] }), {});
  assert.deepEqual([ifc4.sub, ifc4.src], ['plumbing', 'system']);
  // A system whose name says nothing still states "MEP" for a proxy.
  const proxy = core.classifyElement(el('IfcBuildingElementProxy', { groups: [SYS('S-01')] }), { modelDisc: 'architectural' });
  assert.equal(proxy.d, 'mep');
});

test('classification codes: by declared system, by code format, and inside parentheses', () => {
  assert.deepEqual(core.lookupClassification(REF('NL-SfB', '57.51')).target, { d: 'mep', sub: 'ventilation' });
  // Revit writes NL-SfB codes under a "Uniformat" source — the code format decides.
  const misLabelled = core.lookupClassification(REF('Uniformat', '61.30'));
  assert.equal(misLabelled.by, 'code-format');
  assert.deepEqual(misLabelled.target, { d: 'mep', sub: 'electrical' });
  assert.equal(core.lookupClassification(REF('Uniformat', 'D2040')), null, 'a real Uniformat code is not mistaken for NL-SfB');
  assert.equal(core.lookupClassification(REF('', '3A(57)')).target.sub, 'ventilation');
  assert.equal(core.lookupClassification(REF('', '65.11')).target.sub, 'fire', 'longest prefix wins (65.1 over 65)');
  assert.equal(core.lookupClassification(REF('', '28.11')), null, 'non-MEP codes are not mapped');
});

test('a model with no names at all: stated + type evidence only', () => {
  const els = [
    el('IfcFlowSegment', { typeObject: T('IfcDuctSegmentType'), classification: [REF('NL-SfB', '57.50')] }),
    el('IfcFlowSegment', { typeObject: T('IfcDuctSegmentType'), classification: [REF('NL-SfB', '57.50')] }),
    el('IfcFlowFitting', { typeObject: T('IfcDuctFittingType'), classification: [REF('NL-SfB', '57.50')] }),
    el('IfcFlowTerminal', { typeObject: T('IfcAirTerminalType') }),
    el('IfcFlowSegment', {}),
    el('IfcBuildingElementProxy', {}),
  ];
  const info = core.classifyModel(els, '');
  assert.equal(info.discipline, 'mep');
  assert.equal(info.src, 'stated');
  assert.equal(info.sub, 'ventilation');
  assert.equal(info.key, 'mep.ventilation');
  assert.deepEqual([els[0]._ccCls.sub, els[0]._ccCls.src], ['ventilation', 'classification']);
  assert.deepEqual([els[3]._ccCls.sub, els[3]._ccCls.src], ['ventilation', 'type-object']);
  assert.deepEqual([els[4]._ccCls.sub, els[4]._ccCls.src], ['ventilation', 'model'], 'unresolved MEP takes the model majority');
  assert.ok(info.shares.stated > 0.4 && info.shares.inferred > 0 && info.shares.model > 0);
});

test('roles: stated provision, name hints only on proxy-like classes, model majority', () => {
  const p = core.classifyElement(el('IfcBuildingElementProxy', { predefinedType: 'PROVISIONFORVOID' }), {});
  assert.deepEqual([p.role, p.roleSrc], ['provision', 'predefined-type']);
  const viaType = core.classifyElement(el('IfcBuildingElementProxy', { typeObject: T('IfcBuildingElementProxyType', '', 'PROVISIONFORVOID') }), {});
  assert.equal(viaType.role, 'provision');
  assert.equal(core.classifyElement(el('IfcWall', { name: 'Sparing wand' }), {}).role, null, 'a wall named "sparing" is still a wall');
  assert.equal(core.classifyElement(el('IfcSpatialZone', {}), {}).role, 'zone');
  assert.equal(core.classifyElement(el('IfcBuildingElementProxy', { groups: [{ cls: 'IfcZone', name: 'BC-1', objectType: '', predef: '' }] }), {}).role, 'zone');
  const model = [1, 2, 3, 4].map(() => el('IfcBuildingElementProxy', { predefinedType: 'PROVISIONFORVOID' })).concat([el('IfcBuildingElementProxy', {})]);
  const info = core.classifyModel(model, 'openings');
  assert.equal(info.role, 'provision');
  assert.deepEqual([model[4]._ccCls.role, model[4]._ccCls.roleSrc], ['provision', 'model']);
  // Role elements do not vote on the model's discipline.
  const fire = [1, 2, 3, 4, 5].map(() => el('IfcBuildingElementProxy', { name: 'Brandcompartiment', classification: [REF('Uniformat', '65.10')] }));
  assert.notEqual(core.classifyModel(fire, 'x').discipline, 'mep');
});

test('matrix: cross-trade MEP on, same trade off, unresolved MEP stays legacy', () => {
  const R = { excludeSameDiscipline: true };
  assert.equal(core.disciplinePairEnabled('mep.ventilation', 'mep.plumbing', R), true);
  assert.equal(core.disciplinePairEnabled('mep.electrical', 'mep.fire', R), true);
  assert.equal(core.disciplinePairEnabled('mep.heating', 'mep.plumbing', R), true);
  assert.equal(core.disciplinePairEnabled('mep.ventilation', 'mep.ventilation', R), false);
  assert.equal(core.disciplinePairEnabled('mep.piping', 'mep.heating', R), false, 'an unknown pipe may be the same trade');
  assert.equal(core.disciplinePairEnabled('mep.piping', 'mep.ventilation', R), true);
  assert.equal(core.disciplinePairEnabled('mep', 'mep.ventilation', R), false);
  assert.equal(core.disciplinePairEnabled('structural', 'mep.ventilation', R), true);
  assert.equal(core.disciplinePairEnabled('mep.ventilation', 'mep.plumbing', { excludeSameDiscipline: false }), true);
  // Saved overrides keep precedence: exact trade cell, then the MEP cell.
  assert.equal(core.disciplinePairEnabled('mep.plumbing', 'mep.ventilation', { disciplineMatrix: { 'mep:mep': false } }), false);
  assert.equal(core.disciplinePairEnabled('mep.plumbing', 'mep.ventilation', { disciplineMatrix: { 'mep:mep': false, 'mep.plumbing:mep.ventilation': true } }), true);
  assert.equal(core.disciplinePairEnabled('mep.ventilation', 'structural', { disciplineMatrix: { 'mep:structural': false } }), false);
});

test('matrixSkipsSameDiscipline uses element keys; model-derived discipline follows a user re-label', () => {
  const mA = { id: 'a', discipline: 'mep' }, mB = { id: 'b', discipline: 'mep' };
  const duct = el('IfcFlowSegment', { typeObject: T('IfcDuctSegmentType') });
  const drain = el('IfcFlowSegment', { typeObject: T('IfcPipeSegmentType'), groups: [SYS('Sewage')] });
  const duct2 = el('IfcFlowSegment', { typeObject: T('IfcDuctSegmentType') });
  core.classifyModel([duct], 'a'); core.classifyModel([drain], 'b'); core.classifyModel([duct2], 'c');
  assert.equal(core.matrixSkipsSameDiscipline(duct, mA, drain, mB, false, { excludeSameDiscipline: true }), false);
  assert.equal(core.matrixSkipsSameDiscipline(duct, mA, duct2, mB, false, { excludeSameDiscipline: true }), true);
  assert.equal(core.matrixSkipsSameDiscipline(duct, mA, duct2, mA, true, { excludeSameDiscipline: true }), false, 'same model never skipped');
  // A wall in a model classified architectural, re-labelled structural by the user.
  const wall = el('IfcWall', {});
  core.classifyModel([wall, el('IfcDoor'), el('IfcDoor'), el('IfcDoor'), el('IfcDoor')], 'x');
  assert.equal(wall._ccCls.dm, true);
  assert.equal(core.elementDiscipline(wall, 'structural'), 'structural');
  assert.equal(core.elementMatrixKey(wall, 'structural'), 'structural');
});

test('classifyModel: stated MEP majority beats the file name; signature tracks data version', () => {
  const els = [1, 2, 3, 4, 5, 6].map(() => el('IfcBuildingElementProxy', { classification: [REF('Uniformat', '61.50')] }));
  const info = core.classifyModel(els, 'arch-model.ifc');
  assert.equal(info.discipline, 'mep');
  assert.equal(info.src, 'stated');
  assert.equal(info.key, 'mep.electrical');
  const sig1 = info.sig;
  core.registerHints('locale:extra', { subDisciplines: { electrical: ['zzz'] } });
  assert.notEqual(core.classifyModel(els, 'arch-model.ifc').sig, sig1, 'new pack data changes the signature (smart re-run must not reuse results)');
});

// ── Federation role suggestions (pre-run "smart suggestions") ──
function bx(min, max) { return { min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } }; }
function E(id, ifcType, box, props) { return { expressId: id, box: bx(box[0], box[1]), props: Object.assign({ ifcType }, props || {}) }; }

test('suggestRoles: geometry finds provisions and compartment markers on unnamed proxies; equipment is never suggested', () => {
  const struct = { id: 's', discipline: 'structural', elements: [
    E(1, 'IfcSlab', [[0, 0, 3], [20, 10, 3.3]]),
    E(2, 'IfcBuildingElementProxy', [[9, 6.5, 1.9], [13, 8.5, 2.5]]),            // crossed by 3 trades
    E(3, 'IfcBuildingElementProxy', [[30, 30, 0], [31, 31, 1]]),                 // touches nothing
  ] };
  const mep = { id: 'm', discipline: 'mep', elements: [
    E(10, 'IfcDuctSegment', [[1, 7.5, 2.0], [19, 8.0, 2.4]], { groups: [SYS('Supply air')] }),
    E(11, 'IfcPipeSegment', [[9.95, 6, 2.15], [10.05, 9, 2.25]], { groups: [SYS('Sewage')] }),
    E(12, 'IfcCableCarrierSegment', [[12, 6, 2.1], [12.3, 9, 2.2]], { groups: [SYS('Power')] }),
    E(13, 'IfcBuildingElementProxy', [[15, 7.3, 1.8], [16, 8.2, 2.6]], { name: 'Fan unit', groups: [SYS('Supply air')] }),
  ] };
  const arch = { id: 'a', discipline: 'architectural', elements: [E(20, 'IfcWall', [[32, 0, 0], [38, 0.25, 3]])] };
  const marker = { id: 'z', discipline: 'architectural', elements: [
    E(30, 'IfcBuildingElementProxy', [[33, 0.0625, 0.25], [36, 0.125, 2.75]]),
    E(31, 'IfcColumn', [[1, 1, 0], [1.3, 1.3, 3]]),
    E(32, 'IfcColumn', [[1, 1, 0], [1.3, 1.3, 3]], { name: 'C1' }),
  ] };
  const dup = { id: 'd', discipline: 'structural', elements: [E(40, 'IfcColumn', [[1, 1, 0], [1.3, 1.3, 3]])] };
  const models = [struct, mep, arch, marker, dup];
  models.forEach((m) => core.classifyModel(m.elements, m.id));
  const idx = core.suggestRoles(models);
  const g = (m, i) => idx.byEl.get(m.elements[i]);
  assert.deepEqual([g(struct, 1).group, g(struct, 1).src, g(struct, 1).conf], ['provision', 'geometry', 'medium']);
  assert.deepEqual([g(struct, 2).group, g(struct, 2).conf], ['proxy', 'low'], 'unclassified, low confidence');
  assert.equal(g(mep, 3), undefined, 'a proxy in a supply-air system is real equipment');
  assert.deepEqual([g(marker, 0).group, g(marker, 0).src], ['zone', 'geometry']);
  assert.equal(g(dup, 0).group, 'duplicate');
  assert.equal(g(struct, 0), undefined);
  assert.ok(idx.sig && idx.groups.provision.n === 1 && idx.groups.zone.n === 1);
});

test('suggestRoles: stated roles are high confidence; spaces are a group; choices and defaults', () => {
  const m = { id: 'x', discipline: 'architectural', elements: [
    E(1, 'IfcBuildingElementProxy', [[0, 0, 0], [1, 1, 1]], { predefinedType: 'PROVISIONFORVOID' }),
    E(2, 'IfcSpace', [[0, 0, 0], [5, 5, 3]]),
  ] };
  core.classifyModel(m.elements, 'x');
  const idx = core.suggestRoles([m]);
  assert.deepEqual([idx.byEl.get(m.elements[0]).group, idx.byEl.get(m.elements[0]).conf], ['provision', 'high']);
  assert.equal(idx.byEl.get(m.elements[1]).group, 'space');
  assert.equal(core.roleChoice('provision', {}), 'classify');
  assert.equal(core.roleChoice('zone', {}), 'classify');
  assert.equal(core.roleChoice('duplicate', {}), 'include');
  assert.equal(core.roleChoice('proxy', {}), 'include');
  assert.equal(core.roleChoice('space', {}), 'exclude');
  assert.equal(core.roleChoice('space', { includeSpaces: true }), 'include');
  assert.equal(core.roleChoice('zone', { roleChoices: { zone: 'exclude' } }), 'exclude');
  assert.equal(core.roleChoice('zone', { roleChoices: { zone: 'bogus' } }), 'classify');
});
