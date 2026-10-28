'use strict';
// Wiring of the clash review (index.html): review buckets drive the list,
// one bucket bar replaces the separate notices, grouping is always on,
// the overview only opens after interactive runs, group actions are
// undoable, snapshots never run during detection, BCF shown/all.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');

test('triage core is loaded next to the classification core and precached', () => {
  assert.match(src, /<script src="clash-classification-core\.js" defer><\/script>\n<script src="clash-triage-core\.js" defer><\/script>/);
  assert.match(sw, /'clash-triage-core\.js'/);
});

test('rules.hideBuckets is display-only (not in the run signature); showBuckets resets every run', () => {
  assert.match(src, /k === 'hideContacts' \|\| k === 'hideBuckets' \|\| k === 'roleChoicesRemembered'/);
  assert.match(src, /_st\.filters=Object\.assign\(\{\},_st\.filters\|\|s\.filters,\{showBuckets:\[\],hideBuckets:\[\]\}\)/);
});

test('grouping by root-cause element is the default at any size; big lists render windowed', () => {
  assert.match(src, /if\(\(!Array\.isArray\(s\.clashGroupBy\)\|\|s\.clashGroupBy\.length===0\) && _mr\.clashes\.length>0\) \{ _st\.clashGroupBy=\['element'\]; \}/);
  assert.doesNotMatch(src, /_mr\.clashes\.length<=2000/);
  assert.match(src, /rawItemsProp\.length > CC_WINDOWED_AUTO_MIN/);
});

test('the list is filtered by review bucket and ONE bucket bar replaces the separate notices', () => {
  assert.match(src, /if \(_ccBucketShown\(b, s\.rules, f\)\) return true;/);
  assert.match(src, /<\$\{BucketBar\} counts=\$\{triage\.counts\}/);
  for (const gone of ['var providedCount = useMemo', 'var contactCount = useMemo', 'var classifiedCounts = useMemo']) assert.ok(!src.includes(gone), gone);
});

