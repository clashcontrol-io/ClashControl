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

### 21.4 Spatial chunk-merge — default OFF

**Code reference:** `window._ccChunkMerge` initialization.

Stage 1/2A/2B trial baked all same-material elements in a grid cell into one merged BufferGeometry. Won draw-call count and CPU cull time, but collapsed visual distinctions between adjacent elements, broke Style switching (chunks render with a locked material), and changed how selection outlines read on dense models. Reverted to per-element rendering — pre-30-May behaviour.

Memory wins kept independently: `_ccGetSharedPhongMat` cross-load material dedup, `_ccQuantizeNormalAttr` Int8 normals, survey base-point / nulpunt strip.

Set `window._ccChunkMerge = true` from console BEFORE loading a model to opt in for testing; compare with `window._ccPerfSnapshot()`.

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
