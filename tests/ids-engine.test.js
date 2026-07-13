'use strict';
// Locks the IDS 1.0 parse + execution engine in addons/data-quality.js
// (window._ccParseIDS / window._ccRunIDS). Covers the facet semantics that
// differ from the legacy regex engine: exact entity matching (no substring),
// XSD pattern anchoring, enumeration/bounds restrictions, requirement
// cardinality (required/optional/prohibited), spec cardinality, and the
// "not checkable" honesty rule for things the browser data model lacks.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function loadEngine() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'addons', 'data-quality.js'), 'utf8');
  const window = {};
  new Function('window', src)(window);
  assert.equal(typeof window._ccParseIDS, 'function');
  assert.equal(typeof window._ccRunIDS, 'function');
  return window;
}

function ids(specsXml, appAttrs) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">\n' +
    '<info><title>Test IDS</title></info>\n' +
    '<specifications>' + specsXml + '</specifications></ids>';
}

function spec(name, applicability, requirements, appAttrs) {
  return '<specification name="' + name + '" ifcVersion="IFC4">' +
    '<applicability ' + (appAttrs || 'minOccurs="0" maxOccurs="unbounded"') + '>' + applicability + '</applicability>' +
    '<requirements>' + requirements + '</requirements></specification>';
}

function el(id, props) {
  return { expressId: id, props: Object.assign({ globalId: 'G' + id, name: 'El' + id }, props) };
}

function models(elements) {
  return [{ id: 'm1', visible: true, elements }];
}

const ENT_WALL = '<entity><name><simpleValue>IFCWALL</simpleValue></name></entity>';

test('parse: info, spec attrs, cardinality derivation', () => {
  const w = loadEngine();
  const xml = ids(
    spec('Req', ENT_WALL, '<attribute><name><simpleValue>Name</simpleValue></name></attribute>', 'minOccurs="1" maxOccurs="unbounded"') +
    spec('Opt', ENT_WALL, '', 'minOccurs="0" maxOccurs="unbounded"') +
    spec('Proh', ENT_WALL, '', 'minOccurs="0" maxOccurs="0"')
  );
  const parsed = w._ccParseIDS(xml);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.title, 'Test IDS');
  assert.equal(parsed.specs.length, 3);
  assert.equal(parsed.specs[0].cardinality, 'required');
  assert.equal(parsed.specs[1].cardinality, 'optional');
  assert.equal(parsed.specs[2].cardinality, 'prohibited');
  assert.equal(parsed.specs[0].applicability[0].type, 'entity');
  assert.equal(parsed.specs[0].requirements[0].type, 'attribute');
});

test('parse: malformed XML and non-IDS root return error', () => {
  const w = loadEngine();
  assert.ok(w._ccParseIDS('<ids><unclosed').error);
  assert.ok(w._ccParseIDS('<html></html>').error);
});

test('entity matching is exact: IFCWALL does not match IfcWallStandardCase', () => {
  const w = loadEngine();
  const xml = ids(spec('S', ENT_WALL, '<attribute><name><simpleValue>Description</simpleValue></name></attribute>'));
  const parsed = w._ccParseIDS(xml);
  const r = w._ccRunIDS(parsed.specs, models([
    el(1, { ifcType: 'IfcWall', description: '' }),            // applicable, fails
    el(2, { ifcType: 'IfcWallStandardCase', description: '' }) // NOT applicable
  ]));
  assert.equal(r.summary.bySpec['S'].applicable, 1);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].elementId, 1);
});

test('attribute value with XSD pattern is anchored: 30|60 must not match 360', () => {
  const w = loadEngine();
  const xml = ids(spec('S', ENT_WALL,
    '<attribute><name><simpleValue>Name</simpleValue></name>' +
    '<value><xs:restriction base="xs:string"><xs:pattern value="30|60"/></xs:restriction></value></attribute>'));
  const parsed = w._ccParseIDS(xml);
  const r = w._ccRunIDS(parsed.specs, models([
    el(1, { ifcType: 'IfcWall', name: '360' }),
    el(2, { ifcType: 'IfcWall', name: '60' })
  ]));
  assert.equal(r.summary.fail, 1);
  assert.equal(r.summary.pass, 1);
  assert.equal(r.results[0].elementId, 1);
});

