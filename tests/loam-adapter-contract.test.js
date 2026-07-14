'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const addon = fs.readFileSync(path.join(ROOT, 'addons', 'smart-bridge.js'), 'utf8');
const mcp = fs.readFileSync(path.join(ROOT, 'mcp-server.js'), 'utf8');
const protocol = fs.readFileSync(path.join(ROOT, 'CONNECTOR_PROTOCOL.md'), 'utf8');

test('the external-orchestrator adapter keeps the connective-spine join fields', () => {
  assert.match(addon, /projectKey:\s*_projectKey\(s\)/);
  assert.match(addon, /freshness:\s*\{\s*source:\s*'clashcontrol',\s*revisionId:/);
  assert.match(addon, /classificationA:\s*classFor/);
  assert.match(addon, /classificationB:\s*classFor/);
  assert.match(addon, /uniqueIdA:/);
  assert.match(addon, /uniqueIdB:/);
});

test('detection feedback remains a Smart Bridge adapter available through MCP', () => {
  assert.match(addon, /handlers\.ingest_detection_feedback\s*=\s*function/);
  assert.match(mcp, /name:\s*'ingest_detection_feedback'/);
  assert.match(protocol, /Loam is an \*\*external repository and runtime\*\*/);
});

test('ClashControl has no runtime/package dependency on Loam', () => {
  const pkg = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  assert.doesNotMatch(pkg, /["']loam["']/i);
  assert.doesNotMatch(addon, /require\([^)]*loam|import\s+[^;]*loam/i);
});
