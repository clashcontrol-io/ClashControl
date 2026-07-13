# ClashControl — Shared Session Memory

> Auto-updated daily by `.github/workflows/daily-sync.yml`.
> **Every new Claude session should read this file first** to avoid re-implementing things,
> repeating past mistakes, or working against current direction.
> Update the Active Work and Project State sections as you make progress.

---

<!-- BEGIN:project-state -->
## Project State

**Version:** 5.21.17 (2026-07-10) — daily-sync was silently crashing on MEMORY.md's own prose (see Known Issues); this line was stale for a month as a direct result, now corrected by hand.

**Live features (all working):**
- Mesh-based clash detection engine: AABB broad-phase + BVH tri-tri narrow-phase (Möller–Trumbore), optional `_ccWasmIntersect`/`_ccWasmMinDist` WASM accelerators; default clash matrix (skips same-discipline pairs, per-element classification, never skips same-model self-clashes) + N×N matrix UI; rules (discipline filters, clearance, group-by); soft/clearance via spatial-hash vertex distance; hard clashes now report a **real (approximate) penetration depth** (`_estimatePenetrationDepthM` — vertex-inside-mesh ray-parity + true closest-point-on-surface, MTD-style, browser only so far) instead of the old tri-pair SAT chord length; optional escalation to `local-engine.js` for the **same** tri-tri+BVH algorithm at native speed (Numba JIT + multiprocess + scipy KD-tree) — not solid boolean ops, and the Python side doesn't have the new depth estimator yet either (see Known Issues / Active Work)
- BCF 2.1 import/export (viewpoints, markup, snapshots)
- IFC loading via web-ifc WASM (lazy, with geometry + property extraction)
- AI NL command interface (Groq via `/api/nl`, 25+ tool declarations — grew well past the "13" once quoted here, check `TOOLS` in `api/nl.js` for the live count — OpenAI function calling; intentionally basic — clash-solving nudges to your own LLM via the Connector)
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
- Render style hotkeys 1–5 (standard/shaded/rendered/x-ray/wireframe)

**Backend (Vercel serverless + Neon Postgres):**
- `/api/nl` — Groq NL proxy (Groq-only; Gemma dropped). Basic tier; clash-solving nudges to the own-LLM Connector
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
| founding | Three.js r128 (pinned, not latest) — *superseded 2026-06-08, see r180 row below* | API stability; newer versions break existing render/material code |
| 2026-06-08 | Three.js bumped r128 → r180, loaded as ESM via import map (#595, v5.19.12) | Unblocks modern-Three features (splat addon dedup, future WebGPU clash path); post-r155 color management/lighting explicitly re-tuned |
| founding | In-browser clash engine: AABB broad-phase + BVH tri-tri narrow-phase (legacy name "OBB engine" is a simplification — orientation only enters via the slimline-axis prune for directional elements). `_ccWasmIntersect`/`_ccWasmMinDist` accelerate when loaded. Optional `local-engine.js` addon escalates to the local Python server for the same tri-tri+BVH algorithm at native speed. *(Corrected 2026-07-13: this row previously claimed the Python engine does "true solid boolean ops" — verified false by reading `ClashControlEngine/src/clashcontrol_engine/intersection.py`; it runs the identical Möller tri-tri + dual-BVH algorithm as the browser, just faster via Numba JIT + multiprocess + scipy KD-tree. Escalating buys speed, not more-correct geometry — see IMPROVEMENT_PLAN.md CW-1 for the plan to make it genuinely more exact via real penetration depth + `manifold3d` intersection volume.)* | Tri-tri is the browser sweet spot: tighter than AABB-only (kills false positives on rotated beams/pipes), fast enough for thousands of pairs in JS, and has a clean WASM acceleration path. The Python engine gives the same algorithm the CPU headroom (multi-process, JIT) a browser tab can't. |
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

- **Three.js r180 API** (was r128 until v5.19.12): use r180 docs. ESM via import map — no UMD `<script>` tag anymore. Post-r155 color management and light-intensity behaviour are deliberately tuned in the renderer setup (e.g. rendered-mode exposure 0.4); don't "correct" them back to library defaults.
- **View cube mirroring**: The nav cube MUST use `cubeGroup.quaternion.copy(camera.quaternion).invert()`. Camera-position approach causes left/right mirror. Don't "fix" this.
- **web-ifc WASM hang**: A 10-second timeout detects WASM init hangs (slow connections). Don't remove this guard.
- **IFC unit scale**: Storey elevations from IFC are often in mm; geometry is in metres. Always apply `geoFactor` when converting. Walk mode and 2D sheet have fixed this.
- **Ghost material is shared**: `MeshBasicMaterial({color:0x334155, opacity:0.08})` is one instance shared across all ghost meshes. Don't dispose it per-mesh.
- **`invalidate()` required**: Any visual change (material swap, visibility, highlight, grid, ghost) needs `invalidate()` or it won't render until the next interaction.
- **Render loop skips GPU work**: `_needsRender` counter > 0 means render. Counter decrements each frame. Call `invalidate(N)` for N frames of rendering.
- **Addon guard required**: Core code calling addon functions must guard with `typeof window._ccFoo === 'function'`. The app must work without addons.
- **Service worker excludes `/api/*`**: Don't add API paths to the SW cache list.
- **NL pre-block**: Conversational messages that look like commands are allowed through to Groq. Don't make the pre-block over-eager.
- **2D annotation coordinates**: Fixed in v4.15.4. Coordinate bug was in annotation placement — if re-implementing annotation rendering, test coordinate transform carefully.
- **IFC spatial hierarchy is NOT a clash-pruning filter**: `IfcProject → IfcSite → IfcBuilding → IfcBuildingStorey → IfcSpace` is logical containment, not proximity. Real geometry spans containment boundaries (vertical ducts cross storeys, foundations sit between site and building, stairs intersect two slabs). Pair pruning must come from the AABB broad-phase / spatial index, not from shared spatial parent. Don't be tempted to "speed up" detection by filtering pairs that share an IfcBuildingStorey only.
- **`scripts/update-memory.py` `replace_section()` must use a callable `re.sub` replacement, not a string one.** A string replacement lets `re.sub` interpret backslashes as group references; this file's own prose contains literal sequences like `\i \c` (documenting XSD regex escapes in the IDS engine notes) which crashed the daily-sync job with "bad escape \i" on every run since it was written — silently, because nothing surfaced the failure. This is why the Project State version line went stale for a month (fixed 2026-07-08). If you see the version line drift again, check the Actions run for this workflow first.
- **Coplanar triangle pairs are deliberately NOT reported as clashes**, in both the browser JS engine (`index.html`, `_triTriTest`) and the Python engine (`intersection.py`, `tri_tri_intersect`). Flush surface contact (a wall base sitting in a slab's top-face plane) is universal in real models — treating it as a hard clash would flood every project with false positives. This is a policy choice, not a missing feature; the explicit near-zero-`d` early-out also avoids a 0/0 NaN in the interval math. Don't "fix" this by making coplanar overlap report a hit.
- **The browser engine now computes a real (approximate) penetration depth for hard clashes**
  (`_estimatePenetrationDepthM`, 2026-07-13, CW-1a) — vertex-inside-mesh (3-axis ray-parity, majority vote)
  + true closest-point-on-surface (Ericson's algorithm), maxed over both sides, MTD-style. Falls back to
  the old tri-pair SAT-chord estimate, then the AABB-overlap estimate, when it can't tell (open/
  non-manifold mesh, or a graze where no vertex of either side is actually inside the other — e.g. a thin
  post clean through a slab; a real documented limitation, not a bug). It's still an *approximation*
  (vertex sampling, not a true solid intersection) — good enough to build the "hard clash, penetration ≥
  10mm" default floor on top of, not good enough to call "exact."
  **The Python local engine does NOT have this yet** — its `penetration_est` is still the old
  AABB-overlap *upper bound* (`intersection.py`, `meshes_intersect_prepared`). Escalating to the local
  engine today for "more accurate depth" would currently give you a WORSE number than the browser already
  computes for free — port the same technique there next (CW-1a Python half), then layer the `manifold3d`
  exact-volume tier on top (CW-1b) — see `IMPROVEMENT_PLAN.md` CW-1 / Wave 1.5. Don't build a triage/
  severity feature on top of `overlapVolM3`/`penetration_est` as if they were trustworthy depth numbers —
  only the browser's `distance` field is real now, and only for hard clashes.
- **The Python local engine is NOT "exact" in the sense of solid boolean ops** — it runs the identical
  Möller tri-tri + BVH algorithm as the browser (`intersection.py`/`sweep.py`), just faster (Numba JIT,
  multiprocess, scipy KD-tree). Escalating to it today buys speed, not more-correct geometry. See the
  corrected Architecture Decisions row above and `IMPROVEMENT_PLAN.md` CW-1.
<!-- END:known-issues -->

<!-- BEGIN:active-work -->
## Active Work

Update this section at the start and end of each session.
Mark completed items with ~~strikethrough~~ and date, then let the daily sync archive them.

On branch `claude/clashcontrol-competitive-analysis-gra92c` (2026-07-13) — competitive analysis vs
Solibri/Navisworks/OSS (IfcOpenShell, ThatOpen, xeokit, Speckle, BIMcollab, Revizto, buildingSMART IDS)
+ Wave-0 correctness fixes:

- **`IMPROVEMENT_PLAN.md` added** — full analysis + 6-wave roadmap. Thesis (evidence-backed): CC already
  has the pro FEATURE set (cross-run clash reconciliation `computeClashIdentityKey`/`mergeDetectionResults`
  is comparable-or-better than Navisworks' GUID matching, clustering, BCF 2.1/3.0, workspace-aware
  inspector, ahead-of-bar measurement snapping) — the gap vs competitors is **honesty** (fake penetration
  depth, phantom `minGap`, exact-engine silently dropping rules, hollow BCF viewpoints, quality score
  skipping checks shown in its own panel), **noise** (no default clash matrix/tolerance floor → 10k-clash
  first runs), and **feel** (dead orbit-pivot bug, AO/edges built-but-disabled). Waves 1-6 (triage funnel,
  review loop/camera feel, BCF fidelity, search sets, IDS conformance, scale) are roadmap, not yet built.
- ~~**Wave 0 correctness fixes, 9 items, each its own commit + test where the fix is pure logic**~~ (2026-07-13):
  - ~~Orbit pivot recenters to selection~~ — `sph.setFromVector3` on a plain `{r,phi,theta}` object silently
    threw and was swallowed; camera always orbited the pre-selection target. `ab5e5a2`.
  - ~~Model visibility toggle no longer needs a camera nudge~~ — the manual per-mesh culling pass
    (`updateCulling`) throttles to 1-per-8 rendered frames; a bare `invalidate()` (2 frames) wasn't enough
    to cross that gate, so re-shown models stayed individually `.visible=false` until orbiting kept
    invalidating long enough. New `S._forceCull` bypasses the throttle once per models-list change.
    `204a039`. (Found live mid-session from a user bug report, not the original research pass.)
  - ~~`minGap` actually applies~~ — collected/displayed everywhere but never checked; `isSoft` only tested
    the upper bound. Now `[minGap, maxGap]`. `623727a`.
  - ~~Local-engine rule parity~~ — `_serializeForLocalEngine` sent only modelA/B+maxGap+a `mode` field the
    browser's rules object never sets (always fell through to `'hard'` — a configured soft-only run
    silently ran hard-only on the exact engine). Now sends the full scalar rule set + pre-filters
    `IfcSpace` client-side; semantic-filter (`relatedPairs`) parity explicitly deferred (needs a payload
    shape change). Engine-repo companion change (apply the new fields in `engine.py`/`sweep.py`) documented
    in `IMPROVEMENT_PLAN.md`, not yet done in that repo. `739af54`.
  - ~~Assignee/priority survive re-runs~~ — `mergeDetectionResults`' persisting-clash branch carried status/AI
    fields/linkedIssueId forward but not `assignee`/`priority`. `ff02b09`.
  - ~~JS/WASM hit-point parity~~ — JS validated candidate points against both elements' AABBs±10mm before
    accepting a hit; the WASM path returned its raw point unvalidated, so results (and even hit/miss)
    could differ depending on whether WASM loaded. Extracted `_pointInBothBoxes`, gated both paths on it.
    `e020f1a`.
  - ~~Quality Score includes BIM-basics~~ — `computeQualityScore` only ever folded in
    `runDataQualityChecks`+accessibility. `runBIMModelChecks` now always folds in (generic, region-neutral).
    `runILSChecks` (Dutch NL-BIM Basis ILS v2) is nuanced: `noNLSfB` has no IfcType gating, so an
    unadopted-NL-SfB project would score near-zero on a standard it never uses — ILS now always shows as
    its own breakdown category but only counts toward the headline number once the project shows real
    adoption (≥20% of elements carry a code). IDS deliberately not touched (different result shape,
    belongs with Wave 5). `fcad866`.
  - ~~Render key 5 = wireframe~~ (was a duplicate of xray; wireframe had no key) + ~~walk-mode postFX fixed~~
    (`_walkEnter` turned SAO/Outline/SMAA on synchronously but only when the pre-walk style wasn't already
    `'rendered'`, and even then the `renderStyle:'rendered'` dispatch's own re-render immediately re-ran the
    normal-mode "disable postFX, it blurs" effect right after — walk mode never actually got it). `55ca009`.
  - ~~Stable discipline colors~~ — `byDiscipline` color-by assigned colors by element-count rank
    (`CLASS_COLORS[idx]`), not by what the discipline IS — structural could be blue in one federation, red
    in another, never matching the app's own `DISC` semantic map used elsewhere. New `DISC_COLOR_BY_ID`
    lookup used by both the 3D scene and the Navigator panel dots; other views (byType/byStorey/byMaterial)
    unchanged. `fe33b2e`.
  - Doc drift fixed: MEMORY.md's Project State + Architecture Decisions both claimed the Python local
    engine does "true solid boolean ops" — verified false by reading `ClashControlEngine/src/
    clashcontrol_engine/intersection.py` directly; it runs the identical Möller tri-tri + BVH algorithm as
    the browser, just faster (Numba JIT + multiprocess + scipy KD-tree). Corrected both rows.
  - Verification: `npm test` (83/83 passing, up from 68 — 4 new test files, each extracting real
    production code out of `index.html`/addons the same way `tests/ifc-units.test.js` does, not
    reimplementing the logic under test), main-script parse via `new Function` after every edit. NOT
    browser-verified (Playwright/CDN blocked in this sandbox per prior sessions) — the detection-engine
    changes (`minGap`, WASM/JS parity) and the culling-throttle fix in particular need a real browser
    pass; flagged in each commit message.
- 3 sibling repos cloned into the session for reference (`ClashControlEngine`, `ClashControlConnector`,
  `ClashControlSmartBridge` — the last is confirmed superseded, see its own README banner). Engine's
  `intersection.py`/`sweep.py` read directly to ground CW-1 (real penetration depth + `manifold3d`
  intersection volume — Wave 1, not started) and the local-engine parity fix above.
- PR #679 opened (draft), `subscribe_pr_activity` on. User then said "go full throttle to the end" (execute
  Waves 1-6 autonomously, no further check-ins) and "pile it into one PR, or multiple only if they get big"
  (stay on #679 unless a piece of work is large enough to need its own — `ClashControlEngine` is the one
  structural exception, separate repo). Continuing on the same branch/PR:
