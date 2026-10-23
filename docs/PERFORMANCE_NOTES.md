# ClashControl Rendering & Performance Notes

## Context

Analysis of GPU instancing feasibility (prompted by comparison with Fragments .frag format), covering what the codebase already does well, confirmed efficiency gaps, and what to leave alone.

> **Implementation status (2026-07-08).** Implemented: GPU instancing on the IFC path (`InstancedMesh`), BatchedMesh for pathological models (`_ccBatchPathological`), Int8 geometry normals, an adaptive BVH cache + pair-result cache that persist across detection runs, and GLB-path matCache/geoCache dedup (#1, #2 — confirmed in code, this doc previously said open). Open: GLB worker mesh dedup (#3). The chunk-merge draw-call reducer mentioned in earlier revisions of this doc **no longer exists** — removed entirely and replaced by BatchedMesh (see MEMORY.md architecture decisions). Line numbers in this document are indicative and drift as the file grows — locate code by the named symbol or section header, not the line number.

---

## Corrections to Initial Assumptions

| Claim | Reality |
|---|---|
| "Clash detection is OBB-based" | It is **AABB BVH + Möller-Trumbore triangle-triangle** (`index.html:2588–2666`). More precise than OBB. |
| "Ghost system swaps material with no caching" | True it swaps, but **`_ghostMatCache` (UUID-keyed, `index.html:4725`) caches clones** — ghost materials are not recreated per frame. |
| "`mesh.applyMatrix4()` bakes transform into geometry — critical bug" | **False.** `THREE.Mesh.applyMatrix4` calls `Object3D.applyMatrix4` which only updates the mesh's own matrix. Geometry vertices are not mutated. `geoCache` sharing is safe. |

---

## What Already Works Well (Leave Alone)

### IFC path — geometry & material deduplication
- `geoCache` (`index.html:1884`) shares one `THREE.BufferGeometry` across all placed elements with the same `geometryExpressID`. Because Three.js shares the same object reference, WebGL uploads the vertex buffer to the GPU **once** — VRAM deduplication is already in place.
- `matCache` (`index.html:1884`) shares one `THREE.MeshPhongMaterial` per unique RGBA color.
- The only remaining cost is **one draw call per mesh**, not one geometry upload per mesh.

### Transform baking
- `_ccBakeMesh` (`index.html:1302–1307`) freezes `matrixAutoUpdate = false` and `frustumCulled = false` on every mesh at load time. Per-frame transform cost is zero.

### Manual frustum culling + LOD proxies
- `updateCulling` (`index.html:5833`) does a frustum check per mesh per frame and substitutes a shared box proxy (`_lodBoxGeo` / `_lodProxyMat`, shared objects) for distant elements. Avoids GPU overdraw on large models.

### Clash detection engine
- AABB BVH (`index.html:2588–2615`) for broad-phase; Möller-Trumbore triangle-triangle for narrow-phase. Three-tier cache (`_wvCache`, `_triCache`, `_bvhCache`) avoids re-extracting world geometry per candidate pair within a single run.
- **Do not touch the algorithm.** Geometrically correct and already cache-efficient within a run.

### Worker-based IFC loading
- Geometry extraction runs off the main thread. Do not change the worker boundary.
- **Progressive preview + parallel files (2026-10-23, flags `progressivePreview` / `parallelLoad`, default on).** The worker transfers its geometry buffers in ordered batches while it streams; the main thread draws them as a display-only preview and later decodes the model from the same arrays (identical by construction, proven by `tests/browser/model-digest.mjs` in the differential and `progressive-load.mjs`). Several dropped files parse in separate workers under a memory budget; commits stay in file order. Medians of interleaved runs (SwiftShader, 4 shared cores, ms from the drop):

  | set | first pixel | 50 % triangles | all committed | total | peak RSS |
  |---|---|---|---|---|---|
  | generated large federation (3 files, 22k elements) | 5609 → 1730 | 8585 → 3149 | 10006 → 6477 | 10253 → 8422 | 1454 → 1471 MB |

  The preview stops growing once a frame costs > 400 ms (software rasteriser); on a GPU it keeps filling in. Total load time of very large files is dominated by the worker's lazy psets phase, which neither change shortens. The first model of a parallel batch commits later (it shares the CPU), every later one much earlier. Streaming removes most of the worker→main `transferGap` on large files.
- **Sharded single-file load (2026-10-23, flag `shardedLoad`, default on, files ≥ 32 MB, 2 workers):** identical model by construction + tests (docs/INTERNALS.md §7). Measured on synthetic files only, in a sandbox whose 4 cores were shared with other jobs, so the numbers swing with the box's load: web-ifc alone (node, open + stream, 10 MB generated architecture file) 2.1 → 1.6 s with 2 threads, no gain with 3; in the browser (`tests/browser/shard-load.mjs`, 21 MB / 50k elements, first load incl. preview, commit and props) 15.5 → 12.2 s in the quietest run, no gain or slower when the box was saturated (load average 6–8); below ~5 MB the extra worker start + open costs more than it saves. Each shard holds its own model copy in its WASM heap (2 shards = 2× the single worker's heap). Re-measure on an idle multi-core machine before tuning `_ccIfcShard.minBytes` / `maxShards`.
- Not built (measured reasons in MEMORY.md): packing the geometry table into a few typed arrays, loader-side recentring of far models.
- Remaining tail: the geo-cache write right after a big commit (serialize + IndexedDB put, seconds of main thread on very large models) delays the first real frame.

