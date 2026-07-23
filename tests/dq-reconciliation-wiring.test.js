'use strict';
// Locks that DataQualityPanel (index.html) actually wires the reconciliation
// functions into runChecks() and renders a "Since last run" summary.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const panelStart = src.indexOf('function DataQualityPanel(props) {');
assert.ok(panelStart !== -1);
const runChecksStart = src.indexOf('function runChecks() {', panelStart);
const runChecksEnd = src.indexOf('\n    }', runChecksStart);
const runChecksSrc = src.slice(runChecksStart, runChecksEnd);

test('runChecks() flattens all four engines into one map and diffs against the previous run', () => {
  assert.ok(/window\._ccFlattenDQCounts\(\{qc:newQc, bim:newBim, ils:newIls, rvb:newRvb\}\)/.test(runChecksSrc));
  assert.ok(/window\._ccDiffDQCounts\(flatNow, prevDqCounts\)/.test(runChecksSrc));
  assert.ok(/setPrevDqCounts\(flatNow\)/.test(runChecksSrc), 'this run\'s snapshot must become "previous" for the next run');
});

test('the delta is null on the first run (no previous snapshot to compare against)', () => {
  assert.ok(/prevDqCounts && typeof window\._ccDiffDQCounts === 'function' \? window\._ccDiffDQCounts\(flatNow, prevDqCounts\) : null/.test(runChecksSrc));
});

test('a "Since last run" summary renders with expandable worse/better details', () => {
  const summaryStart = src.indexOf('dqDelta && (dqDelta.worse.length>0', panelStart);
  assert.ok(summaryStart !== -1, 'delta summary block not found');
  const nearby = src.slice(summaryStart, summaryStart + 1200);
  // Text goes through _cc_t() for i18n — assert the English fallback + key,
  // not raw literal adjacency to the closing tag.
  assert.ok(/Since last run:/.test(nearby));
  assert.ok(/_cc_t\('dq\.worse','\{n\} worse'/.test(nearby));
  assert.ok(/_cc_t\('dq\.better','\{n\} better'/.test(nearby));
  assert.ok(nearby.indexOf("toggleExp('dq_delta')") !== -1, 'must reuse the existing expanded-section state pattern');
});
