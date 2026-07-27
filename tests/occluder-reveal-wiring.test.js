'use strict';
// Locks the Wave 2.2 occluder-reveal UI wiring in IssueRow (index.html):
// window exposure of the impure entry points, the toggle button, and the
// cleanup effect that reveals occluders when a row stops being active
// (guards against a stale hide surviving a J/K navigation between two
// rows that are both still mounted in the virtualized list).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('_ccHideOccluders and _ccRevealOccluders are exposed on window for IssueRow to call', () => {
  assert.ok(/window\._ccHideOccluders = _ccHideOccluders;/.test(src));
  assert.ok(/window\._ccRevealOccluders = _ccRevealOccluders;/.test(src));
});

test('_ccHideOccluders bounds the raycaster short of the clash point and excludes the pair as a second safety net', () => {
  const start = src.indexOf('function _ccHideOccluders(clashPoint, excludeEids)');
  assert.ok(start !== -1);
  const end = src.indexOf('\n      }', start);
  const fnSrc = src.slice(start, end);
  assert.ok(/new THREE\.Raycaster\(origin, dir, 0, Math\.max\(0, dist - 0\.05\)\)/.test(fnSrc), 'far must stop short of the clash point');
  assert.ok(/_ccResolveOccluderHits\(hits, excludeEids\)/.test(fnSrc));
});

function issueRowSrc() {
  const start = src.indexOf('  function IssueRow(props) {');
  assert.ok(start !== -1, 'IssueRow not found');
  const end = src.indexOf('\n  function ', start + 10);
  assert.ok(end !== -1);
  return src.slice(start, end);
}

test('IssueRow declares local occluder-reveal state and a cleanup effect keyed on [active]', () => {
  const rowSrc = issueRowSrc();
  assert.ok(/var orv=useState\(false\), occReveal=orv\[0\], setOccReveal=orv\[1\];/.test(rowSrc));
  assert.ok(/var occTrackedRef=useRef\(\[\]\);/.test(rowSrc));
  const effectMatch = /useEffect\(function\(\)\{[\s\S]*?\}, \[active\]\);/.exec(rowSrc);
  assert.ok(effectMatch, 'must have a useEffect keyed on [active]');
  assert.ok(/_ccRevealOccluders\(occTrackedRef\.current\)/.test(effectMatch[0]), 'the cleanup effect must reveal any stale hide when this row stops being active');
  assert.ok(/setOccReveal\(false\)/.test(effectMatch[0]));
});

test('the toggle button calls _ccHideOccluders with the clash point and elemA/elemB/elementId as excludeEids', () => {
  const rowSrc = issueRowSrc();
  const btnStart = rowSrc.indexOf("aria-label=${_cc_t('issueRow.toggleOccluderAria'");
  assert.ok(btnStart !== -1, 'occluder-reveal button not found');
  const nearby = rowSrc.slice(Math.max(0, btnStart - 1200), btnStart + 100);
  assert.ok(/var excl=\[it\.elemA,it\.elemB,it\.elementId\]\.filter/.test(nearby));
  assert.ok(/window\._ccHideOccluders\(it\.point, excl\)/.test(nearby));
  assert.ok(/window\._ccRevealOccluders\(occTrackedRef\.current\)/.test(nearby), 'toggling off must reveal via the same function the cleanup effect uses');
});

test('the button only renders for clashes with a known point, and guards on window._ccHideOccluders existing', () => {
  const rowSrc = issueRowSrc();
  const btnStart = rowSrc.indexOf("aria-label=${_cc_t('issueRow.toggleOccluderAria'");
  const conditionStart = rowSrc.lastIndexOf('${isClash && it.point', btnStart);
  assert.ok(conditionStart !== -1 && conditionStart < btnStart);
  const condition = rowSrc.slice(conditionStart, btnStart);
  assert.ok(/typeof window\._ccHideOccluders==='function'/.test(condition));
});

test('occluder-reveal never calls ghostOthers/unghostAll - it is strictly additive on top of whatever ghost state already exists', () => {
  const start = src.indexOf('function _ccResolveOccluderHits');
  const end = src.indexOf('window._ccRevealOccluders = _ccRevealOccluders;');
  const block = src.slice(start, end);
  assert.ok(!/\bghostOthers\(/.test(block));
  assert.ok(!/\bunghostAll\(/.test(block));
});
