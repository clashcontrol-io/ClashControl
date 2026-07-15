'use strict';
// Locks _ccModelMatrixGrid (index.html): the pure aggregation behind the
// Model × model clash matrix. Folds a clash list into a symmetric
// models×models grid of {count, worst-severity}.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = src.indexOf('  function _ccModelMatrixGrid(');
assert.ok(start >= 0, '_ccModelMatrixGrid not found');
const guard = src.indexOf('  if (typeof window', start);
assert.ok(guard > start, 'end marker not found');
const _ccModelMatrixGrid = new Function(src.slice(start, guard) + '; return _ccModelMatrixGrid;')();

const models = [{ id: 'S' }, { id: 'M' }, { id: 'A' }];
function clash(a, b, sev, extra) {
  return Object.assign({ modelAId: a, modelBId: b, aiSeverity: sev }, extra || {});
}

test('empty clash list yields an all-zero symmetric grid', () => {
  const { grid, total } = _ccModelMatrixGrid(models, []);
  assert.equal(total, 0);
  assert.equal(grid.length, 3);
  for (const row of grid) for (const cell of row) assert.deepEqual(cell, { count: 0, worst: 0 });
});

test('cross-model clashes fill both symmetric cells and the total counts pairs once', () => {
  const items = [
    clash('S', 'M', 'critical'),
    clash('M', 'S', 'major'),   // reverse order, same pair
    clash('M', 'A', 'minor'),
  ];
  const { grid, total } = _ccModelMatrixGrid(models, items);
  // total counts each clash once (not the mirrored cell)
  assert.equal(total, 3);
  assert.equal(grid[0][1].count, 2);          // S×M
  assert.equal(grid[1][0].count, 2);          // symmetric
  assert.equal(grid[1][2].count, 1);          // M×A
  assert.equal(grid[2][1].count, 1);          // symmetric
  assert.equal(grid[0][2].count, 0);          // S×A clean
});

test('worst severity wins per cell (critical > major > minor > info)', () => {
  const { grid } = _ccModelMatrixGrid(models, [
    clash('S', 'M', 'minor'), clash('S', 'M', 'critical'), clash('S', 'M', 'major'),
  ]);
  assert.equal(grid[0][1].worst, 4);          // critical
  assert.equal(grid[1][0].worst, 4);
});

test('single/same-model clashes land on the diagonal', () => {
  const { grid, total } = _ccModelMatrixGrid(models, [
    clash('S', null, 'major'),   // single-element clash, no modelB
    clash('M', 'M', 'minor'),    // explicit same-model
  ]);
  assert.equal(grid[0][0].count, 1);
  assert.equal(grid[1][1].count, 1);
  assert.equal(total, 2);
});

test('clashes with an unknown model id are skipped, denied clashes ignored', () => {
  const { grid, total } = _ccModelMatrixGrid(models, [
    clash('ZZ', 'M', 'critical'),               // unknown A → skip
    clash('S', 'M', 'major', { status: 'denied' }),  // denied → ignore
    clash('S', 'A', 'minor'),
  ]);
  assert.equal(total, 1);
  assert.equal(grid[0][2].count, 1);            // only S×A survived
  assert.equal(grid[0][1].count, 0);
});
