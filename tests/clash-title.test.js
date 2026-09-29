'use strict';
// Default clash titles: one shared implementation (clash-classification-core.js)
// used by the browser engine, the local engine and (via the stored title) BCF.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../clash-classification-core.js');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function clash(over) {
  return Object.assign({
    type: 'hard', elemAType: 'IfcDuctSegment', elemBType: 'IfcWall',
    elemAName: 'Supply duct L0', elemBName: 'Corridor wall L0',
    elemAStorey: 'Level 0', elemBStorey: 'Level 0', selfClash: false,
  }, over);
}

test('names + opening classification read as a sentence', () => {
  assert.equal(core.clashTitle(clash({ opening: 'partial' })), 'Supply duct L0 through Corridor wall L0 — opening too small');
  assert.equal(core.clashTitle(clash({ opening: 'provided', type: 'soft' })), 'Supply duct L0 through Corridor wall L0 — provided opening');
});

test('MEP crosses building element; storey appended only when the names lack it', () => {
  const c = clash({ elemAType: 'IfcPipeSegment', elemBType: 'IfcBeam', elemAName: 'Sprinkler main', elemBName: 'Beam B-12', elemAStorey: 'Level 1', elemBStorey: 'Level 1' });
  assert.equal(core.clashTitle(c), 'Sprinkler main crosses Beam B-12 (L1)');
  // names already carry the level -> no duplicate "(L0)"
  assert.equal(core.clashTitle(clash()), 'Supply duct L0 crosses Corridor wall L0');
  // different storeys, neither in the names
  assert.equal(core.clashTitle(clash({ elemAType: 'IfcPipeSegment', elemBType: 'IfcSlab', elemAName: 'Riser', elemBName: 'Slab', elemAStorey: 'Level 0', elemBStorey: 'Level 1' })), 'Riser crosses Slab (L0 / L1)');
});

test('soft and duplicate clashes get their own verb; self clashes are flagged', () => {
  assert.equal(core.clashTitle(clash({ type: 'soft' })), 'Supply duct L0 too close to Corridor wall L0');
  assert.equal(core.clashTitle(clash({ type: 'duplicate', elemAType: 'IfcWall', elemBType: 'IfcWall', elemAName: 'Wall A1', elemBName: 'Wall A2' })), 'Wall A1 duplicates Wall A2 (L0)');
  assert.match(core.clashTitle(clash({ selfClash: true, elemAType: 'IfcBeam', elemBType: 'IfcColumn', elemAName: 'B1', elemBName: 'C1' })), /\(self\)$/);
});

test('GUID-like, generic and Revit-id names fall back to the IFC type label', () => {
  const junk = ['2N7Z1a9AzEXAaxKB3VzjTD', '3f2504e0-4f89-11d3-9a0c-0305e82c3301', '#227', '', null, 'Basic Wall', 'Wall 3',
    'Basic Wall:Generic - 200mm:302345', 'Pipe Segment 12', 'IfcPipeSegment'];
  for (const n of junk) {
    assert.equal(core.meaningfulName(n, n && /Pipe/.test(String(n)) ? 'IfcPipeSegment' : 'IfcWall'), '', 'should be generic: ' + n);
  }
  assert.equal(core.meaningfulName('Sprinkler main', 'IfcPipeSegment'), 'Sprinkler main');
  assert.equal(core.meaningfulName('Beam B-12', 'IfcBeam'), 'Beam B-12');
  assert.equal(core.meaningfulName('x'.repeat(60), 'IfcWall').length, 40);
  const t = core.clashTitle(clash({ elemAName: '2N7Z1a9AzEXAaxKB3VzjTD', elemBName: 'Basic Wall:Generic - 200mm:302345', elemAStorey: 'Level 2', elemBStorey: 'Level 2' }));
  assert.equal(t, 'Duct Segment crosses Wall (L2)');
});

test('title is symmetric in A/B (same pair, either engine ordering)', () => {
  const a = clash({ opening: 'partial' });
  const b = clash({
    opening: 'partial', elemAType: 'IfcWall', elemBType: 'IfcDuctSegment', elemAName: 'Corridor wall L0', elemBName: 'Supply duct L0',
  });
  assert.equal(core.clashTitle(a), core.clashTitle(b));
  const s1 = clash({ elemAType: 'IfcColumn', elemBType: 'IfcBeam', elemAName: 'Column 1', elemBName: 'Beam 1' });
  const s2 = clash({ elemAType: 'IfcBeam', elemBType: 'IfcColumn', elemAName: 'Beam 1', elemBName: 'Column 1' });
  assert.equal(core.clashTitle(s1), core.clashTitle(s2));
});

