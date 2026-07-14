'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseExternalScripts } = require('../scripts/generate-sri');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('every external classic script has a SHA-384 integrity hash and anonymous CORS', () => {
  const deps = parseExternalScripts(html);
  assert.ok(deps.length >= 4, 'expected the React/ReactDOM/JSZip/pdf.js CDN scripts');
  deps.forEach((dep) => {
    assert.match(dep.integrity || '', /^sha384-[A-Za-z0-9+/=]+$/, dep.url);
    assert.equal(dep.crossorigin, 'anonymous', dep.url);
  });
});

test('the SRI generator follows index.html and carries no stale Three.js r128 list', () => {
  const script = fs.readFileSync(path.join(root, 'scripts', 'generate-sri.js'), 'utf8');
  assert.doesNotMatch(script, /three\.js\/r128|three@0\.128\.0/);
  assert.match(html, /three@0\.180\.0\/build\/three\.module\.js/);
});

test('CI re-downloads and verifies the committed hashes', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'sri-check.yml'), 'utf8');
  assert.match(workflow, /node scripts\/generate-sri\.js --check/);
  assert.match(workflow, /schedule:/);
});
