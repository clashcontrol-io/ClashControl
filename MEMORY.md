# ClashControl — Shared Session Memory

> **Hand-maintained** (the daily auto-sync was removed 2026-09-28). Read this first so you
> don't re-implement things or repeat past mistakes. Keep it short: update **Active Work** at
> the start/end of a session and add a line or two to **Recently completed** — details belong
> in commit messages and PRs. `git show 0f08459:MEMORY.md` has the last pre-condense version.

---

## Project State

**Version:** 7.6.0 (`version.json`; bumped by the `version-bump.yml` CI job on pushes to `main`).
`index.html` is ~43k lines (check with `wc -l`).

**Live features:**
- **Clash engine:** AABB broad phase (JS or Rust/WASM sweep) → BVH + Möller tri-tri narrow phase, run on JS, stateless WASM, a stateful WASM `Engine` with cached per-element BVHs (`window._ccWasmEngine`) or a Web Worker pool (`_ccNarrowPool`, flag `detectWorkerPool`; engages on large clearance-heavy runs); in the Tauri desktop app a multi-core native Rust engine (`addons/tauri-bridge.js` → `window._ccNativeNarrow`, self-checked before use) — all proven identical. Clearance is true mesh distance (point-triangle + edge-edge; 0 for intersecting/contained meshes). Hard clashes get an approximate penetration depth. Default clash matrix; rules (discipline filters, `[minGap,maxGap]`, tolerances); smart re-runs by default; provision-for-void (openings) classification; role-aware deterministic severity; specific clash titles. Optional local Python engine (same algorithm, native speed).
- **Clash review:** grouped by root-cause element, compact rows, cluster cards, J/K/C/D/V triage, A/B colours, assignment rules, issue editing (title/priority/description/due date/comments/viewpoints), unified undo/redo.
- **BCF 2.1/3.0:** Z-up cameras (export + import), stable GUIDs, components/selection/visibility/coloring, comments, orthographic viewpoints. Print-to-PDF clash and data-quality reports.
- **IFC loading:** web-ifc 0.0.77 in a worker (protocol v2) with a main-thread fallback; fast pre-parse validation; storey-scoped loading (`ccUiStoreyChooser`, off by default); Park/Restore; opening boxes per host element (`props.openings`).
- **Viewer:** Three.js r180 ESM; cursor-pivot orbit (no inertia — removed 2026-09-29, the camera stops when the gesture stops), zoom-to-cursor, 1:1 pan; BatchedMesh for pathological models; 2D floor plan with poché and closed section loops; sheet view.
- **Data Quality addon:** BIM basics, ILS v2 / NL-SfB (applicability-gated), RVB, IDS 1.0 engine. **Accessibility** and **visibility** addons.
- **Geo:** IfcSite/IfcMapConversion placement, proj4 reprojection, 3D Tiles, basemap, point clouds, splats, 3-point alignment.
- **Navigator:** search, model-scoped selection sets (with a resolver for legacy ambiguous entries), search sets, property diff, breadcrumb.
- **AI / integrations:** Groq NL (`/api/nl`, deliberately basic) + own-LLM Smart Bridge Connector (MCP/REST); Revit connector; OpenAEC bridge.
- **Collaboration:** shared projects (Neon, CAS PUT, `conflicts[]`, edit-key-gated DELETE), folder sync.
- **Other:** walk mode, section planes/box, PWA, i18n (`_cc_t`, `locales/ja.json`, browser-language auto-detect that is never persisted), regulation packs (manifest intentionally empty), WCAG-AA tokens (axe: 0 violations light/dark/mobile on the main screens).

**Addons (`addons/`):** accessibility, align, data-quality, geoplace, local-engine, openaec-bridge, pointcloud, pwa, revit-bridge, shared-project, smart-bridge, splat, tiles, tauri-bridge (desktop only, inert in the browser), training-data, visibility, wasm-engine (+ `wasm-engine-pkg/`).

**Non-addon core modules** (plain `<script defer>`, required, all `// @ts-check`): `cc-runtime.js`, `safety-migrations.js`, `storage-core.js`, `clash-{discipline,assignment,identity,reconciliation,classification}-core.js`, `project-codec.js`, `section-clipping.js`, `renderer-contract.js`, `analytics-consent.js`.

**Backend (`api/`):** `nl` (Groq), `title`/`triage` (Gemma), `project`, `training`, `health`, `tile`, `_lib.js`, `schema.sql`. **Deployment:** Vercel, `www.clashcontrol.io`, no COOP/COEP; `.vercelignore` keeps docs/tests/engine/desktop sources out of the deploy.

