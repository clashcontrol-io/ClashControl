'use strict';
// Covers three related BCF correctness fixes in index.html:
//  1. esc(0) must serialize as the string "0", not '' (String(s||'') dropped
//     falsy-but-meaningful values — a 0 clearance/distance/etc. exported as
//     an empty attribute/element, and a re-import's parseFloat('') === NaN
//     then silently dropped the field).
//  2. _bcfSceneToIfc / _bcfIfcToScene — the scene(Y-up)<->IFC(Z-up) axis
//     swap used by exportBCF's camera XML and (once added) BCF import. The
//     mapping is scene(x,y,z) -> IFC(x,-z,y); applying it twice is the
//     identity (round-trip exact).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFn(name) {
  const header = 'function ' + name + '(';
  const start = html.indexOf('  ' + header);
  assert.ok(start !== -1, name + ' not found');
  const end = html.indexOf('\n  }', start) + '\n  }'.length;
  return html.slice(start, end);
}

const bundle = extractFn('esc') + '\n' + extractFn('_bcfSceneToIfc') + '\n' + extractFn('_bcfIfcToScene');
const { esc, _bcfSceneToIfc, _bcfIfcToScene } = (function () {
  return new Function(bundle + '; return { esc, _bcfSceneToIfc, _bcfIfcToScene };')();
})();

test('esc(0) serializes as "0", not the empty string', () => {
  assert.equal(esc(0), '0');
  assert.equal(esc('0'), '0');
});

test('esc(false) serializes as "false"', () => {
  assert.equal(esc(false), 'false');
});

test('esc still treats null/undefined/"" as empty', () => {
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(''), '');
});

test('esc still escapes XML special characters', () => {
  assert.equal(esc('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
});

test('_bcfSceneToIfc maps scene(x,y,z) -> IFC(x,-z,y) — a walk-mode eye height (scene Y) becomes BCF Z', () => {
  const ifc = _bcfSceneToIfc({ x: 1, y: 1.7, z: 2 });
  assert.deepEqual(ifc, { x: 1, y: -2, z: 1.7 });
});

test('_bcfSceneToIfc / _bcfIfcToScene are exact inverses (round trip)', () => {
  const scene = { x: 3.25, y: -1.5, z: 7.75 };
  const roundTripped = _bcfIfcToScene(_bcfSceneToIfc(scene));
  assert.deepEqual(roundTripped, scene);
});

test('a horizontal camera 1.7m above Level 0 exports BCF Z ~= 1.7 and up vector (0,0,1)', () => {
  // Scene-space: Y-up, walk-mode eye height on Y; default camera up (0,1,0).
  const pos = _bcfSceneToIfc({ x: 0, y: 1.7, z: 0 });
  const up = _bcfSceneToIfc({ x: 0, y: 1, z: 0 });
  assert.equal(pos.z, 1.7);
  assert.deepEqual(up, { x: 0, y: 0, z: 1 });
});