test('property: enumeration, simpleValue numeric tolerance, bounds, booleans', () => {
  const w = loadEngine();
  const xml = ids(
    spec('Enum', ENT_WALL,
      '<property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>' +
      '<baseName><simpleValue>FireRating</simpleValue></baseName>' +
      '<value><xs:restriction base="xs:string"><xs:enumeration value="30"/><xs:enumeration value="60"/></xs:restriction></value></property>') +
    spec('Num', ENT_WALL,
      '<property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>' +
      '<baseName><simpleValue>ThermalTransmittance</simpleValue></baseName>' +
      '<value><simpleValue>0.25</simpleValue></value></property>') +
    spec('Bounds', ENT_WALL,
      '<property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>' +
      '<baseName><simpleValue>AcousticRating</simpleValue></baseName>' +
      '<value><xs:restriction base="xs:double"><xs:minInclusive value="40"/><xs:maxInclusive value="60"/></xs:restriction></value></property>') +
    spec('Bool', ENT_WALL,
      '<property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>' +
      '<baseName><simpleValue>IsExternal</simpleValue></baseName>' +
      '<value><simpleValue>true</simpleValue></value></property>')
  );
  const parsed = w._ccParseIDS(xml);
  const good = el(1, { ifcType: 'IfcWall', psets: { Pset_WallCommon: {
    FireRating: '60', ThermalTransmittance: 0.2500000001, AcousticRating: '45', IsExternal: true } } });
  const bad = el(2, { ifcType: 'IfcWall', psets: { Pset_WallCommon: {
    FireRating: '90', ThermalTransmittance: '0.4', AcousticRating: '70', IsExternal: 'false' } } });
  const r = w._ccRunIDS(parsed.specs, models([good, bad]));
  assert.equal(r.summary.bySpec['Enum'].pass, 1);
  assert.equal(r.summary.bySpec['Enum'].fail, 1);
  assert.equal(r.summary.bySpec['Num'].pass, 1);
  assert.equal(r.summary.bySpec['Num'].fail, 1);
  assert.equal(r.summary.bySpec['Bounds'].pass, 1);
  assert.equal(r.summary.bySpec['Bounds'].fail, 1);
  assert.equal(r.summary.bySpec['Bool'].pass, 1);
  assert.equal(r.summary.bySpec['Bool'].fail, 1);
  assert.ok(r.results.every(row => row.elementId === 2));
});

test('requirement cardinality: prohibited and optional', () => {
  const w = loadEngine();
  const xml = ids(
    spec('NoProxyName', ENT_WALL,
      '<attribute cardinality="prohibited"><name><simpleValue>Description</simpleValue></name></attribute>') +
    spec('OptRating', ENT_WALL,
      '<property cardinality="optional"><propertySet><simpleValue>P</simpleValue></propertySet>' +
      '<baseName><simpleValue>X</simpleValue></baseName>' +
      '<value><simpleValue>ok</simpleValue></value></property>')
  );
  const parsed = w._ccParseIDS(xml);
  const r = w._ccRunIDS(parsed.specs, models([
    el(1, { ifcType: 'IfcWall', description: 'has one' }),               // prohibited → fail
    el(2, { ifcType: 'IfcWall', description: '' }),                      // prohibited → pass; optional absent → pass
    el(3, { ifcType: 'IfcWall', psets: { P: { X: 'wrong' } } }),         // optional present+wrong → fail
    el(4, { ifcType: 'IfcWall', psets: { P: { X: 'ok' } } })             // optional present+right → pass
  ]));
  assert.equal(r.summary.bySpec['NoProxyName'].fail, 1);
  assert.equal(r.summary.bySpec['NoProxyName'].pass, 3);
  assert.equal(r.summary.bySpec['OptRating'].fail, 1);
  assert.equal(r.summary.bySpec['OptRating'].pass, 3);
});

test('spec cardinality: prohibited applicability fails matching elements; required with zero applicable notes a failure', () => {
  const w = loadEngine();
  const xml = ids(
    spec('NoProxies', '<entity><name><simpleValue>IFCBUILDINGELEMENTPROXY</simpleValue></name></entity>', '', 'maxOccurs="0"') +
    spec('NeedsDoors', '<entity><name><simpleValue>IFCDOOR</simpleValue></name></entity>',
      '<attribute><name><simpleValue>Name</simpleValue></name></attribute>', 'minOccurs="1" maxOccurs="unbounded"')
  );
  const parsed = w._ccParseIDS(xml);
  const r = w._ccRunIDS(parsed.specs, models([el(1, { ifcType: 'IfcBuildingElementProxy' })]));
  assert.equal(r.summary.bySpec['NoProxies'].fail, 1);
  assert.equal(r.results[0].specName, 'NoProxies');
  assert.equal(r.summary.bySpec['NeedsDoors'].fail, 1);
  assert.match(r.summary.bySpec['NeedsDoors'].note, /No applicable elements/);
});

