'use strict';
// Automatic re-check on model change (docs/INTERNALS.md §21.59): the pref,
// the gate (no run without a previous run, none while detecting, none on a
// project restore / partial load / memory stop) and the wiring of the
// loader, the Revit bridge and the run itself. The scheduler is extracted
// from index.html by text and run in a sandbox with a fake clock.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const revit = fs.readFileSync(path.join(root, 'addons', 'revit-bridge.js'), 'utf8');
const nl = JSON.parse(fs.readFileSync(path.join(root, 'locales', 'nl.json'), 'utf8')).strings;

function slice(startMarker, endMarker, from) {
  const s = src.indexOf(startMarker, from || 0);
  assert.ok(s !== -1, startMarker + ' not found');
  const e = src.indexOf(endMarker, s);
  assert.ok(e !== -1, endMarker + ' not found');
  return src.slice(s, e + endMarker.length);
}

// The scheduler block, run against a fake window / clock.
function sandbox() {
  const code = slice('  var _ccAutoRerunCfg = window._ccAutoRerun', '    c.timer = setTimeout(_ccAutoRerunTick, c.settleMs);\n    return true;\n  };');
  const timers = [];
  const runs = [];
  const win = {
    _ccLatestState: null, _ccModelLoading: false,
    _ccDetectionActive: () => false,
    _ccRunDetection: (rules, opts) => { runs.push({ rules, opts }); return true; },
  };
  const ctx = {
    window: win, _ccDetectMemCfg: { last: null }, _ccRestoringModels: {}, _ccDetectLastStart: 0,
    Date: { now: () => ctx.__now }, __now: 1000,
    setTimeout: (fn, ms) => { const t = { fn, at: ctx.__now + ms, live: true }; timers.push(t); return t; },
    clearTimeout: (t) => { if (t) t.live = false; },
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  function advance(ms) {
    const end = ctx.__now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.live = false; ctx.__now = due.at; due.fn();
    }
    ctx.__now = end;
  }
  return { win, ctx, runs, advance };
}
const model = (extra) => Object.assign({ id: 'm1', name: 'A', elements: [{ expressId: 1 }] }, extra || {});
function state(extra) {
  return Object.assign({ models: [model(), model({ id: 'm2', name: 'B' })], runHistory: [{ ts: 1 }], prefs: { autoRerun: 'replaced' },
    detecting: false, switchingProject: false, preRun: null, runModalOpen: false, activeProject: 'p1' }, extra || {});
}

