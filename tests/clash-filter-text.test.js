'use strict';
// The clash list free-text filter (index.html, IssuePanel's items useMemo)
// used to do a single naive hay.indexOf(fullQuery) match, so the panel's
// OWN placeholder examples mostly returned 0 results. _ccFilterTextMatches
// replaces it with a tokenized, filler-word-stripped, synonym-aware,
// singular/plural-tolerant AND match.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

function extractFn(name) {
  const header = 'function ' + name + '(';
  const start = html.indexOf('  ' + header);
  assert.ok(start !== -1, name + ' not found');
  const end = html.indexOf('\n  }', start) + '\n  }'.length;
  return html.slice(start, end);
}

const fillerStart = html.indexOf('var _CC_FILTER_FILLER = ');
const fillerEnd = html.indexOf(';', fillerStart) + 1;
const fillerDecl = html.slice(fillerStart, fillerEnd);
const bundle = fillerDecl + '\n' + extractFn('_ccFilterTextMatches');
const { _ccFilterTextMatches } = (function () {
  return new Function(bundle + '; return { _ccFilterTextMatches };')();
})();

function hayFor(it) {
  return [it.title, it.description, it.type, it.elemAStorey, it.elemBStorey, it.elemAType, it.elemBType, it.elemAMaterial, it.elemBMaterial, it.status]
    .filter(Boolean).join(' ').toLowerCase();
}

test('empty query matches everything', () => {
  assert.equal(_ccFilterTextMatches('', 'anything', 3), true);
  assert.equal(_ccFilterTextMatches(null, 'anything', 3), true);
});

test('"hard on floor 2" matches a hard clash on a storey named "Floor 2" or "Level 2" — the panel\'s own placeholder example', () => {
  const it = { type: 'hard', elemAStorey: 'Level 2', status: 'open' };
  assert.equal(_ccFilterTextMatches('hard on floor 2', hayFor(it), 5), true);
});

test('"hard on level 1" matches a hard clash on "Level 1"', () => {
  const it = { type: 'hard', elemAStorey: 'Level 1', status: 'open' };
  assert.equal(_ccFilterTextMatches('hard on level 1', hayFor(it), 5), true);
});

test('"open pipes" matches an open clash whose element type contains the singular "pipe"', () => {
  const it = { status: 'open', elemAType: 'IfcPipeSegment' };
  assert.equal(_ccFilterTextMatches('open pipes', hayFor(it), 5), true);
});

test('floor/storey/story are synonyms for level', () => {
  const it = { elemAStorey: 'Level 3' };
  assert.equal(_ccFilterTextMatches('storey 3', hayFor(it), null), true);
  assert.equal(_ccFilterTextMatches('story 3', hayFor(it), null), true);
  assert.equal(_ccFilterTextMatches('floor 3', hayFor(it), null), true);
});

test('a bare clash number or "#N" matches the item\'s stable display number', () => {
  const it = { title: 'Duct vs beam' };
  assert.equal(_ccFilterTextMatches('7', hayFor(it), 7), true);
  assert.equal(_ccFilterTextMatches('#7', hayFor(it), 7), true);
  assert.equal(_ccFilterTextMatches('7', hayFor(it), 8), false);
});

test('filler words (on/in/at/the/of) are ignored, not required to match', () => {
  const it = { type: 'hard', elemAStorey: 'Level 1' };
  assert.equal(_ccFilterTextMatches('hard on the level 1', hayFor(it), null), true);
});

test('every remaining token must match (AND), not just one', () => {
  const it = { type: 'soft', elemAStorey: 'Level 1' };
  // "hard" does not match a soft clash — must fail even though "level 1" does
  assert.equal(_ccFilterTextMatches('hard level 1', hayFor(it), null), false);
});

test('still matches a plain single-word query the old substring match already handled', () => {
  const it = { title: 'Duct clash', type: 'hard' };
  assert.equal(_ccFilterTextMatches('duct', hayFor(it), null), true);
  assert.equal(_ccFilterTextMatches('hard', hayFor(it), null), true);
});
