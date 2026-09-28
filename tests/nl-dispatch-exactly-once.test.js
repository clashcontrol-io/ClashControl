'use strict';
// A single user action (Enter key, click) could reach processNLCommandWithLLM
// more than once for the identical command text -- e.g. a duplicate
// keydown/composition event -- and each call ran its side effects
// independently (dispatches, downloads, fetches), so a toggle like
// "grid off" could double-fire, or "save project" could download twice.
// The fix wraps processNLCommandWithLLM in a dispatch-level exactly-once
// guard: a second call with the same (raw, replyContext) within a short
// window returns the SAME in-flight/just-settled promise instead of
// re-running the command. This is a guard at the dispatch level (works for
// every NL command), not a per-command debounce.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

test('processNLCommandWithLLM is wrapped by a dispatch-level exactly-once guard', () => {
  const wrapStart = html.indexOf('function processNLCommandWithLLM(raw, s, d, replyContext) {');
  const implStart = html.indexOf('function _processNLCommandWithLLMImpl(raw, s, d, replyContext) {');
  assert.ok(wrapStart !== -1, 'processNLCommandWithLLM wrapper not found');
  assert.ok(implStart !== -1, '_processNLCommandWithLLMImpl not found');
  assert.ok(wrapStart < implStart, 'the guard wrapper must be defined before/around the real implementation');
  const wrapBody = html.slice(wrapStart, implStart);
  assert.match(wrapBody, /_nlDispatchGuard/, 'expected a guard state variable');
  assert.match(wrapBody, /_nlDispatchGuard\.key === _dgKey/, 'expected a key comparison');
  assert.match(wrapBody, /NL_DISPATCH_GUARD_MS/, 'expected a named guard window constant, not a magic number');
});

test('behavioral: two synchronous calls with the same command text run the underlying command exactly once', () => {
  const guardStart = html.indexOf('var _nlDispatchGuard = null;');
  const implStart = html.indexOf('function _processNLCommandWithLLMImpl(raw, s, d, replyContext) {');
  assert.ok(guardStart !== -1 && implStart !== -1);
  const guardSrc = html.slice(guardStart, implStart);

  let calls = 0;
  // Stub out the real implementation with a spy that returns a resolved
  // promise carrying the toggle result, mirroring what "grid off" returns.
  const sandbox = {
    Date: { now: () => 1000 }, // frozen clock: both calls land in the same tick
    _processNLCommandWithLLMImpl: function (raw) {
      calls++;
      return Promise.resolve('Grid off.');
    },
  };
  const fn = new Function(
    ...Object.keys(sandbox),
    guardSrc + '; return processNLCommandWithLLM;'
  )(...Object.values(sandbox));

  const s = {}, d = () => {};
  const p1 = fn('grid off', s, d);
  const p2 = fn('grid off', s, d); // duplicate call, same tick — simulates a double Enter/keydown
  assert.equal(calls, 1, 'the underlying command must run exactly once for two duplicate calls');
  assert.equal(p1, p2, 'the duplicate call must return the same promise, not start a new one');

  return Promise.all([p1, p2]).then(([r1, r2]) => {
    assert.equal(r1, 'Grid off.');
    assert.equal(r2, 'Grid off.');
  });
});

test('behavioral: a different command text is NOT deduped against a recent unrelated command', () => {
  const guardStart = html.indexOf('var _nlDispatchGuard = null;');
  const implStart = html.indexOf('function _processNLCommandWithLLMImpl(raw, s, d, replyContext) {');
  const guardSrc = html.slice(guardStart, implStart);

  let calls = [];
  const sandbox = {
    Date: { now: () => 1000 },
    _processNLCommandWithLLMImpl: function (raw) {
      calls.push(raw);
      return Promise.resolve('ok:' + raw);
    },
  };
  const fn = new Function(
    ...Object.keys(sandbox),
    guardSrc + '; return processNLCommandWithLLM;'
  )(...Object.values(sandbox));

  const s = {}, d = () => {};
  fn('grid off', s, d);
  fn('run detection', s, d);
  assert.deepEqual(calls, ['grid off', 'run detection'], 'unrelated commands must not be deduped against each other');
});

test('behavioral: the same command text again AFTER the guard window elapses runs again', () => {
  const guardStart = html.indexOf('var _nlDispatchGuard = null;');
  const implStart = html.indexOf('function _processNLCommandWithLLMImpl(raw, s, d, replyContext) {');
  const guardSrc = html.slice(guardStart, implStart);

  let now = 1000;
  let calls = 0;
  const sandbox = {
    Date: { now: () => now },
    _processNLCommandWithLLMImpl: function () {
      calls++;
      return Promise.resolve('ok');
    },
  };
  const fn = new Function(
    ...Object.keys(sandbox),
    guardSrc + '; return processNLCommandWithLLM;'
  )(...Object.values(sandbox));

  const s = {}, d = () => {};
  fn('save project', s, d);
  now += 5000; // well past NL_DISPATCH_GUARD_MS
  fn('save project', s, d);
  assert.equal(calls, 2, 'a genuine repeat of the same command after the guard window must run again');
});
