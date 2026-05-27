# ClashControl — Shared Session Memory

> Auto-updated daily by `.github/workflows/daily-sync.yml`.
> **Every new Claude session should read this file first** to avoid re-implementing things,
> repeating past mistakes, or working against current direction.
> Update the Active Work and Project State sections as you make progress.

---

<!-- BEGIN:project-state -->
## Project State

**Version:** 4.15.4 (2026-04-16)

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

On branch `claude/upbeat-gauss-lGSLb` (2026-05-22) — "caveman mode" trim pass:

- Removed devtools-only globals from `index.html`: `_ccDebugOn`/`_ccDebugOff` (URL `?debug=1` is alternative), `_ccCompareModels` (~50 lines), and stale `_ccLoadProfile` write-only assignments at the two IFC profile sites.
- Deleted stale docs: `PLAN.md` (66 lines, superseded by MEMORY.md Project State) and `UI_OVERHAUL.md` (1,469 lines, abandoned brainstorm). `INTERNALS.md` kept — it's the target of 26+ "// INTERNALS.md §N" section anchors in `index.html`.
- Re-verified before trimming and chose NOT to remove: `mcp-server.js` (wired via `smart-bridge-server.js --mcp/--install` and referenced in MCP_BUILD_GUIDE.md), `addons/wasm-engine.js` (provides `_ccWasmIntersect`/`_ccWasmMinDist`/`_ccWasmBatchIntersect`), `ws` devDependency (used by `smart-bridge-server.js`), reducer cases with no current dispatch (state fields still read; risk > reward), helper consolidation across 77+ `.find()` sites (risk > reward in one pass), and `api/_models.js` extraction (title.js is single-model, no actual duplication).

On branch `claude/research-global-dictionary-F5W0N` (2026-05-10) — global-dictionary-inspired changes after reading LangSplat v2:  **[STALE?]**

- ~~Target A: pset/quantities canonicalization via stable-JSON + `Object.freeze`. Caches on window (`_ccPsetCanonCache`, `_ccPsetInnerCache`, `_ccQtoCanonCache`); helpers `_ccCanonPsets`/`_ccCanonQuantities`/`_ccPsetCacheStats`. Applied at all six pset assignment sites in the IFC loader plus the worker→main merge and lazy-merge. Dedup ratio logged in IFC Load Profile.~~ (2026-05-10)
- ~~Target B: bounded LRU + TTL title cache in `api/title.js`. Hard cap 200 entries, 1 h TTL, lazy expiry sweep, oldest-first eviction. Cache key = `(elemAType|elemBType|type|sameStorey)`. Returns `X-CC-Title-Cache` and `X-CC-Title-Cache-Size` headers.~~ (2026-05-10)
- ~~Rendered render style: stop overriding IFC-exported colour with keyword presets. `origColor` (from `placed.color` = resolved IfcSurfaceStyle) is preserved as base; keyword on material name now only informs roughness/metalness and glass detection. Glass opacity prefers IFC-defined alpha.~~ (2026-05-10)
- ~~Click-to-fly gated by workspace + Inspector state. Present: never. Review: only when Inspector open. Coordinate: unchanged. New refs `workspaceRef`, `inspectorOpenRef` next to existing `prefsRef` pattern at the on-pick handler (`index.html:8419`).~~ (2026-05-10)
- ~~MEMORY.md correction: founding architecture row described engine as "OBB clash detection" — actually AABB broad + BVH tri-tri narrow with optional WASM acceleration. Live-features bullet and architecture-decisions row updated; new Known Issues entry on IFC spatial hierarchy not being a valid pair-pruning filter.~~ (2026-05-10)
- ~~Phase 1.1: WASM batch hard-clash. New `_warmChunkBatch`/`_runBatch` near `_processCandidate` (`index.html:~3699`). Groups chunk candidates by elA and calls `_ccWasmBatchIntersect` once per group ≥4 items. Populates `_chunkBatchCache` Map; `_processCandidate` consults before falling through to `_meshesIntersect`. Single-pair WASM and JS BVH paths unchanged. New counter `_nHardTestsBatched` in profile output.~~ (2026-05-10)
- ~~Phase 1.2: Detection profile overlay panel. New state `detectProfile`/`detectProfOpen` listening to `cc-detect-profile` event (already dispatched at `index.html:~4000`). Chip + expandable panel show phase breakdown, hard/soft test counts, memo + pair-cache stats. Gated `(coordinate|review) && diagnostics`.~~ (2026-05-10)
- ~~Phase 1.3: `_BVH_CACHE_MAX` adaptive to `performance.memory.jsHeapSizeLimit` (5% budget, ~50 KB/BVH, clamped [300, 2500]). Old constant 300 used as floor.~~ (2026-05-10)
- ~~Phase 2.4: Type-pair impossibility memo, gated by model-unchanged fingerprint. Per-models-key localStorage entry `cc_typePairMemo:<modelsKey>` tracks empty-run counts; pairs at K=3 empty consecutive runs enter `activeMemo` and are skipped at `_processCandidate` entry. Invalidates automatically when model fingerprint (element count + sampled AABBs) or rules hash diverges. 30-day TTL. Manual reset: `window._ccResetTypePairMemo()`.~~ (2026-05-10)
- ~~Phase 2.5: Pair-result cache for narrow phase. Bounded LRU (50000) `_pairResultCache` keyed by `(mA:eidA|mB:eidB|rulesHash)`. When `rules.changeAware` is on and neither element changed, re-emits cached clash instead of dropping silently. Misses not cached (undefined lookup falls through). Cache cleared per-model in `_clearElCaches` on DEL_MODEL / REPLACE_MODEL. Global reset: `window._ccPairCacheClearForModel(modelId)`.~~ (2026-05-10)
- ~~Bbox handle normalization. Section-box corner spheres, face arrows, and rotation ring now tagged with `_baseSize`/`_targetPx` at build time; `tick()` rescales `mesh.scale` every frame to maintain a constant pixel footprint regardless of model scale or camera distance. Perspective + ortho both supported.~~ (2026-05-10)

