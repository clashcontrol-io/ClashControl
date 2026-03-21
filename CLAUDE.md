# CLAUDE.md — Project Guide for AI Assistants

## What is this?
ClashControl is a free, open-source IFC clash detection web app. It lets users load IFC building models, detect geometric clashes between elements, create/manage issues, and export to BCF format.

## Architecture — Single File App
The **entire application** lives in `index.html` (~4000 lines). There is no build step, no bundler, no node_modules. Just open the file in a browser.

### Tech stack
- **Preact/React 18** via CDN (UMD) — UI framework
- **htm** — hand-written tagged template literal parser (inlined in the file, replaces JSX)
- **Three.js r128** via CDN — 3D rendering
- **JSZip** via CDN — BCF zip export/import
- **No other dependencies**

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
index.html                  — The entire application
version.json                — Current version numbers
CHANGELOG.md                — Version history (auto-updated on commit)
README.md                   — Project readme with version badge
LICENSE                     — License file
OPEN_SOURCE_COMPONENTS.md   — Third-party library credits
scripts/bump-version.sh     — Pre-commit version bump script
```
