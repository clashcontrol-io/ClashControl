# Changelog

## v3.3.50 (2026-03-29)
- Remove load profiler from model card UI

## v3.3.49 (2026-03-29)
- Apply non-physical geometry strip to all GLB load paths

## v3.3.48 (2026-03-29)
- Strip IfcVirtualElement, IfcAnnotation, IfcGrid geometry from viewer

## v3.3.47 (2026-03-29)
- Revert GLB materials to DoubleSide — FrontSide caused black faces

## v3.3.46 (2026-03-29)
- Switch GLB materials to FrontSide; keep DoubleSide only for transparent

## v3.3.45 (2026-03-29)
- Fix 2D button tooltip wrapping — remove spaces around slashes

## v3.3.44 (2026-03-29)
- Include empty GLB nodes and props/sidecar-only elements in element list

## v3.3.43 (2026-03-29)
- Filter IfcOpeningElement in full loadIFC path for consistency with GLB paths

## v3.3.42 (2026-03-28)
- Hide GLB+sidecar import UI until Ifc2Ifc is fully released

## v3.3.41 (2026-03-28)
- Prefer sidecar relatedPairs over IFC STEP pairs in joinGLBWithIFC; document expressId in .ifcprops

## v3.3.40 (2026-03-28)
- feat: GLB+meta pipeline — revitId, host-child hierarchy, opening suppression, relatedPairs

## v3.3.39 (2026-03-28)
- Remove incorrect Z-up→Y-up rotation from GLB loader

## v3.3.38 (2026-03-28)
- Add _ccCompareModels() console helper

## v3.3.37 (2026-03-28)
- Remove element data panel from model card UI (console-only)

## v3.3.36 (2026-03-28)
- Add data quality checker + OmniClass LLM suggestion to model card

## v3.3.35 (2026-03-28)
- Add exporter specs for Revit, ArchiCAD, and Tekla

## v3.3.34 (2026-03-28)
- Skip IFC STEP parsing when .ifcmeta or .ifcprops is present

## v3.3.33 (2026-03-28)
- Add .ifcprops fast-loading path (replaces IFC STEP parsing)

## v3.3.32 (2026-03-28)
- fix: handle black/missing colors in GLB material loading

## v3.3.31 (2026-03-28)
- feat: add load profiler to model card

## v3.3.30 (2026-03-28)
- fix: apply Z-up to Y-up rotation for GLB geometry from Revit/IFC exports

## v3.3.29 (2026-03-28)
- fix: correct _getIfcAPI typo to getIfcAPI in loadIFCMetadataOnly

## v3.3.28 (2026-03-28)
- fix: remove strikethrough on completed roadmap item, add launch date Mar 27 2026

## v3.3.27 (2026-03-28)
- feat: move info btn to top of left rail, update roadmap

## v3.3.26 (2026-03-28)
- feat: export/import clash rules, fix + New theme, speed tip LLM line, REVIT guide link

## v3.3.25 (2026-03-28)
- feat: show loaded model count badge on Models tab

## v3.3.24 (2026-03-28)
- Mention GLB+IFC+ifcmeta and Ifc2Ifc in guided tour, quick start guide, and upload tooltip

## v3.3.23 (2026-03-28)
- Add GLB+IFC+ifcmeta info to import tooltip and chatbox welcome message

## v3.3.22 (2026-03-28)
- Support GLB+IFC+ifcmeta triple file loading

## v3.3.21 (2026-03-28)
- Add background dismiss (click outside to close) for Settings modal and chatbox

## v3.3.20 (2026-03-28)
- Fix mobile logo popup visibility (z-index and positioning)

## v3.3.19 (2026-03-28)
- Add tour/version popup on mobile logo tap and project collaboration tour step

## v3.3.18 (2026-03-28)
- Add Save/Import Project buttons to Tools panel

## v3.3.17 (2026-03-28)
- Add BCF export with version choice to Tools panel

## v3.3.16 (2026-03-28)
- Hide Developer/Fine-Tuning section from settings on mobile