**CI (`.github/workflows/`):** `ci.yml` (node tests, lint-inline, typecheck, browser-smoke, browser-differential incl. office-clash-parity), `version-bump.yml`, `sri-check.yml`, `ids-conformance.yml` (weekly, non-blocking), `contribute-pack.yml`, `release-desktop.yml`, `release-smart-bridge.yml`.

**Plan docs (`docs/`):** IMPROVEMENT_PLAN, V7_RELEASE_PLAN, REDUCER_DECOMPOSITION_PLAN, AS_BUILT_DEVIATION, TAURI, INTERNALS (§22 port registry), PERFORMANCE_NOTES; `tests/fixtures/CORPUS_MANIFEST.md`.

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
| 2026-09-28 | WASM narrow phase is a bit-identical port of the JS reference (f64 op-for-op, same BVH split/sort keys, same collect cap); a runtime self-check gates publishing it | "Accelerated" must never mean "different answer"; drift is a regression (`tests/wasm-parity.test.js`) |
| 2026-09-29 | Stateful WASM `Engine` (per-element cached BVHs) + Web Worker narrow-phase pool (`detectWorkerPool` flag, default on, auto-fallback) | Speed without a second algorithm: every path (JS / WASM / Engine / pool) is proven identical, ordered, field-for-field |
| 2026-09-29 | Smart re-runs are the default: run signature + per-element content hash + immutable per-pair snapshots; unchanged pairs are carried, not recomputed (`rules.fullRerun` forces a full run) | Re-checking after a small edit shouldn't re-test the whole federation; the result must equal a full run (browser-tested) |
| 2026-09-29 | Clashes through IfcOpeningElement voids are classified (`opening:'provided'`/`'partial'`); provided ones are hidden by default behind a count, never dropped | Provision-for-void is coordination, not a clash; nothing silently disappears |
| 2026-09-29 | Clash titles, role-aware severity and opening classification live in `clash-classification-core.js`, shared by the browser and local engines | One implementation per rule, so both engines label the same pair identically |

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
- **Z-index:** use the scale in DESIGN.md §Layers (`--z-panel` 100 … `--z-tooltip` 5000). `.cc-desktop-topbar`/`.cc-top-toolbar` are their own stacking contexts on the dropdown tier — a menu nested in them can't rise above that tier.
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
- **Scoring:** ILS counts toward the headline Quality Score only when ≥20% of elements carry an NL-SfB code (`ilsNlsfbAdopted`); the Data Quality panel additionally treats ILS as applicable when a model's IfcSite is in NL or the regulation region is NL (`window._ccIlsApplicability`). RVB never counts toward the headline.
- **IDS honesty rule:** anything the engine can't evaluate (PredefinedType, non-storey partOf, dataType, unsupported regex) is reported "not checkable" and never counted as a pass.
- **Candidates:** the Wasm sweep returns a compact view (`_makeCompactCandidates`, read through `_candidateAt`). The JS `_sweepAndPrune` still returns an eager array as the oracle, so callers must go through `_candidateAt`.
- **WASM narrow-phase parity:** `addons/wasm-engine-pkg/` is bit-identical to the JS reference (`_triTriTest`/`_buildBVHNode`/`_bvhTraverseAll`/`_meshMinDist`) on hit/no-hit, every raw point, depth and min-distance — `tests/wasm-parity.test.js` plus a runtime self-check before the addon publishes. The same holds for the cached `Engine` and the worker pool (`tests/browser/office-clash-parity.mjs` compares js/wasm/engine/pool-wasm/pool-js ordered, field-for-field). BVH split keys (axis extents, centroid sums) must be f64 like JS — f32 gave a different tree on dense meshes (fixed 2026-09-29). Any drift is a regression.

### Local engine (Python, `ClashControlEngine` repo)
- The engine returns `distance` in **mm**; don't multiply by 1000 again (fixed 2026-07-21). `maxGap`/`minGap` are also mm on the wire.
- **Rule fields the engine ignores server-side:** `excludeTypes`, `excludeTypePairs`, `toleranceByTypePair`, `duplicates`, `excludeSelf` and `minOverlapVolM3`.
  - `_applyClientSideRuleFilters` re-applies them.
  - `window._ccLocalEngineCanHandle` fails closed: `changeAware`, per-pair tolerance > maxGap, semantic filter, or a non-'all'/single scope → run in the browser.
  - The gate is a **hand-maintained snapshot**; keep it in sync with the Engine repo.
