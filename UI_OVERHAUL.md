# ClashControl UI Overhaul — Architectural Design Tool

## Chapter 1: Vision & Context

### Why This Redesign Exists

ClashControl started as a BIM coordination tool: load two IFC models, detect
geometric conflicts, export a BCF report. The feature list grew steadily —
walk mode, AI chat, floor plans, shared projects, presentation mode — but the
UI shell stayed frozen in "clash-detection app" mode. Fifteen icons on the
left rail. Thirteen buttons in the header. A welcome popup that leads with
collision detection.

The product now has a real shot at a different market: **architectural offices
that want to share IFC models with clients, consultants, and construction
managers**. These users are not BIM coordinators. They are project architects,
interior designers, and non-technical project stakeholders who want to
*present* and *discuss* a building, not run clash checks. They compare
ClashControl mentally to Figma, not Navisworks.

The gap between what the app can do and how it presents itself is now the
biggest barrier to adoption. This document specifies how to close it.

---

### Who We Are Designing For

**Primary persona — The Presenting Architect**

Sarah is a senior architect at a 12-person practice. She uses Revit and
exports to IFC every Friday. She wants a tool she can open in a browser,
load the model, set up a few nice views, and send a link to her client before
Monday's meeting. She is comfortable with 3D navigation but has zero
tolerance for BIM jargon. She will not read a tooltip that says "Express ID".
She does not know what OBB stands for.

What Sarah needs: drag-drop IFC → good-looking 3D → save a few camera
angles → share a link. Done in under five minutes.

**Secondary persona — The Client**

Marcus is the client. He receives Sarah's link, opens it on a MacBook, and
wants to rotate around the building and leave a comment on the rooftop
terrace. He has never heard of IFC. The first screen he sees must not mention
clash detection, BCF, or section planes.

**Tertiary persona — The BIM Coordinator (existing user)**

Lukas already uses ClashControl for clash detection. The redesign must not
break his workflow. Conflicts, issues, and BCF export stay — they just live
one level deeper in the UI, accessible from the Model tab in the left panel.

---

### Reference Audit

The redesign draws from two categories of tools: **BIM viewers** that show
what the professional baseline looks like, and **design tools** that show
what the target feel looks like.

**BIM viewers studied**

*xeokit-bim-viewer* sets the clearest layout precedent in open-source BIM:
a clean left tree for the model hierarchy, a properties panel on the right,
and a toolbar that does not try to do too much. Its section gizmo (using
Three.js TransformControls) is the best free implementation available. The
visual language is still engineering-dark, which we will not copy, but the
information architecture is right.

*Autodesk APS Viewer* solved the header problem years ago by moving the
toolbar to the bottom center of the canvas. The model tree is hidden by
default; the canvas fills the browser window on load. Right-click context
menus replace the need for mode buttons in the header. These are the correct
instincts. APS still looks like enterprise software — we want something
warmer.

*BIMcollab Zoom* has the best Smart Views implementation: a visual grid of
preset views that non-technical users can click to orient themselves. It also
pioneered the first-launch tour overlay that teaches the UI without a manual.
Both patterns translate directly to ClashControl.

*Trimble Connect* is the benchmark for "share-first" IFC viewing. The entry
flow is a project card, not a file picker. Sharing is the first action in the
UI, not the fifteenth. The comment system is anchored to camera viewpoints,
so feedback is always contextual. These are the interaction patterns Marcus
(the client persona) needs.

*bldrs.ai* proves that URL-hash deep links work for IFC models. You can
share a URL that opens the model at a specific camera position, with a
specific element selected. No backend needed. This aligns perfectly with
ClashControl's local-first architecture.

**Design tools studied**

*Figma* is the reference for the canvas-first layout. The canvas fills the
screen. The left panel holds layers and assets. The right panel holds
properties. A floating toolbar at the bottom switches interaction modes. No
button lives in a toolbar that could live in a context menu. This layout is
now so universally understood by designers and architects that it reduces
onboarding friction to near zero — users already know where to look.