test('material and classification facets', () => {
  const w = loadEngine();
  const xml = ids(
    spec('Mat', ENT_WALL,
      '<material><value><xs:restriction base="xs:string"><xs:pattern value="(?i).*concrete.*"/></xs:restriction></value></material>') +
    spec('Class', ENT_WALL,
      '<classification><value><xs:restriction base="xs:string"><xs:pattern value="2[12].*"/></xs:restriction></value></classification>')
  );
  // JS RegExp rejects inline (?i) → that pattern is "not checkable", proving
  // null-propagation; use a plain pattern for the working case.
  const xml2 = ids(
    spec('Mat', ENT_WALL,
      '<material><value><xs:restriction base="xs:string"><xs:pattern value=".*[Cc]oncrete.*"/></xs:restriction></value></material>') +
    spec('Class', ENT_WALL,
      '<classification><value><xs:restriction base="xs:string"><xs:pattern value="2[12].*"/></xs:restriction></value></classification>')
  );
  const elems = [
    el(1, { ifcType: 'IfcWall', material: 'Concrete C30/37; Insulation', psets: { 'Classification': { Reference: '21.22' } } }),
    el(2, { ifcType: 'IfcWall', material: 'Timber', psets: {} })
  ];
  const w2 = loadEngine();
  const r2 = w2._ccRunIDS(w2._ccParseIDS(xml2).specs, models(elems));
  assert.equal(r2.summary.bySpec['Mat'].pass, 1);
  assert.equal(r2.summary.bySpec['Mat'].fail, 1);
  assert.equal(r2.summary.bySpec['Class'].pass, 1);
  assert.equal(r2.summary.bySpec['Class'].fail, 1);

  // unsupported inline-flag pattern → unchecked, not a wrong verdict
  const r1 = w._ccRunIDS(w._ccParseIDS(xml).specs, models(elems));
  assert.equal(r1.summary.bySpec['Mat'].unchecked > 0, true);
  assert.match(r1.summary.bySpec['Mat'].note, /not checkable/);
});

test('partOf: storey containment supported, other relations honestly unchecked', () => {
  const w = loadEngine();
  const xml = ids(
    spec('Storey', ENT_WALL,
      '<partOf relation="IFCRELCONTAINEDINSPATIALSTRUCTURE"><entity><name><simpleValue>IFCBUILDINGSTOREY</simpleValue></name></entity></partOf>') +
    spec('Agg', ENT_WALL,
      '<partOf relation="IFCRELAGGREGATES"><entity><name><simpleValue>IFCELEMENTASSEMBLY</simpleValue></name></entity></partOf>')
  );
  const parsed = w._ccParseIDS(xml);
  const r = w._ccRunIDS(parsed.specs, models([
    el(1, { ifcType: 'IfcWall', storey: 'Level 1' }),
    el(2, { ifcType: 'IfcWall', storey: '' })
  ]));
  assert.equal(r.summary.bySpec['Storey'].pass, 1);
  assert.equal(r.summary.bySpec['Storey'].fail, 1);
  assert.equal(r.summary.bySpec['Agg'].unchecked, 2);
  assert.equal(r.summary.bySpec['Agg'].fail, 0);
  assert.match(r.summary.bySpec['Agg'].note, /not checkable/);
  // An element whose only requirement is unchecked must not be counted as a
  // pass either — it was never verified. Both applicable elements landed in
  // `unchecked`, so `pass` (and `fail`) must stay 0, not silently inflate to
  // 2 — the IDS panel and generateValidationReport both compute their
  // pass-rate bar as pass/(pass+fail), so a phantom pass here would report
  // a specification as 100% compliant when nothing was actually checked.
  assert.equal(r.summary.bySpec['Agg'].pass, 0);
  assert.equal(r.summary.bySpec['Agg'].applicable, 2);
});

test('PredefinedType in applicability marks the spec skipped, never guessed', () => {
  const w = loadEngine();
  const xml = ids(spec('PT',
    '<entity><name><simpleValue>IFCWALL</simpleValue></name><predefinedType><simpleValue>SHEAR</simpleValue></predefinedType></entity>',
    '<attribute><name><simpleValue>Name</simpleValue></name></attribute>', 'minOccurs="1" maxOccurs="unbounded"'));
  const parsed = w._ccParseIDS(xml);
  const r = w._ccRunIDS(parsed.specs, models([el(1, { ifcType: 'IfcWall' })]));
  assert.equal(r.summary.bySpec['PT'].applicable, 0);
  assert.equal(r.summary.bySpec['PT'].fail, 0);
  assert.match(r.summary.bySpec['PT'].note, /skipped/);
});

