'use strict';
// Wiring for "smart import" (sub-disciplines, roles, automatic matrix, space
// boundaries). Anchors on literal source text, so a refactor that drops a
// piece of the chain fails here first; behaviour is covered by
// tests/discipline-engine.test.js (engine) and tests/browser/smart-import.mjs
// (real loader, worker == fallback, detection, boundaries).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const localeLoader = fs.readFileSync(path.join(root, 'locales', 'loader.js'), 'utf8');
const regLoader = fs.readFileSync(path.join(root, 'regulations', 'loader.js'), 'utf8');
const localEngine = fs.readFileSync(path.join(root, 'addons', 'local-engine.js'), 'utf8');
const dq = fs.readFileSync(path.join(root, 'addons', 'data-quality.js'), 'utf8');

test('the IFC worker is built from the same extraction functions the fallback calls', () => {
  assert.match(src, /'var extractSemanticRecords=' \+ extractSemanticRecords\.toString\(\)/);
  assert.match(src, /'var extractSpaceBoundaryRecords=' \+ extractSpaceBoundaryRecords\.toString\(\)/);
  // Worker side
  assert.match(src, /try \{ semRecs = extractSemanticRecords\(api, modelID\); \}/);
  assert.match(src, /try \{ sbRecs = extractSpaceBoundaryRecords\(api, modelID\); \}/);
  assert.match(src, /semantics:semRecs, spaceBoundaries:sbRecs,/);
  assert.match(src, /_ccApplySemanticRecords\(elements, msg\.semantics\);/);
  // Fallback side
  assert.match(src, /try \{ _semRecs = extractSemanticRecords\(api, modelID\); \}/);
  assert.match(src, /try \{ _sbRecs = extractSpaceBoundaryRecords\(api, modelID\); \}/);
  assert.match(src, /_ccApplySemanticRecords\(elements, _semRecs\);/);
  // Element PredefinedType: extracted once, packed for the worker transfer.
  assert.match(src, /if \(_pdt && _pdt !== 'NOTDEFINED' && _pdt !== 'USERDEFINED'\) props\.predefinedType = _pdt;/);
  assert.match(src, /if \(pk\.predefIdx && pk\.predefIdx\[i\] !== -1\) props\.predefinedType = _pkStr\(pk\.predefIdx\[i\]\);/);
});

test('extraction helpers are self-contained (stringified into the worker)', () => {
  for (const name of ['extractSemanticRecords', 'extractSpaceBoundaryRecords']) {
    const start = src.indexOf('  function ' + name + '(api, modelID) {');
    const end = src.indexOf('\n  }\n', start);
    assert.ok(start > 0 && end > start, name + ' not found');
    const body = src.slice(start, end);
    assert.doesNotMatch(body, /\bwindow\.|\bTHREE\.|\bdocument\.|_cc[A-Z]/, name + ' must not reach main-thread state');
  }
});

