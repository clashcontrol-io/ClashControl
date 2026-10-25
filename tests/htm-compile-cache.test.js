'use strict';
// The htm parser compiles each template once (cached on its strings array)
// instead of re-parsing the template string on every call. This test checks
// that the compiled parser produces exactly the same h() calls as the old
// parse-every-call parser (tests/_htm-reference.js, kept verbatim) for EVERY
// html`...` template in index.html, with many random hole values (strings,
// numbers, booleans, null/undefined, arrays, objects, functions, and the tag
// names that switch on the table/select whitespace rule), and that a template
// is parsed only once.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const makeReferenceHtm = require('./_htm-reference.js');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('(function(g) {\n    var HOLE');
const end = src.indexOf('})(window);', start) + '})(window);'.length;
const win = {};
new Function('window', src.slice(start, end))(win);
const newHtm = win.htm;
const refHtm = makeReferenceHtm();

// ── extract every html`...` template literal (statics only) ──
// A small scanner over the source: after `html\``, collect the static chunks
// up to the closing backtick, skipping each ${...} expression (balanced
// braces, strings, nested template literals, comments).
function skipString(s, i, q) { // s[i] === q; returns index after the closing quote
  i++;
  while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; i++; }
  return i + 1;
}
function skipTemplate(s, i) { // s[i] === '`'
  i++;
  while (i < s.length && s[i] !== '`') {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '$' && s[i + 1] === '{') { i = skipExpr(s, i + 2); continue; }
    i++;
  }
  return i + 1;
}
function skipExpr(s, i) { // just after '${'; returns index after the matching '}'
  let depth = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { i = skipString(s, i, c); continue; }
    if (c === '`') { i = skipTemplate(s, i); continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i + 2) + 2; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
    i++;
  }
  throw new Error('unbalanced ${ at ' + i);
}
function extractTemplates(s) {
  const out = [];
  let at = 0;
  for (;;) {
    const k = s.indexOf('html`', at);
    if (k === -1) break;
    if (/[\w$.]/.test(s[k - 1] || '')) { at = k + 5; continue; } // e.g. innerHTML`, foo.html`
    let i = k + 5, chunk = '';
    const raws = [];
    while (i < s.length && s[i] !== '`') {
      if (s[i] === '\\') { chunk += s[i] + s[i + 1]; i += 2; continue; }
      if (s[i] === '$' && s[i + 1] === '{') { raws.push(chunk); chunk = ''; i = skipExpr(s, i + 2); continue; }
      chunk += s[i++];
    }
    raws.push(chunk);
    out.push({ line: s.slice(0, k).split('\n').length, raws });
    at = k + 5;
  }
  return out;
}
// cooked strings, as the engine passes them to a tag function
function makeStatics(raws) {
  const cooked = raws.map((r) => new Function('return `' + r + '`;')());
  return Object.freeze(Object.assign(cooked, { raw: Object.freeze(raws.slice()) }));
}

// h stand-in that records the call exactly (identity of values preserved)
function h() { return { tag: arguments[0], props: arguments[1], children: Array.prototype.slice.call(arguments, 2) }; }

// deterministic PRNG
function rng(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
const FN_A = function CompA() {}, FN_B = function CompB() {};
const OBJ = { a: 1, b: 'two' };
function randomValue(r) {
  const k = Math.floor(r() * 16);
  switch (k) {
    case 0: return null;
    case 1: return undefined;
    case 2: return false;
    case 3: return true;
    case 4: return 0;
    case 5: return 42;
    case 6: return '';
    case 7: return ' ';
    case 8: return 'text';
    case 9: return ['a', null, false, true, 0, 'b', ['nested']];
    case 10: return [];
    case 11: return OBJ;
    case 12: return FN_A;
    case 13: return FN_B;
    case 14: return ['select', 'tr', 'table', 'option', 'div'][Math.floor(r() * 5)];
    default: return { kind: 'el', n: Math.floor(r() * 100) };
  }
}

const templates = extractTemplates(src);

test('the scanner finds every html` template in index.html', () => {
  const plain = (src.match(/(^|[^\w$.])html`/g) || []).length;
  assert.ok(templates.length > 1000, 'expected the app\'s templates, found ' + templates.length);
  assert.equal(templates.length, plain);
});

test('compiled templates produce exactly the same h() calls as parsing every call', () => {
  let calls = 0;
  for (const t of templates) {
    let statics;
    try { statics = makeStatics(t.raws); } catch (e) { assert.fail('could not cook template at line ' + t.line + ': ' + e.message); }
    const holes = statics.length - 1;
    const r = rng(t.line * 7919 + holes);
    for (let rep = 0; rep < 12; rep++) {
      const fields = [];
      for (let k = 0; k < holes; k++) fields.push(randomValue(r));
      let want, got, wantErr = null, gotErr = null;
      try { want = refHtm.call(h, statics, ...fields); } catch (e) { wantErr = String(e); }
      try { got = newHtm.call(h, statics, ...fields); } catch (e) { gotErr = String(e); }
      assert.equal(gotErr, wantErr, 'line ' + t.line + ': error differs');
      if (!wantErr) assert.deepStrictEqual(got, want, 'line ' + t.line + ' rep ' + rep);
      calls++;
    }
  }
  assert.ok(calls > 12000);
});

test('a template is parsed once, whatever its hole values', () => {
  // a strings array is constant per call site; the second call must reuse
  // the tree built by the first (proved by changing the array in between —
  // real call sites never do; frozen arrays can't)
  const statics = Object.assign(['<div class="a ', '">', '</div>'], { raw: [] });
  const one = newHtm.call(h, statics, 'x', 'y');
  statics[0] = '<span class="a ';
  const two = newHtm.call(h, statics, 'p', ['q', null, 'r']);
  assert.deepStrictEqual(one, { tag: 'div', props: { class: 'a x' }, children: ['y'] });
  assert.deepStrictEqual(two, { tag: 'div', props: { class: 'a p' }, children: ['q', 'r'] }, 'second call re-parsed the template');
  assert.notEqual(one.props, two.props, 'props objects are fresh per call');
});
