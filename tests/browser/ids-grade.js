'use strict';
// Grades one buildingSMART IDS conformance test case against CC's real
// window._ccRunIDS() output. See:
//   github.com/buildingSMART/IDS — Documentation/ImplementersDocumentation/
//   TestCases/scripts.md
//
// The corpus only has three filename prefixes: pass- (every requirement
// across every specification must hold for the paired .ifc), fail- (at
// least one requirement must fail), invalid- (the .ids itself makes
// conformance impossible, e.g. a facet that can never be satisfied — graded
// the same way as fail-).
//
// CC's engine has a THIRD, orthogonal outcome the corpus's taxonomy doesn't
// have a name for: "not checkable" for facet types it doesn't yet support
// (PredefinedType, non-storey partOf, XSD dataType coercion, ...) rather
// than guessing (see runIDSSpecs' elUnchecked/note handling in
// addons/data-quality.js). A naive pass-rate gate would count every
// honestly-incomplete case as "wrong", which is exactly the kind of
// dishonest number IMPROVEMENT_PLAN.md's Wave 0 was about eliminating. So
// the real gate is "CC never asserts an incorrect verdict" — "couldn't
// verify" is tracked and reported as its own bucket, not folded into either
// pass or fail.
//
// summary is window._ccRunIDS(...).summary: {total, pass, fail, bySpec}.

function gradeIDSCase(prefix, summary) {
  var bySpec = (summary && summary.bySpec) || {};
  var specNames = Object.keys(bySpec);
  var anyUnchecked = specNames.some(function(n) {
    var bs = bySpec[n] || {};
    return bs.unchecked > 0 || (bs.note && /not checkable|skipped/.test(bs.note));
  });
  var ccSaysFail = (summary && summary.fail || 0) > 0;
  var expectFail = prefix === 'fail' || prefix === 'invalid';

  if (ccSaysFail === expectFail) {
    return anyUnchecked
      ? { verdict: 'incomplete', reason: 'correct verdict, but at least one requirement was not checkable' }
      : { verdict: 'conform', reason: null };
  }
  if (anyUnchecked) {
    // Wrong AND unverifiable at the same time: don't blame CC for getting
    // it "wrong" when part of the specification was never actually
    // evaluated — report it as incomplete instead.
    return { verdict: 'incomplete', reason: 'verdict mismatch, but at least one requirement was not checkable so it cannot be blamed as wrong' };
  }
  return {
    verdict: 'wrong',
    reason: expectFail
      ? 'expected at least one requirement to fail, but CC reported all pass (false pass — a non-conformant model would be shown as compliant)'
      : 'expected every requirement to pass, but CC reported a failure (false fail — a conformant model would be incorrectly flagged)'
  };
}

module.exports = { gradeIDSCase };
