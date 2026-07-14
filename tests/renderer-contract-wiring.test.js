const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('Three.js core and every addon stay on one pinned renderer version', () => {
  const versions = [...source.matchAll(/three@([0-9]+\.[0-9]+\.[0-9]+)/g)].map((m) => m[1]);
  assert.ok(versions.length >= 3);
  assert.deepEqual([...new Set(versions)], ['0.180.0']);
});

test('rendererV2 is default-off and falls through to the exact legacy factory', () => {
  const start = source.indexOf('function _createLegacyRenderer()');
  const end = source.indexOf('el.appendChild(renderer.domElement)', start);
  const block = source.slice(start, end);
  assert.match(block, /isEnabled\('rendererV2'\)/);
  assert.match(block, /if \(_rendererV2 && window\._ccRendererContract\)/);
  assert.match(block, /else \{\s*renderer = _createLegacyRenderer\(\)/);
  assert.match(block, /legacy\.toneMapping = THREE\.ACESFilmicToneMapping/);
  assert.match(block, /legacy\.shadowMap\.autoUpdate = false/);
  assert.match(block, /legacy\.localClippingEnabled = false/);
});

test('candidate receives a legacy callback and records its migration outcome', () => {
  const start = source.indexOf('window._ccRendererContract.createGuarded');
  const end = source.indexOf('renderer = _rendererMigration.renderer', start);
  const block = source.slice(start, end);
  assert.match(block, /legacy: _createLegacyRenderer/);
  assert.match(block, /migration:'rendererV2'/);
  assert.match(block, /setSRGBOutput: _ccSetSRGBOutput/);
});

test('renderer contract helper loads before the app and exposes a runtime snapshot', () => {
  const helper = source.indexOf('<script src="renderer-contract.js"></script>');
  const main = source.indexOf('window.onload = function() {');
  assert.ok(helper >= 0 && main > helper);
  assert.match(source, /window\._ccRendererContractSnapshot = window\._ccRendererContract\.snapshot/);
});
