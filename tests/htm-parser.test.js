'use strict';
// Tests for the hand-written htm tagged-template parser (index.html, the
// `<!-- htm — tagged template to React.createElement ... -->` block near the
// top of the file). Extracts the real IIFE source and runs it against a
// stub `h` (standing in for React.createElement) so we exercise the actual
// production parsing logic, not a reimplementation.
//
// The text-chunk whitespace rule follows JSX semantics rather than a naive
// trim: whitespace that contains a newline is removed (leading/trailing) or
// collapsed to a single space (internal); whitespace without a newline is
// left untouched, including a whitespace-only chunk that sits on one line
// between two interpolations/elements (`${a} ${b}` keeps its separating
// space). See index.html's parseChildren() text branch.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const START_MARKER = '(function(g) {\n    var HOLE';
const END_MARKER = '})(window);';
const start = src.indexOf(START_MARKER);
assert.ok(start !== -1, 'htm parser IIFE not found in index.html');
const end = src.indexOf(END_MARKER, start) + END_MARKER.length;
const snippet = src.slice(start, end);

const sandboxWindow = {};
new Function('window', snippet)(sandboxWindow);
const htm = sandboxWindow.htm;
assert.equal(typeof htm, 'function', 'window.htm was not defined by the extracted snippet');

// Stand-in for React.createElement: records tag/props/children verbatim so
// assertions can inspect exactly what parseChildren() produced.
function h() {
  return { tag: arguments[0], props: arguments[1], children: Array.prototype.slice.call(arguments, 2) };
}

// Tagged-template helper: `run\`<div>${x}</div>\`` mirrors how index.html's
// `html` binding is actually invoked.
function run(strings) {
  var vals = Array.prototype.slice.call(arguments, 1);
  strings = strings.slice();
  strings.raw = strings;
  return htm.apply(h, [strings].concat(vals));
}

test('same-line spaces around holes are kept: `${a} ${b}`', () => {
  const r = run(['<div>', ' ', '</div>'], 'A', 'B');
  assert.deepEqual(r.children, ['A', ' ', 'B']);
});

test('same-line whitespace-only text node between two elements is kept', () => {
  const r = run(['<div><span>x</span> <span>y</span></div>']);
  assert.equal(r.children.length, 3);
  assert.equal(r.children[0].tag, 'span');
  assert.equal(r.children[1], ' ');
  assert.equal(r.children[2].tag, 'span');
});

test('newline + indentation around a hole is dropped entirely (no glued/no spurious space)', () => {
  const r = run(['<div>\n  ', '\n</div>'], 'A');
  assert.deepEqual(r.children, ['A']);
});

test('text spanning multiple lines is joined with a single space, per line trimmed', () => {
  const r = run(['<div>\n  hello\n  world\n</div>']);
  assert.deepEqual(r.children, ['hello world']);
});

test('a text chunk that is only whitespace with a newline is dropped as a child', () => {
  const r = run(['<div>\n</div>']);
  assert.deepEqual(r.children, []);
});

test('trailing same-line space before a newline-terminated close is still dropped (newline present)', () => {
  const r = run(['<div>hello   \n</div>']);
  assert.deepEqual(r.children, ['hello']);
});

test('leading same-line space before the first hole with no newline is preserved', () => {
  const r = run(['<div>  ', '</div>'], 'A');
  assert.deepEqual(r.children, ['  ', 'A']);
});

test('multiple blank lines between text collapse to a single space', () => {
  const r = run(['<div>a\n\n\nb</div>']);
  assert.deepEqual(r.children, ['a b']);
});

test('regression: `${label} ${n}` no longer glues into "Total300"', () => {
  const r = run(['<div>', ' ', '</div>'], 'Total', 300);
  assert.deepEqual(r.children, ['Total', ' ', 300]);
});

test('regression: text immediately followed by a same-line element tag is unaffected (no whitespace between)', () => {
  const r = run(['<div>sharing<strong>', '</strong></div>'], 'minimised');
  assert.equal(r.children.length, 2);
  assert.equal(r.children[0], 'sharing');
  assert.equal(r.children[1].tag, 'strong');
  assert.deepEqual(r.children[1].children, ['minimised']);
});

test('whitespace-only same-line text between <tr> and <td> is dropped (table-section child rule)', () => {
  const r = run(['<table><tbody><tr> <td>x</td></tr></tbody></table>']);
  const tbody = r.children[0];
  assert.equal(tbody.tag, 'tbody');
  const tr = tbody.children[0];
  assert.equal(tr.tag, 'tr');
  assert.deepEqual(tr.children.map(c => (c && c.tag) || c), ['td']);
});

test('whitespace-only same-line text between <select> and <option> is dropped', () => {
  const select = run(['<select> <option>a</option> <option>b</option> </select>']);
  assert.equal(select.tag, 'select');
  assert.deepEqual(select.children.map(c => (c && c.tag) || c), ['option', 'option']);
});

test('table-section whitespace-drop rule does not eat real text content', () => {
  const r = run(['<table><tbody><tr><td>', '</td></tr></tbody></table>'], 'value');
  const tbody = r.children[0];
  const tr = tbody.children[0];
  const td = tr.children[0];
  assert.deepEqual(td.children, ['value']);
});

test('attribute parsing is unaffected by the text-whitespace change', () => {
  const r = run(['<div className=', '>hi</div>'], 'x');
  assert.deepEqual(r.props, { className: 'x' });
  assert.deepEqual(r.children, ['hi']);
});
