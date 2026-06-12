# As-Built Verification — Point Cloud vs BIM Deviation

Status doc for the "scan-vs-design deviation" capability: what exists today,
what's a build, and the product framing that should drive it. Written
2026-06-11. This is a roadmap/scope note, not a description of shipped
behaviour — see the Status table for what actually runs.

> **One-line summary:** ClashControl does mesh-vs-mesh clash (solid). It does
> NOT yet do true point-cloud-vs-mesh **surface** deviation. What exists is
> point-cloud↔IFC *alignment* plus a *bounding-box* proximity heatmap. True
> surface-accurate deviation is a contained build (the BVH + triangle soup it
> needs already exist and are exposed), but the part a customer pays for is the
> **dossier output**, not the geometry.

---

## 1. Status — what actually runs today

| Capability | State | Where |
|---|---|---|
| Point-cloud↔IFC **rigid alignment** (3-point manual, closed-form) | ✅ works | `addons/align.js` (`_ccAlignStart`, `_finishAlignment`) |
| **ICP refinement** of the alignment | ✅ works, but snaps to element **centroids**, not surfaces | `addons/align.js` `_ccAlignRefineICP` |
| **Deviation heatmap** (recolour cloud green→amber→red) | ⚠️ works but **bbox-distance only** | `addons/align.js` `_ccDeviationCompute`, `_pointToBoxDistance` |
| Hotspot → auto-issue + PDF/snapshot | ✅ works | `addons/align.js` `_ccDeviationCreateIssues` |
| **True point-to-surface distance** (point → nearest triangle) | ❌ not built — deferred to "Phase 2" in code comment | `addons/align.js:~307` |
| Point clouds / splats as clash-engine input | ❌ excluded by design (display-only) | `addons/pointcloud.js`, `addons/splat.js` |

**The catch:** the heatmap measures each scan point's distance to the nearest
IFC element's **axis-aligned bounding box**, not to the mesh surface. A point
inside a wall's bbox but far from any face reads "close" (green); thin/angled
elements read loose. Fine for a screenshot, not for a measured deviation number.
The code says so directly (`align.js`):

> "Triangle-accurate distance is more expensive and lands in a later phase;
> bbox-distance already gives a useful first pass."

**Honest external claim today:** "alignment + a first-pass proximity heatmap."
NOT "surface-accurate as-built deviation." The LinkedIn line *"ondersteunt al
pointcloud en Gaussian Splat, alleen nog niet volledig getest"* is true for
*display*; for *deviation measurement* it overstates — surface deviation isn't
built-but-untested, it's not built (the bbox proxy is).

---

## 2. Reuse vs build — what the real kernel needs

Audited 2026-06-11. The expensive scaffolding already exists, so this is a
contained build, not research.

| Component | Status | Evidence |
|---|---|---|
| Custom BVH (JS + Rust, median-split, 4-tri leaves) | ✅ reusable | `index.html:~3828` `_buildBVHNode`; `engine/src/bvh.rs`; exposed via `window._ccGetBVH(el)` |
| World-space triangle soup per element (flat xyz, cached) | ✅ reusable | `index.html:~3696` `_getWorldTris`; exposed via `window._ccGetWorldTris(el)` |
| Spatial hash (broad-phase radius culling) | ✅ reusable | `engine/src/spatial_hash.rs` |
| Rust/WASM engine to extend | ✅ reusable | `addons/wasm-engine.js`, `engine/src/lib.rs` (`mesh_intersect`, `mesh_min_distance`) |
| Point cloud data (THREE.BufferGeometry position attr) | ✅ reusable | `addons/pointcloud.js`; iterate `geom.getAttribute('position').array` in 3s |
| Heatmap UI + stats + issue/PDF pipeline | ✅ reusable | `addons/align.js` `_ccDeviationCompute` / `_ccDeviationCreateIssues` |
| **BVH closest-point query** (distance-bounded descent) | ❌ build | BVH is intersection/overlap-only today — no nearest-triangle descent |
| **Point-to-triangle closest-point primitive** (barycentric clamp) | ❌ build | none exists anywhere (`closestPointToTriangle`, `barycentric` → no hits) |
| **Rust kernel** `point_cloud_to_mesh_distance(...)` | ❌ build | `mesh_min_distance` is nearest-**vertex**-to-vertex only, not surface |

Note: `mesh_min_distance` (Rust, `engine/src/lib.rs`) takes two flat **vertex**
arrays and returns nearest-vertex distance via spatial hash — it is NOT
point-to-surface and cannot be used as-is for deviation.

---

## 3. Build plan

### Phase 1 — the measurement (~1 week). Makes the claim honest.
1. **Point-to-triangle closest-point primitive** — barycentric + edge/face
   clamp (~100 lines, textbook).
2. **BVH nearest-triangle query** — distance-bounded descent that prunes nodes
   farther than the current best (~200 lines; reuses existing node struct).
   This is the one genuinely new algorithm.
3. **Rust kernel + JS wrapper** — export
   `point_cloud_to_mesh_distance(points, tris, indices, maxDist)`, JS fallback
   in the existing `wasm-engine.js` pattern; reuse the spatial hash for
   broad-phase culling.
4. **Swap the proxy** — replace the `_pointToBoxDistance` call in
   `_ccDeviationCompute` with the real kernel. Heatmap, stats, and the
   hotspot→issue pipeline then show true surface distance for free.

