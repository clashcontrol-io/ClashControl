#!/usr/bin/env node
// Validates a country pack (regulations/<region>.json) against the contract in
// regulations/_template.json / regulations/README.md. Thresholds are
// safety-relevant numbers (door widths, ramp slopes, turning clearances) — a
// `source` citation is mandatory even for a draft pack, and unrecognized keys
// are flagged since they're most likely a typo rather than a genuinely new
// field. Pure structural + content checks — no execution of the pack content,
// ever (see regulations/loader.js). Regular expressions in a pack are strings,
// length-capped, without nested quantifiers / backreferences / lookbehind; URLs
// are https and on an allow-list. The section rules live in
// country-pack-core.js (validateSections), shared with the app.
'use strict';

const MAX_BYTES = 200 * 1024;
const REQUIRED_TOP_KEYS = ['region', 'name', 'contributor', 'verified', 'source', 'engines'];
const REGION_CODE_RE = /^[a-zA-Z]{2}(-[a-zA-Z0-9]+)*$/;
// Optional country section: classification-code tables (NL-SfB, Uniclass,
// OmniClass …) that map element/system codes to disciplines, MEP
// sub-disciplines or roles. Structure is owned by clash-discipline-core.js
// (validateClassificationTable), shared with the app's registry.
// Country sections (all optional): geo, dataQuality, naming, format — see
// country-pack-core.js.
const OPTIONAL_TOP_KEYS = ['classifications', 'geo', 'dataQuality', 'naming', 'format'];
const { validateClassificationTable } = require('../clash-discipline-core.js');
const countryCore = require('../country-pack-core.js');

// Known threshold keys per engine (addons/accessibility.js reads these).
// An engine not listed here is still accepted (numbers-only check applies);
// this only tightens validation for engines the core actually knows about.
const KNOWN_ENGINE_THRESHOLDS = {
  accessibility: countryCore.ACCESSIBILITY_KEYS
};

function validateRegulationPack(raw) {
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
    if (!REQUIRED_TOP_KEYS.includes(k) && !OPTIONAL_TOP_KEYS.includes(k)) errors.push(`Unknown top-level key: ${k}`);
  });

  if ('region' in pack && (typeof pack.region !== 'string' || !REGION_CODE_RE.test(pack.region))) {
    errors.push('region must be a short region code (e.g. "jp", "jp-tokyo")');
  }
  if ('name' in pack && (typeof pack.name !== 'string' || !pack.name.trim())) {
    errors.push('name must be a non-empty string');
  }
  if ('contributor' in pack && (typeof pack.contributor !== 'string' || !pack.contributor.trim())) {
    errors.push('contributor must be a non-empty string');
  }
  if ('verified' in pack && typeof pack.verified !== 'boolean') {
    errors.push('verified must be true or false');
  }
  if ('source' in pack && (typeof pack.source !== 'string' || !pack.source.trim())) {
    errors.push('source is required — cite the specific regulation text these thresholds come from, even for a draft pack');
  }

  if ('engines' in pack) {
    const hasOther = (Array.isArray(pack.classifications) && pack.classifications.length) ||
      ['geo', 'dataQuality', 'naming'].some((k) => pack[k] != null);
    if (pack.engines == null || typeof pack.engines !== 'object' || Array.isArray(pack.engines)) {
      errors.push('engines must be an object keyed by check-engine id');
    } else if (!Object.keys(pack.engines).length && !hasOther) {
      errors.push('engines must declare at least one check engine (or the pack must carry another section: classifications, geo, dataQuality, naming)');
    }
  }
  if (pack.region != null && typeof pack.region === 'string' && pack.region !== pack.region.toLowerCase()) {
    errors.push('region must be lower-case (e.g. "nl", "jp-tokyo")');
  }
  // engines (incl. engines.visibility presets), geo, dataQuality, naming, format.
  countryCore.validateSections(pack).forEach((e) => errors.push(e));

  if ('classifications' in pack) {
    if (!Array.isArray(pack.classifications) || !pack.classifications.length) {
      errors.push('classifications must be a non-empty array of classification tables');
    } else {
      const ids = new Set();
      pack.classifications.forEach((t, i) => {
        validateClassificationTable(t).forEach((e) => errors.push(`classifications[${i}]: ${e}`));
        if (t && ids.has(t.id)) errors.push(`classifications[${i}]: duplicate id ${t.id}`);
        if (t) ids.add(t.id);
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { validateRegulationPack, MAX_BYTES, KNOWN_ENGINE_THRESHOLDS };

if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/validate-regulation.js <path/to/pack.json>');
    process.exit(2);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const result = validateRegulationPack(raw);
  if (!result.ok) {
    console.error(`✗ ${file}`);
    result.errors.forEach((e) => console.error('  - ' + e));
    process.exit(1);
  }
  console.log(`✓ ${file}`);
}
