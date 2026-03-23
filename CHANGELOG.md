# Changelog

## v1.2.36 (2026-03-23)
- Fix: load project files immediately on page load, not on models tab open

## v1.2.35 (2026-03-23)
- Add Ollama-first LLM with in-browser fallback and idle auto-unload

## v1.2.34 (2026-03-23)
- Reduce memory usage by ~2GB: remove LLM, trim clash data, reuse boxes

## v1.2.33 (2026-03-23)
- Make unchecked model elements non-clickable and non-hoverable

## v1.2.32 (2026-03-23)
- Hide clashes from unchecked models in the clash list

## v1.2.31 (2026-03-23)
- Install pre-commit hook for auto version bumping

## v1.2.30 (2026-03-23)
- Fix model visibility, add cross-model clash detection, virtualize large lists

## v1.2.29 (2026-03-23)
- Speed up project switch by not blocking on IDB save

## v1.2.28 (2026-03-23)
- Remove Development Tools section from OPEN_SOURCE_COMPONENTS.md

## v1.2.27 (2026-03-23)
- Show loading overlay on viewer when switching projects

## v1.2.26 (2026-03-23)
- Fix 7 bugs found in review: stale camera, material leak, dead code, URL leaks

## v1.2.25 (2026-03-23)
- Simplify: remove dRef, fix img cache pattern, deduplicate hasProjectData, fix unmount leak

## v1.2.24 (2026-03-22)
- Fix 8 code review issues: CSP, SRI, state mutation, stale closures, dead code

## v1.2.22 (2026-03-22)
- Fix web-ifc import to use browser-specific entry point

## v1.2.21 (2026-03-22)
- Add 2D underlay system (DXF/PDF import), markup tools, and 2D export

## v1.2.20 (2026-03-22)
- Add clash grouping, duplicate detection, tolerance, ortho/perspective, drag-orbit ViewCube

## v1.2.19 (2026-03-22)
- Add Revit-style 3D ViewCube, project system, and fix CSP/perf issues

## v1.2.18 (2026-03-22)
- Persist loaded IFC files across page reloads using IndexedDB

## v1.2.17 (2026-03-21)
- Rewrite README with proper project description and feature overview

## v1.2.16 (2026-03-21)
- Add SRI integrity hashes to CDN script tags

## v1.2.15 (2026-03-21)
- Add CSP, PWA, global error handling, and accessibility

## v1.2.14 (2026-03-21)
- Fix critical crash on element click and multiple viewer bugs

## v1.2.13 (2026-03-21)
- Fix license docs and correct IFC parser description

## v1.2.12 (2026-03-21)
- Auto version bumping with changelog and README updates on every commit
- Lazy rendering for unused UI components (modals, overlays, panels)
- Security hardening: removed session traces

## v1.2.11 (2026-03-21)
- Render on demand: GPU only draws frames when something actually changes
- Idle FPS reduced from ~27 to 0 when nothing is happening

## v1.2.10 (2026-03-21)
- Light/dark mode toggle in header bar
- 4 viewer render styles: Standard, Shaded, Rendered, Wireframe
- Render style picker in bottom-left of viewer
- Theme and render style settings in preferences

## v1.2.9 (2026-03-21)
- Smart fly-to now detects horizontal and zoom shifts
- Camera preserves viewing angle for nearby targets

## v1.2.8 (2026-03-21)
- Ghost material: non-selected elements shown as semi-transparent grey
- Smart angle-preserving fly-to applied to clashes and issues

## v1.2.7 (2026-03-21)
- Overhauled fly-to system with vertical level shifts and distance-based duration
- Camera slides vertically between floors instead of full re-orientation

## v1.2.6 (2026-03-21)
- Fixed view cube rotating opposite to the 3D viewer using quaternion approach

## v1.2.5 (2026-03-21)
- Cleaned up element property panel with logical sections
- Friendly type names, color-coded tags, organized dimensions/quantities

## v1.2.4 (2026-03-21)
- Fixed fly-to, level clicks, element outline silhouette, calmer animations

## v1.2.3 (2026-03-21)
- Added frustum culling, BCF compatibility, edge outlines, measure UX improvements

## v1.2.2 (2026-03-21)
- Improved section box UX, added sidebar splitter and select-all toggle

## v1.2.1 (2026-03-21)
- Fixed view cube rotation and reworked floor plan level interaction

---

## v1.2.0 (2026-03-20)

### New Features
- **View Cube**: Added interactive view cube in top-right corner of the 3D viewer. Click any face (Front, Back, Left, Right, Top, Bottom) to fly to that view direction with smooth animation.
- **Ctrl+Scroll for Section Planes**: Ctrl+scroll now adjusts the position of active section planes (X/Y/Z axis and surface sections), in addition to the existing floor plan cut height adjustment.
- **Blue Clash Point Marker**: When selecting a clash, a bright blue 3D marker (sphere + rings) now appears at the exact clash point for better visibility.
- **Open Source Components Documentation**: Added `OPEN_SOURCE_COMPONENTS.md` listing all third-party libraries used.

### Improvements
- **Fly-to Distance Scaling**: Camera fly-to distance now scales based on object size — smaller objects get a *2.5 multiplier while larger objects use a minimum of *1.2, providing better framing for all element sizes.
- **Tree Panel Interaction**: Single-click on a tree element now only highlights and shows properties. Double-click triggers the fly-to animation. This prevents accidental camera jumps when browsing the model tree.
- **Floor Element Camera Angle**: Flying to floor/slab elements now positions the camera at an angle instead of straight from the top, giving a better 3D perspective.
- **Property Box Redesign**: Reorganized the element property panel for clarity — element type and name are now prominent headers, storey/material/ID shown as color-coded tags, duplicate Pset dimension properties removed when IFC quantities exist, and dimension quantities separated from other quantities.
- **Enlarged Small Text**: Increased font sizes for tree tab buttons (Expand all/Collapse all), classification view tabs, storey level buttons (All on/All off, Cut, elevation labels) for better readability.
- **Transparency Level**: Ghost/transparency for non-selected elements changed from 85% to 80% transparent (opacity 0.2) for better visibility of context.
- **Clearance Slider Label**: Renamed "Clearance" to "Soft clashes" with "Max gap" label and tooltip explaining that higher values detect more clashes.

### Bug Fixes
- **Clash Selection Fly-to**: Fixed clash/issue click to properly fly to the clash location with transparency applied and elements highlighted.
- **Section Box Auto-off**: Selecting a different clash or issue now automatically turns off the section box, preventing confusion with stale section views.
- **Removed Duplicate Pset Dimensions**: Property sets ending with "Dimensions" (e.g., Pset_WallCommon) that duplicate IFC quantity values are now filtered out to avoid showing the same measurements twice.

---

## v1.1.16 (2026-03-20)
- Dalux-style 3D section cut for floor plans
- Camera fly-to fixes for issue/clash clicks

## v1.1.15 (2026-03-20)
- Issue filters and merged Classify+Tree into Explorer tab

## v1.1.14 (2026-03-20)
- Mini-map removed, material extraction improved, IFC dimensions only

## v1.1.13 (2026-03-20)
- Section box with face handles only (corner handles removed)

## v1.1.12 (2026-03-20)
- Interactive section box with drag handles and rotation

## v1.1.11 (2026-03-20)
- Transparency only on clash/issue selection, not normal clicks

## v1.1.10 (2026-03-20)
- Exploder feature removed

## v1.1.9 (2026-03-20)
- Performance optimizations across rendering, traversals, and DOM
