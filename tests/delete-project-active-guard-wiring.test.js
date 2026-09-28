'use strict';
// Bug 10: two deleteProject() implementations existed with different
// behaviour -- the project-panel one (~index.html:17358) always switched
// to list[0] after deleting ANY project, while the avatar-menu one
// (~index.html:36589) only switched when the deleted project was the
// active one. Unify to the correct (avatar-menu) behaviour: only switch
// away when the project actually being deleted was active.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractDeleteProjectFns() {
  const matches = [];
  const re = /function deleteProject\(id\)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0, i = src.indexOf('{', m.index);
    const start = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    matches.push(src.slice(m.index, i));
  }
  return matches;
}

test('there are exactly two deleteProject(id) implementations (project panel + avatar menu)', () => {
  const fns = extractDeleteProjectFns();
  assert.equal(fns.length, 2, 'expected exactly two deleteProject(id) implementations');
});

test('both deleteProject implementations only switch away when the DELETED project was the active one', () => {
  const fns = extractDeleteProjectFns();
  fns.forEach((fn, i) => {
    assert.ok(
      fn.includes('id === s.activeProject'),
      'deleteProject implementation #' + (i + 1) + ' must guard the switch with id === s.activeProject:\n' + fn
    );
  });
});
