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

The geometry cache stores **exact** geometry (`xp:1`): each mesh's Float32 positions and the normal array the live view uses (Int8, normalised), byte for byte, so a model restored from the cache (park → restore, project reopen/switch) is identical to a fresh load — same world positions, same clash results (`tests/browser/cache-restore-exact.mjs`). Caches written before `xp:1` held 16-bit positions quantised per mesh bbox (up to range/131070 off: ~0.8 mm on a 100 m run, enough to change clash points/verdicts after a reopen); they are re-parsed once from the stored IFC (`_ccGeoCacheLacksSpaces`). Exactness costs ~2× the position bytes in IndexedDB. **Props-complete caches (`pp:1`):** on the worker path psets/quantities arrive after the model commits (lazy props). The load path serialises the geometry at commit but writes the record only once the lazy props have merged into the same props objects (`job.afterProps`), stamped `hasPsets` from the data and `pp:1` when the props phase succeeded; main-thread parses (cold-parse restores, the worker fallback) are complete by construction (`_geoSerialize(result, true)`). A restore uses the cache when `hasPsets || pp`. Before this, the record was written without psets and `_mergeLazyProps` patched it with a main-thread read-modify-write of the whole record — which found nothing when the props won the race against the idle-time write, so the cache stayed `hasPsets:false` and every reopen silently re-parsed the IFC; a model without psets could never restore from cache at all. `_mergeLazyProps` now skips the patch while a write is pending (`_ccGeoWritePending`).

**Shared geometry stored once (`gs:1`):** both IFC loaders keep one `BufferGeometry` per IFC geometry id and reuse it for every placement, so many meshes share a geometry object. `_geoSerialize` writes each distinct geometry OBJECT once (`geoData[]`: `pos`, `n8`/`nrm`, `idx`, `idx16`, `bbox` — the same `xp:1` bytes) and every mesh record references it by index (`md.g`; `eid`, `gid`, `bbox`, `mtx`, `col`, `tr` stay per mesh). Identity, never content: two geometries with equal bytes stay two, because that is what a fresh load holds. `_geoDeserialize` builds one geometry per stored geometry (normal shrink + `_ccGeoBounds` once) and shares it across its meshes, so a restored model has the fresh load's sharing, instancing and BatchedMesh contents (leanMemory adds a shared geometry to a batch once). Three more fields make a `gs:1` restore equal to the fresh load rather than close to it: `pqs` (the mesh's position / quaternion / scale — re-applying the baked `mtx` decomposes and recomposes it again, which moves rotated elements' world positions by an ulp), the instancing key `g:<index>:<material>` (the loaders key by their shared geometry + shared material; worker-path meshes carry no `gid`, and the old content-hash key grouped equal-byte geometries of different ids into InstancedMeshes a fresh load never builds), and `userData._ifcMaterial` from `props.material` (render styles read it; set for every cache). Caches without `gs` (one buffer set per mesh) still restore as before, no re-parse. The v8 validator (`geoCacheV8`) checks `md.g` against `geoData` and accepts `xp:1` buffers and stub elements' empty boxes (it used to reject every exact cache). Gate: `tests/browser/cache-restore-exact.mjs` (no re-parse, digest, sharing/instancing/batching, pixels, clashes, smaller record), `tests/geo-cache-shared-geometry.test.js`; cost: `tests/browser/geo-cache-cost.mjs` — generated federation (medium building + three shared-shape models, 36.9k meshes, 53 % of them reuse a geometry; headless, median of 5 interleaved runs vs the previous code): geometry bytes in the cache 48.2 → 37.2 MB (the building's unique meshes dominate the bytes), `_geoDeserialize` during a restore 1.75 → 0.94 s (no per-mesh copies, no content hashing of gid-less meshes, no extra decompose), heap after restore 210 → 177 MB, serialise at commit 245 → 221 ms (noise-level), restore wall 27.0 → 20.3 s. The restore wall time is mostly native/GPU-process waiting (frames, shader setup), not geometry rebuild, and swings ±50 % with other load on the machine — compare `_geoDeserialize` and heap, not wall time.

**Saving off the main thread:** a freshly serialised payload (`_geoSerialize` output — its geometry buffers are new copies) is written by a small worker (`idbSaveGeoCacheFresh`): after the main thread has opened the database, it posts the record head, then geometry chunks (`gs:1` `geoData`, each buffer transferred exactly once, zero-copy), mesh chunks (no buffers for `gs:1`) and element chunks, each in its own idle callback, then 'end' → the worker assembles and puts. Structured clone keeps every value exactly. Any worker failure falls back to the main-thread `idbSaveGeoCache` (quota eviction + retry). A payload read back from the cache (pset refresh) is re-saved on the main thread because its buffers back the live scene.

**Metadata without reading data (DB v4):** each store has a `cc_meta` index whose key holds the record's size stamp and age (`ifcFiles`: `[bytes, savedAt, projectId, name]`, `geoCache`: `[bytes, savedAt]`, `projects`: `[bytes]`), and `ifcFiles` a `projectId` index. `_ccReadIdbInventory` (storage report, budget check, eviction planning) walks those indexes with `openKeyCursor`, so it never deserialises a stored IFC buffer or geometry cache; only records missing from the index (unstamped legacy) are read one by one. `idbGetProjectFiles` reads one project's files through the `projectId` index, orphan cleanup reads keys only, and `_openIDB` keeps one shared connection. The geometry-cache size stamp is estimated from an even sample of its long arrays (`_ccEstimateBytesFast`). Covered by `tests/browser/storage-metadata.mjs` (fails on the pre-index code).

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

**Sharded single-file load (flag `shardedLoad`, default on):** one large file can be parsed by several web-ifc workers at once (`loadIFCWorkerSharded`). Gate `_ccIfcShardCount`: file ≥ `_ccIfcShard.minBytes` (32 MB), ≥ 4 cores, `min(_ccIfcShard.maxShards (2), _ccIfcLoadPlan().k, budget ÷ per-worker cost)` ≥ 2, the only IFC parse of the batch, no storey scope. Every shard opens the whole file (shard 0 gets the transferred buffer, the others read the `File` themselves) and streams a block-cyclic slice (`_ccIfcShardBlock`: ≥ 32 elements, ~16 blocks per shard) of the order `StreamAllMeshes` would produce, with `StreamMeshes`; shard 0 also streams the rooms and does all non-geometry work and the lazy props, the others only geometry (terminated as soon as their result is in).
- *The order:* web-ifc 0.0.77 streams one contiguous block per IFC type, types in a fixed internal order (not numeric, not `GetIfcEntityList`'s), inside a type the `GetLineIDsWithType` order, and never yields elements without a representation (neither call does). `_ccIfcStreamOrder` reads the type order from the RUNNING web-ifc by streaming a tiny probe model (one box per `IsIfcElement` type of the file's schema, opened with a 64 KB tape so the WASM heap does not grow) — no hard-coded table that could go stale with an upgrade. The probe also yields the streamed type set (it skips openings and rooms); a type present in the file that the probe did not yield and that is not a known skip makes the order unknown → one worker. `tests/ifc-shard-order.test.js` locks it: `StreamMeshes(order)` ≡ `StreamAllMeshes` (ids, geometry ids, colours, transforms), 2–4-shard merges, order independent of file order / type subset / schema.
- *The merge* (`_ccMergeIfcShards`): elements by global position into one message of the single-worker shape (string tables concatenated with offsets, first-occurrence geometry per id, dedup counters `unique = |∪|`, `reused = Σ(unique+reused) − unique`), not-drawn report replayed in single-worker order (stream notes by position, then never-streamed ids ascending; `createNotDrawnReport(null, 0, typeNameOf)`), then the SAME decoder as one worker (`_ccDecodeIfcWorkerResult`). Props that arrive before every shard is done are held until the result resolved. Any shard error/timeout, an unknown order or a merge error rejects without props; the caller reloads in one worker (fresh bytes, fresh preview), then the main-thread fallback as before. One `_ccActiveLoads` entry for all shards, so Cancel terminates every shard.
- *Gates:* `tests/browser/shard-load.mjs` (2/3 shards deep-digest identical to one worker on synthetic files incl. interleaved types, shared shapes, styles, rooms, no-representation elements, assemblies, openings, IFC2X3 semantics, boundaries; fingerprint == fallback; failing shard; cancel; timing report) and the differential harness's sharded case. Memory: every shard holds its own copy of the model (WASM heap per shard = the single worker's).

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

