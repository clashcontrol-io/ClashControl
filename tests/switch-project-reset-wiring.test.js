'use strict';
// Bug 9: switching projects must reset ALL per-project state, not just
// models/clashes/issues -- otherwise project A's assignment rules kept
// auto-assigning project B's newly detected clashes, and project A's run
// history/selection sets/search sets/changelog bled into project B's UI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('_switchProject resets runHistory, selectionSets, searchSets, assignmentRules, comments and changelog', () => {
  const start = src.indexOf('function _switchProject(newProjId, s, d) {');
  assert.ok(start !== -1, '_switchProject not found');
  const end = src.indexOf('\n  }\n', start);
  const body = src.slice(start, end);

  const loadStateStart = body.indexOf('d({t:A.LOAD_PROJECT_STATE, data:{');
  assert.ok(loadStateStart !== -1, 'LOAD_PROJECT_STATE dispatch not found in _switchProject');
  const loadStateEnd = body.indexOf('}});', loadStateStart);
  const payload = body.slice(loadStateStart, loadStateEnd);

  ['runHistory:[]', 'selectionSets:[]', 'searchSets:[]', 'assignmentRules:[]', 'comments:[]', 'changelog:[]'].forEach((field) => {
    assert.ok(payload.includes(field), '_switchProject must reset ' + field);
  });
});
