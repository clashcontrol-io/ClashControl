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
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  // every key of the project / view / session scopes starts from its default
  assert.match(body, /d\(\{t:A\.LOAD_PROJECT_STATE, data:Object\.assign\(_ccScopeDefaults\(\['project','view','session'\]\), \{switchingProject:true\}\)\}\);/);
  const reg = src.slice(src.indexOf("    put('project', "), src.indexOf("    put('view', "));
  ['runHistory', 'selectionSets', 'searchSets', 'assignmentRules', 'comments', 'changelog'].forEach((field) => {
    assert.match(reg, new RegExp('\\b' + field + '\\b'), field + ' must be project-scoped (reset on switch)');
  });
});
