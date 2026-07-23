const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { validateLocalePack } = require('../scripts/validate-locale.js');
const { validateRegulationPack } = require('../scripts/validate-regulation.js');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const REGULATIONS_DIR = path.join(__dirname, '..', 'regulations');

function readJSON(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ── validateLocalePack ──────────────────────────────────────────────────

test('validateLocalePack accepts a well-formed pack', () => {
  const result = validateLocalePack(JSON.stringify({
    lang: 'ja', name: '日本語', contributor: 'someone', strings: { 'toolbar.open': '開く' }
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateLocalePack rejects invalid JSON', () => {
  const result = validateLocalePack('{not json');
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /Invalid JSON/);
});

test('validateLocalePack rejects missing required keys', () => {
  const result = validateLocalePack(JSON.stringify({ lang: 'ja' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Missing required key: name/.test(e)));
  assert.ok(result.errors.some((e) => /Missing required key: contributor/.test(e)));
  assert.ok(result.errors.some((e) => /Missing required key: strings/.test(e)));
});

test('validateLocalePack rejects unknown top-level keys', () => {
  const result = validateLocalePack(JSON.stringify({
    lang: 'ja', name: 'x', contributor: 'y', strings: {}, extra: 'nope'
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /Unknown top-level key: extra/.test(e)));
});

test('validateLocalePack rejects script-injection attempts in string values', () => {
  const cases = [
    '<script>alert(1)</script>',
    'javascript:alert(1)',
    '<img src=x onerror=alert(1)>',
    '<b>bold</b>'
  ];
  cases.forEach((malicious) => {
    const result = validateLocalePack(JSON.stringify({
      lang: 'ja', name: 'x', contributor: 'y', strings: { k: malicious }
    }));
    assert.equal(result.ok, false, `expected rejection for: ${malicious}`);
  });
});

test('validateLocalePack rejects oversized files', () => {
  const huge = 'a'.repeat(300 * 1024);
  const result = validateLocalePack(JSON.stringify({
    lang: 'ja', name: 'x', contributor: 'y', strings: { k: huge }
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /byte limit/.test(e)));
});

test('validateLocalePack rejects a malformed lang tag', () => {
  const result = validateLocalePack(JSON.stringify({
    lang: 'not a tag!', name: 'x', contributor: 'y', strings: {}
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /lang must be/.test(e)));
});

// ── validateRegulationPack ───────────────────────────────────────────────

test('validateRegulationPack accepts a well-formed pack', () => {
  const result = validateRegulationPack(JSON.stringify({
    region: 'jp', name: 'Japan', contributor: 'someone', verified: false,
    source: 'Building Standards Act, Article X',
    engines: { accessibility: { doorClearWidth: 0.8 } }
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateRegulationPack requires a source citation', () => {
  const result = validateRegulationPack(JSON.stringify({
    region: 'jp', name: 'Japan', contributor: 'someone', verified: false, source: '',
    engines: { accessibility: { doorClearWidth: 0.8 } }
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /source is required/.test(e)));
});

test('validateRegulationPack rejects non-numeric thresholds', () => {
  const result = validateRegulationPack(JSON.stringify({
    region: 'jp', name: 'Japan', contributor: 'someone', verified: false, source: 'cite',
    engines: { accessibility: { doorClearWidth: 'wide' } }
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /must be a finite number/.test(e)));
});

test('validateRegulationPack flags unrecognized threshold keys for a known engine', () => {
  const result = validateRegulationPack(JSON.stringify({
    region: 'jp', name: 'Japan', contributor: 'someone', verified: false, source: 'cite',
    engines: { accessibility: { doorWidthTypo: 0.8 } }
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /not a recognized threshold key/.test(e)));
});

test('validateRegulationPack requires verified to be a boolean', () => {
  const result = validateRegulationPack(JSON.stringify({
    region: 'jp', name: 'Japan', contributor: 'someone', verified: 'yes', source: 'cite',
    engines: { accessibility: { doorClearWidth: 0.8 } }
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /verified must be/.test(e)));
});

// ── Real repo content stays valid ───────────────────────────────────────

test('every locale pack referenced by locales/manifest.json exists and validates', () => {
  const manifest = readJSON(path.join(LOCALES_DIR, 'manifest.json'));
  assert.ok(Array.isArray(manifest));
  manifest.forEach((entry) => {
    assert.ok(entry.lang && entry.file && entry.name && entry.contributor, 'manifest entry missing a required field: ' + JSON.stringify(entry));
    const packPath = path.join(LOCALES_DIR, entry.file);
    assert.ok(fs.existsSync(packPath), `manifest references missing file: ${entry.file}`);
    const raw = fs.readFileSync(packPath, 'utf8');
    const result = validateLocalePack(raw);
    assert.equal(result.ok, true, `${entry.file} failed validation: ${result.errors.join('; ')}`);
    assert.equal(JSON.parse(raw).lang, entry.lang, `${entry.file}'s lang must match its manifest entry`);
  });
});

test('every regulation pack referenced by regulations/manifest.json exists and validates', () => {
  const manifest = readJSON(path.join(REGULATIONS_DIR, 'manifest.json'));
  assert.ok(Array.isArray(manifest));
  manifest.forEach((entry) => {
    assert.ok(entry.region && entry.file && entry.name && entry.contributor, 'manifest entry missing a required field: ' + JSON.stringify(entry));
    const packPath = path.join(REGULATIONS_DIR, entry.file);
    assert.ok(fs.existsSync(packPath), `manifest references missing file: ${entry.file}`);
    const raw = fs.readFileSync(packPath, 'utf8');
    const result = validateRegulationPack(raw);
    assert.equal(result.ok, true, `${entry.file} failed validation: ${result.errors.join('; ')}`);
    assert.equal(JSON.parse(raw).region, entry.region, `${entry.file}'s region must match its manifest entry`);
  });
});

test('no stray .json pack files are left out of the manifests', () => {
  const localeFiles = fs.readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json') && f !== 'manifest.json' && f !== '_template.json');
  const localeManifest = readJSON(path.join(LOCALES_DIR, 'manifest.json')).map((e) => e.file);
  localeFiles.forEach((f) => assert.ok(localeManifest.includes(f), `${f} exists in locales/ but is not listed in manifest.json`));

  const regFiles = fs.readdirSync(REGULATIONS_DIR).filter((f) => f.endsWith('.json') && f !== 'manifest.json' && f !== '_template.json');
  const regManifest = readJSON(path.join(REGULATIONS_DIR, 'manifest.json')).map((e) => e.file);
  regFiles.forEach((f) => assert.ok(regManifest.includes(f), `${f} exists in regulations/ but is not listed in manifest.json`));
});
