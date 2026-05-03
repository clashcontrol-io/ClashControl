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

On branch `claude/research-design-tools-TzNQG` (2026-05-03) — in progress:

- ~~ViewCube fix: renderer size 120→74, arrows removed, face-click navigation correct~~ (2026-05-03)
- ~~A1: All toolbar tooltip shortcut hints fixed/added; keyboard handlers added for O, R, F, N, I, B, W, Shift+M~~ (2026-05-03)
- ~~A2: Clashes panel — "Conflicts"→"Clashes", Group/Sort pills→compact `<select>` dropdowns~~ (2026-05-03)
- ~~A3: Issues panel — compact BCF Export `▼` dropdown, + From clash button, active clash pre-fills modal~~ (2026-05-03)
- ~~A4: Detection Rules panel — "Clash Rules"→"Detection Rules", "Hard always flagged"→"Always treat as hard clash" + tooltip, IFC type datalist autocomplete~~ (2026-05-03)
- ~~A5: Navigator panel — Spatial/Tree modes renamed ("Hierarchy"/"Flat list" + title hints), search shown in all modes (filters groups in classification views)~~ (2026-05-03)
- ~~A6: Data Quality panel — severity legend dots, last-checked timestamp, Export CSV button, Create all issues bulk button, IDS section in labeled card~~ (2026-05-03)
- ~~B2: PDF export via `window.print()` — toolbar button captures 3D canvas screenshot into print-ready page~~ (2026-05-03)
- ~~B3: Walkthrough recording — `canvas.captureStream()` + MediaRecorder → .webm download; Record toolbar button with active state~~ (2026-05-03)
- ~~B4: Material preview in Rendered mode — keyword PBR presets (glass/metal/concrete/wood/brick/gypsum/insulation)~~ (2026-05-03)
- ~~B5: X-Ray render style (key 5) — all geometry semi-transparent (opacity 0.22, DoubleSide)~~ (2026-05-03)
- ~~B6 (partial): Area measurement toolbar button exposed (was Cmd+K only)~~ (2026-05-03)

**Pending (next session):**
- B1: Unified comment system with threads
- B6 (remaining): Hover coordinate display (X/Y/Z tooltip on any surface)
- B7: Design option compare (sliding curtain between two model versions)
- B8: Saved selection sets
- Navigator: per-storey hide/show toggle

On branch `claude/redesign-modern-ui-JLbhU` (2026-05-01) — landed:

- ~~Tokens: paper / ink / terracotta palette; legacy `--bg-primary` / `--accent` tokens aliased so 19k lines auto-pick up the new aesthetic~~ (2026-05-01)
- ~~Typography: Fraunces (display, opsz) + Instrument Sans (body) + DM Mono — Inter / Roboto / Syne all dropped per anthropics/skills frontend-design guidance~~ (2026-05-01)
- ~~Light theme by default; pre-paint script reads `cc_theme` to avoid flash~~ (2026-05-01)
- ~~Workspace switcher (Present / Coordinate / Review) in DesktopTopBar with `cc_workspace` persistence + `A.SET_WORKSPACE` action; ephemeral `avatarMenuOpen` separate from persisted `cc_panelOpen` / `cc_inspectorOpen` / `cc_askOpen` / `cc_diagnostics`~~ (2026-05-01)
- ~~AvatarMenu component (avatar circle bottom-right of top bar): consolidates project switcher, theme toggle, settings, presentation, keyboard-shortcuts trigger, "Open model"~~ (2026-05-01)
- ~~Horizontal xeokit-style TopToolbar (View · Section · Measure · Camera · Notes · Style) replaces the prior PR-2 bottom mode pill; ModeToolbar aliased to `() => null`~~ (2026-05-01)
- ~~LeftRail rewritten: returns null in Present, slim 48-px workspace-scoped tab list in Coordinate / Review (project switcher / IFC / walk / 2D / share / theme / settings buttons all removed — they have new homes)~~ (2026-05-01)
- ~~Ask AI demoted: 36-px round bottom-right canvas button with chat-bubble glyph; pulsing violet pill removed; `nlBorderPulse` keyframe neutralised~~ (2026-05-01)
- ~~WelcomePopup redesigned: asymmetric paper card, Fraunces "Open a model." headline, drawn isometric ballast, three flat row links (Choose · URL · Sample), no glass/dashed/scrim~~ (2026-05-01)
- ~~Conflict row: emoji icon (🔴/🟡/🏗/📌) replaced by 7-px severity dot using --sev-* tokens; storey 🏢 → hairline-bordered label; 💬 → text "note"; distance "⬤ 42mm gap" → mono "42 mm"~~ (2026-05-01)
- ~~FPS overlay gated behind `s.workspace==='review' && s.diagnostics` (off by default; toggle lives in LeftRail in Review)~~ (2026-05-01)
- ~~Sky gradient + grid: warm paper tones (--scene-floor → --scene-bg → --paper-bg); grid opacity 0.30 → 0.12; ACES Filmic tone mapping confirmed already on~~ (2026-05-01)
- ~~Glass tokens neutralised (`--glass-bg`/`--glass-border`/`--glass-blur` → solid surface + hairline + none); cc-overlay-chrome / DesktopTopBar / cc-mobile-nav backdrop-filter dropped~~ (2026-05-01)
- ~~Favicon flat ink mark (square outline + terracotta diagonal); boot screen flat ink + Fraunces wordmark; theme-color metatag #f5f2ec~~ (2026-05-01)