test('pref: autoRerun in INIT_PREFS (default replaced, validated) and persisted', () => {
  const init = slice('  var INIT_PREFS = {', '\n  };');
  assert.match(init, /autoRerun:\(function\(\)\{[^\n]*localStorage\.getItem\('cc_autoRerun'\)[^\n]*v==='off'\|\|v==='any'\|\|v==='replaced' \? v : 'replaced'/);
  assert.match(slice('  var PERSISTED_PREF_KEYS = [', '];'), /'autoRerun'/);
  // Settings row: a plain select with the three choices, every string translated
  const row = slice("${_cc_t('settings.detection','Detection')}", '</select>');
  assert.match(row, /value=\$\{p\.autoRerun\|\|'replaced'\}/);
  assert.match(row, /u:\{autoRerun:e\.target\.value\}/);
  for (const v of ['off', 'replaced', 'any']) assert.match(row, new RegExp('<option value="' + v + '">'));
  for (const k of ['settings.detection', 'settings.autoRerun', 'settings.autoRerunSub', 'settings.autoRerunOff', 'settings.autoRerunReplaced', 'settings.autoRerunAny',
    'autoRerun.nNew', 'autoRerun.nGone', 'autoRerun.nIssuesResolved', 'autoRerun.nIssuesReopened', 'autoRerun.toast', 'autoRerun.toastNoChange']) {
    assert.ok(nl[k], 'nl.json has ' + k);
  }
});

test('gate: no run without a previous run, while detecting, on restore, partial load, memory stop or per the pref', () => {
  const { win } = sandbox();
  const gate = win._ccAutoRerunGate;
  assert.equal(gate(state(), 'replaced', {}), null);
  assert.equal(gate(state({ runHistory: [] }), 'replaced', {}), 'no-previous-run');
  assert.equal(gate(state({ detecting: true }), 'replaced', {}), 'detecting');
  assert.equal(gate(state(), 'replaced', { detecting: true }), 'detecting');
  assert.equal(gate(state({ switchingProject: true }), 'replaced', {}), 'restore');
  assert.equal(gate(state({ models: [model({ _stub: true })] }), 'replaced', {}), 'restore');
  assert.equal(gate(state({ models: [model({ stats: { loadedScope: { storeys: ['L1'] } } })] }), 'replaced', {}), 'partial');
  assert.equal(gate(state(), 'replaced', { memoryStopped: true }), 'memory');
  assert.equal(gate(state(), 'replaced', { loading: true }), 'loading');
  assert.equal(gate(state(), 'replaced', { restoring: true }), 'restoring');
  assert.equal(gate(state({ preRun: { groups: [] } }), 'replaced', {}), 'pre-run');
  assert.equal(gate(state({ prefs: { autoRerun: 'off' } }), 'replaced', {}), 'off');
  assert.equal(gate(state(), 'loaded', {}), 'pref', "'replaced' does not re-check after a plain load");
  assert.equal(gate(state({ prefs: { autoRerun: 'any' } }), 'loaded', {}), null);
  assert.equal(gate(state({ models: [] }), 'replaced', {}), 'no-models');
});

test('scheduler: one debounced silent run with the saved rules; nothing without a previous run', () => {
  const sb = sandbox();
  sb.win._ccLatestState = state({ runHistory: [] });
  assert.equal(sb.win._ccScheduleAutoRerun('replaced'), true, 'pending: the tick decides on the settled state');
  sb.advance(5000);
  assert.equal(sb.runs.length, 0);
  assert.equal(sb.win._ccAutoRerun.last.skipped, 'no-previous-run');
  assert.equal(sb.win._ccAutoRerun.pending, null);

  sb.win._ccLatestState = state();
  assert.equal(sb.win._ccScheduleAutoRerun('loaded'), false, 'pref replaced: a plain load does not schedule');
  assert.equal(sb.win._ccScheduleAutoRerun('replaced'), true);
  sb.advance(300);
  assert.equal(sb.win._ccScheduleAutoRerun('replaced'), true, 'a second file of the batch');
  sb.advance(400);
  assert.equal(sb.runs.length, 0, 'debounced: the settle window restarted');
  sb.advance(400);
  assert.equal(sb.runs.length, 1);
  assert.equal(sb.runs[0].rules, null, 'the saved rules');
  assert.deepEqual({ ...sb.runs[0].opts }, { auto: 'replaced' });
  assert.equal(sb.win._ccAutoRerun.runs, 1);
});

test('scheduler: waits while detecting / loading, then runs; skips a restore and a change a newer run covered', () => {
  const sb = sandbox();
  sb.win._ccLatestState = state();
  sb.win._ccModelLoading = true;
  sb.win._ccScheduleAutoRerun('replaced');
  sb.advance(3000);
  assert.equal(sb.runs.length, 0, 'none while a load is in flight');
  sb.win._ccModelLoading = false;
  sb.win._ccLatestState = state({ detecting: true });
  sb.advance(3000);
  assert.equal(sb.runs.length, 0, 'none while detecting');
  sb.win._ccLatestState = state();
  sb.advance(300);
  assert.equal(sb.runs.length, 1, 'runs once the detection finished');

  // a project restore in the meantime: dropped, never run
  sb.win._ccScheduleAutoRerun('replaced');
  sb.win._ccLatestState = state({ switchingProject: true });
  sb.advance(2000);
  assert.equal(sb.runs.length, 1);
  assert.equal(sb.win._ccAutoRerun.last.skipped, 'restore');

  // a run that started after the change and committed covered it
  sb.win._ccLatestState = state();
  sb.win._ccScheduleAutoRerun('replaced');
  sb.ctx._ccDetectLastStart = sb.ctx.__now + 10;
  sb.win._ccLatestState = state({ runHistory: [{ ts: 1 }, { ts: sb.ctx.__now + 50 }] });
  sb.advance(2000);
  assert.equal(sb.runs.length, 1);
  assert.equal(sb.win._ccAutoRerun.last.skipped, 'covered');
});

test('wiring: loader batch, Revit bridge, run tagging, toast, memo kept on a same-id replace', () => {
  // load batch: counts replaced / loaded models, waits for every lazy-props gate, skips cancelled / scoped batches
  assert.match(src, /if \(existing\) _autoRr\.replaced\+\+; else _autoRr\.loaded\+\+;/);
  assert.match(src, /_autoRr\.props\.push\(new Promise\(function\(res\) \{ job\.afterProps\(res\); \}\)\);/);
  assert.match(src, /if \(result\.stats && result\.stats\.loadedScope\) _autoRr\.partial = true;/);
  assert.match(src, /\(_autoRr\.replaced \|\| _autoRr\.loaded\) && !_autoRr\.partial && _batchGen === _ccLoadGeneration[\s\S]{0,200}Promise\.all\(_autoRr\.props\)\.then[\s\S]{0,200}_ccScheduleAutoRerun\(_autoRr\.replaced \? 'replaced' : 'loaded'\)/);
  // a project restore / parked-model restore never schedules one
  const restore = slice('  function _restoreProjectFilesGlobal(projectId, d) {', '\n  }\n');
  assert.doesNotMatch(restore, /_ccScheduleAutoRerun/);
  assert.doesNotMatch(slice('  window._ccRestoreParkedModel = function(id) {', '\n  };\n'), /_ccScheduleAutoRerun/);
  // Revit re-sync
  assert.match(revit, /\{t:'REPLACE_MODEL', id:existingModel\.id, v:modelData\}\);\s*\n\s*\/\/[^\n]*\n\s*if \(typeof window\._ccScheduleAutoRerun === 'function'\) window\._ccScheduleAutoRerun\('replaced'\);/);
  // the run: no tab switch, commit tagged, MERGE_CLASHES → lastAutoRerun, one toast
  const run = slice('  window._ccRunDetection = function(rulesOverride, opts) {', '\n  };\n');
  assert.match(run, /if \(!_auto\) d\(\{t:'TAB',v:'clashes'\}\);/);
  assert.match(run, /_ccCommitDetectionResult\(result, d, _runDs, _auto \? \{auto:_auto\} : undefined\)/);
  assert.match(src, /if \(opts && opts\.auto\) action\.auto = opts\.auto;/);
  assert.match(src, /lastAutoRerun:a\.auto\?\{reason:a\.auto,ts:_mr\.deltaSummary\.ts,delta:_mr\.deltaSummary\}:null/);
  assert.match(src, /if \(parts\.length && !lc\.auto && typeof window\._ccToast === 'function'\)/);
  assert.match(src, /_cc_t\('autoRerun\.toast', 'Re-checked after model update: \{changes\}'/);
  // not saved with the project
  assert.doesNotMatch(slice('  var _AUTOSAVE_SLICES = [', '];'), /lastAutoRerun/);
  // smart re-run after a reload: a same-id replace keeps the run memo
  assert.match(src, /case A\.REPLACE_MODEL: var _rplOld=[^\n]*if\(a\.v&&a\.v\.id===a\.id\)\{ _bvhLRURemoveModel\(_rplOld\); \} else _clearElCaches\(_rplOld\);/);
});
