'use strict';

// Regression locks for the five-hotfix cache/instancing incident fixed by
// PR #598. This deliberately does not refactor the fragile restore path: it
// asserts the two invariants in the production source that prevent collisions.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = source.indexOf('function _geoDeserialize(cached) {');
const end = source.indexOf('  function idbDeleteProjectData(projectId) {', start);
assert.notEqual(start, -1);
assert.notEqual(end, -1);
const restore = source.slice(start, end);

test('legacy cache fallback keys include the absolute millimetre-rounded bbox', () => {
  assert.match(restore, /var _bb = \(md\.bbox \|\| \[\]\)\.map\(function\(x\)\{ return Math\.round\(x \* 1000\); \}\)\.join\(','\)/);
  assert.match(restore, /_iHash\.toString\(36\) \+ ':' \+ _bb \+ ':'/);
});

test('modern cache restores retain the canonical geometry id for future saves', () => {
  assert.match(restore, /mesh\.userData\._instKey = 'gid:' \+ md\.gid/);
  assert.match(restore, /mesh\.userData\._geoExpId = md\.gid/);
});
