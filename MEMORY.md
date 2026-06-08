# ClashControl — Shared Session Memory

> Auto-updated daily by `.github/workflows/daily-sync.yml`.
> **Every new Claude session should read this file first** to avoid re-implementing things,
> repeating past mistakes, or working against current direction.
> Update the Active Work and Project State sections as you make progress.

---

<!-- BEGIN:project-state -->
## Project State

**Version:** 5.17.4 (2026-06-07)

**Live features (all working):**
- Mesh-based clash detection engine: AABB broad-phase + BVH tri-tri narrow-phase (Möller–Trumbore), optional `_ccWasmIntersect`/`_ccWasmMinDist` WASM accelerators; rules (discipline filters, clearance, group-by); soft/clearance via spatial-hash vertex distance; optional escalation to `local-engine.js` for true solid boolean ops
- BCF 2.1 import/export (viewpoints, markup, snapshots)
- IFC loading via web-ifc WASM (lazy, with geometry + property extraction)
- AI NL command interface (Gemma 4 via `/api/nl`, 13 tool declarations, native function calling)
- Shared projects (no login, project keys, Neon Postgres backend)
- Data quality checks addon (BIM basics, ILS, NL-SfB classification)
- Smart Bridge: MCP server (`mcp-server.js`) for IDE/AI tool integration
- Revit connector addon (WebSocket live sync, clash push-back)
- Walk mode (FPS navigation with eye height, FOV scroll, unit-aware speed)
- 2D sheet view (Revit-style floor plan: polygon chaining, SVG export, paper size/scale settings)
- Section planes + section box (interactive clipping)
- Issues panel (status, priority, assignee, PDF overlay, viewpoints)
- Training data addon (ring-buffer, JSONL export, sharing)
- PWA (service worker, install prompt, offline caching)
- IDS format export/import for data quality checks
- Shift+click multi-select in navigator tree
- Color-grade FPS counter (grey→red based on framerate)
- Render style hotkeys 1–4 (standard/shaded/rendered/wireframe)

**Backend (Vercel serverless + Neon Postgres):**
- `/api/nl` — Gemma 4 NL proxy (SMART_MODEL for analytical, FAST_MODEL for everything else)
- `/api/title` — batch AI clash title generation
- `/api/project` — shared issue sync
- `/api/training` — training data ingestion
- `/api/health` — AI + DB status

**Deployment:** `www.clashcontrol.io` on Vercel. No CI/CD for the frontend — merging to `main` triggers a version bump workflow only.
<!-- END:project-state -->

<!-- BEGIN:architecture-decisions -->
## Architecture Decisions

These are permanent. Do not remove entries — add new ones when significant decisions are made.

| Date | Decision | Reason |
|------|----------|--------|
| founding | Single `index.html` app, no build step | Zero setup for users; open-source transparency; easy to fork/inspect |
| founding | Three.js r128 (pinned, not latest) | API stability; newer versions break existing render/material code |
| founding | In-browser clash engine: AABB broad-phase + BVH tri-tri narrow-phase (legacy name "OBB engine" is a simplification — orientation only enters via the slimline-axis prune for directional elements). `_ccWasmIntersect`/`_ccWasmMinDist` accelerate when loaded. Optional `local-engine.js` addon escalates to true solid boolean ops on a localhost Python server. | Tri-tri is the browser sweet spot: tighter than AABB-only (kills false positives on rotated beams/pipes), fast enough for thousands of pairs in JS, and has a clean WASM acceleration path. True solid boolean ops are too slow in JS so they live in the Python local engine. |
| founding | CDN deps pinned with SRI hashes | Reproducible builds; integrity verification |
| founding | Addons pattern (`addons/*.js` IIFE) | Keeps `index.html` lean; optional features don't block initial load |
| founding | Preact/React via CDN UMD (not ESM) | Avoids bundler; works with htm tagged templates inline |
| founding | htm instead of JSX | No transpilation; hand-written parser inlined in the file |
| 2026-04-10 | Stripped ~1960 what-comments from index.html | Comments explained what, not why; moved to INTERNALS.md; reduces file size |
| 2026-04-10 | Camera globals consolidated into `_ccViewport` | Single source of truth for camera/canvas state; avoids global variable sprawl |
| 2026-04-10 | View cube uses `camera.quaternion.copy().invert()` | Camera-position approach causes left/right mirroring; quaternion inversion is correct |
| 2026-04-13 | `processNLCommandWithLLM` wraps `/smart` command | Ensures async handling; keeps NL pipeline consistent |
| 2026-04-15 | 2D sheet uses polygon-face section cut | Correct floor-plan geometry without full mesh boolean ops |
<!-- END:architecture-decisions -->

<!-- BEGIN:known-issues -->
## Known Issues & Gotchas

Things to be careful about. Do not remove without a good reason — add a note if something is fixed.

- **Three.js r128 API**: Use r128 docs. `BufferGeometry.setAttribute`, not `addAttribute`. `MeshStandardMaterial` not `MeshPhysicalMaterial` for standard use.
- **View cube mirroring**: The nav cube MUST use `cubeGroup.quaternion.copy(camera.quaternion).invert()`. Camera-position approach causes left/right mirror. Don't "fix" this.
- **web-ifc WASM hang**: A 10-second timeout detects WASM init hangs (slow connections). Don't remove this guard.
- **IFC unit scale**: Storey elevations from IFC are often in mm; geometry is in metres. Always apply `geoFactor` when converting. Walk mode and 2D sheet have fixed this.
- **Ghost material is shared**: `MeshBasicMaterial({color:0x334155, opacity:0.08})` is one instance shared across all ghost meshes. Don't dispose it per-mesh.
- **`invalidate()` required**: Any visual change (material swap, visibility, highlight, grid, ghost) needs `invalidate()` or it won't render until the next interaction.
- **Render loop skips GPU work**: `_needsRender` counter > 0 means render. Counter decrements each frame. Call `invalidate(N)` for N frames of rendering.
- **Addon guard required**: Core code calling addon functions must guard with `typeof window._ccFoo === 'function'`. The app must work without addons.
- **Service worker excludes `/api/*`**: Don't add API paths to the SW cache list.
- **NL pre-block**: Conversational messages that look like commands are allowed through to Gemma. Don't make the pre-block over-eager.
- **2D annotation coordinates**: Fixed in v4.15.4. Coordinate bug was in annotation placement — if re-implementing annotation rendering, test coordinate transform carefully.
- **IFC spatial hierarchy is NOT a clash-pruning filter**: `IfcProject → IfcSite → IfcBuilding → IfcBuildingStorey → IfcSpace` is logical containment, not proximity. Real geometry spans containment boundaries (vertical ducts cross storeys, foundations sit between site and building, stairs intersect two slabs). Pair pruning must come from the AABB broad-phase / spatial index, not from shared spatial parent. Don't be tempted to "speed up" detection by filtering pairs that share an IfcBuildingStorey only.
<!-- END:known-issues -->

<!-- BEGIN:active-work -->
## Active Work

Update this section at the start and end of each session.
Mark completed items with ~~strikethrough~~ and date, then let the daily sync archive them.

On branch `claude/screenshot-clashcontrol-review-tiHAk` (2026-06-08) — Tiered AI (Groq basic + own-LLM Connector) + IFC-viewer/Solibri SEO:

- **Bridge simplified to zero-key:** dropped the API-key cloud presets I'd briefly added. Built-in chat now offers only one-click local autodetect (Ollama/LM Studio/llama.cpp/Jan) + the existing "Configure Claude" (Claude Desktop app, no key). Rationale: user said API keys are "outdated and too difficult."
- **`/api/nl` is now Groq-ONLY** (`api/nl.js`): Gemma/Gemini fallback chain **removed** (user: "drop Gemma"). POST Groq `/openai/v1/chat/completions` with `TOOLS` mapped to OpenAI `tools` format, parse `tool_calls` → identical `{intent,...params}` contract. Default `llama-3.3-70b-versatile` (`GROQ_MODEL` overridable). On 429/down → 503/429 → client uses offline regex. `GEMINI_API_KEY` still used by `/api/title` + `/api/triage` only. Verified: success→intent, 429→quota_exceeded, no-key→503 (mocked-fetch handler tests). **User must set `GROQ_API_KEY` in Vercel.**
- **Tiered AI / nudge in Ask AI** (`index.html`): the built-in assistant (Groq) is deliberately BASIC. When a command matches resolution-verb + clash-noun (`_solveRx`+`_aboutClash`), it routes to the user's own LLM via the Connector (`127.0.0.1:19803/chat`) if connected, else shows a one-click-connect **nudge** (warm-up → bring-your-own-LLM / future paid tier). Also: on server failure, the `.catch` falls back to the connected own-LLM; over-quota message points to the Connector. Regex validated on 9 cases (find/show clashes = basic; resolve/fix clash = nudge).
- **SEO** (`index.html` head, `manifest.json`, `README.md`, `llms.txt`, `sitemap.xml`, new `free-solibri-alternative/index.html`): lead with "online IFC viewer", position as free Solibri/Navisworks alternative; added homepage `FAQPage` schema (Google rich results + LLM answer engines), `alternateName`/`keywords`/fuller `featureList` on `SoftwareApplication`.
- **Verify on Vercel preview** (not browser-tested here): main inline script parses; `api/nl.js` Groq path unit-tested with mocked fetch; JSON-LD blocks validated.

