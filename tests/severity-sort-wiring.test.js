'use strict';
// Bug 8: the "Severity (high first)" sort option (severity_desc) was
// reversed -- it put info-severity clashes before critical ones. This
// extracts the two comparator functions by source markers and evaluates
// them directly.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractComparator(name) {
  const marker = name + ': function(a,b){';
  const start = src.indexOf(marker);
  assert.ok(start !== -1, name + ' comparator not found');
  const bodyStart = start + marker.length;
  const end = src.indexOf('},', bodyStart);
  const body = src.slice(bodyStart, end);
  // eslint-disable-next-line no-new-func
  return new Function('a', 'b', '_ccDeterministicSeverity', body);
}

function clash(aiSeverity) { return { aiSeverity: aiSeverity }; }

test('severity_desc ("Severity (high first)") sorts critical before info', () => {
  const cmp = extractComparator('severity_desc');
  const critical = clash('critical'), info = clash('info');
  assert.ok(cmp(critical, info, () => 'info') < 0, 'critical must sort before info under "high first"');
  assert.ok(cmp(info, critical, () => 'info') > 0);
});

test('severity_asc ("Severity (low first)") sorts info before critical', () => {
  const cmp = extractComparator('severity_asc');
  const critical = clash('critical'), info = clash('info');
  assert.ok(cmp(info, critical, () => 'info') < 0, 'info must sort before critical under "low first"');
  assert.ok(cmp(critical, info, () => 'info') > 0);
});

test('severity_desc produces the full critical > major > minor > info order', () => {
  const cmp = extractComparator('severity_desc');
  const items = [clash('info'), clash('critical'), clash('minor'), clash('major')];
  items.sort(cmp);
  assert.deepEqual(items.map((c) => c.aiSeverity), ['critical', 'major', 'minor', 'info']);
});