## v3.3.15 (2026-03-28)
- Increase chatbox bottom offset on mobile to clear nav tabs

## v3.3.14 (2026-03-28)
- Add GLB+IFC paired loading for fast Revit model import

## v3.3.13 (2026-03-27)
- Add geometry compression for IndexedDB cache (Level 3)

## v3.3.12 (2026-03-27)
- Add GoatCounter analytics with custom event tracking

## v3.3.11 (2026-03-27)
- Add GDPR-safe anonymous visitor counter

## v3.3.10 (2026-03-27)
- Restore Ollama check on chatbox open

## v3.3.9 (2026-03-27)
- Skip eager Ollama probe to eliminate ERR_CONNECTION_REFUSED in console

## v3.3.8 (2026-03-27)
- Replace Advanced/Simple text with chevron dropdown icon

## v3.3.7 (2026-03-27)
- Fix mobile security warning and chatbox overlapping bottom nav

## v3.3.6 (2026-03-27)
- Fix IFC loading from chatbox not responding on non-models tab

## v3.3.5 (2026-03-27)
- Add *.hf.co to CSP connect-src for HuggingFace WASM fetches

## v3.3.4 (2026-03-27)
- Fix worker error, add loading progress to chatbox, move clash rules to Standards, show IDS failures in clashes

## v3.3.3 (2026-03-27)
- Remove wireframe overlay on hover — eliminates floating plane artifacts

## v3.3.2 (2026-03-27)
- Add model version diffing with visual change tracking

## v3.3.1 (2026-03-27)
- Add Navigator spatial tree, IDS validation, property inspector, glTF export, and BCF enhancements

## v3.2.74 (2026-03-27)
- Fix clickClashRow: poll with setInterval, getClash reads from DOM rows

## v3.2.73 (2026-03-27)
- Tour: robust clickClashRow — dispatch ACTIVE first, retry finding row

## v3.2.72 (2026-03-27)
- Tour: use clash 5 for second selection (more visible in list)

## v3.2.71 (2026-03-27)
- Fix clash list: click actual DOM rows, normalize issue orbit axis

## v3.2.70 (2026-03-27)
- Fix orbit jump, use clash 10, cached mesh list, reverse ending orbit

## v3.2.69 (2026-03-27)
- Fix clash list scroll: use mid-list indices, reset sort/group in tour

## v3.2.68 (2026-03-27)
- Pre-warm render style materials at tour start for smooth switching

## v3.2.67 (2026-03-27)
- Fix clash list scroll, remove measurement step, combine ending orbit

## v3.2.66 (2026-03-27)
- Fix VirtualList scroll: double-rAF, clamp tour to first 50 items

## v3.2.65 (2026-03-27)
- Tour: fix clash list visibility, click confirm button, add explorer tab

## v3.2.64 (2026-03-27)
- Fix 'AI loaded' not showing — force React state via _ccNLSetStatus

## v3.2.63 (2026-03-27)
- Tour: fix NL typing lag, scroll clash into view, static render cycle

## v3.2.62 (2026-03-27)
- Tour: optimize FPS for steps 0, 11-13 — settle before orbit

## v3.2.61 (2026-03-27)
- Tour: show 'AI loaded' in purple, keep training mode on at end, faster modal open

## v3.2.60 (2026-03-27)
- Tour: show models tab at start, faster modal typing, remove duplicate model tree step

## v3.2.59 (2026-03-27)
- Tour: add F12 diagnostics, standards tab for clearances

## v3.2.58 (2026-03-27)
- Tour: show confirm panel, replace BCF export with model tree + clearances

## v3.2.57 (2026-03-27)
- Tour: override AI status to show as loaded during demo

## v3.2.56 (2026-03-27)
- Tour: caption centered in viewer, fix duplicate clash, slower modal/typing/orbit

## v3.2.55 (2026-03-27)
- Tour: caption at top, fill modal text, real measurement, continuous orbit

