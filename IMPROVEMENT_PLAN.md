# ClashControl Improvement Plan — beat Solibri/Navisworks on honesty, noise, and feel

> Competitive analysis + prioritized roadmap, produced 2026-07-13 from a deep audit of
> this codebase (plus the Engine/Connector sibling repos) and mechanism-level research
> into Solibri, Navisworks, Revizto, BIMcollab, xeokit, ThatOpen, IfcOpenShell/ifcclash,
> Speckle, and buildingSMART IDS. Every code claim below was verified against source
> (file:line cited); load-bearing external claims were adversarially re-verified against
> primary docs/source. Wave 0 ships alongside this document; later waves are the roadmap.

## Where ClashControl actually stands

ClashControl already has the professional feature set:

- **Cross-run clash reconciliation** (`computeClashIdentityKey` `index.html:5580`,
  `mergeDetectionResults` `:5612`): sorted element-pair key (UniqueId → GlobalId →
  expressId) + 0.5 m grid cell, with a 300 mm spatial fallback. Status, AI fields,
  linked issue, first-seen and a stable number carry across re-runs, with delta chips
  and run history in the UI. This is comparable-or-better than Navisworks' GUID-only
  matching and is the half of "Revizto's loop" people pay for.
- **Clustering** (element-pair based), **BCF 2.1/3.0 export/import**, **discipline
  rules**, a **workspace-aware inspector** (`renderDetails` `:30810` shows different
  data in present/coordinate/review — most viewers don't), **measurement snapping**
  that exceeds the free-tool bar (vertex/midpoint/centre/edge/face + typed glyphs +
  loupe, `_ccComputeSnap` `:9228`), and a genuinely good **walk mode**.

What loses to Solibri/Navisworks today is not feature count. It is three things:

1. **Numbers that lie.** The clash `distance` is not a penetration depth (it is a
   tri-pair chord length with an AABB fallback, `:4095`/`:5209-17`). `minGap` is
   collected in the UI but never applied by any engine (phantom control). The local
   "exact" engine silently drops most rules (`addons/local-engine.js:586-622`) and so
   returns *less-filtered* results than the browser. The Quality Score excludes the
   BIM/ILS check families it sits next to (`addons/data-quality.js:1224-69`). BCF
   viewpoints are camera-only — no `<Components>`, so exported topics have no
   selectable elements in Solibri/BIMcollab (`:6432-48`, importer parses them `:5991`).
2. **Noise.** No default clash matrix or penetration floor → first runs on real
   federations produce thousands of hits. Industry practice (verified: Solibri matrix
   defaults, BIMcollab grouping, academic >50% grouping + ~17% filtering reductions)
   shrinks the *input* before detection and groups after it.
3. **Feel.** The orbit pivot never recenters to the clicked element — the code intends
   it but calls `sph.setFromVector3` on a plain object and swallows the TypeError
   (`:11090`). SAO and the good OutlinePass exist but are disabled outside walk mode
   (and walk's own activation self-defeats). Present-mode selection is inert.

Strategy: **fix honesty, cut noise, restore feel — and refuse bloat.**

---

## Wave 0 — Correctness: fix what's lying (ships with this document)

Each item is an independently committed, verified bug fix:

1. **Orbit pivot recenters to selection** — replace the dead `sph.setFromVector3`
   call (`index.html:11090`) with the inline spherical computation (the hand-rolled
   convention `x=r·sinφ·sinθ, y=r·cosφ, z=r·sinφ·cosθ` matches THREE.Spherical's).
2. **`minGap` works** — `isSoft` now requires the gap to sit within `[minGap, maxGap]`
   instead of only checking the upper bound, matching the UI's own "Soft clashes
   X–Y mm" framing. The type-pair memo and pair-result cache already key on a hash
   of the whole `rules` object, so they invalidate automatically on this kind of
   rules-shape change — no separate cache work needed.
3. **Local-engine rule parity (browser side)** — `_serializeForLocalEngine` now sends
   the full scalar rule set (excludeTypes, toleranceByTypePair, minOverlapVolM3,
   duplicates, includeSpaces, minGap) and pre-filters `IfcSpace` client-side so the
   "exact" engine is never less filtered than the browser even before the Python
   side reads these fields itself. It also fixes a real bug found while wiring this:
   `mode` was read from a field the browser's rules object never sets, so it always
   fell through to `'hard'` — a configured soft/clearance-only run silently executed
   as hard-only on the local engine. Mode is now derived the same way the browser
   engine branches (hard-only / hard+near-miss / soft-only). Semantic-filter
   (host/opening relationship skip) parity is **not** included — it depends on each
   model's `relatedPairs` map, which isn't part of the elements payload today; wiring
   it needs a payload-shape change plus new Python-side consumer logic, so it's left
   as a tracked gap rather than half-wired. The companion Engine-repo change (below)
   applies the newly-sent fields.
4. **Assignee/priority survive re-runs** — added to the preserved list in
   `mergeDetectionResults` (`:5651-74`).
5. **JS/WASM result parity** — WASM-returned hit points get the same
   point-in-AABB±10 mm validation as the JS path, so results no longer depend on
   whether the WASM accelerator loaded.
6. **Quality Score honesty** — the score now includes the BIM-basics and ILS check
   families (previously silently excluded), so the headline number reflects the panel.
7. **Render fixes** — hotkey `5` = wireframe (was a duplicate of xray; wireframe had
   no key), and the walk-mode postFX activation no longer self-defeats (style-effect
   ordering).
8. **Stable discipline colors** — color-by-discipline uses the semantic `DISC` palette
   (`:688`) instead of count-ranked palette indices, so structural is always the same
   color across sessions and federations.
9. **Docs tell the truth** — the Python local engine runs the *same* Möller tri-tri +
   BVH algorithm as the browser (faster: Numba JIT, multiprocess). The "true solid
   boolean ops" claim is corrected here and in CLAUDE.md/MEMORY.md until Wave 1
   actually ships boolean volumes.

**Companion change required in ClashControlEngine** (separate repo, documented here
because this repo's branch cannot carry it): accept and apply the newly serialized
rule fields in `engine.py`/`sweep.py` — excludeTypes, toleranceByTypePair,
minOverlapVolM3, includeSpaces (filter IfcSpace/IfcOpeningElement server-side),
duplicates, minGap. `mode` itself needed no server-side change — `engine.py` already
reads it correctly via `rules.get('mode','hard')`; the bug was entirely on the
browser side never setting it. All fields are read via plain `dict.get(...)` with
defaults (confirmed in `server.py`/`engine.py`/`protocol.py` — no schema validation
that would reject unknown keys), so this repo's newly-sent fields are safe against
older engine versions; parity means the Python side starts *applying* them. Semantic
filter parity would additionally need `relatedPairs` added to the payload shape and
new consumer logic — out of scope for this wave.

## Wave 1 — The triage funnel (Coordinate's core: 10,000 → dozens)

The engine already has the plumbing (`excludeTypePairs` `:5061`, `toleranceByTypePair`
`:5132`, `excludeTypes` `:4377`, `includeSpaces` `:4388`, semantic host filter
`:5140-53`, self-clash scoping `:4427-40`). This wave is defaults + one real geometry
upgrade + transparency. **Decision: the new defaults apply to everyone** — the funnel
makes every cut visible and reversible.

1. **Per-element discipline classification** (IfcType → STR/ARC/MEP/CIV buckets, model
   discipline as fallback). Also fixes the combined-model preset gap (a single IFC
   containing structure+MEP currently gets one per-model label → discipline presets
   find 0 pairs).
2. **Default clash matrix on the existing rule fields**: skip same-discipline pairs;
   exclude `IfcSpace` + `IfcOpeningElement` (Solibri's documented default); suppress
   same-system pairs (IfcSystem/pset), intra-assembly pairs (IfcRelAggregates), and
   insulation-touching-structure within tolerance.
3. **Matrix UI**: an N×N discipline grid with per-cell on/off + tolerance that reads
   and writes those rule fields. Presets become matrix presets.
4. **Real penetration depth (browser + Python, approximate)**: on a confirmed hit,
   collect the vertices of A inside B (ray-parity point-in-mesh against the existing
   BVH) and take the max distance to the other mesh's surface using the existing
   closest-point machinery. Replaces the chord-length `distance`. Enables the
   **hard-clash ≥ 10 mm default floor** (editable — magnitudes are practitioner
   convention, not a standard; the BEP owns the number).
5. **True intersection volume (Python exact tier)**: `manifold3d` (Apache-2.0) mesh
   boolean → intersection-solid volume + optional overlap solid for reports (Solibri
   "clash solid" parity). Degrades to item 4's depth on non-manifold input. Verified:
   no OSS tool (including current ifcclash, which uses OpenCASCADE tree booleans — not
   fcl/EPA) ships this; Navisworks reports depth only.
6. **Severity model**: discipline-weight × depth × volume × location; default sort.
7. **The funnel UI**: raw pairs → after matrix → after tolerance/exclusions → after
   grouping → issues, every count visible and clickable. Transparency is what makes
   coordinators trust auto-triage.
8. **Spatial sub-clustering**: distance-threshold union-find on clash points beneath
   the existing pair key (~1-2 m default; parity with ifcclash's OPTICS smart groups),
   so one long duct through five joists is one issue, and one pair clashing at two
   distant spots is two.
9. **One-click run**: "Run coordination check" = auto matrix + defaults + funnel; the
   current rules panel becomes the Advanced disclosure.

## Wave 2 — The review loop (clash-by-clash feel)

1. **Clash focus state**: select → tween-frame the pair → isolate pair + ghost rest
   (~10%) with distinct A/B colors → J/K next/prev (keys exist in `VirtualList`) →
   status hotkeys. One reversible state machine over the existing
   `ghostOthers`/`_highlightRefs`/fly-to primitives.
2. **Occluder-reveal toggle** — temporarily hide meshes on the eye→clash ray
   (Navisworks Auto-Reveal parity).
3. **Camera polish**: zoom-out honors the cursor (zoom-in already does, `:7251`);
   Shift+left-drag pan fallback (pan is middle-mouse-only, `:7158`); double-click =
   frame; optional inertia. The drive-forward zoom floor behavior stays.
4. **Edges + SSAO in normal viewing** — un-gate the already-built SAOPass/OutlinePass
   behind a capability-gated quality setting (default-off first release; SAO was
   deliberately disabled for blur — re-enable opt-in, without SMAA, verified on
   batched models), and add a "shaded + edges" style. No PBR work.
5. **Present-mode selection framing** — allow frame-on-click (fly gate `:11109`);
   present is currently inert on click.
6. **On-canvas color legend** (value • swatch • count; group data already computed at
   `:12870`) whenever color-by is active.

## Wave 3 — Interop that round-trips (BCF + assignment)

1. **BCF viewpoint fidelity** (the biggest audited gap): write `<Components>`
   (globalIdA/B + visibility/isolated sets), `<ClippingPlanes>` from section state,
   `<Coloring>`, `<OrthogonalCamera>` when orthographic, and `<Comment>` threads.
   Default export **BCF 2.1** (Solibri interop; keep 3.0 as option). The importer
   already parses Components — round-trip tests close the loop.
2. **Bake 3D screen-space markups into viewpoint snapshots** (compose the DOM overlay
   onto the canvas PNG) so redlines survive into BCF.
3. **Stamp/auto-assignment rules** (Revizto parity, cheap): per-project templates —
   discipline-pair × storey → assignee/priority — applied at merge time.

## Wave 4 — Find & scope

1. **Search sets**: saved re-resolving queries (type/property/classification/storey)
   usable as isolation, coloring, and **clash-matrix rows**. Wire the dead
   `REN_SELSET` reducer (`:1520`); add +/−/= set editing (Solibri basket).
2. **Navigator → real find**: match GlobalId and property values (today only
   name/ifcType/expressId, `:16672`); flat cross-model results; fix the unreachable
   200-per-node truncation (`:16859`); actions: isolate all / color all / save as set.
3. **Inspector**: click-to-copy IDs (GlobalId is shown but not copyable, `:31107`);
   property filter box; containment breadcrumb + hosted-elements (data exists in
   `extractSpatialHierarchy`/`childrenMap`); element-vs-element aligned diff (reuse
   `multiSel` + `PropBlock`).

## Wave 5 — Review-mode parity (checking)

1. **IDS conformance**: implement the four subtle rules naive checkers miss —
   ε=1e-6 combined relative+absolute equality tolerance with **exact** bounds; XSD
   datatype coercion and restriction-node gating by base type; the three-combination
   cardinality rule; IFC2X3↔IFC4 occurrence/type mapping with PredefinedType via
   type-object resolution — and run CI against the buildingSMART **250+ testcase audit
   suite**. "Passes the buildingSMART suite" is an advertisable claim no browser tool
   currently holds (ThatOpen's IDS component exists but its conformance depth is
   unverified).
2. **DQ re-run reconciliation**: clash-style identity (GlobalId × checkId) → new /
   persisting / fixed deltas + trend, reusing the clash reconciliation pattern.
3. **Severity overrides + threshold UI** (the check engines already accept overrides);
   lightweight saved check-profiles — explicitly *not* a Solibri ruleset editor.

## Wave 6 — Scale (only after correctness)

1. **Detection in a Web Worker** (typed-array transfer; main-thread fallback). Today
   detection is main-thread, single-core, chunked via setTimeout (`:5498-533`).
2. **Keep geometry/BVH caches across runs** — lifetime change only (the unconditional
   flush at `:5367`); no cache-key or serialization-format changes (see guardrails).
3. **BVH per unique geometry shared across instances** (engine-side only).
4. **FastNav-style quality degradation during camera motion** (opt-in; note xeokit's
   actual defaults: canvas downscale is off by default, edges/SAO-hiding on).
5. Sweep-and-prune allocation fixes (swap-remove active list; streamed pair
   processing instead of materializing the full candidate array).

---

## History-informed guardrails (do not repeat past error/redo chains)

Mined from CHANGELOG/MEMORY — each rule maps to a documented multi-hotfix saga:

- **Never touch renderer exposure / tone-mapping / ColorManagement values.** The r180
  bump day produced a ×π lighting revert, three exposure re-tunes, a disabled
  ColorManagement, and a production-crashing sRGB recursion. All render work is
  additive passes/overlays, capability-gated, default-off first.
- **Every per-mesh scene sweep must handle BatchedMesh/InstancedMesh**
  (`userData._isCCBatch`) — the chunk-merge removal and "sections cut nothing on
  batched models" lessons. Applies to edges overlays, legend color sweeps, ghosting.
- **No hand-rolled geometry merging; no render-path memory experiments** (chunk-merge
  was removed wholesale after four identity-feature breakages; Free-RAM was excised).
  Any future batching goes through the BatchedMesh phase plan with its CI gates.
- **Don't touch geo-cache keying/serialization** (`_instKey` spike saga: five failed
  hotfixes in one day; root cause was a scale-invariant hash found much later).
- **Detection has stateful caches that go stale silently** (type-pair memo → the
  instant-0 regression; the stall watchdog). Any rules-shape change versions or
  invalidates the type-pair memo and pair cache, and lands with `_ccBenchEngine`
  parity checks. One fix per commit so regressions bisect in minutes.
- **One-way doors stay shut:** view-cube quaternion inversion, coplanar-touch policy
  (touching ≠ clashing), walk pointer-lock user-gesture requirement, IFC unit
  `geoFactor`, service-worker `/api/*` exclusion, drive-forward zoom floor.

## Explicitly not building (bloat evaded)

Sample/demo model (owner directive) · ML clash-relevance filtering (deterministic
rules already deliver the documented >65% reduction) · clearance tests on by default
(order-of-magnitude count multiplier) · VR/avatar/gamepad walk expansion · PBR /
realistic-rendering work (near-zero coordination value) · XKT/DTX/Fragments format
adoption (build-pipeline mismatch; borrow the runtime tricks only) · Pyodide/IfcTester
port (a conformant pure-JS IDS engine is lighter) · full Solibri ruleset editor · ITO
quantity takeoff (at most "sum a quantity over selection") · pset editing ·
bcf-js dependency (Node-flavored, archived) · server-side streaming.

## Verification strategy

- **Engine**: unit tests with analytic solids (offset cubes, pipe-through-slab)
  asserting penetration depth within tolerance and funnel counts; `_ccBenchEngine`
  JS-vs-WASM parity including hit-point equality; a local-vs-browser same-rules →
  same-result-set test; the existing Playwright smoke (real WASM pipeline) extended
  to cover matrix defaults.
- **IDS**: CI job running the buildingSMART audit corpus with a pass-rate gate.
- **BCF**: CC→CC round-trip asserting Components/ClippingPlanes/ortho survive; manual
  import checks into BIMcollab Zoom and Solibri Anywhere.
- **UX**: Playwright — click → pivot recenters; J/K focus loop isolates/ghosts;
  legend renders; present-mode click frames.
- **Perf**: `_ccRenderReport()` and detection wall-time before/after on the known
  7-model federation lag case.
