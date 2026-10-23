'use strict';
// country-pack-core.js: the contract between the IFC-neutral core and country
// packs — resolver precedence, the safe-regex gate, section validation, CRS.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../country-pack-core.js');
const { readPack } = require('./_country-pack.js');

const PACKS = ['be', 'ch', 'gb', 'nl'].map(readPack);
const site = (lat, lon, country) => ({ georef: lat == null ? null : { refLat: lat, refLon: lon }, address: country ? { country } : undefined });
const model = (opts) => ({ spatialHierarchy: Object.assign({ sites: [], buildings: [] }, opts) });

test('no country signal: IFC-neutral', () => {
  assert.deepStrictEqual(core.resolveCountry(PACKS, []), { region: null, reason: 'none', detail: '' });
  assert.equal(core.resolveCountry(PACKS, [model({ sites: [site(48.85, 2.35)] })]).region, null); // Paris: no fr pack
  assert.equal(core.resolveCountry(PACKS, [{}, model({}), model({ sites: [{}] })]).region, null);
});

test('IfcSite lat/lon inside a pack\'s geo.bounds', () => {
  const r = core.resolveCountry(PACKS, [model({ sites: [site(52.37, 4.9)] })]); // Amsterdam
  assert.equal(r.region, 'nl'); assert.equal(r.reason, 'site');
});

test('projected CRS (EPSG code or alias) in a pack\'s geo.crs', () => {
  assert.deepStrictEqual(core.resolveCountry(PACKS, [model({ mapConversion: { epsg: 'EPSG:28992' } })]), { region: 'nl', reason: 'crs', detail: 'EPSG:28992' });
  assert.equal(core.resolveCountry(PACKS, [model({ mapConversion: { epsg: 'Amersfoort / RD New' } })]).region, 'nl');
  assert.equal(core.resolveCountry(PACKS, [model({ mapConversion: { epsg: 'urn:ogc:def:crs:EPSG::31370' } })]).region, 'be');
  // A generic UTM zone spans countries: no answer from the CRS alone.
  assert.equal(core.resolveCountry(PACKS, [model({ mapConversion: { epsg: 'EPSG:32633' } })]).region, null);
});

test('IfcPostalAddress.Country beats CRS and site location; matched by name, code or alias', () => {
  const m = model({ sites: [site(52.37, 4.9, 'Belgique')], mapConversion: { epsg: 'EPSG:28992' } });
  assert.deepStrictEqual(core.resolveCountry(PACKS, [m]), { region: 'be', reason: 'address', detail: 'Belgique' });
  assert.equal(core.resolveCountry(PACKS, [model({ buildings: [{ address: { country: ' the netherlands ' } }] })]).region, 'nl');
  assert.equal(core.resolveCountry(PACKS, [model({ buildings: [{ address: { country: 'NL' } }] })]).region, 'nl');
  assert.equal(core.resolveCountry(PACKS, [model({ sites: [site(null, null, 'België')] })]).region, 'be');
  // An address no pack knows falls through to the next signal.
  assert.equal(core.resolveCountry(PACKS, [model({ sites: [site(52.37, 4.9, 'Atlantis')] })]).reason, 'site');
});

test('user override beats everything; explicit none stays neutral', () => {
  const m = model({ sites: [site(52.37, 4.9, 'Nederland')] });
  assert.deepStrictEqual(core.resolveCountry(PACKS, [m], { mode: 'user', region: 'gb' }), { region: 'gb', reason: 'user', detail: '' });
  assert.deepStrictEqual(core.resolveCountry(PACKS, [m], { mode: 'none' }), { region: null, reason: 'user-none', detail: '' });
});

test('overlapping bounds: the smaller box wins, equal boxes of two countries give no answer', () => {
  const a = { region: 'aa', geo: { bounds: [[0, 0, 10, 10]] } };
  const b = { region: 'bb', geo: { bounds: [[4, 4, 6, 6]] } };
  const c = { region: 'cc', geo: { bounds: [[4, 4, 6, 6]] } };
  assert.equal(core.resolveCountry([a, b], [model({ sites: [site(5, 5)] })]).region, 'bb');
  assert.equal(core.resolveCountry([a, b], [model({ sites: [site(1, 1)] })]).region, 'aa');
  assert.equal(core.resolveCountry([a, b, c], [model({ sites: [site(5, 5)] })]).region, null);
});

test('safeRegex: length cap, no nested quantifiers / backreferences / lookbehind', () => {
  assert.ok(core.safeRegex('^D[\\s\\-_]?\\d{2,4}', 'i').test('d-001'));
  assert.ok(core.safeRegex('(?!IfcSpace).*').test('IfcWall'));
  ['(a+)+b', '(a*)*', '(\\d{2})+', '(a)\\1', '(?<x>a)\\k<x>', '(?<=a)b', '(?<!a)b', 'x'.repeat(201), '([a-', ''].forEach((src) => {
    assert.equal(core.safeRegex(src), null, src);
    assert.ok(core.patternProblem(src), src);
  });
  assert.equal(core.safeRegex('abc', 'g'), null, 'only i/u flags');
});

