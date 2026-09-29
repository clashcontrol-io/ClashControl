// Navigation has no post-release inertia (removed 2026-09-29 at the user's
// request — the coast after letting go of a rotate/pan was annoying). The
// camera must stop the moment the gesture stops; guard against it creeping
// back in (tickInertia / velocity sampling / the "Smooth navigation" pref).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('no inertia step in the orbit controller or the render loop', () => {
  assert.ok(!/tickInertia/.test(html), 'orbit.tickInertia must not exist');
  assert.ok(!/_vel\.(theta|phi|panX|panY)/.test(html), 'no rotate/pan velocity sampling');
});

test('no "Smooth navigation" preference or setting', () => {
  assert.ok(!/smoothNav/.test(html));
  assert.ok(!/Smooth navigation/.test(html));
});
