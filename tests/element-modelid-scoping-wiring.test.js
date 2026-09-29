'use strict';
// Regression lock for the cross-model expressId-collision fix (item A):
// two loaded models can share a bare expressId (e.g. MEP duct #227 and an
// unrelated Architecture element #227), and every place that identified an
// element by expressId alone risked selecting/highlighting/hiding the wrong
// one. This slices the relevant source regions out of index.html and
// asserts the modelId-scoping is actually wired in, since this is UI code
// with no practical way to unit-test the rendered DOM directly here (see
// tests/browser/smoke.mjs for the live-browser check).
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

function sliceFrom(needle, span) {
  const i = html.indexOf(needle);
  assert.ok(i !== -1, 'expected to find: ' + needle);
  return html.slice(i, i + span);
}

test('_elClick takes a modelId param and uses it for both the highlight call and the multiSel ref', () => {
  const body = sliceFrom('function _elClick(e, el, p, eKey, modelId) {', 1200);
  assert.match(body, /var ref = \{expressId: el\.expressId, modelId: modelId\};/);
  assert.match(body, /_highlightById\(el\.expressId, false, modelId\)/);
});

test('multiSel matching compares modelId, not just expressId (dedupe/toggle in _elClick)', () => {
  const body = sliceFrom('function _elClick(e, el, p, eKey, modelId) {', 1200);
  assert.match(body, /r\.expressId===ref\.expressId && r\.modelId===ref\.modelId/);
});

test('the spatial-view tree node builds a model-scoped key and passes model.id through click/dblclick/highlight', () => {
  const body = sliceFrom("var eKey='e_'+model.id+'_'+el.expressId;", 900);
  assert.match(body, /multiSelected:multiSel\.some\(function\(r\)\{return r\.expressId===el\.expressId && r\.modelId===model\.id;\}\)/);
  assert.match(body, /_elClick\(e,el,p,eKey,model\.id\)/);
  assert.match(body, /_fitToElement\(el\.expressId,isFloor\?\{normal:\[0,1,0\]\}:null,model\.id\)/);
  assert.match(body, /_highlightById\(el\.expressId,false,model\.id\)/);
});

test('the flat-tree view element AND its children use model-scoped keys/refs too', () => {
  const body = sliceFrom("var eKey='e_'+model.id+'_'+el.expressId;\n            var cKey='ec_'+model.id+'_'+el.expressId;", 2200);
  assert.match(body, /var ceKey='e_'\+model\.id\+'_'\+child\.expressId;/);
  assert.match(body, /r\.expressId===child\.expressId && r\.modelId===model\.id/);
  assert.match(body, /_elClick\(e,child,cp,ceKey,model\.id\)/);
});

test('arrow-key tree navigation pushes model-scoped node keys and passes n.model.id to highlight/fit', () => {
  const body = sliceFrom('function onKey(e){', 4200);
  assert.match(body, /nodes\.push\(\{key:'e_'\+model\.id\+'_'\+el\.expressId,type:'element',model:model,element:el\}\)/);
  assert.match(body, /_highlightById\(n\.element\.expressId,false,n\.model\.id\)/);
  assert.match(body, /_highlightById\(nodes\[nextIdx\]\.element\.expressId,false,nodes\[nextIdx\]\.model\.id\)/);
});

test('window._ccSelectedModelId is maintained alongside window._ccSelectedExpressId', () => {
  const body = sliceFrom('window._ccSelectedExpressId = selectedEl ? selectedEl.expressId : null;', 500);
  assert.match(body, /window\._ccSelectedModelId = selectedEl \? \(selectedEl\.modelId \|\| null\) : null;/);
});