test('roles stamped by the browser engine and derived from types (local engine before annotation) agree', () => {
  const derived = clash({ elemAType: 'IfcPipeSegment', elemBType: 'IfcSlab' });
  const stamped = Object.assign({}, derived, { roleA: 'mep-main', roleB: 'structural' });
  assert.equal(core.clashTitle(derived), core.clashTitle(stamped));
});

test('storeyShort', () => {
  assert.equal(core.storeyShort('Level 1'), 'L1');
  assert.equal(core.storeyShort('L2'), 'L2');
  assert.equal(core.storeyShort('Level -1'), 'L-1');
  assert.equal(core.storeyShort('Roof'), 'Roof');
  assert.equal(core.storeyShort(''), '');
});

test('legacy type pair stays available and is recognised as a default', () => {
  assert.equal(core.typePairTitle('IfcWall', 'IfcPipeSegment', false), 'Wall × Pipe Segment');
  assert.equal(core.typePairTitle('IfcWall', 'IfcWall', true), 'Wall vs Wall (self)');
  const c = clash({ title: 'Duct Segment × Wall' });
  assert.equal(core.isDefaultTitle(c), true);
  assert.equal(core.isDefaultTitle(clash({ title: 'Wall × Duct Segment' })), true);
});

test('AI titles and user edits are never overwritten', () => {
  const ai = clash({ title: 'AI says hi', aiTitle: 'AI says hi' });
  core.applyDefaultTitle(ai);
  assert.equal(ai.title, 'AI says hi');
  const user = clash({ title: 'Move duct up 200 mm', titleAuto: 'Supply duct L0 crosses Corridor wall L0' });
  core.applyDefaultTitle(user);
  assert.equal(user.title, 'Move duct up 200 mm');
  const fresh = clash({ title: 'Duct Segment × Wall' });
  core.applyDefaultTitle(fresh);
  assert.equal(fresh.title, 'Supply duct L0 crosses Corridor wall L0');
  assert.equal(fresh.titleAuto, fresh.title);
  // an untouched auto title regenerates when the classification changes (opening appears)
  fresh.opening = 'partial';
  core.applyDefaultTitle(fresh);
  assert.equal(fresh.title, 'Supply duct L0 through Corridor wall L0 — opening too small');
});

test('generic-name list stays in sync with the data-quality addon', () => {
  const dq = read('addons/data-quality.js').match(/var GENERIC_RE = (\/.*\/i);/);
  assert.ok(dq, 'GENERIC_RE not found in data-quality.js');
  assert.equal(String(core.GENERIC_NAME_RE), dq[1]);
});

test('re-runs carry AI and user titles but regenerate default ones', () => {
  const rec = require('../clash-reconciliation-core.js');
  const idKey = (c) => c.elemA + '|' + c.elemB;
  const deps = { computeClashIdentityKey: idKey, computeClashPair: idKey, isDeniedClash: () => false, isDefaultTitle: core.isDefaultTitle, now: 1 };
  const mk = (id, over) => clash(Object.assign({ id, elemA: id, elemB: 9, point: [0, 0, 0], status: 'open' }, over));
  const prev = [
    mk(1, { title: 'Duct Segment × Wall' }),
    mk(2, { title: 'AI title', aiTitle: 'AI title' }),
    mk(3, { title: 'My own wording', titleAuto: 'x' }),
  ];
  const next = [1, 2, 3].map((i) => mk(i, { title: 'Supply duct L0 crosses Corridor wall L0', titleAuto: 'Supply duct L0 crosses Corridor wall L0' }));
  const out = rec.mergeDetectionResults(next, prev, deps).clashes;
  const by = (id) => out.find((c) => c.elemA === id);
  assert.equal(by(1).title, 'Supply duct L0 crosses Corridor wall L0');
  assert.equal(by(2).title, 'AI title');
  assert.equal(by(2).aiTitle, 'AI title');
  assert.equal(by(3).title, 'My own wording');
});