**Sensitive paths from this session (check first if regressions appear):**

| Suspect symptom | Likely culprit | File / line | Quick verify |
|---|---|---|---|
| TypeError on mutating element pset | Target A `Object.freeze` on canonicalized psets | `index.html:1707-1746` | Console: `window._ccPsetCacheStats()`; check if mutating code wrote into a frozen pset |
| Wrong/duplicate AI clash titles | Title cache returning stale entry | `api/title.js` | Response header `X-CC-Title-Cache` shows cache state; clear by serverless cold start or wait 1 h TTL |
| "Wood looks wrong" / colours differ in Rendered mode | IFC `placed.color` now respected | `index.html:~10218-10266` | Switch to Shaded (uses same colour) and compare; previous behaviour overrode with keyword presets |
| Click on element doesn't fly anymore | Click-to-fly gating | `index.html:~8419` | Check `s.workspace` and `s.inspectorOpen`; Coordinate always flies, Review only with Inspector open, Present never |
| Missed clashes that "should" be there | Type-pair memo wrongly skipped | `index.html:_processCandidate` (memo branch) | Run `window._ccResetTypePairMemo()` then re-detect; check `detectProfile.memo_skipped` |
| Stale/duplicate clashes appearing | Pair-result cache re-emit with bad invalidation | `index.html:_pairResultCache` | Reload model (REPLACE_MODEL hits `_clearElCaches` → cache cleared); or `window._ccPairCacheClearForModel(modelId)` |
| WASM batch returns wrong hits | Batch path mismatch with single-pair WASM | `index.html:_warmChunkBatch`/`_runBatch` near `_processCandidate` | Disable the batch by setting `window._ccWasmBatchIntersect=null` and re-detect; should fall back cleanly to single-pair |
| BVH cache eviction thrashing | Adaptive `_BVH_CACHE_MAX` too high for device | `index.html:2931-2942` | Check `detectProfile.bvh_cache_max`; revert to literal `300` if needed |
| Section handles wrong size after rotate / camera change | Per-frame scale formula assumes default FOV | `tick()` section handle block in `index.html` | Set `mesh.scale.setScalar(1)` on a handle and compare visually |

Plan file: `/root/.claude/plans/i-just-read-about-transient-pnueli.md`.