**Unit scale:** `_walkUnitScale` (scene units per metre) is 1: geometry and storey elevations (`_ccStoreyElevM`, §21.52) are metres. Speed, eye height, near/far planes, and collision padding are all scaled by this factor.

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

**Storey elevation conversion:** storey elevations arrive in metres (`_ccCollectStoreys`, each model converted with its own unit — §21.52); `sheet.elevation` and `floorPlan.elevation` are metres. `_ccStoreyToGeoFactor()` returns 1 (kept for old addon code).

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

Cap is adaptive to available heap when the runtime exposes it (Chromium). Average BVH is ~50 KB; we allow ~5% of the heap budget, clamped to [300, 2500] so small devices stay safe and big workstations don't thrash. With `leanMemory` the cache is also capped by BYTES from the heap headroom at each run start (§21.46) — the count alone bounds nothing on heavy elements.

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

**Cost proportional to the change (2026-10-23, `tests/browser/rerun-cost.mjs`).** Change detection hashes every element each run, but the expensive parts are cached: the strided vertex sample per position attribute (`_ccVertexSampleHash`, valid while the attribute's `version` — bumped by `needsUpdate` — backing array and count are unchanged) and the props part per props object (`_ccPropsHash`, reused only while every hashed value is still `===`). An in-place geometry edit that does not bump the attribute version is not seen (three.js would not render it either). The pool and the chunk loop are sized by `_nWork` (pairs touching a changed element), not by the candidate count: an all-carried run, or one with at most `_DETECT_SMALL_WORK` (32) pairs to test, is one synchronous pass with no workers; carried pairs never pre-build JS BVHs. When a run recomputed nothing and emitted exactly the previous pairs (`emitKeys`), `classifyClashes` applies the previous run's per-row classification (`_ccRunMemo.classified`) instead of recomputing it. Profile fields: `pairs_recomputed`, `change_detect_ms`. Per-pair derived data (opening/provision status, roles, titles) lives in the snapshot, so it is computed only for recomputed pairs; merge and clustering stay global.

**First-run narrow phase (2026-10-23, `tests/browser/first-run-cost.mjs`).** The JS hit refinement (touch verdict, containment, depth) walks a JS BVH; it is no longer built a second time: `Engine.bvh_flat(id)` (end of `engine/src/lib.rs`) exports the Engine's tree pre-order and `_ccBvhFromFlat` rebuilds exactly the object tree `_buildBVHForTris` returns — used by the workers (after their self-check compares the export with the JS tree) and by the main thread for meshes the Engine already holds (`_ccWasmEngine.bvhFlat`, verified in the addon's engine self-check); only for all-finite meshes, any malformed export falls back to the JS build. `_buildBVHNode` sorts with `_bvhStableSort` (stable merge sort, same permutation as the comparator sort). `_estimatePenetrationDepthM` caches each mesh's extents on the box axes and its own face axes on the topology (`_ccOwnExtents`). Pool scheduling: 10-pair jobs; a free worker takes, within the oldest prefetch window, the job whose elements it already holds most (`pickJob`); two jobs posted ahead per worker; on a first run with >= `earlyMinElements` elements the pool is created before hashing/broad phase and adopted or terminated after it. `_ccNarrowPool.last.uniqueMB` vs `copiedMB` shows the per-worker duplication. Measured and rejected: engaging the pool on few-but-heavy pairs (slower than the main thread), the main thread taking queued jobs itself (delayed worker start-up), a worker JIT warm-up (no clear gain). Not changed: the min-distance traversal (a triangle-AABB prefilter cannot be proven never to skip a Möller near-coplanar hit).

