# Changelog

## v2.12.0 (2026-03-25)
- Fix training mode not activating from popup + force SW update on iOS

## v2.11.4 (2026-03-25)
- Fix stale popup on mobile: service worker cache-first → network-first for HTML, fix text spacing in WelcomePopup

## v2.11.2 (2026-03-25)
- Add automatic sendBeacon for NL chatbox training data

## v2.11.1 (2026-03-25)
- Add Phase 0.5: GDPR consent popup and automatic sendBeacon data sharing

## v2.11.0 (2026-03-25)
- Keep denied clashes in state for training data, hide from UI

## v2.10.3 (2026-03-25)
- Tighten denied clash suppression to 150mm, fix hasData after Send

## v2.10.2 (2026-03-25)
- Suppress denied clashes on re-detection unless elements moved

## v2.10.1 (2026-03-25)
- Fix training pill counter not clearing after Send

## v2.10.0 (2026-03-25)
- Add Deny button for clashes alongside Confirm

## v2.9.3 (2026-03-25)
- Reserve right-click for element context menu, pan with middle button only

## v2.9.2 (2026-03-25)
- Enable middle mouse button (wheel click) for panning the 3D view

## v2.9.1 (2026-03-25)
- Persist sort/group and all preferences across page refresh

## v2.8.0 (2026-03-25)
- Carry over all training feedback and detection metadata to issues

## v2.7.6 (2026-03-25)
- Clear training data after send, sanitize GDPR-sensitive fields

## v2.7.5 (2026-03-25)
- Add Google Forms to CSP connect-src and frame-src

## v2.7.4 (2026-03-25)
- Change verdict row labels to + - × symbols

## v2.7.3 (2026-03-25)
- Replace thumbs up/down with Real clash / Acceptable / False positive

## v2.7.2 (2026-03-25)
- Add Duplicate option to clash type confirmation in training feedback

## v2.7.1 (2026-03-25)
- Add NL training data sharing, mailto fallback for blocked sends

## v2.7.0 (2026-03-25)
- Add iframe fallback for Send, copy-to-clipboard on failure

## v2.6.13 (2026-03-25)
- Persist data notice acceptance, add Export button, fix Send error msg

## v2.6.12 (2026-03-25)
- Allow multiple resolution selections in training feedback

## v2.6.11 (2026-03-25)
- Style detected clash type same as confirmed, keep (detected) label

## v2.6.10 (2026-03-25)
- Add /reload command to chatbox

## v2.6.9 (2026-03-25)
- Include confirmed clashes in training data count and export

## v2.6.8 (2026-03-25)
- Distinguish detected vs confirmed clash type in training feedback

## v2.6.7 (2026-03-25)
- Fix training feedback counter to include all annotation types

## v2.6.6 (2026-03-25)
- Fix element properties in issues, add assignee field, add reason

## v2.6.5 (2026-03-25)
- Persist training feedback in localStorage backup

## v2.6.4 (2026-03-25)
- Split Google Forms URL to avoid phishing heuristic false positive

## v2.6.3 (2026-03-25)
- Add 'Design error' as first training feedback reason option

## v2.6.2 (2026-03-25)
- Auto-advance to next clash after confirming

## v2.6.1 (2026-03-25)
- Persist training mode on/off across page refreshes

## v2.6.0 (2026-03-25)
- Tolerance matrix toggle, confirm button UX, issue tab badge

## v2.5.2 (2026-03-25)
- Add -type exclusion syntax, fix / key always focuses chat input

## v2.5.1 (2026-03-25)
- Add Advanced settings tab with tolerance matrix

## v2.5.0 (2026-03-25)
- Add resolution feedback (Move A/B), neutral status label in clashes

## v2.4.1 (2026-03-25)
- Move confirmed clashes from Clashes tab to Issues tab

## v2.4.0 (2026-03-25)
- Simplify clash row to status label + green Confirmed button

## v2.3.2 (2026-03-25)
- Style Delete button neutral, improve error fallback

## v2.3.1 (2026-03-25)
- Add unsent data warning, merge marker buttons, simplify training actions

## v2.3.0 (2026-03-25)
- Replace +Issue button with Confirmed status on clashes

## v2.2.5 (2026-03-25)
- Move thumbs up/down into expanded training feedback section

## v2.2.4 (2026-03-25)
- Improve training feedback reason presets

## v2.2.3 (2026-03-25)
- Add data collection notice to training mode dropdown

## v2.2.1 (2026-03-25)
- Add quick start guide with interactive walkthrough tour

## v3.0.0 (2026-03-25)
- Add / keyboard shortcut to open AI chat input

## v2.1.4 (2026-03-25)
- Make training pill a toggle with separate dropdown chevron

## v2.1.3 (2026-03-25)
- Switch navigation cube from perspective to orthographic camera

## v2.1.2 (2026-03-25)
- Remove colored axis lines from navigation cube

## v2.0.47 (2026-03-25)
- Hide training mode pill when TrainingOverlay is active

