# Occlusion (depth) culling — check and measurement

Status: **investigation only, nothing built.** Handoff question: are elements hidden behind
other elements skipped before the GPU draws them?

## 1. Code check — confirmed

`updateCulling()` (`index.html`, ~line 16611) tests each mesh's bounding sphere against the
camera frustum and a screen-size ratio. There is no depth or occlusion test:

```js
if(!frustum.intersectsSphere(tmpSphere)){ obj.visible = false; obj.userData._frustumCulled = true; return; }
var screenRatio = distSq > 0 ? (r * r) / distSq : 1;
if(screenRatio < LOD_HIDE_RATIO){ obj.visible = false; ... } else { obj.userData._frustumCulled = false; obj.visible = true; }
```

`LOD_HIDE_RATIO = 0.0000005` (line 16609). The render loop `tick()` (~16644) runs
`updateCulling()` at most once per 8 frames (`cullEvery`) and only when the camera
fingerprint changed (or `S._forceCull`), then calls `renderer.render(scene, S.camera)` (or the
composer). Nothing between those two reads depth.

Further facts from reading it:
- Meshes get `frustumCulled = false` (line 3677) so this manual pass is the only per-mesh cull.
- `BatchedMesh` batches are forced `visible = true` here (line 16618) and rely on Three's
  `perObjectFrustumCulled` (line 4614). They get no LOD-size cull from `updateCulling`.
- `_ccHideOccluders` / `_ccResolveOccluderHits` (~12907–12995) are the "reveal what hides this
  clash" feature: a raycast from the camera to a clash point that hides what it hits. It is
  user-triggered and not culling.
- `git log --all -i --grep=occlu` and a repo-wide grep find no commit or document about
  occlusion culling (the only "occlusion" hits are `addons/visibility.js` sight-line
  occlusion *rates* for clashes and an unrelated line in `AS_BUILT_DEVIATION.md`).

## 2. Measurement

Tool: `tests/browser/occlusion-probe.mjs` (measurement only, no app change). For each view it
(a) renders the app's own normal frame and reads `renderer.info.render.triangles`, then
(b) re-renders the same camera and visibility into an offscreen `WebGLRenderTarget` with a
per-element (and per-instance / per-batch-instance) id colour, reads the pixels and counts
the ids present. Triangles of elements with ≥1 pixel ÷ triangles the frame submitted for model
meshes = the visible share.

Sanity check: summed model-mesh triangles (858) vs `renderer.info` (864); the 6 extra are
non-model scene objects. The id pass reproduces the normal frame's visibility.

### Environment (be careful reading this)
- Machine: this cloud sandbox, 4 vCPU, headless Chromium 141, **WebGL2 via ANGLE/SwiftShader
  (software Vulkan), not a real GPU.** Timings from it mean nothing; triangle counts do not
  depend on the GPU.
- Viewport 1280×720 requested, app canvas 1264×630 (UI panels).
- Files: `tests/fixtures/office-architecture.ifc` + `office-mep.ifc` federated
  (33 + 16 elements, **858 model triangles total**).
- **Not measured: the maintainer's own project.** The file is not in this repo or sandbox.
  Run the probe on it (command below) and paste the output here.

### Results, office fixture

| View | Triangles submitted (`renderer.info`) | Model triangles drawn | Triangles of elements with ≥1 pixel | Ratio |
|---|---|---|---|---|
| Opening (fitAll) | 864 | 858 | 590 | 0.69 (30 of 49 elements) |
| Interior, centre, +X | 580 | 574 | 32 | 0.056 (1 of 32) |
| Interior, centre, +Z | 520 | 514 | 44 | 0.086 (2 of 27) |
| Interior, centre, −X | 600 | 594 | 32 | 0.054 (1 of 32) |
| Interior, offset, +X | 714 | 708 | 80 | 0.113 (5 of 39) |
| Interior, offset, −Z | 664 | 658 | 168 | 0.255 (9 of 34) |

### How far to trust this
- The fixture is **tiny** (858 triangles, 49 elements). It shows that the mechanism is real:
  inside a building most of what is submitted is not seen. It does **not** predict savings on a
  real model and nothing here shows a frame-time problem.
- In every interior view one or a few elements cover all 796,320 canvas pixels. That is
  plausible for a camera 1.6 m above the model's lowest point inside a small office, but I did
  not check which element it is (a floor or wall in front of the lens would exaggerate the
  unseen share). Treat the interior rows as an upper bound until verified on a real interior.
- The opening view (0.69) is the one that matters most for the default experience: about 31%
  of submitted triangles are unseen on this fixture.
- All objects were plain `Mesh`. The instanced and batched id paths are written but were not
  exercised by this fixture (`objectKinds` in the JSON shows 0), so they are untested.

### Reproduce / run on your project
```
CC_CHROMIUM_EXECUTABLE=<chromium> CC_BROWSER_OFFLINE_DEPS=1 \
CC_PROBE_FILE=/abs/path/project.ifc CC_PROBE_W=1920 CC_PROBE_H=1080 \
node tests/browser/occlusion-probe.mjs out.json
```
For a real GPU, run it with a headed/GPU Chromium and drop the SwiftShader flags in the script.

## 3. Options (do not build until the project measurement shows a large unseen share)

Precondition for any option: output must equal the uncull path at rest. A culled element is
hidden only if it is provably fully hidden, never "probably". Existing frustum and tiny-element
culls stay as they are.

| Option | How | Cost | Picture impact | During orbit |
|---|---|---|---|---|
| A. GPU occlusion queries (WebGL2 `ANY_SAMPLES_PASSED_CONSERVATIVE`) | Render bounding boxes of large, near occluded candidates against the depth of last frame's occluders; read results next frame | Extra draw calls per candidate; results arrive 1+ frames late; needs per-object hooks in a render path that has `BatchedMesh`, `InstancedMesh`, composer | A newly revealed element can pop one frame late. Conservative queries avoid false hides but cannot fix lateness. At rest the stable result equals the full render | Latency visible while orbiting fast unless culling is only applied to elements hidden for several frames and un-hides are immediate |
| B. CPU hierarchical depth buffer vs element bounds | Rasterise a low-res depth of big occluders (walls/slabs) on CPU, test each element's AABB against it | CPU per frame, grows with element count; JS only (no SharedArrayBuffer, no COOP/COEP in production) | Exact if tests are conservative (a box counts as hidden only if fully behind) | No lag; cost is paid every frame the camera moves; can run on the existing 8-frame cadence at the price of lag |
| C. WebGPU renderer | Compute-shader hi-Z two-pass cull like native engines | Very large change: all materials, postFX, batching, clipping, section tools, splat/tiles addons; browser coverage needs checking | Risk of visual differences across the whole app | Best behaviour, biggest blast radius |

Recommendation: do not start until section 2 is run on real project files. If the unseen share
is large *and* frame time is a measured problem, prototype B or a hybrid of A behind a
`safety-migrations.js` flag, default off, with a differential test that renders culled vs
uncull and requires identical pixels at rest. Do not touch `_needsRender` / `invalidate` or the
IFC loader.

Interaction notes for whoever builds it: `userData._frustumCulled` is read by hover, ghost and
reveal code (~13239, 13749, 13811) to decide whether a mesh was hidden by culling rather than by
the user, so an occlusion hide would need its own flag or must reuse that contract; `ghostOthers`
and section/clipping paths also write `.visible`.