## v3.2.54 (2026-03-27)
- Tour: move NL typing to step 1, zoom-all before create issue, type CTA in input

## v3.2.53 (2026-03-27)
- Fix app not loading — undefined nextIdx variable in _ccAdvanceToNext

## v3.2.52 (2026-03-27)
- Auto-advance to next clash on confirm/deny/accept, gate training data

## v3.2.51 (2026-03-27)
- Tour: better clash zoom, slower issue transition, faster typing, longer end caption

## v3.2.50 (2026-03-27)
- Tour: flash training mode pill with glow + scale in step 13

## v3.2.49 (2026-03-27)
- Tour: update end caption to call-to-action text

## v3.2.48 (2026-03-27)
- Tour: separate zoom-all step before features, consistent orbit direction

## v3.2.47 (2026-03-27)
- Fix tour orbit breaking viewer — array vs Vector3 and stale sph

## v3.2.46 (2026-03-27)
- Tour: orbit around clash point in step 3, zoom-all for steps 9+

## v3.2.45 (2026-03-27)
- Add typewriter effect to tour step 12 — type in AI command line

## v3.2.44 (2026-03-27)
- Auto-select first issue and fly to it when switching to issues tab

## v3.2.43 (2026-03-27)
- Add continuous camera movement throughout demo tour

## v3.2.42 (2026-03-27)
- Rewrite demo tour from scratch — no _resetView camera animations

## v3.2.41 (2026-03-27)
- Remove _resetView from tour step 1 to prevent camera rotation on start

## v3.2.40 (2026-03-27)
- Redesign demo tour to follow clash-to-issue workflow

## v3.2.39 (2026-03-27)
- Remove Confirmed status from issues tab

## v3.2.38 (2026-03-27)
- Bump version via pre-commit hook

## v3.2.37 (2026-03-27)
- Fix _lodBoxGeo not defined error when loading IFC via worker

## v3.2.36 (2026-03-27)
- Beacon sends labeled clash records from store, not live state

## v3.2.35 (2026-03-27)
- Review fixes: cancel-safe detection, orbit crossVectors, shared dispose helper

## v3.2.34 (2026-03-27)
- Bug fixes & performance: race conditions, memory leaks, allocation reduction

## v3.2.33 (2026-03-27)
- Fix mobile layout: command line above tabs, training pill smaller/lower

## v3.2.30 (2026-03-26)
- Geometry dedup via geometryExpressID + USE_FAST_BOOLS

## v3.2.29 (2026-03-26)
- Add Web Worker for IFC parsing + USE_FAST_BOOLS

## v3.2.28 (2026-03-26)
- Faster vertex deinterleave in IFC geometry streaming

## v3.2.27 (2026-03-26)
- Optimize spatial hash + add IFC load profiler

## v3.2.26 (2026-03-26)
- Add detection profiler — console table + NL chat summary

## v3.2.25 (2026-03-26)
- Scale detection messages to speed — fewer messages when it's fast

## v3.2.24 (2026-03-26)
- Add 'stop' command to cancel any pending NL chat conversation

## v3.2.23 (2026-03-26)
- Reset markers to off when switching projects

## v3.2.22 (2026-03-26)
- Add time-based fun messages for long-running clash detection

## v3.2.21 (2026-03-26)
- Add fun progress messages during clash detection

## v3.2.20 (2026-03-26)
- Show detection progress percentage in NL command bar

## v3.2.19 (2026-03-26)
- Delay detection start 80ms so 'Running...' message paints first

## v3.2.18 (2026-03-26)
- Move training pill up when clash overlay buttons aren't visible

## v3.2.17 (2026-03-26)
- Show Markers toggle when models are loaded, not just after detection

## v3.2.16 (2026-03-26)
- Clear NL chat messages when switching projects

## v3.2.15 (2026-03-26)
- Use atomic REPLACE_MODEL for model versioning, fix Three.js mesh swap

## v3.2.14 (2026-03-26)
- Auto-version models when reloading IFC with same filename

