# Occlusion culling

Status: **built; flag `occlusionCulling` default ON in "verified-auto" form.**
On means: cull only after *this device* passed an offscreen pixel check of the
current scene (section 1b). Until then, or if the check fails, nothing changes
for the user. Kill switch `?ccSafety=-occlusionCulling`. Status:
`window._ccOcclusion.status()` returns `{state: 'verified'|'refused'|'pending',
why, key, source, active, mode}`. No UI: no Settings area lists safety flags.

Code: `occlusion-core.js` (pure math + the verdict key/storage helpers,
`// @ts-check`, unit-tested by `tests/occlusion-core.test.js`) and, next to
`updateCulling()` in `index.html`, `_occlBegin` / `_occlEnd` (the per-frame
pass), `_occlDepthSelfTest`, and the device verification (`_occlVerify*`).
Browser differential: `tests/browser/occlusion-culling.mjs` (in `ci.yml`'s
browser-differential job).

Why not unconditionally on: every generated-fixture view is pixel-identical
with culling on and off, but the proof assumes the GPU interpolates depth per
MSAA sample. SwiftShader evaluates it at the pixel centre, and on real project
geometry that let a few edge pixels differ (section 4). So the match check runs
on the user's own device instead of only in CI.

## 1. What it does

For each frame that `tick()` is about to render anyway, right before
`renderer.render()`:

1. **Collect** visible layer-0 model units: a plain `Mesh` with an
   `expressId`, a whole `InstancedMesh`, or one `BatchedMesh` instance. A unit
   takes part only if its material is a built-in mesh material that is opaque,
   depth-writing and depth-tested with `LessEqual`/`Less`, and has nothing that
   discards, offsets or displaces fragments (`transparent`, `depthWrite:false`,
   `alphaTest`, `alphaHash`, `alphaToCoverage`, `polygonOffset`,
   `stencilWrite`, `wireframe`, displacement, transmission, a custom
   `onBeforeCompile`). Ghosted, x-ray, glass, IfcSpace rooms on layers 3/4,
   clash markers and overlays fail these tests generically, so they are never
   occluders and never culled. Objects with their own
   `onBeforeRender`/`onAfterRender`, children, skinning or morph targets are
   skipped, as is anything in the outline pass's `selectedObjects` and the
   hovered element. Each unit gets a screen rectangle and nearest NDC depth
   from its world AABB (centre/extent through the view matrix, grown by a
   float32 error bound).
2. **Rasterise occluders** (largest on screen first, adaptive triangle budget
   2k-60k aimed at ~3 ms) into a CPU coverage buffer of k x k pixel cells
   (grid about 320 x 180). Occluders already hidden by what is in the buffer
   are skipped.
3. **Test** each candidate rectangle (8x8-tile max, then a max-depth pyramid).
   Hidden units get `visible = false` + `userData._occlCulled = true`, or
   `setVisibleAt(i, false)` for batch instances.
4. Render, then **restore** every hide (`_occlEnd`, in a `finally`).

Nothing outside that one render call sees an occlusion-hidden mesh: hover,
ghost, reveal (`_ccHideOccluders`), raycasts, the magnifier, screenshot/BCF
snapshot renders. The three `_frustumCulled` readers (highlight outline,
fit-to-element, fly-to bounds) also accept `_occlCulled`, so the contract
holds if the restore is ever moved.

### The proof

A unit is hidden only if *every point* of its screen rectangle is covered by
one occluder whose nearest drawn surface there is nearer than the unit's
nearest point by more than the depth margin. Coverage is about whole cells,
not sample points.

* **Coverage of a cell by one occluder**: the cell square grown by `m` px
  touches none of the occluder's *boundary* edges and the cell centre lies in
  one of its triangles. A connected square that misses the union's boundary is
  wholly inside or wholly outside; the centre decides. An edge is *interior*
  only when the two triangles sharing it (same vertex positions bit for bit, so
  the GPU rasterises them watertight) both draw and lie on opposite sides of it
  on screen. Everything else is boundary: outlines, T-junctions, non-manifold
  edges, edges next to back-face-culled, near/far-clipped or sliver triangles.
  Seams between two different meshes are never covered, even when they abut
  exactly; the GPU does not promise them watertight.
