'use strict';
// State scope registry (index.html _CC_STATE_SCOPE, docs/INTERNALS.md §21.64):
// every state key belongs to one lifecycle and lifecycle events only touch
// their own scope. The behaviour (refresh / workspace / tab / project switch,
// selection and isolation) is covered end to end by
// tests/browser/state-scope.mjs; these lock the wiring.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// Evaluates the registry block with a stand-in INIT (only the defaults
// snapshot reads it).
function loadScope(init) {
  const start = src.indexOf('  var _CC_STATE_SCOPE = (function(){');
  const end = src.indexOf('  // Before the view was project state', start);
  assert.ok(start > 0 && end > start, 'scope registry not found');
  const win = {};
  const api = new Function('INIT', 'window', src.slice(start, end) +
    '; return { scope: _CC_STATE_SCOPE, keys: _ccScopeKeys, defaults: _ccScopeDefaults, declare: _ccDeclareStateScope, pickView: _ccPickView };')(init || {}, win);
  api.window = win;
  return api;
}

function initKeys() {
  const start = src.indexOf('  var INIT = {\n    models:[]');
  const end = src.indexOf('\n  };\n', start);
  assert.ok(start > 0 && end > start, 'INIT literal not found');
  const body = src.slice(start, end);
  const keys = new Set();
  // top-level keys: four-space indent, or after a comma on one of those lines
  body.split('\n').forEach((raw) => {
    if (!/^ {4}[A-Za-z_]/.test(raw)) return;
    const line = raw.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
    let depth = 0;
    for (let i = 4; i < line.length; i++) {
      const ch = line[i];
      if (depth === 0 && (i === 4 || line[i - 1] === ',' || line[i - 1] === ' ')) {
        const m = /^([A-Za-z_]\w*)\s*:/.exec(line.slice(i));
        if (m) keys.add(m[1]);
      }
      if ('{[('.includes(ch)) depth++;
      else if ('}])'.includes(ch)) depth--;
    }
  });
  return [...keys];
}

test('every INIT key belongs to exactly one known scope', () => {
  const { scope } = loadScope();
  const keys = initKeys();
  assert.ok(keys.length > 60, 'parsed INIT keys: ' + keys.length);
  const missing = keys.filter((k) => !scope[k]);
  assert.deepEqual(missing, [], 'unclassified INIT keys');
  for (const [k, v] of Object.entries(scope)) assert.ok(['project', 'view', 'session', 'ui'].includes(v), k + ' → ' + v);
});

test('the section and the hidden categories are the project view; selection-like state is session', () => {
  const { scope, keys } = loadScope();
  assert.deepEqual(keys('view').sort(), ['hiddenClasses', 'sectionAxis', 'sectionBox', 'sectionCustom', 'sectionFlip', 'sectionHatch', 'sectionPos', 'sectionStorey']);
  for (const k of ['activeId', 'selected', 'modalElement', 'activeCommentId', 'triageResults', 'idsValidation', 'lastActiveClashId']) assert.equal(scope[k], 'session', k);
  for (const k of ['models', 'parkedModels', 'clashes', 'issues', 'rules', 'runHistory', 'selectionSets', 'searchSets', 'assignmentRules', 'comments', 'changelog', 'deniedPairs', 'propertyRules', 'triage', 'smartViews']) assert.equal(scope[k], 'project', k);
  for (const k of ['workspace', 'tab', 'prefs', 'activeProject', 'projectList']) assert.equal(scope[k], 'ui', k);
});

test('scope defaults are fresh copies from INIT; ui keys are never reset', () => {
  const init = { triage: { facets: {}, savedViews: [] }, clashes: [], sectionAxis: null, workspace: 'review', prefs: { a: 1 } };
  const { defaults } = loadScope(init);
  const a = defaults(['project', 'view', 'session']);
  const b = defaults(['project', 'view', 'session']);
  assert.notEqual(a.triage, b.triage, 'each reset gets its own objects');
  assert.deepEqual(a.triage, init.triage);
  assert.ok(!('workspace' in a) && !('prefs' in a) && !('tab' in a));
  assert.equal(a.sectionAxis, null);
});

test('addons declare the scope of their initState keys', () => {
  const { scope, defaults, declare } = loadScope();
  declare({ demoKey: 'session', demoUi: 'ui', bogus: 'nope' }, { demoKey: { on: true }, demoUi: 1 });
  assert.equal(scope.demoKey, 'session');
  assert.equal(scope.demoUi, 'ui');
  assert.ok(!('bogus' in scope));
  assert.deepEqual(defaults(['session']).demoKey, { on: true });
  assert.ok(src.includes('if (def.stateScope) _ccDeclareStateScope(def.stateScope, def.initState);'));
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'addons')).filter((x) => x.endsWith('.js'))) {
    const a = fs.readFileSync(path.join(__dirname, '..', 'addons', f), 'utf8');
    if (/\binitState:\s*\{/.test(a)) assert.match(a, /\bstateScope:\s*\{/, f + ' adds state without declaring its scope');
  }
});

