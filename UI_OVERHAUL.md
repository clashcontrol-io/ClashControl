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

---

## Chapter 3: The Tools — Architectural Instruments, Not BIM Functions

### From BIM Functions to Drafting Instruments

The most important reframing in this redesign is how the tools are
conceptualized. The current ClashControl treats interaction modes as
*software features* — Walk Mode, Section Plane, Measure Tool. This language
comes from BIM software documentation. It is the language a developer uses
to describe what code does. It is not the language an architect uses to
describe what they are doing.

An architect at a drafting table picks up a pencil, a knife, a scale ruler,
or a red pen. They do not "activate the annotation feature." They pick up the
red pen. The redesign maps each interaction mode to a physical instrument
that an architect already understands:

| Mode       | Drafting equivalent           | Mental model                          |
|------------|-------------------------------|---------------------------------------|
| Orbit      | Walking around a scale model  | I am moving. The building stays still.|
| Walk       | Walking through the building  | I am inside. The building is around me.|
| Slice      | A knife cutting the model     | I am cutting a section to look inside.|
| Measure    | A measuring tape              | I am measuring a distance.            |
| Plan       | Looking straight down         | I am reading a floor plan.            |
| Note       | A red pen / sticky note       | I am marking something for discussion.|

Every tooltip, sub-tool label, and empty state should reinforce the
drafting-instrument metaphor rather than the software-feature framing.

---

### Orbit — Moving Around the Building

Orbit is the default state. When nothing else is happening, the user is
walking around a scale model on a table. Left drag rotates. Right drag pans.
Scroll zooms.

This mode needs no active label in most states — it is the resting state.
The toolbar chip reads "Orbit" but in practice the chip is lit so rarely
because the user only notices it when switching away from another mode.

The tooltip on hover reads: "Rotate, pan, and zoom around the model."
Not "Orbit Camera Mode." Not "Navigation Controls." A sentence that says
what will happen.

Double-clicking an element in Orbit mode flies the camera to face that
element (the existing fly-to behavior). The cursor changes to a crosshair
while in flight, returning to a pointer when settled. No modal, no
interruption.

---

### Walk — Walking Through the Building

Walk mode is activated by the W key or the Walk chip. The mode chip turns
violet. The cursor becomes a crosshair. The movement controls change: WASD
moves, mouse look steers, Space jumps (or ascends in no-clip mode).

The sub-tool row that appears above the toolbar when Walk is active shows
three field-of-view presets labeled exactly as an architectural photographer
would understand them:

```
  [ Narrow 50° ]  [ Natural 75° ]  [ Wide 95° ]  [  ——|—— slider ]
```

"Narrow" is a telephoto lens. "Natural" is approximately what the human eye
sees. "Wide" is a wide-angle architectural photography lens. These labels
mean something to an architect who has worked with photographers. "50°",
"75°", "95°" are present but secondary — the plain label is the primary
affordance.

Shift+scroll dolly-zooms (camera moves forward/back while FOV compensates
to keep subject size constant). The toast that appears at bottom-left reads
"FOV: 75° · Natural" — specific, not generic.

Eye height auto-sets to 1.65m (average standing eye level). A "No-clip"
chip in the sub-tool row removes collision so the user can float through
walls for review purposes.

---

### Slice — Cutting a Section

Slice mode puts a cutting plane through the model. The drafting metaphor is
a hacksaw or a knife: the user is cutting the building to look inside.

The mode chip shows a knife icon (not a scissor, not a plane icon, not ⊡).
Activating Slice mode immediately shows a horizontal cutting plane at mid-
height of the model. The user can then switch to a vertical cut.

Sub-tool row:

```
  [ Horizontal ]  [ Front ]  [ Side ]  [ Box ]  [ Custom ]  [ Flip ]
```

These labels replace the current X/Y/Z axis labels. X, Y, and Z mean
nothing to Yara (the SketchUp architect) in this context. "Horizontal",
"Front", and "Side" are the section orientations she draws on tracing paper.
"Box" cuts from all six sides — useful for looking at a specific room.
"Custom" allows free-angle slicing. "Flip" mirrors the cut direction.