On branch `claude/improve-walk-mode-tool-gNoMu` (2026-05-05) — walk-mode deep redesign:  **[STALE?]**

- ~~Defaults: walking speed 5.0→1.4 m/s, sprint ×4→×3, collision ON by default, "No-clip"→"Fly" rename~~ (2026-05-05)
- ~~Smart entry: lowest above-ground IfcBuildingStorey across loaded models, placed at storey centroid facing the longest interior axis (`window._ccWalkSmartEntry`)~~ (2026-05-05)
- ~~Pegman drop-in (`WalkPegmanLayer`): hover floor surfaces, footprint reticle + arrow, Shift-drag pre-aims heading, click commits → enters walk mode at point. Esc cancels. New state `s.walkPlacing` + `A.WALK_PLACING`. Toolbar Walk button + WW chord + W single-key + Cmd-K all dispatch placing first.~~ (2026-05-05)
- ~~Teleport-anywhere: double-click in walk mode raycasts any surface with `normal.y > 0.5` (floors, stairs, balconies, parapets) and glides camera over 250–700 ms~~ (2026-05-05)
- ~~Alt held = temporary no-collision burst with visible "⎇ Alt — passing through walls" badge in HUD~~ (2026-05-05)
- ~~Height presets (Eye 1.7 / Child 1.1 / Drone 5.0 m), persisted via `cc_walkHeight`~~ (2026-05-05)
- ~~Floor selector dropdown in HUD (jump to storey across all models)~~ (2026-05-05)
- ~~Crouch: hold-C drops eye height to 1.05 m~~ (2026-05-05)
- ~~Clash proximity radar (Coordinate + Review only): top-right compass, 12 m radius, click dot → teleport-look-at~~ (2026-05-05)
- ~~Minimap (Coordinate + Review only): top-right top-down ortho render of model, you-are-here arrow, click to teleport~~ (2026-05-05)
- ~~Hover element label (Coordinate + Review only): name/type/storey under crosshair, F = open Inspector, I = create issue~~ (2026-05-05)
- ~~Persistent ? cheatsheet (replaces 3-s auto-hide hint)~~ (2026-05-05)
- ~~Mouse sensitivity slider (0.25–3×) + Invert-Y toggle in More panel; persisted~~ (2026-05-05)
- ~~First-click pointer-lock affordance: pulsing dashed reticle becomes 6 px dot once locked~~ (2026-05-05)
- ~~Touch virtual joystick (left bottom) for `pointer:coarse` devices feeds movement like gamepad left-stick~~ (2026-05-05)
- ~~Footstep audio toggle (Present only, off by default; tiny 80 Hz click on each footfall)~~ (2026-05-05)
- ~~Sprint vignette (eased 0..1) + ±3° FOV breathing during sprint movement~~ (2026-05-05)
- ~~B-key bookmark current view (saved to `cc_walkBookmarks`)~~ (2026-05-05)
- ~~Workspace gating: minimap/radar/hover-label/F·I/crouch/sensitivity hidden in Present; head-bob hidden in Review; footsteps Present-only~~ (2026-05-05)
- ~~Bug: `_walkSavedCam.fov` was nulled before being read on exit — now snapshotted into local `saved` first~~ (2026-05-05)

**Key new globals:** `_ccWalkSmartEntry`, `_ccWalkSetHeight`, `_ccWalkSetSensitivity`, `_ccWalkSetInvertY`, `_ccWalkSetFootsteps`, `_ccWalkSetTouch`, `_ccWalkGetYaw`, `_ccWalkSetYaw`, `_ccWalkHoverEl`. New components: `WalkPegmanLayer`, `WalkClashRadar`, `WalkMinimap`, `WalkTouchJoystick`. New state: `s.walkPlacing`, `s.walkEntry`. New action: `A.WALK_PLACING`. New prefs (localStorage): `cc_walkHeight`, `cc_walkCollision`, `cc_walkSens`, `cc_walkInvY`, `cc_walkFoot`, `cc_walkBookmarks`.

**Deferred** (next pass): sun/time slider docked in HUD (Present + Coordinate); spline waypoint recorder for cinematic playback; saved bookmarks UI list; VR mode (WebXR — Phase 7 spike, gated by demand from a "View in VR" probe).

