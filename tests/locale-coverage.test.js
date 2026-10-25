'use strict';
// Locale pack coverage (scripts/locale-coverage.js): lists the missing keys
// per pack, keeps the manifest `coverage` numbers (which gate browser-
// language auto-activation in locales/loader.js) honest, and guards the
// English source strings against plural hacks a translator cannot handle.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cov = require('../scripts/locale-coverage.js');

const root = path.join(__dirname, '..');
const keys = cov.collectKeys(root);
const manifest = cov.readManifest(root);

test('coverage report: missing keys per pack', (t) => {
  for (const r of cov.report(root)) {
    t.diagnostic(`${r.lang}: ${(r.coverage * 100).toFixed(1)}% (${r.translated}/${r.total}), missing ${r.missing.length}` +
      (r.missing.length ? ': ' + r.missing.slice(0, 25).join(', ') + (r.missing.length > 25 ? ' …' : '') : ''));
  }
  assert.ok(keys.size > 1000, 'key extraction found ' + keys.size + ' keys');
});

test('manifest coverage matches the packs (run `node scripts/locale-coverage.js --write`)', () => {
  for (const e of manifest) {
    const r = cov.packCoverage(root, e, keys);
    assert.strictEqual(typeof e.coverage, 'number', e.lang + ' has no coverage in locales/manifest.json');
    assert.ok(Math.abs(e.coverage - Math.floor(r.coverage * 1000) / 1000) < 0.0015,
      `${e.lang}: manifest says ${e.coverage}, pack covers ${r.coverage.toFixed(4)}`);
  }
});

test('the Dutch pack is complete', () => {
  const r = cov.packCoverage(root, manifest.find((e) => e.lang === 'nl'), keys);
  assert.deepStrictEqual(r.missing, [], 'nl.json is missing ' + r.missing.length + ' keys');
});

test('translations keep every {placeholder} of the English text', () => {
  for (const e of manifest) {
    const pack = JSON.parse(fs.readFileSync(path.join(root, 'locales', e.file), 'utf8')).strings;
    const bad = [];
    for (const [k, en] of keys) {
      if (typeof pack[k] !== 'string') continue;
      const want = (en.match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join(',');
      const got = (pack[k].match(/\{[A-Za-z0-9_]+\}/g) || []).sort().join(',');
      if ([...new Set(want.split(','))].some((p) => p && !got.includes(p))) bad.push(k);
    }
    assert.deepStrictEqual(bad, [], e.lang + ': placeholders lost in ' + bad.join(', '));
  }
});

test('English strings use separate keys for plurals (no "{s}", "(s)" or "(en)" hacks)', () => {
  const bad = [...keys].filter(([, en]) => /\{(s|es|ies|y)\}|\w\((s|es|en)\)/.test(en)).map(([k]) => k);
  assert.deepStrictEqual(bad, []);
});

test('auto-activation threshold is the same in the loader and the coverage script', () => {
  const loader = fs.readFileSync(path.join(root, 'locales', 'loader.js'), 'utf8');
  assert.match(loader, new RegExp('var AUTO_MIN = ' + String(cov.AUTO_MIN).replace('.', '\\.') + ';'));
});
