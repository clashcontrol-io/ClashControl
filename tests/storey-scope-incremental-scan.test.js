'use strict';
// Follow-up to REWRITE_UI_PLAN.md Phase 12 — the original pre-decode scan
// called ifcFile.text() before load, decoding the WHOLE file into one JS
// string just to regex out storey names. On a 300MB IFC that's a real,
// avoidable memory spike on exactly the large-model case this chooser
// exists for. This locks the replacement: a chunked File.slice()+
// TextDecoder scan (_ccExtractStoreyNamesFromIfcFileIncremental, index.html)
// that never holds more than one chunk in memory and carries incomplete
// trailing SPF lines across chunk boundaries.
//
// An external review of an earlier version (which stopped scanning early
// once several consecutive chunks added nothing new) correctly flagged that
// IFC-SPF entity order isn't guaranteed — a storey appended late in the file
// could be silently missing from the chooser, and a user who then scoped
// down to "everything shown" would silently lose it. The scan now always
// covers the full file (up to a generous byte ceiling, since chunked reads
// stay memory-safe at any length) and reports `truncated: true` when that
// ceiling is hit, so the caller can refuse an unsafe partial selection
// instead of presenting an incomplete list as if it were the whole
// building. The "storey found late in a huge file" and "truncated flag"
// tests below lock exactly that behavior.
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
  window.IFC_STOREY_SCAN_CHUNK_BYTES = IFC_STOREY_SCAN_CHUNK_BYTES;
  window.IFC_STOREY_SCAN_MAX_BYTES = IFC_STOREY_SCAN_MAX_BYTES;
  return window;
`);
const lib = scanExports({});
const extractIncremental = lib._ccExtractStoreyNamesFromIfcFileIncremental;
const CHUNK = lib.IFC_STOREY_SCAN_CHUNK_BYTES;
const MAX = lib.IFC_STOREY_SCAN_MAX_BYTES;

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

// A "virtual" stub for ceiling/large-file tests: reports a `size` that can
// be hundreds of MB without ever materializing that much real data. Each
// slice() synthesizes only the requested byte range on demand via a
// caller-supplied `contentAt(startByte, endByte)`, so total memory use stays
// proportional to chunk size, not virtual file size — the ceiling itself is
// what's under test here, not the fixture's ability to hold huge strings.
function makeVirtualStubFile(size, contentAt) {
  const calls = [];
  return {
    size,
    _calls: calls,
    slice(startByte, endByte) {
      calls.push([startByte, endByte]);
      const text = contentAt(startByte, endByte);
      const bytes = Buffer.from(text, 'utf-8');
      return { arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) };
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
  // Pad the file so the IFCBUILDINGSTOREY line itself straddles the chunk
  // boundary, then confirm it's still found (not silently dropped by a
  // mid-line chunk split).
  const line = ifcLine('guid1', 'Split Level', 0);
  const padTarget = CHUNK - Math.floor(line.length / 2);
  const text = fillerOfLength(padTarget) + '\n' + line + '\n';
  const file = makeStubFile(text);
  assert.ok(file.size > CHUNK, 'fixture must actually straddle a chunk boundary for this test to mean anything');
  const result = await extractIncremental(file);
  assert.deepEqual(result.names, ['Split Level']);
  assert.equal(result.truncated, false);
});

test('deduplicates across chunk boundaries the same way the pure text scan does', async () => {
  const filler = fillerOfLength(CHUNK * 1.5);
  const text = ifcLine('g1', 'Ground Floor', 0) + '\n' + filler + ifcLine('g2', 'Ground Floor', 0) + '\n';
  const file = makeStubFile(text);
  const result = await extractIncremental(file);
  assert.deepEqual(result.names, ['Ground Floor']);
});

test('finds a storey defined late in the file, after many chunks with nothing new — the completeness fix', async () => {
  // Two real storeys up front, ~20MB of filler with nothing new, THEN a
  // third real storey. IFC-SPF entity order isn't guaranteed — a real file
  // could have exactly this shape (e.g. an addition appended after the
  // original export). An earlier version of this scan gave up after a few
  // idle chunks and would have silently missed 'Mezzanine' here.
  const head = ifcLine('g1', 'Level 1', 0) + '\n' + ifcLine('g2', 'Level 2', 3) + '\n';
  const filler = fillerOfLength(CHUNK * 20);
  const tail = ifcLine('g3', 'Mezzanine', 1.5) + '\n';
  const file = makeStubFile(head + filler + tail);
  const result = await extractIncremental(file);
  assert.deepEqual(result.names, ['Level 1', 'Level 2', 'Mezzanine']);
  assert.equal(result.truncated, false);
});

test('never reads more than the hard byte ceiling, and reports truncated:true when the file exceeds it', async () => {
  const file = makeVirtualStubFile(Math.round(MAX * 1.2), () => FILLER_LINE);
  const result = await extractIncremental(file);
  assert.deepEqual(result.names, []);
  assert.equal(result.truncated, true);
  const totalRead = file._calls.reduce((sum, [s, e]) => sum + (e - s), 0);
  assert.ok(totalRead <= MAX, `read ${totalRead} bytes, expected <= ${MAX}`);
  assert.ok(file._calls.length <= Math.ceil(MAX / CHUNK) + 1, `expected roughly ${MAX / CHUNK} chunks, got ${file._calls.length}`);
});

test('truncated is false for a file at or under the ceiling, even when nothing is found', async () => {
  const file = makeVirtualStubFile(Math.round(MAX * 0.9), () => FILLER_LINE);
  const result = await extractIncremental(file);
  assert.deepEqual(result.names, []);
  assert.equal(result.truncated, false);
});

test('a slice()/read failure resolves with whatever was found so far, never rejects', async () => {
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
  const result = await extractIncremental(file);
  assert.deepEqual(result.names, ['Level 1']);
  assert.ok(call >= 2, 'expected the failure path to actually be exercised');
});

test('a completely empty file resolves to an empty array without throwing', async () => {
  const file = makeStubFile('');
  const result = await extractIncremental(file);
  assert.deepEqual(result.names, []);
  assert.equal(result.truncated, false);
});
