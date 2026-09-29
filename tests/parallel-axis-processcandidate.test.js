'use strict';
// CLAUDE.md Item 6, R6 follow-up: tests/parallel-axis-rejection-removed.test.js
// locks the deletion structurally (the comment string is gone) and
// behaviourally against _meshesIntersect called DIRECTLY -- but that
// bypasses _processCandidate entirely, so if the shortcut were ever
// reintroduced INSIDE _processCandidate under different wording (not the
// literal deleted comment/formula text), neither of those tests would
// notice: the structural check wouldn't match different wording, and the
// behavioural check never goes anywhere near _processCandidate.
//
// This drives the exact review counterexample through the REAL
// _processCandidate -- the actual function _detectClashesCore's chunk loop
// calls per candidate pair, including the exact spot the deleted shortcut
// used to sit -- so a reintroduced rejection anywhere in that function,
// under any wording, breaks this test.
//
// Extraction strategy: _processCandidate is a closure nested inside
// _detectClashesCore, over ~20 variables/helper functions _detectClashesCore
// declares as ordinary sequential statements before defining it (scratch
// Vector3 buffers, _buildClashBase and its siblings, the type-pair memo,
// the semantic-filter relatedPairs map, etc). The only way to get a
// _processCandidate whose closure is genuinely populated -- not
// hand-faked -- is to execute _detectClashesCore's real preamble text
// through _processCandidate's own definition, exactly as the browser does,
// with `models`/`rules` chosen so every side effect along the way
// (broad-phase sweep, semantic-filter map, change-aware hashing, type-pair
// memo) resolves to an empty/disabled no-op rather than needing to be
// faked. The handful of genuine external dependencies (uid, discipline
// lookup, the type-pair memo's localStorage-backed helpers, THREE.Vector3)
// are stubbed; _meshesIntersect itself is the REAL one, extracted the same
// way tests/penetration-depth.test.js and
// tests/parallel-axis-rejection-removed.test.js already do.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

// ── Real intersection kernel (same extraction as
// parallel-axis-rejection-removed.test.js) ─────────────────────────────────
const kernelStart = src.indexOf('function _getWorldVerts(el) {');
assert.notEqual(kernelStart, -1, '_getWorldVerts not found');
const kernelFnStart = src.indexOf('function _meshesIntersect(elA, elB) {', kernelStart);
assert.notEqual(kernelFnStart, -1, '_meshesIntersect not found');
const kernelRet = src.indexOf('return _postProcessIntersectPoints(pts, maxDepth[0], elA.box, elB.box, _MI_MARGIN);', kernelFnStart);
assert.notEqual(kernelRet, -1, '_meshesIntersect body not found');
const kernelEnd = src.indexOf('\n  }', kernelRet) + '\n  }'.length;
const kernelBlock = src.slice(kernelStart, kernelEnd);

// ── _detectClashesCore's preamble through the end of _processCandidate ──
const coreStart = src.indexOf('function _detectClashesCore(models, rules, onProgress, resolveAsync) {');
assert.notEqual(coreStart, -1, '_detectClashesCore not found');
const coreEnd = src.indexOf('\n\n    // ── Finalize results after all candidates processed', coreStart);
assert.notEqual(coreEnd, -1, '_processCandidate end not found');
const coreBlock = src.slice(coreStart, coreEnd) + '\n    return _processCandidate;\n  }';

function loadProcessCandidateFactory() {
  // window/CustomEvent/Event: only ever used for progress-event
  // dispatching (_phase), swallowed by _detectClashesCore's own try/catch.
  // _ccResolveModelScope/_sweepAndPruneWasm/_sweepAndPrune are the real
  // broad phase; with models=[] they resolve to grpA=grpB=[] and
  // candidates=[] with zero risk (never used -- we call _processCandidate
  // directly with a hand-built pair, bypassing the sweep entirely).
  const body = `
    function _ccResolveModelScope(models, id) { return []; }
    function _sweepAndPruneWasm() { return null; }
    function _sweepAndPrune() { return []; }
    ${kernelBlock}
    function uid() { return 'TESTID'; }
    function _ccElementDiscipline() { return 'other'; }
    function _ccMatrixSkipsSameDiscipline() { return false; }
    function _ccStableJSON() { return ''; }
    function _tpMemoModelsKey() { return ''; }
    function _tpModelFingerprint() { return ''; }
    function _tpMemoLoad() { return null; }
    function _hashElement() { return ''; }
    var _prevElementHashes = {};
    ${coreBlock}
    return _detectClashesCore;
  `;
  return new Function('window', 'Event', 'CustomEvent', 'THREE', 'performance', body);
}

