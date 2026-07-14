const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const safety = require('../safety-migrations');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function between(startText, endText) {
  const start = source.indexOf(startText);
  assert.notEqual(start, -1, `missing start marker: ${startText}`);
  const end = source.indexOf(endText, start);
  assert.notEqual(end, -1, `missing end marker: ${endText}`);
  return source.slice(start, end);
}

function loadDetectionCore(browserDetect) {
  const core = between('var _DETECT_CHUNK_SIZE', 'function _showFunnelToast');
  const dispatches = [];
  const classified = [];
  const context = {
    window: null,
    console: { log() {}, warn() {}, error() {} },
    Promise,
    Object,
    Array,
    isFinite,
    A: { MERGE_CLASHES: 'MERGE_CLASHES' },
    classifyClashes(result) { classified.push(result); },
    _browserDetect: browserDetect,
  };
  context.window = context;
  context.window._ccSafetyMigrations = safety;
  context.window._ccLatestState = {};
  context.window.dispatchEvent = () => {};
  vm.createContext(context);
  vm.runInContext(core, context);
  return { context, dispatches, classified,
    dispatch(action) { dispatches.push(action); } };
}

test.afterEach(() => safety._setFlagsForTest({}));

test('concurrencyV2 is the only switch that activates the single-flight coordinator', () => {
  const core = between('var _DETECT_CHUNK_SIZE', 'function _showFunnelToast');
  assert.match(core, /isEnabled\('concurrencyV2'\)/);
  assert.match(core, /_ccDetectionCoordinator\.begin\('detection'\)/);
  assert.match(core, /already-running/);
  assert.match(core, /_ccDetectionCoordinator\.cancel\(\)/);
});

test('stale or suppressed generations are rejected before classification and dispatch', () => {
  const commit = between('function _ccDetectionResultUsable', 'window._ccCommitDetectionResult =');
  const guard = commit.indexOf('if (!_ccDetectionResultUsable(result))');
  const classify = commit.indexOf('classifyClashes(result)');
  const dispatch = commit.indexOf('dispatch(action)');
  assert.ok(guard >= 0 && classify > guard && dispatch > classify);
  assert.match(commit, /result\._ccGeneration === _ccDetectGeneration/);
  assert.match(commit, /stale-write-blocked/);
});

test('every direct detection-result state write uses the guarded commit helper', () => {
  assert.doesNotMatch(source, /detectClashesAsync\([^\n]+\)\.then\(function\(result\)\{\s*classifyClashes\(result\)/);
  const directCalls = [...source.matchAll(/detectClashesAsync\([^\n]+\)\.then\(function\(result\)\{/g)];
  assert.ok(directCalls.length >= 7, 'expected the UI, API, NL and bridge detection call sites');
  for (const match of directCalls) {
    const nearby = source.slice(match.index, match.index + 320);
    assert.ok(
      nearby.includes('_ccCommitDetectionResult') || nearby.includes('_ccDetectionResultUsable'),
      `unguarded detection completion near byte ${match.index}`
    );
  }
});

test('the intentional multi-self run is serialized only when concurrencyV2 is enabled', () => {
  const section = between('var multiRun;', 'multiRun.then(function(results)');
  assert.match(section, /if \(_ccConcurrencyV2Enabled\(\)\)/);
  assert.match(section, /multiSelf\.reduce/);
  assert.match(section, /else \{\s*multiRun = Promise\.all/);
  assert.match(section, /_ccDetectionResultUsable\(result\)/);
});

test('Smart Bridge completion is emitted only after a guarded result commit', () => {
  const bridgeRun = between('window._ccRunDetection = function', '// Run a RULESET');
  const commit = bridgeRun.indexOf('if (!_ccCommitDetectionResult(result, d)) return;');
  const event = bridgeRun.indexOf("new CustomEvent('cc-detection-complete'");
  assert.ok(commit >= 0 && event > commit);
});

test('live core: overlapping enabled run is suppressed and cannot write an empty result', async () => {
  safety._setFlagsForTest({ concurrencyV2: true });
  let release;
  const harness = loadDetectionCore(() => new Promise((resolve) => { release = resolve; }));
  const first = harness.context.detectClashesAsync([{ id: 'm' }], {});
  const duplicate = await harness.context.detectClashesAsync([{ id: 'm' }], {});
  assert.equal(duplicate._ccSuppressed, 'already-running');
  assert.equal(harness.context._ccCommitDetectionResult(duplicate, harness.dispatch), false);
  assert.equal(harness.dispatches.length, 0);

  release([{ id: 'real-clash' }]);
  const result = await first;
  assert.equal(harness.context._ccCommitDetectionResult(result, harness.dispatch), true);
  assert.equal(harness.dispatches.length, 1);
  assert.equal(harness.dispatches[0].v[0].id, 'real-clash');
  assert.equal(harness.classified.length, 1);
});

test('live core: cancelled generation cannot commit after its async work finishes', async () => {
  safety._setFlagsForTest({ concurrencyV2: true });
  let release;
  const harness = loadDetectionCore(() => new Promise((resolve) => { release = resolve; }));
  const run = harness.context.detectClashesAsync([{ id: 'm' }], {});
  harness.context.cancelDetection();
  release([{ id: 'late-clash' }]);
  const result = await run;
  assert.equal(result._ccSuppressed, 'stale-generation');
  assert.equal(harness.context._ccCommitDetectionResult(result, harness.dispatch), false);
  assert.equal(harness.dispatches.length, 0);
  assert.equal(harness.classified.length, 0);
});