*Linear* is the reference for sidebar density. The left nav collapses to an
icon strip without losing functionality. Keyboard shortcuts are shown on every
tooltip. The entire tool is navigable without touching the header. Its design
system feels "calm, fast, and in control" — exactly the atmosphere we want.

*Procreate* on iPad is the reference for mode switching. A thin strip of tool
chips at the top switches between Draw, Smudge, Erase. Long-pressing reveals
sub-tools. The active mode is obvious. There is no ambiguity about what will
happen when you tap the canvas. The bottom mode toolbar in this redesign
directly borrows this pattern.

*Notion* is the reference for first-run onboarding. When you open an empty
Notion workspace, you see a clean canvas with large affordances. The "Type
'/' for commands" prompt teaches the power user path without blocking the
simple user. We want the same quality of empty-state design.

*Apple iOS Camera* is the reference for the mode strip: Photo, Video,
Portrait, Pano — one tap, immediate. The active mode is the center chip.
Swipe left or right to change mode. This is the interaction model for our
bottom mode toolbar.

**Key lessons extracted from the reference audit**

1. Canvas is the hero. Every pixel of chrome is a tax on the experience.
   Reduce the header to 44px. Make the left panel collapsible. Float the
   mode toolbar so it sits above the canvas rather than beside it.

2. Mode switching belongs at the bottom, not scattered across the header.
   Orbit, Walk, Slice, Measure, Plan, and Note are modes, not features.
   They deserve a single place in the UI that is always visible.

3. Share lives at the top right, prominent, in an accent color. Not buried
   behind a 16-pixel icon. The share action is the primary value proposition
   for the architectural office persona — it earns its position in the header.

4. The left panel holds the model, not the app controls. Trees, views, search,
   and settings. The right drawer holds AI and element details — the things
   you look at after you click something.

5. Language must be plain. "Conflict" not "Clash." "Saved view" not
   "Viewpoint." "Slice" not "Section plane." "Floor" not "Storey." Architects
   know these words. BIM coordinators will adapt.

---

**Quaternary persona — The SketchUp + InDesign Architect**

Yara uses SketchUp for quick massing and 3D concept work, and InDesign for
presentation sheets. She has never opened Revit. She receives an IFC file
from a contractor and needs to review it with her team. She is completely
comfortable rotating a 3D model. She is not comfortable with the word
"storey", does not know what BCF is, and will close any panel that shows
an "Express ID" field.

What Yara needs: open the IFC, turn layers on and off (she calls them
layers, not disciplines), add a sticky note to the model, and export a
screenshot for her InDesign layout. She expects the app to feel closer to
SketchUp than to a browser-based BIM tool.

This persona is as important as Sarah. The redesign must work without any
BIM vocabulary whatsoever. If a label requires prior BIM knowledge to
understand, it must be replaced.

---

*End of Chapter 1.*

---

## Chapter 2: Layout Architecture

### Design Principle: As Little Design as Possible

Dieter Rams wrote that good design is "as little design as possible." Every
element of the new layout earns its presence or it is removed. The current
header has 13 buttons. A user on first visit cannot tell which five are
important. When everything is emphasized, nothing is. The new layout applies
Nielsen's first heuristic — visibility of system status — selectively: show
only the state that matters right now, hide the rest behind one tap.

The new shell has five zones. Each zone has one job.

---

### The Five-Zone Shell

```
┌─────────────────────────────────────────────────────────────────┐
│  CC  ClashControl              [Share ▾]  [●]  [☀]  [?]       │  44px
├──────┬──────────────────────────────────────────────┬───────────┤
│      │                                              │           │
│  [▦] │                                              │  Details  │
│  [◉] │                                              │  or AI    │
│  [🔍]│          3 D   C A N V A S                  │  drawer   │
│  [⚙] │                                              │  (slides  │
│      │                                              │  in from  │
│      │                                              │  right)   │
│      │                                              │           │
├──────┴──────────────────────────────────────────────┴───────────┤
│      [ Orbit ]  [ Walk ]  [ Slice ]  [ Measure ]  [ Plan ]  [ Note ]  │  52px
└─────────────────────────────────────────────────────────────────┘
         ↑ mode toolbar floats above bottom edge, not docked
```