test('group header actions go through BATCH_UPD_CLASH with explicit ids and are undoable', () => {
  assert.match(src, /d\(\{t:A\.BATCH_UPD_CLASH, ids:openItems2\.map/);
  assert.match(src, /case A\.BATCH_UPD_CLASH: \{\n\s+\/\/ Group header actions/);
  assert.match(src, /replay\(\{t:A\.CLASH_BATCH_RESTORE, prev:prev, keepIssueIds:keep\}\)/);
});

test('the overview auto-opens only after an interactive run, and only for a small review set', () => {
  const inter = src.slice(src.indexOf('window._ccRunDetectionInteractive = function(rulesOverride)'), src.indexOf('function PreRunPanel(props)'));
  assert.match(inter, /\{t:A\.TRIAGE_UPD, u:\{autoOpen:true\}\}/);
  const api = src.slice(src.indexOf('window._ccRunDetection = function(rulesOverride) {'), src.indexOf('window._ccRunDetection = function(rulesOverride) {') + 4000);
  assert.ok(!/autoOpen/.test(api), 'automation never opens the overview');
  assert.match(src, /return tr\.view === 'auto' && !!tr\.autoOpen && rm\.items\.length > 0 && rm\.items\.length <= CC_OVERVIEW_AUTO_MAX;/);
});

test('one filter surface: the overview owns the facets (Filters popover); the sidebar hides its copy meanwhile', () => {
  assert.match(src, /<\$\{TriageFilterBar\} compact=\$\{true\} s=\$\{s\}/);
  assert.match(src, /!_ccOverviewVisible\(s, reviewModel\) && html`<\$\{TriageFilterBar\} s=\$\{s\}/);
  assert.match(src, /data-cc-filters-toggle="1" aria-expanded=\$\{popOpen\?'true':'false'\} aria-controls=\$\{popId\}/);
  // Escape closes the popover first, without closing the overview
  assert.match(src, /if \(e\.key === 'Escape' && popOpen\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); closePop\(true\); \}/);
  // run statistics collapse into one closed "Run details" disclosure
  assert.match(src, /<details data-cc-run-details="1"/);
  assert.match(src, /_cc_t\('panel\.runDetails','Run details'\)/);
});

test('snapshots: visible cards first, cancelled when they leave, one card re-renders per picture', () => {
  const ov = src.slice(src.indexOf('function ClashOverview(props) {'), src.indexOf("  // One list row's filter test"));
  assert.match(ov, /if \(en\.isIntersecting\) vis\.push\(i\); else svc\.cancel\(it\.lead\);/);
  assert.match(ov, /svc\.request\(shown\[i\]\.lead, \{front:true\}\)/);
  assert.ok(!/setTick/.test(ov), 'the grid no longer re-renders on every snapshot');
  const card = src.slice(src.indexOf('function ClashOverviewSnapshot(props) {'), src.indexOf('function ClashOverviewCard(props) {'));
  assert.match(card, /e\.detail\.key === key/);
  assert.match(src, /if \(!res\) \{ _snap\.failed\[job\.key\] = true; _snapNotify\(job\.key\); continue; \}/);
});

test('snapshots wait for an idle viewer and are keyed by identity + both geometry hashes', () => {
  assert.match(src, /if \(_occlBusy\(\) \|\| !S\.mg\) \{ _snap\.stats\.busyDeferrals\+\+; _snapSchedule\(400\); return; \}/);
  assert.match(src, /return _SNAP_VER \+ '\|' \+ _snapIdent\(c\) \+ '\|' \+ ha \+ '\|' \+ hb/);
  assert.match(src, /indexedDB\.open\('cc-snapshots', 1\)/);
});

test('BCF: shown export labels topics with the review item; cached snapshots become viewpoint pictures', () => {
  assert.match(src, /exportBCF\(list, version, s\.viewpoints, s, \{ labelFor: function\(c\) \{ return titles\[c\.id\] \|\| ''; \} \}\)/);
  assert.match(src, /if \(_synth\) vp = \{ camera: _synth\.camera, snapshot: _snapUrl \};/);
});

test('triage state is per project: reset on switch, autosaved, in the project codec', () => {
  // project scope: reset on switch (tests/state-scope.test.js), autosaved
  assert.match(src, /put\('project', [^)]*'triage /);
  assert.match(src, /'selectionSets','searchSets','assignmentRules','modelMeta','triage','deniedPairs','propertyRules','smartViews'\]\.concat\(_CC_VIEW_KEYS\)/);
  assert.match(src, /TRIAGE_STATE:A\.TRIAGE_STATE, UPD_FILTERS:A\.UPD_FILTERS/);
  const codec = require('../project-codec');
  const out = codec.serializeProject({ rules: {}, models: [], clashes: [], issues: [], floors: [], filters: { search: 'duct' },
    triage: { facets: { severity: ['critical'] }, view: 'overview', autoOpen: true, savedViews: [{ id: 'v', name: 'V', facets: {}, search: '' }] } }, 'v', 't');
  assert.deepEqual(out.triage, { facets: { severity: ['critical'] }, search: 'duct', view: 'overview', savedViews: [{ id: 'v', name: 'V', facets: {}, search: '' }], activeViewId: null });
  const acts = [];
  codec.restoreProject(Object.assign({ models: [] }, out), (a) => acts.push(a), { ADD_MODEL: 'AM', UPD_RULES: 'UR', TRIAGE_STATE: 'TS', UPD_FILTERS: 'UF' });
  assert.deepEqual(acts.find((a) => a.t === 'TS').v.facets, { severity: ['critical'] });
  assert.equal(acts.find((a) => a.t === 'UF').u.search, 'duct');
});

// A bucket the rules show (legacy "show contacts" = rules.hideContacts:false,
// or rules.hideBuckets) used to render as a pressed bucket-bar button that
// did nothing when clicked. filters.hideBuckets hides it for the run.
test('every bucket-bar button toggles, including buckets the rules show', () => {
  const vm = require('node:vm');
  const at = src.indexOf('  var _CC_BUCKET_LEGACY_SHOW = ');
  const end = src.indexOf('\n  }\n', src.indexOf('function _ccBucketShown(bucket, rules, f) {')) + 4;
  const core = require('../clash-classification-core.js');
  const ctx = { window: { _ccClashClassificationCore: core } };
  vm.runInNewContext(src.slice(at, end) + '\nthis.shown = _ccBucketShown;', ctx);
  const rules = { hideContacts: false };
  assert.equal(ctx.shown('contact', rules, {}), true, 'the rules show contacts');
  assert.equal(ctx.shown('contact', rules, { hideBuckets: ['contact'] }), false, 'hidden for this run');
  assert.equal(ctx.shown('graze', {}, { showBuckets: ['graze'] }), true);
  assert.equal(ctx.shown('graze', {}, { showBuckets: ['graze'], hideBuckets: ['graze'] }), false, 'hide wins');
  assert.equal(ctx.shown('review', rules, { hideBuckets: ['review'] }), true, 'review is always listed');
  const bar = src.slice(src.indexOf('function BucketBar(props) {'), src.indexOf('var _CC_FACET_TITLES = null;'));
  assert.match(bar, /if \(shown\) \{ if \(byRules\(b\)\) hide\.push\(b\); \} else show\.push\(b\);/);
  assert.match(bar, /u:\{showBuckets: others\.slice\(\), hideBuckets: \[\]\}/);
  assert.match(bar, /\{showBuckets: \[\], hideBuckets: others\.filter\(byRules\)\}/);
});
