'use strict';
// Bug 8 (partial): the clash list's status filter had no "Denied" option
// (denied clashes were unconditionally stripped before the filter ever
// saw them, so there was no way to review/undo a deny), and IDS/
// data-quality validation failures were folded into the clash stats
// bar's Total/Hard/Soft counts as if they were real geometric clashes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('the status filter pill row includes a Denied option for the clash tab', () => {
  const start = src.indexOf("<span style=${FL}>${_cc_t('issues.filter.status','Status')}</span>");
  assert.ok(start !== -1, 'status filter block not found');
  const region = src.slice(start, start + 500);
  assert.ok(region.includes("'denied'"), 'status filter options must include denied');
  assert.ok(region.includes('isClashTab?'), 'denied option should be clash-tab specific (issues have no denied status)');
});

test('rawItems only unconditionally strips denied clashes when the Denied filter itself is not selected', () => {
  const start = src.indexOf('var rawItems = React.useMemo(function(){');
  assert.ok(start !== -1);
  const region = src.slice(start, start + 700);
  assert.ok(region.includes("f.status==='denied' || f.showHandled || c.status!=='denied'"), 'expected the denied-filter-aware base list guard (also open when the "Show resolved/denied" toggle is on)');
  assert.ok(region.includes('f.status'), 'rawItems memo must depend on f.status now that it affects the base list');
});

test('ClashStatsBar excludes _idsValidation entries from total/hard/soft counts', () => {
  const start = src.indexOf('function ClashStatsBar(props) {');
  assert.ok(start !== -1);
  const region = src.slice(start, start + 1400);
  assert.ok(region.includes('it._idsValidation'), 'counts loop must check the _idsValidation flag');
  assert.ok(region.includes('c.dataQuality++'), 'data-quality entries should be tallied separately, not folded into total/hard/soft');
});

// Direct behavioural check of the ClashStatsBar counting logic (extracted
// by source markers, evaluated against a synthetic item list).
test('ClashStatsBar counts: an _idsValidation item never contributes to total/hard/soft', () => {
  const start = src.indexOf("var counts = React.useMemo(function(){");
  const bodyStart = src.indexOf('{', start);
  let depth = 0, i = bodyStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  const fnBody = src.slice(bodyStart + 1, i - 1);
  // eslint-disable-next-line no-new-func
  const run = new Function('items', 'isClash', fnBody + '\nreturn c;');

  const items = [
    { type: 'hard', status: 'open', aiTitle: 't' },
    { type: 'soft', status: 'open', aiTitle: 't' },
    { type: 'hard', status: 'open', aiTitle: 't', _idsValidation: true }, // data-quality masquerading as hard
    { type: 'soft', status: 'open', aiTitle: 't', _idsValidation: true },
  ];
  const counts = run(items, true);
  assert.equal(counts.total, 2, 'total must not include _idsValidation entries');
  assert.equal(counts.hard, 1, 'hard must not include the _idsValidation hard-tagged entry');
  assert.equal(counts.soft, 1, 'soft must not include the _idsValidation soft-tagged entry');
  assert.equal(counts.dataQuality, 2);
});
