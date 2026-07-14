'use strict';
// Locks the Wave 4 "+/-/= editing" fixes for Selection Sets (index.html):
// REN_SELSET's reducer case existed but had ZERO dispatch call sites anywhere
// in the app (genuinely dead code - the rename button didn't exist), and
// there was no way to add/remove elements from an already-saved set at all.
// Extracts the real reducer case bodies (single-expression `case: return X;`
// slices, same extraction spirit as tests/ifc-units.test.js pulling a
// function out of the inline script) rather than reimplementing the logic.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractCaseReturn(caseLabel) {
  const marker = "case '" + caseLabel + "': return ";
  const start = src.indexOf(marker);
  assert.ok(start !== -1, marker + ' not found');
  const exprStart = start + marker.length;
  const end = src.indexOf(';\n', exprStart);
  assert.ok(end !== -1, caseLabel + ' case not terminated on its own line');
  return src.slice(exprStart, end);
}

function reducerCase(caseLabel) {
  const expr = extractCaseReturn(caseLabel);
  return new Function('s', 'a', 'return ' + expr + ';');
}

function selSet(id, name, refs) { return { id: id, name: name, refs: refs || [] }; }

test('UPD_SELSET_REFS replaces refs on the matching set only, leaving others untouched', () => {
  const fn = reducerCase('UPD_SELSET_REFS');
  const s = { selectionSets: [selSet('a', 'Set A', [{ expressId: 1 }]), selSet('b', 'Set B', [{ expressId: 2 }])] };
  const next = fn(s, { id: 'a', refs: [{ expressId: 1 }, { expressId: 5 }] });
  assert.deepEqual(next.selectionSets.find((x) => x.id === 'a').refs, [{ expressId: 1 }, { expressId: 5 }]);
  assert.deepEqual(next.selectionSets.find((x) => x.id === 'b').refs, [{ expressId: 2 }], 'the other set must be untouched');
});

test('UPD_SELSET_REFS preserves the set\'s name (only refs change)', () => {
  const fn = reducerCase('UPD_SELSET_REFS');
  const s = { selectionSets: [selSet('a', 'MEP risers', [{ expressId: 1 }])] };
  const next = fn(s, { id: 'a', refs: [] });
  assert.equal(next.selectionSets[0].name, 'MEP risers');
});

test('UPD_SELSET_REFS with an unknown id is a no-op (no matching set)', () => {
  const fn = reducerCase('UPD_SELSET_REFS');
  const s = { selectionSets: [selSet('a', 'Set A', [{ expressId: 1 }])] };
  const next = fn(s, { id: 'does-not-exist', refs: [{ expressId: 9 }] });
  assert.deepEqual(next.selectionSets, s.selectionSets);
});

test('REN_SELSET (pre-existing reducer case) still renames correctly', () => {
  const fn = reducerCase('REN_SELSET');
  const s = { selectionSets: [selSet('a', 'Old name', [])] };
  const next = fn(s, { id: 'a', name: 'New name' });
  assert.equal(next.selectionSets[0].name, 'New name');
});

test('REN_SELSET now has a real dispatch call site (was dead code - reducer case with zero callers)', () => {
  assert.ok(/d\(\{t:'REN_SELSET'/.test(src), 'no UI dispatches REN_SELSET - rename button is missing or was removed');
});

test('the Selection Sets panel offers rename, +, -, and delete actions', () => {
  const panelStart = src.indexOf("${/* Selection Sets");
  assert.ok(panelStart !== -1, 'Selection Sets panel section not found');
  const panelEnd = src.indexOf('</div>`;\n              })}', panelStart);
  const panelSrc = src.slice(panelStart, panelEnd === -1 ? panelStart + 4000 : panelEnd);
  assert.ok(/click to rename/.test(panelSrc));
  assert.ok(/Add current selection to this set/.test(panelSrc));
  assert.ok(/Remove current selection from this set/.test(panelSrc));
  assert.ok(/d\(\{t:'DEL_SELSET'/.test(panelSrc));
});