* **`m`** = 2 x GPU sub-pixel snapping (`SUBPIXEL_BITS`, at least 1/32 px) +
  the float32 vertex-transform error projected to pixels. Occluders whose `m`
  would exceed 0.5 px are not used.
* **Robust triangles only**: an occluder triangle counts if its smallest
  altitude is at least `4m` px, so GPU and CPU agree on coverage and facing
  (Front/Back/DoubleSide and mirrored transforms honoured).
* **Depth bound** of a covered cell = max over the robust triangles touching
  the grown cell of min(plane maximum at the grown cell's corners, maximum of
  the triangle's part in the cell's row band), plus the float32 depth error.
  NDC depth is affine in screen space for a planar triangle.
* **Depth margin** `eps` = 2 x max(2^-20, 16 x 2^-DEPTH_BITS) in NDC.
* **Candidates the GPU would clip are never culled**: the rectangle must lie
  inside the viewport and the box between the near and far planes.
* **Clipping planes** (section plane/box, floor plan): an occluder counts only
  if its whole AABB is on the kept side of every active plane (global
  `renderer.clippingPlanes`, plus the material's planes when
  `localClippingEnabled`). Clipping only removes candidate fragments, so
  candidates need no restriction.
* **Chains are safe**: an occluder may itself be culled. At any sample the
  nearest occluder is never culled, and it is nearer than every culled one.
* **Precondition: per-sample MSAA depth.** Checked once by
  `_occlDepthSelfTest`, on the canvas's own sample count: a flat quad and a
  steep triangle that is behind it everywhere on its own surface. If any of the
  triangle's colour reaches the resolved image, the GPU extrapolates depth
  outside triangles and the pass does not run (`stats.why =
  'msaa-center-depth'`, `window._ccOcclusion.selfTest`).

### Frames where the pass does not run (draws everything, as before)

`stats.why` names the reason: `unverified` / `refused` (auto mode before or
after a failed device check), `detecting` (a clash-detection run is live), the
post-processing composer path (SAO/outline
re-render with override materials), `scene.overrideMaterial`, a pending
shadow-map update while a shadow-casting light exists (culled casters would
vanish from the shadow map), camera not on layer 0, an unknown projection
matrix shape, the failed depth self-test, or the adaptive skip (after a pass
that took >0.75 ms and culled <1% of candidate triangles, the next 8 rendered
frames skip it). An exception disables the pass for the session and logs
`[occlusion] disabled after error`.

### Render-on-demand

The pass only runs inside a frame `tick()` already decided to render, for that
frame's camera, visibility and materials, and is undone before the frame ends,
so there is nothing to invalidate later and nothing to go stale. Idle frames
stay idle: the browser test asserts 0 frames rendered in 1.5 s at rest, pass on
and off.

### Not done

* `InstancedMesh` is a candidate only as a whole (union of its instances'
  boxes), never an occluder.
* No near-plane clipping of occluder triangles: a triangle with a vertex in
  front of the near plane is dropped and its edges become boundary.

### 1b. Per-device verification (what "auto" means)

* **When:** after the model set changes (load/replace/remove), at idle
  (`requestIdleCallback` after a short delay; never while `_needsRender > 0`,
  while orbiting/walking/dragging a section, while a model loads, while
  detection runs, or with the tab hidden). One view per idle slice; the busy
  check runs before every slice, so a detection run that starts mid-check
  pauses it.