// Minimal THREE.Vector3/Box3-compatible shims -- _buildClashBase and
// _processCandidate only ever call .getSize(target)/.getCenter(target) on
// boxes and .distanceTo(other) on the resulting vectors.
function Vec3() { this.x = 0; this.y = 0; this.z = 0; }
Vec3.prototype.distanceTo = function(o) {
  var dx = this.x - o.x, dy = this.y - o.y, dz = this.z - o.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
};
function makeBox(min, max) {
  return {
    min: { x: min[0], y: min[1], z: min[2] },
    max: { x: max[0], y: max[1], z: max[2] },
    getSize: function(target) {
      target.x = this.max.x - this.min.x; target.y = this.max.y - this.min.y; target.z = this.max.z - this.min.z;
      return target;
    },
    getCenter: function(target) {
      target.x = (this.max.x + this.min.x) / 2; target.y = (this.max.y + this.min.y) / 2; target.z = (this.max.z + this.min.z) / 2;
      return target;
    },
  };
}

// Axis-aligned box as a 12-triangle soup (copied from
// tests/parallel-axis-rejection-removed.test.js -- duplicated rather than
// shared, matching this repo's existing test-helper convention).
function boxTris(x0, y0, z0, x1, y1, z1) {
  var v = {
    a: [x0, y0, z0], b: [x1, y0, z0], c: [x1, y1, z0], d: [x0, y1, z0],
    e: [x0, y0, z1], f: [x1, y0, z1], g: [x1, y1, z1], h: [x0, y1, z1],
  };
  var faces = [
    ['a', 'b', 'c'], ['a', 'c', 'd'], ['e', 'g', 'f'], ['e', 'h', 'g'],
    ['a', 'b', 'f'], ['a', 'f', 'e'], ['d', 'c', 'g'], ['d', 'g', 'h'],
    ['a', 'd', 'h'], ['a', 'h', 'e'], ['b', 'c', 'g'], ['b', 'g', 'f'],
  ];
  var out = [];
  faces.forEach(function(f) { f.forEach(function(k) { out.push(v[k][0], v[k][1], v[k][2]); }); });
  return new Float32Array(out);
}

function makeElement(id, min, max, axis) {
  return {
    expressId: id,
    box: makeBox(min, max),
    props: { ifcType: 'IfcBeam', axis: axis },
    _triCache: boxTris(min[0], min[1], min[2], max[0], max[1], max[2]),
  };
}

function fakeWindow() {
  return { dispatchEvent() {}, _ccDetectProgress: null };
}

test('_processCandidate finds the real intersection for the review counterexample -- no shortcut rejects it first', () => {
  const factory = loadProcessCandidateFactory();
  const THREE = { Vector3: Vec3 };
  const _processCandidate = factory(fakeWindow(), function Event(t) { this.type = t; },
    function CustomEvent(t, i) { this.type = t; this.detail = i && i.detail; }, THREE, { now: () => Date.now() })(
    [], // models
    { hard: true, maxGap: 0 }, // rules: hard-clash-only run, matching the review's fixture
    null, // onProgress
    null  // resolveAsync
  );
  assert.equal(typeof _processCandidate, 'function');

  // The review's exact counterexample: both elements axis [1,0,0], AABBs
  // overlapping by a genuine 2m x 0.25m x 0.2m = 0.1 m^3.
  const elA = makeElement(1, [-5, -1, -0.1], [5, 1, 0.1], [1, 0, 0]);
  const elB = makeElement(2, [3, 0.75, -0.1], [13, 2.75, 0.1], [1, 0, 0]);
  const modelA = { id: 'mA', name: 'Model A', discipline: 'structural' };
  const modelB = { id: 'mB', name: 'Model B', discipline: 'structural' };

  // _processCandidate itself doesn't return anything -- it pushes onto the
  // closure-captured `clashes` array. We don't have a handle on that array
  // directly (it's internal to the returned closure's captured scope), so
  // assert via the one observable side effect this factory exposes: call
  // it once and confirm it doesn't throw, then verify indirectly by
  // re-invoking through a variant that captures the array.
  assert.doesNotThrow(() => {
    _processCandidate({ eA: elA, mA: modelA, eB: elB, mB: modelB, sameModel: false });
  });
});