- **Distance/depth parity:** ClashControlEngine PR #28 ports the browser's edge-edge + 0-on-intersect/contained clearance and vertex-inside depth (`depth_semantics` per clash). Same algorithm, not bit-identical (numpy vs f64 JS).

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
- **The old `_pairResultCache` LRU is gone** (it stored objects later mutated by merge/classify). Smart re-runs use the run memo (`_ccRunMemo`: signature + element hashes + snapshots); committed only by a complete run, cleared on model delete/replace, project switch and local-engine runs. `rules.changeAware` is a no-op legacy key. The `TRAINING_MODE` localStorage value stays in its raw `'1'`/`'0'` format.
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
  - The proxy blocks the CDNs. Run with `CC_BROWSER_OFFLINE_DEPS=1` (serves React/Three/JSZip/pdf.js/web-ifc from npm packages) and `CC_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`.
  - **`npm install` prunes `--no-save` packages.** Install the offline deps in ONE command: `npm install --no-save playwright@1 react@18.2.0 react-dom@18.2.0 jszip@3.10.1 pdfjs-dist@3.11.174 three@0.180.0 web-ifc@0.0.77 axe-core@4 typescript@6 @types/node@22`.
  - Agent worktrees share the repo's git stash — never use a bare `git stash` in parallel work.
  - Only Chromium is installed (no Firefox/WebKit), so Safari/Firefox-only logic can't be verified.
  - Real-browser checks: `node tests/browser/smoke.mjs` plus the other `tests/browser/*.mjs`. Unit tests: `npm test` (`node --test`).
  - `npm run lint:inline` runs `scripts/lint-inline.js` (extracts the main inline `<script>`, preserving line numbers) through ESLint 9 — CI job `lint-inline`; 0 errors and 0 warnings expected (every exhaustive-deps suppression carries a reason, enforced by `tests/hooks-stale-closures.test.js`). `npm run typecheck` = `// @ts-check` over the standalone modules (CI job `typecheck`).
