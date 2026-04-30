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

*End of Chapter 1. Chapters 2–7 follow.*
