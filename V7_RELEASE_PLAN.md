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
