'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ids-conformance.yml'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'tests', 'browser', 'ids-conformance.mjs'), 'utf8');

test('IDS conformance uses a reviewable pinned buildingSMART corpus commit', () => {
  assert.match(workflow, /IDS_CORPUS_COMMIT:\s*[0-9a-f]{40}/);
  assert.match(workflow, /git checkout --detach "\$IDS_CORPUS_COMMIT"/);
  assert.doesNotMatch(workflow, /--branch development/);
});

test('IDS conformance publishes a machine-readable baseline even when the job is non-blocking', () => {
  assert.match(workflow, /IDS_REPORT_PATH:\s*ids-conformance-report\.json/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /if:\s*always\(\)/);
  assert.match(runner, /corpusCommit:\s*process\.env\.IDS_CORPUS_COMMIT/);
  assert.match(runner, /writeFile\(process\.env\.IDS_REPORT_PATH/);
});
