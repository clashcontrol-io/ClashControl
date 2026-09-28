'use strict';
// Two NL "project" command bugs in index.html's processNLCommand /
// saveProject:
//  1. "open project file" (or "open project"/"load project") used to fall
//     straight into the swProjMatch regex, which greedily captured the
//     trailing word "file" as a project NAME and replied
//     `No project named "file".` instead of opening the .ccproject file
//     picker. A dedicated no-name guard must run first and call
//     loadProject(d).
//  2. saveProject() downloaded the file twice for one "save project"
//     command (reachable from more than one caller in the same turn) and
//     used a bare .json extension instead of .ccproject. Fixed with a
//     debounce guard + the correct extension.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

test('a no-name "open/load project [file]" guard runs before the switch-to-named-project regex and opens the file picker', () => {
  const guardIdx = html.indexOf('/^\\s*(?:open|load)\\s+(?:the\\s+)?project(?:\\s+file)?\\s*$/i.test(raw)');
  const swProjIdx = html.indexOf('var swProjMatch = raw.match(');
  assert.ok(guardIdx !== -1, 'no-name open/load project guard not found');
  assert.ok(swProjIdx !== -1, 'swProjMatch regex not found');
  assert.ok(guardIdx < swProjIdx, 'the no-name guard must run BEFORE swProjMatch, or "file" gets captured as a project name');
  const guardBlock = html.slice(guardIdx, swProjIdx);
  assert.match(guardBlock, /loadProject\(d\)/, 'the guard must open the file picker via loadProject(d)');
});

test('the no-name guard regex matches "open project file", "open project", and "load project", not a named switch', () => {
  const re = /^\s*(?:open|load)\s+(?:the\s+)?project(?:\s+file)?\s*$/i;
  assert.ok(re.test('open project file'));
  assert.ok(re.test('open project'));
  assert.ok(re.test('load project'));
  assert.ok(re.test('load the project file'));
  assert.ok(!re.test('open project MEP Tower'), 'a real named-project switch must NOT match the no-name guard');
});

test('saveProject downloads a .ccproject file, not bare .json', () => {
  assert.match(html, /a\.download = 'project-'\+new Date\(\)\.toISOString\(\)\.slice\(0,10\)\+'\.ccproject';/);
  assert.doesNotMatch(html, /a\.download = 'project-'\+new Date\(\)\.toISOString\(\)\.slice\(0,10\)\+'\.json';/);
});

test('saveProject has a re-entrancy/debounce guard against firing twice for one command', () => {
  const fnStart = html.indexOf('function saveProject(s) {');
  assert.ok(fnStart !== -1);
  const fnEnd = html.indexOf('\n  }', fnStart);
  const fnBody = html.slice(fnStart, fnEnd);
  assert.match(fnBody, /_ccLastProjectSaveAt/, 'expected a timestamp-based guard variable');
  assert.match(fnBody, /if \(now - _ccLastProjectSaveAt < 1000\) return;/);
});

test('saveProject actually deduplicates two rapid calls (behavioral, not just source pattern)', () => {
  const fnStart = html.indexOf('var _ccLastProjectSaveAt = 0;');
  const bodyStart = html.indexOf('function saveProject(s) {', fnStart);
  const bodyEnd = html.indexOf('\n  }', bodyStart) + '\n  }'.length;
  const src = html.slice(fnStart, bodyEnd);

  let clicks = 0;
  function FakeDate() {}
  FakeDate.now = () => 1000; // frozen "now" simulates two calls in the same tick/turn
  FakeDate.prototype.toISOString = () => '2026-01-01T00:00:00.000Z';
  const sandbox = {
    Date: FakeDate,
    _ccSerializeProject: () => ({}),
    Blob: function () {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    document: { createElement: () => ({ click() { clicks++; }, set href(v) {}, set download(v) {} }) },
    CC_VERSION: { v: 'test' },
    JSON: JSON,
  };
  const fn = new Function(...Object.keys(sandbox), src + '; return saveProject;')(...Object.values(sandbox));
  fn({});
  fn({}); // second call within the same debounce window
  assert.equal(clicks, 1, 'a second save-project call within 1s of the first must be a no-op');
});
