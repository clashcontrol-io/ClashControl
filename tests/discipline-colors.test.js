'use strict';
// Locks DISC_COLOR_BY_ID (index.html): colorByClass:'byDiscipline' used to
// assign colors by element-count RANK (CLASS_COLORS[idx]), so whichever
// discipline happened to have the most elements got palette[0] regardless of
// what it was - the same discipline could render a different color in every
// federation. DISC_COLOR_BY_ID is the fixed id->hex lookup both the 3D scene
// and the Navigator panel dots now resolve 'byDiscipline' colors through
// instead. Extracted the same way tests/ifc-units.test.js pulls a slice out
// of the inline script.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('var DISC = [');
assert.ok(start !== -1, 'DISC not found');
const end = src.indexOf('DISC.forEach(function(d){ DISC_COLOR_BY_ID[d.id] = d.c; });', start);
assert.ok(end !== -1, 'DISC_COLOR_BY_ID build line not found');
const closeIdx = end + 'DISC.forEach(function(d){ DISC_COLOR_BY_ID[d.id] = d.c; });'.length;
const { DISC, DISC_COLOR_BY_ID } = new Function(
  src.slice(start, closeIdx) + '; return {DISC:DISC, DISC_COLOR_BY_ID:DISC_COLOR_BY_ID};'
)();

test('every discipline id has a stable, distinct color', () => {
  const ids = DISC.map((d) => d.id);
  assert.deepEqual(ids, ['structural', 'mep', 'architectural', 'civil', 'other']);
  const hexes = ids.map((id) => DISC_COLOR_BY_ID[id]);
  assert.equal(new Set(hexes).size, hexes.length, 'every discipline must get a distinct color');
  hexes.forEach((h) => assert.match(h, /^#[0-9a-f]{6}$/i));
});

test('lookup matches the source DISC entries exactly (no drift between the two)', () => {
  DISC.forEach((d) => assert.equal(DISC_COLOR_BY_ID[d.id], d.c));
});

test('both color-resolution sites gate on classView===byDiscipline before consulting DISC_COLOR_BY_ID', () => {
  // The count-indexed CLASS_COLORS palette must remain the default for
  // byType/byStorey/byMaterial - only byDiscipline should special-case.
  const sceneSite = src.slice(src.indexOf('var _groupHex = gKeys.map'), src.indexOf('var _groupHex = gKeys.map') + 300);
  assert.ok(sceneSite.includes("view==='byDiscipline'") && sceneSite.includes('DISC_COLOR_BY_ID'));
  const panelSite = src.slice(src.indexOf('var barColor ='), src.indexOf('var barColor =') + 300);
  assert.ok(panelSite.includes("classView==='byDiscipline'") && panelSite.includes('DISC_COLOR_BY_ID'));
});
