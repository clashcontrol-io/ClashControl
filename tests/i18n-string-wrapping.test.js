'use strict';
// i18n sweep guard: user-facing strings must go through _cc_t so a locale pack can translate
// them; formatting helpers must honour the chosen locale for display only.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const src = read('index.html');

function slice(from, to) {
  const a = src.indexOf(from);
  assert.ok(a !== -1, 'anchor not found: ' + from);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b !== -1, 'end anchor not found: ' + to);
  return src.slice(a, b);
}

test('assistant replies in processNLCommand/dispatchServerAction are wrapped in _cc_t', () => {
  const region = slice('function dispatchServerAction(action, s, d) {', 'function ClashSetupCard(props) {');
  // Sample of replies that used to be bare literals.
  for (const key of ['nl.reply.noProblem', 'nl.reply.gridOn', 'nl.reply.sectionsCleared', 'nl.reply.doneBcfExported',
    'nl.reply.didYouMeanYesNo', 'nl.reply.markersOff', 'nl.reply.nClashesFoundOpen', 'nl.reply.totalClashesBreakdown']) {
    assert.ok(region.includes("_cc_t('" + key + "'"), key + ' should be a _cc_t call');
  }
  // No remaining `return '<english sentence>'` replies: every return of a string literal must be a
  // non-reply token (the storey-name helper returns 'all').
  const bare = [...region.matchAll(/\breturn\s+(['"])([^'"\n]*[A-Za-z]{3}[^'"\n]*)\1/g)].map((m) => m[2]);
  assert.deepStrictEqual(bare.filter((t) => t !== 'all'), [], 'bare English replies left: ' + bare.join(' | '));
});

test('regexes, intents and suggestion chips are NOT translated (the NL parser is English)', () => {
  const region = slice('function processNLCommand(raw, s, d) {', 'function ClashSetupCard(props) {');
  assert.ok(/\^\(\?:hi\|hello\|hey\|yo\|sup\)\$/.test(region), 'greeting regex must stay literal');
  assert.ok(src.includes("suggestions = ['Load an IFC file', 'Start tour', 'What can you do?'];"), 'chips stay English');
});