* **What:** the depth self-test first (refuse -> `msaa-center-depth`). Then the
  current scene from three views (the user's camera, a fit-all view and an
  eye-height interior view derived from the model bounds; cloned cameras, the
  user's camera never moves) is rendered twice into an offscreen render target,
  culled and unculled, and the read-back pixels must be identical (zero
  tolerance). The target has the canvas's drawing-buffer size and MSAA sample
  count, so rasterisation, coverage and depth testing are the same as on
  screen; colour is HalfFloat (when `EXT_color_buffer_float` exists) so tone
  mapping or 8-bit quantisation cannot hide a difference. Nothing is drawn to
  the canvas and nothing is invalidated.
* **Verdict:** every view identical and at least one element culled ->
  `verified` (culling active from the next frame that renders anyway). Any
  difference -> `refused` (`pixel-mismatch in <view> view`). A check that culled
  nothing proves nothing, so it stays `pending` and waits for the next model
  change. Verdicts are stored in localStorage `cc_occlusion_verdict`
  (registered in `storage-core.js` as `viewer-device`, derived) per key
  `gpu=<UNMASKED vendor / renderer, else VENDOR / RENDERER>|app=<CC_VERSION.v>|core=<hash of occlusion-core's source>`,
  newest 8 keys kept. A stored verdict is never re-checked automatically; a new
  app version or a changed core is a new key and starts `pending`.
* **Cost bound:** if the last frame's `render()` took more than half the
  300 ms slice budget, the check is deferred (backing off 15 s, 30 s, ... up to
  6 attempts) and stays `pending`; slices that overrun push the next slice out
  by 15 s. Full-size targets only: a downscaled target would not exercise the
  same coverage and sample positions.

### 1c. Detection never competes with the pass

`detectClashesAsync` counts its in-flight runs (`window._ccDetectionActive()`
is true while a run is live or `state.detecting` is set). `_occlBegin` returns
before any work with `why: 'detecting'` during a run, and the device
verification counts detection as busy. The clash engine itself never reads
mesh visibility: triangle extraction uses element geometry and matrices, and
neither `addons/wasm-engine.js`, `addons/local-engine.js`, `addons/tauri-bridge.js`,
the worker-pool payload builders nor the detection code read `mesh.visible`,
`getVisibleAt` or `_occlCulled` (`addons/visibility.js` reads only the *model*
`visible` flag from state). Hides are also restored before `render()` returns,
so a run that starts between frames can never observe one.

## 2. Why this approach

| Option | Verdict |
|---|---|
| A. GPU occlusion queries | Results arrive 1+ frames late. During orbit a stale result hides elements that just became visible (not "provably hidden"), and with render-on-demand there are no spare frames at rest to converge on. Rejected. |
| B. CPU coverage buffer for the frame being drawn | Exact by construction, no GPU readback or stall, works with MSAA, BatchedMesh, InstancedMesh, all render styles. **Built.** |
| C. WebGPU hi-Z | Whole-renderer rewrite (materials, post FX, clipping, addons). Not justified. |
| Worker / WASM rasteriser | A worker answer arrives a frame late (not provable for the current camera) and needs geometry copied or shared (no SharedArrayBuffer in production: no COOP/COEP). WASM could make the rasteriser ~2x faster; the cost is already bounded by the adaptive budget and the occluder early-out, so not worth a second implementation yet. |

## 3. Measurements (generated fixtures)

Environment: cloud sandbox, 4 vCPU, headless Chromium, **WebGL2 on SwiftShader
(software)**, canvas 1264x630, 4x MSAA. Triangle and draw-call counts do not
depend on the GPU; the times do, and another benchmark shared the CPU during
these runs, so treat every millisecond figure as an upper bound for the pass
and as meaningless for frame time. The fixture scenarios override the depth
self-test (`ignoreSelfTest`) to exercise the proof on SwiftShader; their
geometry has no steep sub-pixel slivers. Reproduce:
`node tests/browser/occlusion-culling.mjs out.json` (`CC_OCCL_LARGE=NxB` for a
bigger generated model, `CC_PROBE_FILE=/abs/file.ifc` for your own model).

All rows: **culled frame identical to unculled frame (0 px)**; a second
culled capture is identical too.

| Scenario / view | Triangles on / off | Draw calls on / off | Culled units |
|---|---|---|---|
| office: opening (fitAll) | 792 / 864 | 48 / 54 | 6 |
| office: in a room, +X | 642 / 714 | 37 / 43 | 6 |
| office: in a room, -X | 622 / 756 | 38 / 45 | 7 |
| office: in a room, +Z / -Z / inside the corridor wall | unchanged | unchanged | 0 |
| office: in a room, diagonal | 768 / 804 | 45 / 48 | 3 |
| office: from above | 780 / 864 | 47 / 54 | 7 |
| office: Hidden Line (FrontSide), X-ray, isolate, section plane x2, section box | unchanged | unchanged | 0 |
| office: facades hidden, opening | 792 / 864 | 48 / 54 | 6 |
| office: orthographic from above | 780 / 864 | 47 / 54 | 7 |
| office: floor plan | 896 / 908 | 58 / 59 | 1 |
| office: depth self-test honoured | pass refused (`msaa-center-depth`) | | 0 |
| batched (BatchedMesh): opening | 426 / 462 | 6 / 6 | 3 |
| batched: in a room +X / -X | 330 / 366, 298 / 366 | 5 / 5, 6 / 6 | 3, 4 |
| instanced (InstancedMesh columns): in a room +X / -X | 438 / 450, 418 / 450 | 24 / 25, 25 / 26 | 1, 1 |
| large (6 storeys x 3 bays, 553 elements): opening | 5700 / 7092 | 442 / 558 | 116 |
| large: in a room, +X | 1288 / 3856 | 100 / 314 | 214 |
| large: in a room, -X | 1044 / 4320 | 89 / 327 | 238 |
| large: in a room, diagonal | 1690 / 4630 | 126 / 371 | 245 |
| large: inside a wall, +X | 798 / 1998 | 70 / 170 | 100 |
| large: from above | 4050 / 7092 | 307 / 558 | 251 |

Large fixture, 48-frame orbit (mean per frame): 7036 -> ~4500 triangles,
553 -> ~350 draw calls. Pass cost at steady state 2-5 ms per view on this
contended software setup (first use in a view is higher: JIT, adjacency
build).

## 4. Real-model check (and why the default is verified-auto, not plain on)

The maintainer's own architecture models (private, not in the repo; figures
from them are deliberately not recorded here) were run through the same test
with `CC_PROBE_FILE`:

