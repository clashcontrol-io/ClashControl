'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_CLAIM_FILES = [
  'README.md',
  'index.html',
  'security/index.html',
  'tour/index.html',
  'developers/index.html',
  'llms.txt',
  'api/nl.js',
];

test('public ClashControl license claims say SSPL/source-available, not MIT/open-source', () => {
  const stale = [];
  const patterns = [
    /ClashControl.{0,120}\bMIT\b/gi,
    /\bMIT\b.{0,120}ClashControl/gi,
    /free(?:,| and)?\s+open-source/gi,
    /ClashControl is open-source/gi,
    /All MIT-licensed/gi,
  ];
  for (const rel of PUBLIC_CLAIM_FILES) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) stale.push(`${rel}: ${match[0]}`);
    }
  }
  assert.deepEqual(stale, [], `Stale license claims:\n${stale.join('\n')}`);

  const license = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  assert.match(license, /Server Side Public License/i);
  assert.match(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), /source-available[\s\S]*SSPL/i);
});
