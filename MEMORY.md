# ClashControl — Shared Session Memory

> **Hand-maintained — there is no automated daily sync any more.** Every new Claude session
> should read this file first so it doesn't re-implement things, repeat past mistakes, or
> work against the current direction. Keep it short: update **Active Work** at the start
> and end of each session, and fold in a short summary under **Recently completed** rather
> than pasting full session write-ups.
> The full historical narrative (long session write-ups, the old auto-generated session log) was
> condensed away on 2026-09-28, when `.github/workflows/daily-sync.yml` and `scripts/update-memory.py`
> were also removed (see CLAUDE.md). `git show 0f08459:MEMORY.md` has the last full pre-condense
> version, and `git log` has everything since.

---

## Project State

**Version:** 7.5.0 (see `version.json`; the pre-commit hook bumps it).
`index.html` is ~38.9k lines (check with `wc -l`).

**Live features:**
- **Clash engine:** AABB broad-phase plus BVH tri-tri narrow-phase (Möller). The broad-phase sweep also has a Rust/WASM path (`_ccWasmSweepAndPrune`, `engine/src/broadphase.rs`) that falls back to the JS `_sweepAndPrune`. The narrow phase can use the `_ccWasmIntersect`/`_ccWasmMinDist` accelerators. A default clash matrix skips same-discipline cross-model pairs (never same-model self-clashes), with an N×N matrix UI. Rules cover discipline filters, clearance `[minGap,maxGap]` and group-by. Hard clashes report an approximate real penetration depth (`_estimatePenetrationDepthM`, browser only). Severity is deterministic (`_ccDeterministicSeverity`). After each run a funnel toast shows the counts. Optional escalation to `local-engine.js` runs the **same** algorithm at native speed.
- **Clash review:** cluster cards, J/K/C/D/V keyboard triage, A/B pair colours, occluder-reveal, spatial "Location" grouping, and assignment rules (discipline-pair × storey → assignee/priority).
- **BCF 2.1/3.0 export/import:** export writes Components/Selection/Visibility/Coloring, synthesized default viewpoints, and orthographic cameras. The HTML clash report and the Data Quality report are both print-to-PDF.
- **IFC loading:** web-ifc 0.0.77 WASM in a worker (protocol v2, packed `rawEls`) with a main-thread fallback. IFC 4.3 parses with geometry. Storey-scoped loading has a picker (`ccUiStoreyChooser` flag, off by default). Declared length-unit extraction. Park/Restore models, with auto-park under heap pressure.
- **Rendering:** Three.js r180 ESM. BatchedMesh/InstancedMesh are used for pathological models, with per-element proxies kept off-scene.
- **Data Quality addon:** BIM basics, ILS v2, NL-SfB, RVB BIM Norm (the RVB section never counts toward the headline score), run-to-run count reconciliation, and an IDS 1.0 engine with import/export.
- **Accessibility addon:** Bbl/NEN geometry checks. **Visibility (sight-line) addon.**
- **Geo:** placement via IfcSite or IfcMapConversion, proj4 CRS reprojection (placement-grade, ~1 m), 3D Tiles context (PDOK/Google/Cesium ion), and a basemap. Point clouds, Gaussian splats, and 3-point alignment for point clouds.
- **Navigator:** real search (GlobalId and pset values), selection sets (rename, +/−), dynamic search sets, element-vs-element property diff, containment breadcrumb and hosted elements.
- **AI and integrations:** NL commands via Groq (`/api/nl`, ~30 tool declarations in `TOOLS`), deliberately basic. Clash-solving is nudged to the user's own LLM through the Smart Bridge Connector (MCP `mcp-server.js`, REST, one-click local-LLM autodetect). Revit connector (live WebSocket, clash push-back). OpenAEC bridge.
- **Collaboration:** shared projects (project keys, Neon Postgres, atomic CAS on PUT) and folder-sync collaboration.
- **Other:** walk mode, 2D sheet view, section planes/box, PWA, i18n (`_cc_t`, `locales/ja.json`), regional regulation packs (`regulations/manifest.json` is intentionally empty), and tabbed Settings.
- **Local storage:** registry, budget and GC (`storage-core.js`, `ClashControl.storage.*`).

**Addons (`addons/`):** accessibility, align, data-quality, geoplace, local-engine, openaec-bridge, pointcloud, pwa, revit-bridge, shared-project, smart-bridge, splat, tiles, training-data, visibility, wasm-engine (+ `wasm-engine-pkg/`).

**Non-addon core modules** (plain `<script defer>`, required): `cc-runtime.js`, `safety-migrations.js`, `storage-core.js`, `clash-{discipline,assignment,identity,reconciliation,classification}-core.js`, `project-codec.js`, `section-clipping.js`, `renderer-contract.js`, `analytics-consent.js`.

**Backend (`api/`):** `nl` (Groq-only), `title` and `triage` (Gemma via `GEMINI_API_KEY`), `project`, `training`, `health`, `tile` (MapTiler/OSM proxy), `_lib.js`, `schema.sql`.

**Deployment:** `www.clashcontrol.io` on Vercel. There are no COOP/COEP headers (the app is not cross-origin isolated).

**GitHub Actions:**
- `ci.yml` runs on PRs to `main` and on pushes. It covers node tests, browser-smoke and browser-differential.
- `version-bump.yml` and `sri-check.yml`.
- `ids-conformance.yml`: weekly or manual, non-blocking.
- `contribute-pack.yml`, `release-desktop.yml` and `release-smart-bridge.yml`.

