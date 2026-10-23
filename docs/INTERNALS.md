# docs/INTERNALS.md — Architecture & Code Reference

This document replaces the inline comments that were stripped from `index.html`. Each section corresponds to a `// ── Section Name ──` header in the code. Use Ctrl+F in `index.html` to find the matching header.

---

## 1. Boot & Initialization

**Code section:** `// See docs/INTERNALS.md` (top of `<script>`)

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

**Element filtering:** `IfcOpeningElement` is filtered entirely (void cutters). `IfcVirtualElement`, `IfcAnnotation`, `IfcGrid` have meshes cleared but are kept as stubs for storey navigation and classification. `IfcSpace` keeps its geometry (streamed in a separate pass, own layer, hidden by default; see `tests/browser/spaces.mjs`).

**Rooms written in their storey's frame:** some exporters write an `IfcSpace` footprint in its parent's (storey) coordinates and also give the space its own placement next to that footprint, so following the placement rules applies the room's offset twice and the room lands away from its walls. `ccSpacePlacementFix` (shared by the worker and the main-thread fallback) detects this per room from the file itself: in the space's own frame the geometry lies within one room diagonal of the space's own placement point, and that point is more than two diagonals from the parent origin (a correctly authored room sits near its own origin, so it never matches). It then removes the space's own placement step once, keeping its vertical offset. Geo caches stamped before this (`sp` ≠ 2) are re-parsed once. Covered by the storey-frame fixture in `tests/browser/spaces.mjs` (`generateSyntheticIfc({spaceFrame:'parent', offsetX})`).

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

**Pure math in `viewer-camera-core.js`** (`window._ccViewerCamera`, `// @ts-check`, node-tested in `tests/orbit-math.test.js` / `tests/viewer-camera-core.test.js`): drag rotation, pan scale, the reversible zoom-to-cursor dolly and `dollyStep`, the bounded wheel/pinch step. Zoom OUT moves by `max(dist, 0.01·sceneDiag, 0.25 m)·(factor−1)` (dist = camera→anchor), so a camera parked on a surface (or behind the fallback anchor plane) always escapes instead of creeping ~2 cm per notch; zoom IN toward a picked surface stops `max(10·near, 0.05 m)` in front of it and never crosses it; far from surfaces the step is the exact multiplicative one (in/out reversible). `|camera−target|` stays in [0.5, 5000] like `apply()`. `_pickSurfacePoint` filters with `window._ccActivePlanes` (clipping is per-material, so `renderer.clippingPlanes` is always empty).

## 14. Three.js Viewer

**Code section:** `// ── Three.js Viewer Component ──`

Three.js r180, loaded as ESM via an import map (bumped from UMD r128 in v5.19.12). WebGL2 renderer with antialiasing.

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

Long-form rationale blocks that used to live inline in `index.html`. Each subsection corresponds to a `// See docs/INTERNALS.md § 21.x` reference in the code.

### 21.1 Three.js bump-prep harness

**Code reference:** `// ── Three.js bump-prep harness ──` (near the top of `startApp()`)

`THREE_VERSION` + `THREE_EXAMPLES_BASE` constants centralize the CDN version so the next bump touches one place instead of six string literals. The examples-base also drives the on-demand loader scripts (GLTFLoader, TransformControls, PLYLoader, PCDLoader, EffectComposer chain, etc.).

When bumping the Three.js version (last done: r128 → r180, v5.19.12):
1. Update `THREE_VERSION` and `THREE_EXAMPLES_PATH` constants.
2. Update the ESM import-map URLs in `<head>` (and the sw.js PRECACHE list).
3. Regenerate SRI hashes via `scripts/generate-sri.js`.

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

### 21.19 Smart re-run memo (narrow-phase)

**Code reference:** `_ccRunMemo`, `_ccRunSignature`, `_hashElement`, the "Smart re-run" block in `_detectClashesCore`.

