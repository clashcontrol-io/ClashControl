'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../clash-reconciliation-core');
const identity = require('../clash-identity-core');

function clash(id, a, b, point, extra) {
  return Object.assign({
    id, uniqueIdA:a, uniqueIdB:b, point:point || [0,0,0],
    distance:-10, status:'open'
  }, extra || {});
}
function deps(extra) {
  return Object.assign({
    computeClashIdentityKey:identity.computeClashIdentityKey,
    computeClashPair:identity.computeClashPair,
    isDeniedClash:()=>false,
    now:1700000000000,
  }, extra || {});
}

test('reconciliation core is immutable and keeps the established cap', () => {
  assert.equal(core.contractVersion, 2);
  assert.equal(core.autoResolveCap, 200);
  assert.equal(Object.isFrozen(core), true);
  assert.equal(typeof core.mergeDetectionResults, 'function');
});

test('first run filters denied clashes and numbers the survivors', () => {
  const denied = clash('denied','a','b',[0,0,0]);
  const kept = clash('kept','c','d',[1,0,0]);
  const out = core.mergeDetectionResults([denied,kept], [], deps({isDeniedClash:(c)=>c===denied}));
  assert.equal(out.clashes.length, 1);
  assert.equal(out.clashes[0].id, 'kept');
  assert.equal(out.clashes[0]._delta, 'new');
  assert.equal(out.clashes[0].number, 1);
  assert.equal(out.clashes[0]._firstSeen, 1700000000000);
  assert.deepEqual(out.deltaSummary, {newCount:1,persisting:0,autoResolved:0,ts:1700000000000});
});

test('persisting clash preserves every human and AI review field', () => {
  const prev = clash('stable','a','b',[1,2,3],{
    number:9,_firstSeen:100,_runCount:4,status:'in_progress',assignee:'jane',priority:'high',
    aiSignals:{x:1},aiFeedback:'yes',aiReasons:['r'],aiResolution:'move',aiNote:'note',
    aiSeverity:'major',aiCategory:'coordination',aiReason:'reason',_clusterGroup:'C-01',
    _clusterSize:3,clashTypeConfirmed:true,linkedIssueId:'issue-1'
  });
  const out = core.mergeDetectionResults([clash('temporary','a','b',[1,2,3],{distance:-20})], [prev], deps()).clashes[0];
  assert.equal(out.id, 'stable');
  assert.equal(out.number, 9);
  assert.equal(out._delta, 'persisting');
  assert.equal(out._firstSeen, 100);
  assert.equal(out._runCount, 5);
  assert.equal(out._prevDepth, -10);
  assert.deepEqual(out._prevPoint, [1,2,3]);
  for (const key of ['status','assignee','priority','aiSignals','aiFeedback','aiReasons','aiResolution','aiNote','aiSeverity','aiCategory','aiReason','_clusterGroup','_clusterSize','clashTypeConfirmed','linkedIssueId']) {
    assert.deepEqual(out[key], prev[key], key + ' must survive');
  }
});

test('an auto-resolved clash reopens when the same identity returns', () => {
  const prev = clash('stable','a','b',[0,0,0],{status:'auto_resolved'});
  const out = core.mergeDetectionResults([clash('fresh','a','b',[0,0,0])], [prev], deps()).clashes[0];
  assert.equal(out.status, 'open');
  assert.equal(out._delta, 'persisting');
});

test('adjacent 0.5m buckets reconcile within 300mm via the point tiebreak', () => {
  const prev = clash('stable','a','b',[0.24,0,0],{number:4});
  const near = core.mergeDetectionResults([clash('near','a','b',[0.26,0,0])], [prev], deps());
  assert.equal(near.clashes[0].id, 'stable');
  assert.equal(near.clashes[0]._delta, 'persisting');
});

