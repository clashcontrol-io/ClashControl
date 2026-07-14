'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = source.indexOf('function _ccSnapshotWithRedlines(sourceCanvas, markups) {');
const end = source.indexOf('  function Viewer(props) {', start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);
const fnSource = source.slice(start, end);

function makeContext(ops) {
  return {
    drawImage() { ops.push('drawImage'); },
    beginPath() { ops.push('beginPath'); },
    moveTo() { ops.push('moveTo'); },
    lineTo() { ops.push('lineTo'); },
    stroke() { ops.push('stroke'); },
    closePath() { ops.push('closePath'); },
    fill() { ops.push('fill'); },
    strokeRect() { ops.push('strokeRect'); },
    fillText() { ops.push('fillText'); },
  };
}

function build() {
  const ops = [];
  const output = {
    width: 0, height: 0,
    getContext: () => makeContext(ops),
    toDataURL: () => 'data:image/png;base64,COMPOSITE',
  };
  const document = { createElement: (name) => { assert.equal(name, 'canvas'); return output; } };
  const fn = new Function('document', 'console', fnSource + '; return _ccSnapshotWithRedlines;')(
    document, { warn() {} }
  );
  return { fn, ops };
}

function sourceCanvas() {
  return {
    width: 1000, height: 500, clientWidth: 500, clientHeight: 250,
    toDataURL: () => 'data:image/png;base64,RAW',
  };
}

test('viewpoint snapshots remain byte-for-byte clean when there are no redlines', () => {
  const h = build();
  assert.equal(h.fn(sourceCanvas(), []), 'data:image/png;base64,RAW');
  assert.deepEqual(h.ops, []);
});

test('line, arrow, rectangle, freehand, and text redlines are baked into the PNG', () => {
  const h = build();
  const result = h.fn(sourceCanvas(), [
    { type:'line', x1:1, y1:2, x2:3, y2:4, color:'#f00' },
    { type:'arrow', x1:5, y1:6, x2:7, y2:8, color:'#0f0' },
    { type:'rect', x1:9, y1:10, x2:20, y2:30, color:'#00f' },
    { type:'freehand', points:[[1,1],[2,2],[3,1]], color:'#111' },
    { type:'text', x:12, y:14, text:'Check this', color:'#222' },
  ]);
  assert.equal(result, 'data:image/png;base64,COMPOSITE');
  assert.ok(h.ops.includes('drawImage'));
  assert.ok(h.ops.includes('strokeRect'));
  assert.ok(h.ops.includes('fillText'));
  assert.ok(h.ops.includes('fill'), 'arrow head should be filled');
  assert.ok(h.ops.filter((op) => op === 'stroke').length >= 3);
});

test('captured viewpoint wiring uses the latest markup ref and BCF already exports that PNG', () => {
  assert.match(source, /markups3DRef = useRef\(markups3D\); markups3DRef\.current = markups3D/);
  assert.match(source, /var snapshot = _ccSnapshotWithRedlines\(renderer\.domElement,[\s\S]*?markups3DRef\.current/);
  assert.match(source, /f\.file\(vpGuid\+'\.png', snapData, \{base64:true\}\)/);
});

test('the interactive 3D canvas is keyboard reachable and labelled', () => {
  assert.match(source, /renderer\.domElement\.tabIndex = 0/);
  assert.match(source, /setAttribute\('role', 'application'\)/);
  assert.match(source, /setAttribute\('aria-label', 'Interactive 3D model viewer'\)/);
});
