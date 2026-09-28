# Reducer/state decomposition — status and plan

> Started 2026-07-17. The reducer (`function reducer(s,a)`, `index.html`, currently
> ~350 lines) mixes state transitions with side effects — persistence, analytics,
> cache invalidation — inline, case by case. This is the highest-blast-radius
> function in the file (every dispatched action passes through it), so this is
> deliberately a narrow-slices, characterization-tests-first effort, not a
> big-bang rewrite. This document tracks what's done and lays out the rest.
>
> Every code reference below was verified against the actual current source
> (not assumed from memory) before being written down.

## Done

### Slice 1 — consolidate duplicated preference-persistence writes (2026-07-17)

**Before:** the `try { localStorage.setItem('cc_'+key, JSON.stringify(value)); } catch(e){}`
pattern was duplicated byte-for-byte across ~8 reducer case branches
(`ADD_SMART_VIEW`, `DEL_SMART_VIEW`, `UPD_PREFS`'s `defaultTolerances` branch and its
20-key `_pk` loop, `CLASH_GROUP_BY`, `CLASH_SORT_BY`, `ISSUE_GROUP_BY`, `ISSUE_SORT_BY`) —
each one a fresh copy of the same three lines, free to drift from each other over time.
Separately, an *already-existing* helper (`_ccPersistUI`, defined just above the
reducer) did the identical job for three other cases (`SET_WORKSPACE`, `DIAGNOSTICS`,
`INSPECTOR_OPEN`) plus a string-passthrough case the duplicated blocks didn't have.

**After:** every JSON-shaped write above now calls `_ccPersistUI` — no new file, no new
abstraction, just consolidating onto the pattern that already existed and was already
proven. The `UPD_PREFS` key list moved from an inline array literal recreated on every
dispatch to a named constant, `PERSISTED_PREF_KEYS`.

**Deliberately NOT touched:** `TRAINING_MODE` writes `cc_trainingMode` as a raw `'1'`/`'0'`
string, not JSON — folding it into `_ccPersistUI`'s JSON path would silently change the
stored format for anyone who already has a `'1'`/`'0'` value saved (read back via
`v==='1'` in `INIT`). Left exactly as-is.

**Verification:** `tests/prefs-persistence-consolidation.test.js` (source-pattern lock +
direct behavior test of `_ccPersistUI`/`PERSISTED_PREF_KEYS`), plus a real-browser check
dispatching `CLASH_GROUP_BY`/`UPD_PREFS`/`TRAINING_MODE` and reading the actual
`localStorage` values back. Full unit suite + real-Chromium smoke green throughout.

## Remaining areas, in the order to attempt them

Ordered by risk × blast-radius, cheapest/safest first. Do not skip ahead — each
later area depends on the discipline (characterization tests before refactor,
real-browser verification after) proven on the earlier ones.

### 2. Cache invalidation — `_clearElCaches` (`index.html`, ~line 1632)

Already a **named, 5-line function** (`_bvhLRURemoveModel` + a guarded
`_pairCacheClearForModel` call), called from exactly two reducer cases
(`DEL_MODEL`, `REPLACE_MODEL`) plus a `_prevM` cleanup path in `ADD_MODEL`'s
neighbor case. This is the cheapest remaining extraction: move the function
(and its two small dependencies, `_bvhLRURemoveModel`/`_pairCacheClearForModel`)
to a static file loaded the same way as `prefs-persistence` *would* have been —
except, per the lesson from slice 1, check first whether an existing pattern
already covers this before introducing a new file. **Risk: low.** Pure
function, no control-flow entanglement, already isolated.

### 3. Analytics — `_gcEvent` (`index.html`, ~line 737)

Also already a **named, 3-line function** (goatcounter beacon, consent-gated,
swallows all errors). The complication isn't the function itself — it's reach:
`_gcEvent` is called **far beyond the reducer** (20 call sites file-wide,
verified by direct count, not just the ~4 inside the reducer switch). Extracting it is
mechanical (it has zero dependencies besides `_ccConsentOK` and the global
`window.goatcounter`), but touches enough surface area that it's worth its own
pass with a dedicated wiring-lock test enumerating call sites, rather than
folding it into a "reducer decomposition" slice narrowly. **Risk: low-medium**
— low complexity, medium surface area.

