'use strict';
// Broken IFC files used to reach the WASM parser directly and fail badly:
// a 0-byte file faulted with a low-level "memory access out of bounds"
// after ~5s, a garbage file renamed .ifc spun ~52s climbing to ~4GB before
// "Aborted()", and a truncated IFC took ~53s/3.3GB. _ccValidateIfcPreParse
// sniffs the raw bytes (non-empty, ISO-10303-21 marker, HEADER;/DATA;
// sections, ENDSEC;/END-ISO-10303-21; at the tail) before the buffer ever
// reaches the parser, so these fail in well under a second with a clear
// message instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

function loadValidator() {
  const start = html.indexOf('function _ccValidateIfcPreParse(buf, fileName) {');
  assert.ok(start !== -1, '_ccValidateIfcPreParse not found');
  const end = html.indexOf('\n  window._ccValidateIfcPreParse = _ccValidateIfcPreParse;', start);
  assert.ok(end !== -1);
  const src = html.slice(start, end);
  return new Function('Uint8Array', src + '; return _ccValidateIfcPreParse;')(Uint8Array);
}

function toBuf(str) {
  const bytes = Buffer.from(str, 'binary');
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const VALID_MINIMAL =
  "ISO-10303-21;\n" +
  "HEADER;\n" +
  "FILE_DESCRIPTION((''),'2;1');\n" +
  "ENDSEC;\n" +
  "DATA;\n" +
  "#1=IFCPROJECT('x');\n" +
  "ENDSEC;\n" +
  "END-ISO-10303-21;\n";

test('the pre-parse validator is wired into processFiles before the IFC parser starts', () => {
  const bufThenIdx = html.indexOf("}).then(function(buf) {\n            var _preCheck = _ccValidateIfcPreParse(buf, f.name);");
  assert.ok(bufThenIdx !== -1, 'validator call not found right after reading the file buffer');
  const parserStartIdx = html.indexOf("_onProg('Starting IFC parser 16%');", bufThenIdx);
  assert.ok(parserStartIdx !== -1);
  assert.ok(parserStartIdx > bufThenIdx, 'the validator must run before the parser starts');
});

test('a 0-byte buffer is rejected immediately with a clear message', () => {
  const validate = loadValidator();
  const r = validate(new ArrayBuffer(0), 'empty.ifc');
  assert.equal(r.ok, false);
  assert.match(r.error, /empty \(0 bytes\)/);
});

test('a garbage text file renamed .ifc is rejected (no ISO-10303-21 marker)', () => {
  const validate = loadValidator();
  const r = validate(toBuf('this is just some random text, not IFC at all'), 'fake.ifc');
  assert.equal(r.ok, false);
  assert.match(r.error, /ISO-10303-21/);
});

test('a file with the ISO marker but no HEADER; section is rejected', () => {
  const validate = loadValidator();
  const r = validate(toBuf('ISO-10303-21;\nsome nonsense\n'), 'bad-header.ifc');
  assert.equal(r.ok, false);
  assert.match(r.error, /HEADER;/);
});

test('a file with HEADER; but no DATA; section is rejected', () => {
  const validate = loadValidator();
  const r = validate(toBuf('ISO-10303-21;\nHEADER;\nENDSEC;\n'), 'no-data.ifc');
  assert.equal(r.ok, false);
  assert.match(r.error, /DATA;/);
});

test('a truncated IFC (valid header/data, no closing ENDSEC;/END-ISO-10303-21;) is rejected as truncated', () => {
  const validate = loadValidator();
  const truncated = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n#1=IFCPROJECT('x')"; // cuts off mid-entity
  const r = validate(toBuf(truncated), 'truncated.ifc');
  assert.equal(r.ok, false);
  assert.match(r.error, /truncated/i);
});

test('a well-formed minimal STEP/IFC file passes validation', () => {
  const validate = loadValidator();
  const r = validate(toBuf(VALID_MINIMAL), 'good.ifc');
  assert.equal(r.ok, true);
});

test('validation runs on a small head/tail slice, not the whole buffer (cheap even on large files)', () => {
  const validate = loadValidator();
  // Pad the middle with megabytes of junk between a valid head and valid tail.
  const middle = 'x'.repeat(2 * 1024 * 1024);
  const big =
    "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\n" + middle + "\nENDSEC;\nEND-ISO-10303-21;\n";
  const t0 = Date.now();
  const r = validate(toBuf(big), 'big.ifc');
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, true);
  assert.ok(elapsed < 200, 'expected the validator to run in well under a second even on a multi-MB buffer, took ' + elapsed + 'ms');
});
