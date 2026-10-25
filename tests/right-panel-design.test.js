'use strict';
// Right-hand panel + dialogs DESIGN.md pass (models / details / data quality /
// settings). Structural checks; the rendered result is covered by
// tests/browser/design-conformance.mjs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function fnBody(sig) {
  const start = src.indexOf(sig);
  assert.ok(start !== -1, sig + ' not found');
  const end = src.indexOf('\n  function ', start + sig.length);
  return src.slice(start, end === -1 ? undefined : end);
}

test('loader warnings are stored as key + vars and translated where they are drawn', () => {
  assert.doesNotMatch(src, /message:\s*_cc_t\('boundary\./, 'a boundary warning must not store finished translated text');
  assert.match(src, /key: 'boundary\.noSpaces'/);
  assert.match(src, /key: placedPolys \? 'boundary\.partial' : 'boundary\.unplaced'/);
  const notices = fnBody('function _ccModelNotices(m) {');
  assert.match(notices, /_ccLoaderWarningText\(w\)/);
  const helper = fnBody('function _ccLoaderWarningText(w) {');
  assert.match(helper, /return w\.message \|\| '';/, 'old stored warnings (message only) still render as before');
});

test('inspector disclosures are buttons with aria-expanded; the marker is the ▶ / ▼ text it had (DESIGN.md: no added icons)', () => {
  const r = fnBody('function renderDetails() {');
  assert.match(r, /<\$\{CcDisclosure\}/);
  const d = fnBody('function CcDisclosure(props) {');
  assert.match(d, /aria-expanded=/);
  assert.match(d, /aria-controls=/);
  assert.match(d, /\$\{open\?'▼':'▶'\}/);
  assert.doesNotMatch(d, /_ccChevron|<svg/);
});

test('inspector data-quality checks go through _cc_t (no English values)', () => {
  const r = fnBody('function renderDetails() {');
  // bare English detail / label strings (outside a _cc_t call)
  for (const re of [/\|\|'(not assigned|not set|unassigned|missing)'/, /: 'none'\}/, /\+' values'/, /\+' pset'/, /label:'(Psets|Name|Quantities|Material|Floor\/Storey|Object type)'/]) {
    assert.doesNotMatch(r, re);
  }
});

test('right panel tab strip: role=tab + aria-selected, no dot glyph before the label', () => {
  const start = src.indexOf("var labels={models:_cc_t('panel.models.title','Models')");
  assert.ok(start !== -1);
  const strip = src.slice(start - 400, start + 1400);
  assert.match(strip, /role="tablist"/);
  assert.match(strip, /role="tab" aria-selected=/);
  assert.doesNotMatch(strip, /hasDot/);
});

test('Settings focuses its card on open, not the close button', () => {
  const body = fnBody('function SettingsModal(props) {');
  assert.match(body, /_ccUseFocusTrap\(cardRef, true, \{initialFocus:'container'\}\)/);
});

test('Data quality + IDS panels: no added icons (▲ / ▼ text as before), disabled run buttons are the real variant at 0.5', () => {
  const dq = fnBody('function DataQualityPanel(props) {');
  const ids = fnBody('function IDSValidationPanel(props) {');
  assert.doesNotMatch(dq + ids, /_ccChevron/);
  assert.match(dq, /\.\.\.S_BTN_PRIMARY_SM,flexShrink:0,whiteSpace:'nowrap',cursor:\(isRunning \|\| !hasModels\)\?'not-allowed':'pointer',opacity:\(isRunning \|\| !hasModels\)\?0\.5:1/);
  assert.match(ids, /\.\.\.S_BTN_PRIMARY_SM, cursor: runDisabled \? 'not-allowed' : 'pointer', opacity: runDisabled \? 0\.5 : 1/);
});

test('location actions keep one variant in every state; Remove model reads as destructive', () => {
  const geo = fnBody('function _GeoPlacementSection(props) {');
  assert.doesNotMatch(geo, /S_BTN_PRIMARY_SM/);
  const card = fnBody('function ModelCard(props) {');
  assert.match(card, /onClick=\$\{remove\}[^>]*style=\$\{S_BTN_DANGER_GHOST_SM\}/);
});

test('the NL-SfB IDS rule set is translatable through the locale pack', () => {
  const pack = JSON.parse(fs.readFileSync(path.join(root, 'regulations/nl.json'), 'utf8'));
  const sp = pack.dataQuality.idsSpecs.find((x) => x.id === 'nlsfb');
  assert.ok(sp, 'regulations/nl.json idsSpecs carries id "nlsfb"');
  const nl = JSON.parse(fs.readFileSync(path.join(root, 'locales/nl.json'), 'utf8')).strings;
  for (const k of ['name', 'description', 'rules.0']) assert.ok(nl['country.nl.ids.nlsfb.' + k], 'locales/nl.json country.nl.ids.nlsfb.' + k);
  const core = require(path.join(root, 'country-pack-core.js'));
  const bad = JSON.parse(JSON.stringify(pack));
  bad.dataQuality.idsSpecs[0].id = 'Not An Id';
  assert.deepStrictEqual(core.validateSections(pack), [], 'regulations/nl.json still validates');
  assert.ok(core.validateSections(bad).some((e) => /idsSpecs\[0\]\.id/.test(e)), 'an invalid id is refused');
});