test('every shipped pack validates and every pattern in it compiles through safeRegex', () => {
  PACKS.forEach((p) => assert.deepStrictEqual(core.validateSections(p), [], p.region));
  const nl = readPack('nl');
  nl.dataQuality.standards.forEach((s) => s.checks.forEach((c) => { if (c.pattern) assert.ok(core.safeRegex(c.pattern, c.flags), c.id); }));
});

test('validateSections rejects malformed sections', () => {
  const bad = [
    { geo: { bounds: [[53, 3, 50, 7]] } },
    { geo: { crs: { 'RD': { label: 'x', def: '+proj=sterea' } } } },
    { geo: { crs: { '28992': { label: 'x', def: 'rm -rf /' } } } },
    { geo: { tiles3d: [{ id: 'x', label: 'X', url: 'http://api.pdok.nl/x', attribution: 'a' }] } },
    { geo: { tiles3d: [{ id: 'x', label: 'X', url: 'https://evil.example.com/tiles', attribution: 'a' }] } },
    { geo: { defaultCrs: '28992' } },
    { geo: { countryNames: ['<script>'] } },
    { engines: { accessibility: { doorClearWidth: 'wide' } } },
    { engines: { accessibility: { doorWidthTypo: 0.8 } } },
    { engines: { visibility: { presets: { x: { label: 'x', viewer: { types: ['Wall'] }, target: {}, maxRange: 5, mode: 'obstruction' } } } } },
    { engines: { visibility: { presets: { x: { label: 'x', viewer: { namePattern: '(a+)+' }, target: {}, maxRange: 5, mode: 'obstruction' } } } } },
    { naming: { spaceRoles: { corridor: '(a*)*' } } },
    { naming: { spaceRoles: { kitchen: 'x' } } },
    { naming: { visibilityTerms: { exit: 'uitgang' } } },
    { naming: { revitDisciplineHints: { hvac: ['x'] } } },
    { naming: { classificationKeys: [{ system: 'X', keys: [] }] } },
    { format: { decimal: ';' } },
    { dataQuality: { standards: [{ id: 'x', label: 'X', scope: 'elements', headline: 'never', elementTypes: [], checks: [{ id: 'a', kind: 'attribute', attr: 'name', label: 'L', sev: 'warn', cat: 'naming' }] }] } },
    { dataQuality: { standards: [{ id: 'x', label: 'X', source: 's', scope: 'elements', headline: 'never', elementTypes: [], checks: [{ id: 'a', kind: 'eval', label: 'L', sev: 'warn', cat: 'c' }] }] } },
    { dataQuality: { standards: [{ id: 'x', label: 'X', source: 's', scope: 'models', headline: 'never', checks: [{ id: 'a', kind: 'attribute', attr: 'name', label: 'L', sev: 'warn', cat: 'c' }] }] } },
    { dataQuality: { standards: [{ id: 'x', label: 'X', source: 's', scope: 'elements', headline: 'never', elementTypes: [], checks: [{ id: 'a', kind: 'elementName', pattern: '(x+)*', label: 'L', sev: 'warn', cat: 'c' }] }] } },
    { dataQuality: { standards: [{ id: 'x', label: 'X', source: 's', scope: 'elements', headline: 'adoption', adoptionMin: 0.2, elementTypes: [], checks: [{ id: 'a', kind: 'attribute', attr: 'name', label: 'L', sev: 'warn', cat: 'c' }] }] } },
  ];
  bad.forEach((sec) => assert.ok(core.validateSections(sec).length > 0, JSON.stringify(sec)));
});

test('pack URL allow-list hosts are all allowed by the app CSP connect-src', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
  const csp = /connect-src ([^;]+)/.exec(meta)[1].split(/\s+/);
  core.URL_HOSTS.forEach((h) => assert.ok(csp.includes('https://' + h), h + ' missing from CSP connect-src'));
});

test('CRS: built-ins, pack entries and the generic UTM builder', () => {
  const reg = core.crsRegistry(PACKS);
  ['3857', '4326', '28992', '25831', '25832', '31370', '2056', '27700'].forEach((k) => assert.ok(reg[k], k));
  assert.equal(core.crsRegistry([])['28992'], undefined, 'no country CRS without a pack');
  assert.deepStrictEqual(core.utmCrs('32631'), { label: 'WGS 84 / UTM 31N', def: '+proj=utm +zone=31 +datum=WGS84 +units=m +no_defs' });
  assert.match(core.utmCrs('32733').def, /\+south/);
  assert.equal(core.utmCrs('25831').def, PACKS.find((p) => p.region === 'nl').geo.crs['25831'].def, 'pack 258xx matches the generic builder');
  assert.equal(core.utmCrs('32661'), null);
  assert.equal(core.utmCrs('25840'), null);
  assert.equal(core.resolveCrs(PACKS, 'Belge Lambert 72'), '31370');
  assert.equal(core.resolveCrs(PACKS, 'OSGB 1936 / British National Grid'), '27700');
  assert.equal(core.resolveCrs(PACKS, 'EPSG:32632'), '32632');
  assert.equal(core.resolveCrs([], 'EPSG:28992'), null);
  assert.equal(core.resolveCrs(PACKS, 'Some Local Grid'), null);
});