* Two of them render almost entirely with transparent source materials;
  nothing qualifies as an occluder, nothing is culled, frames identical. This
  is the intended outcome.
* On a large opaque one (BatchedMesh-heavy), with the self-test overridden,
  the pass removed a large share of submitted triangles in every interior view
  and from above, but two views first differed in a few edge pixels. Root
  cause, traced pixel by pixel (CPU raycasts, a 16-sample ID pass, per-element
  GPU depth readback, bisection of the culled set down to single elements):
  1. A candidate crossing the top frustum plane produced one fragment at depth
     0, far in front of its true depth. Fixed by never culling candidates that
     need clipping (rule above).
  2. With 4x MSAA only (identical without MSAA), elements entirely behind the
     occluder still won samples along their edges. Reproduced in isolation
     (flat quad + steep triangle behind it everywhere): SwiftShader evaluates
     depth at the pixel centre for partially covered pixels, extrapolating the
     triangle's plane, which is unbounded for steep triangles. Plain depth
     precision was measured and is fine (24-bit, resolves to 2^-23..2^-26 NDC).
     No margin can prove this away, so it became the self-test precondition.
* With the self-test honoured (the default behaviour), SwiftShader's verdict is
  `refused` and the pass never runs there. Hardware GPUs are expected to pass
  the self-test (per-sample depth is standard); whether they then cull is
  decided per device by the runtime check in 1b, not by this sandbox.

### Browser test coverage of the verification

`tests/browser/occlusion-culling.mjs` scenario `verify`: (a) on SwiftShader the
self-test refuses -> `refused`/`msaa-center-depth`, culling never runs, frames
identical; (d) the verdict is `stored` after a reload, and a different app
version is a different key (`pending`); (b) with the self-test overridden the
offscreen check passes -> `verified`, auto mode culls (6/6/7 elements in the
checked office views), frames identical, and the verdict survives a reload;
(c) an injected mismatch -> `refused`/`pixel-mismatch`, culling off, refusal
persists. Scenario `large` also runs detection with the pass forced on vs off:
every probe of the pass during the run reports `detecting`, the pass is back
afterwards, and the 143-clash list is identical on all 47 fields that are
stable between two identical runs (`id`, `createdAt` differ run to run).

## 5. Interface notes

* `window._ccOcclusion` (internal plumbing): `status()`, `mode`
  (`auto`/`force`/`off`), `setMode()`, `enabled` (culling active now),
  `setEnabled(bool)` (= force/off), `reverify({forget})`, `adaptive`, `stats`
  (last pass: ran/why, ms split collect/raster/test, cell size, triangle budget,
  occluders, candidates, culled, triangles, rejection reasons), `selfTest`, and
  test-only hooks `probe()`, `debug`, `debugKeep`, `triBudget`, `fixedBudget`,
  `ignoreSelfTest`, `injectMismatch`, `verifyBudgetMs`.
* `window._ccDetectionActive()`: true while a detection run is in flight.
* Opt an object out with `userData._occlNever = true`.
* `tests/browser/occlusion-probe.mjs` (the original measurement probe) still
  measures the share of submitted triangles that reach a pixel.