On branch `claude/improve-measurement-tools-yBrCS` (2026-05-04) — measurement deep-redesign:  **[STALE?]**

- ~~Foundations: `_ccFmtLength/Area/Volume/Angle/Deltas`, IFC `IfcUnitAssignment` heuristic detection, `UPD_MEASUREMENT` action, `measureUnits/measurePrecision/measureMagnifier/measureCalibration` prefs~~ (2026-05-04)
- ~~T1.1+T1.2 Snap engine: vertex/midpoint/edge/face/centre detection inside hit triangle, projected to screen with 18-px radius. Shape-encoded cursor glyph (filled circle / rotated square / ring / bullseye / bar) anchored to cursor with live distance chip + ΔX/Y/Z~~ (2026-05-04)
- ~~T1.3 Live preview: dashed terracotta rubberband from last vertex to snap target; closing dotted line in area mode; Shift draws a coloured (R/G/B) axis guide and locks the click to the dominant world axis~~ (2026-05-04)
- ~~T1.5 Keyboard parity: Esc cancels in-progress (then exits), Del/Backspace pops last vertex, Enter closes area, Cmd+Z undo with 20-deep stack, Shift axis-lock and Alt-hover tracking via window flags~~ (2026-05-04)
- ~~T1.6 Toolbar collapse: single Measure button + caret popover (Trimble/FreeCAD pattern) with Distance · Angle · Area · Element · Clearance · Clear all; new architectural-dimension-line icon replaces the flat ruler~~ (2026-05-04)
- ~~T1.7 In-canvas list upgrades: rename (dblclick), hide-eye (◉/⌐), fly-to (click), per-row delete; uses `_ccRelabelMeasurement` so unit changes propagate live~~ (2026-05-04)
- ~~T2.1 Element measure: click an element while in `element` mode → mini-menu lists Qto_*.NetVolume/NetSideArea/Length/etc. converted to metres (heuristic for mm/cm), click to save as `type:'element'` measurement; bbox fallback when no Qto~~ (2026-05-04)
- ~~T2.2 Min-distance / clearance: pick element A then B, sample-vertex × sample-vertex shortest pair (capped 400 each, bbox-corner fallback). Saved as `type:'clearance'` with `refA/refB`. Promote-to-rule button drafts a Detection Rules `minGap` from the value~~ (2026-05-04)
- ~~T2.3 Alt-hover instant distance: hold Alt with an element selected → red dashed leader from its bbox centre to the snap point, value chip at cursor. Stateless — nothing saved~~ (2026-05-04)
- ~~T2.4 Measurements panel: new "Measure" tab in the right Inspector (Coordinate + Review only; hidden in Present). Grouped by type, snapshot thumbs, rename/hide/fly-to/delete, takeoff sub-panel (Review only), CSV export, unit-mode badge in header~~ (2026-05-04)
- ~~T2.5 Snapshot capture: 192×120 jpeg q70 attached on add/update via two-frame deferred renderer.domElement.toDataURL~~ (2026-05-04)
- ~~T3.1 Settings UI: Measurement section with `Display units` (Auto/Metric/Imperial decimal/Imperial fractional 1/16"), `Decimal precision`, magnifier toggle, calibrate launcher~~ (2026-05-04)
- ~~T3.3 Calibration tool: pick two points → prompt for real distance → store multiplier in `prefs.measureCalibration`, applied uniformly in length/area/volume formatters~~ (2026-05-04)
- ~~T3.4 Takeoff: `_ccComputeTakeoff(filter)` walks all `s.models[*].elements`, sums Qto_* across matches; results render in the panel; `_ccExportTakeoffCsv()` for export~~ (2026-05-04)
- ~~T3.5 BCF round-trip: `clashcontrol/measurements.json` sibling file written on export, parsed on import. Other BCF tools ignore the folder~~ (2026-05-04)
- ~~T3.6 NL + MCP: regex pre-block + fuzzy intents for `measure element|clearance`, `takeoff <type>`, `units imperial|metric`. smart-bridge.js handlers `measure` (extended) + new `takeoff` + `set_measure_units`~~ (2026-05-04)

**Follow-ups now landed:**
- ~~T1.4 drag-to-edit endpoints: endpoint dots tagged via `_ccRegisterMeasurementGeo(id, type, dotCount, lineCount)`; `mousedown`-capture handler hit-tests the tagged dot list, disables orbit, drags with re-snap, recomputes value/label, dispatches `UPD_MEASUREMENT` per move and syncs Three.js geometry incrementally for snappy feel. Element measurements (single centroid) are excluded from drag.~~ (2026-05-04)
- ~~T3.2 PointerLens magnifier render: lazy 96-px circular `WebGLRenderer` overlay attached to `document.body`, re-renders the scene with the main camera cloned at FOV/4 looking at the snap point, hooked into the main `tick()` after the primary render. Pref `measureMagnifier` gates activation; visible while measuring or holding Alt.~~ (2026-05-04)

**Key new globals:** `_ccFmtLength/Area/Volume/Angle/Deltas`, `_ccRelabelMeasurement`, `_ccDetectIfcUnitSystem`, `_ccMeasureUnitMode`, `_ccCalibration`, `_ccComputeSnap`, `_ccUpdateMeasurePreview`, `_ccCancelInProgressMeasurement`, `_ccPopLastMeasureVertex`, `_ccCloseArea`, `_ccUndoMeasurement`, `_ccPromoteClearanceToRule`, `_ccComputeTakeoff`, `_ccExportTakeoffCsv`, `_ccStartCalibration`, `_ccResolveElementForObject`, `_ccOpenElementMeasureMenu`, `_ccPickElementMeasure`, `_ccComputeClearance`, `_ccCaptureMeasurementSnapshot`, `_ccFlyToMeasurement`, `_ccDropInProgressDots`, `_ccForceCloseArea`. Modifier flags: `_ccShiftHeld`, `_ccAltHeld`, `_ccAltHoverFrom`, `_ccCalibrationPending`, `_ccClearancePickA`, `_ccElementMeasureMenu`, `_ccPreviewTarget`, `_ccLastTakeoff`.

**Workspace gating:**
- All workspaces: Measure button, snap engine, live preview, in-canvas list, Alt-hover
- Coordinate + Review: Measure tab in Inspector, Element + Clearance sub-modes, calibration
- Review only: Takeoff sub-panel
- Present: kept clean — no panel, no Element/Clearance buttons, no Qto_* UI

On branch `claude/research-design-tools-TzNQG` (2026-05-03) — in progress:  **[STALE?]**

- ~~ViewCube fix: renderer size 120→74, arrows removed, face-click navigation correct~~ (2026-05-03)
- ~~A1: All toolbar tooltip shortcut hints fixed/added; keyboard handlers added for O, R, F, N, I, B, W, Shift+M~~ (2026-05-03)
- ~~A2: Clashes panel — "Conflicts"→"Clashes", Group/Sort pills→compact `<select>` dropdowns~~ (2026-05-03)
- ~~A3: Issues panel — compact BCF Export `▼` dropdown, + From clash button, active clash pre-fills modal~~ (2026-05-03)
- ~~A4: Detection Rules panel — "Clash Rules"→"Detection Rules", "Hard always flagged"→"Always treat as hard clash" + tooltip, IFC type datalist autocomplete~~ (2026-05-03)
- ~~A5: Navigator panel — Spatial/Tree modes renamed ("Hierarchy"/"Flat list" + title hints), search shown in all modes (filters groups in classification views)~~ (2026-05-03)
- ~~A6: Data Quality panel — severity legend dots, last-checked timestamp, Export CSV button, Create all issues bulk button, IDS section in labeled card~~ (2026-05-03)
- ~~B2: PDF export via `window.print()` — toolbar button captures 3D canvas screenshot into print-ready page~~ (2026-05-03)
- ~~B3: Walkthrough recording — `canvas.captureStream()` + MediaRecorder → .webm download; Record toolbar button with active state~~ (2026-05-03)
- ~~B4: Material preview in Rendered mode — keyword PBR presets (glass/metal/concrete/wood/brick/gypsum/insulation)~~ (2026-05-03)
- ~~B5: X-Ray render style (key 5) — all geometry semi-transparent (opacity 0.22, DoubleSide)~~ (2026-05-03)
- ~~B6: Area measurement toolbar button + hover coordinate display (X/Y/Z) when in measure modes~~ (2026-05-03)
- ~~Engine selector moved out of Detection Rules into a visible Coordinate-toolbar pill~~ (2026-05-03)
- ~~Per-storey hide/show toggle (eye icon on each storey row in Navigator Hierarchy/Flat list)~~ (2026-05-03)
- ~~B8: Selection sets — save/restore named element groups, persisted in .ccproject~~ (2026-05-03)
- ~~B2 (rest): Rich markup tools on the 3D canvas (line/arrow/rect/text/freehand) with SVG overlay; PDF export now includes the markup overlay~~ (2026-05-03)
- ~~B7: Design option compare — pick two models, blend visibility 0–100%~~ (2026-05-03)
- ~~B1: Numbered Sprite pins (Speckle pattern) + @mention highlighting in comments + replies~~ (2026-05-03)

**Plan complete.** All Section A and Section B items shipped on this branch.

On branch `claude/redesign-modern-ui-JLbhU` (2026-05-01) — landed:  **[STALE?]**

- ~~Tokens: paper / ink / terracotta palette; legacy `--bg-primary` / `--accent` tokens aliased so 19k lines auto-pick up the new aesthetic~~ (2026-05-01)
- ~~Typography: Fraunces (display, opsz) + Instrument Sans (body) + DM Mono — Inter / Roboto / Syne all dropped per anthropics/skills frontend-design guidance~~ (2026-05-01)
- ~~Light theme by default; pre-paint script reads `cc_theme` to avoid flash~~ (2026-05-01)
- ~~Workspace switcher (Present / Coordinate / Review) in DesktopTopBar with `cc_workspace` persistence + `A.SET_WORKSPACE` action; ephemeral `avatarMenuOpen` separate from persisted `cc_panelOpen` / `cc_inspectorOpen` / `cc_askOpen` / `cc_diagnostics`~~ (2026-05-01)
- ~~AvatarMenu component (avatar circle bottom-right of top bar): consolidates project switcher, theme toggle, settings, presentation, keyboard-shortcuts trigger, "Open model"~~ (2026-05-01)
- ~~Horizontal xeokit-style TopToolbar (View · Section · Measure · Camera · Notes · Style) replaces the prior PR-2 bottom mode pill; ModeToolbar aliased to `() => null`~~ (2026-05-01)
- ~~LeftRail rewritten: returns null in Present, slim 48-px workspace-scoped tab list in Coordinate / Review (project switcher / IFC / walk / 2D / share / theme / settings buttons all removed — they have new homes)~~ (2026-05-01)
- ~~Ask AI demoted: 36-px round bottom-right canvas button with chat-bubble glyph; pulsing violet pill removed; `nlBorderPulse` keyframe neutralised~~ (2026-05-01)
- ~~WelcomePopup redesigned: asymmetric paper card, Fraunces "Open a model." headline, drawn isometric ballast, three flat row links (Choose · URL · Sample), no glass/dashed/scrim~~ (2026-05-01)
- ~~Conflict row: emoji icon (🔴/🟡/🏗/📌) replaced by 7-px severity dot using --sev-* tokens; storey 🏢 → hairline-bordered label; 💬 → text "note"; distance "⬤ 42mm gap" → mono "42 mm"~~ (2026-05-01)
- ~~FPS overlay gated behind `s.workspace==='review' && s.diagnostics` (off by default; toggle lives in LeftRail in Review)~~ (2026-05-01)
- ~~Sky gradient + grid: warm paper tones (--scene-floor → --scene-bg → --paper-bg); grid opacity 0.30 → 0.12; ACES Filmic tone mapping confirmed already on~~ (2026-05-01)
- ~~Glass tokens neutralised (`--glass-bg`/`--glass-border`/`--glass-blur` → solid surface + hairline + none); cc-overlay-chrome / DesktopTopBar / cc-mobile-nav backdrop-filter dropped~~ (2026-05-01)
- ~~Favicon flat ink mark (square outline + terracotta diagonal); boot screen flat ink + Fraunces wordmark; theme-color metatag #f5f2ec~~ (2026-05-01)

**Deferred** (next pass):
- Right Inspector drawer two-tab restructure (Details · Notes); the existing AIChatPanel is now reachable only via the small Ask button but its body wasn't restructured.
- Inline AI training feedback row on conflicts (`index.html:13860+`) — still inline; should move to Review › Improve.
- Cleanup of remaining `nlBorderPulse` animation calls (now no-ops on visible chrome but still wasted CPU).
- Sample-model URL in WelcomePopup uses an external GitHub raw — should ship a tiny bundled IFC instead.
- Soft contact shadow plane and 35° dollhouse fly-to on first model load — planned but not implemented this pass.
- Help / keyboard shortcuts modal (the AvatarMenu dispatches `cc-show-shortcuts` event but no listener mounts the overlay yet).

Earlier branch `claude/improve-ifc-viewer-ux-WhTsB`: full UI overhaul for architectural audience.
The PR-1..PR-8 overhaul shipped but felt AI-assembled (glass everywhere, violet
gradient, FPS overlay, status-pill explosions, raw IFC jargon on rows). This
pass resets type & chrome:

- Paper + ink + ONE terracotta accent (`#b8533a`); no glassmorphism, no
  gradients, no emoji in chrome. Light theme by default.
- Inter + DM Mono only (Syne dropped).
- Workspace switcher in the top bar — `Present` / `Coordinate` / `Review`.
  Present is the default and hides clash/IDS/training/diagnostics entirely.
- xeokit-bim-viewer style **horizontal top toolbar** (View · Section · Measure ·
  Camera · Notes · Style). Replaces the prior PR-2 bottom mode pill and the
  LeftRail tools.
- Single-path-per-function pass: each function has exactly one canonical
  surface + optional shortcut. Visible buttons everywhere — no hotkey-only
  affordances. Avatar menu consolidates project switcher / theme / settings /
  presentation / shortcuts.
- Ask AI demoted: small bottom-right round button only (no pulse, no glow,
  removed from right Inspector tabs).
- Persistence: workspace, theme, render style, tool, panel/inspector/Ask state,
  diagnostics, grid, floor shadow all write to `localStorage` and rehydrate.
- Cinematic defaults: ACES tone-mapping, soft contact shadow, faint horizon,
  grid opacity 0.12, 35° dollhouse fly-to on first model load.
- Conflict row simplified to severity dot + title + assignee. IFC type code
  and IDs hide under Inspector "Technical" disclosure.

Plan file: `/root/.claude/plans/there-has-been-a-gentle-ember.md`.

Earlier branch `claude/improve-ifc-viewer-ux-WhTsB`: full UI overhaul for architectural audience.
Full 8-PR migration completed (2026-04-30):  **[STALE?]**

- ~~PR-1: violet accent (#7c3aed), rounder radii, glass surface tokens~~ (2026-04-30)
- ~~PR-2: bottom ModeToolbar — Orbit/Walk/Slice/Measure/Plan/Note chips~~ (2026-04-30)
- ~~PR-3: DesktopTopBar (slim, glass, Share accent pill)~~ (2026-04-30)
- ~~PR-4: violet left rail tabs, grid opacity 0.3, blue→violet color sweep~~ (2026-04-30)
- ~~PR-5: Right drawer — AIChatPanel gains Details + Ask AI tabs; polls window._ccSelectedEl; shows element type/name/floor/psets/linked issues~~ (2026-04-30)
- ~~PR-6: Naming pass — Clashes→Conflicts, Addons→Integrations, Viewpoints→Saved views, Storey→Floor in all UI labels~~ (2026-04-30)
- ~~PR-7: ModelLoadCard replaces WelcomePopup — drag/drop or click to browse, open from URL, link shared folder; shown only when models.length===0~~ (2026-04-30)
- ~~PR-8: Overlay panels (LeftRail/LeftPanel float over canvas); mode mutex in reducer; Slice sub-tool position slider; ModeToolbar feature flag removed~~ (2026-04-30)

Also resolved conflict with origin/main: kept revit keep-partial/discard buttons from `9772053`, used violet CSS tokens.

UI_OVERHAUL.md written (7 chapters, 1469 lines). PLAN.md updated.
<!-- END:active-work -->

<!-- BEGIN:session-log -->
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
