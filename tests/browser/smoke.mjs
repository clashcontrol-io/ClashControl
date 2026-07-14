// Browser smoke test: boot the real app in headless Chromium, load a real
// IFC through the real web-ifc WASM pipeline, run real clash detection,
// and assert the two crossing walls in the fixture produce a clash.
//
// Run:  node tests/browser/smoke.mjs        (requires `playwright` installed
//       and `npx playwright install chromium` done — see ci.yml)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../..', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ifc': 'application/octet-stream', '.css': 'text/css',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root))) { res.writeHead(403); return res.end(); }
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end();
  }
});
await new Promise((r) => server.listen(8765, '127.0.0.1', r));

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
// The force-batched step below reloads the same fixture geometry under a new
// filename to reach the BatchedMesh path, which trips the app's real
// duplicate-model-overlap confirm(). Playwright auto-dismisses unhandled
// dialogs (Cancel), which silently drops that load — accept it here so the
// intentional re-load proceeds like a user choosing "Load anyway".
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
let workerFellBack = false;
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console: ' + m.text());
  // The worker path is the product; a silent fallback to the main-thread
  // parser (e.g. a ReferenceError inside the stringified worker source)
  // must fail CI, not just run slower.
  if (m.text().includes('[IFC Worker fallback]')) workerFellBack = true;
});

function fail(msg) {
  console.error('SMOKE FAIL: ' + msg);
  if (errors.length) console.error('Page errors:\n  ' + errors.slice(0, 20).join('\n  '));
  process.exit(1);
}

