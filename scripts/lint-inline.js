#!/usr/bin/env node
// Extracts the main inline <script> from index.html (the one containing
// `function startApp()`), preserving line numbers by padding with blank
// lines, and writes it to a temp file for ESLint to consume with
// eslint.config.mjs. Also collects every `window.X = ` assigned identifier
// across index.html and addons/root *.js so those runtime-published globals
// don't false-positive as no-undef.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, '.lint-tmp');
const OUT_FILE = path.join(OUT_DIR, 'app.js');
const GLOBALS_FILE = path.join(OUT_DIR, 'globals.json');

function extractMainScript(html) {
  // Find every <script ...>...</script> block without a src= attribute,
  // and pick the one whose body contains `function startApp()`.
  const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let best = null;
  let bestStartLine = 0;
  while ((m = scriptRe.exec(html))) {
    const body = m[1];
    if (/function\s+startApp\s*\(/.test(body)) {
      best = body;
      bestStartLine = html.slice(0, m.index + m[0].indexOf(body)).split('\n').length;
      break;
    }
  }
  if (best == null) {
    throw new Error('Could not find main <script> containing function startApp() in index.html');
  }
  return { body: best, startLine: bestStartLine };
}

function collectWindowGlobals(files) {
  const names = new Set();
  const re = /\bwindow\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=(?!=)/g;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let m;
    while ((m = re.exec(src))) names.add(m[1]);
  }
  return Array.from(names).sort();
}

function findJsFiles() {
  const files = [];
  files.push(path.join(ROOT, 'index.html'));
  const dirs = [path.join(ROOT, 'addons')];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.js')) files.push(path.join(dir, f));
    }
  }
  for (const f of fs.readdirSync(ROOT)) {
    if (f.endsWith('.js') && fs.statSync(path.join(ROOT, f)).isFile()) {
      files.push(path.join(ROOT, f));
    }
  }
  return files;
}

function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const { body, startLine } = extractMainScript(html);

  // Pad with (startLine - 1) blank lines so line numbers in lint output
  // line up 1:1 with index.html.
  const padding = '\n'.repeat(Math.max(0, startLine - 1));
  const padded = padding + body;

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, padded);

  const jsFiles = findJsFiles();
  const windowGlobals = collectWindowGlobals(jsFiles);
  fs.writeFileSync(GLOBALS_FILE, JSON.stringify(windowGlobals, null, 2));

  console.log(`Extracted main script: ${body.split('\n').length} lines, starting at line ${startLine} of index.html`);
  console.log(`Collected ${windowGlobals.length} window-assigned globals from ${jsFiles.length} files`);
  console.log(`Wrote ${OUT_FILE}`);
  console.log(`Wrote ${GLOBALS_FILE}`);
}

main();
