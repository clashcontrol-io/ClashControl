'use strict';
// Guided tour rebuild (2026-09-28, see MEMORY.md): the previous TOUR_STEPS
// targeted a removed left sidebar and selectors (`.cc-logo-mark`,
// `.cc-ifc-load-btn`, `.cc-bcf-actions`, `.cc-nlpanel-closed`) that were
// never present in the current markup, so every step silently failed to
// spotlight anything. This locks TOUR_STEPS down to a small set of steps
// (5-7) whose CSS selectors are actually wired up somewhere in index.html
// (as a `data-tour="..."` attribute, or an existing stable id/class) so a
// future refactor that renames one of those hooks without updating
// TOUR_STEPS fails a test instead of quietly breaking the tour again.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractTourSteps() {
  const start = src.indexOf('var TOUR_STEPS = [');
  assert.ok(start !== -1, 'TOUR_STEPS not found');
  const end = src.indexOf('\n  ];', start);
  assert.ok(end !== -1, 'TOUR_STEPS array close not found');
  const body = src.slice(start, end);
  const steps = [];
  const re = /\{sel:'([^']+)',\s*title:'([^']+)'/g;
  let m;
  while ((m = re.exec(body))) steps.push({ sel: m[1], title: m[2] });
  return steps;
}

// A CSS selector list ("a,b") -> its individual simple selectors, each
// reduced to what we can grep for as a literal string in the source: an
// attribute selector `[data-tour="x"]` -> `data-tour="x"`, a class `.foo`
// -> `class="..foo.."` (checked loosely below), an id `#foo` -> `id="foo"`.
function selectorIsWired(simpleSel) {
  simpleSel = simpleSel.trim();
  const attrMatch = simpleSel.match(/^\[data-tour="([^"]+)"\]$/);
  if (attrMatch) {
    return src.includes('data-tour="' + attrMatch[1] + '"') || src.includes('dataTour:\'' + attrMatch[1] + '\'') || src.includes('dataTour:"' + attrMatch[1] + '"');
  }
  const idMatch = simpleSel.match(/^#([\w-]+)$/);
  if (idMatch) {
    return src.includes('id="' + idMatch[1] + '"');
  }
  const classMatch = simpleSel.match(/^\.([\w-]+)$/);
  if (classMatch) {
    // Matches class="foo", class="foo bar", class="bar foo" etc.
    const re = new RegExp('class="[^"]*\\b' + classMatch[1] + '\\b[^"]*"');
    return re.test(src);
  }
  return false;
}

test('TOUR_STEPS has 5-7 steps', () => {
  const steps = extractTourSteps();
  assert.ok(steps.length >= 5 && steps.length <= 7, 'expected 5-7 steps, got ' + steps.length);
});

test('every TOUR_STEPS selector is wired to a real element in index.html', () => {
  const steps = extractTourSteps();
  for (const step of steps) {
    const alternatives = step.sel.split(',');
    const anyWired = alternatives.some(selectorIsWired);
    assert.ok(anyWired, 'TOUR_STEPS step "' + step.title + '" selector not wired: ' + step.sel);
  }
});

test('every TOUR_STEPS step has non-empty title and text', () => {
  const start = src.indexOf('var TOUR_STEPS = [');
  const end = src.indexOf('\n  ];', start);
  const body = src.slice(start, end);
  const re = /\{sel:'[^']+',\s*title:'([^']+)',\s*text:'([^']+)'/g;
  let m, count = 0;
  while ((m = re.exec(body))) {
    count++;
    assert.ok(m[1].trim().length > 0);
    assert.ok(m[2].trim().length > 0);
  }
  assert.ok(count >= 5, 'expected at least 5 steps with title+text, found ' + count);
});

test('the welcome popup starts the in-app tour as its primary tour action, with the /tour/ marketing page as a secondary link', () => {
  const idx = src.indexOf("_cc_t('welcome.newHereTour'");
  assert.ok(idx !== -1, 'welcome.newHereTour string not found');
  const before = src.slice(Math.max(0, idx - 400), idx);
  assert.match(before, /_ccStartTour/, 'the "New here? Take the tour" action should call window._ccStartTour (in-app tour)');
});

test('a ⌘K command starts the in-app tour', () => {
  assert.match(src, /label:_cc_t\('cmdk\.startTour','Start tour'\)/);
  const idx = src.indexOf("label:_cc_t('cmdk.startTour','Start tour')");
  const after = src.slice(idx, idx + 300);
  assert.match(after, /_ccStartTour/);
});