test('toasts, alerts and prompts take translated text (no literal first argument)', () => {
  const lit = [...src.matchAll(/_ccToast\(\s*(['"])/g)];
  assert.strictEqual(lit.length, 0, 'literal _ccToast(...) strings left: ' + lit.length);
  const dlg = [...src.matchAll(/(?<![\w.])(?:alert|prompt)\(\s*(['"])/g)];
  assert.strictEqual(dlg.length, 0, 'literal alert()/prompt() strings left: ' + dlg.length);
  assert.ok(src.includes("_cc_t('toast.loadingCancelled','Loading cancelled.')"));
  // Plural forms are separate keys (no plural rules in _cc_t).
  assert.ok(src.includes("'toast.resolvedOneClash'") && src.includes("'toast.resolvedClashes'"));
});

test('literal title= attributes in templates use _cc_t', () => {
  const lit = [...src.split('\n').slice(1000).join('\n').matchAll(/(?<![\w-])title="[^"$]*[A-Za-z]{3}[^"$]*"/g)];
  assert.strictEqual(lit.length, 0, 'literal title="..." left: ' + lit.map((m) => m[0]).join(' | '));
});

test('every _cc_t key maps to exactly one English text (except known legacy duplicates)', () => {
  const byKey = new Map();
  for (const m of src.matchAll(/_cc_t\('([^']+)',\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)) {
    const en = m[2] !== undefined ? m[2] : m[3];
    if (!byKey.has(m[1])) byKey.set(m[1], new Set());
    byKey.get(m[1]).add(en);
  }
  const legacy = new Set(['shortcuts.view.isolate', 'shortcuts.view.hide', 'revitBridge.reconnectedPullAgain']);
  const conflicts = [...byKey].filter(([k, v]) => v.size > 1 && !legacy.has(k)).map(([k]) => k);
  assert.deepStrictEqual(conflicts, []);
});

// ── _cc_t substitution + locale-aware formatting (extracted from the inline script) ──
function loadRegistry(extra) {
  const code = slice('  var _ccLocalePacks = {};', '  // Restore the user\'s chosen language');
  const storage = extra && extra.storage ? extra.storage : {};
  const win = { dispatchEvent() {}, ...(extra && extra.window) };
  const fn = new Function('window', 'Event', 'localStorage', 'navigator', code + '; return window;');
  return fn(win, function Event() {}, { getItem: (k) => (k in storage ? storage[k] : null), setItem() {} }, (extra && extra.navigator) || { language: 'en-GB' });
}

test('_cc_t: single-pass placeholder substitution, literal "$" in values, missing vars left as-is', () => {
  const w = loadRegistry();
  assert.strictEqual(w._cc_t('k', 'Hi {name}!', { name: 'Ann' }), 'Hi Ann!');
  assert.strictEqual(w._cc_t('k', 'A {a} B {b}', { a: '{b}', b: 'X' }), 'A {b} B X', 'a value is never re-expanded');
  assert.strictEqual(w._cc_t('k', 'Cost {v}', { v: '$&' }), 'Cost $&');
  assert.strictEqual(w._cc_t('k', 'Keep {missing}', { other: 1 }), 'Keep {missing}');
  w._ccRegisterLocalePack({ lang: 'xx', strings: { k: 'Hallo {name}' } });
  w._ccSetLocale('xx', { persist: false });
  assert.strictEqual(w._cc_t('k', 'Hi {name}!', { name: 'Ann' }), 'Hallo Ann');
  assert.strictEqual(w._cc_t('other', 'Fallback {n}', { n: 2 }), 'Fallback 2');
});

test('_ccNumFmt/_ccDateFmt follow the active locale and fall back gracefully', () => {
  const w = loadRegistry({ navigator: { language: 'en-US' } });
  assert.strictEqual(w._ccNumFmt(1234.5, 2), '1,234.50');
  assert.strictEqual(w._ccNumFmt(Infinity, 2), 'Infinity', 'non-finite values are not formatted');
  w._ccRegisterLocalePack({ lang: 'de', strings: {} });
  w._ccSetLocale('de', { persist: false });
  assert.strictEqual(w._ccNumFmt(1234.5, 2), '1.234,50');
  assert.strictEqual(w._ccUiLocale(), 'de');
  assert.ok(/2026/.test(w._ccDateFmt('2026-03-27T12:00:00Z', { year: 'numeric', month: 'long', day: 'numeric' })));
  assert.strictEqual(w._ccDateFmt('not a date', 'date'), '');
  // An invalid tag must not throw.
  w._ccRegisterLocalePack({ lang: 'not a tag!', strings: {} });
  w._ccSetLocale('not a tag!', { persist: false });
  assert.doesNotThrow(() => w._ccNumFmt(1.5, 1));
  assert.ok(/1[.,]5/.test(w._ccNumFmt(1.5, 1)));
});

test('an explicit English choice is not overridden by the browser language for formatting', () => {
  const w = loadRegistry({ storage: { cc_locale: '' }, navigator: { language: 'de-DE' } });
  assert.strictEqual(w._ccUiLocale(), 'en');
  assert.strictEqual(w._ccNumFmt(1234.5, 1), '1,234.5');
});

test('measurement formatters: stored labels stay "."-decimal (machine), display follows the locale', () => {
  const body = slice('  function _ccFmtN(n, digits, machine) {', '  function _ccFmtAngle(rad, state, machine) {');
  const mk = (numFmt) => new Function('window', '_ccMeasureUnitMode', '_ccMeasurePrecision', '_ccCalibration', '_ccFmtFractionalInches',
    body + '; return {len:_ccFmtLength, area:_ccFmtArea, vol:_ccFmtVolume};')(
    { _ccNumFmt: numFmt }, () => 'metric', () => 2, () => 1, () => '');
  const f = mk((n, d) => n.toFixed(d).replace('.', ','));
  assert.strictEqual(f.len(2.5, {}), '2,50 m');
  assert.strictEqual(f.len(2.5, {}, true), '2.50 m');
  assert.strictEqual(f.area(2.5, {}, true), '2.50 m²');
  assert.strictEqual(f.vol(0.5, {}), '500 L');
  // Every place that STORES a measurement label passes the machine flag.
  assert.ok(src.includes('label:_ccFmtArea(area, window._ccLatestState, true)'));
  assert.ok(src.includes('label:_ccFmtAngle(angle,_state,true)'));
  assert.ok(src.includes("label:'min ' + _ccFmtLength(bestDist, st, true)"));
});

test('AI requests carry the UI locale', () => {
  assert.ok(src.includes("Object.assign({}, context, { locale: _loc })"), '/api/nl context.locale');
  assert.ok(/body: JSON\.stringify\(\{ context: \{ locale: /.test(src), '/api/title context.locale');
  assert.ok(src.includes('{locale: window._ccUiLocale()}'), '/api/triage context.locale');
});

test('addons use a guarded _cc_t passthrough, never a hard dependency', () => {
  for (const f of ['smart-bridge', 'revit-bridge', 'pwa', 'shared-project', 'local-engine', 'training-data']) {
    const a = read('addons/' + f + '.js');
    assert.ok(/function _i18n\(key, en, vars\) \{\s*\n\s*if \(typeof window\._cc_t === 'function'\) return window\._cc_t\(key, en, vars\);/.test(a), f + ' passthrough');
    assert.ok(/_i18n\('/.test(a), f + ' should use it');
  }
});