The section plane handle is a flat translucent disk with a drag arrow.
Dragging it moves the plane. Right-clicking it shows a context menu:
"Move to this floor", "Reset", "Remove cut". "Move to this floor" snaps the
plane to the nearest building storey — but the menu says "floor", not
"storey".

The plane is violet (matching the brand accent) with 20% opacity. It is
clearly visible without blocking the interior. The cut edge — where the plane
intersects geometry — is highlighted as a solid violet line.

---

### Measure — Measuring a Distance

Measure mode puts a measuring tape in the user's hand. The cursor changes to
a crosshair with a small ruler icon. First click sets point A. Second click
sets point B. A dimension line appears between them with the distance shown
in the project units (metres or feet, set once in Settings).

The dimension line is dark red — the traditional hand-annotation color in
architectural drawings. The distance label uses the mono font for precision.
Multiple measurements can be placed simultaneously (each is a separate
object).

Sub-tool row when at least one measurement exists:

```
  [ Clear all ]  [ Export to PDF ]
```

"Clear all" removes all measurement overlays. "Export to PDF" is not in the
current codebase — it is a future addition noted here so the sub-tool row
design accounts for it. For now, "Clear all" is the only chip.

Measurement labels stay visible in any render style. They are screen-space
overlays, not world-space geometry, so they do not get hidden when the model
is zoomed out.

---

### Plan — Reading the Floor Plan

Plan mode is the 2D floor plan view. Activating it animates the camera
straight down, sets the projection to orthographic, and runs the polygon-
section cut to show the floor plan as a clean 2D drawing.

The name "Plan" is the correct architectural term. An architect does not say
"I am viewing the floor plan mode." They say "I am in plan." SketchUp uses
the same framing: standard views are "Top", "Front", "Left" — not "plan
view mode."

Sub-tool row in Plan mode:

```
  [ Floor 1 ]  [ Floor 2 ]  [ Floor 3 ]  [ ▾ All floors ]  [ Export SVG ]
```

Floor buttons are named after the actual floor names from the IFC data, not
"Storey 0", "Storey 1". If the IFC contains "Ground Floor", "First Floor",
"Second Floor", those names appear on the chips. If the IFC contains "00",
"01", "02", those appear instead. The data is shown as-is — but the chip
label prefix is never "Storey".

"Export SVG" downloads the current plan view as an SVG that can be opened
in Illustrator or InDesign — the tools Yara already uses. This is the
connection point between the 3D model and her layout workflow.

---

### Note — Marking Up the Model

Note mode is the red-pen mode. The cursor changes to a pin cursor. Clicking
on any surface of the model drops a comment pin. The pin is a small violet
circle with a number. After dropping it, a text input appears immediately —
the user types their comment and presses Enter.

This is identical in behavior to dropping a pin in Google Maps: click,
type, done. No modal, no form, no "create annotation" workflow.

The metaphor for Yara is a physical pin on a printed photo. The metaphor for
Marcus (the client) is a Figma comment. Both of these are so familiar that
no onboarding is needed.

Comment pins are stored in the `.ccproject` sync file (local-first,
no backend). When a folder is linked via Share, everyone who opens the
folder gets the comments. The sync cadence drops to 15 seconds when
unresolved comments exist (already implemented).

Each pin shows the commenter's name, the time, and the comment text in a
small card when hovered. The card has a "Resolve" button that dims the pin
and marks it resolved. Resolved pins show as grey, not violet.

The sub-tool row for Note mode is empty — no sub-tools needed. The action is
atomic: click to pin, type, Enter to save. There is no configuration.

---

### Render Style — The Appearance Dial

Render style is not a mode — it does not change what clicking the canvas
does. It changes how the model looks. It belongs in the canvas corner, not
the mode toolbar.

The current codebase uses keys 1–4 for Standard, Shaded, Rendered,
Wireframe. The corner HUD chip shows these as four small squares at the
bottom-right of the canvas. Clicking cycles through them.

Rename the styles using architectural language:

