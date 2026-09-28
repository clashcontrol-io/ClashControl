'use strict';
// Structural checks that the unified undo/redo manager (tests/undo-stack.test.js
// covers its actual logic) is wired into the places the task requires:
// reducer-level tracking for section changes, model-scoped visibility
// actions pushing undo entries, and Ctrl/Cmd+Z / Shift+Z / Y key handling
// that stays out of the way of text inputs and of the existing measurement
// undo toggle.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

test('reducer() tracks section-plane/box dispatches onto the unified undo stack', () => {
  const reducerStart = html.indexOf('function reducer(s,a) {');
  assert.ok(reducerStart !== -1);
  const reducerHead = html.slice(reducerStart, reducerStart + 800);
  assert.match(reducerHead, /_ccBuildUndoEntry\(s,\s*a\)/);
  assert.match(reducerHead, /_ccPushUndoable\(_ccUndoEntry\)/);
});

test('_ccBuildUndoEntry covers SECTION, SECTION_CUSTOM and SECTION_BOX, deliberately skips measurement actions, and bails out on replayed actions', () => {
  const start = html.indexOf('function _ccBuildUndoEntry(prevState, a) {');
  const end = html.indexOf('\n\n  // How close the orbit', start);
  assert.ok(start !== -1 && end !== -1);
  const body = html.slice(start, end);
  assert.match(body, /a\._ccReplay/); // guards against re-tracking undo/redo's own redispatch
  ['A.SECTION:', 'A.SECTION_CUSTOM:', 'A.SECTION_BOX:'].forEach((needle) => {
    assert.ok(body.includes(needle), `missing case ${needle}`);
  });
  assert.doesNotMatch(body, /A\.ADD_MEASUREMENT/);
  assert.doesNotMatch(body, /A\.DEL_MEASUREMENT/);
  // Section entries share a coalesceKey so a slider/TransformControls drag
  // (which can dispatch many SECTION/SECTION_CUSTOM actions per gesture)
  // collapses into one undo step instead of flooding the stack.
  assert.match(body, /coalesceKey:'section'/);
  assert.match(body, /coalesceKey:'section-box'/);
});

test('window._ccTempHide/_ccIsolate/_ccTempUnhide/_ccUnisolate each push an undo entry via their *Core counterpart', () => {
  const hideWrapper = html.slice(html.indexOf('window._ccTempHide = function(targets) {'), html.indexOf('function _ccTempUnhideCore'));
  assert.match(hideWrapper, /_ccPushUndoable\(\{label:'Hide'/);
  assert.match(hideWrapper, /_ccTempHideCore\(targets\)/);

  const unhideWrapper = html.slice(html.indexOf('window._ccTempUnhide = function() {'), html.indexOf('// ghostOthers() already understands'));
  assert.match(unhideWrapper, /_ccPushUndoable\(\{label:'Show hidden'/);

  const isolateWrapper = html.slice(html.indexOf('window._ccIsolate = function(expressIds) {'), html.indexOf('window._ccUnisolate = function() {'));
  assert.match(isolateWrapper, /_ccPushUndoable\(\{label:'Isolate'/);
  assert.match(isolateWrapper, /_ccIsolateCore\(expressIds\)/);

  const unisolateWrapper = html.slice(html.indexOf('window._ccUnisolate = function() {'), html.indexOf('window._ccUnisolate = function() {') + 500);
  assert.match(unisolateWrapper, /_ccPushUndoable\(\{label:'Unisolate'/);
});

test('empty-space click no longer ends isolation (unghostAll() removed from that path)', () => {
  const idx = html.indexOf('Empty click (no geometry hit at all)');
  assert.ok(idx !== -1);
  const block = html.slice(idx, idx + 400);
  assert.doesNotMatch(block, /unghostAll\(\);/);
});

test('the I key is a real toggle: restores when already isolated, otherwise isolates the current model-scoped selection', () => {
  const idx = html.indexOf("if(e.key==='i'&&!ctrl){");
  assert.ok(idx !== -1);
  const block = html.slice(idx, idx + 700);
  assert.match(block, /window\._ccIsIsolated/);
  assert.match(block, /window\._ccSelectedRefs/);
});

test('Ctrl/Cmd+Z tries the existing measurement-undo toggle first, then falls back to the unified undo; Ctrl/Cmd+Shift+Z and Ctrl/Cmd+Y redo; all three live after the inInput guard', () => {
  const guardIdx = html.indexOf('if(inInput) return;');
  const measIdx = html.indexOf('if(window._ccUndoMeasurement && window._ccUndoMeasurement())');
  const undoIdx = html.indexOf('if(window._ccUndo && window._ccUndo())');
  const redoIdx = html.indexOf('if(window._ccRedo && window._ccRedo())');
  assert.ok(guardIdx !== -1 && measIdx !== -1 && undoIdx !== -1 && redoIdx !== -1);
  assert.ok(measIdx > guardIdx, 'measurement undo must come after the inInput guard');
  assert.ok(undoIdx > measIdx, 'unified undo must be tried after (as a fallback to) measurement undo');
  assert.ok(redoIdx > guardIdx, 'redo handling must come after the inInput guard');
});

test('the toolbar renders Undo/Redo buttons that disable when the stack is empty and mirror window._ccUndoInfo via a cc-undo-change listener', () => {
  const idx = html.indexOf('Undo / redo (visibility, section changes; measurement undo stays on its own toggle');
  assert.ok(idx !== -1);
  const block = html.slice(idx, idx + 1600);
  assert.match(block, /window\._ccUndo\(\)/);
  assert.match(block, /window\._ccRedo\(\)/);
  assert.match(block, /disabled=\$\{!undoInfo\.canUndo\}/);
  assert.match(block, /disabled=\$\{!undoInfo\.canRedo\}/);
  assert.ok(html.includes("window.addEventListener('cc-undo-change', sync)"));
});

test('the context menu and Details-panel visibility actions are model-scoped through window._ccSelectedRefs', () => {
  const ctxIdx = html.indexOf('right-clicked element is part of the');
  assert.ok(ctxIdx !== -1);
  const ctxBlock = html.slice(ctxIdx, ctxIdx + 1400);
  assert.match(ctxBlock, /window\._ccSelectedRefs/);
  assert.match(ctxBlock, /modelId:\s*ctxMenu\.modelId/);

  const detailsIdx = html.indexOf('Visibility actions — model-scoped');
  assert.ok(detailsIdx !== -1);
  const detailsBlock = html.slice(detailsIdx, detailsIdx + 1200);
  assert.match(detailsBlock, /window\._ccSelectedRefs/);
});

test('the STYLE menu no longer renders a full-screen click-swallowing backdrop, and closes via Esc / an outside pointerdown instead', () => {
  const idx = html.indexOf("var styleMenuRef = useRef(null);");
  assert.ok(idx !== -1);
  const block = html.slice(idx, idx + 2200);
  assert.match(block, /document\.addEventListener\('keydown', onKey\)/);
  assert.match(block, /document\.addEventListener\('pointerdown', onDocPointerDown\)/);
  assert.doesNotMatch(block, /position:'fixed',inset:0,zIndex:'var\(--z-dropdown\)'/);
});
