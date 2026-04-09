# ClashControl
> Version: **v4.11.10** (2026-04-09)

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ec4899?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/clashcontrol-io)

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
- **BCF import/export** — standard BCF 2.1 format for interoperability with Revit, Navisworks, Solibri, and BIMcollab
- **Share projects** — save your entire session (clashes, issues, viewpoints, settings) as a `.ccproject` file and share it with teammates. They import it to see your exact results and continue the work.
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

## Privacy

ClashControl shares **anonymous usage data by default** to help improve the AI clash classifier. This is opt-out — you can disable it any time from the Settings menu.

**What is sent**

- IFC type counts (e.g. "150 IfcWall, 32 IfcBeam")
- Geometric metrics for clashes (size ratios, gap distances, intersection volumes — numbers only)
- Whether a clash was marked true positive or false positive
- Natural-language commands you type into the chat (with model and project names stripped)

**What is NOT sent**

- Your IFC files
- Element names, GlobalIds, or coordinates
- Project names, file names, or paths
- Personal information of any kind
- Your IP address (beyond what every web request sends; we don't log it)

**How to opt out**

- Settings → Privacy → toggle off "Anonymous data sharing"
- Or set `localStorage.cc_data_consent = 'denied'` in the browser console
- The first-run banner also has an "Opt out" button

The collection endpoint is [`api/training.js`](api/training.js) — it's a thin Vercel function that writes to a Postgres table. Source is in this repo, audit anything you want.

## Tech

Single-file app built with Preact, Three.js, and web-ifc. No build tools, no bundler — just open and go. See [CLAUDE.md](CLAUDE.md) for architecture details and [OPEN_SOURCE_COMPONENTS.md](OPEN_SOURCE_COMPONENTS.md) for all third-party libraries used.

## License

See [LICENSE](LICENSE) for details.