test('every model-creation path classifies the loaded result', () => {
  assert.doesNotMatch(src, /detectDiscipline\(result\.elements,/);
  const n = (src.match(/_ccClassifyLoadedResult\(result, /g) || []).length;
  assert.ok(n >= 5, 'expected the IFC, GLB+IFC, sidecar, project-restore and unpark paths, got ' + n);
  assert.ok((src.match(/_ccSemanticModelFields\(result\)/g) || []).length >= 6);
});

test('space boundaries persist in the geo cache and are drawn on the rooms layer only', () => {
  assert.match(src, /sp:2, sem:1, xp:1, np:1, hasPsets:hasPsets/);
  assert.match(src, /spaceBoundaries:cached\.spaceBoundaries\|\|null/);
  assert.match(src, /obj\.layers\.set\(_CC_SPACE_LAYER\);\n\s*obj\.raycast = function\(\) \{\};/);
  assert.match(src, /var _bObj = _ccBoundaryObject\(model\);\n\s*if \(_bObj\) grp\.add\(_bObj\);/);
  assert.match(src, /var _CC_SB_MIN_SHARE = 0\.8;/);
  assert.match(src, /window\._ccSpaceAdjacency = function\(modelId, expressId\)/);
  assert.match(dq, /window\._ccSpaceAdjacency\(modelId\)/);
});

test('suggestion groups set to "exclude" are not clash sources (browser sweeps + local engine, gate fails closed)', () => {
  const skip = /if \(typeof _ccRoleExcluded === 'function' && _ccRoleExcluded\(el, rules\)\) return;/g;
  assert.equal((src.match(skip) || []).length, 2, 'JS and Wasm sweep');
  assert.match(localEngine, /window\._ccRoleExcluded\(el, rules\)\) return;/);
  assert.match(localEngine, /Left-out suggestion groups need the core role filter/);
  assert.match(src, /hideProvidedOpenings:true, roleChoices:\{\}, hideContacts:true,/);
  assert.match(src, /window\._ccRoleExcluded = _ccRoleExcluded;/);
});

test('provisions and classified groups are labelled, never dropped, and hidden behind counts', () => {
  assert.match(src, /var _roleIdx = typeof _ccRoleIndex === 'function' \? _ccRoleIndex\(models\) : null;/);
  assert.match(src, /if \(_sigNow && _provIdx\.sig\) _sigNow \+= '#p' \+ _provIdx\.sig;/);
  assert.match(src, /if \(_sigNow && _roleIdx && _roleIdx\.sig\) _sigNow \+= '#r' \+ _roleIdx\.sig;/);
  assert.match(src, /if \(_provStatus\) b\.obj\.provision = _provStatus;/);
  assert.match(src, /if \(_rGroup\) b\.obj\.roleGroup = _rGroup;/);
  // filed by the shared review buckets (clash-classification-core.js
  // reviewBucket: 'provision' / 'zone'), counted in the one bucket bar
  assert.match(src, /roleChoice: function\(g, rules\) \{ return _ccDisciplineCore\.roleChoice\(g, rules\); \}/);
  assert.match(src, /<\$\{BucketBar\} counts=\$\{triage\.counts\}/);
  assert.match(src, /k === 'roleChoicesRemembered'/, 'the remember flag is not part of the run signature');
});

test('exclusions are reported with the result, in state and in the completion event', () => {
  assert.match(src, /if \(result && _runExcluded\) \{ try \{ result\._ccExcluded = _runExcluded; \} catch \(e\) \{\} \}/);
  assert.match(src, /action\.excluded = result\._ccExcluded \|\| null;/);
  assert.match(src, /lastRunExcluded:a\.excluded\|\|null/);
  assert.match(src, /excluded: \(result && result\._ccExcluded\) \|\| null,/);
  assert.match(src, /data-cc-excluded="1"/);
});

test('pre-run suggestions: interactive entry points only; API runs never ask', () => {
  assert.match(src, /window\._ccRunDetectionInteractive = function\(rulesOverride\)/);
  assert.match(src, /onSelect:function\(\)\{ try\{ if\(window\._ccRunDetectionInteractive\) window\._ccRunDetectionInteractive\(\); \}catch\(e\)\{\} \}\}\);/);
  assert.ok((src.match(/_ccMaybePreRun\(/g) || []).length >= 5, 'modal / preset / quick-run paths');
  const apiStart = src.indexOf('window._ccRunDetection = function(rulesOverride) {');
  const apiEnd = src.indexOf('\n  };', apiStart);
  assert.doesNotMatch(src.slice(apiStart, apiEnd), /_ccMaybePreRun|PRE_RUN/, 'the API entry point never blocks');
  assert.match(src, /\(s\.prefs && s\.prefs\.preRunDontAsk\) \|\| \(runRules && runRules\.roleChoicesRemembered\)/);
  assert.doesNotMatch(src.slice(src.indexOf('function PreRunPanel'), src.indexOf('function PreRunPanel') + 6000), /window\.confirm|confirm\(/);
});

test('the run signature tracks each model\'s classification', () => {
  assert.match(src, /\(m\.disciplineInfo && m\.disciplineInfo\.sig\) \|\| ''\]\.join\(':'\)/);
});

test('pack loaders register hints / tables from every flagged pack and re-classify', () => {
  assert.match(localeLoader, /core\.registerHints\('locale:' \+ pack\.lang, pack\.disciplineHints\)/);
  assert.match(localeLoader, /p && p\.disciplineHints && p\.file/);
  assert.match(regLoader, /core\.registerClassificationTable\(t\)/);
  assert.match(localeLoader, /window\._ccReclassifyModels\('locale-hints'\)/);
  assert.match(regLoader, /window\._ccReclassifyModels\('classification-tables'\)/);
  assert.doesNotMatch(localeLoader + regLoader, /\beval\(|new Function/);
});

test('0-clash same-discipline toast and banner key models by sub-discipline', () => {
  assert.match(src, /var k=_ccModelDisciplineKey\(m\); _dc\[k\]=\(_dc\[k\]\|\|0\)\+1;/);
  assert.match(src, /var k=_ccModelDisciplineKey\(m\); _dcnt\[k\]=\(_dcnt\[k\]\|\|0\)\+1;/);
});

test('UI strings for the new surfaces go through _cc_t', () => {
  for (const key of ['provision.passThrough', 'run.roleGroups', 'roles.titlePlain', 'roles.leftOut', 'inspector.disciplineCard', 'modelCard.notice.roomOutlinesAll', 'boundary.unplaced', 'matrix.help']) {
    assert.match(src, new RegExp("_cc_t\\('" + key.replace('.', '\\.') + "'"), key);
  }
});
