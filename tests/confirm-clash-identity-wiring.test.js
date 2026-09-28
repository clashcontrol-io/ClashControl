'use strict';
// Bug 6: confirming a clash must build the resulting issue with full
// element identity (globalIdA/B, uniqueIdA/B, revitIdA/B, storey, ...) via
// the shared _issueIdentityFromClash helper, not a hand-rolled field list
// that omits it (silently breaking BCF <Components> export).
//
// Bug 4: single Confirm (C key / button) and batch "Set status...
// Confirmed" must behave identically -- both promote the clash to a full
// issue via the same helper, and the confirmed clash record itself must
// stay in state.clashes (status:'confirmed', linkedIssueId set) instead of
// being deleted, so the next detection run's reconciliation can match it
// by identity and never "resurrects" it as a brand-new clash.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractFn(name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, name + ' not found in index.html');
  // Balance braces from the first '{' after the signature.
  const braceStart = src.indexOf('{', start);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

test('_ccBuildConfirmIssue exists and delegates identity fields to _issueIdentityFromClash', () => {
  const identitySrc = extractFn('_issueIdentityFromClash');
  const buildSrc = extractFn('_ccBuildConfirmIssue');
  assert.ok(buildSrc.includes('_issueIdentityFromClash'), 'confirm-issue builder must call _issueIdentityFromClash');

  // eslint-disable-next-line no-new-func
  const identityFn = new Function('c', identitySrc.slice(identitySrc.indexOf('{') + 1, identitySrc.lastIndexOf('}')));
  // eslint-disable-next-line no-new-func
  const buildFn = new Function('_issueIdentityFromClash', 'cClash',
    identitySrc + '\n' + buildSrc + '\nreturn _ccBuildConfirmIssue(cClash);'
  );

  const clash = {
    id: 'clash-1', title: 't', description: 'd', priority: 'normal', type: 'hard',
    globalIdA: 'guid-a', globalIdB: 'guid-b', uniqueIdA: 'u-a', uniqueIdB: 'u-b',
    revitIdA: 111, revitIdB: 222, elemA: 1, elemB: 2,
    modelAId: 'mA', modelBId: 'mB', elemAStorey: 'Level 1',
    disciplines: ['structural', 'mep'],
  };
  const issue = buildFn(identityFn, clash);
  assert.equal(issue.globalIdA, 'guid-a');
  assert.equal(issue.globalIdB, 'guid-b');
  assert.equal(issue.uniqueIdA, 'u-a');
  assert.equal(issue.uniqueIdB, 'u-b');
  assert.equal(issue.revitIdA, 111);
  assert.equal(issue.revitIdB, 222);
  assert.deepEqual(issue.globalIds, ['guid-a', 'guid-b']);
  assert.equal(issue.storey, 'Level 1');
  assert.equal(issue.linkedClashId, 'clash-1');
  assert.equal(issue.clashId, 'clash-1');
});

test('the single-confirm UPD_CLASH branch uses _ccBuildConfirmIssue and keeps the clash record (status confirmed + linkedIssueId), not deleting it', () => {
  const start = src.indexOf("if(a.u&&a.u.status==='confirmed'){");
  const region = src.slice(start, start + 3200);
  assert.ok(region.includes('_ccBuildConfirmIssue(cClash)'), 'single confirm must use the shared helper');
  assert.ok(region.includes("status:'confirmed'"), 'confirmed clash must keep status confirmed in state.clashes');
  assert.ok(region.includes('linkedIssueId:newIssue.id'), 'confirmed clash must be linked to its issue');
  assert.ok(!region.includes('clashes:remainClashes'), 'must not delete the clash from state.clashes on confirm');
});

test('BATCH_UPD_CLASH routes status:confirmed through the same _ccBuildConfirmIssue helper as single confirm', () => {
  const start = src.indexOf('case A.BATCH_UPD_CLASH:');
  assert.ok(start !== -1);
  const region = src.slice(start, start + 1200);
  assert.ok(region.includes("a.u.status === 'confirmed'"), 'batch update must special-case confirmed status');
  assert.ok(region.includes('_ccBuildConfirmIssue'), 'batch confirm must use the shared issue builder');
  assert.ok(region.includes("status:'confirmed',linkedIssueId:"), 'batch-confirmed clashes must stay in state with linkedIssueId, matching single confirm');
});