**Plan docs (all under `docs/` — see CLAUDE.md's File overview):**
- `docs/IMPROVEMENT_PLAN.md`: Waves 0–6 and the CW-1 depth/volume work.
- `docs/V7_RELEASE_PLAN.md`: P0–P6, with implementation-status tables.
- `docs/REDUCER_DECOMPOSITION_PLAN.md`
- `docs/AS_BUILT_DEVIATION.md`
- `docs/TAURI.md`: desktop app.
- `docs/INTERNALS.md` §22: the port/protocol registry.
- `tests/fixtures/CORPUS_MANIFEST.md`

---

## Architecture Decisions

These are permanent. Add rows; don't remove them.

| Date | Decision | Reason |
|------|----------|--------|
| founding | Single `index.html` app, no build step | Zero setup; transparency; easy to fork/inspect |
| founding | Three.js r128 pinned — *superseded 2026-06-08 (next row)* | API stability at the time |
| 2026-06-08 | Three.js r128 → r180 as ESM via import map (#595, v5.19.12) | Unblocks modern-Three features (splat dedup, BatchedMesh, future WebGPU); post-r155 color mgmt/lighting explicitly re-tuned |
| founding | In-browser engine = AABB broad-phase + BVH tri-tri narrow-phase (not "OBB"; orientation only via slimline-axis prune). WASM accelerators optional. `local-engine.js` escalates to the Python server running the **identical** Möller tri-tri + BVH algorithm (Numba/multiprocess/KD-tree) — NOT solid boolean ops (corrected 2026-07-13 after reading `intersection.py`) | Tri-tri is the browser sweet spot (kills AABB false positives on rotated members, fast, WASM path). Escalating buys speed, not more-correct geometry — see `docs/IMPROVEMENT_PLAN.md` CW-1 for making it genuinely more exact |
| founding | CDN deps pinned with SRI hashes | Reproducibility; integrity |
| founding | Addons pattern (`addons/*.js` IIFE) | Keeps core lean; optional features don't block load |
| founding | Preact/React via CDN UMD (not ESM) | No bundler; works with inline htm |
| founding | htm instead of JSX | No transpilation; hand-written parser inlined |
| 2026-04-10 | Stripped ~1960 what-comments from index.html → INTERNALS.md | Comments explained what, not why; smaller file |
| 2026-04-10 | Camera globals consolidated into `_ccViewport` | Single source of truth; less global sprawl |
| 2026-04-10 | View cube uses `camera.quaternion.copy().invert()` | Camera-position approach mirrors left/right |
| 2026-04-13 | `processNLCommandWithLLM` wraps `/smart` command | Async handling; consistent NL pipeline |
| 2026-04-15 | 2D sheet uses polygon-face section cut | Correct floor-plan geometry without mesh booleans |
| 2026-07-17 | Six clash-pipeline cores (discipline/assignment/identity/reconciliation/classification/projectCodec) graduated to sole, unconditional implementation; inline legacy code, boot equivalence checks and opt-out flags deleted | Soak at defaultEnabled:true showed zero drift; dual-run was pure overhead. A missing module now throws `TypeError` by design — there is no fallback |

---

## Known Issues & Gotchas

Keep every entry unless it's truly obsolete. Add a note when something gets fixed.

### Rendering / viewer
- **Three.js r180 API**: use r180 docs. It loads as ESM via the import map. The post-r155 color-management and light-intensity tuning is deliberate (e.g. rendered-mode exposure 0.4), so don't reset it to library defaults.
- **View cube** must use `cubeGroup.quaternion.copy(camera.quaternion).invert()`. The camera-position approach mirrors the view.
- **`invalidate()`** is required after any visual change. `_needsRender` > 0 means render, and it decrements per frame. The culling pass (`updateCulling`) throttles to 1 per 8 frames, so a model-visibility change needs `S._forceCull`; a bare `invalidate()` isn't enough.
- **Ghost material is shared** (`MeshBasicMaterial 0x334155, opacity .08`), so never dispose it per mesh. The shared #572 phong cache is also never disposed per mesh; only the per-mesh `_styleMats`/`_edges` are disposed on unload.
- **BatchedMesh traps:**
  - Any scene material/clipping sweep written before batching probably filters on `expressId==null && !isInstancedMesh`, which silently skips batches. Include `userData._isCCBatch`. The render-style swap on batches has not been audited (cosmetic).
  - Off-scene original meshes have no parent, so their `matrixWorld` is a stale identity. Refresh it from `.matrix`, as the outline/bbox code does.
- **Chunk-merge history** (don't repeat it): hand-rolled mesh merging broke identity features, and ~49 setters never became chunk-aware. It went through several enable/revert cycles and was removed in `704837f`. It was replaced by native BatchedMesh with off-scene per-element proxies (`element.meshes[]` stays the source of truth), plus CI regression gates in `tests/browser/smoke.mjs`.
  - "Free RAM"/dehydrate was reverted the same day. Park is the properly scoped redo of that idea.
  - `_instKey` must use `geometryExpressID`, never a derived hash. Scale-invariant hashes grouped 12 m and 18 m piles together ("spiky model").
  - Retire legacy fallback paths in the same change as the fix; don't leave zombie code behind.
- **Removing the proxy pattern was REJECTED** ("BatchedMesh as sole render source", large-model plan Phase 3). It reintroduces the chunk-merge failure class. If memory must come down, target the already-batched subset narrowly.
- **PostFX (SAO/Outline/SMAA)** is the highest-risk area. Re-enable only as an opt-in, without SMAA, and verify on batched models before any default flip.
- **Present-mode click-to-frame is intentionally disabled** ("read-only walkthrough"). Don't "fix" it.
- **Orbit/zoom:** `makeOrbit` is a top-level helper and cannot see App's `modelsRef`/`_elemsBBox` (that threw and broke zoom). Get bounds via `window._ccViewport.getBounds()`. Every selection path recentres the pivot via `_highlightById` (`keepPivot` opts out).
- **Occluder hide** must use each mesh type's native hide:
  - Mesh: `.visible`
  - InstancedMesh: `setMatrixAt(_INST_HIDE_MX)`
  - BatchedMesh: `setVisibleAt`

  `_ccTempHide` has no InstancedMesh branch. Never call `ghostOthers`/`unghostAll` from occluder code.
- **Clipping:** the core turns `renderer.localClippingEnabled` off when no section is active. `tiles.js` site-clearing re-asserts it each frame.
- **North/georef sign:** the applied rotation was negated after a live test. If a model rotates the wrong way, suspect a per-authoring-tool sign difference and add a flip toggle. Georef is context/QA only; the clash engine uses local coordinates.
- **3D Tiles ENU→Y-up sign** is unverified with Google tiles. If the city is mirrored or under the model, flip the rotX sign.
- **Z-index:** modals use `S_BACKDROP` `zIndex:50`. `WelcomePopup` is at 20 so it can't eat modal clicks.
- **Measuring overlap:** `getBoundingClientRect` reports unclipped geometry for children under `overflow:hidden`. Confirm "overlap" with a screenshot.

### React / htm / UI
- **Rules of Hooks:** never call hooks inside `${cond && function(){...}()}` render IIFEs. That crashed clash review (React #310). Extract a component instead (e.g. `ClashToleranceEditor`). Prefer native `<details>` for disclosure, since it needs no state.
- **htm `<img src=${…}>` must be written `\x3Cimg`.** In plain report strings, split it as `'<im'+'g'`. Otherwise Chromium's preload scanner fetches the literal `${…}` URL (404 noise). The cooked string is identical for the htm parser.
- **Lazily-loaded addon state slices** (`s.smartBridge`, `s.openaecBridge`) exist only after first activation, so every core read must be null-guarded. Addon `reducerCases` only run while the addon is active: call `_ccActivateAddon(id)` before dispatching (e.g. the string action `'REVIT_BRIDGE'`; `A.REVIT_BRIDGE` doesn't exist). Lazy activation must fire `def.onEnable` after it resolves.
- **Detection can run from non-interactive triggers** (NL/AI, auto-run). Use `window._ccToast`, never `confirm()`, inside detection.
- **i18n:**
  - `_cc_t(key, english, vars)` falls back to English and has no plural rules (use separate keys).
  - Do NOT translate:
    - IFC/Revit pset/property names (they are lookup keys)
    - the NL regex parser and its suggestion chips (they are fed back into the English parser)
    - command-palette `keywords`
    - the GitHub issue body in `MemoryWarningModal`
    - product names and format IDs (BCF/PDF/DXF, PDOK)
    - ViewCube canvas labels
  - Wiring tests anchor on literal source text, so update them when you wrap a string.
- **Addon guard:** core calls into addons use `typeof window._ccFoo === 'function'`. The WASM addon publishes its globals only after init succeeds, because the core treats their existence as "skip the JS fallback" and a stub would silently report 0 clashes.
- **Before designing a new report/export**, grep for `window.print`, `@media print` and `⎙`. `_ccClashReport`, `_ccDataQualityReport` and `generateValidationReport` already exist.

### Clash semantics
- **Coplanar triangle pairs are deliberately NOT clashes** (JS `_triTriTest` and Python `tri_tri_intersect`). Flush contact is everywhere, and the early-out also avoids a 0/0 NaN.
- **IFC spatial hierarchy is not a pruning filter.** Geometry crosses storeys. Pruning comes only from the AABB broad-phase.
- **Same-model self-clashes are never suppressed by the discipline matrix.** The `sameModel` check comes first in `_ccMatrixSkipsSameDiscipline`.
- **The single-model `excludeSelf` trap** is fixed as an *effective* override inside `_sweepAndPrune`: when `grpA ∪ grpB` is one model, self-pairs are allowed. Don't mutate `rules.excludeSelf`; dozens of call sites set it.
- **Federating two same-discipline models gives 0 clashes by default.** A toast and banner offer "Check same-discipline pairs & re-run".
- **Penetration depth:** `_estimatePenetrationDepthM` is an approximation. It uses vertex-inside tests (3-axis ray parity) plus closest-point distance, falls back to the SAT chord and then the AABB overlap, and returns null for grazes such as a thin post through a slab.
  - Parity rays **must be tilted off-axis**. Axis-aligned rays hit shared edges in axis-aligned IFC geometry and flip parity.
  - Only the browser's hard-clash `distance` is a real depth. Don't build severity/triage on `overlapVolM3` or the Python `penetration_est` (an AABB upper bound).
- **Severity vocabulary is `critical|major|minor|info`.** Don't rank with `o[x]||2`, because `critical` ranks 0, which is falsy.
- **Assignment rules** match on `DISC` ids (`structural/mep/architectural/civil/other`), NOT `STANDARD_DISCIPLINES`. Rules stamp only `_delta==='new'` clashes that have no assignee; `mergeDetectionResults` carries prior assignee/priority forward.
- **Accessibility and Data Quality failures** go through `ADD_ISSUE`/`ADD_CLASHES`, never `MERGE_CLASHES`, which treats its payload as the full result and auto-resolves real clashes.
- **Scoring:** ILS counts toward the headline Quality Score only when ≥20% of elements carry an NL-SfB code. RVB never counts toward the headline.
- **IDS honesty rule:** anything the engine can't evaluate (PredefinedType, non-storey partOf, dataType, unsupported regex) is reported "not checkable" and never counted as a pass.
- **Candidates:** the Wasm sweep returns a compact view (`_makeCompactCandidates`, read through `_candidateAt`). The JS `_sweepAndPrune` still returns an eager array as the oracle, so callers must go through `_candidateAt`.
- **WASM narrow-phase parity:** `addons/wasm-engine-pkg/` is now bit-identical to the JS reference (`_triTriTest`/`_buildBVHNode`/`_bvhTraverseAll`/`_meshMinDist`) on hit/no-hit, every raw point coordinate, depth, and min-distance — enforced by a differential test (`tests/wasm-parity.test.js`) plus a runtime self-check the addon runs before trusting the WASM path. Treat any future WASM/JS drift as a regression, not an accepted approximation.

### Local engine (Python, `ClashControlEngine` repo)
- The engine returns `distance` in **mm**; don't multiply by 1000 again (fixed 2026-07-21). `maxGap`/`minGap` are also mm on the wire.
- **Rule fields the engine ignores server-side:** `excludeTypes`, `excludeTypePairs`, `toleranceByTypePair`, `duplicates`, `excludeSelf` and `minOverlapVolM3`.
  - `_applyClientSideRuleFilters` re-applies them.
  - `window._ccLocalEngineCanHandle` fails closed: `changeAware`, per-pair tolerance > maxGap, semantic filter, or a non-'all'/single scope → run in the browser.
  - The gate is a **hand-maintained snapshot**; keep it in sync with the Engine repo.
- **Depth parity:** the Python side has no depth estimator yet, so escalating gives a *worse* depth number than the browser.

### IFC loader / worker / memory
- **Don't remove the web-ifc WASM init 10s timeout.** The loader is "complex but working". Touch it only with the differential harness (`tests/browser/ifc-worker-fallback-differential.mjs`: 6 fixtures + cancellation) green before and after.
- **IFC unit scale:** storey elevations are often in mm while geometry is in metres, so always apply `geoFactor`. Unit precedence is override > declared LENGTHUNIT > spacing heuristic.
- **The worker Blob is built from `.toString()`** of the shared extraction functions (`_getIFCWorkerUrl`). That guarantees the worker and fallback can't drift.
  - The static-file extraction route is `<script defer>` plus `importScripts()`.
  - It is cross-cutting: `safeStr` alone has 23 call sites.
  - Don't attempt it without expanded differential coverage.
- **Detached input buffer:** the input `ArrayBuffer` is *transferred* to the worker. After `postMessage` it is detached, so the fallback, `idbSaveFile` and the fileSize read re-read it from the `File`.
- **Worker rejection paths** must release the lazy gate (`_releaseLazyGate()`), or the "Placing elements 85%" modal sticks forever.
- **Scoped/partial loads never write the geo-cache.** `_ccReloadModelFull` sets `_ccSkipScopeCheckOnce`, otherwise `maybeScopeThenProcess` re-opens the picker. Chain auto-reload triggers on the `idbSaveFile` promise.
- **`_mergeLazyProps`** must patch the geoCache `hasPsets` even when the model has been parked before Phase-2 props arrive. Otherwise every restore cold-parses (this was the 3.91x→1.44x heap-ratio bug).
- **Park/Restore guarantees:** the geoCache is preserved, restore reuses the same id, and it fails closed on non-restorable models (revit-live, or no cache+file). Any memory-reclaim work must keep all three.
- **Don't slim `_pairResultCache`**, because `changeAware` re-emits it verbatim. The `TRAINING_MODE` localStorage value stays in its raw `'1'`/`'0'` format.
- **Large-model performance:**
  - Measure with `stats.phases`/`stats.sceneSub` (including `transferGap`) read off the loaded model, not by parsing `console.table`.
  - The old "174s / 145k elements" figure was a fixture-generator bug (bare `IfcCartesianPoint` as profile Position); don't cite it.
  - Scaling is super-linear. The residual transfer cost is `geoTable`'s one object per unique geometry.
- **Progressive/partial loading is not built, deliberately.** If it's ever attempted:
  - Put it behind a flag.
  - Audit every `model.elements`/`model.meshes` consumer first.
  - Write regression tests for every failure mode before any default-on.
  - Prefer native primitives. web-ifc `StreamAllMeshes` has no yield hook.

### BCF
- **Viewpoint element order** follows the XSD: `Components` → camera → `Lines` → `ClippingPlanes` → `Bitmap`.
  - `<Visibility>` is **required** in 2.1 (always emit `DefaultVisibility="true"`).
  - `<Coloring>` is a child of `<Components>`. In 2.1, `<Color>` holds `<Component>` directly; in 3.0 it wraps a nested `<Components>`.
  - Verify against the real `visinfo.xsd`, not secondary sources.
- **Orthographic viewpoints** use `isOrtho` + `viewToWorldScale` (no `.fov`). `_restoreViewpoint` only touches fov/scale when the live camera type matches.
- **`_ccImportBCF`** needs the `{base64}` signature. A `File` argument silently opens the picker.
- **Shared project PUT** uses a single-statement atomic CAS (`ON CONFLICT … WHERE updated_at <= expected`).

### Tooling / infra / workflow
- **Browser tests in this sandbox:**
  - The proxy blocks the CDNs. Run with `CC_BROWSER_OFFLINE_DEPS=1` (serves React/Three/JSZip/pdf.js/web-ifc from npm packages) and `CC_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
  - Only Chromium is installed (no Firefox/WebKit), so Safari/Firefox-only logic can't be verified.
  - Real-browser checks: `node tests/browser/smoke.mjs` plus the other `tests/browser/*.mjs`. Unit tests: `npm test` (`node --test`).
  - `npm run lint:inline` runs `scripts/lint-inline.js` (extracts the main inline `<script>` from `index.html`, preserving line numbers) through ESLint 9 (`eslint.config.mjs`) — it's also a CI job (`ci.yml`'s `lint-inline`), non-blocking on warnings, 0 errors expected.
- **`ci.yml` only fires for PRs whose base is `main`.** Stacked PRs get no CI until they're retargeted. `pull_request: synchronize` events have also stalled on open PRs (they were nudged with empty commits); if it recurs, the GitHub App permissions/webhook may need a maintainer. Before assuming a flake, check whether the PR was already merged.
- **Poll GitHub via the authenticated MCP.** The anonymous API limit is 60/h. WebFetch of GitHub `/tree/<branch>/<path>` 404s; fetch `raw.githubusercontent.com` file paths directly.
- **`ids-conformance.yml`** is still `continue-on-error: true` and fetches the corpus at `development` HEAD. **Pin the corpus commit before making it a required check.**
- **Service worker:** it excludes `/api/*` (don't cache API paths) and is network-first for navigations, so static SEO pages aren't hijacked. The `/tour/` hand-off uses IndexedDB `cc-handoff` → `/?load=1`.
- **Tool catalog:** the single source of truth is the addon `_TOOL_MANIFEST`. `mcp-server.js` fetches `GET /tools` from the bridge and falls back to its static `TOOLS` only before a browser connects. The tool count is regression-checked (`tests/doc-tool-count.test.js`).
- **Own-LLM access:** the https app can't reach `localhost` LLMs directly (mixed content/CORS), so a local LLM needs the native bridge.
- **NL pre-block:** don't make it over-eager; conversational text must reach Groq.
- **2D annotation coordinates** were fixed in v4.15.4. Re-test the transform carefully if you re-implement annotation rendering.
- **Hidden control characters:** if `Edit` refuses an exact match on text you just read, suspect a hidden control byte. Check with `cat -A`/`od -c`, then fix it with a `node -e` split/join.
- **Checks before refactors:** grep for an existing helper before adding a new file or abstraction. Twice now a "new" module duplicated an existing helper (`_ccPersistUI`).

---

## Recently completed (for context; details in git history / `git show 0f08459:MEMORY.md`)
- 2026-07-13: IMPROVEMENT_PLAN Waves 0–5, except the items listed under Open.
  - Wave 0: orbit pivot, `minGap`, JS/WASM hit parity, Quality Score folding, stable discipline colours.
  - Waves 1–5: default clash matrix, penetration depth (CW-1a, browser), severity, funnel toast, spatial clusters, camera feel, BCF Selection/Visibility/Coloring/synth viewpoints, assignment rules, search/selection/search sets/diff, DQ reconciliation, RVB checks, DQ print report, IDS pass-count honesty fix.
- 2026-07-14: stress-test fixes (React #310 clash crash, stuck loading modal, pivot consistency, same-discipline trap, zoom-to-void clamp). `classifyClashes` is now a spatial hash (167s→21.6s). Trust hardening: explicit telemetry consent, `/api/training` caps, manual-only bridge update.
- 2026-07-15/16: six guarded core modules ported (graduated 07-17). `cc-runtime.js` runtime plus on-demand smart-bridge/openaec.
- 2026-07-17: REWRITE_UI phases 2–12 (the doc is deleted; see PR #688/#689), toolbar `ResponsiveToolGroup` (`ccUiToolbarV2`, PR #691), tabbed Settings, prefs-persistence slice 1, PDF export redlines fix, storey pre-scan completeness.
- 2026-07-17: IFC worker protocol v2 (packed rawEls: −46% transferGap), zero-copy input transfer, expanded differential harness, load-cancel-load loop, Rust/WASM broad-phase sweep (3.77× faster, byte-identical), storey-scope auto background completion.
- 2026-07-19: storage/memory campaign P1–P7 (`storage-core.js`, budgets/GC, autosave gate, detect-cache flags).
- 2026-07-21: local-engine mm double-scaling fix, capability gate, compact candidate view, model-scope stamping on runs/BCF README, BCF ortho export and viewpoint ortho crash fix.
- 2026-07-22: Park/Auto-park (#702). V7 P0.1–P0.5 local-engine parity plus P1.3, P5.1 CAS (#701). P6.1 residency ledger, P6.2 first slices (#704/#705), P6.3/P6.4 opt-in slices. Real-browser validation. `_mergeLazyProps` parked-model fix.
- 2026-07-23/27: i18n and regulation-pack infrastructure (#708), plus the retrofit of nearly all UI strings to `_cc_t` (#709). Validators and a label-gated contribution pipeline.
- June 2026: BatchedMesh rollout; WASM engine first wired; Tauri Phase 0 scaffold; 3D Tiles/PDOK/Cesium; CRS reprojection; IDS 1.0 engine (#622); storey-scoped loading; Groq-only NL plus own-LLM Connector; accessibility addon; BCF 3.0 validity; browser smoke CI; SEO landing pages/tour.
- **2026-09-28** (branch `claude/pensive-faraday-v6t6wh`, merged to this session):
  - Fixed undefined-name crashes and rules-of-hooks bugs; added the `lint-inline` CI job (ESLint over the extracted inline `<script>`).
  - Fixed `App()`'s dispatch-wrapper stale-closure bug.
  - Fixed keyboard-shortcut bugs: Tab trap, double-meaning keys, Ctrl+F, style-hotkey mismatch, modal focus traps.
  - **WASM narrow-phase engine made bit-identical to the JS reference** (`_triTriTest`/BVH/min-distance) — see the WASM parity gotcha above; new `tests/wasm-parity.test.js`.
  - Fixed clash reconciliation: preserved out-of-coverage clashes of any status, kept counts stable across the grid-cell fallback, made identity element-pair based instead of index based.
  - Fixed clash actions: Deny→Next navigation, Confirm now carries full element identity, batch Confirm matches single-Confirm behavior.
  - Fixed project restore: stubs no longer destroy loaded model geometry on restore; issues/selection/search-set dedup.
  - Fixed project switch: resets all per-project state, unified `deleteProject`, persists comments.
  - **Cross-model `expressId` scoping**: two models sharing a bare expressId no longer cross-select/highlight/hide each other (tree node keys, `_elClick`, multi-select, `window._ccSelectedModelId`, `_ccTempHide`, Selection Set +/-, per-model storey-hide). Hardened `api/project.js` + the shared-project client sync (server-authoritative `updated_at` echo, `conflicts[]` handling + re-pull/toast instead of silent drop, globalId-pair hydration, `''`-vs-`null` field preservation, server-side dedup/validation, `scope=project` DELETE, pruned rate-limiter map). New `tests/project-db.test.js` (`tests/_neon-mock.js`) + `tests/element-modelid-scoping-wiring.test.js`.
  - Fixed clash-list: reversed severity sort, missing "Denied" filter, IDS results polluting Hard/Soft totals.
  - Security pass (this session): GitHub Actions shell-injection fix in `contribute-pack.yml`; `sw.js` core-module staleness fix (network-first for same-origin JS/WASM); anchored the bump-version SEO-page regex; `/api/title` + `/api/triage` cache-key hardening against cross-caller poisoning; `/api/health` `?test=1` rate-limited and no longer echoes upstream body; `/api/tile` rate limiter + no error echo; CORS `Vary: Origin` + apex origin; new `.vercelignore`; `vercel.json` security headers block; CSP fixes (Google Fonts preconnect, Cesium ion hosts); Smart Bridge "Enable" now confirms before the first binary download.
  - Not done (deferred): a UI affordance to disambiguate an unresolved legacy (no-modelId) selection-set entry matching more than one model; `_ccBatchHidden.class`/`.storey` keys for byType/byDiscipline/byMaterial views stay intentionally cross-model.

---

## Open / deferred items

**Local engine / `ClashControlEngine` repo** (separate repo, needs its own PRs):
- **Depth (CW-1):** CW-1a Python half (port the depth estimator) and CW-1b `manifold3d` exact-volume tier. See `docs/IMPROVEMENT_PLAN.md` CW-1 / Wave 1.5.
- **Rule fields:** apply the ignored rule fields server-side (IMPROVEMENT_PLAN Wave 0 item 10). The single-model `excludeSelf` trap also exists in the engine's own scope code. Semantic-filter (`relatedPairs`) payload parity is deferred.
- **V7 P1.1 browser half:** consume `/status` `protocolVersion`/`capabilities` (Engine PR #26 added them) instead of the hand-maintained gate. Confirmed that `addons/local-engine.js` doesn't read them yet.
- **V7 P0.6:** the e2e geometry parity fixture is still open (the unit layer is done).

**docs/V7_RELEASE_PLAN.md (see its status table):**
- P0-infra: branch protection (needs a repo admin).
- P2: real IFC corpus (needs licensed files).
- P3: malformed-IFC robustness.
- P4: BCF import fidelity.

**Memory architecture (V7 P6):**
- **P6.2 remaining (~39 `element.meshes[]` sites).** These are mostly not accessor swaps:
  - Rendering-mutation consumers (model diff, GLTF/sidecar export clone, dispose) need a lazy-reconstruction GeometryStore.
  - `_geoSerialize` (dedupes by mesh uuid, local matrix, material colour) risks silent geo-cache corruption and needs a hard-refresh round-trip test.
  - Section-cut generation needs a visual check.
- **Flags:** graduating `storageDetectCaches` needs a real soak and is Safari/FF-only (can't be verified here). `memorySafeLoad` is off.
- **P6.4:** the WASM streaming cursor needs a Rust rebuild.
- **P6.5:** skipped until telemetry exists.
- **Restore heap:** the residual 1.44× restore-vs-fresh-load heap ratio is unexplained (small).
- **Park follow-ups:**
  - Wire `_ccEnsureModelActive` into detection scope (verified: it is defined but has no callers).
  - Persist parked state across reload.
  - Add per-model last-active timestamps.

**Large-model loading / scale:**
- `geoTable` one-object-per-unique-geometry transfer cost.
- Progressive loading and worker backpressure are not built (see the gotchas).
- COOP/COEP plus multithreading (large-model plan Phase 5): needs an audit of ~18 CDN refs and a `vercel.json` headers change.
- IFC worker static-file extraction (see the gotchas).
- `merge_and_post` per-candidate cost (linear; cache per-element material/discipline).
- IMPROVEMENT_PLAN Wave 6 item 3: BVH per unique geometry.
- The 145k-element load still exceeded 240s before protocol v2. Not re-measured at that scale since.

**Reducer decomposition:**
- Next is Area 2 (cache invalidation: `_clearElCaches`, `_bvhLRURemoveModel`, `_pairCacheClearForModel`; risk low).
- The plan's rules require real-browser verification per slice, which is now possible here.
- Only slice 1 is done (`docs/REDUCER_DECOMPOSITION_PLAN.md`).

**BCF:**
- `<ClippingPlanes>` export (also absent in openaec-bcf-platform).
- Camera import: `importBCF` parses no camera data, perspective or ortho.
- Comment threads.
- Cross-tool round-trip validation against Solibri/BIMcollab.

**IDS:**
- Watch `ids-conformance` results and act on `wrong`/`errored`, then promote it to a gate (pin the corpus first).
- IDS Phase 2: extract PredefinedType + Tag in the loader (verified: no `PredefinedType` in `index.html`), dataType checking, and an IfcTester comparison CI.
- IDS Phase 3: IDS authoring tools on `mcp-server.js`.
- `exportIDS` (`addons/data-quality.js`) doesn't emit the RVB checks.

**Feature flags still default-off** (`safety-migrations.js`): `concurrencyV2`, `geoCacheV8`, `batchedSectionsV2`, `rendererV2`, `ccUiWindowedConflicts`, `ccUiEmptyStates`, `ccUiOperationCenter`, `ccUiToolbarV2`, `ccUiModalV2`, `ccUiStoreyChooser`, `storageAutosaveGate`, `storageDetectCaches` and `memorySafeLoad`. Default flips are soak/product decisions. `ccUiStoreyChooser` in particular changes every user's first-load UX.

**Other product gaps:**
- Loading and scoping:
  - IFC-loader structured warnings for skipped/malformed elements.
  - Discipline- or search-set-scoped *loading*.
  - Search set → clash-scope wiring.
- Navigator:
  - Flat cross-model search results.
  - Auto-expand on search.
- Viewer:
  - Wave 2.4: edges + SSAO in normal viewing (high risk).
  - 3D-canvas keyboard accessibility (no keyboard orbit/pan).
- Accessibility addon:
  - Thresholds UI (status unverified).
  - True free-space corridor/turning geometry.
  - Element-to-element clearance check.
- Geo:
  - Auto-align federated models by map conversion.
  - RDNAPTRANS survey-grade grids.
  - Georef fixture: `RefLatitude`/`RefLongitude` come back `null` on both the worker and fallback paths (fixture or `_compoundToDeg` bug, uninvestigated).
- Rules UI: consolidate the scope-picker self-clash control into Off/On-all/On-selected.
- Point-cloud-vs-BIM deviation (`docs/AS_BUILT_DEVIATION.md`) is not built; waiting for go-ahead.

**i18n:**
- Long-tail string sweep (template-literal text inside `html\`` markup that the attribute grep doesn't catch).
- `locales/ja.json` needs a native-speaker review.
- The `contribution:review-passed` label must be created manually in repo settings (status unverified).
- `navigator.language` and model-location auto-suggest are **not built** (verified: no `navigator.language` in `index.html`/`locales/loader.js`). CLAUDE.md's i18n paragraph overstates this.

**Off-repo / housekeeping:**
- Submit the sitemap in Google Search Console.
- Directory listings (AlternativeTo/G2/Capterra).
- Publish the `desktop-v0.1.0` draft release (status unverified).
- Bulk-delete stale remote branches.
- Revit Connector ignores `modelFilter` on export (future scoped re-export).

---

## Active Work

Update this section at the start and end of every session. Mark completed items with
~~strikethrough~~ and the date. Delete struck items older than ~30 days so this file stays small;
anything worth keeping long-term belongs in Known Issues or Architecture Decisions.

- ~~2026-09-28: MEMORY.md condensed and made hand-maintained; removed the daily-sync workflow (`.github/workflows/daily-sync.yml`, `scripts/update-memory.py`) and updated CLAUDE.md's references to it; ran a security pass across GitHub Actions, `sw.js`, `api/*`, `vercel.json`, CSP and Smart Bridge (see Recently completed above); fixed spatial-hierarchy-lost-on-reload (see below) and audited/corrected several CLAUDE.md claims (globals count, theme default, lazy-addon list, bump-version trigger, `index.html` Z-up comment).~~ (2026-09-28)
- ~~2026-09-28: Viewer navigation overhaul (`makeOrbit`, index.html ~9755-10345). Fixed the ~18deg view-jump-on-first-drag bug (rotate now rigidly rotates the camera's true forward vector + position around a freshly-raycast pivot instead of re-deriving orientation from a possibly-stale `target` via lookAt); added damped rotate/pan inertia after release (`orbit.tickInertia`, gated by new "Smooth navigation" pref, default on); reworked wheel zoom to dolly along the cursor ray with an exponential factor (exactly reversible, anchor drift way down); reworked pan to use true pixel-to-world scale at the grabbed point's depth instead of a flat `sph.r*0.0008`; right-drag now pans (Navisworks/Solibri/BIMcollab convention, Ctrl+right-drag still moves an active section plane, plain right-click still opens the context menu); trackpad two-finger scroll now pans instead of zooming (new "Pointer device" Auto/Mouse/Trackpad pref); `autoFlyTo` now defaults off (only double-click flies). New pure math (`_ccRotateAroundAxis`/`_ccOrbitDragStep`/`_ccZoomDollyStep`/`_ccPanWorldPerPixel`, marked `ORBIT_MATH_START/END`) covered by `tests/orbit-math.test.js`. Not done: the item-9 grab-bag of smaller viewer UI bugs (measure-panel coordinate readout, STYLE menu z-order, view-cube visibility/labels, explicit hide/isolate buttons, undo/redo scope, markup persistence, Rendered→Shaded lighting restore, Presentation-mode chrome) — out of scope for this session, listed but not touched.~~ (2026-09-28)
- ~~2026-09-28: NL dispatch-level exactly-once guard + fast IFC pre-parse validation, out of a larger 11-item UX punch list. Done: (1) `processNLCommandWithLLM` is now wrapped by a dispatch-level guard (`_nlDispatchGuard`/`NL_DISPATCH_GUARD_MS`, index.html ~32852) — a duplicate call with the same (raw, replyContext) within 700ms returns the same in-flight/settled promise instead of re-running side effects (dispatches/downloads/fetches), generalizing the ad-hoc `saveProject` debounce that already existed; covered by `tests/nl-dispatch-exactly-once.test.js`. (10) `_ccValidateIfcPreParse` (index.html ~976, wired into `processFiles`'s per-file IFC branch right after the buffer is read, before `loadIFCWorker`) sniffs raw bytes — non-empty, `ISO-10303-21` marker, `HEADER;`/`DATA;` sections, `ENDSEC;`/`END-ISO-10303-21;` at the tail (truncation) — and fails in ~1s with a clear message instead of a multi-minute runaway WASM allocation; also gated the "unload models" memory-warning modal on `s.models.length` so it can't fire with nothing to unload. Covered by `tests/ifc-preparse-validation.test.js`; verified live in headless Chromium (0-byte and garbage-text-renamed-.ifc both now show the specific error within ~1.3s).~~ (2026-09-28)
- ~~2026-09-28: Detection discoverability (item 2) + panel z-index scale/right-panel-default (item 3) from the same punch list. Detection discoverability: `ccUiEmptyStates` promoted to `defaultEnabled:true` (safety-migrations.js) so the empty clash list gets a labelled "Run detection" button by default, desktop+mobile; new `DetectionDiscoverabilityBanner` (index.html, mounted at App level) shows a dismissible "Run clash detection" toast once per model-set after load with nothing run yet, opening the same `A.SHOW_RUN_MODAL` flow as the toolbar button; toolbar Run button gets a visible "Run" text label at >=1100px (`.cc-btn-text-label`) via a new `btn({textLabel})` option. Verified live: 2 clicks from load to a populated clash list (banner → dialog Run button). Panel layering: new z-index scale as CSS custom properties on `:root` (`--z-panel:100/--z-dropdown:400/--z-overlay:800/--z-modal:2000/--z-toast:3000/--z-palette:4000/--z-tooltip:5000`, documented in DESIGN.md §Layers) applied to every page-level zIndex (S_BACKDROP used by all modals, the right AI/Details panel, avatar/STYLE/context/toolbar menus, command palette, toasts, tour/tutorial/memory-warning/Revit-bridge modals); in-canvas-local overlays (viewer chrome, sticky list headers, resize handles) deliberately left alone. Root cause of the reported bug was two-fold: the right panel's raw `zIndex:1100` (now on the panel tier), AND `.cc-desktop-topbar`/`.cc-top-toolbar` each being `position:relative` with their own hardcoded low z-index (10/9), which trapped every menu nested inside them (avatar, STYLE, home-view, +Add) in a low stacking context regardless of that menu's own z-index — both containers raised to the dropdown tier too. Right AI/Details panel now starts closed by default (no stored `cc_ai_panel_collapsed`), still opens on element/clash selection or Details/Ask AI click, remembers the user's choice. Verified live in headless Chromium at 1440x900/820x1180/390x844 (avatar menu opens and Settings is clickable through to the Settings modal; Run-detection dialog's Run/✕ fully visible at 820px; command palette renders over everything). Tests: `tests/detection-discoverability.test.js`, `tests/z-index-scale.test.js` (new), `tests/safety-migrations.test.js` updated for the promoted flag. **Not done** (explicitly out of scope this session): items 4-9 and 11 of the original punch list — issue editing (title/priority/description/due-date/comments/attach-viewpoint/delete), Present-tab property panel parity + breadcrumb, discipline chip + classifier improvements, command palette Enter-ranking/Ask-AI query passthrough/theme sync, mobile Ask-AI reachability + badge/header spacing + post-sheet focus + model-fit, AI-titles error toast + storey-filter-from-chat + offline "what is this?" + user-facing chat wording, and data-quality active-language-only dedup + neutral "not applicable" styling + malformed-IDS error. All gates green at handoff: `node --test tests/*.test.js` (990/990, incl. in a clean detached worktree without node_modules), `npm run lint:inline` (0 errors), `smoke.mjs`/`office-clash-parity.mjs`/`windowed-list-scroll-memo.mjs` all green.~~ (2026-09-28)
- 2026-09-28: NL dispatch-level exactly-once guard + fast IFC pre-parse validation, out of a larger 11-item UX punch list. Done: (1) `processNLCommandWithLLM` is now wrapped by a dispatch-level guard (`_nlDispatchGuard`/`NL_DISPATCH_GUARD_MS`, index.html ~32852) — a duplicate call with the same (raw, replyContext) within 700ms returns the same in-flight/settled promise instead of re-running side effects (dispatches/downloads/fetches), generalizing the ad-hoc `saveProject` debounce that already existed; covered by `tests/nl-dispatch-exactly-once.test.js`. (10) `_ccValidateIfcPreParse` (index.html ~976, wired into `processFiles`'s per-file IFC branch right after the buffer is read, before `loadIFCWorker`) sniffs raw bytes — non-empty, `ISO-10303-21` marker, `HEADER;`/`DATA;` sections, `ENDSEC;`/`END-ISO-10303-21;` at the tail (truncation) — and fails in ~1s with a clear message instead of a multi-minute runaway WASM allocation; also gated the "unload models" memory-warning modal on `s.models.length` so it can't fire with nothing to unload. Covered by `tests/ifc-preparse-validation.test.js`; verified live in headless Chromium (0-byte and garbage-text-renamed-.ifc both now show the specific error within ~1.3s). **Not done** (explicitly out of scope this session, budget-limited): items 2-9 and 11 of the punch list — detection discoverability CTA, panel z-index scale + right-panel-closed-by-default, issue editing (title/priority/description/due-date/comments/attach-viewpoint/delete), Present-tab property panel parity + breadcrumb, discipline chip + classifier improvements, command palette Enter-ranking/Ask-AI query passthrough/theme sync, mobile Ask-AI reachability + badge/header spacing + post-sheet focus + model-fit, AI-titles error toast + storey-filter-from-chat + offline "what is this?" + user-facing chat wording, and data-quality active-language-only dedup + neutral "not applicable" styling + malformed-IDS error. All gates green at handoff: `node --test tests/*.test.js` (966/966), `npm run lint:inline` (0 errors), `smoke.mjs`/`office-clash-parity.mjs`/`windowed-list-scroll-memo.mjs` all green.
- ~~2026-09-28: Accessibility/terminology/onboarding pass — four independent fixes. (1) Contrast: fixed at the token level (`--text-muted`/`--text-faint` re-tuned for both themes, new `--accent-contrast`/`--progress-good/warn/bad` tokens, `STAT` status-pill object given real fg/tintBg pairs instead of rendering the same hex as text-on-tint-of-itself, discipline chip de-hexed); added a `<main>` landmark; raised sub-11px text in `IssueRow`/cluster-card header to `--text-xs`. Axe-core (wcag2aa color-contrast + landmark-one-main) verified 0 serious violations on landing, clash list (light+dark), issues panel (light+dark), settings (light+dark) — was up to 42 nodes/screen. (2) Terminology: "Conflicts"→"Clashes" in remaining user-facing strings (panel title, mobile nav, banner, empty states, cmdk, toolbar); i18n keys/ja.json untouched (already consistent). (3) Guided tour: `TOUR_STEPS` rebuilt (0/7 targets existed → 7/7 real `data-tour` selectors with `onEnter(d)` workspace/tab switching); welcome popup's "Take the tour" now launches the in-app tour first, `/tour/` kept as a secondary link; added a ⌘K "Start tour" command. New `tests/tour-selectors-wiring.test.js`. (4) Help consistency: Quick Start Guide's shortcut cheat-sheet now reads from the same `_ccShortcutSections()`/`_ccShortcutRow()` the "?" ShortcutsModal uses (was contradicting it — wrong "1-4 switch panels"/"F finds elements" claims). New `tests/quickstart-shortcuts-consistency.test.js`. Gates green: `node --test tests/*.test.js` 1033/1033 (also in a clean detached worktree without `node_modules`), `npm run lint:inline` 0 errors, `smoke.mjs`/`office-clash-parity.mjs` (56 hard clashes, unchanged)/`windowed-list-scroll-memo.mjs` all green.~~ (2026-09-28)
- ~~2026-09-28: Three more items off the same punch list — issue editing, Present/Coordinate/Review property parity, discipline chip + classifier fix. Issue editing: `A.DEL_ISSUE` reducer case (clears `clash.linkedIssueId`, linked viewpoints, `activeId`/`selected`; changelog `issue_deleted`; shared-project sync gets a matching `_sharedDeleteIssue` via `DELETE /api/project?issue=<id>`, same editKey gate as the existing whole-project delete); new `IssueDetailEditor` component (index.html, next to `IssueRow`) adds editable title/priority/description/due-date, a per-issue `it.comments[]` thread (author = `_ccChangelogUser`, add/delete own comment) and "Attach current view" (`_captureViewpoint` + `ADD_VIEWPOINT`, `linkedId`) — all through the existing `UPD_ISSUE` action so shared sync/changelog need no new wiring. BCF `<Comment>` elements now export/import (markup-level siblings of `<Topic>`, recovered via `Markup > Comment`). "+ From clash" was reading `s.activeId`, which the Issues tab's auto-select-first-issue effect clobbers the moment you open Issues with nothing already active; reducer now tracks `s.lastActiveClashId` separately on every `A.ACTIVE` dispatch and the button falls back to it. Properties everywhere: Present/Coordinate/Review (the per-element Details drawer, index.html ~36850-37340) all now show GlobalId+copy and the Project›Site›Building›Storey breadcrumb; Present keeps them (and the full per-Pset dump) collapsed by default via `<details>`, Coordinate gained the full Property Sets card it was missing (previously only Review had it). Discipline: a small chip (colored by `DISC`) on every model row, always visible, opens the discipline `<select>` on click — was previously only reachable by expanding the row. `clash-discipline-core.js`'s `detectDiscipline` now checks file-name hints (word-*prefix* match, not anywhere-substring) *before* the element-class ratio instead of after — this was the actual cause of "Architecture.ifc classified as structural, Walls-vs-MEP finds 0 silently"; extended `tests/clash-discipline-core.test.js`'s reference oracle to match + added fixture-name regression tests using the repo's own `office-architecture.ifc`/`office-mep.ifc`. Also added a Quick Run preset inline warning (`_ccPresetMissingDisciplines`) when a preset's `disc:X` filter matches no loaded, visible model. Verified with a scratch Playwright script (outside the repo) driving the real office fixtures end-to-end: title edit, comment add, Attach current view, Delete issue (+ cleanup asserted), the preset warning firing/clearing, and GlobalId/breadcrumb/psets present in all three workspaces. Gates green: `node --test tests/*.test.js` 982/982 (also in a clean detached worktree with no `node_modules`), `npm run lint:inline` 0 errors, `smoke.mjs`/`office-clash-parity.mjs` (56 hard clashes, unchanged)/`windowed-list-scroll-memo.mjs` all green.~~ (2026-09-28)
- ~~2026-09-28: Fixed the 2D floor plan (FLOOR_PLAN, top-down 3D ortho camera, index.html ~16600-16825) rendering as a flat grey slab — cut walls had the same colour/flat top lighting as the floor below, no cut outlines/poché, and the right Details panel covered part of the frame. Reused the existing polygon-face section-cut code (`generate2DOutlines`/`_cutElementAtPlane`, the same code the 2D sheet uses) instead of a new slicer: `_chainSegments` gained a `noMirror` param (new `_ccChainSegmentsWorld` wrapper, index.html ~32439) so the same chained polygons project through the live 3D camera; new `_ccDrawPlanOverlay` (~32512) draws them onto a 2D `<canvas>` overlay (`planOverlayRef`, `S._floorPlanOverlayCanvas`) every render tick, from chains cached once per storey/cut-height change in a new App-level effect (`window._ccPlanChainsWorld`, ~40899) — dark outlines + poché fill for closed wall/structure loops, lighter fill for openings/MEP/furniture. Below-cut geometry now renders through one shared, fully unlit flat-grey `MeshBasicMaterial` while floorPlan is active (new `isPlan` branch in the render-style effect, ~17007-17252), instead of whatever lit renderStyle was active — that's what made cut and floor read the same flat grey. Camera framing (~16744-16822) now fits the storey's own elements' bbox (not the whole federated model) and biases the frustum center via the camera's own right/up axes so the storey lands in the area actually left visible by the right Details panel (`window._ccRightPanelOpenWidth`) and the top toolbar/floor-popover chrome, both of which overlay the viewport without shrinking it. Verified with a scratch Playwright script (outside the repo) against `office-architecture.ifc`+`office-mep.ifc`: all 3 storeys show clear dark outlines (exterior walls, the "Corridor wall" fixture element, columns) on a light background — ~12.2k dark pixels (~1.55% of the visible model area; low because this fixture's walls chain into open polylines not closed loops, identical to the pre-existing unmodified 2D sheet on the same fixture, confirmed by a side-by-side screenshot — not a regression); whole storey framed inside the panel-free area with the Details panel open; exit restores the exact prior perspective camera (position/target/projection). Gates green: `node --test tests/*.test.js` 1025/1025 (also in a clean detached worktree with no `node_modules`), `npm run lint:inline` 0 errors, `smoke.mjs`/`office-clash-parity.mjs` (56 hard clashes, unchanged)/`windowed-list-scroll-memo.mjs` all green. Not done: no new unit test was added for the frustum-fit math itself (verified only via the live screenshot script) — a follow-up could extract `_ccChainSegmentsWorld`'s adjacency math or the frustum-bias formula into a pure-function unit test.~~ (2026-09-28)
