# Rewrite package review + UI improvement plan (consolidated)

**Date:** 2026-07-16
**Baseline reviewed:** `018c679` (v6.1.1)
**Inputs:** two externally-authored (GPT) deliverables — a "local rewrite candidate"
ZIP (runtime/loader refactor tranche) and a UI functionality improvement plan.
This document is the critical review of both, what was adopted/adjusted/rejected,
and the consolidated forward plan.

---

## Part A — The rewrite package: verdict and adoption

### Verdict

**Largely sound, honestly scoped, and adopted — with three real defects found in
review and fixed before merging.** The package deliberately avoids the areas this
repo's history marks as dangerous (renderer, geometry, cache schema, BCF, worker
serialization) and its claims verified against the actual code: the
`_lazyWorkersActive`/`_chainEndFired` counter pair it replaces really was the
root cause of past stuck-loader regressions, `_loadAddonScripts()` really did
eagerly fetch all 16 addons, and unload really did leak cached render-style
materials (`userData._styleMats` holds per-mesh materials — verified NOT shared,
so per-mesh disposal is safe; originals from the #572 `_ccSharedMatCache` are
shared and are correctly left alone by the new cleanup).

Verification here (not taken on trust): 535/535 unit tests and the **full
real-Chromium smoke** (IFC worker + WASM pipeline, detection, hard-refresh cache
restore, scoped load, BatchedMesh, forced cancellation, forced worker-fallback,
lazy-addon single-load, zero console errors) pass on the adopted tree.

### Honest read of the benchmark numbers

The headline "−30.2% end-to-end" is real but mostly **not** engine speed:

- ~380 ms of the −43% "loading complete" figure is the removal of a cosmetic
  500 ms → 120 ms completion dwell. Fine to take, but it is UX polish, not perf.
- The −36% detection figure is the WASM accelerator being loaded first instead
  of racing 15 other addon fetches. Real, cheap, sensible.
