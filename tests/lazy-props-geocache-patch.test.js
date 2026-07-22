'use strict';
// Regression lock for a real-browser-probe finding (V7_RELEASE_PLAN.md P6.2-
// continued): a model parked (or auto-parked) WHILE its lazy Phase 2 property
// extraction was still in flight used to permanently lose eligibility for
// Park/Restore's fast cache-based rebuild (_geoDeserialize) -- every future
// restore silently fell back to a full cold IFC re-parse (_ccColdParseParkedEntry)
// forever, because `_mergeLazyProps` bailed out entirely once the model was
// gone from `s.models`, before ever reaching the geoCache patch that marks
// `hasPsets: true`.
//
// Confirmed empirically: a 30k-element synthetic model parked moments after
// load (before its own lazy props phase landed) plateaued at 3.9x the heap of
// a fresh load of the same element count across repeated park/restore
// cycles. After decoupling the geoCache patch from the live in-memory model
// lookup, the same fixture (no test changes) dropped to 1.44x, with cycle 2+
// deltas shrinking from ~150MB to ~1MB -- direct evidence the fast path is
// now actually reached.
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

test('_mergeLazyProps does not bail out of the whole function when the model is gone from s.models', () => {
  const body = sliceFrom('function _mergeLazyProps(modelId, propMap) {', 3200);
  // The old bug: `if (!model || !model.elements) return;` as the first thing
  // after the model lookup, short-circuiting everything below it, including
  // the geoCache patch. That exact early-return-the-whole-function shape must
  // be gone.
  assert.doesNotMatch(body, /if \(!model \|\| !model\.elements\) return;/);
});

test('the geoCache patch runs unconditionally (not nested inside an if(model) block)', () => {
  const body = sliceFrom('function _mergeLazyProps(modelId, propMap) {', 3200);
  const ifModelIdx = body.indexOf('if (model && model.elements) {');
  const idbCallIdx = body.indexOf('idbGetGeoCache(modelId).then(');
  assert.ok(ifModelIdx !== -1, 'expected the model-found branch to be an if(model && model.elements) block');
  assert.ok(idbCallIdx !== -1, 'expected an unconditional idbGetGeoCache(modelId).then(...) call');
  // Find where the `if (model && model.elements) {` block closes by counting
  // brace depth from its opening brace -- the geoCache patch call must sit
  // AFTER that close, not inside it.
  let depth = 0, closeIdx = -1;
  for (let i = body.indexOf('{', ifModelIdx); i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}') { depth--; if (depth === 0) { closeIdx = i; break; } }
  }
  assert.ok(closeIdx !== -1, 'could not find the closing brace of the if(model) block');
  assert.ok(idbCallIdx > closeIdx, 'the geoCache patch must run after the if(model) block closes, not nested inside it');
});

test('when the model is gone, the geoCache patch falls back to canonicalizing straight from propMap by expressId', () => {
  const body = sliceFrom('function _mergeLazyProps(modelId, propMap) {', 3200);
  assert.match(body, /var pm2 = propMap\[_ed\.eid\];/);
  assert.match(body, /_ed\.props\.quantities = _ccCanonQuantities\(pm2\.quantities\)/);
  assert.match(body, /_ed\.props\.psets\s*=\s*_ccCanonPsets\(pm2\.psets\)/);
});

test('hasPsets is still set unconditionally once the geoCache patch runs (not gated on merged > 0)', () => {
  const body = sliceFrom('function _mergeLazyProps(modelId, propMap) {', 3200);
  assert.doesNotMatch(body, /if \(merged > 0\)/);
  assert.match(body, /cached\.hasPsets = true;/);
  assert.match(body, /idbSaveGeoCache\(modelId, cached\);/);
});

test('the live-model branch still canonicalizes and dispatches _propsVersion exactly as before, only now scoped inside an if(model) guard', () => {
  const body = sliceFrom('function _mergeLazyProps(modelId, propMap) {', 3200);
  assert.match(body, /if \(model && model\.elements\) \{/);
  assert.match(body, /el\.props\.quantities = _ccCanonQuantities\(pm\.quantities\)/);
  assert.match(body, /el\.props\.psets\s*=\s*_ccCanonPsets\(pm\.psets\)/);
  assert.match(body, /_ccDispatch\(\{t:'UPD_MODEL', id:modelId, u:\{_propsVersion:Date\.now\(\)\}\}\)/);
});