### Ghost material cache
- `_ghostMatCache` (`index.html:4725`) keyed by `origMat.uuid` — one ghost clone per unique material, reused across all elements sharing that material.

---

## Confirmed Efficiency Gaps

### 1. GLB path: matCache — ✅ implemented
**Was:** `loadGLB` created `new THREE.MeshPhongMaterial` per node with no dedup.
**Now:** `loadGLB` (`function loadGLB`, search for it — it's grown well past any fixed line number) keeps a `matCache` keyed by color+alpha, matching the IFC path.

### 2. GLB path: geometry dedup + normals-once — ✅ implemented
**Was:** geometry cloned and `computeVertexNormals()` re-run per node even when nodes shared a mesh.
**Now:** `geoCache` keyed by `geoUuid`; `computeVertexNormals()` only runs on cache miss.

### 3. GLB worker: shared GLTF mesh primitives re-extracted per node — MEDIUM effort
**Gap:** The worker (`index.html:2969–2992`) re-reads primitive vertex data each time a node references the same `node.mesh` index. For a building with 500 identical columns, primitive data is parsed 500 times.
**Fix:** Cache extracted local-space vertices/triangles by `node.mesh` index. Apply each node's world transform to the cached data.
**Risk:** Low, self-contained in the worker.

### 4. Persistent BVH cache across detection runs — ✅ implemented
**Status:** An adaptive `_BVH_CACHE_MAX` (sized to a heap budget) persists geometry/BVH work across detection runs, and the smart re-run memo (`_ccRunMemo`, see INTERNALS §21.19) carries unchanged pairs' results so re-runs only recompute changed elements; all are cleared per-model on `DEL_MODEL`/`REPLACE_MODEL`.

### 5. GPU instancing via `THREE.InstancedMesh` — ✅ implemented (IFC path)
**Status:** A post-streaming pass (`_buildInstancedMeshes`) groups by `(geoExpId, matKey)` and emits `InstancedMesh` for repeated geometry; raycast/hover/ghost/culling map `instanceId → expressId`. The GLB path is not instanced (it needs gap #3 first). For pathological non-repetitive models (many unique geometries, e.g. cladding), `_ccBatchPathological` uses `THREE.BatchedMesh` instead — see MEMORY.md "sixth batch" for the trigger constants and identity-feature parity work.

**Subsystems requiring changes:**

| Subsystem | Change | Location |
|---|---|---|
| IFC loader | Post-streaming pass: group by `(geoExpId, matKey)`, create `InstancedMesh` for groups ≥ threshold | `index.html:1885–2001` |
| Element map | Add `expressId → { instancedMesh, instanceIndex }` lookup | loader output |
| Ghost system | `instanceColor` tinting or split-out per instance | `index.html:4725` |
| Hover system | `instanceColor.setXYZ(i,…)` instead of `material.emissive.set(…)` | `index.html:5260` |
| Raycasting | Map returned `instanceId` → `expressId` | `index.html:5410` |
| updateCulling | Per-instance visibility via count/instanceColor | `index.html:5833` |
| Clash detection | `getMatrixAt(i, m)` + apply to base geometry for `_wvCache`/`_triCache` | `index.html:2468` |

**Constraint (lifted):** the core now runs Three.js r180, so the `EXT_mesh_gpu_instancing` GLB extension (r135+) is available to the GLB path if wanted.
**Order:** IFC path first. GLB path requires gap #2 (geometry dedup) to be solved first.

---

## What to Leave Alone

| Area | Reason |
|---|---|
| htm parser | Hand-written, tested, fragile |
| IFC loader / web-ifc WASM integration | Working, complex |
| AABB BVH + Möller-Trumbore clash engine | Geometrically correct; do not change the algorithm |
| `_ccBakeMesh` | Correctly freezes transforms; instancing must be inserted before this is called |
| `invalidate()` render-on-demand system | Breaking causes GPU waste or no rendering |
| View cube quaternion inversion | Documented quirk; switching breaks mirroring |
| Three.js version pinning | r180 via import map — bump deliberately, never float to latest |
| Per-model geoCache scope | Cross-model dedup requires content-hashing; not worth the complexity |

---

## Priority Summary

| # | Improvement | Effort | Gain | Risk | Status |
|---|---|---|---|---|---|
| 1 | GLB matCache | Low | Material memory reduction | None | ✅ implemented |
| 2 | GLB geometry dedup + normals once | Low | Memory + CPU at load | Low | ✅ implemented |
| 3 | GLB worker mesh dedup | Medium | CPU at clash-prep for large GLBs | Low | ⬜ open |
| 4 | Persistent BVH cache across runs | Medium | CPU at repeat detection | Medium | ✅ implemented |
| 5 | GPU instancing (IFC path first) | High | Draw calls for large repetitive buildings | Medium | ✅ implemented |
| 6 | BatchedMesh for pathological (non-repetitive) models | High | Draw calls where instancing can't help | Medium | ✅ implemented |