| Current label | New label    | What it is                                      |
|---------------|--------------|-------------------------------------------------|
| Standard      | Lines        | Material colors + edge lines (SketchUp default) |
| Shaded        | Shaded       | Material colors, no edges (clean surface view)  |
| Rendered      | Rendered     | ACES tone-mapping, soft shadows, sky bounce     |
| Wireframe     | Skeleton     | Edges only, no fill                             |

"Lines" is what SketchUp users call the default view. "Skeleton" is more
evocative than "Wireframe" for non-technical users. "Shaded" and "Rendered"
are self-explanatory.

---

### The Anti-AI-Design Check on Tool Design

The reference audit noted that anti-AI aesthetics reject generic, algorithmic
visual patterns. Applied to tool design, this means:

1. Each tool icon should be drawn specifically for its meaning, not picked
   from an icon library that also appears in spreadsheet apps and CRMs. A
   knife icon for Slice, a tape measure icon for Measure, a pin icon for
   Note. These are recognizable archetypes, not generic symbols.

2. Tool states should be unambiguous. When Slice mode is active, something
   is visibly cut. When Note mode is active, the cursor is a pin. The
   affordance is in the world, not just in the toolbar chip.

3. Sub-tool labels use plain words, not abbreviations. "Horizontal" not "H".
   "Remove cut" not "Del". "Move to this floor" not "Snap". A user reading
   the label for the first time should understand it immediately without
   consulting documentation.

4. Error states are honest. If the IFC file cannot be parsed, the message is
   "We could not open this file. Check that it is a valid IFC file." Not a
   generic "Error 403" or "Something went wrong." Specific, truthful,
   actionable.

*End of Chapter 3.*

---

## Chapter 4: Visual Language & Tone

### The Design Direction

The existing DESIGN.md establishes the component system — tokens, spacing,
motion, button variants. This chapter does not replace it. It specifies the
*direction* of the visual update: what changes, what is added, and why.

The target atmosphere is **an architectural sketchbook digitized**. Not a
dark SaaS dashboard. Not a game engine interface. A space where you could
imagine annotating a building elevation with a pen, flipping through section
cuts, and sending a screenshot to a client. Focused, calm, a little tactile.