## v3.2.13 (2026-03-26)
- Make popups scroll internally instead of scrolling the page

## v3.2.12 (2026-03-26)
- Fix Standards tab not rendering — add sidebar button and standalone mount

## v3.2.11 (2026-03-26)
- Reset excludeTypes and excludeTypePairs on new NL detection setup

## v3.2.10 (2026-03-26)
- Switch all Google Form sends from FormData to URLSearchParams

## v3.2.9 (2026-03-26)
- Fix detection run summary not appearing in Google Form

## v3.2.8 (2026-03-26)
- Add error handling to async detection and fix BVH pre-build key collision

## v3.2.7 (2026-03-26)
- Skip self-clash confirmation when 'self' is already in the NL command

## v3.2.6 (2026-03-26)
- Fix training pill counter and form send reliability

## v3.2.5 (2026-03-26)
- Add 'Functional clearance' reason chip for element-type clearance envelopes

## v3.2.4 (2026-03-26)
- Add 'Expected clash' to training reason chips

## v3.2.3 (2026-03-26)
- Optimize clash detection performance and fix denied clash training data

## v3.2.2 (2026-03-26)
- Remove extra 'mep' from Standards discipline dropdown to match spec

## v3.2.1 (2026-03-26)
- Add Standards tab with discipline/IFC-type tolerance rules, tolerance input on clash cards, expected-clash tag, and accepted-needs-check status

## v3.1.31 (2026-03-26)
- Move NL panel inside viewport div so it aligns with training pill

## v3.1.30 (2026-03-26)
- Fix training data re-send + align training pill with NL button

## v3.1.29 (2026-03-26)
- Only count Confirm/Deny as verdicts, not workflow status changes

## v3.1.28 (2026-03-26)
- Exclude thumbs feedback from clash verdict counter

## v3.1.27 (2026-03-26)
- Clear section plane when switching tabs or selecting a clash/issue

## v3.1.26 (2026-03-26)
- Flash training pill green when data is sent

## v3.1.25 (2026-03-26)
- Ask for feedback after user rejects fuzzy suggestion

## v3.1.24 (2026-03-26)
- UI spacing: training pill lower, NL button bigger/wider/higher

## v3.1.23 (2026-03-26)
- Remove section percentage label + move nav cube down

## v3.1.22 (2026-03-26)
- Add half-circle rotation indicator on section plane arrow handle

## v3.1.21 (2026-03-26)
- Add section plane rotation: Shift+drag rotates around vertical Y axis

## v3.1.20 (2026-03-26)
- Fix section plane alignment + line-arrow handles

## v3.1.19 (2026-03-26)
- Tune section plane: smaller size, reversed drag, smaller flipped arrows

## v3.1.18 (2026-03-26)
- Fix right-click ghosting + add section plane handles + ESC to cancel

## v3.1.17 (2026-03-26)
- Raise fuzzy intent confidence threshold from 40% to 70%

## v3.1.16 (2026-03-26)
- Wireframe section plane + highlight on right-click without ghost

## v3.1.15 (2026-03-26)
- Add visible section plane with drag-to-move in 3D viewport

## v3.1.14 (2026-03-26)
- Right-click drag to move section plane in the 3D viewport

## v3.1.13 (2026-03-26)
- Point detection run summary to its own form field entry.39972213

## v3.1.12 (2026-03-26)
- Include semantic filter negatives in detection run summary

## v3.1.11 (2026-03-26)
- Rename NL training path labels: regex→matched, no-llm→unmatched

## v3.1.10 (2026-03-26)
- Collect detection run summaries as training data

## v3.1.9 (2026-03-26)
- Don't store incomplete clash training records at all

## v3.1.8 (2026-03-26)
- Only count user-confirmed/denied clashes in training data counter

## v3.1.7 (2026-03-26)
- Smooth camera restore on Zoom Both — saves clash view after fly-to

## v3.1.6 (2026-03-26)
- Add descriptions to each roadmap milestone in Quick Start Guide

