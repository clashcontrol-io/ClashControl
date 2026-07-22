# ClashControl v7 Release Validation Plan

> Built 2026-07-22 from an external re-review of **v7.2.7 / `b195655`**, with every
> load-bearing claim re-verified against source this session (file:line cited). This
> plan is deliberately critical of the review as well as the code: two of the review's
> claims did not survive verification and are corrected below, so we don't spend a
> release cycle chasing a non-issue. It complements `IMPROVEMENT_PLAN.md` (Waves 0–6)
> and does not restate it — where a task is already tracked there, this doc links to it
> and adds the acceptance gate.

## TL;DR

The review's headline is right: **v7.2.7 is not a simple browser experiment anymore**
(worker IFC path, Rust/Wasm broad phase, chunked detection, BCF component/coloring
export, lazy compact candidate materialization are all real), **but it is not yet
release-validated.** The single real release blocker is **local-engine result parity** —
under *default* settings the local ("exact") engine can return a materially different
result set than the browser, and the capability gate does not catch it.

Two review claims are **overstated or wrong** and are downgraded:

- **CI is green.** The review says the differential/smoke/test checks are "configured
  but not evidenced green." Verified false: CI run `29866854575` on the functional
  commit `e0e356b` has `test` ✅, `browser-smoke` ✅, and `browser-differential` ✅
  (both the *IFC worker vs. main-thread-fallback* and *WASM vs. JS broad-phase*
  differentials executed and passed). The reviewer inspected the **tip** commit
  `b195655`, which is a bot version-bump that the workflow's `changes` gate
  intentionally skips — so "no runs on the bump commit" was misread as "no evidence."
  The remaining work here is a **branch-protection / required-checks** hardening task,
  not a "restore Actions" task.
- **Defaults line citation.** The review cites `index.html:1008` for the browser
  default rules; that line is the NL "run detection" *offer* stub. The real
  `INIT.rules` defaults are at **`index.html:1274`** (`useSemanticFilter:true`,
  `excludeSameDiscipline:true`, `changeAware:false`, `excludeTypePairs:[]`). The
  substance (those *are* the shipped defaults) holds; the citation was wrong.

Everything else in the review verified as real. Details per item below.

---

## Verification ledger (what I actually checked)