**Clearance narrow phase (2026-10-23, `tests/clearance-exact.test.js`, `tests/browser/clearance-cost.mjs`).** Only work that provably cannot change a result is left out; same triangle pairs, order, strict update and tie winners as before on every path (JS, stateless WASM, Engine, worker pool, native). (1) Edge-edge skip: in the min-distance leaf loop (`_bvhMinDistTraverse` / `mesh_dist::traverse_min_dist`) `_ccEELowerSq` / `ee_lower_sq` bound every edge-edge sub-test of a triangle pair from the two triangle boxes (gaps shrunk by 1e-12 relative + 1e-12·max|coord|, sum by 1e-12; non-finite or < 1e-200 gives 0) — `_segSegDistSq` clamps its parameters to [0,1], so its points sit on the edges up to a few ulp; when the bound is >= the running best the 9 sub-tests are not evaluated (`_triTriDistSq(…, skipEE)`): a vertex test below best is then still the full minimum's first achiever. The Möller test and the 6 vertex tests always run. (2) The leaf loop stops once best reaches 0. (3) `_ccPairDismissed`: when the two elements' triangle root boxes (BVH comparisons, cached per triangle array) are disjoint and at least the pair's seed apart by the root test's own arithmetic, `_processCandidate` answers "no hit" / Infinity without the kernel and the pool does not get the pair (profile `pairs_dismissed`, `soft_dismissed`); the broad phase keeps per-axis gaps within the run's largest tolerance, so this mostly hits diagonal neighbours and pairs with a smaller type-pair tolerance. (4) Worker jobs carry per-pair seeds (`job.seeds`), so a worker runs exactly the main thread's search for that pair instead of one to the run's largest tolerance (the native pool keeps one seed per batch). Measured and left out because they cannot be proven exact: skipping a vertex-to-triangle test by box distance (Ericson's interior branch has no a-priori bound for slivers/degenerate triangles under rounding — 97 % of those tests would be skippable on the synthetic near-miss field), any node-level bound tighter than the box distance, best-first or seed-tightening reorderings (Möller can report near-coplanar separated triangles as hits, so a different visiting order or pruning can change which pairs are seen and the tie winner), and caching per-triangle planes/edges (identical but no measurable gain).

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

