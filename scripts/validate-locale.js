#!/usr/bin/env node
// Validates a locale pack (locales/<lang>.json) against the contract in
// locales/_template.json / locales/README.md. Pure structural + content
// checks — no execution of the pack content, ever (see locales/loader.js
// for why: contributed packs are untrusted input).
'use strict';

const MAX_BYTES = 200 * 1024;
const REQUIRED_TOP_KEYS = ['lang', 'name', 'contributor', 'strings'];
const LANG_TAG_RE = /^[a-zA-Z]{2,3}(-[A-Za-z0-9]+)*$/;
const UNSAFE_PATTERN = /<script|javascript:|on\w+\s*=/i;
const HTML_TAG_PATTERN = /<[a-zA-Z][\s\S]*>/;

function validateLocalePack(raw) {
  const errors = [];
  if (typeof raw !== 'string') {
    return { ok: false, errors: ['Pack must be provided as raw JSON text'] };
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) {
    errors.push(`File exceeds the ${MAX_BYTES}-byte limit`);
  }

  let pack;
  try {
    pack = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: ['Invalid JSON: ' + e.message] };
  }

  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    return { ok: false, errors: ['Pack must be a JSON object'] };
  }

  REQUIRED_TOP_KEYS.forEach((k) => {
    if (!(k in pack)) errors.push(`Missing required key: ${k}`);
  });
  Object.keys(pack).forEach((k) => {
    if (!REQUIRED_TOP_KEYS.includes(k)) errors.push(`Unknown top-level key: ${k}`);
  });

  if ('lang' in pack && (typeof pack.lang !== 'string' || !LANG_TAG_RE.test(pack.lang))) {
    errors.push('lang must be a BCP-47-style language tag (e.g. "ja", "pt-BR")');
  }
  if ('name' in pack && (typeof pack.name !== 'string' || !pack.name.trim())) {
    errors.push('name must be a non-empty string');
  }
  if ('contributor' in pack && (typeof pack.contributor !== 'string' || !pack.contributor.trim())) {
    errors.push('contributor must be a non-empty string');
  }

  if ('strings' in pack) {
    if (pack.strings == null || typeof pack.strings !== 'object' || Array.isArray(pack.strings)) {
      errors.push('strings must be an object of key → translated string');
    } else {
      Object.entries(pack.strings).forEach(([k, v]) => {
        if (typeof v !== 'string') {
          errors.push(`strings.${k} must be a string`);
          return;
        }
        if (UNSAFE_PATTERN.test(v)) errors.push(`strings.${k} contains a disallowed pattern (script/javascript:/event-handler)`);
        if (HTML_TAG_PATTERN.test(v)) errors.push(`strings.${k} contains raw HTML — translations must be plain text`);
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validateLocalePack, MAX_BYTES };

if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/validate-locale.js <path/to/pack.json>');
    process.exit(2);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const result = validateLocalePack(raw);
  if (!result.ok) {
    console.error(`✗ ${file}`);
    result.errors.forEach((e) => console.error('  - ' + e));
    process.exit(1);
  }
  console.log(`✓ ${file}`);
}