- **Top bar** — 44px tall. The thinnest it can be while remaining touchable.
- **Left tab strip** — 48px wide icon column. Four tabs. Clicking opens a
  280px panel beside it. Clicking the active tab collapses the panel.
- **Canvas** — always full-bleed. No clipping, no padding. ViewCube top-right.
- **Right drawer** — 320px, slides in from the right edge. Default: closed.
- **Mode toolbar** — 52px floating pill, centered, 16px from the bottom edge.

The left panel and right drawer can both be open simultaneously. The canvas
shrinks to accommodate them on large screens; on small screens the panel
overlays the canvas with a dim scrim behind it.

---

### Zone 1: Top Bar

The top bar has four groups, left to right.

**Brand** — the ClashControl logo mark (CC monogram in violet gradient) and
the wordmark "ClashControl" in Syne 700. Clicking it does nothing on desktop
(the app is not a page-based tool). On mobile it opens the main menu.

**Flex space** — empty space that grows to fill the available width. This is
the visual breathing room that makes the top bar feel calm rather than crowded.

**Share** — a violet accent pill button, always visible. It opens the Share
modal. It shows an unread badge (red dot with count) when there are unread
comments on the model. This is the most important entry point in the header.
It is treated as the primary call to action.

**Utility group** — three small icon buttons, right-aligned. In order:
sync status dot (green = linked folder synced, amber = syncing, grey = none),
theme toggle (sun/moon icon), help (?). These are secondary. They are smaller
than the Share button and use ghost styling (no background fill).

**What is removed from the current header:** walk button, section buttons,
measure button, BCF import, BCF export, floor plan button, comment mode
button, search input, AI chat button, settings icon, presentation mode button.
All of these move to either the mode toolbar, the left panel, or the Share
dropdown. The header is not the place to discover features. It is the place
to identify where you are and how to share what you see.

---

### Zone 2: Left Tab Strip + Panel

The left strip is 48px wide and holds four tabs as icon-only buttons.
Icon size is 20px. Active tab gets a 2px violet left border accent and
icon fill changes from muted to primary. Tabs, top to bottom:

**Model tab (▦)** — the model panel. Sections: model list (show/hide models,
rename), conflict list (collapsed by default, opens on click), issue list
(same), data quality results (same). All four sections stack vertically,
each with a count badge and collapse chevron. This is the BIM coordinator's
home base, but it is not the first thing you see.

**Views tab (◉)** — saved views and smart views. The top grid shows smart
view presets (By Category, By Floor, Structure only, Services only). Below
that is a list of saved views with thumbnails. One-click restores the camera
to that view. The Share modal deep-links from here.

**Search tab (🔍)** — element search. A text input at the top. Results list
below. Filter chips: by type, by floor, by category, by name. Clicking a
result flies the camera to that element and opens the right drawer with its
details.

**Settings tab (⚙)** — integrations (the renamed Addons panel), user name
field for shared comments, advanced accordion with training data and debug
options, and an About section with version number and changelog link.

The panel width is 280px. It has no resize handle — that complexity is not
worth the cost. On screens narrower than 1024px the panel overlays the canvas
as a sheet from the left edge.

---

### Zone 3: Canvas

The canvas is the entire remaining space between the left strip+panel and the
right edge (or the open drawer). Three.js renders directly into it. No
padding, no border. The canvas background uses the procedural sky gradient
already in the codebase.

**Canvas chrome** — elements that float on top of the canvas without
obscuring it. All use the `cc-overlay-chrome` style: glass background,
subtle border, blur. Positioned in the four corners:

- *Top-right* — ViewCube (already built). Stays. Do not touch.
- *Bottom-right* — FPS counter (grey-to-red, already built) + render style
  chip (1–4 or Standard/Shaded/Rendered/Wireframe). These are compact, 
  small-text overlays that do not demand attention.
- *Top-left* — empty. This corner is reserved for temporary toasts and
  the FOV display in Walk mode.
