# INTERNALS.md — Architecture & Code Reference

This document replaces the inline comments that were stripped from `index.html`. Each section corresponds to a `// ── Section Name ──` header in the code. Use Ctrl+F in `index.html` to find the matching header.

---

## 1. Boot & Initialization

**Code section:** `// See INTERNALS.md` (top of `<script>`)

The app boots in `window.onload → startApp()`. Before anything runs, CDN dependencies are verified (React, Three.js, htm, JSZip). If any are missing, boot fails with an error message.

Key globals created at startup:
- `html` — htm tagged template bound to `React.createElement`
- `CC_VERSION` — auto-updated by the pre-commit hook (`scripts/bump-version.sh`)
- `_gcEvent()` — GoatCounter analytics (no-op if not configured)
- `uid()` / `guid()` — random ID generators

## 2. Constants & Chat Text

**Code section:** `// ── Constants ──` and `// ── Chat text renderer ──`

- `DISC` — discipline definitions (structural, MEP, architectural, civil, other) with colors
- `STAT` — clash/issue status labels and badge colors
- `renderChatText()` — sanitizes Gemma markdown output (strips `###`, converts `**bold**` to `<strong>`, normalizes bullets). Gemma is told to avoid markdown but sometimes emits it anyway, so this is defensive.

## 3. Pending Offer System

**Code section:** `// ── Pending offer system ──`

When the assistant can't fulfill a command (no models loaded, no clashes detected), it parks a one-click action in `window._ccPendingOffer`. The next "yes" in chat executes it instantly without hitting the API. This runs before fast-path and before `/api/nl`.

## 4. State Management (Reducer)

**Code section:** `// ── Reducer ──`

Single `useReducer` with action types (`A.LOAD_MODEL`, `A.MERGE_CLASHES`, `A.WALK_MODE`, etc.). The `INIT` object defines the full state shape. Dispatch is exposed globally as `window._ccDispatch` for addons.

The reducer also handles addon-injected cases via `reducerCases` from `_ccRegisterAddon`. Action types like `UPD_LOCAL_ENGINE`, `UPD_SMART_BRIDGE`, `UPD_REVIT_DIRECT` are registered by their respective addons.

State is persisted per-project via IndexedDB (clashes, issues, rules) and localStorage (project list, addon states, preferences).

## 5. Addon Registry

**Code section:** `// ── Addon Registry ──`

Addons register via `window._ccRegisterAddon({id, name, initState, reducerCases, init, destroy, onEnable, panel, ...})`. The core merges `initState` into `INIT` and `reducerCases` into the reducer at registration time.

Addon active states are persisted in `localStorage('cc_addons_active')`. Addons are lazy-loaded as `<script>` tags from `addons/` — the core works without any of them.

## 6. IndexedDB Persistence

**Code section:** `// ── IndexedDB persistence for IFC files ──`

IFC file blobs and parsed geometry caches are stored in IndexedDB for instant project-switch without re-parsing. Three stores:
- `ifc-files` — raw IFC file blobs (for re-parse/export)
- `geo-cache` — parsed geometry (vertices, indices, materials) per model
- `project-data` — clashes, issues, rules, viewpoints per project

The geometry cache uses quantized 16-bit positions and 8-bit normals to reduce storage size.

## 7. IFC Loader

**Code section:** `// ── IFC Loader (web-ifc, lazy) ──`

web-ifc WASM is lazy-loaded via ESM (`import()`) on first model load to avoid blocking initial page render. A 10-second timeout detects WASM init hangs (common on slow connections) and offers retry.

**Property extraction pipeline:**
1. `extractProperties()` reads element metadata (GlobalId, Name, IFC type, storey, material)
2. `_extractAxis()` reads placement direction for parallel-axis clash rejection
3. Quantities and property sets are extracted lazily in Phase 2 (after geometry streaming completes) to avoid blocking the 3D view

**Element filtering:** `IfcOpeningElement` is filtered entirely (void cutters). `IfcSpace`, `IfcVirtualElement`, `IfcAnnotation`, `IfcGrid` have meshes cleared but are kept as stubs for storey navigation and classification.

**IFC type constants:** The `IFC` object maps constant names to numeric IDs (from the IFC schema). `IFC_TYPE_NAMES` is built from `IFC` to provide human-readable names — defined once, no numeric ID duplication.

