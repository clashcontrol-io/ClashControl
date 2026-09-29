// DESIGN.md: never hand-pick hex values — status colours come from the
// --color-{success,warning,danger,info}[-fg|-bg|-border] tokens so both
// themes keep AA contrast. Guards the panels de-hexed on 2026-09-29
// (axe: 22 light-theme contrast failures in Data Quality before).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function body(name) {
  const start = html.indexOf('function ' + name + '(');
  assert.ok(start > 0, name + ' not found');
  const next = html.slice(start + 10).search(/\n  function [A-Za-z_][A-Za-z0-9_]*\(/);
  return html.slice(start, next > 0 ? start + 10 + next : start + 20000);
}
const STYLE_HEX = /\b(color|background|border[A-Za-z]*|outline)\s*:\s*'[^']*#[0-9a-fA-F]{3,8}\b/g;

for (const name of ['DataQualityPanel', 'IDSValidationPanel', 'AccessibilityPanel']) {
  test(name + ' uses status tokens, not raw hex, in inline styles', () => {
    const hits = (body(name).match(STYLE_HEX) || []).filter((h) => !/'#fff(fff)?'?$/i.test(h) && !/#fff\b/i.test(h));
    assert.deepStrictEqual(hits, []);
  });
}

// Clash-panel components (de-hexed 2026-09-29). Any quoted hex literal in these
// bodies is a hand-picked colour: status/severity text, chips, verdict badges and
// dots must use the --color-* tokens. Allowed: #fff on solid coloured buttons and
// the categorical (non-status) colours that have no token: visibility blue,
// coverage purple and the "duplicate" purple.
const CLASH_PANELS = ['ClashAISummary', 'ClashStatsBar', 'BulkActionBar', 'RunDetectionModal',
  'ClashRulesPanel', 'ModelClashMatrix', 'IssuePanel', 'StandardsPanel', 'PropDiffView',
  'ClashProps', 'VirtualList', 'ClashHistory', 'ClashToleranceEditor', 'IssueDetailEditor',
  'IssueRow', 'ClashSetupCard'];
const CATEGORICAL_OK = new Set(['#fff', '#ffffff', '#3b82f6', '#a855f7', '#8558ec', '#8b5cf6']);
for (const name of CLASH_PANELS) {
  test(name + ' has no raw hex colour literals (status tokens only)', () => {
    const src = body(name).replace(/\/\/[^\n]*/g, '');
    const hits = (src.match(/['"]#[0-9a-fA-F]{3,8}['"]|\bsolid #[0-9a-fA-F]{3,8}\b/g) || [])
      .map((h) => h.replace(/^solid |['"]/g, '').toLowerCase())
      .filter((h) => !CATEGORICAL_OK.has(h));
    assert.deepStrictEqual(hits, []);
  });
}

test('clash-panel status maps are tokenised', () => {
  assert.match(html, /var statusColors = \{open:'var\(--color-danger\)',in_progress:'var\(--color-warning\)',resolved:'var\(--color-success\)'/);
  assert.match(html, /bg:'var\(--color-success-bg\)',col:'var\(--color-success-fg\)',brd:'var\(--color-success-border\)'/);
});

test('data-quality severity map is tokenised', () => {
  assert.match(html, /var SEV = \{error:'var\(--color-danger-fg\)', warn:'var\(--color-warning-fg\)', info:'var\(--color-info-fg\)'\};/);
});