**Deferred** (next pass):
- Right Inspector drawer two-tab restructure (Details · Notes); the existing AIChatPanel is now reachable only via the small Ask button but its body wasn't restructured.
- Inline AI training feedback row on conflicts (`index.html:13860+`) — still inline; should move to Review › Improve.
- Cleanup of remaining `nlBorderPulse` animation calls (now no-ops on visible chrome but still wasted CPU).
- Sample-model URL in WelcomePopup uses an external GitHub raw — should ship a tiny bundled IFC instead.
- Soft contact shadow plane and 35° dollhouse fly-to on first model load — planned but not implemented this pass.
- Help / keyboard shortcuts modal (the AvatarMenu dispatches `cc-show-shortcuts` event but no listener mounts the overlay yet).

Earlier branch `claude/improve-ifc-viewer-ux-WhTsB`: full UI overhaul for architectural audience.
The PR-1..PR-8 overhaul shipped but felt AI-assembled (glass everywhere, violet
gradient, FPS overlay, status-pill explosions, raw IFC jargon on rows). This
pass resets type & chrome:

- Paper + ink + ONE terracotta accent (`#b8533a`); no glassmorphism, no
  gradients, no emoji in chrome. Light theme by default.
- Inter + DM Mono only (Syne dropped).
- Workspace switcher in the top bar — `Present` / `Coordinate` / `Review`.
  Present is the default and hides clash/IDS/training/diagnostics entirely.
- xeokit-bim-viewer style **horizontal top toolbar** (View · Section · Measure ·
  Camera · Notes · Style). Replaces the prior PR-2 bottom mode pill and the
  LeftRail tools.
- Single-path-per-function pass: each function has exactly one canonical
  surface + optional shortcut. Visible buttons everywhere — no hotkey-only
  affordances. Avatar menu consolidates project switcher / theme / settings /
  presentation / shortcuts.
- Ask AI demoted: small bottom-right round button only (no pulse, no glow,
  removed from right Inspector tabs).
- Persistence: workspace, theme, render style, tool, panel/inspector/Ask state,
  diagnostics, grid, floor shadow all write to `localStorage` and rehydrate.
- Cinematic defaults: ACES tone-mapping, soft contact shadow, faint horizon,
  grid opacity 0.12, 35° dollhouse fly-to on first model load.
- Conflict row simplified to severity dot + title + assignee. IFC type code
  and IDs hide under Inspector "Technical" disclosure.

Plan file: `/root/.claude/plans/there-has-been-a-gentle-ember.md`.

Earlier branch `claude/improve-ifc-viewer-ux-WhTsB`: full UI overhaul for architectural audience.
Full 8-PR migration completed (2026-04-30):