Re-runs are change-aware **by default** (`rules.fullRerun` = false; the UI toggle is "Full re-run"). The memo holds the last *completed* browser run: a signature (every rule except `fullRerun`/`hideProvidedOpenings`, the resolved engine, model ids/names/disciplines/element counts, detection-feedback protected pairs), a per-element content hash (identity, box, every mesh's world matrix + vertex/index counts, identity props, LoadBearing, opening boxes) and an immutable shallow snapshot of every raw hit per pair (`mA:eidA|mB:eidB`).

A run whose signature matches only recomputes pairs that involve a changed element; every other pair carries over — a previous hit is re-emitted as a fresh clone of its snapshot (new id/createdAt, so merge/classify/reconcile may mutate it), a previous miss stays a miss. Candidates are still visited in the same order, so the merged result equals a full run's exactly (proved in `tests/browser/office-clash-parity.mjs`). The memo is committed only by a run that finished (a failed chunk marks the run incomplete first), is dropped — never evicted — if it would exceed `_CC_RUNMEMO_MAX` snapshots, and is cleared on model delete/replace, project switch and local-engine runs. The old LRU `_pairResultCache` (raw objects by reference, evictable, mutated later by merge/classify — it could silently lose or double-annotate carried clashes) no longer exists.

Rule-derived severity (`_sevSource:'rule'`) is re-derived on every re-run by the reconciler; only AI/human verdicts are carried.

### 21.19b Provision for void (clashes through openings)

**Code reference:** `extractOpeningRecords` (loader/worker), `_ccOpeningStatusForPair`, `classifyOpening` in `clash-classification-core.js`.

web-ifc never streams `IfcOpeningElement`, but `GetFlatMesh(opening)` returns its geometry. For every `IfcRelVoidsElement` the loader stores each opening as a flat 15-number oriented box (`props.openings` on the host: centre, 3 unit axes, 3 half extents; scene space, 0.1 mm) — this survives the geo cache (whole `props` is serialised); geo caches written before this version carry no openings until the model is re-imported. After the engine reports a clash the *other* element's triangles are clipped to the host's AABB and tested against the host's openings (20 mm tolerance): whole region inside one opening = `opening:'provided'`; hard clash overlapping an opening but poking out = `'partial'` ("Opening too small"). Classification only — hard/soft detection is untouched. `rules.hideProvidedOpenings` (default on) hides provided clashes from the list behind an "N pass through provided openings — show" notice; they stay in state, reports and exports.

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

### 21.24 Section gizmos — viewer-gizmo-core.js (screen-constant, token colours)

**Code reference:** `viewer-gizmo-core.js` (`S.gz` = `create()`), `_sectionVisFit()`, the section-box effect (`S._sboxLayout`), `S.gz.update()` in the tick.

All section handles are built in PIXEL units (`buildArrow` / `buildTab` / `buildArc`) and registered with `S.gz.track()`; the tick calls `S.gz.update(camera, viewportHeight)`, which sets each tracked handle's scale to `pxScale()` = world length of 1 px at its depth (perspective: view-space depth · tan(fov/2); ortho: frustum height / zoom) and billboards the box tabs. Objects that leave the scene drop out of the registry, so there is nothing to unregister. Colours come only from DESIGN.md tokens through a cached `getComputedStyle` reader (`STYLES`: idle neutral, `--accent` on hover / drag only); a `MutationObserver` on `data-theme` repaints every tracked part. `tests/viewer-gizmo-core.test.js`, `tests/browser/section-gizmo.mjs`.

**Section plane:** ONE gizmo (arrow along the plane normal + rotate ring at its base); the former second gizmo (`TransformControls`, anchored at mid-height with a 1e6-long helper line) is gone. `_sectionVisFit(S, vis, n, p)` builds or refits the visual: the outline is the model box (building grid, `_ccPlanFrame`) cut by the plane (`planeOutline`: box-edge ∩ plane → in-plane extents along `planeBasis` u/v, +4 % per side growing with the cut-to-far-corner gap, capped at 1.2×), and the gizmo sits at its centre ON the plane. Axis, picked and rotated planes share this rule, so the sheet never hangs beside the model.

**Section box:** 1 px edges, six flat 12 px face tabs (drag = closest-point face drag, §21.13) and a 28 px quarter arc on the top corner nearest the camera (drag = rotate about up). Built once per enable; `S._sboxLayout(sb)` re-positions them on every change, so hover / active states survive a drag.

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

### 21.29 Snap engine — vertex > midpoint > edge > face

**Code reference:** `viewer-pick-core.js` (`snap`, `hitMatrix`, `firstVisibleHit`); `_ccComputeSnap` in index.html is a thin wrapper (projection, clip planes, occlusion ray).

Candidates come from the FEATURE edges of the hit element's triangles near the hit point (boundary, non-manifold or crease > 20°; a diagonal shared by two coplanar triangles is not an edge): their endpoints (vertex), midpoints and the closest point on the edge (edge, perspective-correct). Within 12 px of the cursor: vertex first, then midpoint (within 6 px), then edge, else the raw face point. Work is capped (triangle AABB vs a sphere of ~3× the snap radius around the hit, at most 20k triangles in a window around the hit face). The element's world matrix includes the InstancedMesh instance matrix or the BatchedMesh batch-instance matrix (and only the batch instance's geometry range is read) — without it batched elements always read "Surface". Points cut away by `window._ccActivePlanes` are never candidates; the winning candidate is checked with one ray against the hit object so a back corner of the same element cannot win (up to 3 checks; each corner is considered once). Hover, measure-drag and the click pick all take the first VISIBLE hit (`firstVisibleHit`: visible object and ancestors, not ghosted, not clipped) — the same filter the orbit's `_pickSurfacePoint` uses. Glyph colours are `currentColor` = `--accent` / `--accent-contrast`. Tests: `tests/viewer-pick-core.test.js`, `tests/browser/measure-snap.mjs`.

### 21.30 Chunk-merge per-element hide — REMOVED

Removed with chunk-merge. The hide source union (`window._ccHiddenReg`) is kept since it's still consulted by the per-element hide path.

### 21.31 Chunk-merge color-by-class — REMOVED

Removed with chunk-merge.

### 21.32 Race-safe model dedup in the reducer

**Code reference:** the `ADD_MODEL` case in the reducer.

The reducer is the single serialization point, so a concurrent same-name (or same-id) load that slipped past the check-then-act guard in the loader is collapsed here into a replace rather than a second copy. This is what caused "4 files → 8 models" — two in-flight loads of the same file both saw no existing match in `window._ccLatestState` and both dispatched `ADD_MODEL`.

### 21.33 Imperative section-plane drag

**Code reference:** `_secPlaneLiveMove()`.

Moves the section plane imperatively during a drag — the live clip plane (shared by reference with every model material), the outline and the gizmo together via `_sectionVisFit` — then `invalidate()`; state is committed once on `mouseup`. Dispatching on every `mousemove` round-trips through a full rebuild + per-material clip reassignment and lags behind the cursor. Rotation pivots on the gizmo (a point on the plane at the outline centre) with `pos` reset to 0.5, so rotating never shifts the plane.

### 21.34 Section-plane handle group — constant on-screen size

Superseded by §21.24 (`S.gz.update`): the arrow group is a tracked pixel-unit handle; the outline stays world-sized (it is the real cut).

### 21.35 Section rotation ring — world-up reorient for vertical planes

**Code reference:** the ring re-orient block in the section-plane tick.

For vertical section planes the plane normal is horizontal, so the ring (axis = local +Z = plane normal) ends up standing upright. The drag-rotate logic spins the plane around world up, so the ring visually mismatches the motion. Re-orient the ring each frame so its central axis is world-up whenever the plane is vertical — gives a horizontal "spinning record" handle to match the rotation.

### 21.36 Per-material clipping (instead of global)

**Code reference:** `S.renderer.clippingPlanes` reset + per-material assignment.

Setting clip planes on each model mesh material instead of globally means gizmos / helpers / visualization objects (no expressId) are NEVER clipped and always render — section-box handles stay visible. The render loop and render-style effect both call this through the dep array so newly-swapped style materials pick up the planes automatically.

**One owner:** `_ccApplyActiveClipping(S, s)` is the only caller of `_ccApplySectionMaterialPlanes`. The section-plane effect stores `S._sectionPlanes`, the section-box effect `S._sboxPlanes`; each then calls the owner, which applies their union (a plane added while the box is on clips together with it) and publishes it as `window._ccActivePlanes` for click/hover/snap filtering. Turning the box on replaces a plane (reducer); turning it off keeps a plane added since, and clipping goes straight back to that plane. Covered by `tests/browser/section-gizmo.mjs` and `tests/section-clipping-wiring.test.js`.

### 21.37 Floor-plan cut-plane arrow — clippingPlanes:[] required

**Code reference:** floor-plan drag handle build.

The floor-plan arrow is the shared `buildArrow` (no ring), tracked by `S.gz` like the section gizmo, on a model-sized sheet (`outline` style). `clippingPlanes:[]` on its materials is critical — the floor-plan clipping plane removes everything above the cut and the arrow extends UP from it. Drag speed uses `S.gz.pxScale` so 1 px of mouse ≈ 1 px of motion.

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

### 21.45 Clash review — an action costs what it changes

**Code reference:** `VirtualList` (`CC_WINDOWED_GROUPED_MIN`, `_ccStabilizeGroups`, `_ccPatchElementGroups`), `ConflictGroupHeader`, `_ccTriageIncremental`, `_ccListItemPasses` (`_ccPassCache`), `_ccReviewModel` (`_ccGroupSummaryCached`, `_ccReviewItemCache`), `_ccCloneListCached`, `storage-core.js estimateRecordBytes(v, sizeCache)`; test `tests/browser/action-cost.mjs`.

Rule: a small state change must not recompute or re-render everything.
- **Bounded DOM.** A grouped list above 50 items always renders windowed (only visible headers/rows + overscan are mounted), independent of the clash count. Headers are a memoised component with a stable toggle; rows get `autoHighlight`/`autoFlyTo` booleans, not the prefs object.
- **Identity is the cache key.** Clashes are immutable state (an edit makes a new object), so per-clash work is cached in WeakMaps keyed by the clash object: element keys, the filter verdict (+ filters/visibility/rules/facet row), the search text, the save clone and its byte size. Group objects keep their identity while their members are unchanged, so header summaries, review items and overview cards are reused.
- **Incremental paths.** One status/assignee edit: the triage model refiles only the replaced clashes (falls back to a full rebuild when a copy-detection input — type, element ids, boxes, overlap volume — changed or > 256 clashes changed); root-cause groups swap the new objects in when grouping and in-group order are unaffected (element keys/types, severity, depth).
- **UI-only state never persists.** Filters/search, hover, selection, scroll and expanded groups are not autosave inputs; autosave is debounced 2 s and run at idle, and clones/sizes only what changed.
- **Closed means not built.** "Run details" and the filter dropdown lists are computed only while open.
- Anyone mutating a clash object in place after it is in state breaks these caches — make a new object instead.
- Render counts for tests: `?ccRenderCount=1` exposes `window.__ccRenderCount` ({rows, headers, cards}).

## 22. Companion-app port & protocol registry

One place for every localhost contract. The service worker deliberately
never intercepts localhost/127.0.0.1 (sw.js) — probes to absent apps must
fail silently.

| Port | App | Protocol | Client (this repo) | Server repo | Version contract |
|---|---|---|---|---|---|
| 19780 | Revit Connector | WebSocket + HTTP health GET / | `addons/revit-bridge.js` | ClashControlConnector | `EXPECTED_PROTOCOL_VERSION '1.0'`; semver handshake in status/pong, major mismatch hard-fails |
| 19800 | Local clash engine | HTTP: GET /status, GET+POST /update, POST /detect | `addons/local-engine.js` | ClashControlEngine | version-agnostic; /status polled, version change forces reconnect |
| 19801 | Local engine progress | WebSocket: progress/phase/complete | `addons/local-engine.js` | ClashControlEngine | optional — engine falls back to HTTP-only without websockets pkg |
| 19802 | Smart Bridge ↔ browser | WebSocket (tool relay) | `addons/smart-bridge.js` | this repo: `smart-bridge-server.js` (released as `bridge-v*`) | `bridge-version.json`; addon checks GitHub releases for updates |
| 19803 | Smart Bridge chat/REST | HTTP: /chat, /llm/autodetect, /llm/config | `addons/smart-bridge.js`, Ask AI nudge | this repo: `smart-bridge-server.js` | /llm/autodetect 404 ⇒ pre-0.3.0 Connector, addon falls back to manual presets |
| 49100–49115 | OpenAEC siblings (open-pointcloud-studio) | HTTP: /health probe, parallel port scan | `addons/openaec-bridge.js` | open-pointcloud-studio | `s.openaecBridge` state only; no UI consumer yet |
| 11434 / 1234 / 8080 / 1337 | User's local LLMs (Ollama / LM Studio / llama.cpp / Jan) | OpenAI-compatible /v1/* | via Smart Bridge `/llm/autodetect` (browser can't reach them: mixed content) | third-party | `llmEndpointUrl()` appends paths, never replaces base path prefixes |

Rule: a new companion app claims the next free 198xx port, gets a row here,
and its probe failures must be silent (guard + catch, no unhandled rejections).

## 23. Content-Security-Policy: why there is no `script-src`

Decision (2026-10): `vercel.json` ships only the CSP directives that cannot
break the app: `frame-ancestors 'self'; object-src 'none'; base-uri 'self'; form-action 'self'`.
The one `<form>` (index.html, a Preact `onSubmit` handler) has no cross-origin
action, there are no `<object>`/`<embed>`/`<base>` elements, so these are safe.

A `script-src` is deliberately NOT set, because a robust one needs a build step:

- The core is one ~34k-line inline `<script>` that changes on nearly every commit.
  A `sha256-` allow-list entry would go stale on each edit (CI bump-version also
  rewrites index.html), and the project forbids build tooling. `'unsafe-inline'` would
  make `script-src` nearly worthless against XSS, so it is not worth the churn.
- Several other inline scripts and `type=importmap`/`type=module` blocks exist, and
  addons are injected at runtime from same-origin URLs.
- The print/report popups (`window.open` + `document.write`) inherit the opener
  CSP and use inline `onclick="window.print()"`; strict `script-src` would break them.
- web-ifc / WASM engines need `'wasm-unsafe-eval'`, and runtime-loaded CDN modules
  (Spark.js, 3DTilesRenderer) come from several origins.

Mitigations in place instead: SRI on all classic CDN scripts (`scripts/generate-sri.js
--check`), `esc()` on every interpolated string in generated HTML reports
(`tests/report-escaping-wiring.test.js`), exact-match CORS allow-list on `/api/*`.
Revisit if a build/hash-injection step ever exists (e.g. CI computing inline-script
hashes into vercel.json at deploy time).
