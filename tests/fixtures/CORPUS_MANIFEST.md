# Large-model corpus manifest

Follow-up to the browser-first large-model plan review (2026-07-17, see
`MEMORY.md` Active Work). The plan's Phase 0 calls for measuring against a
**private, legally usable corpus** at roughly 50, 150, 300, 500 and 750+ MB,
plus synthetic cases for high entity count, high property count, repeated
geometry and dense broad-phase candidates. Real production IFC files are
almost always too large and/or license-encumbered to commit to this repo —
this document is the registration point for a corpus that lives **outside**
the repo, plus the plumbing to point the existing measurement harnesses at
it without editing the harnesses themselves.

## Rules

- **Never commit real-world IFC files to this repo**, regardless of size.
  Licensing is usually unclear and files can be large. Keep the corpus in a
  local directory outside the working tree (or a private, access-controlled
  location of your choosing).
- Only use files you have clear rights to use for internal engineering
  testing (your own projects, sample files a vendor publishes for this
  purpose, synthetic generators). Do not use client-confidential files
  without explicit permission.
- Record provenance (source, license/usage terms, rough entity count) for
  each file you register, in your own local notes — not in this repo.

## Target tiers

| Tier | File size | Purpose |
|---|---|---|
| Small | ~50 MB | Baseline — should stay fast; regression canary |
| Medium | ~150 MB | Where the plan's own review saw super-linear scaling begin (25k-element synthetic case) |
| Large | ~300 MB | Mid-scale stress |
| X-Large | ~500 MB | Plan's Phase 6 acceptance target tier |
| XX-Large | ~750 MB+ | Upper-bound stress; expected to exercise every bottleneck at once |

Within each tier, prefer variety over raw size: a dense 150 MB model
(high entity count, many unique geometries, heavy property sets) is a
harder case than a repetitive 600 MB model with a few thousand instanced
geometries — the plan's own point about file size not being a capacity
measure. If you only have one file per tier, that's fine; note what kind
of model it is (MEP-heavy, structural, architectural, federated) so a
future comparison isn't misread as apples-to-apples.

Synthetic high-entity-count / high-property-count / repeated-geometry /
dense-broad-phase-candidate cases are already covered by
`generate-synthetic-ifc.js` (see below) — you don't need real files for
those, only for realistic property volume, geometry diversity and file
structure that a generator can't fake.

## Running the existing harnesses against a real corpus file

`perf-local.mjs` and `memory-local.mjs` both support `CC_PERF_FIXTURE_PATH`
— an absolute path to a real IFC file **outside the repo**. When set, the
harness serves that one file from a fixed, narrow route (not through the
general containment-guarded static file server, and never derived from
request input — just the one operator-chosen path) instead of the built-in
`smoke-clash.ifc` fixture, and scales its load-wait timeout up
(`CC_PERF_LOAD_TIMEOUT_MS`, default 600000ms when a corpus path is set) so
a large file isn't falsely reported as a hang.

```sh
CC_CHROMIUM_EXECUTABLE=/path/to/chromium \
CC_BROWSER_OFFLINE_DEPS=1 \
CC_PERF_FIXTURE_PATH=/absolute/path/to/your-real-model.ifc \
CC_PERF_RUNS=3 \
node tests/browser/perf-local.mjs results/perf-<tier>-<date>.json

CC_CHROMIUM_EXECUTABLE=/path/to/chromium \
CC_BROWSER_OFFLINE_DEPS=1 \
CC_PERF_FIXTURE_PATH=/absolute/path/to/your-real-model.ifc \
node tests/browser/memory-local.mjs results/memory-<tier>-<date>.json
```

Both write `fixture: "<path>"` into their JSON output, so a result file is
self-describing about which corpus member produced it — never blend
numbers from different files into one headline, per the plan's own
"publish results per model" rule.

`perf-local.mjs`'s per-sample output already includes, as of this
manifest's companion change: `bootMs`, `geometryReadyMs`, `completeMs`,
`detectionMs`, `rssBytes` (whole-process RSS), `heapBytes`, `elements`,
`clashes`, `candidates` (the clash engine's fully-materialized candidate
count), `candidatesEstBytes` (a documented rough per-candidate-object
estimate — see `_CANDIDATE_EST_BYTES` in `index.html`, not a measured
value), `sweepAndPruneMs`, and `bvhBuildMs`. That covers the plan's Phase 0
ask for "candidate count" and "confirmed clashes" alongside load-phase
timing, without needing a new harness.

## Synthetic fixtures

`generate-synthetic-ifc.js` generates a valid, loadable IFC4-SPF file with
configurable `storeyCount` / `wallsPerStorey` (entity-count scaling), plus
opt-in extensions added alongside this manifest: `withQuantities`
(IfcElementQuantity), `withPsets` (property sets, including one
deliberately null-valued "degenerate" property), `lengthUnit: 'MILLIMETRE'`
(unit-conversion / `geoFactor` exercise), and `geo` / `mapConversion`
(IFC georeferencing — `IfcSite` RefLatitude/RefLongitude,
`IfcMapConversion`/`IfcProjectedCRS`). These are consumed directly by
`tests/browser/ifc-worker-fallback-differential.mjs`'s fixture matrix — see
that file for the exact option shapes.

For a large synthetic entity-count stress case (not a substitute for a
real corpus file — see `MEMORY.md`'s 2026-07-17 entries on why the
generator's schema-validity matters for getting real numbers):

```js
const { generateSyntheticIfc } = require('./tests/fixtures/generate-synthetic-ifc.js');
const fs = require('fs');
fs.writeFileSync('/tmp/synthetic-25k.ifc', generateSyntheticIfc({ storeyCount: 50, wallsPerStorey: 500 }));
```

Then point `CC_PERF_FIXTURE_PATH` at the generated file as above.

## Not yet built (explicit gap, not silently covered)

- **Repeated federation** (loading several models into one session
  repeatedly) and **five consecutive project opens/closes** — the plan's
  Phase 0 asks for long-running tests of both; `load-cancel-load-loop.mjs`
  (added alongside this manifest) only covers load-cancel-load and model
  removal. Follow-up work, not done here.
- **No real corpus files are registered anywhere in or with this repo** —
  this document is the registration *point*, not a registry with entries in
  it. The first person who runs the harnesses against real tier files
  should keep their own local record of what they used (outside the repo,
  per the rules above).
