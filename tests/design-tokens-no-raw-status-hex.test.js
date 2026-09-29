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
  const next = html.slice(start + 10).search(/\n  function [A-Z][A-Za-z0-9_]*\(/);
  return html.slice(start, next > 0 ? start + 10 + next : start + 20000);
}
const STYLE_HEX = /\b(color|background|border[A-Za-z]*|outline)\s*:\s*'[^']*#[0-9a-fA-F]{3,8}\b/g;

for (const name of ['DataQualityPanel', 'IDSValidationPanel', 'AccessibilityPanel']) {
  test(name + ' uses status tokens, not raw hex, in inline styles', () => {
    const hits = (body(name).match(STYLE_HEX) || []).filter((h) => !/'#fff(fff)?'?$/i.test(h) && !/#fff\b/i.test(h));
    assert.deepStrictEqual(hits, []);
  });
}

test('data-quality severity map is tokenised', () => {
  assert.match(html, /var SEV = \{error:'var\(--color-danger-fg\)', warn:'var\(--color-warning-fg\)', info:'var\(--color-info-fg\)'\};/);
});
