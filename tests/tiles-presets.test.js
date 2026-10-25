'use strict';
// addons/tiles.js: keyless national 3D layers are country-pack data
// (geo.tiles3d). Only the active pack's presets are offered; the core holds
// no tileset URL of its own.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { countryWindow, loadAddon, readPack } = require('./_country-pack.js');

function tiles(opts) {
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  return loadAddon('tiles.js', countryWindow(Object.assign({ window: { addEventListener() {}, removeEventListener() {} } }, opts)));
}

test('no active country pack: no keyless preset offered', () => {
  assert.deepStrictEqual(tiles({ regions: ['nl'], active: null })._ccTiles3DPresets(), []);
  assert.deepStrictEqual(tiles({ regions: [], active: null })._ccTiles3DPresets(), []);
});

test('nl active: the pack\'s PDOK preset with its own label', () => {
  const nl = readPack('nl').geo.tiles3d[0];
  const list = tiles({ regions: ['be', 'nl'], active: 'nl' })._ccTiles3DPresets();
  assert.deepStrictEqual(list, [{ id: nl.id, label: nl.label, title: nl.title, region: 'nl' }]);
  assert.equal(nl.heightOffsetM, 43);
});

test('a preset is resolved from pack data; an unknown one is refused before any network call', async () => {
  const w = tiles({ regions: ['nl'], active: 'nl' });
  w._ccState3d = { scene: {}, camera: {}, renderer: {} };
  await assert.rejects(() => w._ccLoadTiles3D({ preset: 'xx-none', lat: 52, lon: 5 }), /Unknown 3D tiles preset/);
  const src = fs.readFileSync(path.join(__dirname, '..', 'addons', 'tiles.js'), 'utf8');
  assert.ok(!/api\.pdok\.nl/.test(src), 'no national tileset URL hard-coded in the addon');
  assert.ok(/opts\.height = pr\.heightOffsetM/.test(src), 'the pack height offset anchors the tileset');
});
