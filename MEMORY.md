# ClashControl — Shared Session Memory

> Auto-updated daily by `.github/workflows/daily-sync.yml`.
> **Every new Claude session should read this file first** to avoid re-implementing things,
> repeating past mistakes, or working against current direction.
> Update the Active Work and Project State sections as you make progress.

---

<!-- BEGIN:project-state -->
## Project State

**Version:** 4.15.4 (2026-04-16)

**Live features (all working):**
- OBB-based clash detection engine with rules (discipline filters, clearance, group-by)
- BCF 2.1 import/export (viewpoints, markup, snapshots)
- IFC loading via web-ifc WASM (lazy, with geometry + property extraction)
- AI NL command interface (Gemma 4 via `/api/nl`, 13 tool declarations, native function calling)
- Shared projects (no login, project keys, Neon Postgres backend)
- Data quality checks addon (BIM basics, ILS, NL-SfB classification)
- Smart Bridge: MCP server (`mcp-server.js`) for IDE/AI tool integration
- Revit connector addon (WebSocket live sync, clash push-back)
- Walk mode (FPS navigation with eye height, FOV scroll, unit-aware speed)
- 2D sheet view (Revit-style floor plan: polygon chaining, SVG export, paper size/scale settings)
- Section planes + section box (interactive clipping)
- Issues panel (status, priority, assignee, PDF overlay, viewpoints)
- Training data addon (ring-buffer, JSONL export, sharing)
- PWA (service worker, install prompt, offline caching)
- IDS format export/import for data quality checks
- Shift+click multi-select in navigator tree
- Color-grade FPS counter (grey→red based on framerate)
- Render style hotkeys 1–4 (standard/shaded/rendered/wireframe)

**Backend (Vercel serverless + Neon Postgres):**
- `/api/nl` — Gemma 4 NL proxy (SMART_MODEL for analytical, FAST_MODEL for everything else)
- `/api/title` — batch AI clash title generation
- `/api/project` — shared issue sync
- `/api/training` — training data ingestion
- `/api/health` — AI + DB status

**Deployment:** `www.clashcontrol.io` on Vercel. No CI/CD for the frontend — merging to `main` triggers a version bump workflow only.
<!-- END:project-state -->

<!-- BEGIN:architecture-decisions -->
## Architecture Decisions

These are permanent. Do not remove entries — add new ones when significant decisions are made.

| Date | Decision | Reason |
|------|----------|--------|
| founding | Single `index.html` app, no build step | Zero setup for users; open-source transparency; easy to fork/inspect |
| founding | Three.js r128 (pinned, not latest) | API stability; newer versions break existing render/material code |
| founding | OBB clash detection (not exact mesh) | Order-of-magnitude faster; exact mesh available via optional `local-engine.js` addon |
| founding | CDN deps pinned with SRI hashes | Reproducible builds; integrity verification |
| founding | Addons pattern (`addons/*.js` IIFE) | Keeps `index.html` lean; optional features don't block initial load |
| founding | Preact/React via CDN UMD (not ESM) | Avoids bundler; works with htm tagged templates inline |
| founding | htm instead of JSX | No transpilation; hand-written parser inlined in the file |
| 2026-04-10 | Stripped ~1960 what-comments from index.html | Comments explained what, not why; moved to INTERNALS.md; reduces file size |
| 2026-04-10 | Camera globals consolidated into `_ccViewport` | Single source of truth for camera/canvas state; avoids global variable sprawl |
| 2026-04-10 | View cube uses `camera.quaternion.copy().invert()` | Camera-position approach causes left/right mirroring; quaternion inversion is correct |
| 2026-04-13 | `processNLCommandWithLLM` wraps `/smart` command | Ensures async handling; keeps NL pipeline consistent |
| 2026-04-15 | 2D sheet uses polygon-face section cut | Correct floor-plan geometry without full mesh boolean ops |
<!-- END:architecture-decisions -->

<!-- BEGIN:known-issues -->
## Known Issues & Gotchas

Things to be careful about. Do not remove without a good reason — add a note if something is fixed.