// Bug 5: identity is element-pair based, with the point only used as a
// tiebreak when a pair genuinely has MULTIPLE clash instances. An
// unambiguous single clash for a pair (one on each side) must reconcile
// even if its hit point moved far (engine swap, precision differences) --
// otherwise engine switches spuriously duplicate clashes.
test('an unambiguous single clash per pair reconciles even when its point moved far', () => {
  const prev = clash('stable','a','b',[0.24,0,0],{number:4});
  const far = core.mergeDetectionResults([clash('far','a','b',[5,5,5])], [prev], deps());
  assert.equal(far.clashes.length, 1);
  assert.equal(far.clashes[0].id, 'stable');
  assert.equal(far.clashes[0]._delta, 'persisting');
  assert.equal(far.clashes[0].number, 4);
});

// When a pair genuinely has multiple clash instances (e.g. a long duct
// crossing a beam at two points), the point/spatial-cell IS needed as a
// tiebreak -- an ambiguous pair must not collapse to a single record, and
// unmatched prior instances of that pair still auto-resolve normally.
test('a pair with genuinely multiple clash instances still uses the point as a tiebreak', () => {
  const prevA = clash('pair-1','a','b',[0,0,0],{number:1});
  const prevB = clash('pair-2','a','b',[5,0,0],{number:2});
  const out = core.mergeDetectionResults(
    [clash('new-near-1','a','b',[0.1,0,0])],
    [prevA, prevB],
    deps()
  );
  const persisting = out.clashes.filter((c) => c._delta === 'persisting');
  assert.equal(persisting.length, 1);
  assert.equal(persisting[0].id, 'pair-1');
  const resolved = out.clashes.filter((c) => c._delta === 'auto_resolved');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].id, 'pair-2');
});

test('cached identity keys are ignored and recomputed after an identity migration', () => {
  const prev = clash('stable','a','b',[0,0,0],{_identityKey:'obsolete-scheme'});
  const out = core.mergeDetectionResults([clash('fresh','a','b',[0,0,0])], [prev], deps());
  assert.equal(out.clashes.length, 1);
  assert.equal(out.clashes[0].id, 'stable');
  assert.equal(out.clashes[0]._delta, 'persisting');
});

test('auto-resolve records cap at 200 -- all 205 records survive, only 200 flip to auto_resolved', () => {
  const prev = Array.from({length:205}, (_, i) => clash('p'+i,'a'+i,'b'+i,[i,0,0],{number:i+1}));
  const out = core.mergeDetectionResults([], prev, deps());
  // Capping how many auto-resolve per run is fine; deleting the record --
  // assignee/status/comments/history -- is not. CLAUDE.md Item 2.
  assert.equal(out.clashes.length, 205);
  assert.equal(out.clashes.filter((c) => c._delta === 'auto_resolved').length, 200);
  assert.equal(out.clashes.filter((c) => c._delta === 'auto_resolved').every((c) => c.status === 'auto_resolved'), true);
  const overflow = out.clashes.filter((c) => c._delta !== 'auto_resolved');
  assert.equal(overflow.length, 5);
  // Overflow records keep their original status untouched (still 'open')
  // and get their own distinct _delta -- not a stale value carried over
  // from a prior run's _delta (R3 follow-up: _delta is user-visible,
  // e.g. index.html's "New this run" badge).
  assert.equal(overflow.every((c) => c.status === 'open'), true);
  assert.equal(overflow.every((c) => c._delta === 'auto_resolve_capped'), true);
  // R3 follow-up: autoResolved must report only the records that ACTUALLY
  // flipped status (200), not 200+5 -- it previously double-counted the
  // preserved overflow as if they'd been auto-resolved too, when they
  // stayed open. autoResolvedTruncated is the separate, correct home for
  // the overflow count.
  assert.equal(out.deltaSummary.autoResolved, 200);
  assert.equal(out.deltaSummary.autoResolvedTruncated, 5);
});

