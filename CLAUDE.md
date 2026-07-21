# CLAUDE.md — Project Guide for AI Assistants

## Session start — read this first

**Before doing any work, read `MEMORY.md`.** It contains the live project state,
recent session history, active work in progress, and architecture decisions that
are not in this file. It is updated automatically every 24 hours by
`.github/workflows/daily-sync.yml` and should be updated by you at the end of
each session (Active Work and Project State sections).

After reading, update the `Active Work` section in `MEMORY.md` with what you
are about to do. When you finish, mark completed items with ~~strikethrough~~ + date.

> **Design work? Read `DESIGN.md` first.** It is the source of truth for colors,
> typography, spacing, and component styling. Never hand-pick hex values or
> raw sizes — always pull from the CSS custom-property tokens defined there.
> Key tokens: `--color-success/warning/danger/info`, `--accent`, `--border`,
> `--text-*`, `--space-*`, `--radius-*`.

## What is this?
ClashControl is a free, source-available IFC clash detection web app licensed under SSPL v1. It lets users load IFC building models, detect geometric clashes between elements, create/manage issues, and export to BCF format.

## Architecture — Single File App + Lazy Addons
The **core application** lives in `index.html` (~34k lines — check with `wc -l` before quoting an exact count, it grows). There is no build step, no bundler, no node_modules. Just open the file in a browser.