## v2.0.46 (2026-03-25)
- Fix stale delta pills on reload and modal title for clash-sourced issues

## v2.0.45 (2026-03-25)
- Add clash persistence, delta detection, and Create Issue from Clash

## v2.0.44 (2026-03-25)
- Fix useCallback crash and add tappable logo version popover

## v2.0.42 (2026-03-25)
- Add edge lines to nav cube and improve theme contrast

## v2.0.41 (2026-03-25)
- Make all overflow-prone UI elements scrollable on any screen size

## v2.0.40 (2026-03-24)
- Show header bar on mobile and make nav cube theme-aware

## v2.0.39 (2026-03-24)
- Make welcome popup scrollable so buttons aren't hidden behind mobile nav

## v2.0.38 (2026-03-24)
- Always show training mode toggle on all screens and before clashes

## v2.0.37 (2026-03-24)
- Always show training toggle in chatbox header, not just when clashes exist

## v2.0.36 (2026-03-24)
- Add 'training mode' as a chat command in NL parser

## v2.0.35 (2026-03-24)
- Solid nav cube faces, better contrast, fix mobile panel covering tabs

## v2.0.34 (2026-03-24)
- Add touch controls for mobile 3D viewer (rotate, pan, pinch-zoom)

## v2.0.33 (2026-03-24)
- Rewrite welcome popup as training mode intro shown each session

## v2.0.32 (2026-03-24)
- Remove compass labels, add training toggle to chatbox, add mobile responsive UI

## v2.0.31 (2026-03-24)
- Move AI training annotations to a dedicated Training Mode tab

## v2.0.30 (2026-03-24)
- Add Phase 0 AI training data collection (export + share)

## v2.0.29 (2026-03-24)
- Fix navigation cube camera alignment and add HTML compass overlay

## v2.0.28 (2026-03-24)
- Change viewcube into a proper navigation cube with touch + edge/corner support

## v2.0.27 (2026-03-24)
- Fix React hooks violation in WelcomePopup causing crash on dismiss

## v2.0.25 (2026-03-24)
- Add tooltips to remaining filter labels and confirm before re-running detection

## v2.0.24 (2026-03-24)
- Fix React hooks violation in ClashRulesPanel Advanced toggle

## v2.0.23 (2026-03-24)
- Add semantic clash filter and extend IFC type coverage

## v2.0.22 (2026-03-24)
- Fix empty clash list when switching between issues and clashes tabs

## v2.0.21 (2026-03-24)
- Add periodic memory cleanup and flush geo caches after detection

## v2.0.20 (2026-03-24)
- Fix model visibility not persisting on refresh; default issue markers off

## v2.0.19 (2026-03-24)
- Fix duplicate element properties display on issues tab

## v2.0.18 (2026-03-24)
- Fix model visibility not persisting across page refresh

## v2.0.17 (2026-03-24)
- Fix clash list scroll-to-active when clicking 3D markers

## v2.0.16 (2026-03-24)
- Split markers button into separate clash/issue toggles, remove from issues tab

## v2.0.15 (2026-03-24)
- Persist model visibility on refresh, clear issue description box

## v2.0.14 (2026-03-24)
- Fix issue panel: adapt ClashProps for single-element issues, pass selected element to new issue modal

## v2.0.13 (2026-03-24)
- Switch to relevant tab when clicking 3D markers

## v2.0.12 (2026-03-24)
- Auto-scroll clash list to active item when selected via 3D marker

## v2.0.11 (2026-03-24)
- Add collapse button to clash/issue detail panel

## v2.0.10 (2026-03-24)
- Add spatial sort for clashes: floor-by-floor, element-by-element walkthrough

## v2.0.9 (2026-03-24)
- Per-group self-clash control, remove duplicate detecting bubble

## v2.0.8 (2026-03-24)
- Section box on selected element, filter IFC types by visible models, model delete confirmation, bump file size warning to 500MB

## v2.0.7 (2026-03-24)
- Improve IFC loading: fix WASM leak, material dedup, early model close, file size warning, cache GC, progress

## v2.0.6 (2026-03-24)
- Add clash detection improvements: overlap volume gate, accurate depth, type-pair tolerances, saved presets

## v2.0.5 (2026-03-24)
- Remove redundant single-H (Home) shortcut — use ZF/ZA instead

## v2.0.4 (2026-03-24)
- Add HH (temp hide), HI (isolate), HR (reset) chord shortcuts

## v2.0.3 (2026-03-24)
- Add Revit-style two-key chord shortcuts (BX, SC, ZF, DL, etc.)

## v2.0.2 (2026-03-24)
- Add comprehensive keyboard navigation throughout the app (v2.0.0)

## v2.0.1 (2026-03-24)
- Fix clash merging, add keyboard nav, marker clicks, and title re-zoom

## v1.2.90 (2026-03-24)
- Tighten segment merge radius from 500mm to 50mm

## v1.2.88 (2026-03-24)
- Allow self-clashes within models during multi-model detection