test('a prior open clash outside this run\'s coverage is preserved untouched, not auto-resolved', () => {
  const inScope = clash('ab-clash', 'modelA-e1', 'modelB-e1', [0,0,0], {number:1, modelAId:'A', modelBId:'B'});
  const outOfScope = clash('cd-clash', 'modelC-e1', 'modelD-e1', [5,0,0], {number:2, modelAId:'C', modelBId:'D'});
  // A run scoped to models A/B: coverage only knows about A and B.
  const coverage = (c) => c.modelAId === 'A' || c.modelAId === 'B' || c.modelBId === 'A' || c.modelBId === 'B';
  const out = core.mergeDetectionResults([], [inScope, outOfScope], deps({coverage}));

  const ab = out.clashes.find((c) => c.id === 'ab-clash');
  const cd = out.clashes.find((c) => c.id === 'cd-clash');
  assert.equal(out.clashes.length, 2, 'no record disappears just because it fell outside this run\'s scope');
  assert.equal(ab._delta, 'auto_resolved');
  assert.equal(ab.status, 'auto_resolved');
  assert.equal(cd._delta, 'not_checked');
  assert.equal(cd.status, 'open', 'a clash this run never looked at must keep its prior status, not flip to auto_resolved');
  assert.equal(out.deltaSummary.notChecked, 1);
});

test('options.coverage absent preserves legacy behaviour (everything treated as in-scope)', () => {
  const prev = clash('legacy', 'a', 'b', [0,0,0], {number:1});
  const out = core.mergeDetectionResults([], [prev], deps());
  assert.equal(out.clashes.length, 1);
  assert.equal(out.clashes[0]._delta, 'auto_resolved');
  assert.equal(out.deltaSummary.notChecked, undefined);
});

test('stable numbers are reused and new clashes fill the lowest gaps', () => {
  const prev = [
    clash('one','a','b',[0,0,0],{number:1}),
    clash('three','c','d',[1,0,0],{number:3}),
  ];
  const next = [
    clash('new-one','a','b',[0,0,0]),
    clash('new-three','c','d',[1,0,0]),
    clash('brand-new','e','f',[2,0,0]),
  ];
  const out = core.mergeDetectionResults(next, prev, deps()).clashes;
  assert.equal(out.find((c)=>c.id==='one').number, 1);
  assert.equal(out.find((c)=>c.id==='three').number, 3);
  assert.equal(out.find((c)=>c.id==='brand-new').number, 2);
});

// Bug 2: an out-of-coverage clash of ANY status (not just open/in_progress)
// must be preserved untouched as 'not_checked', never silently dropped.
test('out-of-coverage clashes are preserved regardless of status (resolved/closed/accepted/denied)', () => {
  const prev = [
    clash('open-oos','a','b',[0,0,0],{status:'open'}),
    clash('resolved-oos','c','d',[1,0,0],{status:'resolved'}),
    clash('closed-oos','e','f',[2,0,0],{status:'closed'}),
    clash('accepted-oos','g','h',[3,0,0],{status:'accepted'}),
  ];
  // This run's coverage never touches any of these pairs.
  const out = core.mergeDetectionResults([], prev, deps({coverage: () => false}));
  assert.equal(out.clashes.length, 4);
  out.clashes.forEach((c) => {
    assert.equal(c._delta, 'not_checked');
  });
  assert.equal(out.clashes.find((c)=>c.id==='resolved-oos').status, 'resolved');
  assert.equal(out.clashes.find((c)=>c.id==='closed-oos').status, 'closed');
  assert.equal(out.clashes.find((c)=>c.id==='accepted-oos').status, 'accepted');
  assert.equal(out.deltaSummary.notChecked, 4);
});

// Bug 3: when a match is only found via the neighbouring-grid-cell fallback
// (point shifted just enough to cross a 0.5m cell boundary), the clash must
// keep its existing number, not get renumbered as if new.
test('a neighbouring-grid-cell fallback match keeps the previous clash number', () => {
  const prev = [clash('orig','a','b',[0.24,0,0],{number:7})];
  // Shift the point just past the 0.5m grid boundary so the exact identity
  // key no longer matches, but it's still within the 300mm fallback radius.
  const next = [clash('orig-run2','a','b',[0.26,0,0])];
  const out = core.mergeDetectionResults(next, prev, deps()).clashes;
  assert.equal(out.length, 1);
  assert.equal(out[0]._delta, 'persisting');
  assert.equal(out[0].number, 7);
});