Output: real **unsigned** surface-deviation heatmap. Enough to demo and to make
the external claim accurate.

### Phase 2 — make it trustworthy for QA (~1–2 weeks). The part a client buys.
Raw distance is not a deliverable. Reframed toward the **dossier** (see §4), not
geometry polish.
5. **No-correspondence cutoff** — max search radius so a scan point with no
   design surface nearby (scaffolding, parked car, tree, neighbour's wall) reads
   *unmeasured*, not huge-red. Without this the heatmap lies on every real scan.
6. **Coverage / occlusion map (inverse)** — design surfaces with no scan points
   near them are *unverified*, not "zero deviation." Mesh-side pass. This is
   what stops you certifying a wall the scanner never saw.
7. **Noise filter** — statistical outlier removal (k-NN distance percentile) so
   sensor speckle doesn't dominate the max/mean stats in a report.
8. **Signed distance** — too thick / too thin / out of plane. Needs consistent
   triangle normals; IFC meshes aren't always watertight, so do after unsigned.
9. **Surface-grade ICP** — current ICP snaps to element centroids (too coarse
   for mm deviation). The Phase-1 kernel doubles as point-to-plane ICP, so one
   build upgrades heatmap + ICP + signed map (three payoffs).

### Phase 3 — know your error bars (~few days). Before promising numbers.
10. **Validate against a known reference** — scan a measured offset / controlled
    test so you can state accuracy. Set expectations vs IFC **tessellation**:
    the design "surface" is itself faceted, so deviations below tessellation
    tolerance are noise, not findings. Know that number before quoting "X mm."

**Effort summary:** ~1 week to a credible demo; ~3–4 weeks to client-grade.
The risk isn't the kernel (bounded, reuses the BVH) — it's the messy scan-side
reality (registration quality, occlusion, noise, IFC mesh fidelity). That's the
"scan-side geometry problem we don't currently own," and it lives in Phase 2.

---

## 4. Product framing — sell the outcome, not the geometry

Target user: Dutch **kwaliteitsborger** (quality assurer under the **Wkb**),
not a designer. Their job is **risk-based inspection during construction against
the Bbl**, ending in the **opleverdossier**. They do not want "a scan with clash
detection" (a design term, not their job).

**Implication for the product:** the deviation geometry is a *means*; the
product is a **Bbl-risk-mapped, timestamped, traceable conformance record** that
drops into the opleverdossier. ClashControl already owns most of that machinery
— issues, BCF, PDF reports, snapshots, shared projects. The scan deviation is
one *evidence source* feeding a dossier workflow we're ~two-thirds built for. So
Phase 2 should prioritise the **dossier/report/provenance/risk-mapping** layer
over signed-distance and ICP polish.

**The boundary we must hold (or lose the Borger on project one):** a scan
verifies **geometry**; most of a risk file is **performance**.

- **Geometrically checkable from a scan (the wedge):** free passage / door
  widths, corridor & escape-route widths (vluchtroutes), ceiling/room heights
  (verblijfsgebied), stair geometry (aan-/optrede, headroom), balustrade /
  valbeveiliging heights (≥1.0 m fall protection — geometric, safety-critical,
  pure liability), floor levels & flatness, shaft/riser positions, opening
  positions/sizes, thresholds (drempels) for accessibility.
- **NOT checkable from a scan:** WBDBO fire resistance, structural capacity,
  BENG/energy, ventilation rates, sound insulation, material specs. A scan shows
  a duct is *there* and the right size; not that it moves enough air.

Truthful claim: **"objective geometric conformance evidence for the geometric
subset of your risk items,"** NOT "Bbl compliance." Conflating those loses trust.

**Discovery questions (sell time / liability / dossier):**
- *Time:* how much of your hours are site measuring + write-up vs desk review?
  Which checks are still tape-measure-and-photo?
- *Liability:* at sign-off (verklaring), what are you most exposed on that your
  current evidence doesn't cover? Would a timestamped geometric as-built record
  shrink that?
- *Dossier:* how do you assemble the opleverdossier today — where's the manual
  pain? Would pre-collated, risk-item-tagged geometric evidence cut assembly
  time?
- *Sizing:* on a typical project, what share of your risk items are geometric vs
  performance? — this number sizes the wedge and says feature-vs-business.

**What this means for the build:** Phase 1 (the kernel) is the evidence engine
and still has to exist. Phase 2's headline is the **dossier layer** — deviation
findings → issues tagged to Bbl risk items → timestamped, traceable PDF/BCF that
slots into the opleverdossier — not signed-distance/ICP. The geometry is just
what makes the evidence credible.

---

## 5. Related code pointers
- `addons/align.js` — alignment, bbox deviation heatmap, ICP, issue creation
- `addons/pointcloud.js` — LAS/PLY/PCD/XYZ load as display-only reference layers
- `addons/splat.js` — Gaussian splats, display-only
- `index.html` `_getWorldTris` / `window._ccGetWorldTris(el)` — world-space tri soup
- `index.html` `_buildBVHNode` / `window._ccGetBVH(el)` — custom BVH
- `engine/src/{bvh,spatial_hash,lib}.rs` — Rust clash/distance kernels
- `addons/wasm-engine.js` — WASM wrapper + JS fallback contract
