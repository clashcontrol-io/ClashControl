# Design: scene-resident-set with frustum gating

> Status: **draft for review.** No code follows from this document until the
> consumer audit (§4) and the quick-measurement task (§5) are signed off.

## 1. Problem & target

The reference federation in this session loads **73,402 elements**. After the
session's surviving memory wins (Int8 normals, shared `MeshPhongMaterial`
cache, base-point strip, model dedup), the dominant remaining cost in JS
heap is **`THREE.Mesh` + `THREE.BufferGeometry` + matrix + `userData`
bookkeeping per element**, independent of the vertex data itself.

Rough estimate from the audit: **3–5 KB per element of Three.js object
overhead** ⇒ ~220–360 MB on the reference federation. This is *not* vertex
data — that's already as small as the constraints allow.

**Target.** Cut ≥150 MB of resident heap on the reference federation **with
zero behavioral regression** across the consumer matrix in §4. Quantitative
threshold for proceeding past the design phase is set in §5.

The lever is not new data compression. It's **owning fewer live
`THREE.Mesh` objects at any one moment.** The raw vertex/index/matrix data
stays resident in plain typed arrays; only the `THREE.Mesh` wrapper around
that data is materialised on demand.

## 2. Constraints

| Constraint | Reason |
|---|---|
| Three.js r128 pinned | Architecture decision (`MEMORY.md`). Upgrade rejected this session. |
| No build step / single-file `index.html` | Architecture decision. No ESM modules, no bundler. |
| No per-feature regression | Selection, hover, clash, BCF, Style swap, measurement, section cut, ghost, walk mode, 2D sheet, GLTF export, Revit live-link addon must keep working exactly as today. |
| No new dependencies | This is a refactor of existing pipeline, not a port to Fragments. |

## 3. Why prior attempts failed (and why this lever is structurally different)

Four memory-reduction approaches were attempted this session. Three failed
in ways that weren't predictable from reading the file:

