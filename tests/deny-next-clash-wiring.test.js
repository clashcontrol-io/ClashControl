'use strict';
// Confirm / Deny → next: the clash list advances to the next item IN THE
// ORDER ON SCREEN (_ccPrepareAdvance / _ccAdvanceToNext over its flatItems),
// never to a clash the list does not show (hidden bucket, filtered out). The
// reducer only changes data: it used to pick "next" from every non-denied
// clash and fly the camera there 100 ms later — onto hidden clashes, and on
// status changes that came from a teammate's sync or the AI bridge too.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function slice(startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  assert.ok(s !== -1, startMarker + ' not found');
  const e = src.indexOf(endMarker, s);
  assert.ok(e !== -1, endMarker + ' not found');
  return src.slice(s, e + endMarker.length);
}

// _ccPrepareAdvance + _ccAdvanceToNext with the list's closure stubbed.
function advanceHarness() {
  const code = slice('    window._ccPrepareAdvance = function(currentId) {', "rows.forEach(function(row) { if (row.dataset.itemId === nxt.id) row.scrollIntoView({block:'nearest'}); });\n      }\n    };");
  const win = {}, actions = [], flights = [];
  // the window.* helpers close over `flatItems`, as each list render's closure does
  const make = new Function('window', 'd', '_itemRefs', '_ghostOthers', '_highlightRefs', '_flyToElements', '_flyTo', 'scrollRef', 'A',
    'var flatItems = [];\n' + code + '\nreturn function(items) { flatItems = items; };');
  const bind = make(win, (a) => actions.push(a), (it) => [{ expressId: it.id }], null, null, (refs) => flights.push(refs[0].expressId), null, { current: null }, { ACTIVE: 'ACTIVE' });
  return { win, actions, flights, render: bind };
}

test('C / D keys: the next item on screen, in list order (the handled item still listed)', () => {
  const h = advanceHarness();
  const items = [{ id: 'c1' }, { id: 'c5' }, { id: 'c3' }];
  h.render(items);
  h.win._ccPrepareAdvance('c5');
  h.win._ccAdvanceToNext('c5');
  assert.deepEqual(h.actions.map((a) => a.id), ['c3']);
  assert.deepEqual(h.flights, ['c3']);
});

test('buttons: after the re-render the handled (now hidden) item is gone — its slot holds the next one', () => {
  const h = advanceHarness();
  h.render([{ id: 'c1' }, { id: 'c5' }, { id: 'c3' }]);
  h.win._ccPrepareAdvance('c5');
  h.render([{ id: 'c1' }, { id: 'c3' }]);
  h.win._ccAdvanceToNext('c5');
  assert.deepEqual(h.actions.map((a) => a.id), ['c3']);
});

test('the last item: steps back to the one before it (both timings); an emptied list does nothing', () => {
  let h = advanceHarness();
  h.render([{ id: 'c1' }, { id: 'c2' }]);
  h.win._ccPrepareAdvance('c2'); h.win._ccAdvanceToNext('c2');
  assert.deepEqual(h.actions.map((a) => a.id), ['c1']);
  h = advanceHarness();
  h.render([{ id: 'c1' }, { id: 'c2' }]);
  h.win._ccPrepareAdvance('c2'); h.render([{ id: 'c1' }]); h.win._ccAdvanceToNext('c2');
  assert.deepEqual(h.actions.map((a) => a.id), ['c1']);
  h = advanceHarness();
  h.render([{ id: 'c1' }]);
  h.win._ccPrepareAdvance('c1'); h.render([]); h.win._ccAdvanceToNext('c1');
  assert.deepEqual(h.actions, []);
});

test('the reducer changes data only on Deny / Confirm: no next-clash pick, no camera side effect', () => {
  const block = slice('      case A.UPD_CLASH:', "            return Object.assign({},s,{clashes:confirmedClashes,issues:s.issues.concat([newIssue])});");
  assert.doesNotMatch(block, /setTimeout/);
  assert.doesNotMatch(block, /activeId/);
  assert.doesNotMatch(block, /_flyToElements|_ghostOthers|_highlightRefs/);
  // who / when / why on the clash; the denied memory follows in _ccAppReducer
  assert.match(block, /_ccDenyFields\(dClash, a\.u, a\._fromSync\)/);
});