test('local-engine converter + annotation titles a pair exactly like the browser engine', () => {
  const src = read('addons/local-engine.js');
  const start = src.indexOf('function _clashFromEngineResult(c, elA, elB, mA, mB, rules) {');
  const end = src.indexOf('\n  function _detectOnLocalEngine(', start);
  assert.ok(start !== -1 && end !== -1, 'converter not found');
  const prevWindow = globalThis.window;
  globalThis.window = { _ccClashClassificationCore: core };
  try {
    const convert = new Function('THREE', src.slice(start, end) + '\n return _clashFromEngineResult;')({});
    const mep = { id: 'm1', name: 'MEP', discipline: 'mep' };
    const arc = { id: 'm2', name: 'ARC', discipline: 'architectural' };
    const duct = { expressId: 11, props: { ifcType: 'IfcDuctSegment', name: 'Supply duct L0', storey: 'Level 0' } };
    const wall = { expressId: 12, props: { ifcType: 'IfcWall', name: 'Corridor wall L0', storey: 'Level 0' } };
    // The engine may name either element "A": both orders must title identically.
    const l1 = convert({ type: 'hard', distance: -40, point: [0, 0, 0] }, duct, wall, mep, arc, {});
    const l2 = convert({ type: 'hard', distance: -40, point: [0, 0, 0] }, wall, duct, arc, mep, {});
    for (const l of [l1, l2]) {
      l.roleA = core.elementRole(l.elemAType, { discipline: l.disciplines[0] });
      l.roleB = core.elementRole(l.elemBType, { discipline: l.disciplines[1] });
      l.opening = 'partial'; // what _ccAnnotateClashes stamps
      core.applyDefaultTitle(l);
    }
    // Browser-engine clash object for the same pair (fields as _buildClashBase writes them).
    const browser = {
      type: 'hard', elemAType: 'IfcWall', elemBType: 'IfcDuctSegment', elemAName: 'Corridor wall L0', elemBName: 'Supply duct L0',
      elemAStorey: 'Level 0', elemBStorey: 'Level 0', roleA: 'architectural', roleB: 'mep-main', opening: 'partial', selfClash: false,
      title: 'Wall × Duct Segment',
    };
    core.applyDefaultTitle(browser);
    assert.equal(l1.title, 'Supply duct L0 through Corridor wall L0 — opening too small');
    assert.equal(l1.title, l2.title);
    assert.equal(l1.title, browser.title);
  } finally {
    if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
  }
});

test('_ccAnnotateClashes (local-engine results) regenerates the title once roles + opening are known', () => {
  const idx = read('index.html');
  const start = idx.indexOf('  function _ccApplyDefaultTitle(c) {');
  const end = idx.indexOf('  // ── Provision for void: is a clash', start);
  assert.ok(start !== -1 && end !== -1, 'annotate block not found');
  const prevWindow = globalThis.window;
  globalThis.window = { _ccClashClassificationCore: core };
  try {
    const run = new Function('_ccRoleOfElement', '_ccOpeningStatusForPair',
      idx.slice(start, end) + '\n return _ccAnnotateClashes;')(
      (el, m) => core.elementRole(el.props.ifcType, { discipline: m.discipline }),
      () => 'partial');
    const mep = { id: 'm1', discipline: 'mep', elements: [{ expressId: 11, props: { ifcType: 'IfcDuctSegment' } }] };
    const arc = { id: 'm2', discipline: 'architectural', elements: [{ expressId: 12, props: { ifcType: 'IfcWall' } }] };
    const c = clash({ modelAId: 'm1', modelBId: 'm2', elemA: 11, elemB: 12, title: 'Duct Segment × Wall' });
    delete c.opening;
    run([c], [mep, arc]);
    assert.equal(c.opening, 'partial');
    assert.equal(c.title, 'Supply duct L0 through Corridor wall L0 — opening too small');
    const user = clash({ modelAId: 'm1', modelBId: 'm2', elemA: 11, elemB: 12, title: 'Renamed by user' });
    run([user], [mep, arc]);
    assert.equal(user.title, 'Renamed by user');
  } finally {
    if (prevWindow === undefined) delete globalThis.window; else globalThis.window = prevWindow;
  }
});

test('wiring: both engines and the row UI use the shared core', () => {
  const idx = read('index.html');
  assert.match(idx, /_ccApplyDefaultTitle\(clashes\[clashes\.length - 1\]\);/);
  assert.match(idx, /function _ccAnnotateClashes[\s\S]{0,1800}_ccApplyDefaultTitle\(c\);/);
  assert.match(idx, /isDefaultTitle:function\(c\)/);
  assert.match(idx, /_pc\.typePairTitle\(it\.elemAType, it\.elemBType/);
  const le = read('addons/local-engine.js');
  assert.match(le, /_cls\.applyDefaultTitle\(out\)/);
  assert.doesNotMatch(le, /function nice\(t\)/, 'local engine must not keep its own title formatter');
});
