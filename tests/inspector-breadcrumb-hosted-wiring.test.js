'use strict';
// Locks that the Identity card in renderDetails (index.html) actually renders
// the breadcrumb (falling back to the old plain "Floor" row when there's
// nothing to build a breadcrumb from) and a Hosted elements card, with click
// = highlight and double-click = frame, matching the interaction convention
// already used by the Navigator tree's own element nodes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const identityStart = src.indexOf('<!-- Identity -->');
assert.ok(identityStart !== -1);
const sectionEnd = src.indexOf('<!-- Dimensions & Constraints -->', identityStart);
assert.ok(sectionEnd !== -1);
const section = src.slice(identityStart, sectionEnd);

test('the breadcrumb row renders when available, with a fallback to the plain Floor row', () => {
  assert.ok(/breadcrumb\.length>0/.test(section));
  assert.ok(/breadcrumb\.join\(' › '\)/.test(section));
  assert.ok(section.indexOf("storey && html`<div style=${ROW}><span style=${LBL}>Floor</span>") !== -1, 'fallback Floor row must survive when breadcrumb is empty');
});

test('the Hosted elements card only renders when there are hosted elements, and caps the list', () => {
  assert.ok(/hostedEls\.length>0 && html/.test(section));
  assert.ok(/Hosted elements \(\$\{hostedEls\.length\}\)/.test(section));
  assert.ok(/hostedEls\.slice\(0,20\)/.test(section));
  assert.ok(/hostedEls\.length>20/.test(section), 'a "+N more" overflow indicator must exist for large hosted lists');
});

test('hosted element rows highlight on click and frame on double-click, matching the Navigator tree convention', () => {
  assert.ok(/onClick=\$\{function\(\)\{if\(_highlightById\)_highlightById\(he\.expressId\);\}\}/.test(section));
  assert.ok(/onDblClick=\$\{function\(\)\{if\(_fitToElement\)_fitToElement\(he\.expressId\);\}\}/.test(section));
});