### 4. Remaining persistence (beyond slice 1)

Slice 1 covered the reducer's *JSON-write* duplication. Not yet covered:

- Direct `localStorage.getItem`/`JSON.parse` reads scattered through `INIT`
  (state hydration at boot) — a natural pair to the writes, currently each
  wrapped in its own inline `try/catch`, same duplication shape as slice 1's
  writes but on the read side.
- IndexedDB persistence (`_saveCurrentProjectData`, `idbSaveFile`, and friends)
  — a materially different, async storage mechanism, not a small extension of
  the localStorage helper. Treat as its own area, not a continuation of this
  one.

**Risk: low** for the `INIT` read-side cleanup (same shape as slice 1, mirror
the same treatment). **Risk: medium** for IndexedDB — async, and mistakes here
mean silent data loss, not just a wrong `localStorage` value.

### 5. Application event wiring (`cc-model-loading`, `cc-load-session`, etc.)

`CustomEvent`/`dispatchEvent` calls that other parts of the app (OperationCenter,
addons, the loading strip) listen for. These exist partly *inside* reducer-adjacent
code and partly in the load-coordinator (`cc-runtime.js`, already its own file).
Unlike areas 2-4, event *timing* and *ordering* carry real behavioral meaning (a
listener firing before vs. after a particular state commit is often load-bearing) —
this is not a pure mechanical dedup, extraction here needs a real inventory of
every listener first (what does each one assume about ordering?) before touching
anything. **Risk: medium-high.**

### 6. Loader/worker lifecycle

The largest, riskiest remaining area, and the one with the most direct overlap
with the IFC-worker static-file research finding (see `MEMORY.md` Known Issues,
2026-07-17 entry) — `loadIFCWorker`/`loadIFC`/`_ccActiveLoads`/`_ccAbortLoading`
and the reducer cases that react to their results (`MERGE_CLASHES`'s
`_mr`/`runHistory`/`floors` bookkeeping, `ADD_MODEL`/`DEL_MODEL`/`REPLACE_MODEL`'s
cache interplay with area 2). Don't attempt this in isolation from the IFC worker
extraction work — they're the same subsystem viewed from two angles (reducer
decomposition asks "what does the loader hand back to state," worker extraction
asks "how is the loader itself structured"). Sequence: finish the worker's own
differential-coverage expansion first (multi-storey, quantities, unit conversion,
georeferencing, malformed records, cancellation — see `MEMORY.md`), *then* revisit
this area with that safety net in place. **Risk: high.**

### 7. The reducer's own action/state-transition logic

Not attempted until 2-6 are done and soaked. Once side effects are out, what's
left is closer to a pure `(state, action) -> state` function — genuinely
decomposable into per-domain sub-reducers (clashes/issues, UI shell, prefs,
models) at that point, but not before; splitting state-transition logic while
side effects are still tangled through it is how you get action ordering bugs
that don't show up until a specific effect-timing edge case in production.
**Risk: highest — do last, in narrow per-action-family slices, each with
characterization tests locking current behavior before any code moves.**

## Standing rules for this effort

- **Characterization tests before refactor**, every slice — write down current
  behavior as an executable test, then refactor, then confirm the test still
  passes unchanged. Slice 1 did this (`prefs-persistence-consolidation.test.js`
  existed before the runtime-behavior real-browser check, not after).
- **Real-browser verification after every slice**, not just unit tests — slice
  1's unit tests would have passed even if the runtime timing bug this session
  hit (see below) had been a real product bug, not a test-harness artifact.
  Only the real-browser dispatch-and-read-`localStorage` check would catch that.
- **Don't introduce a new file/abstraction if an existing one already fits** —
  slice 1's first draft created a new `prefs-persistence.js` before discovering
  `_ccPersistUI` already existed and already covered the shape needed. Check
  first.
- **No slice touches more than one area** — resist the temptation to "also
  clean up" an adjacent case while in the neighborhood; that's exactly how a
  narrow, reviewable diff turns into a large, risky one.
