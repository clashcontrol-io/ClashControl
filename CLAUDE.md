# CLAUDE.md — Project Guide for AI Assistants

## What is this?
ClashControl is a free, open-source IFC clash detection web app. It lets users load IFC building models, detect geometric clashes between elements, create/manage issues, and export to BCF format.

## Architecture — Single File App + Lazy Addons
The **core application** lives in `index.html` (~19.8k lines). There is no build step, no bundler, no node_modules. Just open the file in a browser.

Optional, non-critical features are split into lazy-loaded files under `addons/` (see the Addons section below). These are loaded at runtime via a simple `<script src="addons/<name>.js">` injection and the core app works without them.

### Tech stack
- **Preact/React 18** via CDN (UMD) — UI framework
- **htm** — hand-written tagged template literal parser (inlined in the file, replaces JSX)
- **Three.js r128** via CDN — 3D rendering
- **JSZip** via CDN — BCF zip export/import
- **pdf.js** via CDN — PDF preview/overlay in the Issues panel
- **web-ifc** WASM — IFC parsing, lazy-loaded via ESM on first model load
- CDN scripts are pinned with SRI integrity hashes (regenerate with `node scripts/generate-sri.js` when bumping versions)
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
   - Clash detection engine (OBB-based)
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
- The OBB clash detection engine — geometrically sensitive code
- The render-on-demand system (`_needsRender` / `invalidate`) — breaking this causes either no rendering or constant GPU waste

### Known quirks
- Three.js r128 is used (not latest) — some newer Three.js APIs won't work
- The view cube uses quaternion inversion (`cubeGroup.quaternion.copy(camera.quaternion).invert()`) — don't switch to camera-position approach, it causes mirroring
- Fly-to auto-detects whether to preserve camera angle or re-orient based on travel distance vs current camera distance
- The pre-commit hook only triggers when `index.html` is in the staged files

## File overview
```
index.html                  — The core application (UI, state, 3D viewer, clash engine)
version.json                — Current version numbers
CHANGELOG.md                — Version history (auto-updated on commit)
README.md                   — Project readme with version badge
DESIGN.md                   — UI/UX design principles
LICENSE                     — License file
OPEN_SOURCE_COMPONENTS.md   — Third-party library credits
manifest.json               — PWA manifest for installable app
sw.js                       — Service worker for offline caching (excludes /api/*)
scripts/bump-version.sh     — Pre-commit version bump script
scripts/generate-sri.js     — Generate SRI hashes for CDN scripts
vercel.json                 — Vercel config: COOP/COEP headers, function durations
package.json                — Neon Postgres driver for serverless functions
addons/data-quality.js      — Data quality / BIM / ILS-NL/SfB check engines
addons/local-engine.js      — Bridge to localhost Python exact-mesh clash engine
addons/pwa.js               — Service worker registration, install prompt, update check
addons/revit-bridge.js      — Revit Connector WebSocket live link + clash push-back
addons/shared-project.js    — File System Access folder-sync collaboration
addons/training-data.js     — Training data storage, JSONL export, sharing
api/health.js               — Health check: AI + DB status
api/nl.js                   — Gemma 4 NL proxy with native function calling + quota fallback
api/training.js             — Training data ingestion (replaces Google Forms)
api/project.js              — Shared issues sync (project key, no login)
api/title.js                — AI clash title generation (batch, Gemma 4)
```

## Addons — how they plug in

Each addon is a plain IIFE loaded at runtime by the core via `addons/<name>.js` (see the `_ccLoadAddon` helper near the top of `index.html`'s main script). They share state with the core by:

- Reading globals the core exposes (e.g. `window._ccDispatch`, `window._ccBakeMesh`, `window._ccUid`)
- Registering callbacks the core calls into (e.g. `window._ccRunDataQualityChecks`)

### Rules for addons
- **The core app must still work if an addon fails to load.** Guard any core code that calls an addon with a `typeof window._ccFoo === 'function'` check.
- **Addons never mount their own React components.** The panel UI (e.g. Data Quality, Training Pill) lives in `index.html`; addons only expose data/utility functions.
- **No cross-addon imports.** If two addons need to share code, it either lives in the core or each addon has its own copy.
- **Put new heavy features here first.** If a feature is optional, rarely used, or loads large data, make it an addon instead of bloating `index.html`.

### What each addon does
- `data-quality.js` — All check engines used by the Data Quality panel (BIM basics, ILS, NL-SfB classification checks). Exposed via `window._ccRunDataQualityChecks` et al.
- `local-engine.js` — Talks to the localhost `clashcontrol-engine` Python server (port 19800) for exact mesh intersection. Transparently falls back to the core OBB engine when the server isn't running. Targets `clashcontrol-engine` v0.2.2.
- `pwa.js` — Service-worker registration, update polling, and the "install as app" prompt. Everything else in the app works without it.
- `revit-bridge.js` — WebSocket live link to the ClashControl Connector Revit plugin. Ingests geometry + properties, converts to Three.js meshes, supports `REPLACE_MODEL` on re-sync and linked models. Also handles one-way push of clashes back to Revit.
- `shared-project.js` — File System Access API collaboration. Users pick a shared folder (OneDrive/Dropbox/NAS), and a `.ccproject` file is synced every 60s. No backend.
- `training-data.js` — Pure data layer for clash + NL training data: ring-buffer storage (cap 5000 clash / 2000 NL), JSONL export, share helpers.

## Backend (Vercel Serverless + Neon Postgres)

The app is deployed at `www.clashcontrol.io` on Vercel. The backend consists of serverless functions in the `api/` directory.

### Environment Variables (set in Vercel dashboard)
- `GEMINI_API_KEY` — Google AI Studio API key for Gemma 4 (legacy `GOOGLE_AI_KEY` also accepted)
- `POSTGRES_URL` — Vercel Postgres / Neon connection string (auto-injected when you link a Vercel Postgres database; legacy `DATABASE_URL` also accepted)

### API Endpoints
- `GET /api/health` — Returns `{ ai: bool, db: bool, model: string }`
- `POST /api/nl` — NL command proxy. Body: `{ command, context, replyContext }`. Returns `{ intent, ...params }`
- `POST /api/training` — Training data. Requires `X-CC-Consent: true` header. Types: `nl_command`, `clash_feedback`, `detection_run`
- `POST /api/project` — Create shared project. Returns `{ id, name }`
- `GET /api/project?id=KEY` — Pull all shared issues for a project
- `PUT /api/project?id=KEY` — Push issue changes. Body: `{ issues, user }`
- `POST /api/title` — Generate AI titles. Body: `{ clashes: [...] }` (max 20)

### NL Command Flow
1. Client sends command to `/api/nl` (Gemma 4, server-side)
2. Server picks a primary model — `SMART_MODEL` for analytical commands (analyze, explain, compare, …), `FAST_MODEL` for everything else
3. Gemma 4 uses native function calling with 13 tool declarations
4. On HTTP 429 the server walks a fallback chain across the other Gemma variant (each variant has its own free-tier quota bucket, so the effective quota is roughly doubled)
5. Server returns structured `{ intent, _model, _fallback, ...params }` — no fragile JSON parsing
6. Only when *every* model in the chain is drained does the client fall back to regex matching (offline mode)

### Shared Issues
- No login required. Uses shareable project keys (e.g., `MEP-abc123`)
- Shared records are minimal (~250 bytes): identity (GlobalIds) + team decisions (status, priority, assignee, title)
- IFC metadata (types, names, storeys, materials) is derived locally from each user's loaded model
- Conflict resolution: last-write-wins per issue