- The −22.3% transfer reduction is genuine: Smart Bridge + OpenAEC code an
  inactive session never requests. (An earlier misleading "85% reduction" via
  2.5 s deferral of everything was self-reported and removed — good sign for
  the package's honesty.)
- The +4.1% heap snapshot is non-forced-GC noise; the forced-GC probe shows
  parity/slightly lower. Neither measures WASM/GPU memory.
- All numbers are from a 2-element fixture. They detect regressions; they do
  not predict 100–500 MB model behavior.

### Defects found in review (fixed before merge)

1. **Lazy activation silently skipped `onEnable` (functional regression).**
   The Integrations panel reads the addon def synchronously after
   `_ccActivateAddon(id)` and calls `def.onEnable` — Smart Bridge's `onEnable`
   is the entire Connector download/connect kick-off. With the lazy placeholder
   the def has no `onEnable` yet, so the first-ever Enable of Smart Bridge
   would load code, mark active, and visibly do nothing. Fixed: the lazy branch
   of `_ccActivateAddon` now resolves with the real registered def, and the
   panel fires `onEnable` after the promise settles (sync path unchanged).
   Verified in a real browser: placeholder → promise → real def →
   `onEnable` present → active + persisted. The package's own smoke missed this
   because it tested `_ccEnsureAddon` directly, not the panel flow.
2. **`defer` made a latent preload-scanner bug deterministic.** With the nine
   helper scripts no longer parser-blocking, Chromium's preload scanner
   reliably speculatively fetched the literal URL `${vp.snapshot}` out of an
   htm template inside the inline script (404 noise on every load; the strict
   smoke gate caught it — same bug class as the `sn.img` fix in MEMORY.md, and
   the baseline was already firing it intermittently). Fixed all four
   `<img src=${…}` htm sites with `\x3Cimg` — the cooked template string is
   byte-identical for the htm parser (verified: parser consumes cooked
   statics), but the raw page bytes no longer contain an `<img` tag for the
   scanner. Full smoke now passes with zero console errors.
3. **Minor:** dead `loadDeferred` wrapper (leftover of the removed timer
   experiment) inlined; OpenAEC placeholder description aligned with the real
   registered definition so the Integrations panel copy doesn't change after
   first activation.

### Adopted

- `cc-runtime.js` (registry / script loader / load coordinator, UMD, no build).
- `index.html`: deferred helper scripts, addon manifest + lazy placeholders,
  `_ccEnsureAddon`, coordinator-based load lifecycle in
  `ModelSidebar.processFiles` (named holds + one terminal path + chain
  rejection handler), 120 ms dwell, style-material/edge disposal on model
  unload/replace, centralized `_ccDisposeSectionCutLines` (this also fixes a
  previously-missed geometry dispose on section rebuilds).
- `sw.js`: precache `cc-runtime.js`, drop Smart Bridge/OpenAEC from precache,
  runtime-cache same-origin `/addons/` responses after first use.
- All new/updated tests: `cc-runtime.test.js`, `cc-runtime-wiring.test.js`,
  the extended browser smoke (cancellation, worker fallback, lazy addon), and
  the `perf-local.mjs` / `memory-local.mjs` probes. The eight existing wiring
  tests were only touched to track the `defer` attribute — no assertions
  weakened (checked line by line).

### Rejected / not taken

- The package's `MEMORY.md` rewrite (session log is written fresh here instead).
- Its report file as a repo artifact (superseded by this document).

### Known limitations accepted knowingly

- Smart Bridge/OpenAEC are unavailable on a **first-ever offline** session;
  after one online use the SW runtime-caches them. Acceptable: both talk to
  localhost companion apps that an offline-first-visit user won't have.
- `_ccRegisterAddon` used to merge every addon's `initState` into `INIT` even
  when inactive; lazily-loaded addons no longer do until first activation. All
  current core reads of `s.smartBridge` are null-guarded and `s.openaecBridge`
  has no core reads — **rule going forward: any core read of a lazy addon's
  state slice must stay null-guarded.**
- The coordinator's `cancel()`/`fail()`/service-registry surface is larger than
  its current use (cancel flows through worker `settle(null)` → hold release →
  normal completion; `fail()` only guards an unexpected chain rejection). Not a
  defect — but don't grow this API without a consumer.

---

## Part B — The UI improvement plan: verdict

### Verdict

**Directionally right, adopted as roadmap with re-prioritization.** Its core
diagnosis verified against the code: `VirtualList`'s "progressive reveal" is
first-paint deferral only — the idle callback then mounts **the entire result
set** (`setReveal(rawItemsProp.length)`), so 50k-clash sessions still pay full
DOM cost. The ≤2000-clash default-grouping guard, the phone-panel decisions,
and the cited history constraints all check out (4 of the older commit hashes
sit past this clone's shallow-fetch window but are independently corroborated
by MEMORY.md; none contradicted).

Its self-restraint is also right and is kept as policy: no visual redesign, no
LeftRail resurrection, no hiding commands from Cmd-K, no touching renderer/
geometry/identity from UI work, keep full-screen phone panels.

### Adjustments to the UI plan

1. **Don't build the "operation center" (its Phase 3) as a new subsystem.**
   The load coordinator adopted in Part A already owns load-lifecycle terminal
   states and is the designed attachment point. Operation UI should be a thin
   consumer of coordinator snapshots/events (`begin/hold/release/terminal`),
   extended to detection via the existing `detecting` flag + profile events —
   not a parallel state machine. This shrinks Phase 3 from "unify everything"
   to "one component reading one source of truth."
2. **Re-order: consent + empty-state work before toolbar surgery.** Its Phase 8
   (move first-run consent off the canvas center) and Phase 4 (truthful empty
   states) are low-risk, high-annoyance-removal, and partially built already —
   the same-discipline zero-clash banner and funnel toast (Wave 1.7) are
   precedents. The toolbar overhaul (its Phase 2) touches the most muscle
   memory for the least measured gain; it goes after the list work proves the
   measurement harness.
3. **Windowed conflict list stays the flagship, flag-gated as proposed** —
   with two additions: (a) parity tests must reuse the existing keyboard-triage
   coverage (J/K/C/D/V etc. from Wave 2), and (b) the ≤2000 grouping guard and
   sticky cluster headers are part of the parity contract, not cleanup targets.
   Its acceptance numbers (≤250 mounted rows at 50k, 100 ms first row) are
   adopted as budgets, but treated as fixture-machine budgets, not promises.
4. **Trim scope candidates:** the five-viewport screenshot matrix and 20–100
   cycle detached-node soak are kept, but the "compare legacy and candidate
   dispatch streams from the same state" harness should be built once and
   reused for every later flagged replacement (toolbar, modal), not bespoke per
   phase.
5. **Reject nothing outright** — but its file-set sketch (`ui/*.js` modules) is
   subordinate to this repo's addon rules: panel UI lives in `index.html`;
   extracted UI modules follow the same default-off flag + wiring-test pattern
   as the clash-pipeline cores, not a new `ui/` convention invented mid-stream.

---

## Consolidated forward plan

Ordered, independently landable, each with its gate. Items 1–3 are the direct
continuation of what landed here; 4+ are the merged remainder of both inputs.

1. **Soak the adopted runtime tranche** (this PR): CI browser-smoke green,
   then one release of real-user soak before building on `_ccEnsureAddon`.
   Gate: no loader/addon regressions reported; SW upgrade from production
   cache verified once on the live site.
2. **UI Phase 0 — measurement harness first** (fixtures: 200/2k/10k/50k
   synthetic conflicts; loading/detection/cancel/failure states; 5 viewports;
   keyboard-path suite; heap + detached-node trend probes reusing
   `memory-local.mjs` patterns). Gate: baseline numbers recorded on the
   untouched tree. No UI edit before this exists.
3. **Windowed conflict list** behind `ccUiWindowedConflicts` (default off),
   parity-tested against the legacy list from identical state. Gate: its
   acceptance budgets + zero keyboard regressions; default-on only after an
   external check; legacy path retained one release.
4. **Truthful empty/filtered states + consent relocation** (small state
   machine over the Conflicts empty view; filter chips; consent as
   non-blocking banner). Gate: every zero-row case maps to exactly one tested
   state; no consent regression (opt-in stays explicit).
5. **Operation feedback as coordinator consumer** (load + detection progress,
   terminal states, single Cancel wiring, `aria-live` summaries). Gate:
   cancel-at-every-phase leaves no stuck UI (extend the smoke's existing
   cancellation section).
6. **Activate the six extracted clash-pipeline cores one at a time** (existing
   `ccSafety` flags → default-on → delete inline legacy the release after).
   Gate per module: boot-time equivalence stays green in CI + soak.
7. **Static IFC worker file** with versioned message protocol, replacing
   `.toString()` serialization; keep main-thread fallback; differential
   model-fingerprint fixtures before deleting the serialized path.
8. **Toolbar progressive disclosure + adaptive panels + mobile shell** (UI plan
   Phases 2/5/6, in that order), each flag-gated, each measured against the
   Phase-0 harness. Hard rules kept: no command hidden from Cmd-K, active tool
   never moves into overflow, no second nav layer.
9. **Modal/focus-trap primitive + accessibility hardening** (UI plan Phase 7),
   applied first to Run Detection/Settings/Share/Cmd-K, then the rest after
   parity tests.
10. **Wire more integrations to true first-use loading** via `ensureAddon()`
    from their real triggers (panel open, file-type drop) — one at a time, only
    where a session can plausibly never need them; never deferral-for-optics.
11. **Large-model instrumentation before any geometry/algorithm change:**
    browser RSS + worker/WASM + renderer counters on representative 100 MB+
    models, using `perf-local.mjs`/`memory-local.mjs` with internal fixtures.
    Prerequisite for: render-style cache bounding, geometry-cache write
    scheduling, progressive loading.
12. **User-facing storey-scope chooser** on the existing pre-decode scope path
    (prominent, reversible partial-model state). This — not automatic
    progressive geometry — remains the sanctioned big-model mechanism until
    item 11 data says otherwise.

### Standing rules (unchanged by either input, re-affirmed)

- JavaScript, no build step, static hosting stay.
- No renderer/color-management, cache-schema, `.ccproject`, BCF, or clash-
  policy changes ride along in UI or loader work.
- Every behavioral replacement lands behind a flag or in an isolated commit
  with its rollback path stated.
- Benchmarks that mix cosmetic-timer changes with engine claims get split
  before publication.
