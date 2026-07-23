#!/usr/bin/env node
// Applies a downloaded, already-fetched pack file to locales/ or
// regulations/ — used by .github/workflows/contribute-pack.yml after the
// issue-ops download step. Validates first (same validators as CI), then
// writes the pack file + a manifest.json entry. Never overwrites an
// existing pack: the automated path only ever creates NEW packs, so an
// anonymous issue submission can never silently replace an already-
// reviewed one — updating an existing pack requires a normal reviewed PR
// that edits the file directly.
'use strict';

const fs = require('fs');
const path = require('path');
const { validateLocalePack } = require('./validate-locale.js');
const { validateRegulationPack } = require('./validate-regulation.js');

function main() {
  const [, , kind, filePath] = process.argv;
  if (!['locale', 'regulation'].includes(kind) || !filePath) {
    console.error('Usage: node scripts/apply-contributed-pack.js <locale|regulation> <file.json>');
    process.exit(2);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const isLocale = kind === 'locale';
  const validate = isLocale ? validateLocalePack : validateRegulationPack;
  const result = validate(raw);
  if (!result.ok) {
    console.error('Validation failed:');
    result.errors.forEach((e) => console.error('  - ' + e));
    process.exit(1);
  }

  const pack = JSON.parse(raw);
  const idKey = isLocale ? 'lang' : 'region';
  const id = pack[idKey];
  const dir = path.join(__dirname, '..', isLocale ? 'locales' : 'regulations');
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (manifest.some((e) => e[idKey] === id)) {
    console.error(
      `A ${kind} pack for "${id}" already exists. The automated contribution path only creates ` +
      `NEW packs — updating an existing one requires a regular reviewed PR that edits the file ` +
      `directly, so an anonymous submission can never silently overwrite an already-reviewed pack.`
    );
    process.exit(1);
  }

  const targetFile = `${id}.json`;
  fs.writeFileSync(path.join(dir, targetFile), JSON.stringify(pack, null, 2) + '\n');

  const entry = isLocale
    ? { lang: pack.lang, file: targetFile, name: pack.name, contributor: pack.contributor }
    : { region: pack.region, file: targetFile, name: pack.name, contributor: pack.contributor, verified: pack.verified === true };
  manifest.push(entry);
  manifest.sort((a, b) => (a[idKey] > b[idKey] ? 1 : -1));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`Applied ${kind} pack "${id}" -> ${path.relative(process.cwd(), path.join(dir, targetFile))}, updated manifest.json`);
}

main();
