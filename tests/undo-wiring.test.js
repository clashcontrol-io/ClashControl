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

// A single clash's review decision (UPD_CLASH status/assignee/priority) is on
// the unified stack like the group action (BATCH_UPD_CLASH with ids) — run
// the real _ccBuildUndoEntry against a stub dispatch.
function loadBuildUndoEntry(dispatched) {
  const vm = require('node:vm');
  const start = html.indexOf('function _ccBuildUndoEntry(prevState, a) {');
  const end = html.indexOf('\n\n  // How close the orbit', start);
  const A = { SECTION: 'SECTION', SECTION_CUSTOM: 'SECTION_CUSTOM', SECTION_BOX: 'SECTION_BOX', BATCH_UPD_CLASH: 'BATCH_UPD_CLASH', UPD_CLASH: 'UPD_CLASH', CLASH_BATCH_RESTORE: 'CLASH_BATCH_RESTORE' };
  const ctx = { A, window: { _ccDispatch: (a) => dispatched.push(a) } };
  vm.runInNewContext(html.slice(start, end) + '\nthis._ccBuildUndoEntry = _ccBuildUndoEntry;', ctx);
  return ctx._ccBuildUndoEntry;
}

test('a single clash status edit is undoable: undo restores the previous fields via CLASH_BATCH_RESTORE, redo replays the edit', () => {
  const out = [];
  const build = loadBuildUndoEntry(out);
  const prev = { clashes: [{ id: 'c1', status: 'open', assignee: 'x', linkedIssueId: null }, { id: 'c2', status: 'open' }], issues: [{ id: 'i0' }] };
  const act = { t: 'UPD_CLASH', id: 'c1', u: { status: 'confirmed' } };
  const e = build(prev, act);
  assert.ok(e, 'status edit produces an undo entry');
  e.undo();
  assert.equal(out[0].t, 'CLASH_BATCH_RESTORE');
  assert.equal(out[0]._ccReplay, true);
  assert.deepEqual(Object.keys(out[0].prev), ['c1']);
  assert.equal(out[0].prev.c1.status, 'open');
  assert.ok('linkedIssueId' in out[0].prev.c1, 'a confirm-created issue link is undone too');
  assert.deepEqual(Object.keys(out[0].keepIssueIds), ['i0'], 'issues created by the edit are dropped on undo');
  e.redo();
  assert.equal(out[1].t, 'UPD_CLASH');
  assert.equal(out[1]._ccReplay, true);
  assert.equal(out[1].u.status, 'confirmed');
  // replays never re-track, remote merges and bookkeeping fields stay off the stack
  assert.equal(build(prev, Object.assign({}, act, { _ccReplay: true })), null);
  assert.equal(build(prev, Object.assign({}, act, { _fromSync: true })), null);
  assert.equal(build(prev, { t: 'UPD_CLASH', id: 'c1', u: { aiTitle: 't' } }), null);
  assert.equal(build(prev, { t: 'UPD_CLASH', id: 'missing', u: { status: 'denied' } }), null);
  // typing an assignee coalesces per clash; a status edit does not
  assert.equal(build(prev, { t: 'UPD_CLASH', id: 'c1', u: { assignee: 'ab' } }).coalesceKey, 'clash-assignee:c1');
  assert.ok(!e.coalesceKey);
});

test('undoing a deny forgets the denied pair so the next run does not drop it again', () => {
  // The denied memory is project state kept in step with the clash list by
  // _ccAppReducer for every status change (deny, reopen, undo, sync) —
  // clash-reconciliation-core.js updateDeniedMemory (tests/denied-memory.test.js).
  assert.match(html, /function _ccAppReducer\(s, a\) \{ return _ccFollowDeniedMemory\(s, /);
  const i = html.indexOf('var _CC_DENY_FOLLOW =');
  assert.match(html.slice(i, i + 120), /CLASH_BATCH_RESTORE:1/);
  // the undo entry captures the deny's who / when / why so undo clears them
  assert.match(html, /concat\(\['linkedIssueId', 'aiSignals', 'deniedReason', 'deniedBy', 'deniedAt'\]\)/);
});