**Spatial hierarchy & georeferencing:** `extractSpatialHierarchy()` reads `IfcProject` / `IfcSite` / `IfcBuilding` into `model.spatialHierarchy`. Site georef comes from `IfcSite` RefLatitude/Longitude (compound plane-angle → decimal). IFC4 projected georeferencing (`IfcMapConversion` + `IfcProjectedCRS`: EPSG, Eastings/Northings/Height, grid rotation) is read into `spatialHierarchy.mapConversion`. This is used for **display** and the **pre-run placement-sanity check** (`window._ccPlacementWarnings` — warns when federated models declare different CRS or don't overlap) — **not** by the clash engine, which always works in local coordinates. The `geoplace` addon consumes both for the basemap.

## 8. Lazy-Props Merge & Web Worker

**Code section:** `// ── Lazy-props merge helper ──` and `// ── IFC Web Worker ──`

Phase 2 property extraction runs after geometry is displayed. Results are merged back into elements via `_propsVersion` counter bumps so React components re-render with fresh data. The geo cache is also patched (only `elData.props`, not meshes — those are quantized and immutable).

The web worker (`_ifcWorkerCode`) runs IFC parsing off the main thread. It handles geometry streaming via transferable ArrayBuffers. `IfcOpeningElement` is the only type skipped in the worker — other no-render types need the worker's re-add pass.

## 9. Clash Detection Engine

**Code section:** `// ── Clash Detection ──` through `// ── Profiling summary ──`

Multi-level detection pipeline:
1. **L0 — Sweep and Prune:** O(n log n + k) broad phase using axis-aligned bounding box overlap on the longest axis. Generates candidate pairs.
2. **L1 — BVH dual-tree traversal:** Bounding Volume Hierarchy narrows to triangle-level. Each mesh gets a BVH built on first use and cached.
3. **L2 — Moller triangle-triangle intersection:** Exact triangle intersection test for hard clashes. For soft/clearance clashes, a spatial hash computes vertex-to-surface distances.

**Parallel axis rejection:** Before BVH traversal, elements with known IFC axis directions (beams, pipes) are checked for parallelism. Parallel elements at different positions are skipped — zero false negatives, significant speedup.

**Async chunked processing:** Detection runs in chunks of ~80 candidate pairs, yielding to the event loop between chunks so the UI stays responsive. Generation counter cancels stale runs.

**Delta merge:** `mergeClashes()` preserves user edits (status, priority, title) across re-runs by matching clashes on GlobalId pairs. New clashes are appended, missing ones are auto-resolved.

## 10. AI Auto-Classifier

**Code section:** `// ── AI Auto-Classifier ──`

Rule-based classifier runs synchronously after detection (before `MERGE_CLASHES` dispatch). Labels each clash with `aiSeverity`, `aiCategory`, `aiReason`. False-positive types (IfcOpeningElement, IfcSpace) override everything.

The Clashes panel then de-dupes results into **cluster cards** keyed by element pair (`_ccClusterKeyFor` — sorted GlobalId/eid pair, model-prefixed when GUID missing), so the same pipe-through-beam emitted at many sample points collapses into one expandable group. An optional `/api/triage` call enriches a cluster with `{title, severity, explanation, resolution_options}` (`window._ccBuildClusterContext` builds the packet). Grouped-by-cluster is the default view.

## 11. BCF Import/Export

**Code section:** `// ── BCF Import ──` and `// ── BCF Export ──`

Supports BCF 2.1 and 3.0. Export creates a ZIP with one folder per topic (clash/issue). Each topic gets `markup.bcf` (XML) and optionally a `viewpoint.bcfv` with camera state. Import parses the ZIP and creates issues from topics.

Optional sheet plan attachment: if a 2D sheet is active during export, the canvas is captured as a PNG snapshot and included in the BCF viewpoint.

## 12. Walk Mode (First-Person)

**Code section:** `// ── First-Person Walk Mode ──`

WASD movement + pointer lock mouse look. Camera is positioned at eye height (1.7m) above the selected storey elevation.

**Unit scale:** `_walkUnitScale = _ccDetectUnitScale() * _ccStoreyToGeoFactor()` converts between IFC native units and geometry coordinates. Speed, eye height, near/far planes, and collision padding are all scaled by this factor.

**Nav cube sync:** `_walkApplyLook()` updates `S.orbit.sph.theta/phi` so the navigation cube reflects the walk view direction. Formula: `theta = yaw + PI`, `phi = PI/2 + pitch` (derived from orbit-camera-position vs walk-forward-direction geometry).

**Collision:** Simple raycast against model meshes. Blocked movement slides along walls via surface normal projection.

## 13. Orbit Controls

**Code section:** `// ── Orbit Controls (inline) ──`

Spherical coordinates (`sph.r`, `sph.phi`, `sph.theta`) with `apply()` to update camera position. Mouse drag rotates, middle-button pans, scroll zooms. Touch support: single-finger rotate, two-finger pinch-zoom + pan.

**Walk mode guard:** Orbit's wheel handler returns early when `_walkActive` is true — prevents `orbit.apply()` from snapping the camera back to orbit position during walk mode.

Pre-allocated vectors (`_tmpVec`, `_tmpDir`, `_tmpRight`) avoid per-frame allocations in the hot path.

## 14. Three.js Viewer

**Code section:** `// ── Three.js Viewer Component ──`

Three.js r128 (not latest — some newer APIs won't work). WebGL1 renderer with antialiasing.

**Render-on-demand:** `_needsRender` counter, decremented each frame. `invalidate(frames)` sets the counter. When `_needsRender <= 0`, the render pass is skipped — saves GPU when nothing changes.

**Frustum culling:** Runs every N frames. Camera fingerprinting (`_camFingerprint()`) short-circuits the cull pass when the camera hasn't moved — big win during idle frames.

**Material swapping:** Render styles (standard/shaded/rendered/wireframe) swap mesh materials. Original saved as `mesh._origMaterial`. Ghost material is a shared `MeshBasicMaterial({color:0x334155, opacity:0.08})`.

**GPU instancing:** A post-streaming pass (`_buildInstancedMeshes`) collapses repeated `(geometry, material)` pairs into `THREE.InstancedMesh` to cut draw calls; raycast/hover/ghost/culling map `instanceId → expressId`. An optional spatially-clustered chunk-merge pass (`_ccChunkMerge`) exists but currently defaults off. Geometry normals are stored as Int8 to cut VRAM (~630 MB at large federation scale).

**View cube:** Separate mini Three.js scene. Rotation derived from `orbit.sph.theta/phi` (not `camera.quaternion`) to avoid gimbal lock. Hit-zone detection identifies face/edge/corner clicks for navigation.

## 15. Fly-To Animation

**Code section:** `// ── Animated fly-to system ──`

Cubic ease-in-out interpolation between current and target camera positions. Duration auto-scales with travel distance (400ms minimum, 1200ms cap). Auto-detects whether to preserve camera angle or re-orient based on travel distance vs current camera distance.

## 16. 2D Sheets

**Code section:** `// ── Annotated Sheets ──` (in the App section)

`generate2DOutlines()` cuts model geometry at a storey elevation, producing line segments. Coordinate mapping: `(-seg[0], seg[1])` — mirror X, use Z directly (matches architectural convention).

**Storey elevation conversion:** `_ccStoreyToGeoFactor()` detects the ratio between raw IFC storey elevations (may be mm) and geometry bounding box coordinates (always metres from web-ifc). Sheet elevation = raw elevation * geoFactor.

**Canvas:** HiDPI via `devicePixelRatio`. Zoom-to-cursor adjusts pan to keep the mouse world-position stationary during zoom.

## 17. NL Command System

**Code section:** `// ── Natural Language Command Panel ──`

Three-tier processing:
1. **Pending offer check** — instant "yes/no" confirmation, no API call
2. **Fast-path regex** — `_isFastPathCommand()` detects trivially simple commands ("help", "top view", "dark mode") and handles locally via `processNLCommand()`
3. **Server AI** — `callServerNL()` sends to `/api/nl` (Gemma with function calling). On 429 (quota), falls back across Gemma variants. On total failure, falls back to regex.

**Pre-block heuristic:** Before hitting the server, checks if the command needs state we don't have (no models → offer to load, no clashes → offer to detect). Uses two tiers: BIM-specific terms always block, ambiguous terms only block for short inputs (<=8 words) to avoid catching casual conversation.

`processNLCommand()` is the regex engine (~200 patterns covering views, filters, detection, export, settings, etc.). `processNLCommandWithLLM()` wraps the full pipeline with training data capture and rephrase detection.

## 18. Clash Panel & UI Components

**Code section:** `// ── Left Panel ──`

All UI uses Preact components returning `html\`...\`` tagged templates. Conditional mounting (`${condition && html\`...\``}`) — Preact only mounts when condition is true.

Clash panel has sort/filter/group controls, inline editing (status, priority, assignee), batch operations, and a detection setup card for conversational clash configuration.

## 19. Keyboard Shortcuts

**Code section:** `// ── Global Keyboard Shortcuts ──`

Revit-style two-key chord system. First key starts a chord (stored in `_chord`), second key completes it. Timeout after 800ms. Examples: `SC` = cycle section, `ZF` = zoom to fit, `VV` = restore viewpoint.

## 20. App & Mount

**Code section:** `// ── App ──` and `// ── Mount ──`

`App` is the root component. Manages project switching, changelog recording, shared project sync, memory monitoring, PWA state, and addon initialization.

Mount uses `ReactDOM.createRoot` (React 18) with `ErrorBoundary` fallback. Addon scripts are loaded after mount via `_loadAddonScripts()`.

**Memory cleanup:** Periodic (every 2 minutes) — flushes BVH caches when not detecting, purges stale geometry cache entries for unloaded models.

---

## Performance Notes

- **Render-on-demand** saves GPU when idle (most of the time in a BIM review tool)
- **Frustum culling** with camera fingerprinting skips the scene traversal when camera hasn't moved
- **Pre-allocated vectors** in orbit controls avoid GC pressure in the 60fps hot path
- **Async chunked detection** keeps UI responsive during clash runs
- **Quantized geometry cache** (16-bit positions, 8-bit normals) reduces IndexedDB storage by ~60%
- **GPU instancing** (`_buildInstancedMeshes`) collapses repeated geometry into one draw call; **Int8 normals** cut VRAM (~630 MB at large federation scale)
- **Adaptive BVH cache + pair-result cache** persist across detection runs (cleared per-model on `DEL_MODEL`/`REPLACE_MODEL`)
- **Lazy WASM loading** avoids blocking initial page render with a 5MB download
- **Delta merge** preserves user work across re-detection without re-classifying resolved clashes

---

## 21. Extracted Code Rationale

Long-form rationale blocks that used to live inline in `index.html`. Each subsection corresponds to a `// See INTERNALS.md § 21.x` reference in the code.

### 21.1 Three.js bump-prep harness

**Code reference:** `// ── Three.js bump-prep harness ──` (near the top of `startApp()`)

`THREE_VERSION` + `THREE_EXAMPLES_BASE` constants centralize the CDN version so the next bump touches one place instead of six string literals. The examples-base also drives the on-demand loader scripts (GLTFLoader, TransformControls, PLYLoader, PCDLoader, EffectComposer chain, etc.).

When bumping the Three.js version:
1. Update `THREE_VERSION` and `THREE_EXAMPLES_PATH` constants.
2. Switch the `<script>` tag in `<head>` to the new build URL (ESM at r161+ — checklist covers it).
3. Regenerate SRI hashes via `scripts/generate-sri.js`.
4. Replace `_ccSetSRGBOutput`'s r128 branch with the modern branch.

Everything else in the codebase keeps working.

### 21.2 Graduated autonomy envelope

**Code reference:** in `INIT.prefs.aiEnvelope` default initialization.

Per-project setting (currently global) that defines what the built-in AI is permitted to do without escalation. Based on Day, *AEC Magazine* — "Agentic BIM's missing infrastructure" (Apr 2026).

- `nudge` — current default. Clash-resolve / fix queries return a "connect your own LLM" message; the built-in assistant never proposes a fix.
- `suggest` — connected own-LLM (Smart Bridge) may reason and reply with options, but never dispatches state changes. Architect remains decision-maker.
- `auto` — reserved. Agent may dispatch reversible state changes (mark resolved, set severity) without confirmation. Off by default, no UI to enable yet — the literal exists so we don't need to migrate later.

Per-project scoping arrives when a project record exists for solo (non-shared) use.

### 21.3 Cache-restore chunk-merge + instancing parity

**Code reference:** end of `_geoDeserialize()` after element reconstruction.

The restore path runs the same draw-call optimisations as the live load path (survey-marker strip, instancing, chunk-merge). Before this, restore-from-cache (project switch / reload) bypassed chunk-merge entirely — a reloaded session showed "0 merged chunks" and 146k draw objects even with the flag ON.

`el.meshes[]` stays per-element (chunk-merge mutates only the render list), so clash detection and highlight are unaffected. `_instKey` is set per mesh via the `gid` (cache v:7+) or fingerprint fallback (older caches) so instancing runs cleanly on restored meshes.

### 21.4 Spatial chunk-merge — REMOVED

Removed in the post-bump simplification pass. The trial baked same-material elements per grid cell into one merged BufferGeometry; won draw-call count but collapsed visual distinctions, broke Style switching, and required parallel maintenance of picking, hide, and color-by-class code paths. Flag was default-OFF for months. Memory wins are kept independently (`_ccGetSharedPhongMat`, `_ccQuantizeNormalAttr`, survey-marker strip). See git history for the implementation.

### 21.5 Pset / Quantities canonicalization

**Code reference:** `_ccCanonPsets` / `_ccCanonQuantities` setup.

Many IFC elements share byte-identical property sets — every wall of a type carries the same `Pset_WallCommon`, every column the same `Pset_ColumnCommon`. In a 50k-element model with ~50 unique signatures, naive storage allocates ~50k pset objects where ~50 would do.

Canonicalize twice: once on each inner pset (high-frequency hits), once on the outer container (full combination). Frozen objects are returned as-is — that's the marker for "already canonical, don't re-hash". Caches live on `window` so they survive across model loads in the same session; re-loading a model finds the same canonical refs.

### 21.6 Survey base-point / nulpunt marker stripping

**Code reference:** `_ccIsSurveyMarker()` / `_ccStripSurveyMarkers()`.

Some IFC files ship surveyor "project zero" / base-point reference markers as `IfcBuildingElementProxy` elements whose geometry is extruded 3-D text of the company / project name (e.g. "PIETERS", "KLI_Nulpunt"). They sit at the project origin, often mirrored or at odd scale, and:
- render as giant floating letters in the viewer
- generate junk clashes against each other (the source of the `-197000 mm` / `-1.1e10` sentinel-distance pairs).

They carry no coordination value, so they're dropped from both the render list and the clash set at load time — same treatment the loader gives openings / spaces / grids (just matched by name, since the IFC type is a generic proxy).

### 21.7 Tiered AI — basic assistant vs. your own LLM

**Code reference:** in the NL-command routing logic.

The built-in assistant (Groq) handles basic commands + light Q&A. Real clash-resolution / fix suggestions need a stronger model: route to the user's own LLM via the Connector when connected, otherwise nudge them to connect it in one click — warm-up toward the bring-your-own-LLM tier.

Graduated autonomy: the envelope (`s.prefs.aiEnvelope`) decides what's allowed without escalation. `mode='nudge'` (default) routes clash-resolve to the user's own LLM if connected, else returns the connect message. `mode='suggest'` is the same path for now (own-LLM produces advice, never dispatches state).

### 21.8 BVH LRU cache (bounded cross-run reuse)

**Code reference:** `_BVH_CACHE_MAX` and the BVH cache `Map`.

Keeps the last `_BVH_CACHE_MAX` element BVHs alive between detection runs so re-runs on the same model don't rebuild. A `Map` preserves insertion order, so `delete+set` gives O(1) move-to-end (LRU touch) and `keys().next()` gives O(1) eviction of the oldest entry.

Cap is adaptive to available heap when the runtime exposes it (Chromium). Average BVH is ~50 KB; we allow ~5% of the heap budget, clamped to [300, 2500] so small devices stay safe and big workstations don't thrash.

### 21.9 Int8 normal quantization

**Code reference:** `_ccQuantizeNormalAttr()`.

Shrinks the resident normal attribute from Float32 (12 B/vert) to normalized Int8 (3 B/vert). Normals are a render-only attribute — the GPU normalizes them in the vertex shader, and nothing on the CPU side (clash `_getWorldVerts` / `_getWorldTris`, raycast picking, measurement snap) reads them. Precision-safe for everything but lighting, where 1/127 angular resolution is imperceptible.

Positions stay Float32 (quantizing them needs a dequant-aware CPU read path). Idempotent + shared-geometry safe (guarded on `geo.userData`).

### 21.10 GPU instancing — _buildInstancedMeshes

**Code reference:** `_buildInstancedMeshes()`.

Collapses repeated placements into `THREE.InstancedMesh`. `elements[]` and `meshes[]` are mutated in-place. Individual proxy meshes remain in `element.meshes` for clash detection (geometry + baked matrixWorld). Returns `{meshes, groups, instanced}`.

### 21.11 Render styles — materials per style

**Code reference:** the style switcher useEffect.

- `standard` ("Hidden Line") — flat white/gray surfaces, intended for technical-drawing aesthetic (architectural edge lines are TODO — not currently drawn). polygonOffset would push surfaces back so edges stay in front.
- `shaded` — IFC colors + Lambert. Same as Revit "Consistent Colors". Clean, well-lit, no shadows. Matches professional massing renders.
- `rendered` — PBR + IBL + directional sun + static shadow map.
- `wireframe` — `MeshBasicMaterial` wireframe.

FrontSide everywhere — DoubleSide doubles shadow contributions and z-fights.

### 21.12 Render-style lighting (Revit-inspired)

**Code reference:** the style switcher's tone-mapping / light-intensity branch.

- `standard` → flat white surfaces, thin black edges (technical drawing)
- `shaded` → original colors, ambient-only, no shadows (architectural massing)
- `rendered` → PBR-like, sun + shadows + contact plane (presentation)
- `wireframe` → edges only, transparent fills (CAD wireframe)

Rendered exposure dropped 1.0 → 0.4 after the r180 bump — post-r155 tone-mapping reads brighter than r128 at the same exposure even without any light-intensity change.

### 21.13 Section-box drag — closest-point axis math

**Code reference:** section-box face-arrow drag handler.

Robust axis drag uses the closest point between the mouse ray and the face-normal line through the handle. The earlier ray ∩ plane approach became ill-conditioned when the camera looked nearly along the face normal (side arrows viewed edge-on) — the plane was near-parallel to the view ray, the intersection shot off, and the box scaled wildly.

Closest-point degrades gracefully: it just stops moving when the drag is geometrically ill-posed (you can't drag along an axis that points straight at the camera).

### 21.14 Clash markers — single Points object

**Code reference:** `_ccSevColorRGB()` and the markers `Points` builder.

Replaces the previous "2 Meshes per clash" approach (20k Mesh objects for 10k clashes → 100-400 MB of JS heap) with a single `THREE.Points` object. One `BufferGeometry`, one draw call, ~1 MB heap. Hotspots are computed per Week-1 cluster: clusters with >1 member render as one sized centroid; singletons render as a leaf. Click → cluster key → first member id, which the existing handler then activates.

### 21.15 WASM batch hard-clash warmup

**Code reference:** `_chunkBatchCache` and the per-chunk batch-intersect loop.

For each chunk we group surviving candidates by `elA` and call `_ccWasmBatchIntersect` once per group, instead of N JS↔WASM calls. The cache is per-chunk: built fresh, consulted inside `_processCandidate`, freed at chunk end. Map values:
- `[cx,cy,cz,depth]` → hit
- `null` → batched, confirmed miss
- absent → not batched (small group / no WASM): fall through

`_BATCH_MIN_GROUP = 4` — groups smaller than this stay per-pair.

### 21.16 Type-pair impossibility memo

**Code reference:** `_TP_MEMO_*` constants and check in `_processCandidate`.

Per-set-of-loaded-models record of which (typeA, typeB) IFC type pairs have produced zero clashes for K consecutive runs. Skipped at `_processCandidate` entry to avoid testing pairs that historically never clash (e.g. `IfcWall × IfcSpace`).

Gated by an unchanged-model fingerprint: any geometric edit or load change invalidates the memo, falling back to full testing. TTL 30 days.

### 21.17 PWA install banner

**Code reference:** `_InstallAppBanner()`.

Surfaces the browser's deferred install prompt in a small dismissible banner inside the Models tab. Most users never find the "Install" entry buried in the More menu; this gets it in front of them once per session with one-click acceptance.

The Splat reference-layers panel (just above) shows what's loaded via `_ccLoadSplat` (drag-drop `.spz` / `.ply` / `.ksplat` or `_ccTestSplat()`) with one-click unload. The splat addon owns its renderer; this panel is purely an inventory view that reacts to the addon's `cc-splats-changed` event.

### 21.18 Type pset propagation via IfcRelDefinesByType

**Code reference:** in `loadIFC()` after the main property loop.

Propagates type-level psets/quantities to instances. The main loop builds `propMap` entries for type entities (`IfcBeamType`, `IfcColumnType`, etc.) because they can be targets of `IfcRelDefinesByProperties`. We then copy those entries down to each related instance without overwriting instance-level assignments — so structural profile psets (`Pset_ProfileProperties`, `Pset_BeamCommon`, …) that live on the type become visible on each beam/column instance.

### 21.19 Pair-result cache (narrow-phase)

**Code reference:** `_pairResultCache` / `_PAIR_CACHE_MAX`.

Stores clash objects from previous detection runs, keyed by `(mA:eidA | mB:eidB | rulesHash)`. When changeAware is on and neither element changed since last run, re-emit the cached clash instead of dropping it silently (legacy `changeAware` behaviour). Misses are not cached — undefined lookup falls through naturally.

### 21.20 Walk-mode vertical ground-snap

**Code reference:** vertical-snap block in `_walkStep`.

Casts a ray downward from a bit above eye height, finds the closest floor/stair surface within step-up reach, and snaps camera Y so we stand on it at eye-height. Keeps stairs walkable while leaving walls free to pass through.

### 21.21 Walk-mode pointer lock timing

**Code reference:** end of `_walkEnter`.

Pointer lock CAN'T be requested in `_walkEnter` — it runs from a React `useEffect` that fires after the click event has completed, so the browser sees no active user gesture and silently rejects the lock. The canvas `mousedown` handler takes the first click and locks instantly.

### 21.22 Run Detection modal + pre-run placement sanity

**Code reference:** RunDetectionModal + `_ccPlacementWarnings`.

Single entry point for clash setup. Wraps the existing `ClashRulesPanel` (Quick Run + Advanced) and `StandardsPanel` (default clearance, IFC type-pair rules, discipline-pair rules) so all detection setup lives behind one button.

Pre-run placement sanity: geolocation never enters the clash math — but if two federated models disagree on base point or CRS they won't overlap, and the run quietly finds nothing. `_ccPlacementWarnings` flags that before a detection run is wasted.

### 21.23 Memory-diagnostic breakdown

**Code reference:** `_ccMemDiag()`.

Gathers a diagnostic breakdown of where the JS heap is going so a `[Memory]` report is actionable instead of just "5.9 GB total". Every probe is defensive — renderer / web-ifc / caches may be absent. Returns markdown lines.

Big suspects for heap >> file size: web-ifc WASM linear memory (grows to peak parse size, never shrinks — even after `CloseModel`), per-element retained CPU geometry + three-mesh-bvh boundsTrees (~2× the raw geometry), and material/geometry clones from render styles.

### 21.24 Section-plane gizmo + section-box handles — constant on-screen size

**Code reference:** the per-frame `_secHandleGroup.scale.setScalar(...)` block.

The move arrow + rotation ring live in a sub-group anchored at the plane centre. Scaling it to a fixed pixel size each frame stops the handles from appearing to grow/shrink as the plane is dragged toward/away from the camera, and keeps the arrow compact so its tip no longer whips across the screen when orbiting. The plane rectangle itself stays world-sized (it represents the real cut extent).

Section-box face handles use the same idea: world scale `~maxDim*0.01` looks disproportionately large on big models and tiny on small ones, so they're re-scaled every frame to a target pixel footprint. Face arrows scale to geometry-relative size once per frame (box may be live-dragged); all other handles are sized at creation time relative to geometry — no camera-distance scaling.

### 21.25 Rendered lighting — original intensities (no ×π)

**Code reference:** the HemisphereLight / DirectionalLight constructors in render-style setup.

Light intensities use their original (pre-bump) calibrated values. The ×π multiplier shipped initially overshot — that conversion is only correct for projects that had `physicallyCorrectLights=true` before r155. ClashControl was on the legacy default, so values translate ~directly. Hot-fixed back to original after user reported "rendered is too bright".

### 21.26 Section-pick — click a face / Alt-click shortcut

**Code reference:** picker's section-pick branch.

Click any surface to use it as a section plane. Triggered either by the toolbar "Make Section" mode (`_ccSectionPickPending` flag) or as a one-step shortcut by holding Alt while clicking a face. Borrowed from Onshape / Trimble Connect / Shapr3D. Alt-shortcut is blocked while a measure tool is active — Alt is already used there for throwaway dims and the endpoint-to-area shortcut.

`sectionCustom` is stored as `[x,y,z]` arrays, not `{x,y,z}` objects — the right-click context menu and drag handlers expect arrays. An earlier object shape made the plane build with `Vector3(undefined,...)` → (0,0,0) → degenerate plane → no clipping.

### 21.27 Measure-mode Alt-click — extend length into area polygon

**Code reference:** measure-pick branch's Alt+endpoint shortcut.

When the measure tool is active and the user hovers a previously placed length endpoint, the "Alt+click → trace area" hint appears. Alt-clicking continues tracing an area polygon from that edge.

Gated on measure mode active + no in-progress measurement so it doesn't conflict with throwaway-dim alt-clicks. Must come before the section-pick Alt handler so endpoints take priority.

The chained area mode sets the `_ccChainedArea` flag so the area commit skips `_registerMeasurementGeo` — the committed length line sits between old dots and new dots in the array, which breaks slice arithmetic for drag-edit. Acceptable tradeoff.

### 21.28 Active-clash 3D pin removed

**Code reference:** `window._ccShowActiveClashMarker` / `_ccRemoveActiveClashMarker`.

The legacy active-clash 3D pin (two intersecting forest-green rings) overlapped the new Points hotspot at the same location whenever the user selected a clash, creating "two markers" for one element. The EdgesGeometry outline on the selected elements + the Points dot now carry the same information, so the 3D pin geometry is suppressed. The function is kept to preserve the orbit-target side effect every call-site relies on.

### 21.29 Snap engine — vertex > midpoint > edge > centroid

**Code reference:** `_SNAP_PX` and the snap helper.

Computes the best snap point near the cursor from a raycaster hit: vertex > midpoint > edge > face-centroid > raw face point. Returns `{point, type, normal, screenX, screenY, srcObj}`. Pixel radius scales with element size on screen so dense parts of the model don't snap too aggressively. Side-effect-free so the click handler can re-call it on the click event.

### 21.30 Chunk-merge per-element hide — REMOVED

Removed with chunk-merge. The hide source union (`window._ccHiddenReg`) is kept since it's still consulted by the per-element hide path.

### 21.31 Chunk-merge color-by-class — REMOVED

Removed with chunk-merge.

### 21.32 Race-safe model dedup in the reducer

**Code reference:** the `ADD_MODEL` case in the reducer.

The reducer is the single serialization point, so a concurrent same-name (or same-id) load that slipped past the check-then-act guard in the loader is collapsed here into a replace rather than a second copy. This is what caused "4 files → 8 models" — two in-flight loads of the same file both saw no existing match in `window._ccLatestState` and both dispatched `ADD_MODEL`.

### 21.33 Imperative section-plane drag

**Code reference:** `_secPlaneLiveMove()`.

Moves the section plane imperatively during a drag — updates the live clip plane (shared by reference with every model material) and the gizmo in place, then `invalidate()`. This is the orbit-drag pattern: dispatching to the reducer on every `mousemove` round-trips through a full gizmo rebuild + per-material clip reassignment, which made the drag lag behind the cursor. State is committed once on `mouseup`.

### 21.34 Section-plane handle group — constant on-screen size

**Code reference:** `_secHandleGroup` setup inside the plane gizmo.

Arrow + ring live in a sub-group anchored at the plane centre. The tick loop scales this sub-group every frame to a constant on-screen size, so the handles no longer "grow/shrink" as the plane is dragged toward/away from the camera, and the long tip stops whipping across the screen when orbiting. The fill/border stay world-sized so the rectangle represents the real cut extent.

### 21.35 Section rotation ring — world-up reorient for vertical planes

**Code reference:** the ring re-orient block in the section-plane tick.

For vertical section planes the plane normal is horizontal, so the ring (axis = local +Z = plane normal) ends up standing upright. The drag-rotate logic spins the plane around world up, so the ring visually mismatches the motion. Re-orient the ring each frame so its central axis is world-up whenever the plane is vertical — gives a horizontal "spinning record" handle to match the rotation.

### 21.36 Per-material clipping (instead of global)

**Code reference:** `S.renderer.clippingPlanes` reset + per-material assignment.

Setting clip planes on each model mesh material instead of globally means gizmos / helpers / visualization objects (no expressId) are NEVER clipped and always render — section-box handles stay visible. The render loop and render-style effect both call this through the dep array so newly-swapped style materials pick up the planes automatically.

### 21.37 Floor-plan cut-plane arrow — clippingPlanes:[] required

**Code reference:** floor-plan drag handle build.

Floor-plan handle uses the same geometry/colours as the section-plane gizmo so the two read as one family. `clippingPlanes:[]` on the materials is critical here — the floor-plan clipping plane removes everything above the cut, and the arrow extends UP from the cut elevation, so it would otherwise be entirely clipped away.

### 21.38 cc-render-frame timing — before render(), not after

**Code reference:** the `cc-render-frame` dispatch in the main render loop.

Fires before `renderer.render()` so sibling addons (splat overlay etc.) get their per-frame update call first. Spark's `SplatMesh.frameUpdate(camera, renderer)` sorts splats by camera distance and uploads GPU state; if it runs AFTER the render, the next frame uses stale data and the splat appears invisible until the camera moves again.

### 21.39 Hidden Line style — opaque Lambert + glass

**Code reference:** Hidden Line branch in the render-style switcher.

A single shared `MeshLambertMaterial` for opaque elements + a per-mesh translucent material for glass. Curtain walls and windows read as see-through line drawings instead of solid gray boxes. Glass detection mirrors the Shaded branch; the monochrome shared mat is used for everything else, so perf cost is bounded to the small glass subset.

### 21.40 Rendered style — IFC colour respected

**Code reference:** the rendered-style material constructor.

Photorealistic respects the IFC-exported colour from the source software (Revit / ArchiCAD / etc.) — `origColor` came from `placed.color`, which is the resolved `IfcSurfaceStyle` colour. Material name and IFC type only inform PBR characteristics (roughness, metalness, glass transparency); the colour itself is whatever the architect set in their authoring tool.

### 21.41 Conflicts panel — progressive reveal

**Code reference:** `VirtualList`'s reveal state machine.

Renders the first `INITIAL_REVEAL` items immediately so the panel paints fast; expands to the full list after a paint frame. Critical at 10k+ clashes — the upstream `groupAndSort` / sort / group-bucket pass is O(N) on every render, and pushing it past first paint makes tab switching feel instant instead of stalling for hundreds of ms.

### 21.42 Conflicts panel — IssueRow memoization

**Code reference:** `IssueRow = React.memo(IssueRow);`.

Memo by shallow prop equality so visible rows don't re-render on every `VirtualList` scroll / parent state change. The row is heavy (storey label, dot colour, status pill, expandable detail block) and rendering 15 of them on every scroll tick is what made the panel feel laggy at 10k+ clashes. `item` identity stays stable in the reducer when nothing about that clash changes.

### 21.43 _ccDebugInstancing — collision detection

**Code reference:** `window._ccDebugInstancing()`.

Walks every mesh on every loaded element and reports whether `_instKey` is set, distinct-key count, largest group sizes, and a few sample keys. Also samples up to 4 meshes per InstancedMesh group and compares their local bbox extents — if two share a key but have measurably different bboxes (>5cm in any axis), that IS a real collision, flagged as `suspectCollisions` with a console warning telling the user how to opt out (`localStorage.cc_restoreInstancing = 'off'`).

### 21.44 Memory-warning modal — privacy by design

**Code reference:** `MemoryWarningModal`.

Model names are NEVER included in diagnostic reports — privacy by design. Model names often expose client/project identifiers ("669001A_..._BWK_..."). The opt-in checkbox has been removed; the `includeNames = false` constant survives so the report-generator branch remains unchanged.