test('the project switch resets every non-ui scope from the registry (no hand-written list)', () => {
  const start = src.indexOf('function _switchProject(newProjId, s, d) {');
  const body = src.slice(start, src.indexOf('\n  }\n', start));
  assert.match(body, /d\(\{t:A\.LOAD_PROJECT_STATE, data:Object\.assign\(_ccScopeDefaults\(\['project','view','session'\]\), \{switchingProject:true\}\)\}\);/);
  // undo entries are dropped in dispatch order, inside the reducer
  assert.match(src, /if \(a\.t === A\.SET_PROJECT && a\.id !== s\.activeProject && window\._ccClearUndo\) window\._ccClearUndo\(\);/);
});

test('tab / selection never change the section; the view is saved with the project, not per browser', () => {
  const tab = src.slice(src.indexOf('      case A.TAB:'), src.indexOf('      case A.SETTINGS:'));
  assert.doesNotMatch(tab, /sectionAxis\s*:/);
  const active = src.slice(src.indexOf('      case A.ACTIVE:'), src.indexOf('      case A.MODAL:'));
  assert.doesNotMatch(active, /sectionAxis\s*:/);
  assert.doesNotMatch(src, /localStorage\.setItem\('cc_section'/);
  assert.doesNotMatch(src, /_persistHiddenClasses/);
  assert.match(src, /Object\.assign\(data, _cloneSafe\(_ccPickView\(s\), 0\)\);/);
  assert.match(src, /'smartViews'\]\.concat\(_CC_VIEW_KEYS\);/);
  // loading a model frames the camera only — never the user's "reset view"
  assert.match(src, /S\._frameHome && !_ccLoadPreview\.keepCamera\(_elemsBBox\)\) S\._frameHome\(\);/);
});

test('_ccPickView picks exactly the view keys', () => {
  const { pickView } = loadScope();
  const v = pickView({ sectionAxis: 'x', sectionPos: 0.3, hiddenClasses: { a: true }, clashes: [1], workspace: 'review' });
  assert.equal(v.sectionAxis, 'x');
  assert.deepEqual(v.hiddenClasses, { a: true });
  assert.ok(!('clashes' in v) && !('workspace' in v));
});

test('a shared project (cloud key / folder) belongs to one local project', () => {
  // the cloud key: stored per local project; the old per-browser keys are only read to adopt them
  const legacyReads = src.match(/localStorage\.getItem\('cc_sharedProject(Id|Name|EditKey)'\)/g) || [];
  const adopt = src.slice(src.indexOf('(function _ccAdoptLegacyShareLink() {'), src.indexOf('window._ccShareLink = {'));
  assert.equal(legacyReads.length, (adopt.match(/localStorage\.getItem\('cc_sharedProject(Id|Name|EditKey)'\)/g) || []).length, 'cc_sharedProject* read outside the one-time adoption');
  assert.doesNotMatch(src, /localStorage\.setItem\('cc_sharedProject(Id|Name|EditKey)'/);
  assert.match(src, /function _sharedProjectId\(\) \{ var l = _ccShareLink\(\); return l \? l\.id : null; \}/);
  // leaving a project detaches its sharing BEFORE any dispatch of the switch
  const sw = src.slice(src.indexOf('function _switchProject(newProjId, s, d) {'));
  assert.ok(sw.indexOf("dispatchEvent(new Event('cc-project-leave'))") < sw.indexOf('d({t:A.SWITCHING_PROJECT, v:true});'));
  assert.match(src, /if \(!s\.switchingProject && typeof _sharedStartPolling === 'function'\) _sharedStartPolling\(\);/);
  // the folder: one saved handle per local project, detached on leave, reconnected after the restore
  const addon = fs.readFileSync(path.join(__dirname, '..', 'addons', 'shared-project.js'), 'utf8');
  assert.match(addon, /function _handleKey\(pid\) \{ return 'shared:' \+ \(pid \|\| _localPid\(\)\); \}/);
  assert.match(addon, /window\.addEventListener\('cc-project-leave', _detach\);/);
  assert.match(addon, /window\.addEventListener\('cc-project-restored'/);
  assert.doesNotMatch(addon, /objectStore\('handles'\)\.(put|delete)\([^)]*'shared'\)/);
});
