'use strict';
// Bug 7: denying a clash must jump to the NEXT clash in the (sorted)
// visible list, not always back to the first one. The old code built
// dVisible by already filtering OUT the clash being denied, so
// dVisible.indexOf(dClash) was always -1 -> dIdx forced to 0 -> "next"
// always resolved to whatever was first in the list.
//
// The logic lives inline inside the UPD_CLASH reducer case (React closure
// deps aside, it's plain data computation), so this extracts that exact
// block by source markers and evaluates it against synthetic state,
// matching the extraction pattern other *-wiring tests use for index.html.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const start = src.indexOf('case A.UPD_CLASH:');
assert.ok(start !== -1, 'UPD_CLASH reducer case not found');
const markerEnd = "activeId:dNextId});\n          }";
const endIdx = src.indexOf(markerEnd, start);
assert.ok(endIdx !== -1, 'end of the denied-clash branch not found');
const block = src.slice(start, endIdx + markerEnd.length);

assert.ok(block.includes('dAllVisible'), 'expected fix marker dAllVisible not present -- source may have drifted');

// Build a runnable function computing just {status, activeId} from (s, a),
// with the async side-effect calls (setTimeout/_itemRefs/etc.) stubbed out.
function buildReducerSlice() {
  var body = block
    .replace('case A.UPD_CLASH:', '')
    .replace(/setTimeout\(function\(\)\{[\s\S]*?\},100\);/, ';'); // drop the async fly-to/highlight side effect
  body += '\n}\nreturn null;'; // close if(a.u&&a.u.status==='denied'){ left open by the slice
  // eslint-disable-next-line no-new-func
  return new Function('s', 'a', 'SORT_FNS', '_saveDeniedClash', body);
}

test('denying a clash advances activeId to the NEXT clash in sorted order, not the first', () => {
  var run = buildReducerSlice();
  var clashes = [
    { id: 'c1', status: 'open' },
    { id: 'c2', status: 'open' },
    { id: 'c3', status: 'open' },
  ];
  var s = { clashes: clashes, clashSortBy: null };
  var a = { id: 'c2', u: { status: 'denied' } };
  var result = run(s, a, {}, function(){});
  assert.equal(result.activeId, 'c3', 'expected the clash after the denied one, not the first');
});

test('denying the last clash in the list falls back to the new last remaining clash', () => {
  var run = buildReducerSlice();
  var clashes = [
    { id: 'c1', status: 'open' },
    { id: 'c2', status: 'open' },
    { id: 'c3', status: 'open' },
  ];
  var s = { clashes: clashes, clashSortBy: null };
  var a = { id: 'c3', u: { status: 'denied' } };
  var result = run(s, a, {}, function(){});
  assert.equal(result.activeId, 'c2');
});

test('denying the first clash advances to the second, respecting an active sort', () => {
  var run = buildReducerSlice();
  var clashes = [
    { id: 'c1', status: 'open', n: 3 },
    { id: 'c2', status: 'open', n: 1 },
    { id: 'c3', status: 'open', n: 2 },
  ];
  var s = { clashes: clashes, clashSortBy: 'byN' };
  var SORT_FNS = { byN: function(x, y) { return x.n - y.n; } };
  // Sorted order by n: c2(1), c3(2), c1(3). Denying c2 (first in sorted
  // order) should advance to c3, not c1 (the array's own first element).
  var a = { id: 'c2', u: { status: 'denied' } };
  var result = run(s, a, SORT_FNS, function(){});
  assert.equal(result.activeId, 'c3');
});