## v3.1.5 (2026-03-26)
- Add descriptions to each roadmap milestone in Quick Start Guide

## v3.1.4 (2026-03-26)
- Roadmap: mark training data gathering as also active (already happening)

## v3.1.3 (2026-03-26)
- Fix roadmap: open-source launch is current milestone, not completed

## v3.1.2 (2026-03-26)
- Add roadmap, bug report & feature request links to Quick Start Guide

## v3.1.1 (2026-03-26)
- Fix Quick Start Guide not showing on desktop + NL counter not resetting

## v3.1.0 (2026-03-26)
- Clear localStorage after training data is sent + event-driven counter

## v3.0.13 (2026-03-26)
- Set orbit target to clash point when marker is shown

## v3.0.12 (2026-03-26)
- Make training pill data counts reactive — update every 3 seconds

## v3.0.11 (2026-03-26)
- Improve text contrast on dark theme for readability

## v3.0.10 (2026-03-26)
- Move Zoom A/B toggle to ClashProps where buttons actually live

## v3.0.9 (2026-03-26)
- Fix zoomedTo crash + add NL training feedback + resolved action in records

## v3.0.8 (2026-03-26)
- Clean up training pill: show only data records, move clash stats to tab

## v3.0.7 (2026-03-26)
- Fix auto-share status text: mention periodic sending, not just session end

## v3.0.6 (2026-03-26)
- Remove inner sphere from clash marker — only keep crosshair rings

## v3.0.5 (2026-03-26)
- Zoom A/B toggle: second click flies to clash point

## v3.0.4 (2026-03-26)
- Ask for data sharing consent when training mode is activated

## v3.0.3 (2026-03-26)
- Add inline SVG favicon with CC logo

## v3.0.2 (2026-03-26)
- Auto-enable data sharing when training mode is turned on

## v3.0.1 (2026-03-26)
- Fix app not loading: remove extra } brace + fix pdf.js SRI integrity failure

## v2.12.19 (2026-03-26)
- Fix NL training data form field ID to entry.908589612

## v2.12.18 (2026-03-26)
- Unify training pill: show clash + NL stats, auto-share both via Google Form

## v2.12.17 (2026-03-26)
- Separate NL data submission from clash data using different form fields

## v2.12.16 (2026-03-26)
- Add conversational clash setup + fuzzy confirmation for low-confidence matches

## v2.12.15 (2026-03-26)
- Add fuzzy intent fallback to NL command parser

## v2.12.14 (2026-03-26)
- Increase font size 15% across entire app (outside already-bumped panels)

## v2.12.13 (2026-03-26)
- Replace hardcoded _IFC_SHORT map with dynamic fuzzy IFC type resolver

## v2.12.12 (2026-03-26)
- Replace hardcoded model/discipline matching with fuzzy resolver

## v2.12.11 (2026-03-26)
- Expand _IFC_SHORT to cover all IFC types from IFC_TYPE_NAMES map

## v2.12.10 (2026-03-26)
- Add self-clash NL commands: self:discipline, intra, within same discipline

## v2.12.9 (2026-03-26)
- Add multi-model clash grouping, custom tags, and NL group syntax

## v2.12.8 (2026-03-26)
- Add type-pair exclusion in NL commands + 15% font size increase in panels

## v2.12.7 (2026-03-26)
- Increase font sizes in all side panel tabs by 15% for readability

## v2.12.6 (2026-03-26)
- Replace action type strings with A.constants object

## v2.12.5 (2026-03-26)
- Standardize expressID → expressId on mesh userData for consistency

## v2.12.4 (2026-03-26)
- Extract clash object factory: deduplicate clash creation in detection engine

## v2.12.3 (2026-03-26)
- Code review cleanup: fix reload loop, texture leak, dead code, stale closures

## v2.12.2 (2026-03-25)
- Fix React error #300: move useState for details toggle before early return

## v2.12.1 (2026-03-25)
- Fix training mode toggle-off bug + add expandable GDPR data details to popup

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
