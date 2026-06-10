'use strict';
// smart-bridge-server.js starts listening on require (and needs `ws`), so the
// helper is extracted from source instead of imported.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'smart-bridge-server.js'), 'utf8');
const match = src.match(/function llmEndpointUrl[\s\S]*?\n}/);
assert.ok(match, 'llmEndpointUrl not found in smart-bridge-server.js');
const llmEndpointUrl = new Function('return ' + match[0])();

// Regression lock: `new URL('/v1/...', baseUrl)` dropped path prefixes
// (Groq /openai, OpenRouter /api). The helper must append, not replace.
test('llmEndpointUrl preserves provider path prefixes', () => {
  assert.equal(
    llmEndpointUrl('https://api.groq.com/openai', '/v1/chat/completions').href,
    'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(
    llmEndpointUrl('https://openrouter.ai/api', '/v1/chat/completions').href,
    'https://openrouter.ai/api/v1/chat/completions');
});

test('llmEndpointUrl does not duplicate /v1 when the base already ends in /v1', () => {
  assert.equal(
    llmEndpointUrl('http://localhost:1234/v1', '/v1/chat/completions').href,
    'http://localhost:1234/v1/chat/completions');
});

test('llmEndpointUrl handles bare hosts and trailing slashes', () => {
  assert.equal(
    llmEndpointUrl('http://localhost:11434', '/v1/chat/completions').href,
    'http://localhost:11434/v1/chat/completions');
  assert.equal(
    llmEndpointUrl('http://localhost:11434/', '/v1/models').href,
    'http://localhost:11434/v1/models');
});