Candidates come from the FEATURE edges of the hit element's triangles near the hit point (boundary, non-manifold or crease > 20°; a diagonal shared by two coplanar triangles is not an edge): their endpoints (vertex), midpoints and the closest point on the edge (edge, perspective-correct). Within 12 px of the cursor: vertex first, then midpoint (within 6 px), then edge, else the raw face point. Work is capped (triangle AABB vs a sphere of ~3× the snap radius around the hit, at most 20k triangles in a window around the hit face). The element's world matrix includes the InstancedMesh instance matrix or the BatchedMesh batch-instance matrix (and only the batch instance's geometry range is read) — without it batched elements always read "Surface". Points cut away by `window._ccActivePlanes` are never candidates; the winning candidate is checked with one ray against the hit object so a back corner of the same element cannot win (up to 3 checks; each corner is considered once). Hover, measure-drag and the click pick all take the first VISIBLE hit (`firstVisibleHit`: visible object and ancestors, not ghosted, not clipped) — the same filter the orbit's `_pickSurfacePoint` uses; all of them query the scene pick index (§21.47). Glyph colours are `currentColor` = `--accent` / `--accent-contrast`. Tests: `tests/viewer-pick-core.test.js`, `tests/browser/measure-snap.mjs`.

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

### 21.46 Federation memory — one copy of everything (leanMemory)

**Code reference:** `_ccShareBatchArrays`, `_ccBatchPathological`, `_ccArrayBytes`/`_ccComputeResidencyLedger`, `_bvhLRUAccount`/`_ccCacheBudgetForRun`, `_ccIfcMemBatch`/`_ccIfcLoadMem`, `_ccLoadPreview` `streamEnded`, `_recordSnap`, `clash-reconciliation-core.js`; safety flag `leanMemory` (default on, `?ccSafety=-leanMemory`); test `tests/browser/memory-federation.mjs`.

Rule: remove true duplicates and data that is provably no longer needed — never lower precision, simplify geometry or drop anything a feature reads.
- **Batched geometry has ONE CPU copy.** `BatchedMesh.addGeometry` copies a source geometry's vertex attributes verbatim (`TypedArray#set` when the array types match) into the batch's arrays; the off-scene source geometry (`element.meshes[]` — engine, picking, snapping, export, geo cache) then reads `position`/`normal` through a `subarray` view of the batch's array. The index stays separate (the batch's holds vertexStart-offset values). A geometry used by several plain meshes is added to its batch once (one range, one instance per mesh); window membership is measured as before. Anything not a verbatim copy (interleaved, other array type/itemSize/normalized) keeps its own array. Never transfer or detach a geometry array's `.buffer` — it may be the batch's. Memory reports charge a shared buffer once (`_ccArrayBytes`).
- **Detection caches are capped by bytes** as well as by count: each cached element carries its estimated bytes (world tris + verts + JS BVH nodes + topology, `el._ccCacheBytes`), the LRU map's `delete`/`clear` keep the total, and the cap is set at every run start from the heap headroom (35 % of `0.9 × jsHeapSizeLimit − used`, else deviceMemory; ≥ 64 MB; override `ClashControl.storage.bvhCache.setMaxBytes`). An evicted element re-extracts the same triangles / tree, so results never depend on the cap.
- **No per-run context outlives the run.** `window._ccNiceTypeLabel` used to be a closure created inside `_detectClashesCore`, which kept that run's whole closure context (raw result rows, candidates, per-run maps) alive until the next run; it is defined outside now. Don't store closures created inside `_detectClashesCore` anywhere long-lived.
- **Clash rows are fast-mode objects.** V8 keeps an object built by `Object.assign(target, {…two or more new keys})` / `Object.assign({}, row, {…})` of a ~50-field clash in dictionary mode (~3 KB); object spread with the same operands gives the same keys, order and values as a fast-mode object (~0.4 KB). The raw hit, the run-memo snapshot, the carried re-emit and the reconciled rows (`mergeDetectionResults`) use spread. Keep it that way for anything copied per clash.
- **Load-only data:** the progressive preview drops its geometry-table references when the parse result arrives (`streamEnded`; its chunks are already drawn).
- **Memory-aware IFC scheduling.** Before a second parse starts next to running ones, the batch projects the main-heap peak (used now + factor × bytes in flight incl. this file; factor 6, refined by the batch's measured peak ÷ bytes started). Over 70 % of the limit the batch goes serial for good: one file at a time, never sharded, the next parse only after the previous worker is gone (props merged). Commits stay in file order, so models/ids/element order are unchanged. Knob: `_ccIfcLoadMem.limitBytes` (tests), last decisions on `_ccIfcLoadMem.last`.
- Not done (reasons in the commit history): sharing the index (offset values), slimmer `Object3D` proxies (non-configurable `modelViewMatrix`/`normalMatrix`, exactness of lazily re-derived position/quaternion/scale), per-mesh render-style materials.

### 21.47 Scene pick index — picks cost what is under the cursor

**Code reference:** `viewer-pick-index.js` (`window._ccViewerPickIndex.create(THREE)`), `S.scenePick` next to `S.mg` in index.html, `visiblePredicate` in `viewer-pick-core.js`; tests `tests/viewer-pick-index.test.js`, `tests/browser/pick-index.mjs`.

Every ray against the models goes through `S.scenePick`: hover (raw nearest + first visible in one query), click (+ rooms-layer pass), measure snap and its occlusion ray (`firstVisibleOn`, one object), orbit cursor pivot (`_pickSurfacePoint`), section pick, right-click, measure drag-edit, occluder reveal, walk mode (collision / knee / gravity / teleport + footprint / hover / fly), the pegman floor pick and `addons/align.js`. Each call site keeps its own filter as a predicate (`{accept(hit), skip(object)}`), so the hit it uses is exactly what `raycaster.intersectObjects(S.mg.children, true)` + that filter returned before.
- **Index:** one BVH per model group (top-level child of `S.mg`) over padded WORLD boxes — one leaf per Mesh, per InstancedMesh instance, per BatchedMesh instance (median split, leaves of ≤ 8; not an octree: long thin members straddle cells). Objects with a non-standard raycast (Line, Points, Sprite, custom/no-op override, morph targets) are "always test" entries raycast every query, subtree included.
- **Query:** `first` is best-first by box entry distance and stops once the next box is entered strictly beyond the nearest accepted hit; `all` (click, occluders, short walk rays) collects every hit of the boxes the ray enters. The exact test is still three's own `Mesh.raycast` per candidate; InstancedMesh / BatchedMesh instances are raycast one at a time by a line-for-line copy of r180's loop bodies (incl. the InstancedMesh whole-sphere pre-check and BatchedMesh per-instance visible/active flags). Hits sort by (distance, model order, depth-first object order, instance id, push order) = three's stable sort, so ties come out identical. Boxes are padded 1e-6 relative, so no hit lies outside its box or before its entry distance (float32 storage stays conservative).
- **Sync (checked per query, cost ~ models + instanced/batched objects):** `S.mg.children` identity/order (load / unload / replace / park / restore — only the changed model rebuilds), `childadded`/`childremoved` on every container inside a model (ghost split-outs), matrixWorld of `S.mg`, containers and non-baked meshes, `instanceMatrix.version`/`count` (occluder hide, ghost hide/restore → refit), BatchedMesh matrix-texture version / instance + geometry counts. Visibility, ghosting, isolate, clipping, layers (rooms on layer 3) and batch per-instance visibility are read at query time. Code that moves baked geometry in place without any of these calls `S.scenePick.invalidate()`. Known blind spot: a leaf mesh that later gets children of its own.
- **Re-entrant:** a predicate may query again (walk footprint check); each query takes its own heap.
- **Tests:** node fuzz (thousands of random rays over random meshes / instances / batches with exact duplicates for ties, axis-aligned rays, near/far, layers, hidden / ghosted / clipped, every sync path) vs the full raycast; browser grid × 12 states vs `S.scenePick.bruteForce = true` (test-only switch), snaps via real mousemove, and hover cost on a generated federation (~17k elements: median 3–4 ms → ~0.02 ms per hover query).

### 21.48 Triangle-level narrow phase — what was built, kept and rejected (2026-10-23)

**Code reference:** `engine/Cargo.toml` (opt-level), `engine/src/bvh.rs` `BvhNode::build`, `_buildBVHNode` / `_bvhStableSort`, `_ccRefineTraverse` + `_ccTriBox6`, `_ccMeshTopo`, `_jsIntersectBVH`; tests `engine/src/lib.rs` `bvh_build_equivalence_tests`, `tests/kernel-degenerate-bound.test.js`.

Rule: only changes that are faster with the same answer on every path (JS, stateless WASM, Engine, pool, native) were kept.
- **Kept — WASM built for speed.** Most of the Engine's narrow-phase time is registering meshes (BVH builds). `opt-level = "z"` → `3`: build ~2x faster, no f64 result changes (no fast-math / FMA contraction at any level), +11 KB wasm.
- **Kept — same tree, cheaper build (Rust + JS).** Per-triangle boxes (same running min / max, same bits incl. +-0), already-sorted ranges skipped (identity of a stable sort), Rust sorts (key, index) pairs, inline leaf indices, one allocation per child pair. NaN-key meshes keep the original comparator sort call (Rust's sort may panic on them — it did before, too). The pre-change build is kept as a test-only reference.
- **Kept — refinement.** `_ccRefineTraverse` skips triangle pairs whose boxes are more than tau (+0.1 %) apart: both `_ccTriDeep` certificates (transversal overlap, coplanar patch inside the prism over A) lie within tau of both triangles, so it returned false with no side effects for them (91 % of its calls on the dense fixture). `_ccMeshTopo` reuses stamped hash tables (same sizes, hash, probe order → same ids / slots / odd-edge order) and scans for odd edges only when there are any; `verts` is a Float32Array of the same values.
- **Kept — JS kernel.** The early-exit probe pass before the collect pass is gone (it was the collect pass's own prefix; Rust never had it).
- **Rejected — exact (orient3d) predicates in `_triTriTest`.** Fuzzed 120k near-degenerate pairs (vertex / edge / triangle near the other plane, vertex near an edge, at 0 / 50 / 500 m, plus slivers) against the oracle's exact `triTri`: the kernel disagrees often, but every disagreement is < 1 µm (< 15 µm on slivers) — a hit 1 µm apart in truth, a missed crossing 1 µm deep — and it is symmetric in argument order in every case. The pair decision works at tau = 0.1 mm and the oracle scores reported distances below 0.1 mm as 0, so no verdict or distance can move; exact predicates would only cost time. `tests/kernel-degenerate-bound.test.js` pins the bound and the symmetry.
- **Rejected — SAH BVH.** Built twice (3-axis 16-bin, then 1-axis 8-bin with child boxes / key bounds from the bins), JS == Rust node for node on every synthetic element. On the dense fixture it cut triangle tests ~30x (hit) / ~35x (min distance) and made the Engine's intersect ~4x and seeded min distance ~7x faster — but the build cost 2–3.5x the median build, and the build dominates first runs: the medium first run (hard + 50 mm) got slower on every path (pool-1 1995 → 2301 ms, main-js 1604 → 2420 ms). Worth revisiting only with a much cheaper SAH build or for clearance-heavy runs where the tree is reused.
- **Not built — nearest-first min-distance traversal.** ~37 % fewer triangle pairs on the near-miss field in a prototype, but the visiting order picks the winner among equal distances (reported closest points) and changes which pairs are pruned at rounding level, so it is not answer-identical (same reason as the clearance notes in §21.19).
- **Not built — WASM SIMD** (nothing above landed that it would accelerate enough to justify a second kernel variant).

### 21.49 Non-physical elements — one rule on every path

**Code reference:** `_ccIfcNonPhysical` / `_ccIfcNonPhysicalNoteIds` / `_ccIfcStubIds` (next to `_ccIfcStreamOrder`, serialized into the IFC worker), `loadIFC` + `_ifcWorkerMain` + `_ccDecodeIfcWorkerResult` (stubs = packed elements with `geoCount` 0), `_NON_PHYSICAL_TYPES` / `_ccIsNonPhysicalEl` (next to `_ccIsSpaceEl`), both broad-phase sweeps, `addons/local-engine.js`; tests `tests/non-physical-elements.test.js`, the differential harness's non-physical case.

IfcVirtualElement / IfcAnnotation / IfcGrid are not building parts. Before, the main-thread fallback skipped their geometry and kept stub elements, while the worker (the default path) decoded, packed, drew and clashed them, and kept no stubs at all (neither for them nor for rooms without geometry).
- **Loaders (identical by construction):** both call the same helpers. With any such element in the file, the stream runs over `_ccIfcStreamOrder`'s order minus them (`StreamMeshes`), so web-ifc never tessellates them — the expensive part; skipping in the callback only saved the copy-out. If the order probe cannot place every type, `StreamAllMeshes` runs and the callback drops them (same model). Files without them keep the plain `StreamAllMeshes` path, no probe. After the room pass: every in-scope one is noted `nonRenderable` (no `GetLine` per element — that cost more than it saved), then stub elements are appended — rooms without geometry, then the non-physical elements (props, storey, material, no meshes, empty box), in that order on both paths; a storey-scoped load keeps only the stubs on its storeys. Sharded loads: shard 0 does notes and stubs at global positions after the rooms; shards stream the order without them.
- **Never clash:** `_ccIsNonPhysicalEl` in both sweeps (JS + WASM input), the local-engine payload and the snapshot context — so also when a source hands them geometry (GLB join strips it anyway; Revit drops grids by category; old caches). Rooms keep their own `includeSpaces` switch.
- **Visibility decision — kept hidden:** web-ifc 0.0.77 yields NO mesh for curve-based grids (`IfcGridAxis` polylines, FootPrint curve sets) or 2D annotations (polylines, text, fill areas) — measured on synthetic files — so "show grids as reference" needs a curve/line path neither loader has; the solids it does yield (3D annotation volumes, virtual boundaries) are not reference geometry worth drawing as building parts. Grids are read as data from their `IfcGridAxis` curves instead (§21.51).
- **Geo cache `np:1`:** worker-written caches drew these elements and lacked the stubs; `_ccGeoCacheLacksSpaces` re-parses them once when the source IFC is stored. `_ccRestoredGeoMatchesCache` accepts a stub's empty (±Infinity) box.
- **Found on the way:** the worker packed `props.typeId` in an `Int32Array`; IFC type codes reach 2^32, so IfcWall, IfcSpace, IfcVirtualElement … arrived negative. Now `Float64Array` (worker + shard merge); the differential harness compares every element's identity props, element order, stubs and the not-drawn report.
- **Cost (synthetic, generator `nonPhysical`):** 4 storeys × 20 walls + 12k non-physical boxes (5.5 MB): stream phase in node 166 → 31 ms (median of 5); browser worker `stats.loadTime` ~2.7–3.0 s → ~1.1–1.2 s (median of 3, two interleaved rounds, busy 4-core box). Mixed file with 2k of 7.8k elements non-physical: within noise.

### 21.50 First load — main-thread cost on the load path

**Code reference:** `_ccQuantizeNormalsI8` / `_ccPosBounds` (next to `_ccQuantizeNormalAttr` / `_ccGeoBounds`, serialized into the IFC worker), `_ccDecodeIfcWorkerResult` (`slice`, `_CC_DECODE_SLICE_MS`), `loadIFCWorker` (`_resultIn`, `_propsSeen`), `_ccLoadPreview` (`h.pending` / `h.flush`, `_frameMs`), `_frameCostPing` / `S._lastFrameMs` in the render loop, `_checkModelOverlap`; tests `tests/geo-bounds.test.js`, `tests/browser/progressive-load.mjs`, `tests/browser/ifc-worker-fallback-differential.mjs`, `tests/browser/memory-federation.mjs`.

Rule: the loaded scene and everything downstream stay identical (model digest, every mesh's matrices / geometry / bounds / material / instancing key, batching, the rendered frame, the clash list); only where and when the main thread does the work changes.
- **Normals and bounds in the worker.** The worker quantizes each unique geometry's normals to Int8 and computes its bounds (`_ccPosBounds`: [min, max, centre, radius] as float64) with the main thread's own functions, injected by `_getIFCWorkerUrl`; the entry travels as `{pos, nrm (Int8Array), idx, bb}`. The decode builds the same normalized Int8 attribute and `_ccGeoBounds(geo, bb)` sets the same box / sphere values (`tests/geo-bounds.test.js` checks `pre` against three). `window._ccQuantizeNormals === false` is passed to the worker (`qn`), which then sends Float32 normals as before. Int8 normals are a plain `BufferAttribute(int8, 3, true)` on both loaders — `Int8BufferAttribute` copies its array once more (same array type, itemSize and normalized flag).
- **Sliced decode.** The single-worker result is decoded in ~50 ms slices (`_ccYieldTask` between them) over the same loop in the same order, then instancing / batching as before. The load stays in `_ccActiveLoads`, so Cancel settles it as before; lazy props that arrive meanwhile are held by the caller until the commit (the gate already handled props before the in-order commit), and a worker error after the result only ends the props phase. The sharded path still decodes in one pass.
- **Preview: drawn lazily, paced on the real frame cost.** A preview batch only queues on its handle; right before a preview frame (`_inv`) every queued batch is merged into one chunk. Batches still queued when the file's result is decoded are dropped (`streamEnded`) — the model commits next, so they would have been built only to be torn down. The pacing measured `render()` only, but on a slow GPU or a software rasteriser most of a frame's cost lands after `render()` returns (compositor / GPU waits in the same task), so the "≤ 25 % of the time drawing" rule never held: `S._lastFrameMs` is now render start → the next task (a message posted from inside the frame task, only while loading) and the gap cap is 10 s (was 2 s). On a normal GPU the measured cost stays a few ms and nothing changes (gap 250 ms).
- **Overlap check:** `_checkModelOverlap` classified the new model's discipline on every commit; it is only needed when a near-total overlap is found, so it is computed then (same decision).
- **Rejected / not done:** skipping `applyMatrix4`'s decompose — the baked `matrix` is `compose(decompose(placement))`, not the placement itself, so setting it directly changes matrix bits; `expandByObject` → own box math (≈ 60 ms on 36k meshes, not worth a second implementation of three's box transform); avoiding the BatchedMesh copy (`addGeometry` copies every vertex once; the sources then view the batch — §21.46); deferring the console element profile (it reads props before the lazy merge, so its output would change).
- **Measured** (synthetic: `generateBuilding({scale:'large', seed:4242})` architecture + structure + MEP and `generateShardIfc({storeys:10, perStorey:1500, smallShare:true})`, 36,396 elements, one drop; headless Chromium with a software rasteriser on a shared 4-core box, so wall times are noisy — median of interleaved runs):
  | | before | after |
  |---|---|---|
  | load → all committed + props merged | 19.0 s | 10.9 s |
  | summed long tasks during load | 17.2 s | 7.2 s |
  | longest long task | 1.66 s | 1.30 s |
  | first input handled after the first model appears | 968 ms | 186 ms |
  | worst input delay during load | 1149 ms | 20 ms |

  Most of the "before" time was preview frames: each cost 1–3 s of main thread after `render()` returned while the pacing saw ~5 ms. With rendering stubbed out (JS cost only): load 6.6 → 6.7 s (worker-bound), summed long tasks 2.19 → 1.90 s, longest 830 → 543 ms (the sliced decode). Two-model federation (`generateShardIfc` × 2, 20 storeys × 1000, shared shapes, 38,512 elements): load 12.3 → 9.9 s, summed long tasks 10.9 → 7.6 s. Every run identical: deep model digest, every mesh's position / quaternion / scale / matrix / matrixWorld / flags / userData keys / geometry bounds, element boxes, instance matrices and the rendered frame (runtime culling flags `visible` / `_frustumCulled` / `_occlCulled` excluded — they follow the camera); `tests/browser/memory-federation.mjs` against the previous code (`MEM_FED_REF_ROOT`) also gives the identical clash list (40,775 clashes).
- **memory-federation's "after load" heap** is now read once two post-GC samples agree: after a fast load the geo-cache write (§21.46 / `idbSaveGeoCacheFresh`) can still be streaming 3 s later, and the old fixed wait then measured it (~710 MB vs the settled 427 MB, same on both code versions).

### 21.51 IFC grids — read as data, never clashed

**Code reference:** `extractGridAxes` / `ifcGeomReader` (serialized into the IFC worker; the fallback calls the same functions), `_ccGridLinesFromAxes`, `_ccSemanticModelFields` (`gridLines`), `_ccGridRef`, `_ccClashGrid` / `_ccClashLocation`, `_ccGridLinesAll` / `window._ccRefreshGridOverlay` / `window._ccGridBayForPoint` (viewer setup), the models effect (`S._gridsDrawn`), View menu "Show grids" (`prefs.showGridLines`); tests `tests/grid-axes-extract.test.js`, `tests/browser/grid-lines.mjs`.

- **One reader, both loaders.** `extractGridAxes(api, modelID)` walks every `IfcGrid` (U / V / W axes), evaluates each `IfcGridAxis` curve with the shared placement / curve reader (polyline, line, trimmed curve with point or parameter trims) and returns world points in file units with the axis tag, family and grid name. The worker sends them as `gridAxes`; the fallback resolves the same records, so both paths produce identical `gridLines` (browser test). The grid element itself stays a non-physical stub (§21.49).
- **`model.gridLines`** is the shared shape the Revit link already used: `{name, fam, grid, elev, pts:[x,z,…]}` in scene metres (x = X / unitScale, z = −Y / unitScale). Converted once per load result in `_ccSemanticModelFields`, whichever model-creation path asks first.
- **Overlay:** one line + one tag sprite per axis at the grid's elevation, rebuilt only when a visible model's `gridLines` array changes (identity compare in the models effect — the Revit bridge's own refresh call is gone). "Show grids" (View menu, shown only when a model has grids, persisted) toggles the group's visibility; nothing is rebuilt.
- **Clash location:** `_ccGridRef(lines, x, z)` picks the nearest axis of each family with a signed offset; `_ccClashGrid(c)` memoises its label per clash object until the set of grid lines changes, so a list render, a search keystroke or a report costs one lookup per clash once. `_ccClashLocation(c, storey)` → "Grid C-4 · Level 6" in the clash row, the clash report (column "Location", review cards) and the clash search; `get_clashes.gridBay` (Smart Bridge / MCP) uses the same lookup.
- **Geo cache (`gr:1`):** the cache record carries `gridAxes`, so park → restore and project reopen bring the grid lines back without a parse. A cache written before (no `gr`) is re-parsed once only when its stored IFC contains `IFCGRIDAXIS(` (`_ccIfcHasBytes`, one byte scan); other older caches restore as they are.
- **Not in BCF:** the topic description round-trips through import, so a location appended on export would be appended again on every re-export; the viewpoint already places the clash.

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

### 21.52 Storey elevations — metres, per model

**Code reference:** the "Storey units" block in `index.html` (`_ccStoreyUnitScale`, `_ccStoreyElevM`, `_ccCollectStoreys`, `_ccStoreyElevByName`, `_ccDetectUnitScale`, `_ccFormatElev`, `_ccElevInUnit`); tests `tests/storey-units.test.js`, `tests/browser/storey-units.mjs` (generator `units:'mm'`, `placeStoreys`).

`model.storeyData[i].elevation` stays the raw IFC value in that file's own length unit. It is converted to metres in ONE place, with that model's unit: the `unitScaleOverride` pref (one unit for every model) > the declared LENGTHUNIT (`stats.unitScale`) > the storey-spacing heuristic on that model's OWN storeys (fewer than two: its element-box height). Before, one unit (the first model's) was applied to the whole federation and storeys were merged by name on raw values, so a mm model next to a m model averaged 3000 and 3 to 1501.5 and the plan cut, labels and sheets were wrong.
- `_ccCollectStoreys(models)` returns levels in metres, merged across models by name within `STOREY_MERGE_TOL_M` (1 m; same name further apart stays two levels). A level whose storeys share one unit averages the raw values and converts once, so a single model or a same-unit federation gets bit-for-bit the metres it had (raw × 1/unit).
- Everything downstream is metres: `floorPlan.elevation` (cut = elevation + cutHeight, no factor; ctrl-wheel and the cut-arrow drag in metres; it already was metres when it came from `s.floors` or the smart-bridge `set_section_at`, which the old factor shrank for mm models), `sheet.elevation` (`_ccMakeSheet` takes metres; `_storeyElevation` is the display value; legacy sheets without `_geoFactor` are still migrated), sheet clash pins (were multiplied by the factor a second time), walk entry / walk storey picker (used raw mm as metres), the clash-filter level list, the NL context levels, the sidebar level list, the plan floor picker, the DXF export of an active floor plan, smart-bridge `list_storeys` / `create_2d_sheet` / `walk_mode` / `get_levels.elevationM` (was multiplied instead of divided) — the addon reaches the core through `window._ccCollectStoreys` / `window._ccStoreyElevM` (the bare names were never visible to it).
- The triage storey normaliser gets each model's resolved unit; the element quantity panel formats a quantity in its OWN model's unit.
- Display: `_ccDetectUnitScale` is presentation only — override > the unit most models declare (tie: the first) > the most common per-model heuristic; `_ccFormatElev(metres, unit)` snaps the converted value to 1e-6 so a label reads as it did from the raw value (3 m → "3000 mm"). Title blocks (canvas / SVG / DXF / print) format `sheet.elevation` with `sheet._unitScale`.


### 21.53 Persistence costs what changed

**Code reference:** `idbSaveProjectData` / `idbGetProjectData` / `idbDeleteProjectData` / `_ccProjPageMemo`, `_ccReadIdbInventory` (page keys), `storage-core.js` `planProjectPages` / `assembleProjectRecord` / `foldProjectRows` / `PROJECT_PAGE_SIZE`, `_saveCurrentProjectData` (`_ccModelMeta` / `_ccModelMetaSig`), `idbGetProjectFile`, `_ccFileSidecar`, `_ccRestoreModelGeometry(id, cached, getEntry)`, `_ccLsRemoved` (`cc-ls-removed`), `addons/training-data.js` (`_clashMem`), `addons/shared-project.js` (`_sharedLastSynced`); tests `tests/project-pages.test.js`, `tests/park-restore-io.test.js`, `tests/training-store-memory.test.js`, `tests/project-autopersist.test.js`, `tests/shared-project-safety.test.js`, `tests/browser/project-pages.mjs`, `tests/browser/action-cost.mjs`.

Rule: a save, sync or restore reads and writes what the action changed, not everything the project holds.
- **Project record = header + pages.** The `projects` store holds a header keyed by the project id (rules, filters, model meta, sheets, … and `_ccPages: {v, size, clashes, issues}`) and pages of 128 clashes / issues keyed `[projectId, 'c'|'i', n]` (`{id, items, bytes}`). Array keys sort after every string key, so they never collide with a project id, and `[pid] … [pid, []]` is the range of one project's pages. A save diffs the identity-stable clones (`_ccCloneListCached`) per page position against what the previous save wrote and puts only the changed pages + the header; an insertion/reorder rewrites the pages it shifts, a shorter list deletes the tail. Header, puts and deletes are ONE transaction, so header and pages always match.
- **The memo is optimistic.** `_ccProjPageMemo` is set when the transaction is created (transactions on one store commit in creation order, so the next save diffs against what this one writes, even while it is in flight) and cleared on any failure — the next save then rewrites every page after deleting the project's page range. No memo (first save after a load, project switch) = full write.
- **Old single-record projects** (no `_ccPages`) are read as they are and become pages on their first save (full write, the clashes leave the header). `assembleProjectRecord` returns the same fields the single record had (`id`, header fields, `clashes`, `issues`, `bytes` = header + pages).
- **Flush:** the transaction calls `tx.commit()` after queuing its requests. Without it a pagehide/visibility flush of an edit made right before a reload was lost (also before pages: `tests/browser/project-pages.mjs`).
- **Accounting:** the storage inventory keys its index lookup so array keys can't collide, and folds header + page rows into one row per project (`foldProjectRows`), so report, budget and eviction see one project with its full size. Project delete removes the header and the page range.
- **Autosave inputs:** models are persisted only as `modelMeta`, so the autosave effect and the `storageAutosaveGate` memo key on `_ccModelMetaSig(s.models)` (cached per models array), not on `s.models` identity: a storey hide or other non-persisted model change saves nothing; a visibility toggle/rename writes the header only. A failed write (`'failed'`) does not record the gate memo.
- **Park/restore reads one file, only when needed.** `idbGetProjectFile(pid, id)` is a single get by id (park guard, reload-in-full, restore) — never `getAll` of the project's IFC buffers. Restore reads the cache first and calls `getEntry()` only where the cache-vs-cold-parse policy needs the IFC (no usable cache, flags that need the source scanned, cold-parse fallback) or when the record may carry a Revit sidecar: `_ccFileSidecar[id]` is noted wherever this session reads/writes a file record; unknown ids read it.
- **Training store in memory.** `addons/training-data.js` keeps the parsed clash training store (write-through; localStorage content unchanged, the new record is normalised through JSON so memory equals a fresh parse). Dropped on a `storage` event, on `cc-ls-removed` (core: Clear training data, the localStorage quota pruner) and after a failed write.
- **Shared folder sync** skips a tick (no read, no write, no dispatch) when the slices it writes have the identities of its last write and the file's `lastModified`/`size` (metadata only) are what that write left; Sync Now forces. `MERGE_COMMENTS` returns the same state when nothing is new, or every tick would look like a change. (Superseded by the change-log redesign, §21.55.)
- Large synthetic federation (3 models, 21,982 elements, 13,716 clashes): per status edit 1 put of ~17.5 MB / 260–340 ms long task → 1 page + header, 2.6–5 ms of puts, no long task; visibility toggle / rename ~280–400 ms → 0.2–0.3 ms; storey hide ~280 ms → no write; restore of one parked model read 23.4 MB of IFC (every file) → 0; an idle shared-sync tick ~280–340 ms of stringify + a file read + 3–4 dispatches → nothing; the training count parsed the store on every edit (10–20 ms) → 0. The first save after a load or detection still writes everything once.

### 21.55 Shared folder — change log, conflicts shown to everyone

**Code reference:** `shared-log-core.js` (`window._ccSharedLogCore`: `makeChange` / `makeResolution` / `fieldState` / `targetState` / `buildSnapshot` / `planCleanup` / `migrateProject`), `addons/shared-project.js` (`_link`, `_tick`, `_flush`, `_note`, `_resolve`, `_project`, `_seed`, `_migrate`), the dispatch-wrapper hook `window._ccSharedLogNote` in `App`, `_ccSharedConflictBadge` / `SharedConflictResolver` / `_ccSharedConflictStats` (index.html), the `shared-conflict` tag + suggested view in `clash-triage-core.js`; tests `tests/shared-log-core.test.js`, `tests/shared-project-safety.test.js`, `tests/browser/shared-folder.mjs`.

Rule: a write costs what changed, no two people ever write the same file, and a concurrent edit is a conflict every user sees until a user resolves it — never an automatic winner.

- **Folder layout.** The picked folder holds `<name>.ccshared/` (an existing one is used; a picked folder named `*.ccshared` is used as is): `project-<id>.json` (written once; the smallest name is the local cache key), `changes/<userId>/<writer>-<seq>.json` and `snapshot-<ts>-<userId>.json`. Every file is created once under a name only its author can produce (userId = per-browser random id in `cc_shared_uid`; writer = per page-load id, so two tabs never collide) and never rewritten — `createWritable` copies the whole file and sync clients re-upload whole files, so there are no appends either. A cloud client therefore never sees two writers on one file: no "conflicted copy", no lost update.
- **Records = decisions, not clash data.** `{id, user, ts, target:{kind, key}, field, value, base, resolves?, prev?, resolution?}`. Targets: `clash` keyed by the clash identity (`_identityKey` / `computeClashIdentityKey`, the same on every machine that runs detection on the same models), `issue` by id (`created` = the issue's own fields without `_*`, comments, pictures, training signals; `deleted`; `comment:<id>`), `note` (3D comments: `created`, `text`, `resolved`, `deleted`, `reply:<id>`). Clash fields are `DECISION_FIELDS` (status, priority, assignee, title, description, category, dueDate — the api/project.js set). Geometry and results stay local.
- **Conflict rule (shared-log-core, never time-based).** Per (target, field) the heads are the changes nothing builds on via `base` or `resolves` (a reference to a change not read yet counts). One head, or several with the same value → that value. Several different values → conflict, whether made seconds or months apart; the field shows the last agreed value = the newest common ancestor (when the maximal common ancestors disagree — two concurrent resolutions — it goes further down; with none, the earliest root's `prev`). An edit made after reading another builds on it (`base` = the head) and is an ordinary update, however soon after. An ordinary edit of a conflicted field builds on the agreed version and so JOINS the conflict; only a resolution (`resolves` = every current head, `resolution:true`) clears it. Two different concurrent resolutions are a new conflict by the same rule. Nothing is dropped from the log.
- **Writing.** `_note` (from the dispatch wrapper, local actions only — everything the addon dispatches carries `_fromSync`) turns UPD_CLASH / BATCH_UPD_CLASH / CLASH_BATCH_RESTORE (undo) / UPD_ISSUE / BATCH_UPD_ISSUE / ADD_ISSUE / DEL_ISSUE / ADD/UPD/DEL_COMMENT into records, skips no-ops and amends a still-unwritten record of the same field (typing an assignee is one record). Pending records are in `cc_shared_outbox:<writer>` at once; after 3 s of quiet, on Sync Now, a resolution, `visibilitychange`→hidden or `pagehide` they become ONE new file. A failed write keeps them pending; an outbox left by a closed tab (key untouched for a minute) is adopted by the next check.
- **Reading costs what is new.** A check lists names only (`.ccshared`, `changes/`, each user folder) and reads only snapshots / change files not applied yet (newest snapshot first; a snapshot marks the files it covers as applied). Applied names and the records live in the IndexedDB cache `cc_shared` (`log`, `seen`, keyed `[projectKey, …]`, only new rows put), so a reload reads only files new since. A file that does not parse (half-downloaded) is retried only when its size/date changes. An idle check: no file opened or read, nothing written, nothing dispatched (`tests/browser/shared-folder.mjs` counts `getFile` / `Blob.text` / `createWritable`).
- **Log → app state (`_project`).** For the targets that changed (and for every target when the local clashes / issues / notes array changed — a detection run, a project load) it puts the shared values on the local objects and `_sharedConflict` = `[{kind, key, field, agreed:{value,…}, heads:[{id, user, mine, ts, value}]}]`, dispatching only what differs: one `CLASH_BATCH_RESTORE` (no issue creation, no undo entry), `UPD_ISSUE` / `ADD_ISSUE` / `DEL_ISSUE`, `UPD/ADD/DEL_COMMENT`, all `_fromSync`. A local `auto_resolved` status is not overwritten (the geometry says it is gone). Teammates' records also go into the History (`MERGE_CHANGELOG`). The marker is a field of the clash object, so memoised rows, the triage index (`_ccTriageIncremental`) and autosave pick it up like any edit.
- **What each user sees.** Row badge "Conflict" (warning tokens, tooltip with fields + names); the suggested view "Conflicts" (`tag: shared-conflict`, offered whenever there is one, also when every item is conflicted); "N conflicts to resolve" in the review overview header (also shows the buckets holding them); in the row detail `SharedConflictResolver`: per field the agreed value, every competing value with who / when and "Use this", plus "Use new value" (status select or text). Notes get the same badge + resolver in Share ▸ Comments. `sharedProject.conflicts` counts them for the Integrations panel.
- **First link.** Once per browser and project, this user's own non-default decisions not in the folder yet (clash status ≠ open/auto_resolved, priority ≠ normal, assignee; issues; notes) are published (`_seed`); a value that differs from a shared one becomes a conflict, never silently lost or silently overwritten.
- **Snapshots + cleanup.** Past 200 change files not covered by a known snapshot, a client (random half per check) writes a snapshot: every change record it holds (so a change made later on ANY old version is still placed right — pruning would lose that), the open conflicts, and the change files / older snapshots it covers. Merge = union by id, so snapshot + files in any order and any number of times give the same log. Only the snapshot's author deletes what it covers, only after 6 h (`planCleanup`), and only covered names — a client that has not read the snapshot yet gets every change from it (proved by a randomized lagging-sync simulation in `tests/shared-log-core.test.js`, which fails if cleanup removes an uncovered file).
- **Migration.** An old `.ccproject` next to the shared folder is read once into `snapshot-<savedAt>-legacy-<hash>.json` (non-default clash decisions, issues + comments, notes + replies); ids and name come from the file content, so two people migrating at once write the same thing; the old file is never written.
- Fixed on the way: linking called `.then` on `dirHandle.values()` (an async iterator), so linking a folder never completed in Chrome.
- Not covered (open): viewpoints are not shared any more (the old file carried them without pictures); an issue a confirm creates in the reducer (`UPD_CLASH` status confirmed) is not published — teammates get the clash status only; an edit concurrent with an issue delete is kept in the log but the issue stays deleted.

