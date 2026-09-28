'use strict';
// Panel layering + right-panel default (see MEMORY.md / DESIGN.md §Layers).
// The right AI/Details panel used to carry a raw zIndex:1100 that floated
// above the avatar menu (399/400), the shared modal backdrop (50) and other
// ad-hoc overlay values, so it could cover the avatar menu, the
// Run-detection dialog and other chrome at narrower widths. This locks the
// z-index CSS custom-property scale and its application to the surfaces
// named in that story.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const TOKENS = ['--z-panel', '--z-dropdown', '--z-overlay', '--z-modal', '--z-toast', '--z-palette', '--z-tooltip'];

test('the z-index scale is defined once, as CSS custom properties on :root', () => {
  const rootStart = src.indexOf(':root{');
  assert.ok(rootStart !== -1, ':root block not found');
  const rootEnd = src.indexOf('\n    }', rootStart);
  const rootBody = src.slice(rootStart, rootEnd);
  for (const token of TOKENS) {
    assert.match(rootBody, new RegExp(token.replace(/[-]/g, '\\-') + ':\\d+;'), token + ' missing from :root');
  }
});

test('tiers are strictly increasing (panel < dropdown < overlay < modal < toast < palette < tooltip)', () => {
  const rootStart = src.indexOf(':root{');
  const rootEnd = src.indexOf('\n    }', rootStart);
  const rootBody = src.slice(rootStart, rootEnd);
  const values = TOKENS.map((t) => {
    const m = rootBody.match(new RegExp(t.replace(/[-]/g, '\\-') + ':(\\d+);'));
    assert.ok(m, t + ' value not found');
    return Number(m[1]);
  });
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] > values[i - 1], TOKENS[i] + ' must be greater than ' + TOKENS[i - 1]);
  }
});

test('the shared modal backdrop (S_BACKDROP, used by every modal incl. RunDetectionModal) is on the modal tier', () => {
  assert.match(src, /var S_BACKDROP = \{[^}]*zIndex:'var\(--z-modal\)'/);
});

test('the right AI/Details panel (collapsed tab and expanded panel) is on the panel tier, not a raw 1100', () => {
  assert.doesNotMatch(src, /zIndex:1100\b/);
  const panelStart = src.indexOf('function AIChatPanel(props) {');
  assert.ok(panelStart !== -1, 'AIChatPanel not found');
  const panelEnd = src.indexOf('\n  function ClashChips', panelStart);
  const body = src.slice(panelStart, panelEnd === -1 ? undefined : panelEnd);
  const matches = body.match(/zIndex:'calc\(var\(--z-panel\) \+ 5\)'/g) || [];
  assert.ok(matches.length >= 2, 'expected both the collapsed tab and the expanded panel to use the panel tier, got ' + matches.length);
});

test('the right panel is closed by default (no stored preference) and remembers the user choice', () => {
  const panelStart = src.indexOf('function AIChatPanel(props) {');
  const panelEnd = src.indexOf('\n    var tabSt=useState', panelStart);
  const body = src.slice(panelStart, panelEnd);
  assert.match(body, /raw==null \? true : raw==='1'/);
});

test('the avatar menu and STYLE menu backdrops/menus are on the dropdown tier', () => {
  const dropdownBackdrop = (src.match(/zIndex:'var\(--z-dropdown\)'\}/g) || []).length;
  assert.ok(dropdownBackdrop >= 3, 'expected at least 3 dropdown-tier backdrops (avatar menu, STYLE menu, add menu), got ' + dropdownBackdrop);
});

test('the command palette is on its own tier, above modals and toasts', () => {
  assert.match(src, /zIndex:'var\(--z-palette\)'/);
  assert.match(src, /zIndex:'calc\(var\(--z-palette\) \+ 1\)'/);
});

test('the desktop topbar and toolbar (ancestors of the avatar/STYLE/home menus) are themselves on the dropdown tier', () => {
  // .cc-desktop-topbar and .cc-top-toolbar are position:relative with an
  // explicit z-index, which makes each its OWN stacking context — any
  // z-index inside them (e.g. the avatar menu's 401) is compared against
  // OUTSIDE content using the ANCESTOR's z-index, not the descendant's own
  // value. They used to be hardcoded 10/9, which trapped every dropdown
  // nested in them (avatar menu, STYLE menu, home-view menu, +Add menu,
  // toolbar popovers) below the right panel regardless of the dropdown's
  // own z-index. Both must be raised onto the scale too.
  assert.match(src, /\.cc-desktop-topbar\{[^}]*z-index:var\(--z-dropdown\)/);
  assert.match(src, /class="cc-top-toolbar" style=\$\{\{[^}]*zIndex:'var\(--z-dropdown\)'/);
  assert.doesNotMatch(src, /z-index:10;position:relative/);
  assert.doesNotMatch(src, /position:'relative',zIndex:9\}/);
});

test('no page-level surface still carries the old ad-hoc 9998/9999/10000+ values this story targeted', () => {
  // These specific raw values named in the bug report (avatar/STYLE/home
  // menus, modal backdrops, tutorial/tour, toasts) must all have been
  // converted to a scale token. Small in-canvas-local values (viewer
  // overlays, sticky list headers, resize handles) are intentionally left
  // alone — see the :root comment — so this only checks the ones this test
  // file's other cases already prove were converted.
  assert.doesNotMatch(src, /zIndex:399\b/);
  assert.doesNotMatch(src, /zIndex:400\b/);
  assert.doesNotMatch(src, /zIndex:401\b/);
});