On branch `claude/screenshot-clashcontrol-review-tiHAk` (2026-06-07) — Smart Bridge: one-click "use your own AI":

- **Why:** the BYO-LLM agent loop already existed (`smart-bridge-server.js` `runAgentLoop` → any OpenAI-compatible `/v1/chat/completions` + `tool_calls` → `callBrowser` → `window._ccDispatch`), but was buried behind a 3-option dropdown with an empty `baseUrl` nobody knew how to fill. Goal: one click to connect the LLM the user already runs **on their desktop**. Local-desktop *requires* the bridge by design — the https app can't reach `http://localhost:11434` (mixed-content/CORS), so the native bridge proxies localhost. (Zero-install + local-desktop are mutually exclusive; user chose local-desktop.)
- **Server (`smart-bridge-server.js`):** new `GET /llm/autodetect` probes `LOCAL_LLM_CANDIDATES` (Ollama :11434, LM Studio :1234, llama.cpp :8080, Jan :1337) in parallel via existing `probeLlm({baseUrl})`, returns `{found:[{provider,label,baseUrl,models}]}`. `bridge-version.json` 0.2.0→0.3.0. Verified end-to-end against a stub LLM (boots with a tiny `ws` stub since `ws` isn't installed here).
- **Addon (`addons/smart-bridge.js`):** primary "Connect my desktop LLM" button → `/llm/autodetect` → auto-fills + saves config (`_detectLocal`); 404 → falls back to manual presets (older Connector). Presets expanded: local (Ollama/LM Studio/llama.cpp/Jan, no key) + cloud (OpenAI `gpt-4o-mini`, Claude `claude-sonnet-4-5` via Anthropic's OpenAI-compat, key). Copy reframed "Use your own AI"; "Get a key" links + Claude-compat-beta note.
- **Note / out of scope:** cloud keys (Claude/OpenAI) don't *strictly* need the bridge — they live in the bridge panel for now; moving them to the no-bridge in-app NL bar is Tier-2. The root-relative URL bug (`new URL('/v1/chat/completions', baseUrl)` drops path prefixes → breaks Groq/OpenRouter/Gemini) is untouched; in-scope targets resolve correctly. Autodetect reaches users only on the next Connector release; addon degrades gracefully.

On branch `claude/screenshot-clashcontrol-review-tiHAk` (2026-06-07) — Accessibility (toegankelijkheid) geometric check — first building-code geometric layer:

- **Engine: `addons/accessibility.js`** (follows data-quality.js — globals only, no register/toggle; added to `_loadAddonScripts` list). Exposes `window._ccRunAccessibilityChecks(elements, {thresholds})`. Deterministic, no LLM. Checks: door clear width, threshold height, ramp slope, corridor/escape-route width, turning clearance. Method is tiered honestly: ramp slope (bbox rise/run) + door width (IFC quantity, bbox fallback) + threshold (data-gated, n/a when absent) are exact; corridor/turning use footprint minor dimension (approximate for non-rectangular — true medial-axis / inscribed-circle deferred to v2). Every result carries `value/required/pass/unit/note/basis`. NL Bbl/NEN defaults (0.85/1.20/1.50/0.02 m, 1:12). `_ccAccessibilityClearance` wraps `_ccWasmMinDist` for a future element-to-element clearance check (the only check the min-distance kernel actually fits — the v1 dimensional checks are single-element/free-space, so the proposal's "reuse the kernel for everything" was oversold).
- **Panel: `AccessibilityPanel`** in `index.html` (before `DataQualityPanel`), DESIGN tokens. Reachable via Review-workspace toolbar button (`k:'a11y'`) + left-panel tab `'accessibility'` (added to `TITLES` + render switch). Model selector, Run, per-check pass/fail with measured vs required + caveat, "Isolate failing" (ghostOthers), "Create issues".
- **Failure rail = issues, NOT the clash MERGE path.** Routing through `MERGE_CLASHES` would auto-resolve all real clashes (it treats its payload as *the* detection result). So failures dispatch `A.ADD_ISSUE` (`source:'accessibility'`, `qualityGids`), exactly like data-quality → Issues tab + BCF export. If items are wanted literally in the Conflicts/Clashes tab, that needs a new non-destructive `ADD_CLASH` action (follow-up).
- **Not done:** thresholds UI (defaults only, engine accepts overrides); true free-space corridor/turning geometry (v2); the clearance-kernel check. Not browser-tested in env — main script parses via `node --check`; verify on the Vercel preview.

On branch `claude/screenshot-clashcontrol-review-tiHAk` (2026-06-07) — repo docs refresh: corrected clash-engine description (AABB+BVH, not OBB), green brand accent in DESIGN.md, web-ifc 0.0.77, added geoplace/pointcloud addons + tile/triage APIs to CLAUDE.md, marked instancing/BVH-cache as implemented in PERFORMANCE_NOTES, archived 185 lines of completed [STALE?] MEMORY blocks. Docs state current facts only (no change-history phrasing).

On branch `claude/screenshot-clashcontrol-review-tiHAk` (2026-06-07) — IFC4 georeferencing read + placement-sanity (context/QA, NOT a clash-accuracy feature):

- **Framing (deliberate):** clash detection is relative geometry and does not depend on geolocation. A geolocation/base-point mismatch between models shows up as gross systematic noise (everything off by one vector) — a coordination symptom, not a design conflict. So this work is positioned as *context + pre-run QA*, not "georef makes clashes trustworthy". The clash engine still runs in local coordinates; nothing here touches the geometry/clash math.
- **Extraction (`extractSpatialHierarchy`, `index.html:~2049`):** added `IFCMAPCONVERSION:1709695098` + `IFCPROJECTEDCRS:3843373140` constants and read the IFC4 georef chain into `hierarchy.mapConversion = {eastings, northings, orthogonalHeight, rotationDeg, scale, epsg}`. `rotationDeg = atan2(XAxisOrdinate, XAxisAbscissa)` (grid rotation); `epsg` from `TargetCRS.Name`. Pure read, wrapped in try/catch — no behaviour change when absent. (The older `IfcSite` lat/lon path is unchanged.)
- **Display (Geo Placement panel, `index.html:~14250`):** read-only mono line showing EPSG · grid rotation · E/N offset when any loaded model has a `mapConversion`. Tooltip states it's context only, not used by the clash engine.
- **Placement-sanity (`window._ccPlacementWarnings(models)` + RunDetectionModal banner, `index.html:~15605`):** on modal open, compares per-model world bboxes (`_ccState3d.map[id]` via `setFromObject`, same precedent as geoplace `_getModelBBox`). Warns when two models declare different EPSG, or sit >8× the larger diagonal apart and don't overlap ("a clash run between them will find nothing"). Capped at 4 warnings. Non-blocking amber banner.
- **NOT done (deliberately deferred):** proj4js / projected→WGS84 reprojection for an accurate basemap (still the `geoplace.js:4` deferral); auto-aligning federated models by map conversion; feeding `rotationDeg` into the basemap auto-rotation (sign convention not verified — kept display-only to avoid shipping a wrong rotation).
- **Caveats:** not browser-tested this session (no GPU/sample IFC) — syntax-checked only (main inline script parses via `node --check`). `setFromObject` instance/chunk bounding follows the existing geoplace precedent. Rotation sign/zero-meridian conventions are display-only and unverified against a real georeferenced IFC.

On branch `claude/jolly-planck-mgEaf` (2026-06-06) — Phase C: cluster cards as rows + keyboard triage:

- Cluster headers (Grouped mode, clash tab) upgraded to **Sentry/Linear-style cluster cards** with: severity dot on the left edge (colour from max `aiSeverity`/`type` across the cluster), 2-line layout (title + chips row), storey chip, **model-pair chip** (highlighted when cross-model so N-model federations make the owner obvious at a glance), open/resolved counts. Hover reveals two action buttons: **Triage** (calls `window._ccTriageCluster(items)`) and **Resolve all** (confirm dialog, then `_ccResolveCluster`).
- New abstractions: `window._ccTriageCluster(clashes)` (today: copy AI prompt to clipboard with toast; Week 3 swaps for `fetch('/api/triage')` — UI doesn't change), `window._ccResolveCluster(clashes, dispatch)` (loops `UPD_CLASH` resolved), `window._ccClusterSeverity(items)` (rank table).
- Keyboard shortcuts in `VirtualList` (clash tab only): **J/K** next/prev item (aliases for ArrowDown/Up), **T** triage current group, **R** resolve all open in current group (confirm prompt), **X** expand/collapse current group, **/** focus the search input. Existing Arrow/Tab/Esc unchanged.
- Non-cluster grouping (storey/severity/discipline/etc.) keeps the original lean header — only cluster groups get the card treatment.

On branch `claude/jolly-planck-mgEaf` (2026-06-06) — Phase A2: N-model scope picker (All / discipline / model)

- New `_renderScopePicker(rules, models, d)` replaces the legacy "Check / against" rows in `ClashRulesPanel`. Segmented control: **All ↔ All / By discipline / By model**. Side A / Side B multi-pickers reuse `_modelMultiPicker`. Pair-count badge shows live "N model(s) loaded · ~K pairs" when narrowed.
- New `rules.scopeMode` field is the UI hint; `rules.modelA` / `modelB` stay as engine truth. `_ccDerivedScopeMode(rules)` derives mode from existing modelA/modelB on first render so saved presets and shared `.ccproject` files keep working unchanged.
- `_ccSummariseRules` rendered with array-aware label list (e.g. "structural + mep ↔ architectural").
- Self-clash control unchanged in this commit — the existing `_selfClashPicker` already handles N models via multi-select. Deferred consolidation into a single Off/On-all/On-selected control.

On branch `claude/jolly-planck-mgEaf` (2026-06-06) — Phase B: clashes panel header cleanup + grouped-by-default:

- The 9-option Group dropdown is replaced (clash tab only) with a 2-button **Grouped | All** segmented control. Grouped = the Week-1 cluster de-dupe; All = flat list. A small secondary "by [storey/severity/discipline/…]" select appears only in All mode for the other axes.
- After `A.MERGE_CLASHES`, `s.clashGroupBy` is seeded to `['cluster']` if the user has never explicitly picked a Group option (`localStorage` flag `cc_clashGroupBy`). First-time visceral demo: 400 raw clashes appear as ~15 cluster cards by default.
- `ClashAISummary` defaults to collapsed (`useState(true)`). One-line header strip stays visible; details expand on click.
- Issue tab keeps its original Group dropdown (Phase B is clash-only).
- Copy AI prompt button (Week 2) is now visible on every cluster header by default — no extra clicks needed to reach the AI triage prompt copy.

On branch `claude/jolly-planck-mgEaf` (2026-06-06) — Phase A: Run Detection modal (UI overhaul step 1):

- New toolbar **Run detection** button (accent CTA in the TopToolbar's section/measure gap) opens a new `RunDetectionModal` (`index.html:~14894`) that wraps the existing `ClashRulesPanel` (Quick Run presets + Advanced) plus a collapsible **Project standards** section embedding `StandardsPanel`. One surface for all clash setup.
- New `_ccSummariseRules(rules, models)` helper produces a one-line header (e.g. `Hard clashes · 6 models, all-vs-all`) shown under the modal title.
- New state field `s.runModalOpen`, action `A.SHOW_RUN_MODAL`. `A.DETECTING` auto-closes the modal on run.
- Removed **Detection Rules** tab from the IssuePanel tab bar (`~15336`). StandardsPanel is still rendered defensively if `s.tab==='standards'` ever fires, but no UI path sets it now. Cmd-K palette "Open Standards" and the NL "double-cancel" fallback both redirect to `A.SHOW_RUN_MODAL` instead.
- Engine selector pill in toolbar stays (power-user shortcut); inside the modal the engine selector inside ClashRulesPanel also stays.
- Not done in this commit: N-model scope picker (`rules.scope = { mode, sideA, sideB }`) and self-clash consolidation. The legacy `modelA`/`modelB` multi-picker still works for all N models, just less intuitive than the planned segmented control. Phase A2 next.
- Caveats: untested in browser this session (no GPU/sample IFC); syntax-checked only via `new Function(body)`. The summary line shows `modelA ↔ modelB` for non-all rules but does not yet enumerate when `modelA`/`modelB` are arrays (`_modelSelectLabel` only handles scalar input). Cosmetic — not wrong.

On branch `claude/jolly-planck-mgEaf` (2026-06-05) — AI Triage Weeks 1+2: clustering + prompt scaffolding (still no API call):

**Week 2 — context-packet + prompt, manual copy-paste loop.** New `window._ccBuildClusterContext(clashes)` walks the cluster, looks up each element via `_ccElementFor(modelId, expressId)` (uses `window._ccLatestState`), and returns a JSON-ready context: ifcType / name / objectType / storey / material / curated quantities (Length, Diameter, Volume, etc.), cross-model + same-storey flags, hard/soft/duplicate counts, spatial extent + center in metres, min/max distance. `window._ccBuildTriagePrompt(ctx)` produces a senior-BIM-coordinator prompt asking for `{title, severity, explanation, discipline_conflict, false_positive_likelihood, resolution_options[]}` — advisory framing, no prescriptive structural changes. New "Copy AI prompt" button on each cluster group header (only when groupBy='cluster' and clash tab) copies the full prompt to clipboard so we can iterate against Claude/Gemma manually before wiring `/api/triage` in Week 3.



- New `Group → Smart group (de-dupe)` option in the Clashes panel. Collapses N raw clashes from the same element pair (e.g. same pipe through the same beam emitted at 30 sample points) into one expandable group. Pure code, no API call. First step toward the AI Triage tier (Steps 2–4 add LLM explanation, severity, resolution options, BCF write-back).
- Implementation: `window._ccClusterKeyFor(c)` = sorted pair of `(globalIdA||eid, globalIdB||eid)` — model-prefixed when GUID missing — so same pair clusters across reversed A/B order. `window._ccClusterLabelFor(c)` = `typeA × typeB — nameA ↔ nameB` (truncated 22 chars). Key/label decoupled via `window._ccClusterDisplay` side-map so the group header shows the readable label, not the GUID hash.
- New `'cluster'` case in `_groupKeyFor` (`index.html:~17288`) populates the display map and returns the hash key for grouping. Group header lookup at `index.html:~17545`.
- Added option to the Group dropdown for the Clashes tab only (`index.html:~15583`). Issues dropdown unchanged.
- Caveats: cluster cache (`_ccClusterDisplay`) accumulates labels across detection runs — harmless (deterministic from clash data) but not GC'd; rebuild on `LOAD_MODEL` if it ever shows stale text. No spatial bucketing — same long duct hitting the same beam at two physically distinct spots will collapse to one group (rare; acceptable for v1).
- Not done: visual count badge ("400 → 14") in the toolbar (the per-group count badge is already shown by VirtualList); fly-to that frames all clashes in a cluster; "Triage this group" button (Week 3); BCF write-back of group structure.

On branch `claude/adoring-hopper-IEpvn` (2026-06-03) — SEO Phase 0+1+2 (canonical, crawlability, landing pages):

- Add `<link rel="canonical">`, `<noscript>` body content, visually-hidden `<h1>`, `SoftwareApplication` JSON-LD, `og:locale` to `index.html` head.
- Add `vercel.json` 301 redirects for `/clash-control`, `/ClashControl`, `/index.html` → `/`.
- Add `robots.txt`, `sitemap.xml`, `llms.txt` at repo root.
- Phase 2: shipped 5 use-case static pages (`/free-navisworks-alternative`, `/ifc-clash-detection-online`, `/free-bcf-viewer`, `/free-ifc-viewer-online`, `/ids-validation-online`) with `FAQPage` JSON-LD, cross-links, and Goatcounter CTA tagging. Sitemap + `llms.txt` updated.
- Phase 3 remaining: submit sitemap in Google Search Console (needs owner access).

On branch `claude/meshlets-research-OSMAL` (2026-05-30) — "can we use meshlets?" research + Stage-1 PoC:

- Researched meshlets/mesh shaders. Verdict: hardware mesh shaders don't exist in WebGL/WebGPU; Needle/Nanite-style GPU meshlet rasterizers need WebGPU + three.js r160+ (too big a lift for this r128/no-build app). Meshlets do **not** help clash detection (the BVH already uses 4-tri leaves, finer than meshlets). The real, in-stack win is the *spirit* of meshlets: merge the 5k–200k per-material meshes into spatially-clustered chunks to slash draw calls + the per-mesh cull loop.
- Implemented a **flag-gated Stage-1 PoC** (`window._ccChunkMerge`, default OFF → exact revert). New `_ccBuildMergedChunks`/`_ccMergeChunkGeometries` near `_buildInstancedMeshes` (`index.html:~2200`), hooked after both IFC instancing call sites. Buckets non-instanced static meshes by spatial grid cell × material, ≤65 535-vert budget, hand-written typed-array merge (BufferGeometryUtils isn't loaded). Mutates only the render list; `element.meshes[]` untouched (protects clash/serialize/bounds — the instancing precedent).
- Picking preserved via per-chunk faceIndex→expressId range table (`window._ccChunkExprIdForFace`, used in `_hitExpressId`). Culling extended for `_isMergedChunk` (`updateCulling`). Section-clip traversals (×3) broadened so chunk/instanced materials still receive clipping planes. Hover highlight suppressed on chunks. Identity features (highlight outline / ghost / color-by-class / hide) naturally no-op on chunks under the flag (deferred to Stage 2 shader-LUT).
- **Not done / caveats:** runtime browser verification (no GPU/sample IFC in this env — syntax-checked only via vm.Script); GLB + geo-cache-restore paths not hooked (fresh IFC loads only); transparent meshes merged into a chunk may sort imprecisely; merge trades away geoCache VRAM dedup (measure `renderer.info.memory.geometries`). Plan: `/root/.claude/plans/can-we-use-the-sprightly-waffle.md`.
- **Stage 1 verified by user (2026-06-04): orbiting large models is "very smooth" now.** Merged via PR #561.
- **Stage 2A — selection & isolation on merged chunks, NO shaders (proxy/split-out reuse). Merged via PR #566; user: "works amazing".** `_findMeshByRef` falls back to the off-scene per-element proxy (`element.meshes[0]`) via a new per-model index `_ccProxyElement`/`_ccProxyMeshFor` → selection EdgesGeometry outline works. `ghostOthers` ghosts whole chunks then re-surfaces kept elements as full-material proxy clones (`_keptProxy`), removed in `unghostAll`. Post-process outline guarded to in-scene meshes only. Skips instanced (`_instanceRef`) to avoid double-render.
- **Stage 2B — bulk hide + color on chunks, in-place (no shaders, no unmerge); flips `window._ccChunkMerge` default → ON.** Render-style already applied to chunks (meshList = all meshes). **Hide** (class/storey/temp/isolate): `window._ccChunkApplyHidden` rebuilds each chunk's index to drop hidden elements' triangles, unioning a `window._ccHiddenReg` {class,storey,temp} registry that the 3 hide effects populate; picking stays correct via a parallel `_activeRanges` table (`_ccChunkExprIdForFace` prefers it); `_fullIndex` preserves the original for restore. **Color** (color-by-class + DQ `colorByDistribution`/`colorByILSDist`): `window._ccChunkApplyColors(map)` writes a per-vertex RGB `color` attr (matched→class/DQ color, unmatched→opaque context gray — all-opaque to dodge depth-sort artifacts) and swaps the chunk to one shared `vertexColors` material (`_ccColored`); render-style loop skips `_ccColored` chunks; `_ccChunkClearColors` restores. Default flip = one-line revert (`window._ccChunkMerge=false`).
- **Stage 2B caveats / long tail NOT yet chunk-aware (default is now ON, so these silently no-op on merged chunks until swept):** BCF viewpoint per-element visibility, search-highlight, validation-failure highlight, and any other of the ~15 visibility / ~34 color setters that traverse by `expressId`. Edge: changing render-style *while* color-by-class is active leaves chunks one style behind until color is cleared. Not runtime-tested in this env (syntax-checked only).

On branch `claude/code-review-quality-IjbhT` (2026-05-28) — code-review quality pass:

- ~~`api/title.js`: `MAX_CLASHES` was 50 but the handler then sliced to 20, silently dropping clashes 21–50. Set the cap to 20 (matches the client's per-call batch in `index.html:~22662` and the documented contract) and slice with the constant, so oversized payloads get a clear 413.~~ (2026-05-28)
- ~~Addon convention: `pwa.js`, `shared-project.js`, `local-engine.js`, `revit-bridge.js` called `window._ccRegisterAddon(...)` unguarded. Wrapped each in a `typeof === 'function'` guard (one-liner, no re-indent) matching `wasm-engine.js`.~~ (2026-05-28)
- ~~`addons/training-data.js`: extracted the 3×-duplicated Google-Forms submit-with-fallback (CORS → no-cors → hidden iframe) into one `_postToGoogleForm(entryId, value, onStatus, onSuccess)` helper. AI share passes `null` for onSuccess (it intentionally does not clear the store).~~ (2026-05-28)
- ~~Error handling: `suggestOmniClass` provider chains now reject on non-ok HTTP via `_aiResJson` (NOTE: `suggestOmniClass` is currently dead code — defined, never called); `/api/health` guards `r.ok` before `.json()`; `api/nl.js` upstream-error log truncated to 500 chars.~~ (2026-05-28)
- ~~Docs: CLAUDE.md core line count 19.8k → ~29k, added `smart-bridge.js` + `wasm-engine.js` to the file overview and "what each addon does". MEMORY.md version header 4.15.4 → 5.12.6. Taught `scripts/update-memory.py` to keep the Project State `**Version:**` line synced from `version.json` on every daily run.~~ (2026-05-28)
- ~~Testing/CI: added a no-dependency `node:test` suite under `tests/` (CORS allow-list + rate limiter in `_lib.js`; title/nl validation incl. the 413 regression lock), `"test": "node --test"` script, and `.github/workflows/ci.yml` running it on PRs/pushes to main. Added `.gitignore` (none existed).~~ (2026-05-28)

**Deferred (tracked follow-ups, not done this pass):** core reducer/state refactor (287-line reducer / 80+ cases / impure `_saveDeniedClash` inside the reducer / ~50 `window._cc*` globals) — do it only once the test suite covers the pure clash/reducer/BCF logic, which needs those helpers extracted from `index.html` first. Also: a CI check that re-verifies `index.html` SRI hashes against the live CDN, and 3D-canvas keyboard accessibility (no keyboard orbit/pan, no modal focus trap).

<!-- END:active-work -->

<!-- BEGIN:session-log -->
### 2026-06-07
**Summary:** 32 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 425924e chore: bump version to 5.17.4
- 1a43021 revert: chunk-merge default OFF — back to per-element rendering
- a13893d chore: bump version to 5.17.3
- f573042 revert: remove Free RAM / dehydrate experiment entirely
- 1cde307 chore: bump version to 5.17.2
- 2477ada feat(settings): expose Free RAM button in main Settings
- e0053fe fix(geoplace): same-origin tile proxy + opaque basemap (#579)
- 2a6dc52 chore: bump version to 5.17.1
- 6064b37 perf+consent: memoize Conflicts-tab aggregations + default-on consent + suppress banner
- 3648646 chore: bump version to 5.17.0
- 251bbc8 feat(triage+viewer): grounded prompt + 👍/👎 + marker fixes + survey-marker strip + memory helpers
- 9d312b4 chore: bump version to 5.16.2
- ca62e77 feat: point clouds + IFC geo-placement (v1) (#578)
- c290f11 chore: bump version to 5.16.1
- 09e5dfd perf(viewer): PR-A — Int8 normals (~630 MB cut), positions unchanged
- d5d03bc chore: bump version to 5.16.0
- 879eb67 fix(loader): race-safe model dedup — 4 files no longer load as 8 (#572)
- 79a0582 chore: bump version to 5.15.3
- 9b16e6e perf(loader): fix chunk-merge bypass on cache-restore + Clear all clashes
- d3f9200 chore: bump version to 5.15.2
- a941037 perf(viewer): D1b LOD + cross-load material sharing + dup-load guard
- f61726e chore: bump version to 5.15.1
- ae8f202 perf(viewer): D1 — Points + per-cluster hotspot markers
- a1229b4 chore: bump version to 5.15.0
- 53b4dcc fix(clash-ui): align overhaul with DESIGN.md + workspace gating, wire /api/triage, perf
- 9b2e9cf chore: bump version to 5.14.0
- 215d06a feat(clash-ui): Phase C — cluster cards as rows + keyboard triage
- 76af12c feat(clash-ui): Phase A2 — N-model scope picker (All / discipline / model)
- 51897d5 feat(clash-ui): Phase B — clashes header cleanup + grouped-by-default
- 815ac50 feat(clash-ui): Phase A — Run Detection modal + remove Detection Rules tab
- df7c5aa feat(triage): Week 2 — cluster context packet + prompt + copy button
- 6effc2b chore: daily memory sync 2026-06-06

</details>

### 2026-06-06
**Summary:** 4 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 7367304 chore: daily memory sync 2026-06-05
- b8b8d86 chore: bump version to 5.13.0
- c3f901e fix(section-box): stable side-face arrow dragging (robust axis projection)
- 3fb15de fix(spatial-tree): persist category visibility across refresh

</details>

### 2026-06-05
**Summary:** 9 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- b8b8d86 chore: bump version to 5.13.0
- c3f901e fix(section-box): stable side-face arrow dragging (robust axis projection)
- 3fb15de fix(spatial-tree): persist category visibility across refresh
- a610701 feat(memory-report): add heap breakdown diagnostics
- 5d52417 chore: bump version to 5.12.14
- c7f274b feat(viewer): Stage 2B — bulk hide + color on merged chunks; enable chunk-merge by default
- 1892c6e chore: daily memory sync 2026-06-04
- 051f8f7 chore: bump version to 5.12.13
- fd0e272 feat(viewer): Stage 2A — selection highlight + ghost/isolate on merged chunks

</details>

### 2026-06-04
**Summary:** 11 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 051f8f7 chore: bump version to 5.12.13
- fd0e272 feat(viewer): Stage 2A — selection highlight + ghost/isolate on merged chunks
- aee3ed3 Potential fix for code scanning alert no. 13: Workflow does not contain permissions
- 757be37 chore: bump version to 5.12.12
- a010500 chore(brand): replace stale PWA icons + OG image with current green-square brand
- 2e716d5 fix(viewer): keep section-plane rotation ring horizontal on vertical planes
- 9feceef chore: bump version to 5.12.11
- 0824e5c chore: bump version to 5.12.10
- c4c062f SEO Phase 2: five high-intent landing pages
- 1a9fcbd SEO Phase 0+1: canonical, crawlability, structured data
- f02dd29 chore: daily memory sync 2026-06-03

</details>

### 2026-06-03
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 6b398d2 chore: daily memory sync 2026-06-02

</details>

### 2026-06-02
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- c989a56 chore: daily memory sync 2026-06-01

</details>

### 2026-06-01
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- e552c23 chore: daily memory sync 2026-05-31

</details>

### 2026-05-31
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 1e61d1f chore: daily memory sync 2026-05-30

</details>

### 2026-05-30
**Summary:** 6 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- e50d72a chore: daily memory sync 2026-05-29
- ab6fb7c chore: bump version to 5.12.9
- 243ddcf Section gizmo: constant-size handles, follow plane, fix stuck drag & ring offset
- a30b9bd chore: bump version to 5.12.8
- b356ac8 Make section-plane drag track the cursor and easier to grab
- 7c82c74 chore: bump version to 5.12.7

</details>

### 2026-05-29
**Summary:** 9 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- ab6fb7c chore: bump version to 5.12.9
- 243ddcf Section gizmo: constant-size handles, follow plane, fix stuck drag & ring offset
- a30b9bd chore: bump version to 5.12.8
- b356ac8 Make section-plane drag track the cursor and easier to grab
- 7c82c74 chore: bump version to 5.12.7
- 4348944 Code-review quality pass: bug fix, addon guards, dedup, tests, docs
- f759f94 chore: bump version to 5.12.6
- 25826bd Don't block project switching when welcome card is shown
- 48187ef chore: daily memory sync 2026-05-28

</details>

### 2026-05-28
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 2ef0a47 chore: daily memory sync 2026-05-27

</details>

### 2026-05-27
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- e834c4d chore: daily memory sync 2026-05-26

</details>

### 2026-05-26
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 10863b8 chore: daily memory sync 2026-05-25

</details>

### 2026-05-25
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 7be9827 chore: daily memory sync 2026-05-24

</details>

### 2026-05-24
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- e9b31af chore: daily memory sync 2026-05-23

</details>

### 2026-05-23
**Summary:** 5 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 29c06d5 chore: bump version to 5.12.5
- df2eb44 chore: prune 7 unwired reducer cases
- 972ac3d chore: daily memory sync 2026-05-22
- 07a1a84 chore: bump version to 5.12.4
- cf60b7d chore: trim devtools globals and stale docs

</details>

### 2026-05-22
**Summary:** 3 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 07a1a84 chore: bump version to 5.12.4
- cf60b7d chore: trim devtools globals and stale docs
- 2a2693b chore: daily memory sync 2026-05-21

</details>

### 2026-05-21
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 7fe0a23 chore: daily memory sync 2026-05-20

</details>

### 2026-05-20
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 7a99eb1 chore: daily memory sync 2026-05-19

</details>

### 2026-05-19
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 2847951 chore: daily memory sync 2026-05-18

</details>

### 2026-05-18
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 765c2b2 chore: daily memory sync 2026-05-17

</details>

### 2026-05-17
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 15546dc chore: daily memory sync 2026-05-16

</details>

### 2026-05-16
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 65e7755 chore: daily memory sync 2026-05-15

</details>

### 2026-05-15
**Summary:** 19 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 014f080 chore: bump version to 5.12.3
- b301d3e Slow down section plane drag to better follow mouse speed
- 8e75d02 Fix section plane rotation to match ring orientation
- 3c23c97 Fix section plane rotation ring orientation — always lies flat (world-horizontal)
- 8a1ac83 Remove flat end caps from section plane arrow shaft
- 10145ab Lock face arrow size cap and fix tall-narrow box scaling
- 22aadb1 chore: bump version to 5.12.2
- a149c48 Tighten handle size caps to prevent oversizing on large models
- 7cb1b49 Thin section plane arrow shaft (~40% of previous radius)
- efcd7b5 chore: bump version to 5.12.1
- 11585ef Fix handle sizing to be geometry-relative, not camera-distance based
- 1c382ba chore: bump version to 5.12.0
- 2494aa8 Unify section plane handles with section box style
- 7e92932 Show IFC quantities in model's native unit, not converted to metres
- 002d291 Fix IFC quantity dimensions ignoring project unit scale
- c122a36 Fix Alt+click, section box arrows, bounds, rotation, and opacity
- 0573dcf Fix text overflow in Details panel element name header
- 557d246 Add folder watcher, inline project creation, remove Measure tab
- 5a4b345 chore: daily memory sync 2026-05-14

</details>

### 2026-05-14
**Summary:** 4 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 4acc741 chore: bump version to 5.11.3
- fc6a3d3 chore: bump version to 5.11.2
- d58b062 fix: propagate type-level psets to instances on IFC load
- 080f6d3 chore: daily memory sync 2026-05-13

</details>

### 2026-05-13
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 8d2279f chore: daily memory sync 2026-05-12

</details>

### 2026-05-12
**Summary:** 16 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 23325ac chore: bump version to 5.11.1
- 01ff976 fix: WASD breaks when clicking to look — remove mid-walk requestPointerLock
- 8393047 fix: walk LMB-drag look stops at screen edge
- 7c6d70d chore: bump version to 5.11.0
- bd07655 Walk mode Phase 2: LMB-drag look, step-up, section/measure preserved, V/N/share
- ee1252c chore: bump version to 5.10.0
- 7f63458 Walk mode Phase 1: fix lag, accel/friction, EMA look, smooth enter/exit
- 219c70f revert: unrequested areaKeys expansion (user asked about material/classification, not area)
- a246f2a fix: restore Ask AI tab so Cmd+K entries remain functional
- cfa6853 fix: inspector details — material layers, area formatting, default tab, remove Ask AI tab
- ec6ec90 fix: use --color-success green for drag-drop overlay border; call out DESIGN.md in session start
- a4c0add feat: drag-and-drop IFC/GLB loading when models are already open
- 0132c7d chore: bump version to 5.9.8
- 32c58ee chore: bump version to 5.9.7
- dbdd54b chore: daily memory sync 2026-05-11
- 5af42ab feat: persist detection profile in detection-runs history

</details>

### 2026-05-11
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- f9b0010 chore: daily memory sync 2026-05-10

</details>

### 2026-05-10
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- a09a822 chore: daily memory sync 2026-05-09

</details>

### 2026-05-09
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- bcba721 chore: daily memory sync 2026-05-08

</details>

### 2026-05-08
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 56c90cd chore: daily memory sync 2026-05-07

</details>

### 2026-05-07
**Summary:** 57 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 5d33059 chore: bump version to 5.9.6
- 29a232c fix walk mode: mouse look works during WASD by listening at window level
- 7afbe4e chore: bump version to 5.9.5
- f31d52f walk mode: free mouse look + dynamic resolution for performance
- 6d43564 fix walk mode: pointer lock rotation, drone height, performance
- 7564cc5 chore: bump version to 5.9.4
- 0f94b83 Fix walk-mode auto-exit on 'w' key + ViewCube ReferenceError
- c90826e chore: bump version to 5.9.3
- b03efdf Remove [2D Outlines] / [2D Sheet] console.log spam
- 6a34c59 Fix _isGhostMat ReferenceError crashing walk-tick gravity
- 87894e6 chore: bump version to 5.9.2
- d791312 Walk mode: call _ccWalkEnter directly from Pegman click
- 0b44fe4 chore: bump version to 5.9.1
- ea0bdd0 Fix Pegman placement, reduce walk-mode render overhead
- cc593f1 chore: bump version to 5.9.0
- ca0b6a2 Walk mode follow-up: spline recorder, bookmarks UI, sun slider, footprint check, Settings section
- 30a5e0c chore: bump version to 5.8.0
- e504753 chore: bump version to 5.7.13
- 06c26c6 feat(measure): edge-vertex insert, Z-axis labels, and geo disposal
- 1122987 Walk mode deep redesign: Pegman entry, teleport-anywhere, radar + minimap
- 8884ecf chore: bump version to 5.7.12
- c16efa0 feat(measure): smart polygon ordering for area tool
- 35b9d51 Fix area seeding direction and replace right-click with caret for home view
- 2fb3aed feat: differentiate Fit All and Reset View with context-awareness and saved home
- 8b92a0c chore: bump version to 5.7.11
- 0dbf122 Fix model replacement: stale ghost, stale meshList, ortho near-clip, stale state closure
- eb6b5e1 Strip embedded NN%/N-of-M from loading phase text to avoid double percentage
- c617ebb chore: bump version to 5.7.10
- dcc31ea Fix glass detection for IfcWindow curtain wall frames + type-level material inheritance
- d17d92b Fix clearance: sample real mesh vertices instead of bbox corners
- 496b71c chore: bump version to 5.7.9
- 3a5fa12 Fix glass detection, area preview edges, and add IFC type to Identity panel
- 15bb2ea chore: bump version to 5.7.8
- 947b7b0 Hide measurement 3D geometry when m.hidden toggled
- 120ca6b Fix coordinate chip showing &nbsp; literally; alt+click seeds both endpoints
- 066759f chore: bump version to 5.7.7
- a127884 fix: raise click/drag threshold during active measurement to 8px
- f879b88 fix: block alt+click section plane shortcut while measure tool is active
- f982f4f chore: bump version to 5.7.6
- c5f5571 fix: area icon, snap race condition, endpoint hint, area seeding
- 0616c9a chore: bump version to 5.7.5
- e45ba6c fix: only show alt+click endpoint hint when measure tool is active
- 29cd66e feat: alt+click placed length endpoint to continue as area polygon
- 9102282 chore: bump version to 5.7.4
- 0db6416 Token compliance pass for yesterday's section + compare UI
- f53447a Design token compliance pass for measurement UI additions
- 703aabe Fix Esc deleting committed dimensions; hide section-clear when no section; add Alt-throwaway
- 1fbeac4 chore: bump version to 5.7.3
- f0233fa chore: daily memory sync 2026-05-05
- 708a7b2 Add click-to-continue: length auto-chains into area on 3rd click
- aaaf4c4 Consolidate measure cursor + snap marker into one combined element
- fe9c48f chore: bump version to 5.7.2
- d3ca74b Resurface IFC dimension & constraint properties in Inspector Details
- 16ab0ef chore: bump version to 5.7.1
- d94cbea Fix measurement tool UX: popover, cursor offset, icon, snap + drag feedback
- 0677141 chore: bump version to 5.7.0
- 8c8fbb3 Drag-to-edit endpoints + PointerLens magnifier render

</details>

### 2026-05-05
**Summary:** 52 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- fe9c48f chore: bump version to 5.7.2
- d3ca74b Resurface IFC dimension & constraint properties in Inspector Details
- 16ab0ef chore: bump version to 5.7.1
- d94cbea Fix measurement tool UX: popover, cursor offset, icon, snap + drag feedback
- 0677141 chore: bump version to 5.7.0
- 8c8fbb3 Drag-to-edit endpoints + PointerLens magnifier render
- 93e09a4 Measure tools deep redesign — snap engine, live preview, Qto_* element measure, clearance, takeoff, units
- 8034c54 chore: bump version to 5.6.13
- 8ae0680 Section box rotation + force-opaque framing elements
- 195e6a1 chore: bump version to 5.6.12
- b94104e Fix section box face drag, clipped-element clicks, and glass detection
- 2e12b9c Remove orbit damping (felt sluggish at end of rotation)
- 8290a75 chore: bump version to 5.6.11
- fc182c8 Three viewer performance improvements + glass name detection
- 6ad6f9e Fix metal mullions wrongly rendered as glass
- e5983da chore: bump version to 5.6.10
- a903f3e Fix section plane drag and rotation
- 5c3f3e4 chore: bump version to 5.6.9
- 9af8eba Drop custom section plane arrow/torus, recolour TransformControls green
- 00e8916 chore: bump version to 5.6.8
- c02735e Section handles glow on hover + no modifier needed to drag
- 037a1f0 Detect glass by IFC type fallback (IfcWindow / IfcCurtainWall / IfcPlate)
- 9d7c942 Make glass transparent in shaded mode too
- 5e2237e chore: bump version to 5.6.7
- 3f2d083 Fix glass transparency in rendered mode
- c0f478b Fix section plane rotation direction — invert drag sign
- b28c169 Match section plane arrow size to section box face arrows
- a10cbe9 chore: bump version to 5.6.6
- 42707d0 Replace stencil section hatch with polygon-based cap mesh
- 5152127 Make Compare panel generic A/B instead of version-specific Old/New
- 68bdbbd chore: bump version to 5.6.5
- 7b40af0 Fix section box clip/wireframe rotating in opposite directions, +15% handles
- c9cb710 chore: bump version to 5.6.4
- 0058a25 Fix section box clipping, handle size -50%, rotation gizmo live update
- 94a4ec6 chore: bump version to 5.6.3
- cdd029f Fix section box not clipping + shrink handles
- ac79945 Persist IFC v2 version metadata to IndexedDB so it survives page refresh
- 05bc035 chore: bump version to 5.6.2
- bf87d99 Version Compare: rename A/B to Old/New, auto-detect version pairs, update diff badges to design system
- 710474b Fix section tools, shadows, hatch, handles, ground plane + remove wireframe
- e5414ff chore: bump version to 5.6.1
- 38f2add Fix section hatch camera-angle flicker + section box handle visibility
- e0d4e5a Section hatch: size cap plane to model bounding box
- ea8bcf9 chore: bump version to 5.6.0
- 04a8a73 Section hatch: auto-rebuild on model change, skip thin shells
- 4612a64 Add architectural section hatch — stencil-cap solid fill on cut faces
- 02533de chore: bump version to 5.5.1
- a51592d chore: daily memory sync 2026-05-04
- 46bc120 fix(section): make the cut actually cut + show a visible plane
- 991713a chore: bump version to 5.5.0
- 950e404 feat(section): unified S key, Alt+click, F-flip, drag HUD, viewpoint persistence
- a811bad fix(section): apply clipping reliably + clearer icons + axis-key alignment

</details>

### 2026-05-04
**Summary:** 17 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 991713a chore: bump version to 5.5.0
- 950e404 feat(section): unified S key, Alt+click, F-flip, drag HUD, viewpoint persistence
- a811bad fix(section): apply clipping reliably + clearer icons + axis-key alignment
- 521aec6 chore: bump version to 5.4.0
- 45cecbf Update MEMORY.md — full plan complete
- 014844a B1: Numbered pins (Speckle pattern) + @mention highlighting
- c97db89 B7: Design option compare — blend two model versions
- 8cbfabf B2 (rest): Rich markup tools on the 3D canvas
- ee864f2 Engine in toolbar + B6 hover coords + A5 per-storey hide + B8 selection sets
- be020c6 chore: bump version to 5.3.0
- b54a889 Update MEMORY.md with completed session work
- 47700ab B4: Material preview in Rendered mode
- 963c7e6 B2 + B3: PDF export and walkthrough recording
- ae3522f A2-A6 + B5 + B6: Panel improvements, X-Ray render style, area measurement
- 861bae8 chore: bump version to 5.2.4
- 788f1a2 ViewCube: fix off-screen clipping, remove arrows, fill wrapper
- f41edc1 chore: daily memory sync 2026-05-03

</details>

### 2026-05-03
**Summary:** 12 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 1f5a225 chore: bump version to 5.2.3
- aa978cc Cmd-K: reorder items within each group by current workspace
- f326556 Revert "Cmd-K palette: workspace-aware ordering and filtering"
- 3551c35 Cmd-K palette: workspace-aware ordering and filtering
- cdbea34 Toolbar tooltips: design-system styling
- 7dc5520 chore: bump version to 5.2.2
- 3070986 UI polish: remove LeftRail, fix Style dropdown, resize ViewCube, clean up viewer
- 3f2e982 chore: bump version to 5.2.1
- b8201f0 perf(render): Hidden Line uses one shared Lambert, not N per-mesh
- 510c772 fix(ui): post-screenshot polish — welcome hides on load, restore Review, toolbar icons
- a2a55de chore: daily memory sync 2026-05-02
- c4e11b9 chore: bump version to 5.2.0

</details>

### 2026-05-02
**Summary:** 63 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- c4e11b9 chore: bump version to 5.2.0
- e56937a feat(ui): DOM-anchored 3D clash chips — selection title floats above the model
- 3be9ba5 feat(ui): Tier 3 — load progress card, tonal canvas, single icon scale, draw-in welcome
- 3f1a4e7 feat(ui): Tier 2 — Cmd-K palette, fold Review→Coordinate, share promoted, copy clearer
- 38d8bf0 feat(ui): Tier 1 — kill violet bleed, forest brand mark, wire shortcuts modal
- 79c1c16 chore: bump version to 5.1.14
- 5291125 Distribute remaining integrations into their natural places
- 0d9f7a1 Distribute integrations to logical contexts; demote unified menu
- eefc593 Sweep remaining blue colors from user-facing UI
- 46e258e Replace remaining blue accents in clash/issues UI; clean up mobile chrome
- 5c975df Hide ground shadow when all models are unchecked
- 490c143 chore: bump version to 5.1.13
- dedfabd Fix element picker selecting wrong element (wall click picking beam)
- a75d334 Add inline project rename + responsive layout fixes
- c7cc7a7 Add Ctrl/Cmd+Click to multi-select elements in 3D viewer
- 9ed2d11 chore: bump version to 5.1.12
- f96160c Fix toolbar tooltip (remove native title attr) and redesign Present details as property table
- f497440 File-load opens right-panel Models tab; ViewCube arrows only on axis-aligned views
- 52914bc Fix ground plane floating; hide Models tab label in right panel
- 0b69d75 chore: bump version to 5.1.11
- 3b90853 Models toolbar button toggles right panel (Models tab), not left panel
- 2a652eb Models button back to toolbar; 2D underlay stays in 3D; ground plane glass fix
- 4648dac Ground plane cutout, Integrations redesign, Details auto-open on element click
- 3e7d6ac chore: bump version to 5.1.10
- d498e2b UI reorganization: models to right panel, navigator to review, integrations to avatar menu, toolbar tooltips
- 3c0e721 Memory optimizations: remove LOD proxy system, strip _glbBuffer from state, free geoCache
- b3596a8 chore: bump version to 5.1.9
- 9f7f1f9 ModelSidebar: tighten spacing and sizing in redesign
- 0cded3c UI fixes: LOC boxes, ViewCube, tabs, modals, toolbar
- 557fb29 chore: bump version to 5.1.8
- 442263f Present prose, toolbar Ask AI, +Add dropdown, panel cleanup
- 15a7735 chore: bump version to 5.1.7
- 79ebeb2 Section box face arrows + Revit-style ViewCube
- 1e15b87 chore: bump version to 5.1.6
- 3e268c0 Workspaces renamed + inspector depth + UX polish
- 1a2c18c Section box: Revit-style — fits selected element, falls back to full model
- 7881f80 Popovers, walk HUD redesign, hover fix + Enscape-style scroll speed
- cd6faaf Fix walk mode entry + default to Shaded style on load
- 55dc6c5 chore: bump version to 5.1.5
- 97836aa Render styles: Hidden Line mode + faster rendered view
- f651b61 fix(walk+inspector): free WASD walk, no forced details re-open
- a940172 feat(render): time-of-day sun, less-bright shaded, distinct standard
- 95b2e61 chore: bump version to 5.1.4
- 6b72c60 feat(toolbar+section): default to Standard, click-surface section, Add model
- 817f0a2 fix(render): IBL ambient, working sliders, no z-fighting, real ground plane
- b37640a chore: bump version to 5.1.3
- ab58a2f fix(toolbar+panels): unbreak app, redesign panel headers, drop sample model
- 21c6fb2 chore: daily memory sync 2026-05-01
- 963fb70 chore: bump version to 5.1.2
- d0731c5 feat(ui): zinc + forest palette, layout fix, Enscape walk, render quality
- 1b9b0ed fix(inspector): collapse right panel when element is deselected
- 027364f fix(ui): remove duplicate access points across viewer
- a20e0f4 chore: bump version to 5.1.1
- 3c3a46c feat(inspector): workspace-aware element details depth
- b7f46f1 fix(ui): clean white palette, remove emojis, deduplicate element panel
- 50cfd86 fix(ui): switch fonts to Syne + DM Sans, fix theme-color meta
- e09b517 chore: bump version to 5.1.0
- bf9e3a5 feat(ui): paper + ink + terracotta redesign — workspace switcher, xeokit toolbar, demoted Ask AI
- 71b094b chore: bump version to 5.0.3
- fa2d1a1 fix(mobile): hide right drawer entirely + add floating theme toggle (top-left)
- 939798e feat(theme): default to light mode (Figma/Sketch/Notion convention) — boot script applies before paint to prevent flash
- 413b0a9 chore: bump version to 5.0.2
- 0ce33ee fix: sky gradient addColorStop needs hex, not CSS variable (Canvas 2D doesn't resolve var(--))

</details>

### 2026-05-01
**Summary:** 64 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 963fb70 chore: bump version to 5.1.2
- d0731c5 feat(ui): zinc + forest palette, layout fix, Enscape walk, render quality
- 1b9b0ed fix(inspector): collapse right panel when element is deselected
- 027364f fix(ui): remove duplicate access points across viewer
- a20e0f4 chore: bump version to 5.1.1
- 3c3a46c feat(inspector): workspace-aware element details depth
- b7f46f1 fix(ui): clean white palette, remove emojis, deduplicate element panel
- 50cfd86 fix(ui): switch fonts to Syne + DM Sans, fix theme-color meta
- e09b517 chore: bump version to 5.1.0
- bf9e3a5 feat(ui): paper + ink + terracotta redesign — workspace switcher, xeokit toolbar, demoted Ask AI
- 71b094b chore: bump version to 5.0.3
- fa2d1a1 fix(mobile): hide right drawer entirely + add floating theme toggle (top-left)
- 939798e feat(theme): default to light mode (Figma/Sketch/Notion convention) — boot script applies before paint to prevent flash
- 413b0a9 chore: bump version to 5.0.2
- 0ce33ee fix: sky gradient addColorStop needs hex, not CSS variable (Canvas 2D doesn't resolve var(--))
- c0f7db2 chore: bump version to 5.0.1
- 3673f27 fix: remove escaped quotes in WelcomePopup template literal (SyntaxError at line 21137)
- 685a945 chore: bump version to 5.0.0
- dc57df1 ci: remove custom CodeQL workflow — conflicts with Default Setup already enabled on repo
- 30ca36f ci: match CodeQL Default Setup categories (javascript-typescript + rust)
- 0c9a7cb ci: add CodeQL workflow (fixes '1 configuration not found' failure)
- 535ed8d fix(security): keep apiKey in memory only, not sessionStorage (js/clear-text-storage-of-sensitive-data)
- 92e31eb fix(security): add SRI integrity hashes for GLTFLoader and pdf.js (js/functionality-from-untrusted-source #7)
- e216fa2 fix(security): hostname allowlist in sw.js instead of URL substring checks (js/incomplete-url-substring-sanitization #5 #6)
- bba1f5c fix(security): move apiKey from localStorage to sessionStorage (js/clear-text-storage-of-sensitive-data)
- 8e27a28 fix(security): static format string in revit-bridge console.log (js/tainted-format-string)
- 3b057aa fix(security): use static format string in local-engine console.log (js/tainted-format-string)
- f2361b2 chore: update MEMORY.md — UI overhaul complete (PR-1 through PR-8)
- f93b3f3 feat(overlay-panels): left/right panels float over canvas + details drawer + model load card
- c19010c feat(pr4): violet left rail tabs, grid opacity, blue→violet sweep
- 2925060 feat(pr3): slim desktop top bar — glass surface, Share accent, theme toggle
- 6b54bf5 feat(pr2): bottom mode toolbar with 6 chips and sub-tool rows
- 91ecc5d feat(pr1): violet accent, rounder radii, glass surface tokens
- 4743a20 docs: UI overhaul — Chapter 7 (implementation roadmap)
- 9b0ff1b docs: UI overhaul — Chapter 6 (first-run and onboarding)
- f02aa30 docs: UI overhaul — Chapter 5 (feature remapping and naming pass)
- 1f7a116 docs: UI overhaul — Chapter 4 (visual language and copy tone)
- b1e4959 docs: UI overhaul — Chapter 3 (tools as architectural instruments)
- 9d4cfa5 docs: UI overhaul — Chapter 2 (layout architecture)
- e5e90ae docs: UI overhaul design doc — Chapter 1 (vision, personas, references)
- 865944f fix: ViewCube nav arrows render as literal text on iOS Safari
- 51dfbff chore: bump version to 4.19.0
- ab207c1 feat(PR-A): TransformControls section gizmo
- 6a4adf1 feat(PR-E): presentation v2 — slide auto-advance + brand logo
- e272a7b feat(PR-B): SAO ambient occlusion + selection outline post-processing
- 6822bc9 feat(PR-D): walk-mode polish — head-bob + no-clip + gamepad
- 158a7ad feat(PR-C): Smart Views + shareable URL hash
- 5a7e47a chore: bump version to 4.18.0
- 885647a chore: bump version to 4.17.1
- c2aaf71 feat: presentation/kiosk mode + roadmap
- 84a57b9 feat: header Share button + walk-FOV HUD + ACES/shadows for cinematic look
- 9772053 feat(revit-bridge): implement session resumption + keep/discard partial model UI
- 9f80b5a chore: bump version to 4.17.0
- de6b9dd feat: top-level Share entry + pin-on-model comments via folder-sync
- 3d3c2f6 chore: bump version to 4.16.6
- 954e61e fix(revit-bridge): handle isLinked→isLink field rename + add export-start/end logging
- 61ef16f fix: remove LOD proxy boxes — show elements or hide, never show translucent AABB
- 155b2f7 chore: bump version to 4.16.5
- 2959d35 fix: bump geo cache to v4 to invalidate corrupted v3 entries from instancing
- dda8647 fix: delete geo cache immediately when a project is deleted
- fb4e1d2 chore: bump version to 4.16.4
- 2b5d1cd fix: replace setFromObject(scene) with _elemsBBox() to fix instanced mesh bounds
- 59d0917 fix viewer rotation lag and add ViewCube navigation arrows
- 4cbfe5f chore: daily memory sync 2026-04-30

</details>

### 2026-04-30
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- c45e1a5 chore: daily memory sync 2026-04-29

</details>

### 2026-04-29
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- fa5a57f chore: daily memory sync 2026-04-28

</details>

### 2026-04-28
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 4b5274a chore: daily memory sync 2026-04-27

</details>

### 2026-04-27
**Summary:** 5 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 4cc7120 chore: bump version to 4.16.3
- 6c36924 perf+sec: kill periodic rotation hitch; rate-limit /api/nl + /api/title
- 28fa548 feat(bridge): /llm/health probe, error codes, env-var timeouts
- fdf26c2 chore: daily memory sync 2026-04-26
- d942a27 chore: bump version to 4.16.2

</details>

### 2026-04-26
**Summary:** 3 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- d942a27 chore: bump version to 4.16.2
- f37f17d fix: CORS exact-match, face panel material leak, dedupe cleanup blocks
- f39737c chore: daily memory sync 2026-04-25

</details>

### 2026-04-25
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 028129f chore: daily memory sync 2026-04-24

</details>

### 2026-04-24
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 71ce56a chore: daily memory sync 2026-04-23

</details>

### 2026-04-23
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- f490af8 chore: daily memory sync 2026-04-22

</details>

### 2026-04-22
**Summary:** 5 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 4ffff92 chore: daily memory sync 2026-04-21
- 0dcb06b chore: bump version to 4.16.1
- 1b6c65e chore: update MEMORY.md active work log
- f88c625 feat: wire unused data paths — DQ→Issues, feedback badge, BCF revit IDs, shared viewpoints
- 4175de7 perf: O(1) BVH LRU + prune ghost mat cache on model unload

</details>

### 2026-04-21
**Summary:** 8 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 0dcb06b chore: bump version to 4.16.1
- 1b6c65e chore: update MEMORY.md active work log
- f88c625 feat: wire unused data paths — DQ→Issues, feedback badge, BCF revit IDs, shared viewpoints
- 4175de7 perf: O(1) BVH LRU + prune ghost mat cache on model unload
- b20d0cb chore: daily memory sync 2026-04-20
- 5e3e9be chore: bump version to 4.16.0
- 23a1dcd perf: replace persistent BVH cache with LRU-bounded cross-run cache
- 548aca6 perf: GPU instancing, GLB dedup, persistent BVH cache

</details>

### 2026-04-20
**Summary:** 4 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 5e3e9be chore: bump version to 4.16.0
- 23a1dcd perf: replace persistent BVH cache with LRU-bounded cross-run cache
- 548aca6 perf: GPU instancing, GLB dedup, persistent BVH cache
- f61d944 chore: daily memory sync 2026-04-19

</details>

### 2026-04-19
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- a646758 chore: daily memory sync 2026-04-18

</details>

### 2026-04-18
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- d7131ba feat: daily memory sync system for shared session continuity

</details>

## Session Log

Daily summaries, newest first. Entries older than 60 days are pruned to the Cleanup Log.

### 2026-04-17
**Summary:** Initial MEMORY.md created to establish shared session memory. Seeded with project state at v4.15.4, architecture decisions, and known issues.
**Changed:** MEMORY.md (new), scripts/update-memory.py (new), .github/workflows/daily-sync.yml (new), CLAUDE.md (updated)
**Notable:** Daily automation uses `ANTHROPIC_API_KEY` GitHub secret for AI-powered summaries; falls back to plain commit list if key absent. Set the secret in repo Settings → Secrets → Actions.
<!-- END:session-log -->

<!-- BEGIN:cleanup-log -->
## Cleanup Log

Records what was pruned from the session log and why. Permanent.

_Nothing pruned yet._

<!-- END:cleanup-log -->