The existing dark theme (`--bg-primary: #0f172a`) is a good foundation — it
makes rendered IFC models look dramatically better than a white background.
The accent color is the biggest change: blue (`#2563eb`) is replaced by
violet (`#7c3aed`). Violet is associated with design tools (Figma's dark
purple, Framer's violet), not engineering tools (Autodesk blue, Bentley blue).
This single change shifts the perceived category of the product.

---

### Updated CSS Token Set

The following tokens update or extend the current `:root` block in
`index.html` (line 141). Tokens not listed here remain unchanged.

**Shape — rounder, friendlier**

```css
--radius-sm:   8px;    /* was 6px — buttons, small chips */
--radius-md:   14px;   /* was 8px — inputs, popovers */
--radius-lg:   20px;   /* new — modals, drawer header */
--radius-pill: 999px;  /* unchanged */
```

Rounding up from 6→8 and 8→14 is a meaningful shift. At 6px, elements feel
precise and engineering-coded. At 14px, they feel approachable and considered.
Figma uses 8–12px. Notion uses 6–10px. We land slightly above both because
our content is 3D architectural geometry — the shell should soften the
contrast with the technical model.

**Brand — violet replaces blue**

```css
--accent:          #7c3aed;                       /* violet-700 */
--accent-light:    #8b5cf6;                       /* violet-500 */
--accent-hover:    #6d28d9;                       /* violet-800 */
--accent-dim:      rgba(124,58,237,.12);          /* soft fill */
--accent-bg:       rgba(124,58,237,.1);           /* was #1e3a5f */
--accent-bg-deep:  rgba(124,58,237,.2);           /* was #172554 */
--accent-subtle:   #c4b5fd;                       /* violet-300 for dark bg */
```

The logo gradient stays: `linear-gradient(135deg, #00e5ff 0%, #7c3aed 100%)`
(cyan → violet). The cyan endpoint is kept for contrast — a pure violet
gradient is heavy. The brand mark reads "design precision" (cyan) meeting
"spatial thinking" (violet).

**Glass surfaces — new set of tokens**

Glass is used for the top bar, mode toolbar pill, right drawer, and any
floating HUD. It is a functional choice, not a decorative one: glass signals
"this panel is in front of the canvas" without covering the model with an
opaque white box. The blur reinforces depth.

```css
--glass-bg:        rgba(15,15,20,.72);
--glass-border:    rgba(255,255,255,.08);
--glass-blur:      blur(16px);
--glass-bg-light:  rgba(250,248,245,.88);  /* light theme variant */
--glass-border-light: rgba(0,0,0,.08);
```

Usage rule: apply glass only to elements that float over the canvas. Panel
interiors (left panel, right drawer interior) use `--bg-secondary` — a solid
surface, not glass. Glass on every surface creates visual noise. Glass only
where depth is being communicated.

**Light theme — warm parchment, not clinical white**

The light theme currently uses `--bg-primary: #f8fafc` (a cool grey-white).
Update to a warm off-white:

```css
[data-theme=light] {
  --bg-primary:   #faf8f5;   /* warm parchment */
  --bg-secondary: #ffffff;
  --bg-tertiary:  #f3f1ee;   /* warm recess */
  --glass-bg:     var(--glass-bg-light);
  --glass-border: var(--glass-border-light);
  --scene-bg:     #e8e4de;   /* warm canvas background */
}
```

Warm light mode feels like a printed architectural drawing or a physical
model on a white table. Cool grey-white feels like a generic SaaS product.
This is a small change with a disproportionate effect on perceived warmth.

---

### Typography — What Changes

The font families are unchanged (Syne, DM Sans, DM Mono). The type scale
tokens in DESIGN.md remain in place. Two specific changes:

**Display headings** — the CC wordmark and modal titles already use Syne 700.
Extend this to the mode toolbar chip labels when no model is loaded and
the app is in its welcome state. The large "Drop an IFC file" heading on the
first-run card uses Syne 800 at 1.75rem. This is the single "hero moment"
where display typography is visible at scale.

**Mono labels** — expand usage of DM Mono. The render style chip text
("Lines", "Shaded", etc.), the FOV display ("75°"), the FPS counter, and
all measurement readouts use mono. These are numbers and technical labels
that benefit from fixed-width spacing. This is a subtle signal: mono =
precise readout, sans-serif = human label. The distinction helps users parse
information faster.

---

### Motion — No Decorative Animation

The existing motion tokens (`--duration-fast: 120ms`, `--duration-base: 200ms`)
are correct. The rule for this redesign: **animate only state transitions
that communicate information**. Do not animate to delight.

What gets animated:
- The left panel sliding in when a tab is clicked (communicates: this panel
  came from the left, it will return to the left)
- The right drawer sliding in from the right (same)
- Mode toolbar chips transitioning from inactive to active fill (communicates:
  the active mode changed)
- Comment pins appearing with a brief scale animation (communicates: the pin
  was placed here)
- The first-run card fading in when no model is loaded (communicates: you are
  at the beginning)

What does not get animated:
- Hover states on most elements (120ms transition is enough; keyframe
  animations on hover are decorative)
- The canvas fly-to camera movement (this is already smooth from the existing
  tween system; no change needed)
- The ViewCube rotation (already smooth; no change)
- Loading spinners (a single CSS spin animation is sufficient; no lottie,
  no multi-step loader)

The `@media (prefers-reduced-motion: reduce)` block must cover all of the
above transitions by setting their duration to 1ms. Users who set this
preference do so because motion causes discomfort. Respect it.

---

### Iconography — Specific Over Generic

The current icon set uses a mix of Lucide icons (already inlined as SVG
strings in the HTML) and custom paths. The redesign does not replace the
icon library — it refines which icon is chosen for each concept.

Rules for icon selection:
1. The icon should have one obvious meaning. A funnel icon means "filter".
   A magnifying glass means "search". Do not use a magnifying glass for
   "zoom in" — that conflicts with its search meaning.
2. Icons that represent physical tools should look like those tools. The
   Slice knife icon should look like a scalpel, not an abstract line. The
   Measure icon should look like a ruler, not a resize handle.
3. Icon-only buttons outside the mode toolbar must have `aria-label` and
   show a text tooltip on hover (already enforced in DESIGN.md).
4. The mode toolbar chips show icon + label always (not icon-only). Labels
   are hidden only on screens narrower than 480px, where they collapse to
   icon-only with a bottom-edge label bar.

The existing icons that need replacement:
- Section plane button: currently a polygon icon → replace with scalpel/knife
- Walk mode button: currently footsteps → keep (it is clear)
- Comment/pin: currently a speech bubble → replace with pin/thumbtack
- Addons (now Integrations): currently a puzzle piece → replace with a
  plug icon (universal for "connect to external service")

---

### Copy Tone — Plain, Specific, Human

The research in Chapter 1 referenced Gov.uk, Mailchimp, and Shopify Polaris
as the benchmarks for copy that sounds human rather than AI-generated. The
specific test from Polaris: "Read it out loud. Does it sound like something
a human would say?"

Applied to ClashControl, the principle is: **say what it does, not what it
is**. A label is not a product description. It is a direction.

**Words and phrases to avoid in the UI:**

| Avoid               | Use instead                              |
|---------------------|------------------------------------------|
| Seamless            | (never use — say what is smooth)         |
| Intuitive           | (never use — show, don't claim)          |
| Powerful            | (never use — be specific about the power)|
| Leverage            | Use                                      |
| Navigate            | Go to, move to, open                     |
| Utilize             | Use                                      |
| Capture viewpoint   | Save this view                           |
| Activate            | Turn on, start, open                     |
| Functionality       | Feature, tool, option                    |
| End user            | You, the user                            |
| Surface             | Show, display                            |

**Empty states** should always name the specific thing that is empty and say
what to do about it:

| Panel | Empty state text (current) | Empty state text (new) |
|---|---|---|
| Model tab — conflicts | "No clashes detected" | "No conflicts yet. Run a conflict check to find overlapping elements." |
| Model tab — issues | "No issues" | "No issues added. Click any element and mark it as an issue." |
| Views tab | "No viewpoints saved" | "No saved views. Set up a view you like, then click Save view." |
| Search tab | (no model loaded) | "Open a model to search its elements." |
| Note mode — no comments | "No comments" | "Click anywhere on the model to leave a note." |
| Right drawer — nothing selected | (no state shown) | "Click any element to see its details." |

Every empty state tells the user what to do next. No empty state is a dead end.

*End of Chapter 4.*

---

## Chapter 5: Feature Remapping & Naming Pass

### The Problem with the Current Feature Map

The current UI has 28 distinct entry points to features. No user discovers
all of them without reading documentation. Some features have been added
progressively over time and ended up where there was space, not where they
logically belong. The walk mode button is in the header next to the BCF
import button. The comments icon is in the left rail next to the Data Quality
tab. There is no coherent information architecture — just accumulation.

This chapter maps every current entry point to its new home and specifies
the correct label for each.

---

### Full Feature Remapping Table

| Feature | Current location | Current label | New location | New label |
|---|---|---|---|---|
| File open / drag-drop | Welcome popup + header | Open file | Canvas drop zone + top bar "Open ▾" | Open |
| BCF import | Header icon | Import BCF | Top bar "Open ▾" dropdown | Import BCF report |
| Model list | Left rail — Models | Models | Left panel — Model tab (top) | Models |
| Model visibility | Model list toggle | Eye icon | Model tab — visibility toggle | Hide / Show |
| Model color | Model list color swatch | Color swatch | Model tab — color chip | Colour |
| Model discipline | Model list dropdown | Discipline | Model tab — category chip | Category |
| Conflict detection | Left rail — Clashes | Clashes | Left panel — Model tab, Conflicts section | Check for conflicts |
| Conflict list | Left rail — Clashes | Clashes | Model tab — Conflicts section | Conflicts |
| Issue list | Left rail — Issues | Issues | Model tab — Issues section | Issues |
| Issue create | Clash row "+ issue" | Create issue | Element right-click → "Add issue" | Add issue |
| Data quality | Left rail — Data Quality | Data Quality | Model tab — Quality section | Quality |
| Viewpoints | Left rail — Viewpoints | Viewpoints | Left panel — Views tab, list | Saved views |
| Save viewpoint | Viewpoints panel button | Save view | Views tab → "Save view" button | Save view |
| Smart views | SmartViewsModal | Smart Views | Left panel — Views tab, grid (top) | Views |
| Element search | Header search input | Search… | Left panel — Search tab | Search elements |
| Element properties | Right click → properties | Properties | Right drawer — Details tab | Details |
| Walk mode | Header button | Walk | Mode toolbar chip | Walk |
| FOV controls | Walk HUD (auto-shown) | Narrow/Normal/Wide | Walk sub-tool row | Narrow / Natural / Wide |
| Section plane | Header button ✂ | Section | Mode toolbar chip → Slice | Slice |
| Section box | Header button □ | Section Box | Slice sub-tool row → Box | Slice box |
| Section reset | Section controls | Reset | Slice context menu | Remove cut |
| Measure | Header button | Measure | Mode toolbar chip | Measure |
| Floor plan | Left rail icon | Floor Plan | Mode toolbar chip | Plan |
| Floor plan export | Floor plan panel | Export SVG | Plan sub-tool row | Export as SVG |
| Comment pins | Left rail icon | Comments | Mode toolbar chip | Note |
| AI chat | Left rail icon | AI Chat | Right drawer — Ask AI tab | Ask AI |
| Share | Header icon (16px) | Share | Top bar accent button | Share |
| Share folder link | Share modal | Link Folder | Share modal — Overview tab | Link a folder |
| Presentation mode | Keyboard P only | (hidden) | Top bar — Share ▾ dropdown | Present |
| BCF export | Header icon | Export BCF | Share ▾ dropdown | Export BCF report |
| Screenshot | (no explicit UI) | — | Share ▾ dropdown | Copy screenshot |
| Render style | Keys 1–4 only | (hidden) | Canvas bottom-right HUD chip | Lines / Shaded / Rendered / Skeleton |
| Theme toggle | Header icon | Theme | Top bar utility group | (sun/moon icon, no label) |
| Help | Header ? icon | Help | Top bar utility group | (? icon) |
| Keyboard shortcuts | Help modal | Shortcuts | Help overlay — Shortcuts tab | Shortcuts |
| Integrations (addons) | Settings panel | Addons | Left panel — Settings tab | Integrations |
| Shared project settings | Addon panel | Shared Project | Settings tab — top section | Sharing |
| User name | Shared project panel | Your name | Settings tab — Sharing | Your name |
| Training data | Settings panel | Training Data | Settings tab — Advanced | Training data |
| Changelog | Settings panel | Changelog | Settings tab — About | What's new |
| Version number | Settings panel | Version | Settings tab — About | Version |
| Revit connector | Addons | Revit Bridge | Settings tab — Integrations | Revit |

---

### Naming Principles Applied

The table above follows four naming rules:

**1. Verbs for actions, nouns for places.** "Check for conflicts" is an
action (verb phrase). "Conflicts" is a section label (noun). "Save view" is
an action. "Saved views" is a list label. Do not mix these — "Clashes" as a
tab label was a noun used where a verb belonged: clicking it detects clashes,
it does not show a list of them. The redesign separates the detection action
("Check for conflicts" button) from the list label ("Conflicts").

**2. Plain English, no BIM jargon.** "Storey" → "Floor". "Discipline" →
"Category". "Viewpoint" → "Saved view". "BCF" stays as-is in labels aimed at
BIM coordinators (the third persona) but disappears from primary navigation.
"Express ID" stays in the Details drawer (it is a technical reference for
the secondary persona) but never appears in the Model tab or mode toolbar.

**3. No generic labels.** "Settings" is acceptable for the settings tab
because it is a universal convention. "Addons" is not — it is a developer
term. "Options" would also be wrong — it is too generic to be useful. The
correct label is "Integrations" because that is exactly what they are:
connections to external tools (Revit, shared folders, training data).

**4. Consistent tense for modal actions.** Buttons in modals that perform
an action use present tense: "Share", "Save", "Export", "Import", "Check".
Not "Sharing", "Saving", "Exporting". Not "Share it", "Save the view". Just
the verb. This is the Mailchimp principle: short, direct, active.

---

### Terminology Reference Card

This card is for anyone writing UI copy in `index.html`. Pin it.

**Model content**
- The building is a **model**. Multiple models are loaded into the **scene**.
- Geometric overlaps are **conflicts** (not clashes, not intersections).
- Resolved conflicts become **resolved** (not closed, not fixed).
- A tracked problem is an **issue** (not a ticket, not a task).
- A building level is a **floor** (not storey, not level, not Etage).
- A collection of similar elements is a **category** (not discipline, not type group).
- An element type is its **type** (not IFC type, not entity type).

**Navigation and views**
- A saved camera position is a **saved view** (not viewpoint, not bookmark).
- Preset configurations are **views** (not smart views — "smart" is jargon).
- Rotating around the model is **orbiting** (verb: orbit, pan, zoom).
- Moving through the building is **walking** (not flying, not first-person).
- Cutting the model is **slicing** (not sectioning, not clipping).

**Collaboration and sharing**
- Sending access to others is **sharing** (not publishing, not exporting a link).
- A linked sync folder is a **shared folder** (not a shared project, not a link).
- A text pin on the model is a **note** (not a comment, not an annotation).
- A resolved note is **resolved** (not closed, not done, not fixed).
- Your identity in shared notes is your **name** (not username, not handle).

**Technical (Details drawer only — never in primary navigation)**
- An element's numeric identifier is its **ID** (Express ID is the technical term;
  use "ID" in the UI).
- A file format is an **IFC file** (spell it out: "Open an IFC file", not "Open IFC").
- BCF is always spelled "BCF" in labels aimed at BIM coordinators; avoid it
  entirely in labels aimed at the architectural office personas.

*End of Chapter 5.*

---

## Chapter 6: First-Run Experience & Onboarding

### The Problem with the Current Welcome Screen

The current welcome popup opens with a header reading "Welcome to
ClashControl" and immediately presents clash detection settings: rule
configuration, discipline filters, clearance distances. This is the right
workflow for Lukas (the BIM coordinator). It is a wall of jargon for Sarah
(the presenting architect), Marcus (the client), and Yara (the SketchUp
architect).

The welcome popup also has a visual structure borrowed from a dialog box —
a card with a close button, sections with labels, and buttons at the bottom.
It looks like a settings screen, not an invitation.

The redesign replaces this with an approach borrowed from Notion's first-run
experience and the iOS Photos app: the canvas is the first thing you see,
and the only prompt is to add something to it.

---

### The First-Run Card

When no model is loaded, a centered card floats over the canvas. The canvas
itself is visible behind it — the procedural sky gradient is running,
the grid is visible, and the ViewCube is in its corner. The card is not a
modal; it has no backdrop scrim. It says: "the canvas is already here, just
add something to it."

**Card layout (top to bottom):**

The CC wordmark in violet gradient at the top, 48px tall. Below it, in
Syne 800 at 1.75rem: "Open a building model." The line under it, in DM Sans
regular at 0.9rem, text-muted: "IFC files stay on your computer. Nothing
is uploaded." This single sentence addresses the first concern that an
architect who cares about client data will have.

Below the copy, a large drop zone: a dashed rounded rectangle, 100% card
width, 120px tall. Inside it: a building outline icon (simple, architectural)
and the text "Drop an IFC file here". Below the drop zone: a smaller
secondary button "Choose a file" for users who prefer a file picker.

Below the drop zone, two small cards side by side:

- **Try a sample model** — loads a small bundled IFC (a simple one-storey
  building). Label: "Try a sample". Description: "A small building model to
  explore the tool." This is for Marcus and Yara who do not have an IFC
  handy but want to see how it works.

- **Open from URL** — an input field that accepts a URL to an IFC file.
  This is for teams who store IFC files on a shared server. Label: "Open
  from URL". Placeholder: "Paste a link to an IFC file".

At the bottom of the card, a faint link text: "Working with a team? Link
a shared folder →". Clicking this opens the Share modal directly to the
folder-linking flow.

**What is not on the card:** clash detection settings, BCF import, project
keys, training data, addons. These exist — they are just one level deeper,
in the panels that appear after a model is loaded.

---

### Card Animation

The card enters with a 200ms fade + scale from 0.95 to 1.0. The sky
gradient behind it is already animating subtly. The overall effect is:
you open the app and see a living, lit canvas with a simple prompt floating
in the center of it. It feels like standing in front of an empty drafting
table.

When the user drops a file or selects one, the card exits with a 150ms
fade-out. The IFC loads with the existing loading spinner (centered on the
canvas) and progress text. When loading completes, the camera fits to the
model and the mode toolbar fades in from below.

When returning users open the app with a previously loaded model in memory
(or with a linked shared folder that auto-reconnects), the card does not
appear at all. The model is already there. The toolbar fades in and the user
is immediately in the 3D view.

---

### The Loading State

The existing loading flow shows a percentage counter and a spinner. The
redesign keeps this but adds two improvements:

**Progress labels.** Instead of "Loading... 34%", show what is actually
happening: "Reading file structure...", "Building geometry...", "Extracting
properties...", "Finishing up...". These four phases correspond to the
actual WASM parsing pipeline. Showing them reduces perceived wait time and
signals that the app is doing something specific, not just stuck.

**Abort option.** A small "Cancel" text link appears after 3 seconds of
loading. Clicking it aborts the load and returns to the first-run card. This
addresses the case where a user accidentally drops a very large IFC file or
the wrong file. Currently there is no way to cancel — the only option is to
reload the page.

---

### After Loading — The First Model Moment

The first time a model loads successfully, a subtle guidance bar appears
at the bottom of the canvas above the mode toolbar. It reads:

"Orbit: drag to rotate · Scroll to zoom · Click any element for details"

This bar fades out after 8 seconds or when the user interacts with the
canvas. It does not appear on subsequent loads. It is stored as a seen-flag
in localStorage. This is the entire onboarding. No tour overlay, no tooltip
sequence, no video.

The guidance bar uses the same glass surface as the mode toolbar. Text is
`--text-muted` at `--text-xs`. It is present but not demanding.

---

### The Share Entry Point During First Run

For Marcus (the client) who receives a URL with a model pre-loaded via
URL hash (PR-C from the PLAN.md roadmap), the first-run card never appears.
The URL hash contains the camera position, the model reference, and any
active section or visibility settings. The app opens directly to the model
with the camera at the shared position.

The only thing that appears on first open via a shared URL is a small
toast at the top of the canvas: "Viewing [model name] · Shared by Sarah →".
Clicking the arrow opens the Share modal where Marcus can see the full
sharing context, link comments, and add his own notes.

This path requires PR-C (shareable URL hash) to be implemented. Until it is,
the first-run card appears for all users.

---

### Empty States After Loading

Once a model is loaded, the first-run card is gone. The panels that open
from the left strip have their own empty states, specified in Chapter 4.
Two additional states deserve attention:

**No geometry loaded** — if the IFC file parsed successfully but produced
no renderable geometry (this can happen with IFC files that contain only
data, no geometry), the canvas shows: "This model has no visible geometry.
It may contain only properties or metadata." This is a specific, honest
message. Not "Rendering failed."

**Model too large** — if the IFC file contains geometry that exceeds the
threshold where the viewport would run at under 10 FPS on an average laptop,
a banner appears: "This model is large. Some views may be slow. Try
'Skeleton' style for faster performance." The banner has a one-click button
to switch to Skeleton style. The performance threshold is checked against
triangle count after loading, not before.

*End of Chapter 6.*
