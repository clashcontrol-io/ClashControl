// buildingSMART IDS conformance: drives every pass-/fail-/invalid- .ifc+.ids
// pair from the official buildingSMART/IDS corpus (Documentation/
// ImplementersDocumentation/TestCases) through the REAL app in headless
// Chromium — real web-ifc WASM load, real window._ccParseIDS/_ccRunIDS —
// and grades each one against the filename's documented expected outcome
// (see ids-grade.js for why "wrong" and "incomplete" are scored
// separately: CC's engine honestly reports facets it can't verify yet
// instead of guessing, and a naive pass-rate gate would count every one of
// those as a failure).
//
// Corpus format: github.com/buildingSMART/IDS, Documentation/
// ImplementersDocumentation/TestCases/scripts.md. Cases are paired files
// sharing a basename (<prefix>-<slug>.ids + .ifc), prefix ∈
// {pass, fail, invalid}. A couple of documented cases ship an .html instead
// of an .ifc (IDS#310) — silently skipped, not a harness failure.
//
// Run:  node tests/browser/ids-conformance.mjs <path-to-TestCases-dir>
//       (requires `playwright` installed + chromium — see
//       .github/workflows/ids-conformance.yml)
//
// Not runnable in this dev sandbox: the corpus fetch and the CDN-hosted
// web-ifc/React/Three.js dependencies both need outbound network access
// this environment's proxy denies (see MEMORY.md). Verified on CI only —
// same as tests/browser/smoke.mjs originally was.
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, normalize, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { gradeIDSCase } from './ids-grade.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const corpusRoot = process.argv[2];
if (!corpusRoot) {
  console.error('Usage: node tests/browser/ids-conformance.mjs <path-to-TestCases-dir>');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ifc': 'application/octet-stream', '.css': 'text/css',
  '.ids': 'application/xml',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file;
    if (urlPath.startsWith('/corpus/')) {
      file = normalize(join(corpusRoot, urlPath.slice('/corpus/'.length)));
      if (!file.startsWith(normalize(corpusRoot))) { res.writeHead(403); return res.end(); }
    } else {
      const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
      file = normalize(join(repoRoot, rel));
      if (!file.startsWith(normalize(repoRoot))) { res.writeHead(403); return res.end(); }
    }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(8765, '127.0.0.1', r));

// ── Discover every pass-/fail-/invalid- .ids+.ifc pair ──────────────────
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}

const allFiles = await walk(corpusRoot);
const ifcSet = new Set(allFiles.filter((f) => f.endsWith('.ifc')));

const cases = [];
for (const idsPath of allFiles.filter((f) => f.endsWith('.ids'))) {
  const ifcPath = idsPath.slice(0, -4) + '.ifc';
  if (!ifcSet.has(ifcPath)) continue; // documented .html-instead-of-.ifc gap (IDS#310)
  const name = basename(idsPath, '.ids');
  const m = /^(pass|fail|invalid)-/.exec(name);
  if (!m) continue;
  const relName = relative(corpusRoot, idsPath).replace(/\\/g, '/');
  cases.push({
    name: relName,
    prefix: m[1],
    idsUrl: '/corpus/' + relName,
    ifcUrl: '/corpus/' + relative(corpusRoot, ifcPath).replace(/\\/g, '/'),
    // unique, filesystem-derived model name so each case loads as a fresh
    // ADD_MODEL (never REPLACE_MODEL) — avoids a stale-state race against
    // the previous case's model while its own waitForFunction is polling.
    modelName: relName.replace(/\.ids$/, '').replace(/[^a-zA-Z0-9_.-]/g, '_') + '.ifc',
  });
}

if (cases.length === 0) {
  console.error('IDS CONFORMANCE FAIL: discovered 0 test cases under ' + corpusRoot + ' — corpus fetch likely broken');
  server.close();
  process.exit(1);
}
console.log('Discovered ' + cases.length + ' IDS conformance cases.');

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('pageerror: ' + e.message));

const outcomes = { conform: 0, incomplete: 0, wrong: [], errored: [] };

try {
  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.ClashControl && typeof window._ccDispatch === 'function',
    null, { timeout: 60_000 }
  );

  for (const c of cases) {
    try {
      await page.evaluate(async ({ ifcUrl, modelName }) => {
        const buf = await (await fetch(ifcUrl)).arrayBuffer();
        window.ClashControl.loadFiles([new File([buf], modelName)]);
      }, { ifcUrl: c.ifcUrl, modelName: c.modelName });

      // model.stats is populated once for a fully-processed load (scoped or
      // not — loadedScope specifically is only non-null for a *scoped*
      // load, so it can't be used as a general readiness gate here).
      await page.waitForFunction(({ modelName }) => {
        const s = window._ccLatestState;
        const m = s && s.models.find((x) => x.name === modelName);
        return !!(m && m.stats);
      }, { modelName: c.modelName }, { timeout: 30_000 });

      const result = await page.evaluate(async ({ idsUrl, modelName }) => {
        const xml = await (await fetch(idsUrl)).text();
        const parsed = window._ccParseIDS(xml);
        if (parsed.error) return { parseError: parsed.error };
        const model = window._ccLatestState.models.find((x) => x.name === modelName);
        return { summary: window._ccRunIDS(parsed.specs, [model]).summary };
      }, { idsUrl: c.idsUrl, modelName: c.modelName });

      // Clean up before the next case regardless of outcome — keeps the
      // running app light across 250+ cases and guarantees the next
      // case's waitForFunction can't observe this case's stale model.
      await page.evaluate(({ modelName }) => {
        const s = window._ccLatestState;
        const m = s && s.models.find((x) => x.name === modelName);
        if (m) window._ccDispatch({ t: 'DEL_MODEL', id: m.id });
      }, { modelName: c.modelName });

      if (result.parseError) {
        outcomes.errored.push({ name: c.name, reason: 'IDS parse error: ' + result.parseError });
        continue;
      }
      const graded = gradeIDSCase(c.prefix, result.summary);
      if (graded.verdict === 'conform') outcomes.conform++;
      else if (graded.verdict === 'incomplete') outcomes.incomplete++;
      else outcomes.wrong.push({ name: c.name, reason: graded.reason });
    } catch (e) {
      outcomes.errored.push({ name: c.name, reason: String((e && e.message) || e) });
    }
  }
} finally {
  await browser.close();
  server.close();
}

const total = cases.length;
console.log('');
console.log('IDS CONFORMANCE: ' + total + ' cases — ' + outcomes.conform + ' conform, ' +
  outcomes.incomplete + ' incomplete (honestly not-checkable), ' +
  outcomes.wrong.length + ' WRONG, ' + outcomes.errored.length + ' errored');

if (outcomes.wrong.length > 0) {
  console.error('\nWRONG verdicts (CC asserted an incorrect result):');
  outcomes.wrong.forEach((w) => console.error('  ' + w.name + ': ' + w.reason));
}
if (outcomes.errored.length > 0) {
  console.error('\nHarness errors (case did not run to completion):');
  outcomes.errored.forEach((w) => console.error('  ' + w.name + ': ' + w.reason));
}

if (outcomes.wrong.length > 0 || outcomes.errored.length > 0) {
  process.exit(1);
}
console.log('\nIDS CONFORMANCE OK — zero wrong verdicts.');
