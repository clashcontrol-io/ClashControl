'use strict';
// Follow-up to REWRITE_UI_PLAN.md Phase 12 — the original pre-decode scan
// called ifcFile.text() before load, decoding the WHOLE file into one JS
// string just to regex out storey names. On a 300MB IFC that's a real,
// avoidable memory spike on exactly the large-model case this chooser
// exists for. This locks the replacement: a chunked File.slice()+
// TextDecoder scan (_ccExtractStoreyNamesFromIfcFileIncremental, index.html)
// that never holds more than one chunk in memory, carries incomplete
// trailing SPF lines across chunk boundaries, and stops early once several
// consecutive chunks add nothing new.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('function _ccExtractStoreyNamesFromIfcText(text) {');
assert.ok(start !== -1, '_ccExtractStoreyNamesFromIfcText not found');
const end = src.indexOf(
  'window._ccExtractStoreyNamesFromIfcFileIncremental = _ccExtractStoreyNamesFromIfcFileIncremental;',
  start
);
assert.ok(end !== -1, '_ccExtractStoreyNamesFromIfcFileIncremental closing point not found');
const scanExports = new Function('window', src.slice(start, end) + `
  window._ccExtractStoreyNamesFromIfcText = _ccExtractStoreyNamesFromIfcText;
  window._ccExtractStoreyNamesFromIfcFileIncremental = _ccExtractStoreyNamesFromIfcFileIncremental;
  return window;
`);
const lib = scanExports({});
const extractIncremental = lib._ccExtractStoreyNamesFromIfcFileIncremental;

// Duck-typed stub matching the real File API shape the function actually
// uses (file.size, file.slice(start,end).arrayBuffer()) — no DOM needed.
// Tracks every slice() call so tests can assert how much was actually read.
function makeStubFile(text, encoding) {
  encoding = encoding || 'utf-8';
  const bytes = Buffer.from(text, encoding);
  const calls = [];
  return {
    size: bytes.length,
    _calls: calls,
    slice(startByte, endByte) {
      calls.push([startByte, endByte]);
      const chunk = bytes.subarray(startByte, endByte);
      return {
        arrayBuffer: () => Promise.resolve(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)),
      };
    },
  };
}

function ifcLine(guid, name, elevation) {
  return `#1=IFCBUILDINGSTOREY('${guid}',$,'${name}',$,$,#2,$,$,.ELEMENT.,${elevation}.);`;
}

const FILLER_LINE = '#0=IFCCARTESIANPOINT((0.,0.,0.));\n';
// Repeat.length-based math (magic-number division) is fragile against the
// literal's exact byte length — build to an exact target length instead.
function fillerOfLength(minLength) {
  const reps = Math.ceil(minLength / FILLER_LINE.length) + 1;
  return FILLER_LINE.repeat(reps).slice(0, minLength);
}

test('finds a storey whose record is split across a chunk boundary', async () => {
  // Chunk size is 2MB — pad the file so the IFCBUILDINGSTOREY line itself
  // straddles the boundary, then confirm it's still found (not silently
  // dropped by a mid-line chunk split).
  const CHUNK = 2 * 1024 * 1024;
  const line = ifcLine('guid1', 'Split Level', 0);
  const padTarget = CHUNK - Math.floor(line.length / 2);
  const text = fillerOfLength(padTarget) + '\n' + line + '\n';
  const file = makeStubFile(text);
  assert.ok(file.size > CHUNK, 'fixture must actually straddle a chunk boundary for this test to mean anything');
  const names = await extractIncremental(file);
  assert.deepEqual(names, ['Split Level']);
});

test('deduplicates across chunk boundaries the same way the pure text scan does', async () => {
  const CHUNK = 2 * 1024 * 1024;
  const filler = fillerOfLength(CHUNK * 1.5);
  const text = ifcLine('g1', 'Ground Floor', 0) + '\n' + filler + ifcLine('g2', 'Ground Floor', 0) + '\n';
  const file = makeStubFile(text);
  const names = await extractIncremental(file);
  assert.deepEqual(names, ['Ground Floor']);
});

test('stops early once several consecutive chunks add nothing new, without reading the whole file', async () => {
  const CHUNK = 2 * 1024 * 1024;
  // Two real storeys up front, then many megabytes of filler with nothing
  // new — the scan should give up long before reaching the end.
  const head = ifcLine('g1', 'Level 1', 0) + '\n' + ifcLine('g2', 'Level 2', 3) + '\n';
  const filler = fillerOfLength(CHUNK * 20);
  const file = makeStubFile(head + filler);
  const names = await extractIncremental(file);
  assert.deepEqual(names, ['Level 1', 'Level 2']);
  // 20MB of filler at 2MB/chunk is ~10 chunks; the idle-chunk cutoff (4) plus
  // the head chunk should stop well short of reading it all.
  assert.ok(file._calls.length < 8, `expected an early stop, but read ${file._calls.length} chunks`);
});

test('never reads more than the hard byte ceiling, even if nothing is ever found', async () => {
  const CHUNK = 2 * 1024 * 1024;
  const MAX = 64 * 1024 * 1024;
  const filler = fillerOfLength(MAX * 1.2);
  const file = makeStubFile(filler);
  assert.ok(file.size > MAX, 'fixture must exceed the ceiling for this test to mean anything');
  const names = await extractIncremental(file);
  assert.deepEqual(names, []);
  const totalRead = file._calls.reduce((sum, [s, e]) => sum + (e - s), 0);
  assert.ok(totalRead <= MAX, `read ${totalRead} bytes, expected <= ${MAX}`);
  assert.ok(file._calls.length <= Math.ceil(MAX / CHUNK) + 1, `expected roughly ${MAX / CHUNK} chunks, got ${file._calls.length}`);
});

test('a slice()/read failure resolves with whatever was found so far, never rejects', async () => {
  const CHUNK = 2 * 1024 * 1024;
  // Pad past one full chunk so a real second slice() call happens — a
  // single-chunk fixture would never exercise the failure path at all.
  const filler = fillerOfLength(CHUNK);
  const file = makeStubFile(ifcLine('g1', 'Level 1', 0) + '\n' + filler);
  assert.ok(file.size > CHUNK, 'fixture must span at least two chunks for this test to mean anything');
  const realSlice = file.slice.bind(file);
  let call = 0;
  file.slice = (s, e) => {
    call++;
    if (call === 1) return realSlice(s, e);
    return { arrayBuffer: () => Promise.reject(new Error('simulated read failure')) };
  };
  const names = await extractIncremental(file);
  assert.deepEqual(names, ['Level 1']);
  assert.ok(call >= 2, 'expected the failure path to actually be exercised');
});

test('a completely empty file resolves to an empty array without throwing', async () => {
  const file = makeStubFile('');
  const names = await extractIncremental(file);
  assert.deepEqual(names, []);
});
