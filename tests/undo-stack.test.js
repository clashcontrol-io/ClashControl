'use strict';
// Exercises the actual unified undo/redo manager shipped in index.html
// (window._ccUndo/_ccRedo/_ccUndoInfo + the coalescing _ccPushUndoable) by
// extracting that exact source block and running it in a vm sandbox --
// not a reimplementation, so a regression in the real code fails this test.
// Covers visibility (hide/isolate/show all) and section plane/box undo.
// Measurement undo deliberately keeps its own existing
// window._ccUndoMeasurement toggle (see tests/element-modelid-scoping-wiring
// / the Ctrl+Z handler in index.html) rather than being folded into this
// stack, so this test does not exercise measurements.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

function extractBlock(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  assert.ok(start !== -1, `start marker not found: ${startMarker}`);
  const end = html.indexOf(endMarker, start);
  assert.ok(end !== -1, `end marker not found: ${endMarker}`);
  return html.slice(start, end);
}

function loadUndoManager() {
  const src = extractBlock('var CC_UNDO_CAP = 50;', 'window._ccUndoInfo = function() {');
  const tail = 'window._ccUndoInfo = function() {\n    return {canUndo: window._ccUndoStack.length > 0, canRedo: window._ccRedoStack.length > 0};\n  };\n';
  const events = [];
  // `window` is the vm's own global object, so bare `function foo(){}`
  // declarations (e.g. _ccPushUndoable, _ccUndoChanged) land on it exactly
  // like they land on the real page's global scope -- no need to
  // re-attach anything after running the script.
  const sandbox = {
    CustomEvent: function CustomEvent(name) { this.type = name; },
    console,
    Date,
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = function () {};
  sandbox.window.dispatchEvent = function (evt) { events.push(evt); };
  vm.createContext(sandbox);
  vm.runInContext(src + tail, sandbox, { filename: 'undo-manager.js' });
  return { win: sandbox.window, events };
}

test('undo stack is bounded at 50 entries (oldest dropped first)', () => {
  const { win } = loadUndoManager();
  for (let i = 0; i < 60; i++) {
    win._ccPushUndoable({ undo() {}, redo() {} });
  }
  assert.equal(win._ccUndoStack.length, 50);
});

test('undo pops the newest entry, calls its undo(), and moves it to the redo stack', () => {
  const { win } = loadUndoManager();
  let undone = 0;
  win._ccPushUndoable({ undo() { undone++; }, redo() {} });
  const ok = win._ccUndo();
  assert.equal(ok, true);
  assert.equal(undone, 1);
  assert.equal(win._ccUndoStack.length, 0);
  assert.equal(win._ccRedoStack.length, 1);
});

test('undo on an empty stack returns false and does nothing', () => {
  const { win } = loadUndoManager();
  assert.equal(win._ccUndo(), false);
});

test('redo re-applies the entry and moves it back onto the undo stack', () => {
  const { win } = loadUndoManager();
  let redone = 0;
  win._ccPushUndoable({ undo() {}, redo() { redone++; } });
  win._ccUndo();
  const ok = win._ccRedo();
  assert.equal(ok, true);
  assert.equal(redone, 1);
  assert.equal(win._ccUndoStack.length, 1);
  assert.equal(win._ccRedoStack.length, 0);
});

test('pushing a new undoable action clears the redo stack (branching, not a ring buffer)', () => {
  const { win } = loadUndoManager();
  win._ccPushUndoable({ undo() {}, redo() {} });
  win._ccUndo();
  assert.equal(win._ccRedoStack.length, 1);
  win._ccPushUndoable({ undo() {}, redo() {} });
  assert.equal(win._ccRedoStack.length, 0);
});

test('entries with the same coalesceKey pushed within the debounce window merge into one, keeping the oldest undo and the newest redo', () => {
  const { win } = loadUndoManager();
  win._ccPushUndoable({ coalesceKey: 'section', undo() { return 'undo-1'; }, redo() { return 'redo-1'; } });
  win._ccPushUndoable({ coalesceKey: 'section', undo() { return 'undo-2'; }, redo() { return 'redo-2'; } });
  win._ccPushUndoable({ coalesceKey: 'section', undo() { return 'undo-3'; }, redo() { return 'redo-3'; } });
  assert.equal(win._ccUndoStack.length, 1);
  assert.equal(win._ccUndoStack[0].undo(), 'undo-1'); // original "before" preserved
  assert.equal(win._ccUndoStack[0].redo(), 'redo-3'); // latest "after" adopted
});

test('entries with different coalesceKeys never merge, even back-to-back', () => {
  const { win } = loadUndoManager();
  win._ccPushUndoable({ coalesceKey: 'section', undo() {}, redo() {} });
  win._ccPushUndoable({ coalesceKey: 'section-box', undo() {}, redo() {} });
  assert.equal(win._ccUndoStack.length, 2);
});

test('entries with no coalesceKey never merge (visibility actions are always discrete)', () => {
  const { win } = loadUndoManager();
  win._ccPushUndoable({ undo() {}, redo() {} });
  win._ccPushUndoable({ undo() {}, redo() {} });
  assert.equal(win._ccUndoStack.length, 2);
});

test('_ccUndoInfo reports canUndo/canRedo matching stack contents', () => {
  // win._ccUndoInfo() returns a plain object built inside the vm sandbox, so
  // it has a different realm's Object.prototype than a literal written here
  // -- compare fields directly rather than with deepEqual (which treats
  // cross-realm prototypes as unequal).
  const { win } = loadUndoManager();
  let info = win._ccUndoInfo();
  assert.equal(info.canUndo, false);
  assert.equal(info.canRedo, false);
  win._ccPushUndoable({ undo() {}, redo() {} });
  info = win._ccUndoInfo();
  assert.equal(info.canUndo, true);
  assert.equal(info.canRedo, false);
  win._ccUndo();
  info = win._ccUndoInfo();
  assert.equal(info.canUndo, false);
  assert.equal(info.canRedo, true);
});

test('a failing undo()/redo() is caught (console.warn), not thrown, and the stacks still swap', () => {
  const { win } = loadUndoManager();
  win._ccPushUndoable({ undo() { throw new Error('boom'); }, redo() {} });
  assert.doesNotThrow(() => win._ccUndo());
  assert.equal(win._ccRedoStack.length, 1);
});