| # | Review claim | Verdict | Evidence |
|---|---|---|---|
| 1 | Capability gate only rejects `duplicates` + over-epsilon `minOverlapVolM3` | **CONFIRMED** | `addons/local-engine.js:767-776` — gate checks exactly those two |
| 2 | `useSemanticFilter` / `excludeSameDiscipline` are browser defaults, applied neither locally nor server-side | **CONFIRMED** | defaults `index.html:1274`; `_serializeForLocalEngine` never sends `useSemanticFilter`/`excludeSameDiscipline` (`:656-670`); `_applyClientSideRuleFilters` never re-applies them (`:787-825`) |
| 3 | Model selectors diverge: browser resolves arrays/`disc:`/`tag:`/names/substrings; engine exact-matches `model_id` | **CONFIRMED** | browser `pick()` `index.html:6251-6287`; engine `elements_a = [e for e in all_elements if e['model_id'] == model_a]` `engine.py:240-248`; addon forwards `modelA/modelB` raw `local-engine.js:657` |
| 4 | Per-type tolerance > global `maxGap` silently under-detects; only a warning | **CONFIRMED** | `local-engine.js:810-820` — tighten-only, `console.warn` when wider |
| 5 | `excludeTypePairs` test uses an object; real representation is an array | **CONFIRMED + worse** | `INIT.rules` default is `excludeTypePairs:[]` (`:1274`) but `_applyClientSideRuleFilters` indexes it as a map `excludeTypePairs[key]` (`:807`) — array vs. map is inconsistent *inside the app*, not just in the test |
| 6 | `changeAware` and custom `disciplineMatrix` unsupported on local path | **CONFIRMED** | neither serialized nor re-applied; `disciplineMatrix` used only browser-side (`index.html:19800-19810`, `:6365`) |
| 7 | Compact candidate diagnostics still report `96 bytes × candidates` | **CONFIRMED** | `_CANDIDATE_EST_BYTES = 96` (`index.html:6100`) multiplied by candidate **count** at `:6464` and `:6972` regardless of representation; compact Wasm path is ~12 B/pair (3 ints) + element table — overstates ~8× |
| 8 | Shared-project conflict check is read-then-unconditional-upsert, not atomic CAS | **CONFIRMED** | `api/project.js:234-253` — `SELECT ... updated_at`, JS timestamp compare, then unconditional `INSERT ... ON CONFLICT DO UPDATE`; two writers can both pass the check |
| 9 | BCF import reads only topic + component GUIDs (no cameras/clipping/comments) | **CONFIRMED** (per review's cite `index.html:7327-7385`) | — |
| 10 | No real IFC corpus registered; 500 MB claim unevidenced | **CONFIRMED** | `tests/fixtures/CORPUS_MANIFEST.md` "No real corpus files are registered anywhere"; only synthetic + two smoke IFCs present |
| 11 | IDS workflow is `continue-on-error` (informational, not a gate) | **CONFIRMED** (per review's cite) | — |
| 12 | CI differential "configured but not evidenced green" | **REFUTED** | run `29866854575` (commit `e0e356b`) — all 4 jobs `success`, differential steps ran |
| 13 | Local-engine mm conversion fixed | **CONFIRMED** | `IMPROVEMENT_PLAN.md` Wave 0 item 10; `_clashFromEngineResult` no longer `*1000` |

The nuance the review misses, and which shapes P0: **items 2 and 6 split into two
classes.** `excludeSameDiscipline`, `disciplineMatrix`, and `changeAware` are all
recoverable **client-side** from data already on each clash object
(`disciplines[]`, `elemAType/elemBType`, prior-run hashes) — no Engine change needed.
Only `useSemanticFilter` genuinely needs a payload-shape change (it depends on each
model's `relatedPairs` map, absent from the elements payload) — so for that one, the
honest short-term move is **fail-closed**, not half-wire.

---

## Priority plan (gated)

Each item has a binary acceptance gate. Nothing ships as "validated v7" until P0 is green.

### Implementation status (2026-07-22)

Landed this session (ClashControl PR #701, ClashControlEngine PR #26):

| Item | Status | Where |
| --- | --- | --- |
| **P0.1** model-selector normalization | ✅ done | `_ccResolveModelScope` (hoisted, shared) + `_normalizeModelScope`; `'all'`\|single-id\|fail-closed |
| **P0.2** discipline parity | ✅ done | local path re-applies the shared `_ccMatrixSkipsSameDiscipline`; per-element discipline in `_clashFromEngineResult` |
| **P0.3** changeAware / semantic fail-closed | ✅ done | gate; semantic only when `excludeSelf` off (default runs stay local) |
| **P0.4** wider-than-maxGap tolerance | ✅ done | gate fails closed; tighten case still recovered |
| **P0.5** `excludeTypePairs` array vs map | ✅ done | consumed as a Set from the array; legacy-object fallback |
| **P0.6** golden parity suite | ◑ unit layer done | `tests/local-engine-parity.test.js` (11-ruleset matrix + anchors); **e2e geometry fixture still open** |
| **P0-infra** required CI checks | ☐ open | CI runs green today; branch-protection needs repo-admin |
| **P1.1** engine capability negotiation | ◑ engine half done | `/status` now advertises `protocolVersion` + `capabilities` (Engine PR #26); **browser consumer still open** |
| **P1.3** compact-candidate byte accounting | ✅ done | `_candidateSetBytes` (eager 96 B vs compact 12 B/pair + item table); report gains `candidates_representation` |
| **P5.1** atomic issue-sync CAS | ✅ done | `api/project.js` single-statement `ON CONFLICT DO UPDATE ... WHERE`; conflicts from `RETURNING`. Live-DB concurrency test still needs Postgres (node harness has none) |

**P0.1–P0.5 detail.** The local ("exact") engine no longer silently returns a
different result set than the browser: selectors resolve to what the engine can address
(or fall back), the shared discipline-core governs both engines, `changeAware`/semantic
fail closed when they'd change the result, wide per-pair tolerances fall back, and
`excludeTypePairs` actually filters. Tests: `local-engine-units.test.js` 13→27,
`local-engine-parity.test.js` (13 new), full suite **713 green**; `index.html` main
script re-parses clean.

**Still open — deliberately not rushed** (see the priority table below for the full
plan): P0.6 end-to-end geometry fixture (needs Playwright + the Python engine); the
browser half of P1.1 (read `/status` capabilities to drive the gate — changes no
behavior until the engine grows capabilities, so low-urgency); **P1.2** engine-side
intersection volume + `relatedPairs` semantic filtering (geometrically sensitive — the
real fix behind P0.3/P0.4's fail-closes); **P2** a legally-usable real corpus (needs
licensed IFC files — cannot be produced in this environment); **P3** malformed-IFC
robustness (touches the IFC loader, which CLAUDE.md flags as high-care); **P4** BCF
import fidelity + IDS gate (needs external round-trip tooling to validate); and
**P0-infra / P5.2** branch protection + `index.html` extraction (repo-admin / large,
respectively).

### P0 — Local-engine correctness parity  *(release blocker)*

The local engine must **never silently return a different result set than the browser**
for a ruleset it claims to handle. Two ways to satisfy that: honor the rule, or
fail-closed to the browser engine with a visible reason. No silent divergence.

**P0.1 — Normalize model selectors before the engine sees them.**
The addon forwards `rules.modelA/modelB` raw (`local-engine.js:657`); the engine only
understands `'all'` or an exact `model_id`. Resolve selectors browser-side (reuse the
same `pick()` logic as `index.html:6251`) into concrete `model_id` lists, and send the
engine an explicit id set — OR fail-closed when the resolved scope isn't expressible as
what the engine accepts. Today a named/`disc:`/`tag:`/array/substring scope returns a
**silent zero** from the local engine.
*Gate:* a scoped run (`disc:MEP`, a model name, a substring) returns the **same pair
identities** on both engines, or falls back to the browser with a toast — never `0`.

**P0.2 — Recover the client-side-recoverable default rules.**
Add `excludeSameDiscipline`, `disciplineMatrix`, and `changeAware` to
`_applyClientSideRuleFilters` (`local-engine.js:787`), using the `disciplines[]`,
`elemAType/elemBType`, and prior-run-hash data already present. These are on by default
(`excludeSameDiscipline:true`), so today a **default** local run over-reports.
*Gate:* browser and local return identical pair identities + types on `INIT.rules`
defaults over a 2-model federation.

**P0.3 — Fail-closed for `useSemanticFilter`.**
It's a default (`true`) and cannot be recovered without `relatedPairs` in the payload.
Until the payload/engine change lands (P1.2), the gate must **reject** the local path
whenever `useSemanticFilter !== false` and the model actually carries host/opening
relationships — fall back to the browser engine with a reason.
*Gate:* a default run on a model with door-in-wall openings does not route to the local
engine (or routes only after semantic parity ships); no over-report.

**P0.4 — Reject or widen for per-pair tolerance > global `maxGap`.**
Today it warns and under-detects (`local-engine.js:810-820`). Either fail-closed for
that ruleset, or raise the engine run's global `maxGap` to `max(maxGap, max per-pair
tolerance)` and tighten client-side afterward (the tighten path already exists).
*Gate:* a ruleset with any `toleranceByTypePair[k] > maxGap` returns the same soft-clash
set as the browser, or falls back — never silently drops those pairs.

**P0.5 — Reconcile `excludeTypePairs` representation (array vs. map).**
`INIT.rules` ships `excludeTypePairs:[]` (array, `:1274`) but the client filter indexes
it as a map (`excludeTypePairs[key]`, `:807`), and the unit test uses an object. Pick
one canonical shape (recommend: normalized `Set`/map of sorted `"A:B"` keys), converge
the browser engine, the client filter, and the tests on it.
*Gate:* one representation across `INIT`, browser engine, `_applyClientSideRuleFilters`,
and tests; a contract-realistic test (array-shaped input as the app actually produces)
proves the filter fires.

**P0.6 — Golden parity suite.**
A same-rules → same-result-set test asserting **identical pair identities and types**
between browser and local engines, run per-rule and on defaults. This is the standing
gate that keeps P0 from regressing (extends `IMPROVEMENT_PLAN.md` Verification strategy's
"local-vs-browser same-rules" line into a real fixture-backed suite).
*Gate:* suite green in CI; every individual rule + the default set has a parity case.

### P0 (infra) — Make CI a merge gate  *(downgraded from review, but do it)*

CI already runs green (run `29866854575`); the gap is that it isn't **required**.
Add branch protection on `main` requiring `test`, `browser-smoke`, and
`browser-differential` before merge, and add the **P0.6 parity suite** to the required
set. No "restore Actions" work — they run today.
*Gate:* a PR cannot merge to `main` with any of those checks red or missing.

### P1 — Engine capability negotiation + observability

**P1.1 — `/status` capability/protocol version.**
Add a `capabilities`/`protocolVersion` field to the engine's `/status`
(`ClashControlEngine`, `server.py`) so the browser can *negotiate* instead of
hand-maintaining the gate snapshot (`IMPROVEMENT_PLAN.md` Wave 0 already flags this as a
hand-maintained snapshot). Old engines → explicit browser fallback; new engines →
advertise which rule fields they honor.
*Gate:* an engine without the field triggers browser fallback; one advertising a rule is
allowed to run it and passes the P0.6 parity suite.

**P1.2 — Engine-side rule support** (`ClashControlEngine`, separate repo/branch).
Apply the serialized-but-ignored fields server-side — `excludeTypes`,
`excludeTypePairs`, `toleranceByTypePair`, `duplicates`, `excludeSelf`, and
`minOverlapVolM3` (needs real intersection-volume, currently always `None`) — plus
`relatedPairs`-driven semantic filtering (unblocks P0.3). Ordered by parity impact.
*Gate:* each newly-supported field passes the golden parity suite against a
capability-advertising engine.

**P1.3 — Correct the compact-candidate byte accounting.**
`_CANDIDATE_EST_BYTES` is applied to candidate count at `:6464` and `:6972` for both
representations. Distinguish eager-JS (~96 B/candidate) from compact-Wasm (~12 B/pair +
one-time element table) in the perf report and any memory warning, and benchmark the
`.at()` per-access object churn (`_candidateAt` `:5857`) so the compact path's lower
peak isn't paid back in GC time.
*Gate:* the perf report shows distinct eager vs. compact byte figures; a bench shows
compact peak-memory down without materially higher GC time.

### P2 — Real corpus + lifecycle evidence  *(precondition for any "500 MB" claim)*

Populate a **legally-usable private** corpus at 50 / 150 / 300 / 500 / 750+ MB and
publish anonymized per-model metric artifacts (element count, load wall-time, peak RSS,
detection time). Add a **five consecutive load/remove cycle** test (the manifest notes
only load-cancel-load + removal exist today).
*Gate:* on a declared reference machine — no crash, responsive cancellation, exact
detection parity vs. browser, bounded retained memory across five cycles. Only then may
docs/marketing claim "500 MB support." Until then, strike the claim.

### P3 — Malformed-IFC robustness

Add corrupt/partial IFC fixtures and structured per-element warnings so one bad entity
can't abort a load. Surface loaded / skipped / error counts in UI + reports.
*Gate:* a fixture with one corrupt entity loads the rest; counts are visible.

### P4 — BCF round-trip + IDS ratchet

Complete BCF **import** for cameras, clipping planes, and comment threads (export already
does Components/Coloring/OrthogonalCamera per Wave 3); schema-validate 2.1/3.0; test
external round-trips (Solibri Anywhere, BIMcollab Zoom). Ratchet the IDS workflow from
`continue-on-error` informational to a **regression gate** (`ids-conformance.yml:28-40`).
*Gate:* CC→CC round-trip preserves viewpoint state; representative files open correctly
in Solibri/BIMcollab; an IDS regression fails CI.

### P5 — Storage atomicity + (deferred) modularization

**P5.1 — Atomic conflict update.** Replace the read-then-unconditional-upsert in
`api/project.js:234-253` with a single conditional statement — an `INSERT ... ON CONFLICT
DO UPDATE ... WHERE shared_issues.updated_at = <expected>` (or a CTE returning the
rejected rows as conflicts) so the compare-and-swap is atomic in one round-trip.
*Gate:* a concurrent-write test (two simultaneous PUTs on the same issue) proves no lost
update — the loser is reported in `conflicts[]`, not silently overwritten.

**P5.2 — Incremental `index.html` extraction** — only behind equivalence tests, one
module at a time (see `REDUCER_DECOMPOSITION_PLAN.md`). Not a release blocker.
*Gate:* each extraction causes zero behavioral drift (differential/smoke/parity green).

---

### P6 — Memory architecture (residency ledger, geometry handles, bounded detection)

Built 2026-07-22 from an external re-review of `main` at `f4733d`/v7.3.0, after this
session's own Park/Auto-park work (P702/P703 — see MEMORY.md). Every code claim was
re-verified against source this session; every named historical incident was re-verified
against `CHANGELOG.md`/`git log` (dates + commit hashes below), not taken on faith. **This
review's claims all held** — a cleaner pass than the previous round (no factual corrections
needed), with two precision notes:
- The BVH LRU cap (`_BVH_CACHE_MAX_FN`, `:5333-5346`) isn't a *naive* element-count budget —
  it derives an element-count cap from `jsHeapSizeLimit`/`navigator.deviceMemory` at an
  assumed ~50 KB/element. Still not true per-element byte accounting (P6.1's point stands),
  but it already reaches for the same signals P6.1 formalizes — reuse this pattern rather
  than reinvent it.
- The "10M candidates ≈ 120 MB" figure is exactly right: the compact Wasm path is a flat
  `Int32Array` at 3 ints (12 B) per pair (`_makeCompactCandidates`, `:5957-5970`).

**Confirmed by direct inspection, not just the review's citations:**
- `element.meshes[]` is genuinely retained forever while a model is loaded, read by ~40
  call sites (clash engine, cut-plane, serialization, diff/compare, selection, addons) —
  this is real breadth, not a narrow patch.
- The IFC worker does **not** terminate on the `'result'` (geometry) message — it stays
  alive extracting properties via `onProps`/`'props'` while the **main thread**
  synchronously builds every `BufferGeometry`/`Mesh`/`matCache` entry from the packed
  arrays (`loadIFCWorker` `:4806-4925`). The peak-memory overlap P6.3 targets is real and
  already visible in the current code path, not speculative.
- BVH build (`_getBVH` `:5431-5442`) works from **world-space** triangles
  (`_getWorldTris`), so N instances of the same local geometry each get an independent BVH
  build today — confirming `IMPROVEMENT_PLAN.md` Wave 6 item 3 ("BVH per unique geometry
  shared across instances") is real, unclaimed work, not a stale roadmap line.
- Issue #572 (closed 2026-06-06, PR #573) already named `element.meshes[]` retention (~70M
  verts at the time) as an explicit, deliberately-deferred follow-up ("D2 follow-up") —
  five weeks ago. This is the oldest unaddressed item in the plan.

#### Historical guardrail ledger (mined from `CHANGELOG.md`/`git log`, not just IMPROVEMENT_PLAN.md's summary)

Every task below cites which of these it must not repeat.

| Saga | Timeline | What happened | Root cause / eventual fix |
| --- | --- | --- | --- |
| **Chunk-merge** (hand-rolled geometry merging — the direct ancestor of P6.2's proposal) | Enabled default v5.12.14 (2026-06-04) → reverted v5.17.4 (2026-06-06) → emergency re-enabled v5.19.27 → re-reverted v5.19.28 (both 2026-06-08) → **removed wholesale** v5.19.55 (2026-06-09, `chore: remove chunk-merge subsystem (#5)`) | Merging multiple elements' geometry into one buffer broke per-element identity: selection highlight, ghost/isolate, bulk hide, and per-element color/style switching all had to be **re-implemented on top of** merged chunks (Stage 2A/2B, v5.12.13/.14) and still needed a cache-restore bypass fix (v5.15.3) before the first revert. | Replaced by **instancing/batching that keeps the per-element proxy mesh** (`InstancedMesh`/`BatchedMesh`, current code) specifically so selection/style/hide resolve to a real per-element object. CI now gates this permanently: `tests/browser/smoke.mjs:310-370`, "every symptom that caused the old chunk-merge reverts (`366c7cc`)" — hide, style-swap-reaches-batch, per-instance color, section clipping. |
| **Free RAM / dehydrate** (a prior, unscoped attempt at exactly what Park/Auto-park does now) | Added v5.17.2 → **reverted the very next version**, v5.17.3, same day (2026-06-06) | Excised, not fixed — the CLAUDE.md guardrail groups it under "no render-path memory experiments" with no salvage. | This session's Park feature (`d5eaeef`, PR #702/#703) is the properly-scoped version of the same idea: geoCache-preserving, same-id restore, fail-closed on non-restorable models, single-model-at-a-time. **Any P6 task that reclaims memory must keep those three guarantees** (restorable-first, same-id, fail-closed) — that discipline, not the idea itself, is what Free RAM lacked. |
| **`_instKey` hashing** ("five failed hotfixes in one day" per `IMPROVEMENT_PLAN.md`) | All 2026-06-08: v5.19.31 (`matKey was never declared`) → .32 (cache-restore branch missing the call) → .33 (defensive bbox shape detection) → .42/.43 (fingerprint position buffer) → .45 (hash entire position+index buffer, bump cache version) → .46 (kill 32-bit hash collisions) → .47 (collision detector + opt-out) → **.48 (`persist geometryExpressID, use as canonical _instKey`)** | A **position-derived hash** used as the instancing/geo-cache key was scale-invariant and collided across genuinely different geometries — five successive patches tried to harden the hash (bigger fingerprint, whole-buffer hash, collision detection) before the real fix: stop hashing, use the IFC's own canonical `geometryExpressID`. | **Lesson for P6.2/P6.1: don't invent a new identity/hash scheme for geometry when a canonical upstream ID already exists.** `geometryExpressID` is exactly the kind of handle a `GeometryHandle.geometryId` should be keyed on — this saga is direct precedent for that field. |
| **Type-pair memo → instant-0 regression** | Referenced in `IMPROVEMENT_PLAN.md`/`CHANGELOG.md:157` (`clear stale type-pair memo on bridge runs (instant-0 fix)`, #634) | A stateful detection cache kept a prior ruleset's memo and silently suppressed all pairs on the next run with different rules — clashes went to 0 with no error. | Guardrail now codified: "any rules-shape change versions or invalidates the type-pair memo and pair cache, and lands with `_ccBenchEngine` parity checks. One fix per commit so regressions bisect in minutes." **P6.4 must apply this same discipline to any new candidate-cursor/BVH-sharing cache** — version/invalidate on rules or geometry-identity change, never assume staleness can't happen. |

#### P6.1 — Byte-accurate in-memory residency ledger

Track *reclaimable* bytes per model — not just element count — so parking decisions and
diagnostics are trustworthy: unique position/normal/index `ArrayBuffer`s (deduped by
`geometryId`, not summed per-proxy the way today's report does), `BatchedMesh` buffer
share, instance matrix/color arrays, retained `element.meshes[]` proxy count, `_bvhLRU`
world-tri cache size, and an approximate property-graph size.

This is a **new, in-memory-residency** concept — distinct from `storage-core.js`'s
`IDB_REGISTRY`/`LS_REGISTRY` (those track *disk* persistence retention classes:
source/derived/decay/prefs). Don't conflate the two, but **do** reuse that module's proven
shape: a single explicit registry + a wiring test that fails when a new heavy structure is
added without being accounted for (mirrors `storage-registry-wiring.test.js`).

Then: park the hidden model with the largest reclaimable footprint (replacing today's
`(m.elements||[]).length` sort in `_ccAutoParkPass`, `:2259-2274`); add hysteresis (park
above 72%, only resume normal operation below ~58%, to stop thrashing at the boundary);
add a per-model cooldown after a smart-reload restore so a just-touched model isn't
immediately re-parked; fall back to `navigator.deviceMemory` where `performance.memory`
is absent (Safari/Firefox) — mirroring the pattern `_BVH_CACHE_MAX_FN` already uses.

*Gate:* the memory report's "Retained element.meshes[]" line and the auto-park decision
both read from the same ledger (no more double-counting shared geometry); a 10-cycle
park/restore soak shows <5% ledger drift from actual `performance.memory` deltas.

*Do first* — every other P6 task's "expected effect" claim becomes falsifiable once this
lands, and it's pure addition (a new accounting layer), not a rewrite of retained state —
lowest risk, do it before touching any consumer of `element.meshes[]`.

#### P6.2 — `GeometryHandle` / `GeometryStore`, retiring `element.meshes[]`

The real fix for the ~40-call-site retention problem. Element geometry becomes a handle —
`{geometryId, renderOwnerId, instanceId, transform, materialId}` — resolved through one
`getElementGeometry(element)` accessor, instead of an array of live off-scene `THREE.Mesh`
objects. `geometryId` should be the IFC's own `geometryExpressID` (see the `_instKey` row
above) — not a fresh hash.

**This is explicitly NOT a chunk-merge revival.** Chunk-merge failed because it destroyed
per-element addressability by merging geometry *buffers*; a `GeometryHandle` keeps
per-element addressability (every element still resolves to its own transform/material)
while only changing *what object type* represents that address (a handle vs. a retained
Mesh). The rollout must prove this distinction empirically, not just architecturally:

1. Add handles **alongside** `element.meshes[]` — dual-write, no removal yet.
2. Land `getElementGeometry(element)` and migrate exactly one consumer (recommend the
   clash engine first — it's already isolated behind `_getWorldVerts`/`_getWorldTris`).
3. Run both paths and diff outputs (clash pair-identity parity, not just "it ran").
4. Migrate selection outline, serialization (`_geoSerialize`), diff/compare, then addons —
   one consumer per commit (per the type-pair-memo guardrail: "one fix per commit so
   regressions bisect in minutes").
5. Drop proxies for `InstancedMesh` groups first (lowest risk — geometry is already
   shared, only the wrapper object goes away), then `BatchedMesh` source proxies, only
   after cache-restore round-trips through the new handle shape.
6. Remove `element.meshes[]` only once every one of the ~40 call sites is migrated and the
   CI gate below is green.

*Gate:* `tests/browser/smoke.mjs`'s existing BatchedMesh identity block (hide, style-swap,
per-instance color, section clipping — the exact "every symptom that caused the old
chunk-merge reverts" list) stays green throughout, unmodified in intent; add the same
assertions for the `InstancedMesh` path if not already covered; clash-pair identity parity
between the old and new geometry-read paths on the existing differential fixture; zero
retained `THREE.Mesh` objects off-scene for migrated elements, confirmed via P6.1's ledger.

*Sequencing note:* this is the largest, highest-risk item here — Medium-High risk is the
right label. Land P6.1 first so "did this reduce memory" is measurable, and expect this to
be its own multi-PR arc (like the instancing rollout was), not one commit.

#### P6.3 — Memory-safe loading mode for large IFC files

Confirmed real: `loadIFCWorker` doesn't terminate its worker on the geometry `'result'`
message (`:4859-4873`) — the worker stays alive lazily extracting properties from its own
open web-ifc WASM model while the **main thread**, in the same tick range, synchronously
builds every `BufferGeometry`/`Mesh` from the packed arrays (`:4886-4925`). That overlap
(worker's WASM model + transferred raw geometry + new Three.js geometry + prop extraction)
is the real peak, not a hypothetical one.

Add a pressure-gated mode (triggered by file size or P6.1's ledger showing the load would
cross a threshold): stage packed geometry without constructing Three.js objects yet, let
property extraction finish and the worker terminate, auto-park unrelated models via
`_ccAutoParkPass` if still tight, *then* construct the model off the live scene state and
commit it atomically (single `ADD_MODEL` dispatch — never a partially-built model in
`s.models`, which is exactly the failure mode `IMPROVEMENT_PLAN.md`'s "explicitly not
building" list already rejects: *"progressive partial-model rendering"*). For files large
enough to warrant it, defer full psets to a background/on-demand pass after commit — psets
are already canonicalized/deduplicated (`_ccCanonPsets`, `:3262-3271`) so this is a
sequencing change, not a new dedup mechanism.

*Gate:* peak heap during load of the largest corpus fixture drops measurably (P6.1 makes
this falsifiable); no partially-committed model is ever visible in `s.models`; load
correctness (element count, storeys, warnings) is unchanged versus today's path.

#### P6.4 — Bounded-memory clash detection

`_sweepAndPruneWasm` materializes the **entire** flat candidate array in one shot
(`_makeCompactCandidates`, `:5957-5970`) — confirmed exact math: 10M candidates × 12 B/pair
(3 × int32) ≈ 120 MB, before narrow phase even starts. This graduates
`IMPROVEMENT_PLAN.md` Wave 6 item 5 verbatim ("streamed pair processing instead of
materializing the full candidate array") — **update that document when this lands rather
than tracking it in two places.**

- A stateful Wasm sweep cursor returning fixed batches (25k-50k pairs), narrow-phase
  processed before the next batch is requested — keep the existing JS `_sweepAndPrune` as
  the correctness oracle, exactly as the Wasm broad-phase rollout already does today.
- Byte-budgeted BVH LRU: reuse `_BVH_CACHE_MAX_FN`'s existing `jsHeapSizeLimit`/
  `deviceMemory`-derived signal (it already isn't naive) but key the cap on tracked bytes
  (via P6.1) instead of a flat element-count-under-an-estimate.
- One local-space BVH per unique `geometryId`, shared across instances via P6.2's handles
  (`_getBVH` currently rebuilds per-element from world-space triangles, `:5431-5442`,
  because there's no shared local-space tree to transform queries into) — this graduates
  Wave 6 item 3. **Sequencing dependency: this sub-item needs P6.2's `geometryId` to exist
  first**, so it lands after, not alongside.
- Optional cache clear after detection completes, for the non-interactive "run once and
  export" flow.

*Gate:* the existing type-pair-memo guardrail applies directly — any change to what the
cursor/BVH cache keys on must version or invalidate on rules-hash **or** geometry-identity
change, and land with `_ccBenchEngine` parity checks. Candidate memory footprint stays
bounded (a fixed multiple of batch size) independent of total candidate count on the large
federation fixture; exact clash-pair parity with today's engine, not just "similar count."

#### P6.5 — Property paging (do only if telemetry justifies it)

Lowest priority, correctly ranked last by the review: psets/quantities are **already**
canonicalized and structurally deduplicated (`_ccCanonPsets`/`_ccCanonQuantities`,
`:3262-3281`) via frozen-shape caches, so this isn't the first target the way it might be
in a naive IFC viewer. Only revisit if P6.1's ledger shows property-graph size is still
material after P6.2 lands: keep IDs/type/name/storey/material/classification resident,
page full psets/quantities from IndexedDB keyed by model+expressId on inspector-open, and
let IDS/data-quality workers stream blocks instead of hydrating the full graph.

*Gate:* only pursued if P6.1 telemetry shows it's still a top-3 contributor after P6.2 —
otherwise this is explicitly **not** scheduled, to avoid Medium-High-risk work with no
measured payoff (the review's own risk rating for this item).

#### Ship gates (both corpora: the 4-model federation from this session + the large
single-IFC case)

- Zero retained proxy `THREE.Mesh` objects for migrated batched/instanced elements (P6.2).
- ≥25% lower peak **and** steady-state memory on the federation, measured via P6.1's
  ledger (not element-count proxies).
- Candidate memory capped independently of total candidate count (P6.4).
- <5% retained-memory growth after ten park/restore cycles (extends this session's Park
  feature soak test).
- Exact clash-pair identity parity with the current engine throughout (every task above).
- Selection, outlines, styles, cache restore, and BCF viewpoints stay byte-for-byte
  identical in behavior — verified by the existing `tests/browser/smoke.mjs` BatchedMesh
  block plus new equivalents for any newly-migrated path.
- Camera interaction stays <33 ms p95 frame time after load (existing `_ccRenderReport`).

*If only one thing ships from this section, ship P6.2 (after P6.1 makes it measurable).*
Auto-parking (already shipped this session) is the safety valve; retiring
`element.meshes[]` is what changes the app's fundamental memory curve.

---

## Explicitly NOT doing now (endorsed from the review)

- No progressive partial-model rendering.
- No wholesale Rust rewrite.
- No SharedArrayBuffer / cross-origin-isolation work (production isn't COOP/COEP-isolated
  by design — `vercel.json` has no headers block; keep it that way).

Correctness parity (P0) and a real corpus (P2) come before any further architectural
experiment. The safer scaling path stays the atomic storey-scoped model already in
`IMPROVEMENT_PLAN.md` Wave 6.

## Sequencing

1. **P0.1–P0.6 + P0-infra** — the release blocker. All browser-side except P0.6's CI
   wiring; no Engine dependency. Ship first.
2. **P1.1 + P1.3** — cheap, high-leverage (negotiation unblocks honest gating; byte
   accounting is a small fix). P1.2 follows in the Engine repo.
3. **P2** — gated corpus work; the only thing that licenses the 500 MB claim.
4. **P3 → P4 → P5** — robustness, interop, and storage atomicity, in that order.
5. **P6.1 → P6.2 → P6.4's BVH-sharing sub-item**, with **P6.3** parallel to P6.2 (loading
   mode doesn't depend on the geometry-handle migration, only on P6.1's ledger existing)
   and **P6.5 deferred** pending P6.1 telemetry. This is independent of P0-P5 — no release
   blocker depends on it — but it's the highest-value work remaining once P0 ships, per the
   review's own framing ("if you do only one substantial piece next, do this").