- *Bottom-left* — empty. Reserved for the minimap in Walk mode (PR-D).

**Click behavior** — clicking a mesh element opens the right drawer with that
element's properties. This is the primary discovery path for Marcus (the
client) and Yara (the SketchUp architect). No modal, no panel switch — the
right drawer slides in while the canvas stays fully visible.

**Drag-drop** — when no model is loaded, the canvas shows the first-run card
(Chapter 5). When a model is loaded, drag-dropping another IFC adds it as a
second model. This matches the SketchUp mental model of importing geometry.

---

### Zone 4: Right Drawer

The right drawer is 320px wide. It slides in from the right edge over a
200ms ease-out transition. It has two tabs: **Details** and **Ask AI**.

**Details tab** — shows the selected element's properties. Sections:
type and name (large, prominent), category and floor (plain labels, not
"IFC type" or "Storey"), material if present, and a linked issues list.
If nothing is selected, the tab shows an empty state: "Click any element
to see its details." Short. Specific. Not generic.

**Ask AI tab** — the existing AIChatPanel, moved here from the left rail.
The tab label "Ask AI" is plain. The input placeholder is "Ask about this
model..." The response area shows the AI's message in a speech bubble,
left-aligned. The user's message is right-aligned. No markdown rendering in
responses — plain text only, because markdown in a small drawer looks like
a formatting accident.

The right drawer closes when the user presses Escape or clicks the X in
the drawer header. It does not close when the user clicks the canvas. A
user might want to read the properties panel while rotating the model.

---

### Zone 5: Bottom Mode Toolbar

The mode toolbar is a floating pill. It is not docked to the bottom edge —
it floats 16px above it. This matters: docked elements feel like they belong
to the browser, not the app. A floating pill feels like a tool tray you can
pick up.

The pill has six chips. Each chip is a mode, not a feature. The distinction
is important: a mode changes what happens when you interact with the canvas.
A feature does a thing and finishes. Walk is a mode. Export is a feature.

```
  [ Orbit ]  [ Walk ]  [ Slice ]  [ Measure ]  [ Plan ]  [ Note ]
```

Active chip styling: `background: var(--accent)`, `color: #fff`, no border.
Inactive chip: glass surface, muted icon + label, subtle hover lift.

Each chip shows its keyboard shortcut on hover in a small tooltip below the
chip. The shortcuts are single keys: Escape, W, S, M, F, N. These match the
SketchUp conventions Sarah and Yara already know (Escape = select, W = walk
around = already intuitive).

**Sub-tool rows** appear in a small secondary pill just above the main
toolbar when a mode is active. For example, activating Slice shows:
`[ X ]  [ Y ]  [ Z ]  [ Box ]  [ Custom ]  [ Flip ]`. Switching to a
different main mode collapses the sub-tool row. Only one sub-tool row visible
at a time.

The mode toolbar only has one job: tell the user what touching the canvas
will do. When you see the toolbar at a glance, you know: Orbit chip is lit,
therefore clicking and dragging will orbit. This is direct manipulation
with explicit mode signaling — the correct pattern from Procreate and iOS
Camera.

---

### Design Principles Applied to This Layout

**Gestalt proximity** — the mode toolbar groups all canvas-interaction modes
in one place. The top bar groups all file-and-share actions. The left strip
groups all model-content panels. Items that belong together are near each
other; items that do not are not mixed.

**Progressive disclosure** — the left panel starts collapsed (only the icon
strip is visible). The right drawer starts closed. The sub-tool row only
appears when a mode needs it. The conflict list inside the Model tab starts
collapsed. Complexity is hidden until the user needs it.

**Nielsen's heuristic 3 — User control and freedom** — Escape always returns
to Orbit mode. The right drawer can be dismissed without penalty. Any section
plane added in Slice mode can be removed with a single click. Nothing is
permanent without explicit save.

**Nielsen's heuristic 7 — Flexibility and efficiency** — keyboard shortcuts
cover all six modes plus theme toggle (T), share (Ctrl+Shift+S), and help (?).
Power users never need to touch the toolbar.

*End of Chapter 2.*
