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

// Service-worker-initiated fetches bypass page.route(); the experimental
// flag (must be set before launch) lets the offline mirror below intercept
// them at the context level too, so the hard-refresh path works offline.
if (process.env.CC_BROWSER_OFFLINE_DEPS === '1')
  process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';

const localChromium = process.env.CC_CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(localChromium ? {
  executablePath: localChromium,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--no-zygote',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
} : {});
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
  if (m.type() === 'error') errors.push('console: ' + m.text() + ' [' + ((m.location() && m.location().url) || '') + ']');
  // The worker path is the product; a silent fallback to the main-thread
  // parser (e.g. a ReferenceError inside the stringified worker source)
  // must fail CI, not just run slower.
  if (m.text().includes('[IFC Worker fallback]')) workerFellBack = true;
});

// Optional deterministic dependency mirror for restricted/offline test
// environments. Production and CI still exercise the pinned CDN URLs; the
// browser keeps those URLs here too, while Playwright fulfils them from the
// exact matching npm package bytes (including the committed SRI hashes).
if (process.env.CC_BROWSER_OFFLINE_DEPS === '1') {
  async function local(route, file, contentType) {
    await route.fulfill({
      status: 200,
      body: await readFile(join(root, 'node_modules', file)),
      headers: { 'content-type': contentType || 'text/javascript', 'access-control-allow-origin': '*' },
    });
  }
  await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', (r) => local(r, 'react/umd/react.production.min.js'));
  await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js', (r) => local(r, 'react-dom/umd/react-dom.production.min.js'));
  await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', (r) => local(r, 'jszip/dist/jszip.min.js'));
  await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.min.js'));
  await page.context().route('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', (r) => local(r, 'pdfjs-dist/build/pdf.worker.min.js'));
  await page.context().route('https://cdn.jsdelivr.net/npm/three@0.180.0/**', async (route) => {
    const suffix = new URL(route.request().url()).pathname.split('/three@0.180.0/')[1];
    await local(route, 'three/' + suffix);
  });
  await page.context().route('https://cdn.jsdelivr.net/npm/web-ifc@0.0.77/**', async (route) => {
    const suffix = new URL(route.request().url()).pathname.split('/web-ifc@0.0.77/')[1];
    await local(route, 'web-ifc/' + suffix, suffix.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  });
  await page.context().route('https://fonts.googleapis.com/**', (route) => route.fulfill({status:200, body:'', contentType:'text/css'}));
  await page.context().route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.context().route('https://gc.zgo.at/**', (route) => route.fulfill({status:200, body:'', contentType:'text/javascript'}));
}

function fail(msg) {
  console.error('SMOKE FAIL: ' + msg);
  if (errors.length) console.error('Page errors:\n  ' + errors.slice(0, 20).join('\n  '));
  process.exit(1);
}

try {
  // Candidate migrations remain disabled for users, but CI explicitly opts
  // into every remaining flagged path so none can drift unexercised behind
  // its safety flag. discipline/assignment/identity/reconciliation/
  // classification/projectCodec don't appear here anymore — they graduated
  // from flagged migrations to the sole implementation (see MEMORY.md
  // Architecture Decisions), so there's no flag left to opt into; their
  // correctness is exercised unconditionally by the rest of this smoke
  // (model load -> discipline/identity classify it, detection -> matrix +
  // reconciliation + classification run, save/load -> projectCodec runs).
  await page.goto('http://127.0.0.1:8765/?ccSafety=concurrencyV2,geoCacheV8,batchedSectionsV2,rendererV2', { waitUntil: 'domcontentloaded' });

  // App mounted (CDN deps + main script executed)
  await page.waitForFunction(
    () => window.ClashControl && typeof window._ccDispatch === 'function',
    null, { timeout: 60_000 }
  ).catch(() => fail('app did not mount within 60s'));

  const gradutedCoresLoaded = await page.evaluate(() => ({
    discipline: !!(window._ccClashDisciplineCore && window._ccClashDisciplineCore.contractVersion === 1),
    assignment: !!(window._ccClashAssignmentCore && window._ccClashAssignmentCore.contractVersion === 1),
    identity: !!(window._ccClashIdentityCore && window._ccClashIdentityCore.contractVersion === 1),
    reconciliation: !!(window._ccClashReconciliationCore && window._ccClashReconciliationCore.contractVersion === 1),
    classification: !!(window._ccClashClassificationCore && window._ccClashClassificationCore.contractVersion === 1),
    projectCodec: !!(window._ccProjectCodec && window._ccProjectCodec.contractVersion === 1),
    // No flag/status/validation object should exist for any of the six —
    // graduation means there's nothing left to gate.
    noLeftoverGates: !window._ccDisciplineCoreStatus && !window._ccAssignmentCoreStatus &&
      !window._ccIdentityCoreStatus && !window._ccReconciliationCoreStatus &&
      !window._ccClassificationCoreStatus && !window._ccProjectCodecStatus,
  }));
  for (const [name, loaded] of Object.entries(gradutedCoresLoaded)) {
    if (!loaded) fail('graduated core module check failed: ' + name);
  }
  console.log('SMOKE OK — all six graduated clash-pipeline cores are loaded with no leftover flag/gate');

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

  // ── Settings modal: Claude-Desktop-style tabbed layout (8 tabs, including
  // the Advanced/tolerance-matrix tab that was previously defined but never
  // rendered anywhere — AdvancedSettingsTab existed with zero call sites
  // until this session wired it in as a real tab).
  await page.evaluate(() => window._ccDispatch({ t: 'SETTINGS', v: true }));
  await page.waitForSelector('#cc-settings-title');
  const expectedTabs = ['General', 'Measurement', 'Walk mode', 'Privacy & Data', 'Shared Project', 'AI', 'Issues', 'Advanced'];
  const tabRail = page.getByRole('tablist', { name: 'Settings sections' });
  const tabLabels = await tabRail.getByRole('tab').allTextContents();
  if (JSON.stringify(tabLabels) !== JSON.stringify(expectedTabs)) fail('settings tab rail mismatch: ' + JSON.stringify(tabLabels));
  if (!(await page.getByText('Auto fly-to on click').isVisible())) fail('General settings tab did not show Viewer content by default');
  const settingsMarkers = {
    'Measurement': 'Display units', 'Walk mode': 'Eye height', 'Privacy & Data': 'Anonymous data sharing',
    'Shared Project': 'Your name', 'AI': 'AI Status', 'Issues': 'Default Priority', 'Advanced': 'Type-Pair Tolerances',
  };
  for (const [tab, marker] of Object.entries(settingsMarkers)) {
    await tabRail.getByRole('tab', { name: tab, exact: true }).click();
    await page.waitForTimeout(30);
    if (!(await page.getByText(marker).first().isVisible())) fail(`settings "${tab}" tab did not show its marker content`);
    if (await page.getByText('Auto fly-to on click').count()) fail(`settings "${tab}" tab leaked General content`);
  }
  // Advanced tab's toggle actually flips the pref and reveals the matrix control.
  await page.getByText('Custom tolerances per type pair').locator('xpath=../following-sibling::*[1]').click();
  await page.waitForTimeout(100);
  if (!(await page.getByText(/tolerance matrix/i).isVisible())) fail('settings Advanced tab tolerance toggle did not reveal the matrix control');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(50);
  if (await page.locator('#cc-settings-title').count()) fail('Escape did not close the settings modal');
  console.log('SMOKE OK — settings modal: all 8 tabs render distinct content, Advanced tab is wired and interactive');

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
  // (The intentional duplicate-model reload below trips CC's overlap
  // confirm(); the global dialog handler near the top accepts it.)
  await page.evaluate(async () => {
    window._ccForceBatch = true;
    const buf = await (await fetch('/tests/fixtures/smoke-clash.ifc')).arrayBuffer();
    window.ClashControl.loadFiles([new File([buf], 'batched.ifc')]);
  });
  await page.waitForFunction(() => {
    const s = window._ccLatestState;
    const m = s && s.models.find((x) => x.name.indexOf('batched') === 0);
    return m && (m.elements || []).length >= 2;
  }, null, { timeout: 60_000 }).catch(async () => {
    const diagnostic = await page.evaluate(() => ({
      loading: window._ccModelLoading,
      loadMessage: window._ccModelLoadMsg,
      pendingScope: window._ccNextLoadScope,
      models: ((window._ccLatestState && window._ccLatestState.models) || []).map((m) => ({
        name: m.name,
        elements: (m.elements || []).length,
        stats: m.stats || null,
      })),
    }));
    console.error('Force-batch diagnostic: ' + JSON.stringify(diagnostic));
    fail('force-batched load did not finish');
  });

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

  // ── Load lifecycle: cancellation must settle the coordinator even when a
  // worker never emits geometry or properties. This directly covers the gate
  // that historically left the loading strip stuck after Cancel.
  await page.evaluate(async () => {
    window.Worker = class HangingWorker {
      postMessage() {}
      terminate() {}
    };
    const buf = await (await fetch('/tests/fixtures/smoke-clash.ifc')).arrayBuffer();
    window.ClashControl.loadFiles([new File([buf], 'cancelled.ifc')]);
  });
  await page.waitForFunction(() => window._ccModelLoading === true, null, { timeout: 5_000 });
  await page.evaluate(() => window._ccAbortLoading());
  await page.waitForFunction(() => {
    const coordinator = window._ccRuntime && window._ccRuntime.services.get('loadCoordinator');
    return window._ccModelLoading === false && coordinator && coordinator.activeCount() === 0;
  }, null, { timeout: 5_000 }).catch(() => fail('Cancel did not settle the load coordinator'));
  console.log('SMOKE OK — cancellation releases the lazy-property gate and returns the loader to idle');

  // ── Expected worker failure: the synchronous fallback must complete and
  // release the same coordinator. The general smoke gate still rejects any
  // other unexpected fallback.
  workerFellBack = false;
  await page.evaluate(async () => {
    window.Worker = class FailingWorker { constructor() { throw new Error('forced smoke fallback'); } };
    const buf = await (await fetch('/tests/fixtures/smoke-clash.ifc')).arrayBuffer();
    window.ClashControl.loadFiles([new File([buf], 'fallback.ifc')]);
  });
  await page.waitForFunction(() => {
    const s = window._ccLatestState;
    const m = s && s.models.find((x) => x.name.indexOf('fallback') === 0);
    const coordinator = window._ccRuntime && window._ccRuntime.services.get('loadCoordinator');
    return m && (m.elements || []).length >= 2 && window._ccModelLoading === false &&
      coordinator && coordinator.activeCount() === 0;
  }, null, { timeout: 60_000 }).catch(() => fail('main-thread fallback did not finish cleanly'));
  if (!workerFellBack) fail('forced Worker constructor failure did not use the visible main-thread fallback');
  workerFellBack = false;
  console.log('SMOKE OK — expected worker failure falls back and returns the loader to idle');

  // ── Optional integration code is absent at boot and loaded once on demand.
  const lazyAddon = await page.evaluate(async () => {
    const before = window._ccGetAddons()['openaec-bridge'];
    const beforeScripts = document.querySelectorAll('script[data-cc-feature="openaec-bridge"]').length;
    await Promise.all([window._ccEnsureAddon('openaec-bridge'), window._ccEnsureAddon('openaec-bridge')]);
    const after = window._ccGetAddons()['openaec-bridge'];
    return {
      placeholder: !!(before && before.lazy),
      beforeScripts,
      afterScripts: document.querySelectorAll('script[data-cc-feature="openaec-bridge"]').length,
      registered: !!(after && !after.lazy)
    };
  });
  if (!lazyAddon.placeholder || lazyAddon.beforeScripts !== 0 || lazyAddon.afterScripts !== 1 || !lazyAddon.registered)
    fail('optional integration did not follow placeholder → one script → registered lifecycle');
  console.log('SMOKE OK — inactive integration code loads once, only on demand');

  if (errors.length) fail('browser emitted uncaught page or console errors');
  console.log('SMOKE OK — browser completed with no uncaught page or console errors');
} finally {
  await browser.close();
  server.close();
}
