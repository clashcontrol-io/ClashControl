// section-clipping.js outlineHalfExtents: the section-plane outline size.
// It must follow the model: proportional (not a huge sheet under one chair,
// not a stamp on a big building), rectangular on a long building, and wide
// enough that geometry above/below a horizontal cut still reads as inside
// the outline in perspective.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { outlineHalfExtents } = require('../section-clipping.js');

const ratio = (ext, gap) => outlineHalfExtents(ext, gap).map((h, i) => (2 * h) / ext[i]);

test('single chair: outline stays chair-sized (<= 1.5x per side), not metres of margin', () => {
  const [a, b] = outlineHalfExtents([0.5, 0.5], 0.45); // 0.9 m tall chair cut halfway
  assert.ok(2 * a <= 0.5 * 1.5 + 1e-12 && 2 * b <= 0.5 * 1.5 + 1e-12, `chair outline ${2 * a} x ${2 * b}`);
});

test('big building: margin scales with it (>= 4% per side), never a fixed small stamp', () => {
  const r = ratio([300, 120], 0);
  r.forEach((x) => assert.ok(x >= 1.08 - 1e-12 && x <= 1.5 + 1e-12, `ratio ${x}`));
});

test('long rectangular building keeps its aspect ratio (outline is not squared up)', () => {
  const ext = [200, 20];
  const [a, b] = outlineHalfExtents(ext, 12); // tall-ish, large gap saturates both clamps
  const aspect = a / b, model = ext[0] / ext[1];
  assert.ok(Math.abs(aspect - model) / model < 1e-12, `outline aspect ${aspect} vs model ${model}`);
});

test('short side gets a 2 x gap margin inside the 4%..25% band (perspective cover)', () => {
  const [a, b] = outlineHalfExtents([46, 43], 4.75); // the reported furniture model, cut at 90%
  assert.ok(Math.abs(b - (21.5 + 9.5)) < 1e-9, `short side ${b}`);
  assert.ok(a - 23 >= 9.5 - 1e-9, `long side margin ${a - 23}`);
});

test('margin clamped to 4% .. 25% of each axis', () => {
  assert.deepStrictEqual(ratio([10, 10], 0).map((x) => +x.toFixed(12)), [1.08, 1.08]);
  assert.deepStrictEqual(ratio([10, 10], 100).map((x) => +x.toFixed(12)), [1.5, 1.5]);
});

test('flat / degenerate extent still gets a visible band; no NaN', () => {
  const [a, b] = outlineHalfExtents([20, 0], 0);
  assert.ok(a > 10 && b > 0 && Number.isFinite(b), `${a}, ${b}`);
  outlineHalfExtents([0, 0], 0).forEach((h) => assert.ok(Number.isFinite(h) && h >= 0));
});
