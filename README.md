# ClashControl
> Version: **v3.2.33** (2026-03-27)

**Free, open-source IFC clash detection — right in your browser.**

No installs. No licenses. No subscriptions. Just open the file and start checking your models.

## What is it?

ClashControl is a lightweight web app for BIM coordination. Load your IFC models, detect geometric clashes between building elements, create and manage issues, and export everything to BCF — all without leaving your browser.

Built for architects, engineers, and BIM coordinators who are tired of paying thousands for clash detection software that does the same thing.

## Features

- **Load multiple IFC models** — drag & drop or browse, supports any IFC 2x3/4 file
- **Geometric clash detection** — hard clashes (intersections) and soft clashes (clearance violations) using OBB-based collision detection
- **3D viewer** — orbit, pan, zoom, section planes, section boxes, floor plan cuts, measurement tools
- **Model explorer** — browse elements by storey, IFC type, discipline, or material with visibility toggles and color-by-classification
- **Issue management** — create issues linked to elements, set priority/status/category, assign to team members
- **BCF import/export** — standard BCF 2.1 format for interoperability with other BIM tools
- **Viewpoints** — save and restore camera positions with snapshots
- **Dark & light mode** — full theme support
- **Works offline** — PWA with service worker caching, no server required
- **Zero dependencies** — single HTML file, no build step, no node_modules

## What's new

- **Discipline-colored outlines** — element outlines now match the model category color (structural = blue, MEP = red, architectural = purple, civil = green) when selecting or inspecting clashes
- **Smarter soft clash markers** — markers are placed at the actual closest point between elements, weighted toward the smaller element so they no longer appear in the middle of a long beam
- **Detection status in chat** — when clash detection is running with the chat panel open, the input area shows a live status bar with a glowing animated border
- **Clearance & Tolerance tooltips** — hover over the labels for 1 second to see what each setting does
- **Cleaner clash cards** — removed penetration depth display from hard clash cards for a less cluttered list

## How to use

1. Open `index.html` in a modern browser (Chrome, Edge, Firefox)
2. Load two or more IFC models via the sidebar
3. Configure clash rules (model A vs B, hard/soft, clearance distance)
4. Hit **Run** — clashes appear in the right panel
5. Click a clash to fly to it, inspect element properties, change status
6. Export to BCF when done

## Why free?

BIM coordination shouldn't be locked behind expensive licenses. ClashControl gives every project team access to clash detection, regardless of budget. No more paying a lot of money for a license to just do your job.

Of course donations to keep the project running and expand more are welcome.

## Important

ClashControl is not complete nor perfect and you should always verify results yourselves. That said, it will save you lots of money and frustration.

## Tech

Single-file app built with Preact, Three.js, and web-ifc. No build tools, no bundler — just open and go. See [CLAUDE.md](CLAUDE.md) for architecture details.

## License

See [LICENSE](LICENSE) for details.
