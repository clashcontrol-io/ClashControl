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