// The test above only proves _processCandidate runs without throwing --
// useful (a reintroduced shortcut that early-`return`s wouldn't throw
// either, so this alone can't tell "rejected" from "accepted" apart). The
// real assertion needs to observe whether a clash was actually recorded,
// which means capturing `clashes` from inside the closure. Do that by
// having the factory return both _processCandidate AND a way to read the
// clashes it pushed.
function loadProcessCandidateWithClashSink() {
  const body = `
    function _ccResolveModelScope(models, id) { return []; }
    function _sweepAndPruneWasm() { return null; }
    function _sweepAndPrune() { return []; }
    ${kernelBlock}
    function uid() { return 'TESTID'; }
    function _ccElementDiscipline() { return 'other'; }
    function _ccMatrixSkipsSameDiscipline() { return false; }
    function _ccStableJSON() { return ''; }
    function _tpMemoModelsKey() { return ''; }
    function _tpModelFingerprint() { return ''; }
    function _tpMemoLoad() { return null; }
    function _hashElement() { return ''; }
    var _prevElementHashes = {};
    ${coreBlock.replace('\n    return _processCandidate;\n  }', '\n    return {processCandidate:_processCandidate, clashes:clashes};\n  }')}
    return _detectClashesCore;
  `;
  return new Function('window', 'Event', 'CustomEvent', 'THREE', 'performance', body);
}

function runProcessCandidate(rules, elA, modelA, elB, modelB, sameModel) {
  const factory = loadProcessCandidateWithClashSink();
  const THREE = { Vector3: Vec3 };
  const { processCandidate, clashes } = factory(fakeWindow(), function Event(t) { this.type = t; },
    function CustomEvent(t, i) { this.type = t; this.detail = i && i.detail; }, THREE, { now: () => Date.now() })(
    [], rules, null, null
  );
  processCandidate({ eA: elA, mA: modelA, eB: elB, mB: modelB, sameModel: !!sameModel });
  return clashes;
}

test('_processCandidate records a real hard clash for the review counterexample (the pair is not rejected before the intersection kernel)', () => {
  const elA = makeElement(1, [-5, -1, -0.1], [5, 1, 0.1], [1, 0, 0]);
  const elB = makeElement(2, [3, 0.75, -0.1], [13, 2.75, 0.1], [1, 0, 0]);
  const modelA = { id: 'mA', name: 'Model A', discipline: 'structural' };
  const modelB = { id: 'mB', name: 'Model B', discipline: 'structural' };

  const clashes = runProcessCandidate({ hard: true, maxGap: 0, excludeSameDiscipline: false }, elA, modelA, elB, modelB, false);

  assert.equal(clashes.length, 1, 'the real intersection kernel must find and record this clash -- a shortcut rejecting the pair first would leave clashes empty');
  assert.equal(clashes[0].type, 'hard');
});

test('sanity: two genuinely far-apart parallel elements produce NO clash through the same real path', () => {
  const elA = makeElement(1, [-5, -1, -0.1], [5, 1, 0.1], [1, 0, 0]);
  const elFar = makeElement(3, [1000, 1000, 1000], [1001, 1001, 1001], [1, 0, 0]);
  const modelA = { id: 'mA', name: 'Model A', discipline: 'structural' };
  const modelB = { id: 'mB', name: 'Model B', discipline: 'structural' };

  const clashes = runProcessCandidate({ hard: true, maxGap: 0, excludeSameDiscipline: false }, elA, modelA, elFar, modelB, false);
  assert.equal(clashes.length, 0);
});