Optional, non-critical features are split into lazy-loaded files under `addons/` (see the Addons section below). These are loaded at runtime via `<script>` injection (deduplicated by `cc-runtime.js`'s script loader) and the core app works without them. Most addons still load eagerly after mount; `smart-bridge` and `openaec-bridge` are genuinely on-demand (lightweight placeholder in the Integrations panel, real code fetched on first activation via `window._ccEnsureAddon(id)`).

### Tech stack
- **Preact/React 18** via CDN (UMD) — UI framework
- **htm** — hand-written tagged template literal parser (inlined in the file, replaces JSX)
- **Three.js r180** via CDN (ESM import map) — 3D rendering
- **JSZip** via CDN — BCF zip export/import
- **pdf.js** via CDN — PDF preview/overlay in the Issues panel
- **web-ifc** WASM — IFC parsing, lazy-loaded via ESM on first model load
- CDN classic scripts are pinned with SRI integrity hashes (verify with `node scripts/generate-sri.js --check`; regenerate with `node scripts/generate-sri.js` when bumping versions)
- **No other runtime dependencies** (`package.json` only pulls `@neondatabase/serverless` for the Vercel functions)

### Code structure inside index.html
The file follows this layout top to bottom:
1. **CDN script tags** — React, Three.js, JSZip
2. **htm parser** — custom tagged template engine (~80 lines)
3. **CSS** — all styles in a single `<style>` block, using CSS custom properties for theming
4. **Boot screen** — loading spinner shown before JS executes
5. **Main `<script>`** — everything else:
   - `startApp()` wraps the entire application
   - Constants, state shape (`INIT`), reducer
   - IFC loader (uses web-ifc WASM library, lazy-loaded via ESM)
   - Three.js scene setup, orbit controls, render loop
   - Fly-to system, ghost/highlight system, section planes, section box
   - Clash detection engine (AABB broad-phase + BVH tri-tri narrow-phase, Möller–Trumbore)
   - BCF import/export
   - All UI components as functions returning `html\`...\`` tagged templates
   - App component, mount

### Key patterns
- **Tagged templates**: `html\`<div>...</div>\`` instead of JSX. Uses `${expr}` for interpolation.
- **IIFE in templates**: Complex render logic uses `${condition && function(){ ... }()}` pattern.
- **Render on demand**: Global `invalidate(frames)` + `_needsRender` counter. The render loop skips GPU work when nothing changes. Call `invalidate()` after any visual change.
- **Conditional mounting**: UI components use `${condition && html\`...\``}` for lazy rendering — Preact only mounts when condition is true.
- **Material swapping**: Render styles (standard/shaded/rendered/wireframe) swap mesh materials. Original saved as `mesh._origMaterial`.
- **Ghost material**: Shared `MeshBasicMaterial({color:0x334155, opacity:0.08})` replaces mesh materials for transparency effect.
- **State management**: Single `useReducer` with action types like `{t:'LOAD_MODEL', ...}`. Dispatch available globally as `window._ccDispatch`.
- **CSS custom properties**: `:root` = dark theme, `[data-theme=light]` = light theme.

## Important conventions

### Versioning
- Version lives in `version.json` (major.minor.patch)
- `scripts/bump-version.sh` runs as a pre-commit hook when `index.html` is staged
- It auto-increments patch, updates `version.json`, injects version into `index.html`, updates `README.md` version badge, and appends commit message to `CHANGELOG.md`
- Current version: check `version.json`

### Globals discipline
There are ~280 `window._cc*` globals — do not add to the sprawl casually.
- `window._cc*` is for **internal plumbing only** (core ↔ addon contracts). Always guard calls with `typeof window._ccFoo === 'function'`.
- Anything meant for users, automation, or external tools goes on the **`window.ClashControl.*` namespace** (defined near `_ccViewport` in index.html) as a thin guarded alias — follow the existing pattern there.
- Before adding a new global, check whether an existing one already covers it.

### Git / PR workflow
- **Don't open a pull request for every change.** Pile up commits on the working branch and only open a PR when starting a new piece of work, or if a single change is really big/risky enough to warrant its own review checkpoint. Repeatedly opening-and-merging a PR per small increment is noisy and not the desired cadence.

### When making changes
- **Always edit `index.html`** — that's where all the code is
- **Call `invalidate()`** after any change that affects the 3D view (camera, materials, visibility, highlights, ghost, grid, etc.)
- **Don't add new files** unless absolutely necessary — this is a single-file app by design
- **Don't add npm/build tooling** — the app runs directly in the browser
- **Keep the CHANGELOG.md updated** — the bump script handles this automatically on commit
- **Test by opening index.html** in a browser after changes

### Things NOT to touch without good reason
- The htm parser at the top of the script — it's hand-written and tested
- The IFC loader (web-ifc integration) — complex but working, handles property/material extraction
- The clash detection engine (AABB broad-phase + BVH tri-tri narrow-phase) — geometrically sensitive code
- The render-on-demand system (`_needsRender` / `invalidate`) — breaking this causes either no rendering or constant GPU waste

### Known quirks
- Three.js r180 is loaded as ESM via an import map (bumped from UMD r128 in v5.19.12) — use r180 docs; post-r155 color management / lighting defaults are explicitly tuned in the renderer setup, don't "fix" them back
- The view cube uses quaternion inversion (`cubeGroup.quaternion.copy(camera.quaternion).invert()`) — don't switch to camera-position approach, it causes mirroring
- Fly-to auto-detects whether to preserve camera angle or re-orient based on travel distance vs current camera distance
- The pre-commit hook only triggers when `index.html` is in the staged files

## File overview
```
index.html                  — The core application (UI, state, 3D viewer, clash engine)
cc-runtime.js               — No-build runtime module: service registry, deduplicating addon script loader, load-session coordinator (UMD; also consumed by node:test)
version.json                — Current version numbers
CHANGELOG.md                — Version history (auto-updated on commit)
README.md                   — Project readme with version badge
DESIGN.md                   — UI/UX design principles
AS_BUILT_DEVIATION.md       — Scope/roadmap: point-cloud-vs-BIM surface deviation (status, build plan, Wkb/Bbl Borger framing)
REDUCER_DECOMPOSITION_PLAN.md — Status + narrow-slices plan for separating the reducer's state transitions from its inline side effects (persistence, analytics, cache invalidation, event wiring, loader lifecycle)
LICENSE                     — License file
OPEN_SOURCE_COMPONENTS.md   — Third-party library credits
manifest.json               — PWA manifest for installable app
sw.js                       — Service worker for offline caching (excludes /api/*)
icons/                      — PWA icons (192/512 px, normal + maskable)
scripts/bump-version.sh     — Pre-commit version bump script
scripts/generate-sri.js     — Generate SRI hashes for CDN scripts
vercel.json                 — Vercel config: function durations, redirects (NO headers block — COOP/COEP are NOT set; the app is not cross-origin isolated, so SharedArrayBuffer/multithreaded WASM are unavailable in production)
package.json                — Neon Postgres driver for serverless functions
addons/accessibility.js     — Deterministic building-code geometry checks (door width, thresholds, ramp slope, corridor/turning) with NL Bbl/NEN defaults
addons/align.js             — Point-cloud ↔ IFC manual 3-point rigid alignment (as-built verification)
addons/data-quality.js      — Data quality / BIM / ILS-NL/SfB check engines
addons/local-engine.js      — Bridge to localhost Python native-speed clash engine (same Möller tri-tri + BVH algorithm as the browser, not solid boolean ops)
addons/openaec-bridge.js    — Bridge to OpenAEC Foundation sibling apps (Phase 1: open-pointcloud-studio over localhost HTTP)
addons/geoplace.js          — Real-world basemap placement (IfcSite lat/lon + IFC4 map conversion), tiles via /api/tile
addons/pointcloud.js        — Load LAS/PLY/PCD/XYZ/PTS/PTX point clouds as reference layers
addons/pwa.js               — Service worker registration, install prompt, update check
addons/revit-bridge.js      — Revit Connector WebSocket live link + clash push-back
addons/shared-project.js    — File System Access folder-sync collaboration
addons/smart-bridge.js      — LLM bridge (MCP / ChatGPT / REST) — executes tool calls from AI assistants
addons/splat.js             — Gaussian Splat as-built captures as a first-class scene layer (.splat/.ply/.ksplat/.spz)
addons/tiles.js              — Streams photorealistic 3D Tiles (Google/Cesium/any tileset) as real-world context around a georeferenced model
addons/training-data.js     — Training data storage, JSONL export, sharing
addons/visibility.js        — Visibility (sight-line) clash detection — ray-cast against BVH for viewer/target/obstructer rules + regulation presets
addons/wasm-engine.js       — Rust WASM clash accelerator (mesh_intersect / mesh_min_distance), JS fallback
api/health.js               — Health check: AI + DB status
api/nl.js                   — NL proxy: Groq-only (OpenAI tool-calling). Basic tier; clash-solving nudges to the Connector
api/training.js             — Training data ingestion (replaces Google Forms)
api/project.js              — Shared issues sync (project key, no login)
api/title.js                — AI clash title generation (batch, Gemma 4)
api/triage.js               — AI clash triage (cluster context → severity / explanation / resolution)
api/tile.js                 — Map-tile proxy for the geoplace basemap (MapTiler when keyed, else OSM)
api/_lib.js                 — Shared serverless helpers (CORS allow-list, rate limiter)
```

## Addons — how they plug in

> **Vocabulary:** in user-facing UI these are always called **Integrations**
> (tab title, header button, palette entry). "Addon" is the internal/code
> term only (`addons/` dir, `_ccRegisterAddon`, docs). Don't mix them in UI copy.

Each addon is a plain IIFE loaded at runtime by the core via `addons/<name>.js` (see `_loadAddonScripts` / `_ccEnsureAddon` near the top of `index.html`'s main script; script fetching is deduplicated by `cc-runtime.js`). They share state with the core by:

- Reading globals the core exposes (e.g. `window._ccDispatch`, `window._ccBakeMesh`, `window._ccUid`)
- Registering callbacks the core calls into (e.g. `window._ccRunDataQualityChecks`)

### Rules for addons
- **The core app must still work if an addon fails to load.** Guard any core code that calls an addon with a `typeof window._ccFoo === 'function'` check.
- **Addons never mount their own React components.** The panel UI (e.g. Data Quality, Training Pill) lives in `index.html`; addons only expose data/utility functions.
- **No cross-addon imports.** If two addons need to share code, it either lives in the core or each addon has its own copy.
- **Put new heavy features here first.** If a feature is optional, rarely used, or loads large data, make it an addon instead of bloating `index.html`.

### What each addon does
- `accessibility.js` — Deterministic building-code geometry checks (door clear width, threshold height, ramp slope, corridor/turning clearance) with NL Bbl/NEN defaults, overridable thresholds. Exposed via `window._ccRunAccessibilityChecks`.
- `data-quality.js` — All check engines used by the Data Quality panel (BIM basics, ILS, NL-SfB classification checks). Exposed via `window._ccRunDataQualityChecks` et al.
- `local-engine.js` — Talks to the localhost `clashcontrol-engine` Python server (port 19800) for native-speed mesh intersection — the *same* Möller tri-tri + BVH algorithm as the browser engine (Numba JIT + multiprocess + scipy KD-tree), not true solid boolean ops; escalating to it buys speed, not more-correct geometry. Transparently falls back to the core AABB+BVH engine when the server isn't running, or when the active ruleset includes a rule field the engine can't honor (see `window._ccLocalEngineCanHandle` and the wire-contract note atop the addon file). Version-agnostic — reads the live engine version from `/status` and the latest release tag from GitHub at runtime; not pinned to a specific engine release.
- `geoplace.js` — Places the loaded model on a real-world raster basemap. Reads `IfcSite` RefLatitude/Longitude (and the IFC4 `IfcMapConversion`/`IfcProjectedCRS` georef the core extracts into `spatialHierarchy.mapConversion`), or accepts a manual lat/lon, then stitches map tiles (via the same-origin `/api/tile` proxy) onto a ground plane. The model never moves — the basemap is positioned in IFC space. No reprojection (proj4js) yet; projected CRS data is read for display + the pre-run placement-sanity check only.
- `pointcloud.js` — Loads LAS/PLY/PCD/XYZ point clouds as reference layers (e.g. survey scans), recentred near origin for precision. Display-only; not fed to the clash engine.
- `pwa.js` — Service-worker registration, update polling, and the "install as app" prompt. Everything else in the app works without it.
- `revit-bridge.js` — WebSocket live link to the ClashControl Connector Revit plugin. Ingests geometry + properties, converts to Three.js meshes, supports `REPLACE_MODEL` on re-sync and linked models. Also handles one-way push of clashes back to Revit.
- `shared-project.js` — File System Access API collaboration. Users pick a shared folder (OneDrive/Dropbox/NAS), and a `.ccproject` file is synced every 60s. No backend.
- `smart-bridge.js` — LLM bridge connecting ClashControl to AI assistants over WebSocket: Claude Desktop/Code via the bundled MCP server, ChatGPT via a REST bridge + OpenAPI Actions, or any function-calling LLM via REST. Receives tool calls from the bridge server (localhost:19802) and executes them through `window._ccDispatch` and friends.
- `splat.js` — Loads 3D Gaussian Splat as-built captures (.splat/.ply/.ksplat/.spz) as a first-class scene layer alongside IFC and point clouds, via Spark.js on its own r180 ESM canvas synced to the core camera.
- `tiles.js` — Streams photorealistic 3D Tiles (Google Photorealistic, Cesium ion, or any tileset URL) as real-world context around a georeferenced model via NASA-AMMOS 3DTilesRendererJS. The model never moves; the tileset is placed in ENU/ECEF space around the anchor.
- `training-data.js` — Pure data layer for clash + NL training data: ring-buffer storage (cap 5000 clash / 2000 NL), JSONL export, share helpers.
- `wasm-engine.js` — Loads the Rust WASM module for hardware-accelerated clash detection, exposing `window._ccWasmIntersect` / `window._ccWasmMinDist` as drop-in replacements for the JS BVH+Möller engine. Falls back to the built-in JS engine if WASM fails to load.

## Backend (Vercel Serverless + Neon Postgres)

The app is deployed at `www.clashcontrol.io` on Vercel. The backend consists of serverless functions in the `api/` directory.

### Environment Variables (set in Vercel dashboard)
- `GROQ_API_KEY` — Groq API key. **The backend for `/api/nl`** (fast, generous free tier; OpenAI-compatible function calling). Default model `llama-3.3-70b-versatile`, overridable via `GROQ_MODEL`. When unset, `/api/nl` returns 503 and the client uses its built-in offline regex commands. **Gemma was dropped from `/api/nl`** (unreliable free-tier quota).
- `GEMINI_API_KEY` — Google AI Studio API key for Gemma 4 — used by `/api/title` and `/api/triage` (the NL endpoint no longer uses Gemma; legacy `GOOGLE_AI_KEY` also accepted)
- `POSTGRES_URL` — Vercel Postgres / Neon connection string (auto-injected when you link a Vercel Postgres database; legacy `DATABASE_URL` also accepted)
- `MAPTILER_KEY` — (optional) MapTiler key for satellite basemap tiles via `/api/tile`. When unset, the proxy serves OpenStreetMap tiles.

### API Endpoints
- `GET /api/health` — Returns `{ ai: bool, db: bool, model: string }`
- `POST /api/nl` — NL command proxy. Body: `{ command, context, replyContext }`. Returns `{ intent, ...params }`
- `POST /api/training` — Training data. Requires `X-CC-Consent: true` header. Types: `nl_command`, `clash_feedback`, `detection_run`
- `POST /api/project` — Create shared project. Returns `{ id, name }`
- `GET /api/project?id=KEY` — Pull all shared issues for a project
- `PUT /api/project?id=KEY` — Push issue changes. Body: `{ issues, user }`
- `POST /api/title` — Generate AI titles. Body: `{ clashes: [...] }` (max 20)
- `POST /api/triage` — AI clash triage for a cluster. Body: cluster context packet. Returns `{ title, severity, explanation, resolution_options[] }`
- `GET /api/tile?z=&x=&y=` — Map-tile proxy for the geoplace basemap (MapTiler satellite when `MAPTILER_KEY` is set, else OpenStreetMap)

### NL Command Flow (tiered AI)
**Basic = Groq (server-side); more = your own LLM via the one-click Connector.**
1. Client sends command to `/api/nl` → **Groq** (OpenAI-compatible `tool_calls` over the tool declarations). Default `llama-3.3-70b-versatile` (`GROQ_MODEL` overridable). Returns structured `{ intent, _model, _fallback, ...params }` — no fragile JSON parsing. Gemma was dropped (unreliable free-tier quota).
2. The built-in assistant is intentionally **basic**. When a command asks to *resolve/fix a clash* (resolution verb + clash noun), the client routes to the user's **own LLM via the Smart Bridge Connector** (`http://127.0.0.1:19803/chat`) when connected, otherwise shows a one-click-connect **nudge** — the bring-your-own-LLM / future paid tier.
3. If Groq is over quota/down, the client uses the connected own-LLM (if any), then falls back to built-in offline regex commands. The over-quota message points to the one-click Connector.

### Shared Issues
- No login required. Uses shareable project keys (e.g., `MEP-abc123`)
- Shared records are minimal (~250 bytes): identity (GlobalIds) + team decisions (status, priority, assignee, title)
- IFC metadata (types, names, storeys, materials) is derived locally from each user's loaded model
- Conflict resolution: last-write-wins per issue