test('quantity sets: Qto_/BaseQuantities requests search flattened quantities', () => {
  const w = loadEngine();
  const xml = ids(spec('Q', ENT_WALL,
    '<property><propertySet><simpleValue>Qto_WallBaseQuantities</simpleValue></propertySet>' +
    '<baseName><simpleValue>Width</simpleValue></baseName>' +
    '<value><xs:restriction base="xs:double"><xs:minExclusive value="0"/></xs:restriction></value></property>'));
  const parsed = w._ccParseIDS(xml);
  const r = w._ccRunIDS(parsed.specs, models([
    el(1, { ifcType: 'IfcWall', quantities: { Width: 0.3 } }),
    el(2, { ifcType: 'IfcWall', quantities: {} })
  ]));
  assert.equal(r.summary.bySpec['Q'].pass, 1);
  assert.equal(r.summary.bySpec['Q'].fail, 1);
});

test('applicability narrows by property facet, not only entity', () => {
  const w = loadEngine();
  const xml = ids(spec('ExtWalls',
    ENT_WALL +
    '<property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>' +
    '<baseName><simpleValue>IsExternal</simpleValue></baseName>' +
    '<value><simpleValue>true</simpleValue></value></property>',
    '<property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>' +
    '<baseName><simpleValue>ThermalTransmittance</simpleValue></baseName></property>'));
  const parsed = w._ccParseIDS(xml);
  const r = w._ccRunIDS(parsed.specs, models([
    el(1, { ifcType: 'IfcWall', psets: { Pset_WallCommon: { IsExternal: true } } }),          // applicable, missing U → fail
    el(2, { ifcType: 'IfcWall', psets: { Pset_WallCommon: { IsExternal: false } } }),         // not applicable
    el(3, { ifcType: 'IfcWall', psets: { Pset_WallCommon: { IsExternal: true, ThermalTransmittance: 0.2 } } }) // pass
  ]));
  assert.equal(r.summary.bySpec['ExtWalls'].applicable, 2);
  assert.equal(r.summary.bySpec['ExtWalls'].fail, 1);
  assert.equal(r.summary.bySpec['ExtWalls'].pass, 1);
  assert.equal(r.results[0].elementId, 1);
});

test('hidden models are skipped; result rows carry model/element identity', () => {
  const w = loadEngine();
  const xml = ids(spec('S', ENT_WALL, '<attribute><name><simpleValue>Description</simpleValue></name></attribute>'));
  const parsed = w._ccParseIDS(xml);
  const r = w._ccRunIDS(parsed.specs, [
    { id: 'mA', visible: true, elements: [el(1, { ifcType: 'IfcWall', storey: 'L1' })] },
    { id: 'mB', visible: false, elements: [el(2, { ifcType: 'IfcWall' })] }
  ]);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].modelId, 'mA');
  assert.equal(r.results[0].globalId, 'G1');
  assert.equal(r.results[0].storey, 'L1');
  assert.equal(r.results[0].status, 'fail');
});

test('importIDS summary rides the same parser', () => {
  const w = loadEngine();
  const xml = ids(spec('S', ENT_WALL,
    '<property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>' +
    '<baseName><simpleValue>FireRating</simpleValue></baseName></property>'));
  const sum = w._ccImportIDS(xml);
  assert.equal(sum.title, 'Test IDS');
  assert.equal(sum.ruleCount, 1);
  assert.equal(sum.rules[0].entity, 'IFCWALL');
  assert.match(sum.rules[0].requirements[0], /Pset_WallCommon\.FireRating/);
});

test('round-trip: our own exportIDS output parses and executes', () => {
  const w = loadEngine();
  const xml = w._ccExportIDS({ title: 'RT' });
  const parsed = w._ccParseIDS(xml);
  assert.equal(parsed.error, undefined);
  assert.ok(parsed.specs.length > 5, 'export should produce specs');
  const r = w._ccRunIDS(parsed.specs, models([el(1, { ifcType: 'IfcWall', material: 'Concrete', storey: 'L1', description: 'd' })]));
  assert.ok(r.summary.total > 0, 'executed checks');
});
