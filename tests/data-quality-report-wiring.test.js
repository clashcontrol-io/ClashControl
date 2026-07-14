'use strict';
// Locks the two entry points for _ccDataQualityReport (index.html): the "Print
// report" button in DataQualityPanel, and the "Data quality report" entry in
// IssuePanel's Export flyout (alongside the pre-existing "Clash report"). Also
// locks that the DQ panel's CSV button was renamed off "Export report" - that
// string used to collide in meaning with the new print report.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function html() {
  return fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
}

test('DataQualityPanel has a Print report button calling window._ccDataQualityReport(s)', () => {
  const src = html();
  const panelStart = src.indexOf('function DataQualityPanel(props) {');
  assert.ok(panelStart !== -1);
  const panelEnd = src.indexOf('\n  function ', panelStart + 40); // next top-level function after the panel
  const panelSrc = src.slice(panelStart, panelEnd === -1 ? panelStart + 20000 : panelEnd);
  assert.ok(/window\._ccDataQualityReport\(s\)/.test(panelSrc), 'Print report button must call window._ccDataQualityReport(s)');
  assert.ok(/⎙ Print report/.test(panelSrc));
});

test('the DQ panel\'s CSV button no longer shares a label with the print report', () => {
  const src = html();
  // The old ambiguous label - both a CSV download AND (now) a print report
  // would have been called "Export report", which is exactly the confusion
  // this rename fixes.
  assert.ok(!/↓ Export report/.test(src), 'the CSV button label must not collide with the new print report');
  assert.ok(/↓ Export CSV/.test(src));
});

test('IssuePanel\'s Export flyout offers both the clash report and the data quality report', () => {
  const src = html();
  const clashBtnPos = src.indexOf('⎙ Clash report');
  const dqBtnPos = src.indexOf('⎙ Data quality report');
  assert.ok(clashBtnPos !== -1, 'pre-existing Clash report entry must still be present');
  assert.ok(dqBtnPos !== -1, 'new Data quality report entry must be present');
  assert.ok(dqBtnPos > clashBtnPos, 'Data quality report should be listed after Clash report');
  // Both must live in the same dropdown, not scattered - check the intervening
  // text is short (just one button's worth of markup) and contains the handler.
  const between = src.slice(clashBtnPos, dqBtnPos);
  // The onClick handler sits BEFORE the button's visible label text in the
  // markup, so look in a window straddling dqBtnPos, not just after it.
  assert.ok(/window\._ccDataQualityReport/.test(src.slice(dqBtnPos - 400, dqBtnPos + 200)));
  assert.ok(between.length < 600, 'the two report buttons should be adjacent in the same flyout');
});

test('_ccDataQualityReport is exposed on window for both entry points and MCP/automation to call', () => {
  const src = html();
  assert.ok(/window\._ccDataQualityReport = _ccDataQualityReport;/.test(src));
});
