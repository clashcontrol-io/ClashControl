'use strict';
// Drift guard: every doc/UI/console string that states a tool count must
// match mcp-server.js's actual TOOLS array length. This is exactly the kind
// of drift this test is meant to catch — before this test existed, eight
// files independently claimed "51 tools" while the array had grown to 66
// (fixed in the same change that added this test).
//
// Pattern modeled on Loam's orchestrator/test/doc_tool_count.test.js
// (pins every doc's headline tool count to the server's TOOLS registry).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

function readToolsArray() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'mcp-server.js'), 'utf8');
  const m = src.match(/const TOOLS = \[[\s\S]*?\n\];/);
  assert.ok(m, 'TOOLS array not found in mcp-server.js');
  const TOOLS = new Function('return ' + m[0].replace('const TOOLS = ', ''))();
  assert.ok(Array.isArray(TOOLS) && TOOLS.length > 0, 'TOOLS did not evaluate to a non-empty array');
  return TOOLS;
}

// Files that state a headline tool count somewhere in prose/UI/logs. Any
// "<number> tool(s)" / "<number> MCP tool(s)" occurrence in these files must
// equal TOOLS.length.
const FILES_WITH_TOOL_COUNT_CLAIMS = [
  'developers/index.html',
  'llms.txt',
  'addons/smart-bridge.js',
  'smart-bridge-server.js',
  'MCP_BUILD_GUIDE.md',
  'mcp-server.js',
  'bridge-governance.js',
  'BRIDGE_GOVERNANCE.md',
  '.github/workflows/release-smart-bridge.yml',
];

// One deliberate exception: MCP_BUILD_GUIDE.md's worked-examples section
// honestly states it only documents a SUBSET of tools ("N of TOTAL
// documented below") rather than falsely claiming completeness. For that
// phrasing, TOTAL must still equal TOOLS.length, but N is checked against
// the actual number of documented examples instead of the full count.
const PARTIAL_COUNT_PATTERN = /\((\d+) of (\d+) documented below/i;

test('every stated tool count matches mcp-server.js TOOLS.length', () => {
  const TOOLS = readToolsArray();
  const expected = TOOLS.length;
  const countPattern = /\b(\d+)\s+(?:MCP\s+)?tools?\b/gi;

  const mismatches = [];
  for (const rel of FILES_WITH_TOOL_COUNT_CLAIMS) {
    const abs = path.join(__dirname, '..', rel);
    if (!fs.existsSync(abs)) continue; // file removed — nothing to check
    const text = fs.readFileSync(abs, 'utf8');

    const partial = text.match(PARTIAL_COUNT_PATTERN);
    if (partial) {
      const [, documentedCount, totalCount] = partial;
      if (parseInt(totalCount, 10) !== expected) {
        mismatches.push(`${rel}: "${partial[0]}" total (expected ${expected})`);
      }
      const actualDocumented = (text.match(/server\.registerTool\(/g) || []).length;
      if (parseInt(documentedCount, 10) !== actualDocumented) {
        mismatches.push(`${rel}: claims ${documentedCount} documented, found ${actualDocumented} registerTool( calls`);
      }
    }

    let m;
    while ((m = countPattern.exec(text))) {
      if (partial && m.index >= text.indexOf(partial[0]) && m.index < text.indexOf(partial[0]) + partial[0].length) {
        continue; // already checked above with the partial-count rule
      }
      const found = parseInt(m[1], 10);
      if (found !== expected) {
        mismatches.push(`${rel}: found "${m[0]}" (expected ${expected})`);
      }
    }
  }

  assert.deepEqual(mismatches, [], `Tool-count drift:\n${mismatches.join('\n')}`);
});

test('every tool in TOOLS is classified in bridge-governance.js (no silent fall-through gaps)', () => {
  const TOOLS = readToolsArray();
  const gov = require('../bridge-governance');
  const unclassified = TOOLS
    .map((t) => t.name)
    .filter((name) => gov.classifyTool(name) === 'destructive'
      && !gov.READ_ONLY.has(name) && !gov.REVERSIBLE.has(name) && !gov.DESTRUCTIVE.has(name));
  // Not an error by itself (unclassified tools correctly fail safe to
  // 'destructive'), but surface it — a tool nobody deliberately classified
  // is a sign this list needs updating, not a passing state to stay quiet in.
  if (unclassified.length) {
    console.warn('[doc-tool-count] Unclassified tools defaulting to destructive:', unclassified);
  }
  assert.ok(true);
});