- ~~PR-1: violet accent (#7c3aed), rounder radii, glass surface tokens~~ (2026-04-30)
- ~~PR-2: bottom ModeToolbar — Orbit/Walk/Slice/Measure/Plan/Note chips~~ (2026-04-30)
- ~~PR-3: DesktopTopBar (slim, glass, Share accent pill)~~ (2026-04-30)
- ~~PR-4: violet left rail tabs, grid opacity 0.3, blue→violet color sweep~~ (2026-04-30)
- ~~PR-5: Right drawer — AIChatPanel gains Details + Ask AI tabs; polls window._ccSelectedEl; shows element type/name/floor/psets/linked issues~~ (2026-04-30)
- ~~PR-6: Naming pass — Clashes→Conflicts, Addons→Integrations, Viewpoints→Saved views, Storey→Floor in all UI labels~~ (2026-04-30)
- ~~PR-7: ModelLoadCard replaces WelcomePopup — drag/drop or click to browse, open from URL, link shared folder; shown only when models.length===0~~ (2026-04-30)
- ~~PR-8: Overlay panels (LeftRail/LeftPanel float over canvas); mode mutex in reducer; Slice sub-tool position slider; ModeToolbar feature flag removed~~ (2026-04-30)

Also resolved conflict with origin/main: kept revit keep-partial/discard buttons from `9772053`, used violet CSS tokens.

UI_OVERHAUL.md written (7 chapters, 1469 lines). PLAN.md updated.

<!-- END:active-work -->

<!-- BEGIN:session-log -->
### 2026-05-03
**Summary:** 12 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 1f5a225 chore: bump version to 5.2.3
- aa978cc Cmd-K: reorder items within each group by current workspace
- f326556 Revert "Cmd-K palette: workspace-aware ordering and filtering"
- 3551c35 Cmd-K palette: workspace-aware ordering and filtering
- cdbea34 Toolbar tooltips: design-system styling
- 7dc5520 chore: bump version to 5.2.2
- 3070986 UI polish: remove LeftRail, fix Style dropdown, resize ViewCube, clean up viewer
- 3f2e982 chore: bump version to 5.2.1
- b8201f0 perf(render): Hidden Line uses one shared Lambert, not N per-mesh
- 510c772 fix(ui): post-screenshot polish — welcome hides on load, restore Review, toolbar icons
- a2a55de chore: daily memory sync 2026-05-02
- c4e11b9 chore: bump version to 5.2.0

</details>

### 2026-05-02
**Summary:** 63 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- c4e11b9 chore: bump version to 5.2.0
- e56937a feat(ui): DOM-anchored 3D clash chips — selection title floats above the model
- 3be9ba5 feat(ui): Tier 3 — load progress card, tonal canvas, single icon scale, draw-in welcome
- 3f1a4e7 feat(ui): Tier 2 — Cmd-K palette, fold Review→Coordinate, share promoted, copy clearer
- 38d8bf0 feat(ui): Tier 1 — kill violet bleed, forest brand mark, wire shortcuts modal
- 79c1c16 chore: bump version to 5.1.14
- 5291125 Distribute remaining integrations into their natural places
- 0d9f7a1 Distribute integrations to logical contexts; demote unified menu
- eefc593 Sweep remaining blue colors from user-facing UI
- 46e258e Replace remaining blue accents in clash/issues UI; clean up mobile chrome
- 5c975df Hide ground shadow when all models are unchecked
- 490c143 chore: bump version to 5.1.13
- dedfabd Fix element picker selecting wrong element (wall click picking beam)
- a75d334 Add inline project rename + responsive layout fixes
- c7cc7a7 Add Ctrl/Cmd+Click to multi-select elements in 3D viewer
- 9ed2d11 chore: bump version to 5.1.12
- f96160c Fix toolbar tooltip (remove native title attr) and redesign Present details as property table
- f497440 File-load opens right-panel Models tab; ViewCube arrows only on axis-aligned views
- 52914bc Fix ground plane floating; hide Models tab label in right panel
- 0b69d75 chore: bump version to 5.1.11
- 3b90853 Models toolbar button toggles right panel (Models tab), not left panel
- 2a652eb Models button back to toolbar; 2D underlay stays in 3D; ground plane glass fix
- 4648dac Ground plane cutout, Integrations redesign, Details auto-open on element click
- 3e7d6ac chore: bump version to 5.1.10
- d498e2b UI reorganization: models to right panel, navigator to review, integrations to avatar menu, toolbar tooltips
- 3c0e721 Memory optimizations: remove LOD proxy system, strip _glbBuffer from state, free geoCache
- b3596a8 chore: bump version to 5.1.9
- 9f7f1f9 ModelSidebar: tighten spacing and sizing in redesign
- 0cded3c UI fixes: LOC boxes, ViewCube, tabs, modals, toolbar
- 557fb29 chore: bump version to 5.1.8
- 442263f Present prose, toolbar Ask AI, +Add dropdown, panel cleanup
- 15a7735 chore: bump version to 5.1.7
- 79ebeb2 Section box face arrows + Revit-style ViewCube
- 1e15b87 chore: bump version to 5.1.6
- 3e268c0 Workspaces renamed + inspector depth + UX polish
- 1a2c18c Section box: Revit-style — fits selected element, falls back to full model
- 7881f80 Popovers, walk HUD redesign, hover fix + Enscape-style scroll speed
- cd6faaf Fix walk mode entry + default to Shaded style on load
- 55dc6c5 chore: bump version to 5.1.5
- 97836aa Render styles: Hidden Line mode + faster rendered view
- f651b61 fix(walk+inspector): free WASD walk, no forced details re-open
- a940172 feat(render): time-of-day sun, less-bright shaded, distinct standard
- 95b2e61 chore: bump version to 5.1.4
- 6b72c60 feat(toolbar+section): default to Standard, click-surface section, Add model
- 817f0a2 fix(render): IBL ambient, working sliders, no z-fighting, real ground plane
- b37640a chore: bump version to 5.1.3
- ab58a2f fix(toolbar+panels): unbreak app, redesign panel headers, drop sample model
- 21c6fb2 chore: daily memory sync 2026-05-01
- 963fb70 chore: bump version to 5.1.2
- d0731c5 feat(ui): zinc + forest palette, layout fix, Enscape walk, render quality
- 1b9b0ed fix(inspector): collapse right panel when element is deselected
- 027364f fix(ui): remove duplicate access points across viewer
- a20e0f4 chore: bump version to 5.1.1
- 3c3a46c feat(inspector): workspace-aware element details depth
- b7f46f1 fix(ui): clean white palette, remove emojis, deduplicate element panel
- 50cfd86 fix(ui): switch fonts to Syne + DM Sans, fix theme-color meta
- e09b517 chore: bump version to 5.1.0
- bf9e3a5 feat(ui): paper + ink + terracotta redesign — workspace switcher, xeokit toolbar, demoted Ask AI
- 71b094b chore: bump version to 5.0.3
- fa2d1a1 fix(mobile): hide right drawer entirely + add floating theme toggle (top-left)
- 939798e feat(theme): default to light mode (Figma/Sketch/Notion convention) — boot script applies before paint to prevent flash
- 413b0a9 chore: bump version to 5.0.2
- 0ce33ee fix: sky gradient addColorStop needs hex, not CSS variable (Canvas 2D doesn't resolve var(--))

</details>

### 2026-05-01
**Summary:** 64 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 963fb70 chore: bump version to 5.1.2
- d0731c5 feat(ui): zinc + forest palette, layout fix, Enscape walk, render quality
- 1b9b0ed fix(inspector): collapse right panel when element is deselected
- 027364f fix(ui): remove duplicate access points across viewer
- a20e0f4 chore: bump version to 5.1.1
- 3c3a46c feat(inspector): workspace-aware element details depth
- b7f46f1 fix(ui): clean white palette, remove emojis, deduplicate element panel
- 50cfd86 fix(ui): switch fonts to Syne + DM Sans, fix theme-color meta
- e09b517 chore: bump version to 5.1.0
- bf9e3a5 feat(ui): paper + ink + terracotta redesign — workspace switcher, xeokit toolbar, demoted Ask AI
- 71b094b chore: bump version to 5.0.3
- fa2d1a1 fix(mobile): hide right drawer entirely + add floating theme toggle (top-left)
- 939798e feat(theme): default to light mode (Figma/Sketch/Notion convention) — boot script applies before paint to prevent flash
- 413b0a9 chore: bump version to 5.0.2
- 0ce33ee fix: sky gradient addColorStop needs hex, not CSS variable (Canvas 2D doesn't resolve var(--))
- c0f7db2 chore: bump version to 5.0.1
- 3673f27 fix: remove escaped quotes in WelcomePopup template literal (SyntaxError at line 21137)
- 685a945 chore: bump version to 5.0.0
- dc57df1 ci: remove custom CodeQL workflow — conflicts with Default Setup already enabled on repo
- 30ca36f ci: match CodeQL Default Setup categories (javascript-typescript + rust)
- 0c9a7cb ci: add CodeQL workflow (fixes '1 configuration not found' failure)
- 535ed8d fix(security): keep apiKey in memory only, not sessionStorage (js/clear-text-storage-of-sensitive-data)
- 92e31eb fix(security): add SRI integrity hashes for GLTFLoader and pdf.js (js/functionality-from-untrusted-source #7)
- e216fa2 fix(security): hostname allowlist in sw.js instead of URL substring checks (js/incomplete-url-substring-sanitization #5 #6)
- bba1f5c fix(security): move apiKey from localStorage to sessionStorage (js/clear-text-storage-of-sensitive-data)
- 8e27a28 fix(security): static format string in revit-bridge console.log (js/tainted-format-string)
- 3b057aa fix(security): use static format string in local-engine console.log (js/tainted-format-string)
- f2361b2 chore: update MEMORY.md — UI overhaul complete (PR-1 through PR-8)
- f93b3f3 feat(overlay-panels): left/right panels float over canvas + details drawer + model load card
- c19010c feat(pr4): violet left rail tabs, grid opacity, blue→violet sweep
- 2925060 feat(pr3): slim desktop top bar — glass surface, Share accent, theme toggle
- 6b54bf5 feat(pr2): bottom mode toolbar with 6 chips and sub-tool rows
- 91ecc5d feat(pr1): violet accent, rounder radii, glass surface tokens
- 4743a20 docs: UI overhaul — Chapter 7 (implementation roadmap)
- 9b0ff1b docs: UI overhaul — Chapter 6 (first-run and onboarding)
- f02aa30 docs: UI overhaul — Chapter 5 (feature remapping and naming pass)
- 1f7a116 docs: UI overhaul — Chapter 4 (visual language and copy tone)
- b1e4959 docs: UI overhaul — Chapter 3 (tools as architectural instruments)
- 9d4cfa5 docs: UI overhaul — Chapter 2 (layout architecture)
- e5e90ae docs: UI overhaul design doc — Chapter 1 (vision, personas, references)
- 865944f fix: ViewCube nav arrows render as literal text on iOS Safari
- 51dfbff chore: bump version to 4.19.0
- ab207c1 feat(PR-A): TransformControls section gizmo
- 6a4adf1 feat(PR-E): presentation v2 — slide auto-advance + brand logo
- e272a7b feat(PR-B): SAO ambient occlusion + selection outline post-processing
- 6822bc9 feat(PR-D): walk-mode polish — head-bob + no-clip + gamepad
- 158a7ad feat(PR-C): Smart Views + shareable URL hash
- 5a7e47a chore: bump version to 4.18.0
- 885647a chore: bump version to 4.17.1
- c2aaf71 feat: presentation/kiosk mode + roadmap
- 84a57b9 feat: header Share button + walk-FOV HUD + ACES/shadows for cinematic look
- 9772053 feat(revit-bridge): implement session resumption + keep/discard partial model UI
- 9f80b5a chore: bump version to 4.17.0
- de6b9dd feat: top-level Share entry + pin-on-model comments via folder-sync
- 3d3c2f6 chore: bump version to 4.16.6
- 954e61e fix(revit-bridge): handle isLinked→isLink field rename + add export-start/end logging
- 61ef16f fix: remove LOD proxy boxes — show elements or hide, never show translucent AABB
- 155b2f7 chore: bump version to 4.16.5
- 2959d35 fix: bump geo cache to v4 to invalidate corrupted v3 entries from instancing
- dda8647 fix: delete geo cache immediately when a project is deleted
- fb4e1d2 chore: bump version to 4.16.4
- 2b5d1cd fix: replace setFromObject(scene) with _elemsBBox() to fix instanced mesh bounds
- 59d0917 fix viewer rotation lag and add ViewCube navigation arrows
- 4cbfe5f chore: daily memory sync 2026-04-30

</details>

### 2026-04-30
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- c45e1a5 chore: daily memory sync 2026-04-29

</details>

### 2026-04-29
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- fa5a57f chore: daily memory sync 2026-04-28

</details>

### 2026-04-28
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 4b5274a chore: daily memory sync 2026-04-27

</details>

### 2026-04-27
**Summary:** 5 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 4cc7120 chore: bump version to 4.16.3
- 6c36924 perf+sec: kill periodic rotation hitch; rate-limit /api/nl + /api/title
- 28fa548 feat(bridge): /llm/health probe, error codes, env-var timeouts
- fdf26c2 chore: daily memory sync 2026-04-26
- d942a27 chore: bump version to 4.16.2

</details>

### 2026-04-26
**Summary:** 3 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- d942a27 chore: bump version to 4.16.2
- f37f17d fix: CORS exact-match, face panel material leak, dedupe cleanup blocks
- f39737c chore: daily memory sync 2026-04-25

</details>

### 2026-04-25
**Summary:** 1 commit(s) landed (no AI summary — set ANTHROPIC_API_KEY secret for richer entries).
**Changed:** see commits
**Notable:** —

<details><summary>Commits</summary>

- 028129f chore: daily memory sync 2026-04-24

</details>

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