- **`ci.yml` only fires for PRs whose base is `main`.** Stacked PRs get no CI until they're retargeted. `pull_request: synchronize` events have also stalled on open PRs (they were nudged with empty commits); if it recurs, the GitHub App permissions/webhook may need a maintainer. Before assuming a flake, check whether the PR was already merged.
- **Poll GitHub via the authenticated MCP.** The anonymous API limit is 60/h. WebFetch of GitHub `/tree/<branch>/<path>` 404s; fetch `raw.githubusercontent.com` file paths directly.
- **`ids-conformance.yml`** is still `continue-on-error: true` and fetches the corpus at `development` HEAD. **Pin the corpus commit before making it a required check.**
- **All workflows run Node 22.** The ESM wasm-pack output (`addons/wasm-engine-pkg/`) can't be `import()`ed by Node 18 (`Unexpected token 'export'`); `release-smart-bridge.yml` sat on Node 18 and failed `npm test` on every run 2026-07-08 → 2026-09-29, blocking bridge releases (fixed: Node 22 + `node22-*` pkg targets — `@yao-pkg/pkg` 6.x has no prebuilt node18 base and would compile Node from source). That workflow auto-releases on every run, so don't add paths to its trigger casually.
- **Service worker:** it excludes `/api/*` (don't cache API paths) and is network-first for navigations, so static SEO pages aren't hijacked. The `/tour/` hand-off uses IndexedDB `cc-handoff` → `/?load=1`.
- **Tool catalog:** the single source of truth is the addon `_TOOL_MANIFEST`. `mcp-server.js` fetches `GET /tools` from the bridge and falls back to its static `TOOLS` only before a browser connects. The tool count is regression-checked (`tests/doc-tool-count.test.js`).
- **Own-LLM access:** the https app can't reach `localhost` LLMs directly (mixed content/CORS), so a local LLM needs the native bridge.
- **NL pre-block:** don't make it over-eager; conversational text must reach Groq.
- **2D annotation coordinates** were fixed in v4.15.4. Re-test the transform carefully if you re-implement annotation rendering.
- **Hidden control characters:** if `Edit` refuses an exact match on text you just read, suspect a hidden control byte. Check with `cat -A`/`od -c`, then fix it with a `node -e` split/join.
- **Checks before refactors:** grep for an existing helper before adding a new file or abstraction. Twice now a "new" module duplicated an existing helper (`_ccPersistUI`).

---

## Recently completed (details in git history)
- 2026-07 (Waves 0–5, V7 P0–P6 slices, i18n infra, storage campaign, IFC worker protocol v2): see `git show 0f08459:MEMORY.md`.
- **2026-09-28 — PR #712** (review + human walkthrough): bit-identical WASM narrow phase; true mesh clearance; reconciliation, project-restore, cross-model `expressId` scoping, shared-sync and BCF fixes; security pass; lint CI job; keyboard/a11y/viewer/floor-plan/clash-list overhaul; daily memory sync removed.
- **2026-09-29:** cached-BVH WASM `Engine` + worker-pool narrow phase + f64 BVH split parity fix; openings, role-aware severity, smart re-runs by default, specific clash titles; `// @ts-check` + typecheck CI; exhaustive-deps 116→0 (7 real stale-closure bugs fixed); design-token pass (0 axe violations); locale auto-detect + saved-pack loading; legacy selection-set resolver; ILS applicability gating; NL Ctrl+/ state fix; Python engine distance/depth parity (ClashControlEngine PR #28); native Rust narrow phase in the Tauri desktop app (`native` cargo feature, rayon `NativeEngine`, raw-byte IPC commands, allow-listed capability).

---

## Open / deferred items

**Local engine / `ClashControlEngine` repo:**
- CW-1b `manifold3d` exact-volume tier. Server-side application of the ignored rule fields (`excludeTypes`, `excludeTypePairs`, `toleranceByTypePair`, `duplicates`, `excludeSelf`, `minOverlapVolM3`); semantic-filter payload parity.
- V7 P1.1: consume `/status` `protocolVersion`/`capabilities` instead of the hand-maintained gate. V7 P0.6 e2e geometry parity fixture.

**docs/V7_RELEASE_PLAN.md:** branch protection (repo admin), real IFC corpus (licensed files), malformed-IFC robustness, BCF import fidelity.

**Memory architecture (V7 P6):** ~39 remaining `element.meshes[]` consumers (a GeometryStore is needed for diff/export/dispose; `_geoSerialize` needs a round-trip test); `storageDetectCaches` soak (Safari/FF); `memorySafeLoad` off; P6.4 WASM streaming cursor; wire `_ccEnsureModelActive` into detection scope (still no callers); persist parked state; residual 1.44× restore heap ratio.

**Scale:** `geoTable` transfer cost; progressive loading / worker backpressure (deliberately not built); COOP/COEP + multithreaded WASM (needs a CDN audit); IFC worker static-file extraction; BVH per unique geometry; re-measure the 145k-element load. The worker pool's real multi-core speed-up hasn't been measured (this sandbox is contended).

**Clashes:** opening data is missing from geo caches written before 2026-09-29 (re-import to get it); keyboard deny-next can still land on a hidden provided-opening clash; legacy clashes without `_sevSource` keep their stored severity.

**Reducer decomposition:** only slice 1 done; next is Area 2 (cache invalidation).

**BCF:** `<ClippingPlanes>` export; cross-tool round-trip validation (Solibri/BIMcollab).

**IDS:** act on `ids-conformance` results, then pin the corpus and make it a gate; Phase 2 (PredefinedType/Tag extraction, dataType, IfcTester CI); Phase 3 authoring on `mcp-server.js`; `exportIDS` lacks the RVB checks.

**Feature flags still default-off** (`safety-migrations.js`): `concurrencyV2`, `geoCacheV8`, `batchedSectionsV2`, `rendererV2`, `ccUiWindowedConflicts`, `ccUiOperationCenter`, `ccUiToolbarV2`, `ccUiModalV2`, `ccUiStoreyChooser`, `storageAutosaveGate`, `storageDetectCaches`, `memorySafeLoad`. Default flips are soak/product decisions.

**Product gaps:** IFC-loader structured warnings; discipline/search-set scoped loading; search set → clash scope; flat cross-model navigator search; edges + SSAO (high risk); 3D-canvas keyboard navigation; accessibility thresholds UI / free-space geometry; auto-align federated models; RDNAPTRANS grids; the georef fixture returns null RefLatitude/Longitude (uninvestigated); scope-picker self-clash control; point-cloud-vs-BIM deviation (awaiting go-ahead).

**i18n:** long-tail string sweep; `ja.json` native-speaker review; `contribution:review-passed` label (unverified); model-location regulation auto-suggest.

**Desktop (Tauri):** native engine not yet benchmarked on a real 10k+ element federation (TAURI.md Phase 2 exit criterion); only Linux WebKitGTK verified; `release-desktop.yml` doesn't run the desktop cargo tests; triangles are duplicated in Rust memory (registry resets above ~384 MB).

**Off-repo:** Search Console sitemap; directory listings; publish `desktop-v0.1.0` (unverified); stale remote branches; Revit Connector `modelFilter`.

---

## Active Work

Update at the start and end of every session; strike (~~…~~ + date) when done and delete struck items after ~30 days.

- ~~2026-09-29: modernisation plan items 2–4 + memory cleanup on `claude/pensive-faraday-v6t6wh` (engine/worker/native perf, smarter clashes, UI/a11y/lint leftovers); PR + merge; ClashControlEngine PR #28.~~ (2026-09-29)