| Attempt | Failure mode |
|---|---|
| Free RAM / dehydrate (`el.meshes[i]` attribute dispose) | Disposed `BufferAttribute.array` buffers were *shared* with `InstancedMesh` and live scene meshes; dispose corrupted the scene. Even after safety guards, dehydrated state broke selection EdgesGeometry, BCF, hover. Hydrate-on-click was rejected: "if hydrate-on-click, the whole idea doesn't stand." |
| Chunk-merge default-ON (Stages 1/2A/2B) | Merging same-material adjacent elements into one `BufferGeometry` visually blended distinct walls and made Style switching a no-op on merged chunks. Disabled-by-default on `claude/disable-chunk-merge` (#585). |
| Resident Uint16 position quantization | r128's `BufferAttribute.getX` returns the raw stored value, ignoring `normalized` flag. Would silently break clash narrow-phase (`_getWorldVerts`/`_getWorldTris`), raycast picking, `EdgesGeometry`, measurement snap. Three.js core consumers we cannot intercept. |
| Int8 normals (PR-A, kept) | ✓ Worked. Render-only attribute, no CPU reader; ~630 MB cut. |

**How the scene-resident-set lever avoids each pattern.**

- *Not dehydration.* Raw position/index/matrix data is **always resident**
  in a side-table (the geometry pool, §4.1). No IO. No shared-buffer
  disposal hazard. The thing that gets created and destroyed is the
  lightweight `THREE.Mesh` wrapper, not its data.
- *Not chunk-merge.* Every element keeps a stable `expressId`, its own
  geometry slot, its own matrix, and its own material key. There is no
  per-material merged geometry. Picking, Style swap, hide/show, ghost,
  color-by-class all read the same `expressId` indirection they read today.
- *Not Uint16 positions.* Positions stay `Float32` in the pool. No r128
  reader breakage.
- *Not "free everything off-screen and reload from disk."* On-screen
  elements get a real `THREE.Mesh`; off-screen elements get a `null` slot.
  No IO either way.

## 4. Architecture

### 4.1 Geometry pool (resident, lives outside the scene graph)

Per loaded model, alongside the existing `model.elements[]`:

```text
GeometryPool = Map<expressId, GeometryEntry>

GeometryEntry = {
  positions:   Float32Array,                 // local-space vertices
  indices:     Uint16Array | Uint32Array,    // triangle list
  normalsInt8: Int8Array,                    // already what _ccQuantizeNormalAttr produces
  matrix:      Float32Array(16),             // local→world (baked once, as today)
  bboxMin:     Float32Array(3),              // world-space, precomputed
  bboxMax:     Float32Array(3),              //   "
  materialKey: string,                       // RGBA key into _ccGetSharedPhongMat cache
  visibleFlag: bool,                         // user hide/show
  styleKey:    string|null,                  // active Style override (standard/shaded/...)
}
```

Notes:

- Today, every element already carries this data inside `el.meshes[i].geometry`. The pool
  is a *flat* re-projection of it that lives separate from the scene graph,
  so we can dispose the `THREE.Mesh` without losing the data.
- The `materialKey` indirection lets `_ccGetSharedPhongMat`
  (`index.html:2683`) keep working as the single source of materials.
- The pool is built from the same data the loader produces today
  (`loadIFC`, IDB cache restore via `_geoDeserialize` at `index.html:1595`).
  No new compression step.

### 4.2 Resident set (live `THREE.Mesh` wrappers)

```text
ResidentSet = Map<expressId, THREE.Mesh>
```

A `THREE.Mesh` is created **only** when the element enters the working set
(see §4.3) and **disposed** (geometry + mesh, *not* the pool entry) when it
leaves. The Mesh's `geometry.attributes.position.array` is a view onto the
pool's `positions` (zero-copy `Float32Array` reuse where r128 permits it;
copy where it doesn't — measured in §5).

### 4.3 Working set policy

The working set is the union of:

1. **Frustum-visible elements.** Broad-phase: AABB-vs-frustum test against
   the pool's precomputed `bboxMin`/`bboxMax`. Walked on the same trigger
   as `invalidate()` (already debounced), throttled to at most one walk per
   frame.
2. **Pinned elements.** Currently selected element, currently hovered
   element, every element referenced by an open Issue / BCF viewpoint, every
   element a measurement snap is anchored to. These are pinned so
   consumers that hold a `THREE.Mesh` reference don't see it ripped out
   from under them.
3. **In-flight consumer requests.** During clash run, GLTF export, BCF
   capture batch, etc., the relevant elements are pinned for the duration
   of the operation (see §4.4 per-consumer rules).

### 4.4 Consumer audit

This is the table that has to be right for the refactor to be safe. Every
site in `index.html` that reads `attributes.position`, `el.meshes[i]`, or
otherwise assumes a live `THREE.Mesh` must be classified. Line numbers as
of `origin/main` (commit `a13893d`).

Legend:
- **R** = "resident by definition" (only runs on visible elements; no change needed)
- **M-on-call** = "materialise on lookup" (lookup transparently builds the Mesh and pins it for the call duration)
- **Batch-rehydrate** = "pin all relevant elements, run, unpin" (used for whole-model passes)
- **Pool-direct** = "read from the geometry pool, never touch `THREE.Mesh`"

| # | Site | File:line | Policy | Failure mode if wrong |
|---|---|---|---|---|
| 1 | Clash narrow-phase `_getWorldVerts` | `index.html:3453` | Batch-rehydrate before clash run | False-negative clashes (missing geometry) |
| 2 | Clash narrow-phase `_getWorldTris` | `index.html:3472` | Batch-rehydrate before clash run | Same as 1 |
| 3 | Selection/hover `_buildHighlightGroupForMesh` | `index.html:7333` | M-on-call (selection is pinned in working set) | Wrong outline geometry; missing EdgesGeometry |
| 4 | Universal lookup `_findMeshByRef` | `index.html:7315` | M-on-call; returns Mesh after materialise | Every downstream consumer breaks |
| 5 | IDB cache `_geoSerialize` | `index.html:1543` | Pool-direct (reads pool, not Mesh) | Corrupted cache → bad restore |
| 6 | IDB cache `_geoDeserialize` | `index.html:1595` | Pool-direct (writes pool, not Mesh) | Same as 5 |
| 7 | BCF export `exportBCF` | `index.html:5357` | Iterates referenced issues; pinned elements are already in working set; for unpinned, batch-rehydrate per viewpoint | Missing snapshot geometry / wrong bbox |
| 8 | BCF viewpoint `captureCurrent` | `index.html:20426` | R (only captures currently rendered scene) | None expected |
| 9 | GLTF export `exportGLTF` | `index.html:16830` | Batch-rehydrate (or stream from pool element-by-element to bound peak heap) | Empty / partial export |
| 10 | Section cut / section box (`scene.traverse` clipping plane apply) | `index.html:9022, 10619, 10854` | R (only adjusts material clippingPlanes on resident Meshes) | Off-screen elements get clipped state on next materialise → handled by pool's `styleKey` |
| 11 | Style swap (standard/shaded/rendered/wireframe) | `index.html:11487`, `_origMaterial` at `16176/16194/16623` | Apply to pool's `materialKey`; resident Meshes follow on next render | Off-screen elements wrong material when they enter frustum |
| 12 | Ghost mode | uses shared `MeshBasicMaterial` | Pool's `materialKey` set to ghost key; resident Meshes follow | Wrong color on entry |
| 13 | Visibility hide/show | walks `model.elements` today | Set `visibleFlag` in pool; resident-set walk respects it | Ghost element flicker on materialise |
| 14 | Measurement snap | needs nearest vertex on a hover target | R (hover is pinned) | Snap fails on edges of working set |
| 15 | Raycast picking | reads `hit.object.geometry.attributes.position` (`index.html:7886, 8278, 8284, 9625`) | R (raycaster only hits resident Meshes; off-screen elements are not pickable, which is what the user already expects since the camera can't see them) | Misclick edge case at frustum boundary |
| 16 | InstancedMesh path `_buildInstancedMeshes` | `index.html:2635` | **Exclude from gating.** InstancedMesh already collapses repeated placements; gating individual instances would defeat it. Pool entry holds a reference to the parent InstancedMesh + instanceId, no per-instance Mesh. | Double-gating, broken instance hover |
| 17 | Chunk-merge path (`window._ccChunkMerge`, currently default-ON on main, default-OFF on `claude/disable-chunk-merge`) | `index.html:2453, 2535, 2588` | **Out of scope.** Gate is incompatible with chunk-merge by construction (merged chunks have no per-element Mesh to materialise). Gating is only enabled when chunk-merge is OFF. | Visual breakage if both flags ON |
| 18 | Revit live-link addon (`addons/revit-bridge.js`) | external | **Bypass gating** on REPLACE_MODEL / push updates: addon needs a stable Mesh handle. Mark addon-managed models as "always-resident". | Live-link breakage |
| 19 | 2D sheet view (polygon-face section cut over all model elements) | (line refs TBD) | Batch-rehydrate elements crossing the active storey plane | Missing walls/columns on plan |
| 20 | Data quality addon | external | Pool-direct for geometric checks; descriptor checks unaffected | Wrong DQ counts |
| 21 | Walk mode (FPS navigation) | (line refs TBD) | R + slightly enlarged frustum (anticipate forward motion) | Pop-in on fast walks |
| 22 | Perf snapshot `_ccPerfSnapshot` / GPU counts | `index.html:1710` | Pool-direct (reports pool size + resident size separately) | Misleading stats |
| 23 | `scene.traverse(o => o.isMesh)` patterns | `index.html:10619, 10815, 10854, 12902, 12948` | Audit each call site; most are clipping-plane / style updates which fall under R | Stale flags on materialise |

**Sites for which line numbers are TBD** are flagged for the implementation
PR's deeper audit; the design contract is that they will all fit into one
of the four policies above.

### 4.5 Materialisation cost

Building a `THREE.Mesh` from a pool entry:

```text
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(entry.positions, 3));
geo.setAttribute('normal',   new THREE.BufferAttribute(entry.normalsInt8, 3, true));
geo.setIndex(new THREE.BufferAttribute(entry.indices, 1));
geo.boundingBox = new THREE.Box3(/* from entry.bboxMin/Max */);
geo.boundingSphere = /* derived from bbox */;
const mat = _ccGetSharedPhongMat(entry.materialKey);   // already cached
const mesh = new THREE.Mesh(geo, mat);
mesh.applyMatrix4(/* from entry.matrix */);
_ccBakeMesh(mesh);                                     // existing helper at index.html:1717
mesh.userData.expressId = expressId;
```

Cost per materialise: one `BufferGeometry`, three `BufferAttribute`
wrappers (no array copy — the `Float32Array`/`Int8Array`/`Uint16Array` are
reused by reference), one `Mesh`, one matrix application. Target: < 0.1 ms
per element at frustum-walk time, < 5 ms for a 50-element burst.

The frustum walk should amortise this across frames — at most N elements
materialised per frame, ordered by distance from camera.

## 5. Quick-measurement task (gate to implementation)

Before any code is written, run this measurement on the reference
federation, on a build of `main` with chunk-merge disabled
(`window._ccChunkMerge = false` before load) to isolate the per-Mesh
overhead from the chunk-merge confound:

```js
// In DevTools, after model fully loads:
let n = 0;
S.scene.traverse(o => { if (o.isMesh && !o.isInstancedMesh) n++; });
const before = performance.memory.usedJSHeapSize;
console.log('mesh count:', n, 'heap:', (before/1048576).toFixed(0), 'MB');

// Hide half the elements:
let toggled = 0;
S.scene.traverse(o => {
  if (o.isMesh && !o.isInstancedMesh && (toggled++ % 2 === 0)) o.visible = false;
});
// Wait a few frames, then:
const after = performance.memory.usedJSHeapSize;
console.log('after .visible=false on half:', (after/1048576).toFixed(0), 'MB');

// Then actually remove half:
const kill = [];
S.scene.traverse(o => { if (o.isMesh && !o.isInstancedMesh && kill.length < n/2) kill.push(o); });
kill.forEach(m => { m.parent.remove(m); m.geometry.dispose(); });
// Force GC if available, wait a few seconds:
const final = performance.memory.usedJSHeapSize;
console.log('after remove+dispose on half:', (final/1048576).toFixed(0), 'MB');
console.log('per-Mesh overhead:', ((before-final)/(n/2)/1024).toFixed(2), 'KB');
```

**Decision rule.**

| Per-Mesh overhead observed | Action |
|---|---|
| < 1.5 KB | **Abandon.** Estimate was wrong; full refactor not worth the failure-mode risk. |
| 1.5–3 KB | **Discuss.** Marginal; depends on user appetite. Probably defer. |
| > 3 KB | **Proceed** to scoping the implementation PR. |

## 6. Failure-mode pre-mortem

| Past failure | Why this design doesn't repeat it |
|---|---|
| Shared-buffer dispose corrupting InstancedMesh / scene | Pool buffers are never disposed. Only `THREE.Mesh` + its (newly created) `BufferGeometry` wrapper are disposed. `InstancedMesh` path is excluded from gating (§4.4 row 16). |
| Hydrate-on-click UX wart | Hydration is driven by **camera frustum**, not user interaction. Visible = resident. There is no user-visible "loading…" because elements are materialised before they enter the frustum (one-frame look-ahead based on camera velocity). |
| Visual blending of distinct elements (chunk-merge) | Per-element identity preserved end-to-end. Pool entries are keyed by `expressId`. No merging at any stage. |
| Style switching no-op on merged chunks | Style is applied to pool `materialKey`; resident Meshes follow. Always works on every element. |
| Raw-getter bypass (Uint16 positions) | Positions stay `Float32`. No r128 reader breakage. |
| Off-screen consumer reads (BCF, clash, GLTF) | Each is classified explicitly in §4.4 with a batch-rehydrate / M-on-call / pool-direct policy. |
| Addon assumptions (Revit live-link, Data Quality) | Live-link models bypass gating (always-resident); DQ reads pool-direct. |

## 7. Out of scope

The following ideas were considered earlier in the session and are
**explicitly not** part of this design:

- Three.js upgrade to ≥ r150 (would unlock Fragments / per-material
  batching). Rejected by architecture decision.
- ESM modules / build step. Same.
- Worker-based geometry stream (Fragments-style). Requires the above.
- Per-material batched `BufferGeometry` with instance matrix attribute.
  Same failure mode as chunk-merge.
- Resident `Uint16` quantized positions. Same failure mode as
  `claude/quantized-geometry`.
- Lazy hydration from disk on element access. Rejected.
- Removing the Int8 normal compression. It works; it stays.

## 8. Open questions for review

1. **Frustum-walk cadence.** Every `invalidate()` is too often (camera
   panning at 60 fps would thrash). Once per N ms, or once per camera
   "settle"? Suggest 100 ms throttle with immediate walk on big camera
   jumps (>30° rotation or >50% radius change).
2. **Pin set bloat.** If a user opens 200 BCF issues, do we pin all 200
   referenced elements forever, or only for the duration of the Issues
   panel being open? Suggest the latter; pin on panel open, unpin on close.
3. **Walk mode.** Should the working-set frustum be enlarged in walk mode
   to anticipate forward motion? Suggest yes — 1.5× near-plane radius for
   one frame of look-ahead.
4. **Federation models.** When a Revit linked model is loaded via the
   live-link addon, does it count as one always-resident model, or do we
   gate per-linked-model? Suggest always-resident on the addon side; the
   addon owns the lifecycle.
5. **Per-Mesh `_origMaterial` cache** (`index.html:11487, 16176, 16194,
   16623`) — does this move to the pool, or stay attached to the
   short-lived Mesh? If on the Mesh, Style swap state is lost on
   dispose/re-materialise. Suggest pool-resident `styleKey`, recompute
   `_origMaterial` from `materialKey` on materialise.
6. **`window._ccPerfSnapshot`** should report two numbers — pool size and
   resident size — so we can see the working-set ratio at a glance.
7. **Memory ceiling override.** Power users on 16 GB machines may want to
   disable gating entirely. Suggest a `window._ccResidentGating = false`
   debug flag that pins the whole model, symmetric to `_ccChunkMerge`.

## 9. Implementation plan (sketch only — not part of this approval)

If §5 measurement clears the threshold, the implementation lands as **four
separate PRs**, each independently revertable:

1. **Pool side-table only.** Build the pool alongside existing
   `el.meshes[]`, no behavior change. Validate by serialising the pool to
   IDB and confirming bit-equality with the current `_geoSerialize`
   output. *Memory delta: small (the pool duplicates some data).*
2. **Pool-direct rewrites.** Move `_geoSerialize`, clash narrow-phase,
   GLTF export, BCF export to read from the pool instead of
   `el.meshes[i].geometry`. Still no gating. *Memory delta: zero.
   Behavior delta: zero. This is the safe consumer migration.*
3. **Resident-set materialiser.** Add the frustum walk + materialise /
   dispose loop, but keep all elements force-pinned. Validate that
   nothing visually changes. *Memory delta: zero.*
4. **Enable gating.** Unpin elements outside the working set. *Memory
   delta: target ≥150 MB on the reference federation.*

Each PR ships behind a `window._ccResidentGating` flag for fast revert.

## 10. References

- `MEMORY.md` — recent session history.
- `CLAUDE.md` — architecture decisions, "things NOT to touch".
- `index.html` — the core file. Key sections: loader (lines 1469–2700),
  clash (3309–4300), highlight (7315–7480), Style/material (11487, 16176),
  exporters (5357, 16830, 20426).
- Prior memory-cut branches: `claude/quantized-geometry` (Uint16
  positions, reverted), `claude/auto-free-ram-toggle` and
  `claude/undo-free-ram` (dehydrate experiment, reverted),
  `claude/disable-chunk-merge` (chunk-merge default-OFF).