try {
  // Candidate migrations remain disabled for users, but CI explicitly opts
  // into all four paths so none can drift unexercised behind its safety flag.
  await page.goto('http://127.0.0.1:8765/?ccSafety=concurrencyV2,geoCacheV8,batchedSectionsV2,rendererV2', { waitUntil: 'domcontentloaded' });

  // App mounted (CDN deps + main script executed)
  await page.waitForFunction(
    () => window.ClashControl && typeof window._ccDispatch === 'function',
    null, { timeout: 60_000 }
  ).catch(() => fail('app did not mount within 60s'));

  const rendererGate = await page.evaluate(() => ({
    path: window._ccRendererMigration && window._ccRendererMigration.path,
    state: window._ccRendererContractSnapshot,
    diagnostic: (window._ccSafetyMigrations.diagnostics() || [])
      .filter((d) => d.migration === 'rendererV2').at(-1) || null,
  }));
  if (rendererGate.path !== 'candidate') fail('rendererV2 did not pass its guarded factory');
  if (!rendererGate.state || !rendererGate.state.srgb || !rendererGate.state.aces ||
      !rendererGate.state.shadows || rendererGate.state.shadowAutoUpdate !== false ||
      rendererGate.state.localClippingEnabled !== false)
    fail('rendererV2 contract snapshot does not match the established renderer');
  if (!rendererGate.diagnostic || rendererGate.diagnostic.outcome !== 'candidate')
    fail('rendererV2 did not publish a passing runtime diagnostic');
  console.log('SMOKE OK — rendererV2 matches the pinned r180 renderer contract');

  // Load the fixture through the real file pipeline (web-ifc WASM from CDN)
  await page.evaluate(async () => {
    const buf = await (await fetch('/tests/fixtures/smoke-clash.ifc')).arrayBuffer();
    const file = new File([buf], 'smoke-clash.ifc');
    window.ClashControl.loadFiles([file]);
  });
  await page.waitForFunction(() => {
    const s = window._ccLatestState;
    return s && s.models.length === 1 && (s.models[0].elements || []).length >= 2;
  }, null, { timeout: 120_000 }).catch(() => fail('model did not load/process within 120s (web-ifc WASM path)'));

  const detected = await page.evaluate(async () => {
    // Default rules exclude within-model pairs (excludeSelf:true) — the
    // fixture is one model with two crossing walls, so opt self-clash in.
    const result = await window.ClashControl.runDetection({ selfClashModels: 'all', excludeSelf: false });
    return result ? result.length : 0;
  });
  if (detected < 1) fail('two crossing walls produced 0 clashes');

  // The MERGE_CLASHES dispatch lands on the next React render — wait for it.
  await page.waitForFunction(
    () => window._ccLatestState && window._ccLatestState.clashes.length > 0,
    null, { timeout: 10_000 }
  ).catch(() => fail('detection found ' + detected + ' clash(es) but they never reached app state'));

  const sample = await page.evaluate(() => {
    const c = window._ccLatestState.clashes[0];
    return c ? c.type + ' ' + (c.title || c.aiTitle || '') : '';
  });
  if (workerFellBack) fail('IFC worker crashed and fell back to the main-thread parser — check the stringified worker source for missing functions');
  console.log('SMOKE OK — model loaded, detection found ' + detected + ' clash(es), state updated; first: ' + sample);

  // ── Hard-refresh/cache restore: the five-hotfix "spikey model" incident
  // only appeared after reload, never on a fresh parse. Keep the real IDB +
  // geo-cache path in CI and compare element bounds before/after. The
  // diagnostic additionally detects different-sized geometries sharing one
  // restore instancing key (the exact PR #598 root-cause signature).
  const beforeRefresh = await page.evaluate(() => {
    const m = window._ccLatestState.models.find((x) => x.name.indexOf('smoke-clash') === 0);
    return (m.elements || []).map((e) => {
      const b = e.box;
      return [e.expressId, b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]
        .map((v, i) => i === 0 ? String(v) : Number(v).toFixed(6)).join(':');
    }).sort();
  });
  // Let the existing 2s project autosave settle. File bytes are already in
  // IndexedDB, but this also exercises the real pagehide flush on reload.
  await page.waitForTimeout(2500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.ClashControl && typeof window._ccDispatch === 'function',
    null, { timeout: 60_000 }
  ).catch(() => fail('app did not remount after hard refresh'));
  await page.waitForFunction(() => {
    const s = window._ccLatestState;
    const m = s && s.models.find((x) => x.name.indexOf('smoke-clash') === 0);
    return !!(m && m.stats && (m.elements || []).length >= 2);
  }, null, { timeout: 120_000 }).catch(() => fail('cached model did not restore after hard refresh'));
  const afterRefresh = await page.evaluate(() => {
    const m = window._ccLatestState.models.find((x) => x.name.indexOf('smoke-clash') === 0);
    const bounds = (m.elements || []).map((e) => {
      const b = e.box;
      return [e.expressId, b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]
        .map((v, i) => i === 0 ? String(v) : Number(v).toFixed(6)).join(':');
    }).sort();
    const instancing = window._ccDebugInstancing ? window._ccDebugInstancing() : null;
    return { bounds, collisionCount: instancing ? instancing.collisionCount : null };
  });
  if (JSON.stringify(afterRefresh.bounds) !== JSON.stringify(beforeRefresh))
    fail('element bounds changed across hard-refresh/cache restore');
  if (afterRefresh.collisionCount !== 0)
    fail('cache restore produced ' + afterRefresh.collisionCount + ' suspect instancing-key collision(s)');
  console.log('SMOKE OK — hard refresh restored identical bounds with zero suspect instancing collisions');

  // ── Scoped loading: same fixture, storey filter must thread through the
  // worker → only in-scope geometry materialises ───────────────────────────
  await page.evaluate(async () => {
    const buf = await (await fetch('/tests/fixtures/smoke-clash.ifc')).arrayBuffer();
    window.ClashControl.loadFiles([new File([buf], 'scoped-bogus.ifc')], { storeys: ['NoSuchLevel'] });
  });
  await page.waitForFunction(() => {
    const s = window._ccLatestState;
    const m = s && s.models.find((x) => x.name.indexOf('scoped-bogus') === 0);
    return m && m.stats && m.stats.loadedScope; // load finished, scope recorded
  }, null, { timeout: 60_000 }).catch(() => fail('scoped load (bogus storey) did not finish'));
  const scoped = await page.evaluate(() => {
    const s = window._ccLatestState;
    const m = s.models.find((x) => x.name.indexOf('scoped-bogus') === 0);
    return { els: (m.elements || []).length, out: m.stats.scopedOutCount, storeys: (m.storeys || []).length };
  });
  if (scoped.els !== 0) fail('bogus-storey scope still loaded ' + scoped.els + ' elements');
  if (scoped.out < 2) fail('expected >=2 scoped-out elements, got ' + scoped.out);
  if (scoped.storeys < 1) fail('storey list must stay complete on scoped loads');
  console.log('SMOKE OK — scoped load: 0 elements materialised, ' + scoped.out + ' skipped, storey list intact');

  // ── BatchedMesh identity features: every symptom that caused the old
  // chunk-merge reverts (366c7cc) is asserted here ────────────────────────
  await page.evaluate(async () => {
    window._ccForceBatch = true;
    const buf = await (await fetch('/tests/fixtures/smoke-clash.ifc')).arrayBuffer();
    window.ClashControl.loadFiles([new File([buf], 'batched.ifc')]);
  });
  await page.waitForFunction(() => {
    const s = window._ccLatestState;
    const m = s && s.models.find((x) => x.name.indexOf('batched') === 0);
    return m && (m.elements || []).length >= 2;
  }, null, { timeout: 60_000 }).catch(() => fail('force-batched load did not finish'));

  const batch = await page.evaluate(() => {
    const s = window._ccLatestState;
    const m = s.models.find((x) => x.name.indexOf('batched') === 0);
    const grp = window._ccState3d.map[m.id];
    let b = null;
    grp.traverse((o) => { if (o.userData && o.userData._isCCBatch) b = o; });
    if (!b) return { found: false };
    const eids = b.userData.batchExprIds.filter((e) => e != null);
    // symptom: hide — per-element visibility without index rebuilds
    const target = eids[0];
    const idx = b.userData.batchExprIds.indexOf(target);
    window._ccTempHide([target]);
    const hiddenAfterHide = b.getVisibleAt(idx) === false;
    window._ccTempUnhide();
    const shownAfterUnhide = b.getVisibleAt(idx) === true;
    // symptom: style switch — material swap must reach the batch
    const matBefore = b.material.uuid;
    window._ccDispatch({ t: 'UPD_PREFS', u: { renderStyle: 'rendered' } });
    return new Promise((resolve) => setTimeout(() => {
      const matAfterStyle = b.material.uuid;
      window._ccDispatch({ t: 'UPD_PREFS', u: { renderStyle: 'shaded' } });
      window._ccDispatch({ t: 'SECTION', axis: 'x', pos: 0.5 });
      setTimeout(() => {
        const clippingPlanes = (b.material.clippingPlanes || []).length;
        const sectionDiag = (window._ccSafetyMigrations.diagnostics() || [])
          .filter((d) => d.migration === 'batchedSectionsV2').at(-1) || null;
        window._ccDispatch({ t: 'SECTION', axis: null, pos: 0.5 });
        resolve({
          found: true, items: eids.length, hiddenAfterHide, shownAfterUnhide,
          styleSwapsMaterial: matAfterStyle !== matBefore,
          // symptom: blending — per-instance colors recorded for distinction/restore
          origColors: (b.userData._origColors || []).filter((c) => c != null).length,
          clippingPlanes, sectionDiag,
        });
      }, 300);
    }, 400));
  });
  if (!batch.found) fail('forced batching produced no BatchedMesh');
  if (batch.items < 2) fail('batch lost elements: ' + batch.items);
  if (!batch.hiddenAfterHide || !batch.shownAfterUnhide) fail('per-element hide on batch broken (revert symptom)');
  if (!batch.styleSwapsMaterial) fail('render-style switch did not reach the batch material (revert symptom)');
  if (batch.origColors < 2) fail('per-instance colors missing — elements would blend (revert symptom)');
  if (batch.clippingPlanes !== 1) fail('section plane did not reach BatchedMesh material');
  if (!batch.sectionDiag || batch.sectionDiag.outcome !== 'candidate' || batch.sectionDiag.stats.batches < 1)
    fail('BatchedMesh section candidate did not pass its runtime equivalence gate');
  console.log('SMOKE OK — BatchedMesh: ' + batch.items + ' items, hide/style/colors/section all behave per-element');
} finally {
  await browser.close();
  server.close();
}