## v1.2.87 (2026-03-24)
- Add group and sort to both clashes and issues tabs

## v1.2.86 (2026-03-24)
- Add sort-within-group for clash list (group by storey, sort by gap)

## v1.2.85 (2026-03-24)
- Show model loading status in open chat panel input area

## v1.2.84 (2026-03-24)
- Replace prompt() with inline text input for new project creation

## v1.2.83 (2026-03-24)
- Allow deleting default project — resets to clean startup state

## v1.2.82 (2026-03-24)
- Add IFC axis-based parallel element rejection for clash detection

## v1.2.81 (2026-03-24)
- Remove parallel element heuristic to prevent false negatives

## v1.2.80 (2026-03-24)
- Add parallel linear element rejection to reduce false hard clashes

## v1.2.79 (2026-03-24)
- Fix false hard clashes, show filtered count, improve detection accuracy

## v1.2.78 (2026-03-24)
- Replace Clearance/Tolerance with single Max Gap setting

## v1.2.77 (2026-03-24)
- Add What's New section to README

## v1.2.76 (2026-03-24)
- Optimize soft clash marker: use AABB diagonal for weighting, zero-alloc scratch

## v1.2.75 (2026-03-24)
- Color element outlines by model discipline (structural=blue, MEP=red, etc.)

## v1.2.74 (2026-03-24)
- Fix soft clash marker position and remove penetration depth display

## v1.2.73 (2026-03-24)
- Show detection status in chat input area with glowing animation

## v1.2.72 (2026-03-24)
- Add delayed hover tooltips explaining Clearance vs Tolerance

## v1.2.71 (2026-03-24)
- Extract IFC GlobalId from loaded elements

## v1.2.70 (2026-03-24)
- Fix clash marker placement using exact intersection line midpoints

## v1.2.69 (2026-03-24)
- Move info button from header to bottom of left sidebar

## v1.2.68 (2026-03-24)
- Bump version for distance slider and clash detection fixes

## v1.2.67 (2026-03-24)
- Reduce max intersection sample points from 150 to 24

## v1.2.66 (2026-03-24)
- Fix clash marker positioning: use actual triangle intersection point

## v1.2.65 (2026-03-24)
- Add IFC type exclusion to clash detection setup card

## v1.2.64 (2026-03-24)
- Bring camera closer to model on initial load and reset view

## v1.2.63 (2026-03-24)
- Keep project panel open on delete/cancel, reset view on project switch

## v1.2.62 (2026-03-24)
- Add green 3D markers for issues in the viewer

## v1.2.61 (2026-03-24)
- Add clash detection setup card and fix marker positioning

## v1.2.60 (2026-03-24)
- Add logo/version tooltips and quick start guide

## v1.2.59 (2026-03-24)
- Add comprehensive NL commands for full app control via chat

## v1.2.58 (2026-03-23)
- Add classical UI controls, bulk actions, and deeper AI integration

## v1.2.57 (2026-03-23)
- Polish light mode: CSS variables for theme coherence across all components

## v1.2.56 (2026-03-23)
- Improve UI readability, spacing, and visual polish across the app

## v1.2.55 (2026-03-23)
- Redesign welcome popup with polished card-based UI

## v1.2.54 (2026-03-23)
- Add first-visit welcome popup with LLM setup instructions

## v1.2.53 (2026-03-23)
- Add Revit Bridge: AI-powered bidirectional sync between ClashControl and Revit

## v1.2.52 (2026-03-23)
- Add soft clash / proximity detection via chatbox distance input

## v1.2.51 (2026-03-23)
- Hide unchecked model elements from all filter lists and panels

## v1.2.50 (2026-03-23)
- Word-based NL parsing for clash detection commands

## v1.2.49 (2026-03-23)
- Replace distance filter with dual-range slider

## v1.2.48 (2026-03-23)
- Support discipline-based model selection in clash detection

## v1.2.47 (2026-03-23)
- Fix phantom section plane caused by stale clipping planes

## v1.2.46 (2026-03-23)
- Convert multi-option filters to dropdown checkboxes & add delete to sidebar projects

## v1.2.45 (2026-03-23)
- Add Sweep and Prune as L0 element broad phase

## v1.2.44 (2026-03-23)
- Add element type exclusion checkboxes + detecting chat bubble

## v1.2.43 (2026-03-23)
- Match clash detection indicator style to model loading

## v1.2.42 (2026-03-23)
- Improve project deletion UX

## v1.2.41 (2026-03-23)
- Replace triangle spatial hash with dual-BVH traversal

## v1.2.40 (2026-03-23)
- Replace vertex-distance hard clash with triangle-triangle intersection

## v1.2.39 (2026-03-23)
- Default clash markers to off to reduce visual clutter

## v1.2.38 (2026-03-23)
- Fix: 'run clash...' commands now run detection instead of just setting rules

## v1.2.37 (2026-03-23)
- Replace AABB-only clash detection with geometry-accurate narrow phase

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
