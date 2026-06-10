'use strict';
// Locks _ccExtractIfcLengthUnit (index.html): declared IFC LENGTHUNIT beats
// heuristics, so this must keep parsing the STEP forms correctly.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const i = src.indexOf('function _ccExtractIfcLengthUnit');
assert.ok(i !== -1);
const fn = new Function(src.slice(i, src.indexOf('\n  }', i) + 4) + '; return _ccExtractIfcLengthUnit;')();
const buf = (s) => new TextEncoder().encode(s).buffer;

test('parses SI length unit prefixes', () => {
  assert.equal(fn(buf('#1=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);')), 1000);
  assert.equal(fn(buf('#1=IFCSIUNIT(*,.LENGTHUNIT.,.CENTI.,.METRE.);')), 100);
  assert.equal(fn(buf('#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);')), 1);
});

test('skips non-length LENGTHUNIT mentions and finds the real one', () => {
  assert.equal(fn(buf('LENGTHUNIT decoy\n#1=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);')), 1000);
});

test('imperial/absent units return null (heuristic fallback)', () => {
  assert.equal(fn(buf("#1=IFCCONVERSIONBASEDUNIT(#2,.LENGTHUNIT.,'FOOT',#3);")), null);
  assert.equal(fn(buf('no units')), null);
});

test('real fixture declares plain metres', () => {
  const f = fs.readFileSync(path.join(__dirname, 'fixtures', 'smoke-clash.ifc'));
  assert.equal(fn(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength)), 1);
});
