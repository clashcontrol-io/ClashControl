'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const update = require('../bridge-update');

test('Smart Bridge versions compare numerically across supported tag forms', () => {
  assert.equal(update.isNewerVersion('bridge-v0.10.0', '0.9.9'), true);
  assert.equal(update.isNewerVersion('v1.0.0', 'bridge-v0.99.99'), true);
  assert.equal(update.isNewerVersion('0.3.3', '0.3.3'), false);
  assert.equal(update.isNewerVersion('not-a-version', '0.3.3'), false);
});

test('update discovery selects the newest stable Smart Bridge release only', () => {
  const releases = [
    { tag_name: 'v9.0.0', html_url: 'wrong-product' },
    { tag_name: 'bridge-v0.4.0', prerelease: true, html_url: 'prerelease' },
    { tag_name: 'bridge-v0.3.9', html_url: 'older' },
    { tag_name: 'bridge-v0.4.1', html_url: 'newest' },
  ];
  assert.equal(update.selectBridgeRelease(releases, '0.3.3').html_url, 'newest');
  assert.equal(update.selectBridgeRelease(releases, '0.4.1'), null);
});

test('the addon offers release downloads and contains no automatic update POST', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'addons', 'smart-bridge.js'), 'utf8');
  assert.match(src, /function _maybeOfferUpdate/);
  assert.doesNotMatch(src, /function _applyBridgeUpdate/);
  assert.doesNotMatch(src, /method:'POST'[^\n]+\/update/);
});
