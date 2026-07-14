'use strict';
// Locks that every element-search call site was migrated onto the shared
// _elMatchesSearch (index.html) instead of its own duplicated inline check -
// and, separately, that the default "Hierarchy" (spatial) Navigator view
// actually filters by the search box at all, which it previously didn't
// (stEls/noSt were rendered unfiltered - the search input had zero effect
// in the view every user sees first).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('no stale duplicated inline matchers remain (the old 2-3 field name/ifcType/expressId-only check)', () => {
  // The exact fragment every duplicate used to share, character for character.
  const stale = "(p.name||'').toLowerCase().indexOf(q)!==-1||(p.ifcType||'').toLowerCase().indexOf(q)!==-1";
  assert.ok(src.indexOf(stale) === -1, 'a duplicated inline matcher was left behind instead of using _elMatchesSearch');
});

test('_findAndHighlightElements (Items Finder, used by NL commands) uses the shared matcher', () => {
  const start = src.indexOf('_findAndHighlightElements = function(query, models) {');
  assert.ok(start !== -1);
  const end = src.indexOf('\n      };', start);
  const fnSrc = src.slice(start, end);
  assert.ok(/_elMatchesSearch\(el,\s*q\)/.test(fnSrc));
});

test('NavigatorPanel: the spatial (Hierarchy, default) view now filters elements by the search box', () => {
  const panelStart = src.indexOf('function NavigatorPanel(props) {');
  assert.ok(panelStart !== -1);
  const spatialStart = src.indexOf("viewMode==='spatial' && html`<ul", panelStart);
  assert.ok(spatialStart !== -1, 'spatial view block not found');
  const spatialEnd = src.indexOf("viewMode==='tree' && html`<ul", spatialStart);
  assert.ok(spatialEnd !== -1, 'tree view block (used as the end boundary) not found');
  const spatialSrc = src.slice(spatialStart, spatialEnd);
  assert.ok(/var q = treeSearch\.toLowerCase\(\);/.test(spatialSrc), 'spatial view must compute q from treeSearch - it previously never did');
  const matches = spatialSrc.match(/_elMatchesSearch\(el,\s*q\)/g) || [];
  assert.ok(matches.length >= 2, 'both the storey-grouped and no-storey element lists must filter through _elMatchesSearch');
});

test('NavigatorPanel: the tree ("Flat list") view and its keyboard-nav duplicate both use the shared matcher', () => {
  const panelStart = src.indexOf('function NavigatorPanel(props) {');
  const panelEnd = src.indexOf('\n  function ', panelStart + 40);
  const panelSrc = src.slice(panelStart, panelEnd === -1 ? panelStart + 30000 : panelEnd);
  const matches = panelSrc.match(/_elMatchesSearch\(el,\s*q\)/g) || [];
  // spatial view (2) + tree view render (2) + tree view keyboard-nav duplicate (2) = 6
  assert.ok(matches.length >= 6, 'expected _elMatchesSearch to be used at least 6 times across NavigatorPanel (spatial x2, tree render x2, keyboard-nav x2), found ' + matches.length);
});

test('search result caps are raised while actively searching (not stuck at 200/100 forever)', () => {
  const panelStart = src.indexOf('function NavigatorPanel(props) {');
  const panelEnd = src.indexOf('\n  function ', panelStart + 40);
  const panelSrc = src.slice(panelStart, panelEnd === -1 ? panelStart + 30000 : panelEnd);
  assert.ok(/q\s*\?\s*1000\s*:\s*200/.test(panelSrc), 'the 200-element storey cap must widen to 1000 while a search query is active');
});