- **Three.js r128 API**: Use r128 docs. `BufferGeometry.setAttribute`, not `addAttribute`. `MeshStandardMaterial` not `MeshPhysicalMaterial` for standard use.
- **View cube mirroring**: The nav cube MUST use `cubeGroup.quaternion.copy(camera.quaternion).invert()`. Camera-position approach causes left/right mirror. Don't "fix" this.
- **web-ifc WASM hang**: A 10-second timeout detects WASM init hangs (slow connections). Don't remove this guard.
- **IFC unit scale**: Storey elevations from IFC are often in mm; geometry is in metres. Always apply `geoFactor` when converting. Walk mode and 2D sheet have fixed this.
- **Ghost material is shared**: `MeshBasicMaterial({color:0x334155, opacity:0.08})` is one instance shared across all ghost meshes. Don't dispose it per-mesh.
- **`invalidate()` required**: Any visual change (material swap, visibility, highlight, grid, ghost) needs `invalidate()` or it won't render until the next interaction.
- **Render loop skips GPU work**: `_needsRender` counter > 0 means render. Counter decrements each frame. Call `invalidate(N)` for N frames of rendering.
- **Addon guard required**: Core code calling addon functions must guard with `typeof window._ccFoo === 'function'`. The app must work without addons.
- **Service worker excludes `/api/*`**: Don't add API paths to the SW cache list.
- **NL pre-block**: Conversational messages that look like commands are allowed through to Gemma. Don't make the pre-block over-eager.
- **2D annotation coordinates**: Fixed in v4.15.4. Coordinate bug was in annotation placement — if re-implementing annotation rendering, test coordinate transform carefully.
<!-- END:known-issues -->

<!-- BEGIN:active-work -->
## Active Work

Update this section at the start and end of each session.
Mark completed items with ~~strikethrough~~ and date, then let the daily sync archive them.

On branch `claude/review-clashcontrol-optimization-QhAYx` (review pass): wiring up data paths that were previously dangling.

- ~~BCF export/import round-trips Revit element IDs via `<Labels>` (cc:revitA/B)~~ (2026-04-21)
- ~~Shared project replay merges remote viewpoints by id~~ (2026-04-21)
- ~~Data Quality panel: per-check `+issue` button creates aggregated issue (source:'data_quality')~~ (2026-04-21)
- ~~Clash row: feedback badge shows aiReasons/aiResolution/aiNote outside training mode; issue summary no longer gated by trainingMode~~ (2026-04-21)
- ~~O(1) BVH LRU via insertion-ordered Map + ghost material cache prune on model unload~~ (2026-04-20)

<!-- END:active-work -->

<!-- BEGIN:session-log -->
### 2026-04-24
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 71ce56a chore: daily memory sync 2026-04-23

</details>

### 2026-04-23
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- f490af8 chore: daily memory sync 2026-04-22

</details>

### 2026-04-22
**Summary:** 5 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 4ffff92 chore: daily memory sync 2026-04-21
- 0dcb06b chore: bump version to 4.16.1
- 1b6c65e chore: update MEMORY.md active work log
- f88c625 feat: wire unused data paths — DQ→Issues, feedback badge, BCF revit IDs, shared viewpoints
- 4175de7 perf: O(1) BVH LRU + prune ghost mat cache on model unload

</details>

### 2026-04-21
**Summary:** 8 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 0dcb06b chore: bump version to 4.16.1
- 1b6c65e chore: update MEMORY.md active work log
- f88c625 feat: wire unused data paths — DQ→Issues, feedback badge, BCF revit IDs, shared viewpoints
- 4175de7 perf: O(1) BVH LRU + prune ghost mat cache on model unload
- b20d0cb chore: daily memory sync 2026-04-20
- 5e3e9be chore: bump version to 4.16.0
- 23a1dcd perf: replace persistent BVH cache with LRU-bounded cross-run cache
- 548aca6 perf: GPU instancing, GLB dedup, persistent BVH cache

</details>

### 2026-04-20
**Summary:** 4 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 5e3e9be chore: bump version to 4.16.0
- 23a1dcd perf: replace persistent BVH cache with LRU-bounded cross-run cache
- 548aca6 perf: GPU instancing, GLB dedup, persistent BVH cache
- f61d944 chore: daily memory sync 2026-04-19

</details>

### 2026-04-19
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- a646758 chore: daily memory sync 2026-04-18

</details>

### 2026-04-18
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- d7131ba feat: daily memory sync system for shared session continuity

</details>

## Session Log

Daily summaries, newest first. Entries older than 60 days are pruned to the Cleanup Log.

### 2026-04-17
**Summary:** Initial MEMORY.md created to establish shared session memory. Seeded with project state at v4.15.4, architecture decisions, and known issues.
**Changed:** MEMORY.md (new), scripts/update-memory.py (new), .github/workflows/daily-sync.yml (new), CLAUDE.md (updated)
**Notable:** Daily automation uses `ANTHROPIC_API_KEY` GitHub secret for AI-powered summaries; falls back to plain commit list if key absent. Set the secret in repo Settings → Secrets → Actions.
<!-- END:session-log -->

<!-- BEGIN:cleanup-log -->
## Cleanup Log

Records what was pruned from the session log and why. Permanent.

_Nothing pruned yet._

<!-- END:cleanup-log -->