test('3D-canvas element selection stamps modelId onto selectedEl (both the single-click and multi-select-last-shown paths)', () => {
  assert.match(html, /setSelectedEl\(\{props:lastFound\.el\.props\|\|\{\}, modelName:lastFound\.model\.name, modelId:lastFound\.model\.id,/);
  assert.match(html, /setSelectedEl\(found \? \{props:found\.el\.props\|\|\{\}, modelName:found\.model\.name, modelId:_hitModelId, expressId:eid,/);
});

test('hide (hh) / isolate (hi) chord hotkeys build model-scoped refs, not bare expressIds', () => {
  const body = sliceFrom("function getActiveRefs(){", 4600);
  assert.match(body, /if\(it\) _itemRefs\(it\)\.forEach\(function\(r\)\{refs\.push\(r\);\}\);/);
  assert.match(body, /if\(chord==='hh'\)\{/);
  assert.match(body, /var hhRefs=getActiveRefs\(\);/);
  assert.match(body, /hhRefs=\[\{expressId:window\._ccSelectedExpressId, modelId:window\._ccSelectedModelId\|\|null\}\]/);
  assert.match(body, /if\(chord==='hi'\)\{/);
  assert.match(body, /var hiRefs=getActiveRefs\(\);/);
});

test("the plain 'i' isolate hotkey passes modelId too (and is now a real toggle via window._ccIsIsolated)", () => {
  const body = sliceFrom("if(e.key==='i'&&!ctrl){", 700);
  assert.match(body, /window\._ccIsIsolated/);
  assert.match(body, /_iRefs = \[\{expressId: window\._ccSelectedExpressId, modelId: window\._ccSelectedModelId\|\|null\}\]/);
  assert.match(body, /window\._ccIsolate\(_iRefs\)/);
});

test('_ccTempHideCore accepts {expressId,modelId} refs and only hides meshes whose modelId matches a scoped ref', () => {
  // The scoping logic lives in _ccTempHideCore now; window._ccTempHide is a
  // thin wrapper that snapshots state and pushes an undo entry around it.
  const body = sliceFrom('function _ccTempHideCore(targets) {', 1600);
  assert.match(body, /var meshModelId = obj\.parent && obj\.parent\.userData && obj\.parent\.userData\.modelId;/);
  assert.match(body, /var match = idAny\[eid\] \|\| \(idScoped\[eid\] && meshModelId && idScoped\[eid\]\[meshModelId\]\);/);
});

test('_ccBatchHidden.temp visibility check honors a model-scoped key alongside the legacy bare-eid one', () => {
  const body = sliceFrom('function _ccBatchApplyVisibility(root) {', 700);
  assert.match(body, /_ccBatchHidden\.temp\[eid\] \|\| _ccBatchHidden\.temp\[k\]/);
});

test('Selection Set +/- editing matches by (expressId, modelId), falling back to expressId-only for legacy refs with no modelId', () => {
  assert.match(html, /if\(!merged\.some\(function\(m\)\{return m\.expressId===r\.expressId && \(!r\.modelId \|\| !m\.modelId \|\| m\.modelId===r\.modelId\);\}\)\) merged\.push\(r\);/);
  assert.match(html, /return !refs\.some\(function\(r\)\{return r\.expressId===m\.expressId && \(!r\.modelId \|\| !m\.modelId \|\| m\.modelId===r\.modelId\);\}\);/);
});

test('no remaining Save/+/- selection-set fallback hardcodes modelId:null for the current 3D selection', () => {
  assert.doesNotMatch(html, /window\._ccSelectedExpressId \? \[\{expressId:window\._ccSelectedExpressId, modelId:null\}\] : \[\]/);
});

test('storey-hide in the Navigator tree is model-scoped (byStorey:<modelId>::<name>), not global', () => {
  assert.match(html, /var stHiddenKey = 'byStorey:'\+model\.id\+'::'\+sd\.name;/);
  assert.match(html, /onToggleVis:function\(\)\{d\(\{t:A\.TOGGLE_CLASS_VIS,key:stHiddenKey\}\);\},/);
  assert.match(html, /var sHiddenTKey = 'byStorey:'\+model\.id\+'::'\+st;/);
  assert.match(html, /onToggleVis:function\(\)\{d\(\{t:A\.TOGGLE_CLASS_VIS,key:sHiddenTKey\}\);\},/);
});

test('the visibility-application effect parses the scoped byStorey key and restricts hiding to that one model', () => {
  const body = sliceFrom('var hiddenIds = new Set();', 1300);
  assert.match(body, /if \(view === 'byStorey' && grpKey\.indexOf\('::'\) !== -1\) \{/);
  assert.match(body, /if \(scopedModelId && it\.modelId !== scopedModelId\) return;/);
});

test('no chord path uses bare expressIds: getActiveEids is gone, BX section box uses refs', () => {
  assert.ok(!html.includes('function getActiveEids('), 'flat-id helper must not come back');
  const body = sliceFrom("if(chord==='bx'){", 700);
  assert.match(body, /var bxRefs=getActiveRefs\(\);/);
  assert.match(body, /_sboxAroundElements\(bxRefs\)/);
});

test('section box from the context menu / toolbar is model-scoped', () => {
  assert.match(html, /_sboxAroundElements\(\[\{expressId:ctxMenu\.expressId, modelId:ctxMenu\.modelId\|\|null\}\]\)/);
  assert.match(html, /_sboxAroundElements\(\[\{expressId:selEid, modelId:window\._ccSelectedModelId\|\|null\}\]\)/);
  assert.ok(!/_sboxAroundElements\(\[(ctxMenu\.expressId|selEid)\]\)/.test(html));
});

test('data-quality highlight groups ghost with model-scoped refs', () => {
  assert.ok(!/eids\.push\(el\.expressId\)/.test(html), 'no bare expressId pushes into highlight lists');
  assert.equal((html.match(/eids\.push\(\{expressId:it\.expressId, modelId:it\.modelId\|\|null\}\)/g) || []).length, 2);
});