- ~~**Wave 1.1-1.3: the default clash matrix (the triage funnel's first, highest-leverage lever)**~~
  (2026-07-13):
  - Per-element discipline classification: `_DISC_TYPE_MAP` (flat IfcType→discipline, extracted from
    `detectDiscipline`'s inline tables, behavior-preserving) + `_ccElementDiscipline(el, modelDiscipline)`
    (discriminating type wins, else falls back to the model's own vote) — closes the per-model-granularity
    gap a combined STR+MEP IFC file had (one label for the whole model). `22bdb80`.
  - Default matrix: `rules.excludeSameDiscipline` (default true) + `rules.disciplineMatrix` (sparse
    `"discA:discB"` override map) + `_ccMatrixSkipsSameDiscipline(...)` wired into both the chunk
    pre-filter and `_processCandidate`'s authoritative check. `1aac245`.
  - Matrix UI: 5×5 triangular grid in `ClashRulesPanel` advanced section, click-to-toggle any cell.
    `6ef0e6c`.
  - **CRITICAL FIX same day, caught by `browser-smoke` CI, not by me**: the default matrix skipped
    same-*discipline* pairs, but the smoke fixture is two crossing walls in ONE model — both fall back to
    that model's single discipline, so they read as "same discipline" and got skipped, reporting 0 clashes
    on a real physical overlap. Same-discipline is a *cross-model* federation-noise concept; a same-model
    self-clash is a data-integrity error and must never be suppressed by it. Added a `sameModel` param to
    `_ccMatrixSkipsSameDiscipline`, checked *before* any discipline/matrix logic, always wins. `e7c4100`.
  - 17 tests in `tests/discipline-classification.test.js` (incl. the `sameModel` regression) + 3 in
    `tests/discipline-colors.test.js`.
- ~~**Wave 1.4: real (approximate) penetration depth — CW-1a**~~ (2026-07-13). The user's explicit
  directive from earlier in the session ("escalating to \[the local engine\] gets you speed, not
  fundamentally more correct geometry") committed this as its own workstream. What hard clashes reported as
  "depth" was `_triTriTest`'s 4th return value — the SAT overlap-interval length of *one* colliding triangle
  pair along their cross-normal axis, maxed across all colliding pairs. Real number, not penetration depth:
  long for a shallow graze between two big triangles, shrinks on fine tessellation regardless of true
  overlap. New `_estimatePenetrationDepthM(elA, elB)`: for each mesh's vertices that ray-parity-test as
  *inside* the other mesh (3-axis majority vote against its BVH), find the true closest-point-on-surface
  distance (Ericson's algorithm, not nearest-*vertex*) to the other mesh; max across both sides ≈ true
  penetration (MTD-style approximation). Runs only on confirmed hard-clash pairs (post tri-tri), never the
  broad-phase set. Null (open/non-manifold mesh, or a graze where no vertex of either side is actually
  inside — e.g. a thin post clean through a slab with both meshes' corners outside each other, a real
  documented limitation) falls through to the old chord-length estimate, then the AABB-overlap estimate —
  same fallback shape as before, just with a genuinely better first tier.
  **Caught a real bug pre-commit**: casting the parity rays exactly axis-aligned is the worst possible
  choice for *this* codebase specifically (IFC geometry is overwhelmingly axis-aligned) — a ray from the
  exact center of a symmetric test cube landed precisely on a shared triangle edge on all 3 axes at once,
  and the ray-triangle test's inclusive edge tolerance double-counted that one crossing (once per triangle
  sharing the edge), flipping odd parity to even — reporting the center of a unit cube as *outside* it, and
  no majority vote could catch it since all 3 axes failed identically. Fixed by casting along small fixed
  off-axis tilts instead of pure axes (also lets the BVH node-prune use a standard generic slab test, since
  no direction component is ever exactly 0 anymore). `e8425ea`. 16 analytic-solid tests in
  `tests/penetration-depth.test.js` (offset cubes, a post partially into a slab, the full-through-slab null
  case, disjoint cubes, a symmetric fully-contained cube) — verified against hand-computed expected depths,
  not just "doesn't throw."
  **Not yet done: the Python-engine companion (CW-1b, same technique + `manifold3d` exact-volume tier) — a
  separate repo (`ClashControlEngine`), needs its own PR per the branch-scoping rule.**
- ~~**Wave 2.1, 2.3, 2.5, 2.6 — camera/review-loop feel**~~ (2026-07-13):
  - Zoom-out now honors the cursor too (mirrors the existing zoom-in-to-cursor branch: retreat the target
    away from the picked point and grow `sph.r`, instead of the old pure `sph.r *= zoomFactor` around
    whatever the orbit target happened to be). `bd37b37`.
  - Shift+left-drag = pan fallback (was middle-mouse-button only — no trackpad path at all). Checked for
    key collisions first: Ctrl/Cmd is multi-select on click, Shift is unclaimed on the orbit canvas's own
    mousedown handler. Added a "Mouse" section to the shortcuts modal (orbit/pan/zoom had zero in-app
    documentation before this). `49a7bc8`.
  - Double-click-to-frame turned out to already exist (`index.html` ~7996, predates this session) — no
    work needed, closes that Wave 2.3 item. Present-mode click-to-frame ("present is inert") turned out to
    already be *intentionally* disabled with a clear rationale ("read-only walkthrough; framing fights the
    user") — the Wave-0 orbit-pivot fix (unconditional, runs before the fly-gate) already made present-mode
    clicks meaningful again (recenters the pivot for subsequent drags), so no further change — overriding a
    deliberate, commented design decision based on stale pre-Wave-0 research would have been wrong.
  - On-canvas color legend (`ColorLegend`, bottom-left of the viewport) for `colorByClass` views — swatch/
    label/count next to the model instead of only in the side-panel Navigator list (BIMcollab Smart-View
    parity). Sort + color-index logic copied verbatim from the 3D scene tint effect so it can't drift.
    `bbc5717`.
  - Distinct A/B clash-pair colors: `_itemRefs` already tagged each ref `role:'A'`/`'B'`, but
    `_highlightRefs` only ever colored by model discipline — so same-discipline pairs (incl. every
    same-model self-clash) highlighted both sides identically. `_highlightRefs` now checks `ref.role` first,
    fixed red/cyan for A/B, falling back to discipline color for every other caller (verified `_itemRefs` is
    the only producer of role A/B anywhere in the file). `77bd6f8`.
  - Keyboard status hotkeys (C/D/V = confirm/deny/accept-check) reuse the exact
    `_ccPrepareAdvance`→`UPD_CLASH`→`_ccAdvanceToNext` sequence the existing mouse-only buttons already used
    — J/K → C/D/V is now a full keyboard-only triage loop. Added a "Clash triage" shortcuts section (J/K/
    Tab/T/R/X/'/' had none either). `46eb1c9`. Together, tween-frame + isolate/ghost(~12%) + J/K all already
    existed; A/B color + status hotkeys were the two actually-missing pieces of "Wave 2.1: clash focus
    state."
  - Wave 2.2 (occluder-reveal toggle) and 2.4 (edges/SSAO in normal viewing) intentionally deferred —
    ghosting already gets most of 2.2's value now that it exists, and 2.4 is explicitly the highest-risk
    remaining item per this file's own history-informed guardrails (renderer/tone-mapping touchiness).
- ~~**Wave 1.6: deterministic severity model**~~ (2026-07-13). `aiSeverity` (critical/major/minor/info)
  already drove sort/group-by/cluster-dot/row-dot, but it's only ever set by opt-in AI actions — every one
  of those sites fell back to a flat per-*type* guess when absent (every hard clash the same critical-red
  dot, tied for the same sort rank, no matter the actual depth or discipline). New
  `_ccDeterministicSeverity(c)` uses the real depth from CW-1a + per-element disciplines (max of the pair,
  not an average) to produce a real critical/major/minor/info verdict for every clash; every site above now
  reads `c.aiSeverity || _ccDeterministicSeverity(c)`. Tracing every fallback site to wire this in
  consistently turned up **3 independent, real, pre-existing vocabulary bugs**, all fixed in the same
  commit: the AI triage prompt asked for `critical|high|medium|low` against display code that only
  recognizes `critical|major|minor|info` (so a compliant AI response would render with no color); a
  cluster-summary table's own rank map used the same wrong vocabulary (major/minor always fell through to
  rank 0); and `severity_asc`/`_desc`'s `o[a.aiSeverity]||2` silently mistreated every *critical* clash as
  rank 2 (tied with minor) because `'critical'` ranks `0`, which `||` reads as falsy. `551011e`. Also:
  `disciplines:[mA.discipline,mB.discipline]` (whole-model, stale even after Wave 1.1) →
  `_ccElementDiscipline`-based (per-element) — the same upgrade the clash matrix got, this separate
  display/severity field had never received it. `e22301a`. 13 tests in `tests/severity-model.test.js`.
  **Found but deliberately deferred**: `rules.excludeSelf` defaults to `true` app-wide (confirmed
  consistent across `INIT.rules`, every preset, and the NL-command layer — not an oversight, a real design
  choice), meaning a project that's a single combined IFC file finds **zero** clashes on the very first,
  most prominent "Run detection" click, with no visible explanation why. Touches dozens of call sites
  (NL parsing, presets, `_captureDetectionSettings`) — needs its own focused pass, not a bolt-on.
- ~~**Wave 1.9: one-click run — verified already substantially satisfied, no changes needed**~~ (2026-07-13).
  Checked `RunDetectionModal`/`ClashRulesPanel` against the plan item ("auto-matrix + defaults + funnel;
  existing panel becomes Advanced") before building anything new: the modal already leads with 6 one-click
  preset buttons + a single prominent "Run detection" footer button that runs with whatever `s.rules`
  currently is, and both the matrix/tolerance editor and "Project standards" are already collapsed behind
  an Advanced toggle by default. Wave 1.2's new default clash matrix means even the bare "Run detection"
  button (zero configuration) now runs with sane discipline filtering out of the box. The `excludeSelf`
  single-model gap above is the one real first-run trap left, and it's already logged separately.
- ~~**Wave 1.7: show the detection funnel**~~ (2026-07-13). The default clash matrix (Wave 1.2) already
  filters same-discipline noise on every run, but nothing surfaced that it had happened outside the
  developer-only diagnostics panel. New `matrix_skipped` counter on the existing detection-profile object
  (one counter, one increment site — the WASM chunk-warmup pre-filter re-tests the same matrix check as a
  cache-population shortcut but every candidate still reaches the authoritative check in
  `_processCandidate`, so counting only there avoids double-counting), shown as a new diagnostics-panel
  row. More importantly: new `_showFunnelToast()` shows a one-line "N pairs checked → M filtered by
  discipline matrix → K clashes found" toast to *every* user after *every* browser-engine run, no
  diagnostics flag needed — hooked into `_browserDetect`'s own promise chain (the one function all 9
  `detectClashesAsync` call sites funnel through) rather than touching each site, and only reads
  `window._ccDetectProfile` right after that run set it so it can't show a stale number or leak in when
  the local engine (which doesn't populate that global) handled the run. `f63743b` (PR #680 — #679 merged
  mid-session, branch restarted from the new `main`, see below). 6 tests.
  Wave 1.8 (spatial sub-clustering) and the `excludeSelf` single-model default trap remain deferred — same
  reasoning as before (1.8 needs its own careful opt-in design, not a change to default grouping behavior;
  `excludeSelf` touches dozens of call sites).
- **PR #679 merged to `main` by explicit user instruction** ("merge to main. Continue with the to do's")
  mid-session — squash-free `merge` method to preserve the granular one-fix-per-commit history. Per the
  branch-restart convention, the designated branch was reset to the new `main` and PR #680 opened for
  continued work — its diff is scoped to genuinely new commits (confirmed via `merge-base --is-ancestor`
  before any push) rather than re-showing everything from #679. **Note for future sessions**: a
  `force-with-lease` push during that reset was correctly blocked by the auto-mode classifier (the user's
  merge instruction didn't name that specific destructive op) — the clean fix was cherry-picking the one
  new commit onto the *old* (pre-reset) branch tip instead of onto the new `main`, since the old tip is now
  an ancestor of `main` (regular merge, not squash) and a plain fast-forward push needs no force at all.
- ~~**Wave 3.1: BCF viewpoints write `<Components><Selection>`**~~ (2026-07-13). The single biggest audited
  interop gap: CC's BCF *exporter* wrote only `<PerspectiveCamera>` — no `<Components>` — so a CC-exported
  BCF had no selectable elements in Solibri/BIMcollab/Navisworks, or even CC's own *importer*, which
  already parses `<Component IfcGuid=...>` out of viewpoint files on the way in and has for a while. Every
  exported topic now carries `<Components><Selection>` populated from the item's own identity data
  (`globalIds`/`globalIdA`/`globalIdB`, deduped) — no new capture-side work needed, this data already
  existed on every clash/issue. Placed before the camera element per the BCF schema's element order.
  `34dc868`. 4 new tests in `tests/bcf-export.test.js` (element order, dedup, the no-identity-data case,
  round-trip shape against CC's own importer).
  **Deliberately narrow scope, two related gaps left for follow-up**: (1) issues with no linked, user-saved
  viewpoint still get **no `.bcfv` file at all** — probably the common case for a quick "export these
  clashes" action, since most users don't manually save+link a viewpoint per clash first. Fixing that means
  synthesizing a reasonable default camera position from just a clash `point`, which needs its own careful
  design (existing "frame a point" conventions live deep in the live-render closures, e.g. `_fitToClashes`/
  `_zoomDist`, not yet checked for safe reuse at export time) rather than inventing new framing math under
  time pressure — camera math is exactly the kind of thing this file already warns about getting wrong
  without visual verification. (2) `<ClippingPlanes>` — CC already captures section-plane state on every
  viewpoint (`vp.section`) but never exports it; the existing section-to-world-space conversion math (used
  for live rendering, e.g. around `new THREE.Plane(...)` call sites in the section/section-box effects) is
  deeply coupled to live scene state and wasn't yet confirmed safe to reuse at export time in one sitting.
- ~~**Wave 1.8: spatial sub-clustering**~~ (2026-07-13). The existing `'cluster'` groupBy
  (`_ccClusterKeyFor`) groups touch points between the *same two elements* — a duct crossing one beam at 3
  points along its run correctly collapses to one group, but a duct crossing 5 *different* joists in the
  same corridor bay showed as 5 separate-looking groups, even though it reads as one problem area. New
  `_ccSpatialClusterMap(items, radiusM)`: distance-threshold union-find on clash points (1.5m default),
  grid-bucketed (same spirit as the engine's `_SpatialHash`) for O(n) average. Wired in as a new `'nearby'`
  groupBy dimension ("Location" in the secondary group-by dropdown) — deliberately additive, doesn't touch
  the default "Grouped" (cluster) view. `4ab0bba`. 8 tests (radius boundary, transitive chaining through a
  bridging point — why this needs real union-find not a naive pairwise pass —, unlocated items, label
  stability, grid-bucket neighbor search across a cell boundary).
  **Wave 1 (the triage funnel) is now fully shipped except 1.5** (the Python `manifold3d` exact-volume
  tier — separate repo, hasn't been added to this session's write scope).
- **User redirected priorities mid-session**: asked for a plan on 4 external OpenAEC-ecosystem repos
  (`jochem25/OpenAEC-BIM-validator`, `OpenAEC-Foundation/openaec-reports`, `-bcf-platform`,
  `-monty-ifc-viewer`). Researched via WebFetch (note: GitHub `/tree/<branch>/<path>` sub-paths 404 through
  this session's WebFetch — only repo-root pages and `raw.githubusercontent.com` file content work; also
  cost time discovering `OpenAEC-BIM-validator`'s default branch is `master`, not `main`). Proposed
  build/check/defer/skip; user said **"Build 1 and 3, check number 2"** — RVB BIM Norm port (build), PDF
  reports (build, overriding my own suggestion to defer it), BCF-platform cross-check (investigate only).
- ~~**Build 1: RVB BIM Norm v1.1 port**~~ (2026-07-13). Read `OpenAEC-BIM-validator`'s two public-standard
  `.ids` files directly (`RVB_BIM_Norm_v1.1.ids` 27 specs, `NL_BIM_Basis_ILS_v2.ids` 12 specs, both on
  `master`) — clean-room reimplementation against the standards' requirements, same policy as the existing
  `runILSChecks` comment states (no code copied from the validator). Mapped every RVB spec against CC's
  existing `runILSChecks`/`runBIMModelChecks` coverage first — most of NL-BIM Basis ILS v2 was ALREADY
  covered, often more thoroughly than the reference; work narrowed to the genuine gaps:
  - **Bug found + fixed first**: 7 of `runILSChecks`' 16 buckets (the "NL-BIM Basis ILS v2 additions" —
    storeyNaming, doorNaming, spaceIncomplete, fireRatingInvalid, extWallNoUValue,
    loadBearingInvalidMaterial, mepNoRenovationStatus) were computed every run but never appeared in the DQ
    panel's row list, CSV export, or "Create all issues" action — real findings silently invisible. New
    shared `ILS_KEYS` constant used everywhere the panel touches `ils`. `939693e`.
  - `IfcFurnishingElement` was already checked for NL-SfB presence but missing from `IFC_TO_NLSFB`, so a
    furnishing element miscoded with another discipline's group silently passed the mismatch check. Mapped
    to group 90 (Vaste inrichting), per RVB 2.2.7.11. `41b043a`.
  - `spaceIncomplete` extended: ObjectType, IsExternal (Pset_SpaceCommon), GrossFloorArea/Height
    (Qto_SpaceBaseQuantities) — RVB 2.2.7.6a/6b, alongside the pre-existing Name/LongName/NetFloorArea. A
    space could pass every old check while missing all four new ones. `a43956e`.
  - New IFC loader groundwork (purely additive, no existing field's shape/value changed): `IFCZONE`
    constant (`1033361043`, cross-verified against `ThatOpen/engine_web-ifc`'s `ifc-schema.ts` since 3 of
    the file's other hardcoded numeric IDs matched exactly); `extractSpatialHierarchy` now reads IfcZone
    (RVB 2.2.7.7) and stamps `_hasName` on project/site/building/zone (so a `safeStr(...)||'IfcProject'`
    fallback name can't be mistaken for a real one); `extractStoreys` stamps `hasElevation` (an explicit
    0.0 ground-floor elevation is otherwise indistinguishable from Elevation never being set). `7ee8167`.
  - New `runRVBChecks(models)` engine (addons/data-quality.js) — takes models directly, not a flat elements
    array, since spatialHierarchy/storeyData are per-model: IfcProject Name (2.2.7.1), IfcSite
    Name+georef (2.2.7.2), IfcBuilding Name (2.2.7.3), IfcZone Name/ObjectType for zones that exist
    (2.2.7.7, a model with none is not flagged — IfcZone is optional in IFC), IfcBuildingStorey Elevation
    (2.2.7.4). `f691141`.
  - Wired into `computeQualityScore` via a new `_foldEntityCheckMap` (each bucket carries its OWN `total` —
    project/site/building/zone/storey aren't the same population, so a shared `_total` like
    `_foldCheckMap` uses would misstate every bucket's failure ratio) and into the DQ panel as a new RVB
    section. **Deliberately never folds into the headline score or the panel's top "N issues" badge** — RVB
    is one Dutch central-government client's own norm, narrower even than the already-adoption-gated NL-SfB
    category; "missing IfcSite georeference" shouldn't tank the score of a model never meant to be
    geo-referenced. Reuses the existing `renderCheckGroup` (its "Highlight in 3D" button is a harmless
    no-op for these rows — project/site/building/zone entities aren't matched by GlobalId the way elements
    are — but "+issue" works correctly). `a79f434`.
  - 35 new tests across 6 files (`ils-panel-visibility`, `ils-furnishing`, `ils-space-quantities`,
    `spatial-hierarchy-rvb`, `rvb-checks`, `quality-score-rvb`, `rvb-panel-wiring`); `extractSpatialHierarchy`/
    `extractStoreys` tested via a minimal fake web-ifc `api` (same style as `bcf-export.test.js`'s fake
    JSZip). 194/194 passing.
  - **Not done**: `exportIDS()` (CC's own hardcoded-specs → .ids XML exporter) doesn't yet emit the new RVB
    checks as exportable IDS specs — the check ENGINE is done, the export-as-IDS representation is a
    separate, smaller follow-up if wanted.
- ~~**Check 2: cross-checked CC's BCF handling against `openaec-bcf-platform`'s Rust implementation**~~
  (2026-07-13). Unblocked the prior sub-path fetch failure by fetching `Cargo.toml` first (revealed the
  `crates/bcf-core` + `crates/bcf-server` workspace layout) then `crates/bcf-core/src/{lib,visinfo,
  xml_types}.rs` directly via `raw.githubusercontent.com` — general lesson: when a repo root page works but
  `/tree/<branch>/<path>` 404s, fetch a known-likely file path directly instead of trying to browse.
  Findings: (1) **Components/Selection** — `XmlComponents.selection → XmlSelection.components: Vec<Xml
  Component>` with `#[serde(rename="Component")]`/`IfcGuid`-shaped, structurally identical to CC's own
  exporter/importer convention — confirms round-trip interop, no action needed. (2) **Coloring** — the
  platform DOES model `<Coloring><Color Color="#hex"><Component IfcGuid=.../></Color></Coloring>`; CC
  exports no `<Coloring>` at all (confirmed absent, not just theorized) — a real, now-confirmed gap, logged
  as a candidate follow-up, not built this session (Check 2 was investigate-only). (3) **ClippingPlanes** —
  confirmed ABSENT in this sibling project too (not just CC) — reassuring: CC isn't behind the ecosystem
  here, it's an unbuilt corner on both sides, validates deferring it rather than rushing untested camera
  math. (4) **Element order** — `XmlVisualizationInfo`'s Rust struct field order is `guid → perspective_
  camera/orthogonal_camera → components`, meaning (since their serde+quick-xml-style setup serializes in
  declaration order) their writer likely emits the camera choice BEFORE `<Components>` — the OPPOSITE of
  the true buildingSMART XSD sequence (`Components` → camera choice → `Lines` → `ClippingPlanes` →
  `Bitmap`) that CC's own Wave 3.1 exporter correctly follows (locked by the "precedes the camera element"
  test in `bcf-export.test.js`). Net: CC's own BCF viewpoint schema-order compliance looks MORE correct
  than this sibling tool's on this specific point — a positive validation of Wave 3.1, not a gap to close.
- ~~**Build 3: print-ready Data Quality report**~~ (2026-07-13). Research before writing any code turned up
  a course-correcting discovery: CC already has a mature, working report generator —
  `_ccClashReport(s)` (index.html:19446) — builds a self-contained HTML document (inline CSS, a
  `@media print{.noprint{display:none}}` block, a "Print / Save as PDF" button calling `window.print()`)
  and opens it via `window.open('','_blank')` + `document.write`. A third sibling,
  `generateValidationReport`, already covers IDS specs. So the real gap wasn't "CC has no report feature,"
  it was "Data Quality has no report feature" (only CSV export). Built `_ccDataQualityReport(s)` as a
  fourth report using the *identical* pattern (deliberately did not invent a shared modal/print-CSS system
  — see the superseded plan below) — Quality Score + breakdown, General/BIM-basics/ILS/RVB check tables,
  accessibility pass/fail, models table. Self-sufficient like `_ccClashReport` (re-runs the check engines
  from `s.models` directly, doesn't depend on `DataQualityPanel`'s own React state having already run).
  Wired into two entry points: a new "⎙ Print report" button in the DQ panel (renamed the pre-existing CSV
  button off the now-ambiguous "↓ Export report" to "↓ Export CSV"), and a new "⎙ Data quality report"
  entry in `IssuePanel`'s Export flyout next to the pre-existing "⎙ Clash report". 12 new tests across 2
  files (function-body extraction + sandboxed stub engines, same style as `bcf-export.test.js`; a grep-based
  wiring lock for both entry points). 206/206 passing.
  **Superseded plan, kept for the record**: before finding `_ccClashReport`, the plan was a jsPDF CDN
  dependency — dropped because this sandbox's CDN fetches 403 (couldn't self-verify an SRI hash, and a
  wrong hardcoded one would silently break the feature for every user), then a from-scratch
  modal+`window.print()` system — dropped once `_ccClashReport` showed the project already has a proven,
  simpler, dependency-free convention for exactly this. Lesson: grep for `window.print` /  `@media print`
  /  `⎙` before designing a new report/export feature from scratch — this file already has three.
- ~~**Fixed the `excludeSelf` single-model default trap**~~ (2026-07-13). `rules.excludeSelf` defaults
  `true`, and one-click "Run detection" runs with whatever rules currently are. For a project with only
  one combined IFC model (a common federated-export shape), `grpA`/`grpB` both resolve to that single
  model, so "cross-model only" always yields zero pairs by construction — the single most prominent
  first-run action silently reported "0 clashes" regardless of real physical overlaps. Fix is inside
  `_sweepAndPrune` (index.html:4605, takes `grpA`/`grpB` directly — no refactor needed to reach the right
  scope): reuses the `seenModels` map it already builds when merging `grpA.concat(grpB)` into `items`, and
  when that union collapses to exactly one model, forces `selfAllowed = true` for the same-model gating
  branch — covers both "only one model loaded globally" and a run explicitly scoped to one model on both
  sides (NL command / preset), since both collapse the same way. Deliberately does NOT mutate
  `rules.excludeSelf` itself (an effective-only override), so the dozens of UI/NL-command/preset call
  sites that SET it keep working unchanged, and multi-model behavior is provably unaffected (locked by a
  same-model-pair-must-still-be-excluded regression test). 7 tests extracting the real `_sweepAndPrune`
  (plain `{min:{x,y,z},max:{x,y,z}}` boxes, no THREE.js needed). `6d4ed0f`. 213/213 passing.
  **Companion follow-up, not done here**: the local ("exact") Python engine has the same trap in its own
  model-scope resolution — `_serializeForLocalEngine` (`addons/local-engine.js:586`) passes
  `rules.excludeSelf` through as-is and doesn't have access to the resolved `grpA`/`grpB` (it serializes
  ALL passed-in models unconditionally and lets the Python engine do its own `modelA`/`modelB` string
  resolution server-side), so the equivalent fix belongs in `ClashControlEngine`'s own sweep/scope code —
  a separate repo, out of this session's write scope, same situation as the Wave-0 local-engine rule-parity
  fix.
- ~~**Wave 4 (partial): copyable inspector IDs + Navigator real find**~~ (2026-07-13). Continuing "go full
  throttle to the end" past the user's explicit redirect (Build 1/3, Check 2) and the excludeSelf fix,
  back onto the roadmap:
  - **Copyable GlobalId/Express ID**: both were plain, unselectable-feeling text in the Details inspector
    (Coordinate's full Identity card + Present mode's truncated Quick identity card). New shared
    `_ccCopyToClipboard(text, label)` (clipboard API + execCommand fallback, toast confirmation instead of
    AIChatPanel's copyMsg per-index state, since these call sites have no natural index) wired via a small
    `_copyBtn` helper in `renderDetails`. The truncated Present-mode row copies the full untruncated
    GlobalId, not the visible ellipsis text. `3eca120`.
  - **Navigator search, two bugs found by reading the code before touching it, not just the one in the
    plan**: (1) every element-search call site (spatial view, tree/"Flat list" view, its keyboard-nav
    duplicate for arrow-key traversal, and `_findAndHighlightElements`/Items Finder used by NL commands)
    duplicated its own 2-6 field inline check — none matched GlobalId, so pasting a GlobalId from a BCF
    issue into the search box found nothing; none matched property/quantity VALUES either. (2) **bigger
    find**: the default "Hierarchy" (spatial) view — `viewMode==='spatial'`, what every new user sees
    first — never read `treeSearch` at all; `stEls`/`noSt` were rendered fully unfiltered, so the search
    box had literally zero effect in the default view. Only the secondary "Flat list" view actually
    filtered anything. New shared `_elMatchesSearch(el, q)`: name/ifcType/expressId (pre-existing) +
    GlobalId/ObjectType/material/description/storey + every pset/quantity value. All 5 call sites
    migrated onto it (removing the duplication as a side effect); spatial view now computes `q` and
    filters `stEls`/`noSt` like the other views always should have. Storey render caps (200/100 elements)
    widen to 1000/500 while actively searching — search is exactly the case where seeing more matters more
    than DOM-node headroom. `da26294`. 14 new tests across 4 files (matcher unit tests + grep-based wiring
    locks confirming no stale duplicated matcher text remains and the spatial view specifically computes
    `q`). 231/231 passing.
  - **Deliberately not done**: a "flat cross-model results list" (today's results still nest inside the
    per-model/per-storey tree, just correctly filtered now) and auto-expand-on-search (matching a node
    still requires manually expanding its ancestors, same as before) — both bigger, separate UX redesigns,
    not part of this fix's scope.
  - ~~**Selection Sets: rename + `+`/`−` membership editing**~~. `REN_SELSET` had a reducer case but
    genuinely zero dispatch call sites anywhere in the app — no rename button existed at all. Click a
    set's name to rename (wires the existing action). New `UPD_SELSET_REFS` reducer case (a dedicated case
    rather than delete+re-add, so a set's `createdAt`/`color` aren't reset by editing membership) backs new
    `+`/`−` buttons that add/remove the current selection from an already-saved set. `b89cd1e`.
  - ~~**Containment breadcrumb + hosted elements in the Details inspector**~~. The Coordinate workspace's
    Identity card only ever showed a bare storey string — no Project/Site/Building chain, no way to see
    what an element is hosting (e.g. a wall's doors/windows) — despite both data sets already existing
    (`spatialHierarchy` from `extractSpatialHierarchy`, `hostId` from the loader). New breadcrumb (each
    level included only when unambiguous — 0 or 2+ sites/buildings are omitted rather than guessed, with a
    fallback to the old plain row when nothing resolves) + a "Hosted elements" card, click to highlight /
    double-click to frame (same convention as the Navigator tree's own element nodes). `63534de`.
  - 17 more tests across 4 files this round (block-extraction + grep wiring locks). 248/248 passing.
  - **Still unstarted**: dynamic/re-resolving "search sets" (save a classification filter as a named query
    that re-evaluates against the live model, distinct from today's static snapshot-of-refs sets) and
    element-vs-element compare/diff (`multiSel` + `PropBlock` already exist and are used as stacked A/B in
    the clash panel — reusing them for an aligned diff view is the natural next step, just not started).
- ~~**Element-vs-element property diff (Wave 4)**~~ (2026-07-13). `multiSel` (Shift-click) + `PropBlock`
  already existed but only ever stacked two elements' properties as separate A/B blocks (`ClashProps`) —
  nothing aligned them side by side or flagged which actually differ. New `_diffElementProps(pA, pB)`:
  aligned rows for identity fields + the UNION of both sides' quantity/pset keys, so a property only one
  element carries shows as a row with the other side marked missing rather than silently dropped. New
  `PropDiffView` (3-column table, differing rows highlighted) wired into `NavigatorPanel`: selecting
  exactly 2 elements shows "Compare selected (2)". **Real bug found while wiring it up**: `_lookupElProps`
  required an exact `modelId` match, but Selection Sets/Navigator `multiSel` refs never populate `modelId`
  in practice (only one call site in the whole file ever sets it, and even that one falls back to `null`)
  — the new Compare view would have silently shown nothing. Fixed by falling back to searching every model
  by expressId alone, matching `_findMeshByRef`'s existing lenient convention exactly; `ClashProps` (the
  only pre-existing caller) is unaffected since clash items always carry real model ids. `3d725af`. 12
  tests across 2 files. 260/260 passing.
  **Process note for future sessions**: an `Edit` tool-call embedded a stray `\x01` control byte in place
  of an intended plain delimiter inside a hand-written string-join key (`setName+'\x01'+k`), which silently
  broke `Object.keys(...).sort()` grouping — caught immediately by re-running the exact-match `Edit` (it
  correctly refused to match, since the file's real bytes didn't equal what was intended) rather than by
  a test. Fixed via a small Node one-off (`cat -A` to confirm the exact byte, then `String.split/join` in
  a `node -e` script) instead of fighting the Edit tool's literal-text matching against an uncopyable
  control character. Lesson: if `Edit`'s exact-match unexpectedly fails on text you just read verbatim,
  suspect a hidden/control character before assuming a stale read — `cat -A` (or `od -c`) confirms it in
  one step, and a `node -e` `String.split/join` script sidesteps needing to type the character at all.
- **Wave 4 is now substantially done**: real find, copyable IDs, containment breadcrumb + hosted elements,
  Selection Set rename/`+`/`−` editing, and element-vs-element diff all shipped this session. **Still
  unstarted**: dynamic/re-resolving "search sets" (save a classification filter as a named query that
  re-evaluates against the live model — today's sets are still a static snapshot-of-refs; this is a
  bigger, separate feature: query definition UI + a live re-resolution engine + wiring into the clash-scope
  picker, not attempted this session).
- ~~**DQ re-run reconciliation (Wave 5)**~~ (2026-07-13). Clash detection has had full GUID-identity
  reconciliation (new/persisting/auto-resolved) since `#638`; Data Quality re-runs just overwrote the prior
  result with no trend at all — running the DQ panel twice gave no sense of whether things got better or
  worse. A true per-element identity diff (GlobalId × checkId) would need every check bucket to also return
  an uncapped GlobalId list — today `ex` is deliberately capped at 6-8 items for display, so that would be
  an engine-shape change across all four check engines (qc/bim/ils/rvb). Reconciled at the check-COUNT level
  instead ("was N, now M" per bucket), which needs no engine-shape change: new `flattenDQCounts(results)` /
  `diffDQCounts(current, previous)` (`addons/data-quality.js`, exposed as `window._ccFlattenDQCounts`/
  `window._ccDiffDQCounts`) flatten all four engines into one map keyed `engineName:bucketKey` (prefixed so
  same-named buckets in different engines, e.g. two different `noMaterial` checks in `qc` vs `ils`, never
  collide), then diff two snapshots into `{worse[], better[], unchangedCount}`, sorted by largest swing
  first. Wired into `DataQualityPanel.runChecks()`: computes `newQc`/`newBim`/`newIls`/`newRvb` as named
  locals (needed so they can be flattened before the setters run), flattens+diffs against the previous run's
  snapshot (`null` on the first run — nothing to compare against), stores the new snapshot as "previous" for
  next time. New "Since last run: N worse, M better" summary line under "Last checked", expandable (reusing
  the existing `expanded[...]` section-toggle pattern) into the full worse/better list with labels and
  from→to counts. **Deliberately session-local, not persisted** — `prevDqCounts` is component state, cleared
  on reload, matching how the rest of the DQ panel already behaves (no snapshot persistence exists anywhere
  else in Review mode either). `9d475b9`. 11 new tests across 2 files (`dq-reconciliation` — flatten/diff
  logic incl. engine-prefix collision avoidance and sort order; `dq-reconciliation-wiring` — panel wiring).
  Caught and fixed a stale assertion in `tests/rvb-panel-wiring.test.js` from the `runChecks()` refactor
  (literal-text match on `setRvb(runRVBChecks(rvbModels))`, now `var newRvb = ...; setRvb(newRvb)` —
  behavior-equivalent, just restructured) in a separate follow-up commit, `e4fa73a`. 271/271 passing.
- **Next**: dynamic search sets (the one remaining Wave 4 item, and the largest), the two BCF follow-ups
  (auto-synthesized viewpoints; `<ClippingPlanes>` export — now doubly-confirmed as a shared, not
  CC-specific, gap per Check 2), a possible `<Coloring>` export (newly confirmed gap from Check 2), rest of
  Wave 3 (stamp/auto-assignment rules), IDS conformance CI against the buildingSMART 250-case audit suite
  (Wave 5's one remaining piece now that DQ reconciliation is done — already queued as "Phase 2" earlier in
  this file), and Wave 6 (Scale — untouched; extra care required per this session's own history-informed
  guardrails: no geo-cache keying changes, no hand-rolled geometry merging).

On branch `claude/codebase-review-optimization-3nltcw` (2026-07-08) — four-repo review sweep (in progress):

- Two-round audit of ClashControl + Connector + Engine + SmartBridge (superseded). Fix wave in flight: core dead features (ClashControl.version / _ccFlyToMeasurement / palette Fit), IFC-worker watchdog re-arm, shared-project data-loss merge, JS coplanar NaN guard, WASM-path LRU registration, backend (title/triage model verify, project.js editKey + batched upsert, tile.js validation), daily-sync repair, doc/memory reconciliation. Engine + Connector fixes on same-named branches in their repos (release-pipeline workflow_call fix, all-vs-all dedup, coplanar branch, modelFilter exclude semantics, quantities/description emission).

On branch `claude/loam-api-stability-enrichment-gxh8gc` (2026-06-15) — Loam API stability + enrichment:  **[STALE?]**

- **Loam's 5-point request triaged against the live bridge surface.** Points 1 (classification + storeyA/storeyB on get_clashes), 3 (uniqueIdA/B + storey + classification on get_issues) and 4 (ingest_detection_feedback, byRule/byPair) were ALREADY shipped (#639–#646) — confirmed in `addons/smart-bridge.js` (get_clashes ~478, get_issues ~580, ingest_detection_feedback ~882). Point 5 (stable weekly detection config) **skipped per user.**
- **Point 2 BUILT — new `get_data_quality` MCP tool** (the named gap: Loam defaults to `get_data_quality`, overridable via `LOAM_CC_DQ_TOOL`; CC only had per-element `get_element_quality`). New `handlers.get_data_quality` in `addons/smart-bridge.js` (after get_element_quality): flattens all elements, runs `_ccRunDataQualityChecks` + `_ccRunBIMModelChecks` (both guarded), rolls checks into headline buckets **completeness / materials / brokenLinks / naming / classification / geometry** (per-bucket 0-100 sub-score via the same weighted-failure-ratio as the Quality Score chip + raw flaggedCount), overall score/grade from `_ccComputeQualityScore` (reconciles 1:1 with the in-app chip), plus a flat `checks[]`. Stable numeric fields for Loam's pulse. Declared in the addon `_TOOL_MANIFEST` and `mcp-server.js` TOOLS (forwarding is generic — `callBridge(name)` → `handlers[name]`, no allowlist). Optional `modelId` to scope to one model.
- **Not browser-verified in sandbox** — `node --check` passes on both files; handler is pure logic over plain element objects. First real run = Smart Bridge connected with a model loaded.
- **SEO/AEO push (to break into AI "best free IFC viewer" lists):** (1) new `/best-free-ifc-viewer/` comparison page (ItemList + SoftwareApplication + FAQPage schema, side-by-side table vs Open IFC Viewer/BIMvision/usBIM/Dalux/Bonsai/FZKViewer) — the listicle shape answer engines extract; (2) homepage Organization + WebSite @graph + `sameAs` (GitHub) for entity recognition; (3) **de-orphaned landing pages** — the app linked to none of them; added a crawlable internal-links `<nav>` in the hidden SEO block + noscript fallback; (4) new **`/tour/` explanatory page** (full feature breakdown + Q&A + schema) with a **functional hero**: dropped/chosen IFC is stashed in IndexedDB (db `cc-handoff`, store `pending`, key `file`) then redirects to `/?load=1`; a guarded boot hook at the end of index.html reads it and calls `window._ccLoadFiles([file])`; `/?connect=revit` auto-opens the Revit bridge. WelcomePopup got a "New here? Take the tour." link. All pages in sitemap. SW is network-first for navigations so the static pages aren't hijacked by the SPA. **Decision: subdir, NOT a subdomain** (subdomain splits SEO authority). Off-repo still needed: AlternativeTo/G2/Capterra listings, listicles, Reddit/LinkedIn. **Not browser-verified** — JSON-LD + all scripts parse via node.
- **De-duplicated the tool catalog (follow-up):** the tool surface was declared twice — the addon `_TOOL_MANIFEST` (dynamic, pushed to the bridge → served at `GET /tools`) AND `mcp-server.js` `TOOLS` (static). The two "routes" (MCP stdio via mcp-server.js; REST/`/chat`/OpenAPI via smart-bridge-server.js) actually CONVERGE — mcp-server.js's `callBridge` just `fetch`es the same bridge (`/call/<tool>` on 19803) → WS → the one set of browser `handlers`. mcp-server.js is a thin MCP-protocol shim, not a separate impl. Made the addon manifest the single source of truth: `mcp-server.js` now fetches `GET /tools` at `tools/list` time (`getTools()`, cached once reachable, 3 s timeout) and falls back to the hardcoded `TOOLS` only when the bridge isn't connected yet (MCP clients ask for the catalog at spawn, before a browser is up). Call validation accepts a name in either list. New tools now only need declaring in the addon `_TOOL_MANIFEST`.

On branch `claude/sharp-rubin-tlowao` (2026-06-13) — start-screen Revit live link:  **[STALE?]**

- **4th option on the Welcome/start screen**: added a "Live link to Revit…" row (under "Watch a folder…") in `WelcomePopup` (index.html ~30723). Activates the `revit-bridge` addon then dispatches `{t:'REVIT_BRIDGE',v:true}` to open the Revit Bridge panel — same proven pattern as the "+Add → Live from Revit" menu entry (`_ccActivateAddon('revit-bridge')` first, since addon reducerCases only run when the addon is active). Uses the string action literal `'REVIT_BRIDGE'` (the close handler does too); `A.REVIT_BRIDGE` is not a defined A-key.

Eleventh batch (2026-06-12) — CRS-aware geo-placement (proj4 reprojection, completes the v5.16.2 geoplace work):  **[STALE?]**

- ~~**Projected CRS → WGS84 reprojection in `addons/geoplace.js`**: the loader already extracts IFC4 `IfcMapConversion` → `IfcProjectedCRS` (eastings/northings/grid-rotation/EPSG) but only displayed it. Now a georeferenced model auto-places without typing lat/lon. New globals: `_ccCRSList` (selector data), `_ccCRSResolve` (IFC TargetCRS.Name → EPSG key — handles `EPSG:28992`, URN, bare code, names), `_ccReprojectToWGS84(E,N,key)`, `_ccGeoplaceFromCRS(modelId,mc,key)` (reproject → existing `_ccGeoplaceModel`; north/elev flow through the existing path which already prefers map-conversion rotation). proj4 lazy-loaded from jsdelivr (`proj4@2.20.9`, CSP script-src already allows the host; no SRI, same as web-ifc/spark runtime loads) only when a projection is requested. CRS registry (8 systems, def strings carry 7-param towgs84 → no grid file): RD New 28992, Belgian Lambert 31370, CH1903+/LV95 2056, OSGB 27700, ETRS89 UTM 31N/32N, Web Mercator, WGS84. **Placement-grade (~1 m), NOT RDNAPTRANS survey-grade** (full RD needs the NTv2 grid + quasi-geoid — deliberately not shipped). UI: Geo Placement panel — when a model has projected E/N and isn't placed yet, a CRS `<select>` (defaults to detected EPSG or 28992) + "Place from CRS" button; "· unrecognised" badge when the IFC names a CRS not in the registry. Guards: missing E/N, unrecognised CRS, out-of-range reprojection all reject with a clear message. 8 tests in tests/geoplace-crs.test.js (proj4 stubbed — geodesy is proj4's job).~~ (2026-06-12)
- **Deferred (as planned):** auto-aligning federated models by map conversion (touches model transforms — riskier); true RDNAPTRANS grids (megabytes, survey-grade opt-in); vertical datum selector (NAP-vs-ellipsoid is a constant offset, already handled +43 m for tiles). North-sign convention bit us before (negated after live test) — verify map-conversion rotation on a real georeferenced model before trusting it.
- **NOT browser-verified in sandbox** (jsdelivr host-blocked, no GPU/sample IFC): geoplace.js syntax-checked, main inline script parses via `new Function`, 8 reprojection tests pass with proj4 stubbed. First real run = Vercel preview with a georeferenced IFC (RD New is the easy NL test).

Tenth batch (2026-06-12) — IDS 1.0 execution engine (transposing the ifc-ids-mcp capability, Phase 1):  **[STALE?]**

- ~~**Full buildingSMART IDS 1.0 engine in `addons/data-quality.js`** (`window._ccParseIDS` + `window._ccRunIDS`): user asked to "transpose" github.com/vinnividivicci/ifc-ids-mcp (Python MCP wrapper over IfcTester) into our ecosystem — capability re-implemented in JS from the published standard, no code ported (IfcTester is LGPL). Parser is a hand-written dependency-free XML parser (no DOMParser → Node-testable). Facets: entity (EXACT match per spec — fixes legacy substring bug where IFCWALL matched IfcWallStandardCase), attribute (Name/Description/GlobalId/ObjectType/LongName), property (pset+baseName+value, Qto_/BaseQuantities → flattened quantities), classification (pset-key heuristics), material (segment split), partOf (storey containment only). Restrictions: enumeration, pattern (XSD→JS anchored `^(?:…)$`; \i \c / class subtraction → not-checkable), bounds, length; numeric tolerance + boolean spelling variants. Cardinality: facet required/optional/prohibited + spec-level via applicability min/maxOccurs. **Honesty rule: anything un-evaluable (PredefinedType, non-storey partOf, dataType, unsupported regex) reports "not checkable" — never silently passes.** Core wiring: `parseIDSXml` delegates to addon when loaded (tags specs `__ids2`), `runIDSValidation` routes them to `_ccRunIDS`, panel shows per-spec notes/partially-checked counts; legacy regex path kept as no-addon fallback + for bundled specs. `importIDS` rebuilt on the same parser. 15 tests in tests/ids-engine.test.js incl. round-trip of our own exportIDS output. Merged as #622.~~ (2026-06-12)
- **Phase 2 (queued):** CI conformance job comparing verdicts vs IfcTester on shared fixtures (pip in CI only); extract PredefinedType + Tag in the loader so those facets stop being "not checkable"; dataType checking.
- **Phase 3 (queued):** IDS authoring tools on `mcp-server.js` (create_ids/add_*_facet/export, mirroring ifc-ids-mcp's tool surface) so an AI can author a spec via Smart Bridge and run it against the live federation.

Doc added (2026-06-11): **`AS_BUILT_DEVIATION.md`** — scope/roadmap for point-cloud-vs-BIM surface deviation. Captures the capability audit (alignment + bbox-proxy heatmap exist; true point-to-surface distance is NOT built, deferred to "Phase 2" in `align.js`), reuse-vs-build (BVH + `_getWorldTris` triangle soup + Rust engine all reusable; net-new = point-to-triangle primitive + BVH closest-point descent + Rust kernel), the Phase 1/2/3 plan (~1wk demo / ~3–4wk client-grade), and the Wkb/Bbl **Borger** product framing (sell the dossier outcome, not the geometry; scan verifies the *geometric subset* of Bbl risk items only). Not built — awaiting go-ahead.  **[STALE?]**

Ninth batch (2026-06-11) — 3D world context live-test round 3:  **[STALE?]**

- ~~**PDOK tiles all failed to parse** ("setMeshoptDecoder must be called before loading compressed files", 21/21 failed): PDOK 3d-basisvoorziening glbs use EXT_meshopt_compression and the renderer's GLTFLoader had no decoders. tiles.js now registers GLTFExtensionsPlugin with MeshoptDecoder + DRACOLoader + KTX2Loader (latter two for Google photorealistic tiles, same wall). Merged as #619 → main `2bc3b62`. User confirmed PDOK buildings render.~~ (2026-06-11)
- **Geo align nudge** (PR #620): panel `align` row (camera-relative arrows + step select) slides basemap + tiles together in world XZ metres; offset persisted on model georef (offsetX/offsetZ), reapplied on rebuild/auto-restore/context reload. APIs: `_ccGeoplaceSetOffset`, `_ccSetTiles3DOffset`/`_ccTiles3DOffset`, `opts.offset` on `_ccLoadTiles3D`. Applied AFTER north rotation (world space) in both layers.
- **Site clearing** (PR #620): `Site: keep / Clear +N m` select carves context inside the models' union footprint + margin using 4 vertical clip planes with clipIntersection (PDOK/Google merge many buildings per mesh → per-building hiding impossible). Gotcha: core flips `renderer.localClippingEnabled` off when no section is active — tiles frame handler re-asserts it while clearing is on. Persisted in localStorage `cc_tiles3d_clear` (-1 = off).

Eighth batch (2026-06-10 evening, merged as #614 → main `92a4bbc`) — live-test loop round 2:  **[STALE?]**

- ~~**Sections cut nothing on batched models**: all four per-material clipping sweeps (section plane apply, section box apply, box clear, floor-plan cut) gated on `expressId==null && !isInstancedMesh` which excludes every BatchedMesh — sweeps now include `userData._isCCBatch`. Pattern to remember: ANY scene material sweep written pre-batching probably has this filter; render-style swap on batches still unaudited (cosmetic).~~ (2026-06-10)
- ~~**Section drag inverted**: axis path negated the screen-projected dot (horizontal cut ran against the mouse); picked-face custom planes used raw screen-Y. Now: project travel direction (+axis or custom normal) from the gizmo position, pos follows the mouse component.~~ (2026-06-10)
- ~~**Batched click-outline invisible on most elements** (#610/#612): off-scene originals are parentless so matrixWorld was stale identity — outline drew at the origin. Refresh from .matrix (updateMatrixWorld on parentless), outline ALL meshes of multi-body elements; same guard in bbox fallback + _buildHighlightGroupForMesh.~~ (2026-06-10)
- ~~**Geo anchor unification**: basemap half-tile drift fixed (grid centred on the *tile*, plane treated canvas centre as anchor — ~47 m at z18); tiles3d anchors at model bbox centre via `opts.origin` (was scene origin); NL preset height +43 m (PDOK = ECEF/ellipsoidal, NAP ≈ ellipsoid − 43); tiles load-error toast; streaming pump (update() only ran on rendered frames → downloads stalled when camera idle); 'load-tileset' event name; radius plugin takes anchor ECEF directly.~~ (2026-06-10)
- ~~**North from IFC**: loader reads IfcGeometricRepresentationContext.TrueNorth via IfcProject.RepresentationContexts (no type constant); `window._ccModelNorthDeg` prefers IfcMapConversion.rotationDeg over TrueNorth; **applied sign NEGATED after live test** (first deploy doubled the rotation error — XAxisAbscissa/Ordinate semantics in the wild are inverted vs my spec reading); fresh model value overrides persisted trueNorthDeg (self-heals old-sign saves). If a future model rotates wrong again, suspect per-authoring-tool sign differences → add a flip toggle.~~ (2026-06-10)
- ~~**Geo per-project**: basemap + tiles detach on `cc-project-switch` (geoplace re-runs _autoRestore for the new project's saved georef; tiles clears cc_tiles3d_on quietly).~~ (2026-06-10)
- ~~**Integrations → avatar menu**: topbar + mobile header buttons removed; single "Integrations" row in AvatarMenu with left flyout (Revit Connector / Clash Engine / Smart Bridge); `window._ccAddonsFocus` filters AddonsPanel to that one card + "Show all integrations" escape (focus clears on panel unmount).~~ (2026-06-10)
- ~~**AI counting**: `count_elements` tool in api/nl.js TOOLS + client case in dispatchServerAction (matches props.ifcType substring after ifc-strip/singularise, props.storey substring; storey-name suggestions on zero match) + offline regex in processNLCommand (EN+NL). Groq 400 tool_use_failed → one retry without tools → text answer instead of 502.~~ (2026-06-10)
- ~~**Cesium ion 3D source** ("cradence" = Cesium): CesiumIonAuthPlugin, default asset 96188 OSM Buildings (free community tier), token in localStorage cc_cesium_ion_token, "ion…" button next to PDOK/Google.~~ (2026-06-10)
- ~~CodeQL alert #14 (incomplete-hostname-regexp): Cache.match(wasmUrl) → new Request(wasmUrl).~~ (2026-06-10)
- ~~**Desktop COMPLETE — all three platforms green**: Windows MSI failed `Couldn't find a .ico icon` (bundle.icon listed only icon.png) → fixed by listing the generated set; PR #612 (icon fix head) was merged from the UI at 19:13, desktop run 27299970667 on that merge: macOS + Linux + **Windows all success** → `desktop-v0.1.0` draft release (id 337444538) has installers for all platforms. Remaining: user publishes the draft (or downloads from it); expectations = unsigned (SmartScreen warning), Phase 0 web-app-in-window, internet needed first launch.~~ (2026-06-10)
- **OPEN — PDOK 3D verification**: user retests after deploy; if still empty the new load-error toast names the cause. Sandbox cannot probe api.pdok.nl (host allowlist) — tileset URL unverified upstream; if 404/CORS, check PDOK OGC API landing (`.../ogc/v1_0`) for the exact 3dtiles link.
- **NOT a CI flake this time (post-mortem)**: pull_request events stopped after a5f2d4a because **#612 had been merged from the UI at 19:13** — later pushes had no open PR, so no pull_request events; "cannot be reopened" = it was merged, not closed. Remedy that works either way: open a NEW PR for the branch. Before assuming the event flake, check whether the PR is still open. Anonymous GitHub API rate limit (60/h) exhausted by 30 s monitor polls — poll via authenticated MCP instead, or space polls ≥60 s.

On branch `claude/codebase-review-ae7481` (2026-06-10) — codebase review: connect open ends + fix bucket:  **[STALE?]**

- ~~**WASM clash engine connected for the first time.** It was never wired: `'wasm-engine'` missing from `addonFiles` AND `addons/wasm-engine-pkg/` never built/committed — the documented 4-8× acceleration never ran. Built `engine/` (wasm32 + wasm-bindgen 0.2.123, 35 KB), committed the pkg, added to the load list. **Critical fix while wiring:** the addon eagerly defined `_ccWasmIntersect`/`_ccWasmMinDist`/`_ccWasmBatchIntersect` with not-ready returns (false/Infinity/[]) while the core treats their *existence* as "skip JS fallback" — a failed/in-flight load would have silently reported zero clashes. Globals now publish only after successful init, unpublish on deactivate; `active:true/false` dispatched so the engine pill + Settings selector (which read `s.wasmEngine.active`, never set before) work. Node smoke test passes; verify the pill on Vercel preview.~~ (2026-06-10)
- ~~Bridge URL bug fixed (`smart-bridge-server.js`): `new URL('/v1/...', baseUrl)` dropped path prefixes (Groq/OpenRouter). New `llmEndpointUrl()` appends, skips double `/v1`; applied to callLlmApi + probeLlm; bridge 0.3.0→0.3.1; regression test `tests/bridge-url.test.js`.~~ (2026-06-10)
- ~~`UPD_OPENAEC_BRIDGE` was a silent no-op (no reducerCases registered) — addon now registers initState+reducerCases → `s.openaecBridge` tracks {available,checking,port,info}.~~ (2026-06-10)
- ~~`/api/project` (only unauthenticated DB-write) had no body cap — swapped bare rateLimit for `llmGuard` 30/min + 256 KB; 413 test added.~~ (2026-06-10)
- ~~Doc drift: CLAUDE/INTERNALS/PERFORMANCE_NOTES/OPEN_SOURCE_COMPONENTS/MEMORY still said Three.js r128 — corrected to r180 ESM import map; 2 "OBB engine" tooltips → AABB+BVH.~~ (2026-06-10)
- ~~Dead code: removed suggestOmniClass+_aiResJson, _ccLoadScript, _ccFormatLen (dup of _ccFmtLength), _ccDrawTitleBlock/ScaleBar/NorthArrow (dead duplicates of the inline 2D-sheet drawing) — ~136 lines.~~ (2026-06-10)
- ~~PWA offline was broken for addons: fetch handler only runtime-caches CDN hosts, addons weren't precached → 404 offline. All 15 addons + wasm pkg added to PRECACHE (cache name rotates per release).~~ (2026-06-10)
- **Deliberately skipped:** hiding model names from `/api/health` — Settings intentionally displays the live model (e840a79) and it's public in llms.txt; hiding it would regress a feature for negligible gain.
- **Chunk-merge caveat list is moot:** the whole chunk-merge subsystem was removed in 704837f (2026-06-09) — the Stage 2B "~15 visibility / ~34 color setters not chunk-aware" follow-up no longer applies. This session removed the orphaned write-only `_ccHiddenReg` registry the removal left behind. If chunk-merge ever returns, it returns with its own registry.  **[STALE?]**

Second batch same branch (2026-06-10) — product features + test infra ("do all 1-9"):  **[STALE?]**

- ~~Run history + trend: `s.runHistory` (capped 100) appended on MERGE_CLASHES, persisted in .ccproject + IndexedDB autosave; sparkline in ClashStatsBar "This run" row.~~ (2026-06-10)
- ~~Clash coordination report: `_ccClashReport(s)` print-to-PDF window (align.js pattern) — cover cards, models, rules summary, runHistory trend chart+table, clusters ranked by open count (cap 300), viewpoint snapshot appendix. Export dropdown entry.~~ (2026-06-10)
- ~~BCF 3.0 export made actually valid (verified against official buildingSMART release_3_0 XSDs): viewpoints inside Topic, Labels/Label wrapper (importer parses both shapes now), Files/IsExternal header, lowercase GUIDs, AspectRatio, no bogus xmlns, no DetailedVersion; DocumentReferences moved inside Topic (was invalid in BOTH versions). Locked by tests/bcf-export.test.js. BCF-API client NOT done (needs live OAuth server).~~ (2026-06-10)
- ~~`_ccBenchEngine(pairLimit)` console helper: JS vs WASM narrow-phase A/B on real overlapping pairs + hit-count parity check. Run after a detection.~~ (2026-06-10)
- ~~Browser smoke test: tests/fixtures/smoke-clash.ifc (hand-written IFC4, two crossing walls, verified to parse under web-ifc 0.0.77) + tests/browser/smoke.mjs (Playwright headless Chromium, real WASM pipeline, real detection) + ci.yml browser-smoke job + `ClashControl.runDetection()`. NOT run locally (Playwright CDN blocked in sandbox) — first execution is CI on the PR.~~ (2026-06-10)
- ~~Globals discipline: rule in CLAUDE.md (public surface → window.ClashControl.*); namespace grew loadFiles/runDetection/benchEngine/clashReport.~~ (2026-06-10)
- ~~Memory guardrail: toast+console warn at >75% of tab heap limit after IFC load batch.~~ (2026-06-10)
- ~~TAURI.md: phased desktop plan (same index.html, capability-detected tauri-bridge addon, native engine/ reuse, streamed reads, disk geo-cache, built-in Smart Bridge). Phase 0 not started — awaiting go.~~ (2026-06-10)

Seventh batch (2026-06-10) — 3D Tiles world context (the June-22 That-Open-launch flex):  **[STALE?]**

- **addons/tiles.js**: NASA-AMMOS 3DTilesRendererJS 0.4.28 ESM (bare `three` resolves via the page import map → shares core r180; splat precedent). Google Photorealistic 3D Tiles via GoogleCloudAuthPlugin (BYO Map Tiles API key, localStorage `cc_google_tiles_key`) or any tileset URL. Georef: anchor lat/lon → `WGS84_ELLIPSOID.getEastNorthUpFrame` → invert → rotX(-90°) so the anchor sits at scene origin Y-up; the IFC never moves. Per-frame `tiles.update()` on the core's `cc-render-frame`; streaming events call invalidate so render-on-demand keeps painting. UI: "🌍 3D world context…" in Geo Placement (prefills from IfcSite/manual georef). CSP connect-src += tile.googleapis.com. NOT browser-verified in-session — needs a real key on the preview; ENU→Y-up sign convention is the thing to eyeball first (if the city is mirrored/under the model, flip the rotX sign).
- Same batch: batched-click selection fully fixed (#604 merged: per-instance tiebreak bounds + click outline/bbox from off-scene originals); local-engine boot probe gated on 'seen' flag.

Sixth batch (2026-06-10) — perf plan after user's laggy 7-model federation (USER APPROVED — Phases 0+1+2 SHIPPED on the branch; verify _ccRenderReport() on the real federation before/after, then consider widening the trigger):  **[STALE?]**

- **Lag root cause (user log):** ZDS_BWK_PDR_gevelbekleding — 2,510 elements, 74,772 UNIQUE geometries, 0 reused → ~75k meshes/draw calls from one cladding model. Instancing can't help (nothing repeats).
- **Why all past merge attempts failed (from revert 366c7cc + MEMORY):** hand-rolled chunk-merge on r128 broke identity features — (1) same-material elements visually blended, (2) render-style switch no-op on chunks, (3) selection outlines blended, (4) hide/color needed index-rebuild registries, ~49 setters never became chunk-aware. Removed entirely in 704837f. Free-RAM/dehydrate = wrong problem (RAM not draw calls), removed.
- **PLAN (BatchedMesh, post-r180 — the primitive that didn't exist during prior attempts):**
  - Phase 0: `_ccRenderReport()` (draw calls via renderer.info, frame time, per-model mesh counts); acceptance gates: ≥30fps orbit on the user's federation AND hide/color/style/pick/outline identical to per-element.
  - Phase 1: THREE.BatchedMesh for pathological models only (trigger: geoUnique/elements > 10 OR >20k meshes/model). Original per-element meshes kept off-scene as proxies (proven Stage 2A pattern — element.meshes[] stays source of truth for clash/serialize/outline). Identity features via natives: setVisibleAt (hide), setColorAt (color-by-class), raycast batchId→expressId (pick), .material swap (render styles).
  - Phase 2: every historical revert symptom becomes a browser-smoke CI assertion on a batched model BEFORE any default-on expansion.
  - Phase 3 (parallel): storey-picker UI for scoped loading; Tauri Phase 2 native engine.

Fifth batch (2026-06-10) — declared units + registry; scoped-loading design queued:  **[STALE?]**

- ~~Declared IFC LENGTHUNIT extraction (`_ccExtractIfcLengthUnit`) wired: load → result.stats.unitScale → geo-cache persist → `_ccDetectUnitScale` precedence override>declared>spacing-heuristic. tests/ifc-units.test.js locks it.~~ (2026-06-10)
- ~~Port/protocol registry: INTERNALS.md §22 — all companion-app contracts in one table.~~ (2026-06-10)
- ~~Storey-scoped loading SHIPPED (core): `ClashControl.loadFiles(files,{storeys})` one-shot batch scope → both load paths skip out-of-scope geometry pre-decode; stats.loadedScope/scopedOutCount; partial loads never write geo-cache; 'partial' badge on model row + `_ccReloadModelFull` one-click full reload; smoke test asserts the filter end-to-end.~~ (2026-06-10) ~~**Remaining: pre-load storey-picker modal UI.**~~ Shipped: `StoreyPickerModal` (`index.html:24856`, wired via `window._ccShowStoreyPicker`). (2026-07-08, confirmed by audit)
- ~~Tauri Phase 0 scaffold: desktop/ (Tauri v2 conf + main.rs + build-dist.sh, sw.js excluded from dist) + release-desktop.yml (matrix installers via tauri-action, publishes draft release on desktop-version.json bump). First real build = CI after merge.~~ (2026-06-10)
- **Original design notes (kept for the picker follow-up):** the IFC worker is assembled by stringifying the SAME shared functions the main-thread fallback uses (`_getIFCWorkerUrl`, index.html:~3075) — so the scope filter goes into the shared stream-processing function once and both paths get it. Plan: (1) fast pre-pass already exists (`loadIFCMetadataOnly` ~13451 + `extractStoreys`) → storey list before geometry; (2) UI: storey-picker step in the load flow (reuse Levels-panel rendering) with "Load all" default so the flow stays one-click; (3) thread `scope:{storeys:[...]}` through loadIFCWorker message + loadIFC signature; in the StreamAllMeshes callback, `continue` for elements whose storeyMap entry is out of scope (storeyMap is built BEFORE geometry streaming); (4) un-loaded storeys listed in Levels panel greyed with a "load now" affordance → re-parse with widened scope (file bytes are in IDB via idbSaveFile). Memory + time win proportional to scope; geo-cache keying must include the scope or only cache full loads (simpler: only cache full loads, v1).
- **Then Tauri Phase 0** per TAURI.md (user-approved order).
Fourth batch (2026-06-10) — spike fix + loading status correction:  **[STALE?]**

- ~~**Spikey-model-on-refresh ROOT CAUSE found and fixed (#598):** geo-cache hash-fallback `_instKey` hashes bbox-NORMALIZED qpos bytes — scale-invariant, so same-proportion different-size shapes (12 m vs 18 m piles) hash identically → wrong instancing groups. Fix: absolute mm-rounded bbox appended to key + `_geoExpId` stashed on restore. The five 5.19.29-48 hotfixes couldn't work — the bytes carry no scale.~~ (2026-06-10)
- **In-browser IFC loading status (corrects earlier open-points list):** worker parsing ALREADY EXISTS (`loadIFCWorker`, primary path at the load call site) and WASM model cleanup is correct. IFC 4.3 (IFC4X3_ADD2) PARSES WITH GEOMETRY under pinned web-ifc 0.0.77 (Node-verified) — claimed in llms.txt. Remaining real item: storey/discipline-scoped loading (big; next session, before Tauri Phase 0).
- **Stale-branch audit:** all 24 non-main remote branches' content is in main (squash-merged), superseded (geoplace-persist → modelMeta georef; threejs-r179-bump → #595), or deliberately reverted (Free-RAM family). Nothing to merge. Safe to bulk-delete for hygiene.

Third batch same branch (2026-06-10) — cross-repo contract audit (user-supplied PAT, since deleted) + addon one-click UX:  **[STALE?]**

- ~~**ClashControlEngine audit** → two real bugs fixed both sides: GET /update sends {latest,release_url} but addon read {update_version,update_url} AND the addon's /update handler never dispatched the info into state → update banner always blank. Addon now accepts both shapes + dispatches (main repo); engine adds aliases + modelAId/modelBId on clash objects (O(1) resolve) — ClashControlEngine PR #24 (draft; merge to main auto-releases).~~ (2026-06-10)
- ~~**ClashControlConnector audit**: protocol contract SOLID — version 1.0 both sides with semver handshake, all 22 message types handled bidirectionally, 14/16 items of its CLASHCONTROL_INTEGRATION_IMPROVEMENTS.md wishlist already implemented. Only note: browser sends `modelFilter` in export, plugin parses but ignores it (future scoped re-export).~~ (2026-06-10)
- ~~**ClashControlSmartBridge repo is superseded** (stopped at 0.2.3; bridge lives in main repo as 0.3.x and the app downloads from main-repo releases). Deprecation-banner PR #14 opened; recommend archiving the repo after merge.~~ (2026-06-10)
- ~~**Addon one-click UX**: new `alwaysOn` addon flag (forces active; Addons panel shows "Built in · always on" instead of a do-nothing toggle). Applied to align/splat/visibility (were registered but never auto-activated — features sat behind a dead Settings toggle) and to newly-registered data-quality/accessibility/training-data (were invisible in the panel). External-dep addons keep real toggles + their existing one-click connect flows.~~ (2026-06-10)

On branch `claude/jolly-cannon-YZUwi-followup` (2026-06-08) — Splat addon Phase 1 + Three.js bump scheduled:  **[STALE?]**

- **`addons/splat.js` (Phase 1, sibling-canvas pattern):** opt-in addon that lazy-loads Three.js r180 + Spark.js 2.0 as ESM only when the user actually loads a splat. Mounts its own WebGL canvas BEHIND the main IFC canvas (z-index 0, pointer-events:none), mirrors the core's camera each frame via `_ccViewport.getCamera()` and a new `cc-render-frame` event the core fires after every render. IFC canvas clear-color forced transparent while splats are active; restored on unload. **Core stays on r128.** Drag-drop wired for `.splat / .ksplat / .spz` (alongside `.ply / .pcd` for point clouds). Public API: `_ccLoadSplat(urlOrFile, opts)`, `_ccUnloadSplats(id?)`, `_ccListSplats()`, `_ccTestSplat()` (loads a public sample for the spike).
- **Architecture decision (matters):** addons can bring their own modern Three.js. Core Three.js doesn't need to bump just to ship modern-Three features. The splat addon is the proof-of-concept; future modern-Three addons follow the same pattern until the bundle math turns against us (3-4 such addons each pulling 600KB).
- **Three.js core bump SCHEDULED, not done.** Trigger condition: WebGPU compute path for clash detection, expected ~10× speedup on 10k+ element federations. Plan in session transcript: 4 days bump (r128 → r179, ESM via import maps, no build step, ~514 THREE refs to migrate, ~6 CDN script loads to convert) + 1 week WebGPU clash path with WebGL2 fallback + 3 days re-verification = ~2 weeks. Risks: rendered-mode material defaults, TransformControls API change, InstancedMesh raycast quirks. Workarounds we'd retire: chunk-merge Stage 2A outline (~200 lines), hand-rolled selection outline (~150 lines), hand-written BufferGeometry merge (~80 lines), raycast fallback for moved instances (~50). Workarounds we'd keep: chunk-merge Stage 1 spatial bucketing (different problem), stencil section hatch.
- **Splat Phase 2 (not yet):** 3D Tiles tileset.json streaming via NASA-AMMOS/3DTilesRendererJS (~r167+ required, Spark plugin available), Esri Site Scan tileset URLs (BYO ArcGIS access token), proj4js for IFC4-georef'd auto-placement.
- **Not browser-tested in this session — main script parses via `new Function(body)`; addon parses via `node --check`. Spike validation = the user opening Vercel preview, dragging a public SPZ sample (or calling `window._ccTestSplat()` in console), and confirming the camera-sync feels right at IFC scales.**

On branch `claude/jolly-cannon-YZUwi-followup` (2026-06-08) — BCF provenance round-trip, autonomy envelope UI, viewer fixes:  **[STALE?]**

- **BCF round-trip of `aiProvenance`** (`exportBCF` + `importBCF`): writes `cc:aiModel`, `cc:aiSource`, `cc:aiAt` as `<Labels>` on every topic that has aiProvenance set. Same proven pattern as `cc:revitA`/`cc:revitB`. Importer reconstructs aiProvenance on the issue payload (`source:'bcf_import'`); existing "AI" chip in IssueRow renders unchanged.
- **Autonomy envelope UI** in SettingsModal "AI / Natural Language" section: segmented Nudge | Suggest control on `s.prefs.aiEnvelope.resolveClashes` (the state field shipped in #589). Default Nudge. `auto` mode stays reserved.
- **Viewer fixes** (single commit): (1) section box + measure now coexist — `clearAllModes` accepts an optional `{sectionBox|measureMode:true}` keep set so the two tools don't cancel each other (other modes still mutually exclusive); (2) section-plane drag arrow + section-box face arrows changed `0x1a6b4a` (brand green) → `0xf59e0b` (amber) to match the rotation ring and read as one gizmo; opacity bumped 0.65 → 0.85; (3) wheel zoom no longer dead-stops at `sph.r=0.5` floor — when radius would clamp, target advances along view direction by the requested delta instead (Blender/Rhino "drive forward" pattern), so detail inspection works at any scale. PR #591.

On branch `claude/screenshot-clashcontrol-review-tiHAk` (2026-06-08) — Tiered AI (Groq basic + own-LLM Connector) + IFC-viewer/Solibri SEO:  **[STALE?]**

- **Bridge simplified to zero-key:** dropped the API-key cloud presets I'd briefly added. Built-in chat now offers only one-click local autodetect (Ollama/LM Studio/llama.cpp/Jan) + the existing "Configure Claude" (Claude Desktop app, no key). Rationale: user said API keys are "outdated and too difficult."
- **`/api/nl` is now Groq-ONLY** (`api/nl.js`): Gemma/Gemini fallback chain **removed** (user: "drop Gemma"). POST Groq `/openai/v1/chat/completions` with `TOOLS` mapped to OpenAI `tools` format, parse `tool_calls` → identical `{intent,...params}` contract. Default `llama-3.3-70b-versatile` (`GROQ_MODEL` overridable). On 429/down → 503/429 → client uses offline regex. `GEMINI_API_KEY` still used by `/api/title` + `/api/triage` only. Verified: success→intent, 429→quota_exceeded, no-key→503 (mocked-fetch handler tests). **User must set `GROQ_API_KEY` in Vercel.**
- **Tiered AI / nudge in Ask AI** (`index.html`): the built-in assistant (Groq) is deliberately BASIC. When a command matches resolution-verb + clash-noun (`_solveRx`+`_aboutClash`), it routes to the user's own LLM via the Connector (`127.0.0.1:19803/chat`) if connected, else shows a one-click-connect **nudge** (warm-up → bring-your-own-LLM / future paid tier). Also: on server failure, the `.catch` falls back to the connected own-LLM; over-quota message points to the Connector. Regex validated on 9 cases (find/show clashes = basic; resolve/fix clash = nudge).
- **SEO** (`index.html` head, `manifest.json`, `README.md`, `llms.txt`, `sitemap.xml`, new `free-solibri-alternative/index.html`): lead with "online IFC viewer", position as free Solibri/Navisworks alternative; added homepage `FAQPage` schema (Google rich results + LLM answer engines), `alternateName`/`keywords`/fuller `featureList` on `SoftwareApplication`.
- **Verify on Vercel preview** (not browser-tested here): main inline script parses; `api/nl.js` Groq path unit-tested with mocked fetch; JSON-LD blocks validated.

On branch `claude/screenshot-clashcontrol-review-tiHAk` (2026-06-07) — Smart Bridge: one-click "use your own AI":  **[STALE?]**

- **Why:** the BYO-LLM agent loop already existed (`smart-bridge-server.js` `runAgentLoop` → any OpenAI-compatible `/v1/chat/completions` + `tool_calls` → `callBrowser` → `window._ccDispatch`), but was buried behind a 3-option dropdown with an empty `baseUrl` nobody knew how to fill. Goal: one click to connect the LLM the user already runs **on their desktop**. Local-desktop *requires* the bridge by design — the https app can't reach `http://localhost:11434` (mixed-content/CORS), so the native bridge proxies localhost. (Zero-install + local-desktop are mutually exclusive; user chose local-desktop.)
- **Server (`smart-bridge-server.js`):** new `GET /llm/autodetect` probes `LOCAL_LLM_CANDIDATES` (Ollama :11434, LM Studio :1234, llama.cpp :8080, Jan :1337) in parallel via existing `probeLlm({baseUrl})`, returns `{found:[{provider,label,baseUrl,models}]}`. `bridge-version.json` 0.2.0→0.3.0. Verified end-to-end against a stub LLM (boots with a tiny `ws` stub since `ws` isn't installed here).
- **Addon (`addons/smart-bridge.js`):** primary "Connect my desktop LLM" button → `/llm/autodetect` → auto-fills + saves config (`_detectLocal`); 404 → falls back to manual presets (older Connector). Presets expanded: local (Ollama/LM Studio/llama.cpp/Jan, no key) + cloud (OpenAI `gpt-4o-mini`, Claude `claude-sonnet-4-5` via Anthropic's OpenAI-compat, key). Copy reframed "Use your own AI"; "Get a key" links + Claude-compat-beta note.
- **Note / out of scope:** cloud keys (Claude/OpenAI) don't *strictly* need the bridge — they live in the bridge panel for now; moving them to the no-bridge in-app NL bar is Tier-2. The root-relative URL bug (`new URL('/v1/chat/completions', baseUrl)` drops path prefixes → breaks Groq/OpenRouter/Gemini) is untouched; in-scope targets resolve correctly. Autodetect reaches users only on the next Connector release; addon degrades gracefully.

On branch `claude/screenshot-clashcontrol-review-tiHAk` (2026-06-07) — Accessibility (toegankelijkheid) geometric check — first building-code geometric layer:  **[STALE?]**

- **Engine: `addons/accessibility.js`** (follows data-quality.js — globals only, no register/toggle; added to `_loadAddonScripts` list). Exposes `window._ccRunAccessibilityChecks(elements, {thresholds})`. Deterministic, no LLM. Checks: door clear width, threshold height, ramp slope, corridor/escape-route width, turning clearance. Method is tiered honestly: ramp slope (bbox rise/run) + door width (IFC quantity, bbox fallback) + threshold (data-gated, n/a when absent) are exact; corridor/turning use footprint minor dimension (approximate for non-rectangular — true medial-axis / inscribed-circle deferred to v2). Every result carries `value/required/pass/unit/note/basis`. NL Bbl/NEN defaults (0.85/1.20/1.50/0.02 m, 1:12). `_ccAccessibilityClearance` wraps `_ccWasmMinDist` for a future element-to-element clearance check (the only check the min-distance kernel actually fits — the v1 dimensional checks are single-element/free-space, so the proposal's "reuse the kernel for everything" was oversold).
- **Panel: `AccessibilityPanel`** in `index.html` (before `DataQualityPanel`), DESIGN tokens. Reachable via Review-workspace toolbar button (`k:'a11y'`) + left-panel tab `'accessibility'` (added to `TITLES` + render switch). Model selector, Run, per-check pass/fail with measured vs required + caveat, "Isolate failing" (ghostOthers), "Create issues".
- **Failure rail = issues, NOT the clash MERGE path.** Routing through `MERGE_CLASHES` would auto-resolve all real clashes (it treats its payload as *the* detection result). So failures dispatch `A.ADD_ISSUE` (`source:'accessibility'`, `qualityGids`), exactly like data-quality → Issues tab + BCF export. If items are wanted literally in the Conflicts/Clashes tab, that needs a new non-destructive `ADD_CLASH` action (follow-up).
- **Not done:** thresholds UI (defaults only, engine accepts overrides); true free-space corridor/turning geometry (v2); the clearance-kernel check. Not browser-tested in env — main script parses via `node --check`; verify on the Vercel preview.
  - ~~The `ADD_CLASH` follow-up above shipped as `A.ADD_CLASHES` (non-destructive, additive — reducer case `index.html:1346`, dispatched by the accessibility panel).~~ (2026-07-08, confirmed by audit)

On branch `claude/screenshot-clashcontrol-review-tiHAk` (2026-06-07) — repo docs refresh: corrected clash-engine description (AABB+BVH, not OBB), green brand accent in DESIGN.md, web-ifc 0.0.77, added geoplace/pointcloud addons + tile/triage APIs to CLAUDE.md, marked instancing/BVH-cache as implemented in PERFORMANCE_NOTES, archived 185 lines of completed [STALE?] MEMORY blocks. Docs state current facts only (no change-history phrasing).

On branch `claude/screenshot-clashcontrol-review-tiHAk` (2026-06-07) — IFC4 georeferencing read + placement-sanity (context/QA, NOT a clash-accuracy feature):  **[STALE?]**

- **Framing (deliberate):** clash detection is relative geometry and does not depend on geolocation. A geolocation/base-point mismatch between models shows up as gross systematic noise (everything off by one vector) — a coordination symptom, not a design conflict. So this work is positioned as *context + pre-run QA*, not "georef makes clashes trustworthy". The clash engine still runs in local coordinates; nothing here touches the geometry/clash math.
- **Extraction (`extractSpatialHierarchy`, `index.html:~2049`):** added `IFCMAPCONVERSION:1709695098` + `IFCPROJECTEDCRS:3843373140` constants and read the IFC4 georef chain into `hierarchy.mapConversion = {eastings, northings, orthogonalHeight, rotationDeg, scale, epsg}`. `rotationDeg = atan2(XAxisOrdinate, XAxisAbscissa)` (grid rotation); `epsg` from `TargetCRS.Name`. Pure read, wrapped in try/catch — no behaviour change when absent. (The older `IfcSite` lat/lon path is unchanged.)
- **Display (Geo Placement panel, `index.html:~14250`):** read-only mono line showing EPSG · grid rotation · E/N offset when any loaded model has a `mapConversion`. Tooltip states it's context only, not used by the clash engine.
- **Placement-sanity (`window._ccPlacementWarnings(models)` + RunDetectionModal banner, `index.html:~15605`):** on modal open, compares per-model world bboxes (`_ccState3d.map[id]` via `setFromObject`, same precedent as geoplace `_getModelBBox`). Warns when two models declare different EPSG, or sit >8× the larger diagonal apart and don't overlap ("a clash run between them will find nothing"). Capped at 4 warnings. Non-blocking amber banner.
- **NOT done (deliberately deferred):** proj4js / projected→WGS84 reprojection for an accurate basemap (still the `geoplace.js:4` deferral); auto-aligning federated models by map conversion; feeding `rotationDeg` into the basemap auto-rotation (sign convention not verified — kept display-only to avoid shipping a wrong rotation).
- **Caveats:** not browser-tested this session (no GPU/sample IFC) — syntax-checked only (main inline script parses via `node --check`). `setFromObject` instance/chunk bounding follows the existing geoplace precedent. Rotation sign/zero-meridian conventions are display-only and unverified against a real georeferenced IFC.

On branch `claude/jolly-planck-mgEaf` (2026-06-06) — Phase C: cluster cards as rows + keyboard triage:  **[STALE?]**

- Cluster headers (Grouped mode, clash tab) upgraded to **Sentry/Linear-style cluster cards** with: severity dot on the left edge (colour from max `aiSeverity`/`type` across the cluster), 2-line layout (title + chips row), storey chip, **model-pair chip** (highlighted when cross-model so N-model federations make the owner obvious at a glance), open/resolved counts. Hover reveals two action buttons: **Triage** (calls `window._ccTriageCluster(items)`) and **Resolve all** (confirm dialog, then `_ccResolveCluster`).
- New abstractions: `window._ccTriageCluster(clashes)` (today: copy AI prompt to clipboard with toast; Week 3 swaps for `fetch('/api/triage')` — UI doesn't change), `window._ccResolveCluster(clashes, dispatch)` (loops `UPD_CLASH` resolved), `window._ccClusterSeverity(items)` (rank table).
- Keyboard shortcuts in `VirtualList` (clash tab only): **J/K** next/prev item (aliases for ArrowDown/Up), **T** triage current group, **R** resolve all open in current group (confirm prompt), **X** expand/collapse current group, **/** focus the search input. Existing Arrow/Tab/Esc unchanged.
- Non-cluster grouping (storey/severity/discipline/etc.) keeps the original lean header — only cluster groups get the card treatment.

On branch `claude/jolly-planck-mgEaf` (2026-06-06) — Phase A2: N-model scope picker (All / discipline / model)  **[STALE?]**

- New `_renderScopePicker(rules, models, d)` replaces the legacy "Check / against" rows in `ClashRulesPanel`. Segmented control: **All ↔ All / By discipline / By model**. Side A / Side B multi-pickers reuse `_modelMultiPicker`. Pair-count badge shows live "N model(s) loaded · ~K pairs" when narrowed.
- New `rules.scopeMode` field is the UI hint; `rules.modelA` / `modelB` stay as engine truth. `_ccDerivedScopeMode(rules)` derives mode from existing modelA/modelB on first render so saved presets and shared `.ccproject` files keep working unchanged.
- `_ccSummariseRules` rendered with array-aware label list (e.g. "structural + mep ↔ architectural").
- Self-clash control unchanged in this commit — the existing `_selfClashPicker` already handles N models via multi-select. Deferred consolidation into a single Off/On-all/On-selected control.

On branch `claude/jolly-planck-mgEaf` (2026-06-06) — Phase B: clashes panel header cleanup + grouped-by-default:  **[STALE?]**

- The 9-option Group dropdown is replaced (clash tab only) with a 2-button **Grouped | All** segmented control. Grouped = the Week-1 cluster de-dupe; All = flat list. A small secondary "by [storey/severity/discipline/…]" select appears only in All mode for the other axes.
- After `A.MERGE_CLASHES`, `s.clashGroupBy` is seeded to `['cluster']` if the user has never explicitly picked a Group option (`localStorage` flag `cc_clashGroupBy`). First-time visceral demo: 400 raw clashes appear as ~15 cluster cards by default.
- `ClashAISummary` defaults to collapsed (`useState(true)`). One-line header strip stays visible; details expand on click.
- Issue tab keeps its original Group dropdown (Phase B is clash-only).
- Copy AI prompt button (Week 2) is now visible on every cluster header by default — no extra clicks needed to reach the AI triage prompt copy.

On branch `claude/jolly-planck-mgEaf` (2026-06-06) — Phase A: Run Detection modal (UI overhaul step 1):  **[STALE?]**

- New toolbar **Run detection** button (accent CTA in the TopToolbar's section/measure gap) opens a new `RunDetectionModal` (`index.html:~14894`) that wraps the existing `ClashRulesPanel` (Quick Run presets + Advanced) plus a collapsible **Project standards** section embedding `StandardsPanel`. One surface for all clash setup.
- New `_ccSummariseRules(rules, models)` helper produces a one-line header (e.g. `Hard clashes · 6 models, all-vs-all`) shown under the modal title.
- New state field `s.runModalOpen`, action `A.SHOW_RUN_MODAL`. `A.DETECTING` auto-closes the modal on run.
- Removed **Detection Rules** tab from the IssuePanel tab bar (`~15336`). StandardsPanel is still rendered defensively if `s.tab==='standards'` ever fires, but no UI path sets it now. Cmd-K palette "Open Standards" and the NL "double-cancel" fallback both redirect to `A.SHOW_RUN_MODAL` instead.
- Engine selector pill in toolbar stays (power-user shortcut); inside the modal the engine selector inside ClashRulesPanel also stays.
- Not done in this commit: N-model scope picker (`rules.scope = { mode, sideA, sideB }`) and self-clash consolidation. The legacy `modelA`/`modelB` multi-picker still works for all N models, just less intuitive than the planned segmented control. Phase A2 next.
- Caveats: untested in browser this session (no GPU/sample IFC); syntax-checked only via `new Function(body)`. The summary line shows `modelA ↔ modelB` for non-all rules but does not yet enumerate when `modelA`/`modelB` are arrays (`_modelSelectLabel` only handles scalar input). Cosmetic — not wrong.

On branch `claude/jolly-planck-mgEaf` (2026-06-05) — AI Triage Weeks 1+2: clustering + prompt scaffolding (still no API call):  **[STALE?]**

**Week 2 — context-packet + prompt, manual copy-paste loop.** New `window._ccBuildClusterContext(clashes)` walks the cluster, looks up each element via `_ccElementFor(modelId, expressId)` (uses `window._ccLatestState`), and returns a JSON-ready context: ifcType / name / objectType / storey / material / curated quantities (Length, Diameter, Volume, etc.), cross-model + same-storey flags, hard/soft/duplicate counts, spatial extent + center in metres, min/max distance. `window._ccBuildTriagePrompt(ctx)` produces a senior-BIM-coordinator prompt asking for `{title, severity, explanation, discipline_conflict, false_positive_likelihood, resolution_options[]}` — advisory framing, no prescriptive structural changes. New "Copy AI prompt" button on each cluster group header (only when groupBy='cluster' and clash tab) copies the full prompt to clipboard so we can iterate against Claude/Gemma manually before wiring `/api/triage` in Week 3.



- New `Group → Smart group (de-dupe)` option in the Clashes panel. Collapses N raw clashes from the same element pair (e.g. same pipe through the same beam emitted at 30 sample points) into one expandable group. Pure code, no API call. First step toward the AI Triage tier (Steps 2–4 add LLM explanation, severity, resolution options, BCF write-back).
- Implementation: `window._ccClusterKeyFor(c)` = sorted pair of `(globalIdA||eid, globalIdB||eid)` — model-prefixed when GUID missing — so same pair clusters across reversed A/B order. `window._ccClusterLabelFor(c)` = `typeA × typeB — nameA ↔ nameB` (truncated 22 chars). Key/label decoupled via `window._ccClusterDisplay` side-map so the group header shows the readable label, not the GUID hash.
- New `'cluster'` case in `_groupKeyFor` (`index.html:~17288`) populates the display map and returns the hash key for grouping. Group header lookup at `index.html:~17545`.
- Added option to the Group dropdown for the Clashes tab only (`index.html:~15583`). Issues dropdown unchanged.
- Caveats: cluster cache (`_ccClusterDisplay`) accumulates labels across detection runs — harmless (deterministic from clash data) but not GC'd; rebuild on `LOAD_MODEL` if it ever shows stale text. No spatial bucketing — same long duct hitting the same beam at two physically distinct spots will collapse to one group (rare; acceptable for v1).
- Not done: visual count badge ("400 → 14") in the toolbar (the per-group count badge is already shown by VirtualList); fly-to that frames all clashes in a cluster; "Triage this group" button (Week 3); BCF write-back of group structure.

On branch `claude/adoring-hopper-IEpvn` (2026-06-03) — SEO Phase 0+1+2 (canonical, crawlability, landing pages):  **[STALE?]**

- Add `<link rel="canonical">`, `<noscript>` body content, visually-hidden `<h1>`, `SoftwareApplication` JSON-LD, `og:locale` to `index.html` head.
- Add `vercel.json` 301 redirects for `/clash-control`, `/ClashControl`, `/index.html` → `/`.
- Add `robots.txt`, `sitemap.xml`, `llms.txt` at repo root.
- Phase 2: shipped 5 use-case static pages (`/free-navisworks-alternative`, `/ifc-clash-detection-online`, `/free-bcf-viewer`, `/free-ifc-viewer-online`, `/ids-validation-online`) with `FAQPage` JSON-LD, cross-links, and Goatcounter CTA tagging. Sitemap + `llms.txt` updated.
- Phase 3 remaining: submit sitemap in Google Search Console (needs owner access).

On branch `claude/meshlets-research-OSMAL` (2026-05-30) — "can we use meshlets?" research + Stage-1 PoC:  **[STALE?]**

- Researched meshlets/mesh shaders. Verdict: hardware mesh shaders don't exist in WebGL/WebGPU; Needle/Nanite-style GPU meshlet rasterizers need WebGPU + three.js r160+ (too big a lift for this r128/no-build app). Meshlets do **not** help clash detection (the BVH already uses 4-tri leaves, finer than meshlets). The real, in-stack win is the *spirit* of meshlets: merge the 5k–200k per-material meshes into spatially-clustered chunks to slash draw calls + the per-mesh cull loop.
- Implemented a **flag-gated Stage-1 PoC** (`window._ccChunkMerge`, default OFF → exact revert). New `_ccBuildMergedChunks`/`_ccMergeChunkGeometries` near `_buildInstancedMeshes` (`index.html:~2200`), hooked after both IFC instancing call sites. Buckets non-instanced static meshes by spatial grid cell × material, ≤65 535-vert budget, hand-written typed-array merge (BufferGeometryUtils isn't loaded). Mutates only the render list; `element.meshes[]` untouched (protects clash/serialize/bounds — the instancing precedent).
- Picking preserved via per-chunk faceIndex→expressId range table (`window._ccChunkExprIdForFace`, used in `_hitExpressId`). Culling extended for `_isMergedChunk` (`updateCulling`). Section-clip traversals (×3) broadened so chunk/instanced materials still receive clipping planes. Hover highlight suppressed on chunks. Identity features (highlight outline / ghost / color-by-class / hide) naturally no-op on chunks under the flag (deferred to Stage 2 shader-LUT).
- **Not done / caveats:** runtime browser verification (no GPU/sample IFC in this env — syntax-checked only via vm.Script); GLB + geo-cache-restore paths not hooked (fresh IFC loads only); transparent meshes merged into a chunk may sort imprecisely; merge trades away geoCache VRAM dedup (measure `renderer.info.memory.geometries`). Plan: `/root/.claude/plans/can-we-use-the-sprightly-waffle.md`.
- **Stage 1 verified by user (2026-06-04): orbiting large models is "very smooth" now.** Merged via PR #561.  **[STALE?]**
- **Stage 2A — selection & isolation on merged chunks, NO shaders (proxy/split-out reuse). Merged via PR #566; user: "works amazing".** `_findMeshByRef` falls back to the off-scene per-element proxy (`element.meshes[0]`) via a new per-model index `_ccProxyElement`/`_ccProxyMeshFor` → selection EdgesGeometry outline works. `ghostOthers` ghosts whole chunks then re-surfaces kept elements as full-material proxy clones (`_keptProxy`), removed in `unghostAll`. Post-process outline guarded to in-scene meshes only. Skips instanced (`_instanceRef`) to avoid double-render.
- **Stage 2B — bulk hide + color on chunks, in-place (no shaders, no unmerge); flips `window._ccChunkMerge` default → ON.** Render-style already applied to chunks (meshList = all meshes). **Hide** (class/storey/temp/isolate): `window._ccChunkApplyHidden` rebuilds each chunk's index to drop hidden elements' triangles, unioning a `window._ccHiddenReg` {class,storey,temp} registry that the 3 hide effects populate; picking stays correct via a parallel `_activeRanges` table (`_ccChunkExprIdForFace` prefers it); `_fullIndex` preserves the original for restore. **Color** (color-by-class + DQ `colorByDistribution`/`colorByILSDist`): `window._ccChunkApplyColors(map)` writes a per-vertex RGB `color` attr (matched→class/DQ color, unmatched→opaque context gray — all-opaque to dodge depth-sort artifacts) and swaps the chunk to one shared `vertexColors` material (`_ccColored`); render-style loop skips `_ccColored` chunks; `_ccChunkClearColors` restores. Default flip = one-line revert (`window._ccChunkMerge=false`).
- **Stage 2B caveats / long tail NOT yet chunk-aware (default is now ON, so these silently no-op on merged chunks until swept):** BCF viewpoint per-element visibility, search-highlight, validation-failure highlight, and any other of the ~15 visibility / ~34 color setters that traverse by `expressId`. Edge: changing render-style *while* color-by-class is active leaves chunks one style behind until color is cleared. Not runtime-tested in this env (syntax-checked only).

On branch `claude/code-review-quality-IjbhT` (2026-05-28) — code-review quality pass:  **[STALE?]**

- ~~`api/title.js`: `MAX_CLASHES` was 50 but the handler then sliced to 20, silently dropping clashes 21–50. Set the cap to 20 (matches the client's per-call batch in `index.html:~22662` and the documented contract) and slice with the constant, so oversized payloads get a clear 413.~~ (2026-05-28)
- ~~Addon convention: `pwa.js`, `shared-project.js`, `local-engine.js`, `revit-bridge.js` called `window._ccRegisterAddon(...)` unguarded. Wrapped each in a `typeof === 'function'` guard (one-liner, no re-indent) matching `wasm-engine.js`.~~ (2026-05-28)
- ~~`addons/training-data.js`: extracted the 3×-duplicated Google-Forms submit-with-fallback (CORS → no-cors → hidden iframe) into one `_postToGoogleForm(entryId, value, onStatus, onSuccess)` helper. AI share passes `null` for onSuccess (it intentionally does not clear the store).~~ (2026-05-28)
- ~~Error handling: `suggestOmniClass` provider chains now reject on non-ok HTTP via `_aiResJson` (NOTE: `suggestOmniClass` is currently dead code — defined, never called); `/api/health` guards `r.ok` before `.json()`; `api/nl.js` upstream-error log truncated to 500 chars.~~ (2026-05-28)
- ~~Docs: CLAUDE.md core line count 19.8k → ~29k, added `smart-bridge.js` + `wasm-engine.js` to the file overview and "what each addon does". MEMORY.md version header 4.15.4 → 5.12.6. Taught `scripts/update-memory.py` to keep the Project State `**Version:**` line synced from `version.json` on every daily run.~~ (2026-05-28)
- ~~Testing/CI: added a no-dependency `node:test` suite under `tests/` (CORS allow-list + rate limiter in `_lib.js`; title/nl validation incl. the 413 regression lock), `"test": "node --test"` script, and `.github/workflows/ci.yml` running it on PRs/pushes to main. Added `.gitignore` (none existed).~~ (2026-05-28)

**Deferred (tracked follow-ups, not done this pass):** core reducer/state refactor (287-line reducer / 80+ cases / impure `_saveDeniedClash` inside the reducer / ~50 `window._cc*` globals) — do it only once the test suite covers the pure clash/reducer/BCF logic, which needs those helpers extracted from `index.html` first. Also: a CI check that re-verifies `index.html` SRI hashes against the live CDN, and 3D-canvas keyboard accessibility (no keyboard orbit/pan, no modal focus trap).
<!-- END:active-work -->

<!-- BEGIN:session-log -->
### 2026-07-12
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- bf83fa3 chore: daily memory sync 2026-07-11

</details>

### 2026-07-11
**Summary:** 4 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 52a1faa resilience: retry transient LLM upstream failures with backoff (T11) (#678)
- b7d6c6a chore: daily memory sync 2026-07-10
- 0fbe4f6 chore: bump version to 5.21.17
- 0871fcc Add tool governance layer to the Smart Bridge (audit log + confirm gate) (#677)

</details>

### 2026-07-10
**Summary:** 3 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 0fbe4f6 chore: bump version to 5.21.17
- 0871fcc Add tool governance layer to the Smart Bridge (audit log + confirm gate) (#677)
- 616ad35 chore: daily memory sync 2026-07-09

</details>

### 2026-07-09
**Summary:** 111 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- c395cc8 chore: bump version to 5.21.16
- 2a262d7 fix: dead public API, clash-engine parity, shared-project data loss, daily-sync crash (#676)
- 3b5bece chore: bump version to 5.21.15
- d659ae4 fix(walk): delay entry animation until rendered style is applied
- 436823c fix(walk): don't force rendered style on walk entry
- 86b0a4d chore: bump version to 5.21.14
- c0dd744 fix(materials): stricter glass threshold for multi-material mesh groups
- 48505b1 chore: bump version to 5.21.13
- 61fedec fix: array-safe material dispose for multi-material meshes
- 3b40f0d fix(walk): re-entry spawns at orbit target position, not model centre
- 80984f8 chore: bump version to 5.21.12
- 6ad7831 fix: per-group materials for multi-material curtain walls
- b860bbd fix: drop unreachable [::1] bridge host — use 127.0.0.1 only
- ffc6a32 chore: bump version to 5.21.11
- 3d0cf52 feat: restore walk mode + position across a hard refresh
- d94ba11 fix: multi-material meshes render grey + [::1] CSP block
- 7f4310d chore: bump version to 5.21.10
- eb6dbd0 fix: curtain panel glass renders opaque grey from Revit Bridge
- b9b7e1b chore: bump version to 5.21.9
- f857db5 fix: resolve prefsRef scope error breaking scroll zoom
- 20d6a0c chore: bump version to 5.21.8
- 2f5c0f7 feat: scroll zoom speed slider, orbit-around-selected, glass detection fix
- 6554e6e fix: walk mode pointer-lock race, material undefined warnings, collision toggle label
- 2e34cc6 chore: bump version to 5.21.7
- 307cbe7 feat: support per-face-group materials in Revit Bridge mesh builder
- 05260d2 chore: bump version to 5.21.6
- 917596e fix: use explicit [::1] ports in CSP — Chrome rejects IPv6 wildcard (#664)
- 207d300 fix: use explicit [::1] ports in CSP to work around Chrome IPv6 wildcard bug
- 480c320 chore: bump version to 5.21.5
- 8a1aa9d fix: add [::1] IPv6 loopback origins to CSP connect-src (#663)
- 08e170f ci(smart-bridge): auto-bump patch and release on server file changes
- da8bbd3 fix(smart-bridge-server): bind to both 127.0.0.1 and [::1] loopback interfaces
- 9e1bf42 docs(CONNECTOR_PROTOCOL): recommend dual-loopback binding, not 0.0.0.0/::
- 77ee052 chore: bump version to 5.21.4
- 7466511 fix(smart-bridge): IPv4/IPv6 loopback fallback + Smart Bridge API docs
- 568281b chore: bump version to 5.21.3
- 16c17d4 fix(revit-bridge): IPv4/IPv6 loopback fallback + SW cache bust + CONNECTOR_PROTOCOL.md
- 9aca443 fix(revit-bridge): use 127.0.0.1 instead of localhost for WS connection
- 05eae26 fix(revit-bridge): dismiss loading modal when WS connect times out
- b67be1c feat(smart-bridge): expose full IFC property sets via get_element_properties
- 86aec4f chore: bump version to 5.21.2
- b1d6ef7 fix: section-plane zoom stop and gizmo handle size
- 02ea128 fix: section-plane zoom and gizmo handle size
- 4f665c1 chore: bump version to 5.21.1
- d163dde fix: zoom-to-cursor no longer zooms out over off-centre geometry
- 7e55bb3 fix: zoom-to-cursor no longer zooms out over off-centre geometry
- 112c44b Fix zoom-to-cursor lateral jump when hovering over off-centre geometry
- 6a4db9c Revit Bridge: handshake timeout, connect debounce, live pull progress (#651)
- b4452bb Fix Revit Bridge runaway reconnect loop on connector dropout (#650)
- 16e141a chore: bump version to 5.21.0
- e0dc9a5 Measure coexists with the section plane + zoom-toward-cursor (#649)
- 94277e8 chore: bump version to 5.20.35
- 51619a7 Tour rewrite, discipline auto-detect, viewer drag/box fixes, friendlier errors (#648)
- 8108978 chore: bump version to 5.20.34
- c462568 Loam API enrichment (get_data_quality) + SEO tour & comparison pages (#647)
- a12ad5f chore: bump version to 5.20.33
- e38caec BCF import: carry referenced IfcGUIDs onto issues (#646)
- 17251e1 chore: bump version to 5.20.32
- 041e2ef Expose BCF import to the LLM + wire BCF export (#645)
- b56d878 chore: bump version to 5.20.31
- 1022573 Rooms, structural grids & levels via the Revit bridge + issue element keys (#644)
- db2f282 chore: bump version to 5.20.30
- 7f7d19c Revit bridge: Connector update prompt + promoted-issue in-app navigation (#643)
- f64c986 chore: bump version to 5.20.29
- a710925 Cross-discipline ruleset detection + clash→issue promotion with element link (#642)
- c673286 Broaden classification extraction (NL-SfB) + close last AI auto-resolve hole (#641)
- b9f43a8 chore: bump version to 5.20.28
- c7cf855 Scoped detection resolves models by name + ping orchestrator on run completion (#640)
- db1ad9a chore: bump version to 5.20.27
- 410a353 ingest_detection_feedback: stop suppressing pairs that ate real clashes (#639)
- 5322277 Orchestrator integration fixes: get_status ingest/freshness, no auto-resolve, discipline scoping (#637)
- 23c7f98 chore: bump version to 5.20.26
- 36246b0 Reconcile clashes across runs by stable identity (#638)
- 2d567c7 chore: bump version to 5.20.25
- f7835bf Fix detection instant-0 regression + one-click Revit live link + faster 82k pull (#636)
- 7fd2d25 feat(detection): cancel_detection tool — reset a wedged/stuck run from the MCP side (no browser restart) (#635)
- 03a2e78 chore: bump version to 5.20.24
- 9d06240 fix(detection): live progress in get_status, reject concurrent runs, 90s stall watchdog (no eternal detecting:true), clear stale type-pair memo on bridge runs (instant-0 fix) (#634)
- ed679e5 chore: bump version to 5.20.23
- 2d288da feat: surface last detection error via get_status.lastDetectionError (message+stack) so the orchestrator can report failures without console access (#633)
- 6bc27a0 chore: bump version to 5.20.22
- 1b5fafa Scoped sync: exclude heavy models from the live Revit sync (skip on receive + persist + re-include) (#632)
- 1108df1 feat(clash-status): add reversible 'expected' (suppressed/by-design) status — distinct from resolved, excluded from open count, re-openable; tools route by-design here not resolved (#631)
- 7f67c60 chore: bump version to 5.20.21
- 81e8748 Host-aware detection for Revit-keyed relatedPairs + throttle reconnect loading indicator (#630)
- e749dd9 chore: bump version to 5.20.20
- 4481f69 Live-test fixes: clash metadata (type/name/storey), uniqueId join key, discipline tagging, classification shape (#629)
- 7ecc093 feat(smart-bridge): emit connective-spine MUST keys (source, projectKey, sourceLocalId) on clash/issue/element tools (#628)
- 30dae2d Phase 2 CC helpers: get_element_by_guid + resync (#627)
- 91c53ae chore: bump Smart Bridge _releaseTag to bridge-v0.3.3
- 668c632 Smart Bridge: Claude Desktop attach fix + live-link restore + CC↔PDRA join groundwork (#626)
- 0bb3fa8 chore: bump Smart Bridge _releaseTag to bridge-v0.3.2
- cc3b3d6 Smart Bridge: make "drive ClashControl from Claude Desktop" actually work (#625)
- bcd4754 chore: bump version to 5.20.19
- 9c8b4df Start-screen Revit live-link option + Smart Bridge rejection fix (#624)
- 7e0b7dd chore: bump version to 5.20.18
- d80121c CRS-aware geo-placement — reproject IFC4 projected coordinates to lat/lon (#623)
- 2421ca1 chore: bump version to 5.20.17
- 9b23c60 IDS 1.0 execution engine — run imported .ids files against loaded models (#622)
- 38a3e50 chore: bump version to 5.20.16
- ed2fe18 smart-bridge: bulk-by-default inputs for mutating tools (cut agent round-trips)
- 58ef9e4 Relabel deviation heatmap as first-pass proximity (don't imply measured deviation)
- b93d883 docs: add AS_BUILT_DEVIATION.md — point-cloud-vs-BIM deviation scope
- b6d6b4d 3D world context: auto-seat on the model floor (height auto-snap)
- 4909b55 3D world context: live vertical height nudge
- 8f0f769 chore: daily memory sync 2026-06-11
- d8797ba chore: bump version to 5.20.15
- 16bffc1 Geo align nudge + site clearing for the 3D world context (#620)
- 2bc3b62 Fix 3D Tiles: register glTF decoders (meshopt/Draco/KTX2) — PDOK tiles failed to parse (#619)
- 4a30a52 fix(tiles): cc-render-frame gate — tiles.update() never ran, root tileset never loaded (#617)
- 3ee4a9d fix(tiles): set _ccHasFrameListener — cc-render-frame is gated and never fired, so tiles.update() never ran

</details>

### 2026-06-11
**Summary:** 57 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- d8797ba chore: bump version to 5.20.15
- 16bffc1 Geo align nudge + site clearing for the 3D world context (#620)
- 2bc3b62 Fix 3D Tiles: register glTF decoders (meshopt/Draco/KTX2) — PDOK tiles failed to parse (#619)
- 4a30a52 fix(tiles): cc-render-frame gate — tiles.update() never ran, root tileset never loaded (#617)
- 3ee4a9d fix(tiles): set _ccHasFrameListener — cc-render-frame is gated and never fired, so tiles.update() never ran
- 27148b9 chore: bump version to 5.20.14
- 1dcd75c feat(geo): manual north dial, PDOK visibility fixes; What's new from CHANGELOG (#616)
- a2bd954 feat(geo): manual north dial + tiles fade removal + streaming status; What's new reads CHANGELOG
- fff85ec chore: bump version to 5.20.13
- a0a89d6 fix(tiles): tileset URL validation + surfaced errors; Integrations below + New project (#615)
- 4b650cd ui: Integrations row moved below + New project in the avatar menu
- 9323745 fix(tiles): validate tileset URL up front (PDOK OGC may need /tileset.json) + surface swallowed update() errors
- d097ff8 docs: MEMORY.md — desktop complete (all platforms), #612 post-mortem correction
- c63311e docs: MEMORY.md — eighth batch session log (live-test loop round 2)
- 2ee5caf chore: bump version to 5.20.12
- 92a4bbc fix: sections on batched models + drag direction, geo north/per-project, Y-menu integrations, AI counting, Cesium ion, Windows MSI icon (#614)
- b8e3c7e chore: bump version to 5.20.11
- 167161e fix(geo): one anchor, two layers — basemap half-tile drift + 3D tiles anchored to model
- 573df1a fix: pass explicit Request to Cache.match — clears CodeQL incomplete-hostname-regexp alert
- a5f2d4a fix(desktop): list generated .ico/.icns in bundle.icon — Windows MSI bundler requires a .ico
- 9191d80 chore: bump version to 5.20.10
- 294aebf fix: PDOK first-click crash + batched-element selection outline (#610)
- fef2eec fix(select): batched-element click outline — refresh stale matrixWorld on off-scene originals
- cb9cf61 fix(tiles): getEastNorthUpFrame takes (lat, lon, height, target) — first PDOK click crashed
- 926812f fix(desktop): cross-platform Node dist-assembler (#609)
- 32b0d13 fix(desktop): resolve build script via git toplevel (#608)
- f18acb7 fix(desktop): beforeBuildCommand path — tauri-action builds from repo root (#607)
- aa8b664 chore: bump version to 5.20.9
- 1e44c95 feat(tiles): PDOK NL 3D layer, range+detail controls, site-radius masking, offline hardening (#606)
- 839f4ae chore: bump version to 5.20.8
- 42f56ec feat(tiles): 3D world context — Google Photorealistic 3D Tiles under the IFC (#605)
- df045cf chore: bump version to 5.20.7
- 0fb81e2 fix(pick): batched element selection — tiebreak bounds, click outline/bbox, idle probe (#604)
- b67006a chore: bump version to 5.20.6
- e58837b fix(pick): rotated batched elements unselectable — front-face filter got local-space normals
- dd4bc1e chore: bump version to 5.20.5
- cd86fa9 perf(batch)+fix(hover): fold small instanced groups + per-instance hover on batches
- caa876e fix(ux): Integrations button was added to the wrong header — invisible everywhere
- b385103 chore: bump version to 5.20.4
- eaa53b0 fix(loader): Cancel left the UI in loading state — skeleton rows stuck
- 103b191 perf(batch): retune triggers against the real federation — 0 batches fired
- 6897a1a chore: bump version to 5.20.3
- 1b07b9b test(browser): BatchedMesh identity assertions — the chunk-merge revert symptoms as CI gates (Phase 2)
- 40008d8 perf(viewer): BatchedMesh for pathological models + _ccRenderReport (Phases 0+1)
- c4f9702 docs(memory): BatchedMesh perf plan + history of failed merge attempts
- df996c9 chore: daily memory sync 2026-06-10
- 59e3adf ux(loader): progress labels in plain language, not parser jargon
- 9a2a76e fix(section): plane orientation wrong on instanced surfaces — instance matrix skipped
- fb9e010 feat(loader): Cancel button on the loading strip
- d0e523b chore: bump version to 5.20.2
- 3b8c242 Loader worker fix, plan-cut units, scoped loading, Tauri Phase 0, section gizmo r180 (#599)
- 675f317 chore: bump version to 5.20.1
- 2c69478 fix(restore): spikey model after hard refresh — scale-invariant hash collisions (#598)
- 9dee1d2 chore: bump version to 5.20.0
- c4e1bdf Coordination features, plan-view fix, Integrations UX, loader perf, browser smoke CI (#597)
- ae5cb70 chore: bump version to 5.19.68
- bb77893 Codebase review: connect the WASM engine + fix verified open ends (#596)

</details>

### 2026-06-10
**Summary:** 47 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- d0e523b chore: bump version to 5.20.2
- 3b8c242 Loader worker fix, plan-cut units, scoped loading, Tauri Phase 0, section gizmo r180 (#599)
- 675f317 chore: bump version to 5.20.1
- 2c69478 fix(restore): spikey model after hard refresh — scale-invariant hash collisions (#598)
- 9dee1d2 chore: bump version to 5.20.0
- c4e1bdf Coordination features, plan-view fix, Integrations UX, loader perf, browser smoke CI (#597)
- ae5cb70 chore: bump version to 5.19.68
- bb77893 Codebase review: connect the WASM engine + fix verified open ends (#596)
- 62b025a docs(readme): remove OpenAEC interop mentions
- 979724d chore: bump version to 5.19.67
- f970ddb feat(visibility): multi-sample target + inverse coverage + presets + NL + panel
- 4ebac16 docs(visibility): canonical BCF cc:vis* extension schema in llms.txt
- 16f19d9 chore: bump version to 5.19.66
- cfa55ff feat(visibility): stats chip + BCF cc:vis* round-trip
- 7c30945 chore: bump version to 5.19.65
- fe06bab feat(visibility): 3D sight-line visualization for active visibility clashes
- 41ba4f3 chore: bump version to 5.19.64
- 7baf8e2 feat(visibility): third clash category — sight-line obstruction detection
- 81657bc chore: bump version to 5.19.63
- cc065cb feat(align): per-hotspot snapshots + printable deviation report PDF
- d2fe582 chore: bump version to 5.19.62
- 81ae72d feat(align): ICP refinement + auto-issue at deviation hotspots
- b30d631 chore: bump version to 5.19.61
- 29d81ca feat(bcf): point-cloud reference extension (cc:scanRef) round-trip
- 803d118 chore: bump version to 5.19.60
- 7b16484 feat(align): deviation heatmap — colour scan by distance to nearest IFC
- 20f9b7b chore: bump version to 5.19.59
- 0239b12 docs+ui: surface alignment workflow in README/llms.txt + Align button
- 9b547e8 chore: bump version to 5.19.58
- 4a5358b feat(align): manual 3-point point-cloud ↔ IFC alignment (MVP)
- 0e3b203 chore: bump version to 5.19.57
- 421c711 feat(openaec-bridge): localhost integration with open-pointcloud-studio
- f6f5592 chore: bump version to 5.19.56
- 9a42add feat(pointcloud): proper PTS + PTX parsers (Leica scan formats)
- 0896514 chore: bump version to 5.19.55
- 704837f chore: remove chunk-merge subsystem (#5)
- 267e2df chore: bump version to 5.19.54
- 9fc5260 docs: batch 4 — extract 15 more rationale blocks (§ 21.30-21.44)
- afd5070 chore: bump version to 5.19.53
- 2d07386 docs: batch 3 — extract 12 more rationale blocks (§ 21.18-21.29)
- 629a860 chore: bump version to 5.19.52
- 6219d65 docs: extract 10 more rationale blocks to INTERNALS.md § 21.8-21.17
- 69b3671 chore: bump version to 5.19.51
- ad9339f chore: post-bump simplification — drop r128 fallbacks and bump-prep scaffolding
- b2917b0 chore: bump version to 5.19.50
- 01d0a0b chore(console): gate noisy probe + opt-out warnings to once per session
- 9f6412d chore: daily memory sync 2026-06-09

</details>

### 2026-06-09
**Summary:** 111 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 9fa447f chore: bump version to 5.19.49
- 61f8a46 docs: extract 7 longest rationale blocks from index.html to INTERNALS.md
- 3ec5e85 chore: bump version to 5.19.48
- 2260aae fix(restore): persist geometryExpressID, use as canonical _instKey
- 25a09fb chore: bump version to 5.19.47
- d18ffde diag(restore): detect real hash collisions + add opt-out switch
- 37e53aa chore: bump version to 5.19.46
- d01a75e fix(restore): belt-and-braces _instKey to kill 32-bit hash collisions
- 2d7b6a6 fix(splat): call frameUpdate, the actual Spark per-frame method
- 29c2dd3 chore: bump version to 5.19.45
- 5c41162 fix(restore): hash entire position+index buffer + bump cache version
- 21ef6ae chore: bump version to 5.19.44
- cfaf47c fix(splat): dispatch frame event before render + flip gate flag
- b30c11e chore: bump version to 5.19.43
- 7d17c71 fix(restore): fingerprint position buffer for _instKey
- 8219acb chore: bump version to 5.19.42
- fbcd677 fix(plan): cut-plane arrow + plane unclipped, match section gizmo
- 09b183b chore: bump version to 5.19.41
- a4b1c60 feat(plan): draggable horizontal cut plane in floor-plan view
- 909a4db chore: bump version to 5.19.40
- ca54a1f perf(conflicts): progressive reveal + memo IssueRow
- 297457f chore: bump version to 5.19.39
- 4bb2e23 feat(plan): floor picker in 2D toolbar + cut-height stepper
- f8b6365 chore: bump version to 5.19.38
- 7bc6ca9 fix(ui): measure toolbar no longer kills section box
- 860f674 chore: bump version to 5.19.37
- f6b04ce feat(api): add window.ClashControl.* public namespace alias
- 9d900f9 chore: bump version to 5.19.36
- 2cbe7c7 fix(pick): tiebreak coplanar hits by element size
- 43d6a44 chore: bump version to 5.19.35
- ca7a0c4 chore: remove instancing/survey-marker diagnostic console logs
- e0b176d chore: bump version to 5.19.34
- 25750a4 fix(ui): hide Fit All Clashes / Markers bar when no models loaded
- 6480f30 chore: bump version to 5.19.33
- 78db12f hotfix: defensive bbox shape detection in _geoDeserialize _instKey calc
- 42e7b1d chore: bump version to 5.19.32
- 3f1c99b fix(perf): cache-restore branch also missing _instKey + instancing call
- e26d081 chore: bump version to 5.19.31
- 4941735 fix(perf): instancing regression — matKey was never declared
- f962855 chore: bump version to 5.19.30
- 9d29006 feat(debug): _ccDebugInstancing() console helper — works on already-loaded models
- b5af82f chore: bump version to 5.19.29
- 0feece3 diag: top-of-function ping in instancing + move QualityScore chip to Review workspace
- 832a89a chore: bump version to 5.19.28
- d10194f diag: revert auto chunk-merge + expand instancing diagnostic
- e9a27af chore: bump version to 5.19.27
- f6e7a9e perf(emergency): auto-enable chunk-merge for >5k-element models
- 0559e77 chore: bump version to 5.19.26
- 1bd4065 fix(viewer): hidden-line glass + instancing diagnostics + sRGBEncoding warn cleanup
- 77298a0 chore: bump version to 5.19.25
- 8d37c00 feat(debug): _ccMemReport() console helper — same diagnostic, no popup
- 1cfac35 chore: bump version to 5.19.24
- 7c06569 fix(viewer): drop rendered exposure 0.55 → 0.4 (still too bright at 0.55)
- 74a852b chore: bump version to 5.19.23
- d60e3ce feat(reach): PWA install banner + public Developer API landing page
- d4826f9 chore: bump version to 5.19.22
- d2b9ecd fix(walk): pointer lock on FIRST mouse click — don't try from useEffect
- 9db6d6f chore: bump version to 5.19.21
- fe5096b feat(quality-score): single 0-100 score across data-quality + accessibility checks
- 12f6cbf chore: bump version to 5.19.20
- ac195f9 docs(security): public Security & Privacy page — IFC stays in your browser
- 6103403 chore: bump version to 5.19.19
- 3891aa5 perf(three-bump): explicitly attach all critical THREE classes after spread
- 9ab7ed2 chore: bump version to 5.19.18
- 851281e fix(viewer): disable shadows on remaining section-box helpers + force shadow refresh + diagnostic privacy
- a81656c chore: bump version to 5.19.17
- 35943db fix(viewer): drop rendered exposure 0.7 → 0.55 (still too punchy at 0.7)
- 8b4cb9a chore: bump version to 5.19.16
- b046330 perf(viewer): disable r155+ ColorManagement default to restore pre-bump speed
- a107366 chore: bump version to 5.19.15
- 97471c9 fix(viewer): section-box helpers don't cast shadows + lower rendered exposure
- 9fd0266 chore: daily memory sync 2026-06-08
- bb1b37e fix(splat): kick render-on-demand invalidate during async splat load
- cb92ac4 chore: bump version to 5.19.14
- 995f108 hotfix(lighting): revert × π light intensity overshoot
- cab3365 chore: bump version to 5.19.13
- cf2c8ff hotfix: spread Three.js module namespace into a mutable object before attach
- 62af537 chore: bump version to 5.19.12
- 1359abd Three.js r128 → r180 bump (phased) (#595)
- 8365ab2 chore: bump version to 5.19.11
- bfc8f82 fix(section-gizmo): add TC anchor to scene graph
- 949daab chore: bump version to 5.19.10
- e840a79 fix(ai-status): Settings shows actual model from /api/health, not hardcoded "Gemma 4"
- 2dea5ea fix(splat): layer above IFC instead of forcing the IFC canvas transparent
- dff83b9 chore: bump version to 5.19.9
- 27a7a4b fix(section-box): BX shortcut falls back to single-element selection before full model
- 466931b chore: bump version to 5.19.8
- 77c588c feat(splat): scale/rotation opts, change events, Models-tab inventory panel
- 83c1d63 chore: bump version to 5.19.7
- b14d785 fix(section-box): snap to selected element's bbox, not the merged chunk's bbox
- cbc9fff fix(splat): default-position the splat at the IFC's bbox center
- b831dc1 chore: bump version to 5.19.6
- 7dc30f1 fix(splat): test URL → Spark's hosted butterfly.spz (HuggingFace 404'd) + CSP allowlist
- a86d712 chore: bump version to 5.19.5
- a13639e fix(splat): dedupe Three.js — load Spark's unbundled ESM + document-head import map
- ab3dbd1 chore: bump version to 5.19.4
- e67544b fix(csp+splat): allow data: in connect-src so Spark.js can load its inline WASM
- dd7d267 chore: bump version to 5.19.3
- e3cea72 fix(critical): _ccSetSRGBOutput infinite recursion crashed production
- 6883630 chore: bump version to 5.19.2
- 35c69d9 BCF provenance round-trip, autonomy envelope, splat Phase 1, bump-prep (#591)
- d8cbb1d Claude/jolly cannon yz uwi (#594)
- 2c7c584 fix(health): report Groq as the NL backend, not Gemma (#593)
- 40537b4 docs: refresh Project State (Groq-only NL, v5.19.0) (#592)
- 766c02b chore: bump version to 5.19.1
- e950a99 Security + agentic governance: MCP hardening, AI provenance, autonomy envelope (#589)
- 2c5b01c fix(health): report Groq as the NL backend, not Gemma (#590)
- 0396f6d docs: refresh Project State (Groq-only NL, v5.19.0) (#588)
- c969f8a chore: bump version to 5.19.0
- 3f45b8d feat(ai): make /api/nl Groq-only + nudge to own-LLM for clash-solving
- b2f97c8 feat(ai): Groq as basic NL backend + own-LLM Connector in Ask AI panel

</details>

### 2026-06-08
**Summary:** 50 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- bb1b37e fix(splat): kick render-on-demand invalidate during async splat load
- cb92ac4 chore: bump version to 5.19.14
- 995f108 hotfix(lighting): revert × π light intensity overshoot
- cab3365 chore: bump version to 5.19.13
- cf2c8ff hotfix: spread Three.js module namespace into a mutable object before attach
- 62af537 chore: bump version to 5.19.12
- 1359abd Three.js r128 → r180 bump (phased) (#595)
- 8365ab2 chore: bump version to 5.19.11
- bfc8f82 fix(section-gizmo): add TC anchor to scene graph
- 949daab chore: bump version to 5.19.10
- e840a79 fix(ai-status): Settings shows actual model from /api/health, not hardcoded "Gemma 4"
- 2dea5ea fix(splat): layer above IFC instead of forcing the IFC canvas transparent
- dff83b9 chore: bump version to 5.19.9
- 27a7a4b fix(section-box): BX shortcut falls back to single-element selection before full model
- 466931b chore: bump version to 5.19.8
- 77c588c feat(splat): scale/rotation opts, change events, Models-tab inventory panel
- 83c1d63 chore: bump version to 5.19.7
- b14d785 fix(section-box): snap to selected element's bbox, not the merged chunk's bbox
- cbc9fff fix(splat): default-position the splat at the IFC's bbox center
- b831dc1 chore: bump version to 5.19.6
- 7dc30f1 fix(splat): test URL → Spark's hosted butterfly.spz (HuggingFace 404'd) + CSP allowlist
- a86d712 chore: bump version to 5.19.5
- a13639e fix(splat): dedupe Three.js — load Spark's unbundled ESM + document-head import map
- ab3dbd1 chore: bump version to 5.19.4
- e67544b fix(csp+splat): allow data: in connect-src so Spark.js can load its inline WASM
- dd7d267 chore: bump version to 5.19.3
- e3cea72 fix(critical): _ccSetSRGBOutput infinite recursion crashed production
- 6883630 chore: bump version to 5.19.2
- 35c69d9 BCF provenance round-trip, autonomy envelope, splat Phase 1, bump-prep (#591)
- d8cbb1d Claude/jolly cannon yz uwi (#594)
- 2c7c584 fix(health): report Groq as the NL backend, not Gemma (#593)
- 40537b4 docs: refresh Project State (Groq-only NL, v5.19.0) (#592)
- 766c02b chore: bump version to 5.19.1
- e950a99 Security + agentic governance: MCP hardening, AI provenance, autonomy envelope (#589)
- 2c5b01c fix(health): report Groq as the NL backend, not Gemma (#590)
- 0396f6d docs: refresh Project State (Groq-only NL, v5.19.0) (#588)
- c969f8a chore: bump version to 5.19.0
- 3f45b8d feat(ai): make /api/nl Groq-only + nudge to own-LLM for clash-solving
- b2f97c8 feat(ai): Groq as basic NL backend + own-LLM Connector in Ask AI panel
- dc50d5d feat(bridge): zero-key one-click AI + SEO for IFC viewer / Solibri alternative
- 592979e feat(smart-bridge): one-click connect your own desktop LLM
- 85d4745 feat(accessibility): route failures into Conflicts tab via non-destructive ADD_CLASHES
- 876cd12 docs(memory): record accessibility addon + docs refresh in Active Work
- 49ec0ab feat(accessibility): AccessibilityPanel + issue/BCF wiring
- b0a7de7 feat(accessibility): deterministic geometric accessibility check engine (addon)
- 902a0d4 docs: state current facts directly, drop change-history phrasing
- 8c8c742 docs: thorough refresh — correct engine description, green brand, current addons/APIs, mark shipped perf work
- 7ea2d25 feat(ifc): read IFC4 IfcMapConversion/IfcProjectedCRS + pre-run placement-sanity check
- 645e623 chore: bump version to 5.18.0
- ee509cf chore: daily memory sync 2026-06-07

</details>

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
<!-- END:session-log -->

<!-- BEGIN:cleanup-log -->
### 2026-07-12 — pruned session entry 2026-05-12
**Reason:** Entry is older than 60 days.

### 2026-07-11 — pruned session entry 2026-05-11
**Reason:** Entry is older than 60 days.

### 2026-07-10 — pruned session entry 2026-05-10
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-05-09
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-05-08
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-05-07
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-05-05
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-05-04
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-05-03
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-05-02
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-05-01
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-04-30
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-04-29
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-04-28
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-04-27
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-04-26
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-04-25
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-04-24
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-04-23
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-04-22
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-04-21
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-04-20
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-04-19
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-04-18
**Reason:** Entry is older than 60 days.

### 2026-07-09 — pruned session entry 2026-04-17
**Reason:** Entry is older than 60 days.

## Cleanup Log

Records what was pruned from the session log and why. Permanent.

_Nothing pruned yet._
<!-- END:cleanup-log -->
