# [ClashControl](https://www.clashcontrol.io)
> Version: **v5.19.57** (2026-06-09)

[![Sponsor](https://img.shields.io/badge/Sponsor-%E2%9D%A4-ec4899?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/clashcontrol-io)

**Free, open-source online IFC viewer & BIM clash detection — right in your browser.**

A free alternative to Solibri and Navisworks for the everyday IFC coordination loop. No installs. No licenses. No subscriptions. Just open the file and start viewing and checking your models.

## What is it?

ClashControl is a lightweight web app for BIM coordination. Load your IFC models, detect geometric clashes between building elements, create and manage issues, and export everything to BCF — all without leaving your browser.

Built for architects, engineers, and BIM coordinators who are tired of paying thousands for clash detection software that does the same thing.

## Features

- **Load multiple IFC models** — drag & drop or browse, supports any IFC 2x3/4 file
- **Geometric clash detection** — hard clashes (intersections) and soft clashes (clearance violations) via AABB broad-phase + BVH triangle–triangle (Möller–Trumbore) narrow-phase, with optional WASM acceleration
- **3D viewer** — orbit, pan, zoom, section planes, section boxes, floor plan cuts, walk mode, measurement tools
- **Model explorer** — browse elements by storey, IFC type, discipline, or material with visibility toggles and color-by-classification
- **Issue management** — create issues linked to elements, set priority/status/category, assign to team members
- **Data quality & IDS** — BIM-basics, ILS and NL-SfB classification checks, plus IDS (Information Delivery Specification) import/validation
- **AI assistant** — type plain-language commands ("show structural vs MEP clashes", "top view"), and get AI-generated clash titles and triage suggestions
- **Real-world context** — drop the model onto a satellite/OSM basemap from its IFC georeferencing, and load LAS/PLY/PCD/XYZ point clouds as reference layers
- **BCF import/export** — standard BCF 2.1 format for interoperability with Revit, Navisworks, Solibri, and BIMcollab
- **Share projects** — save your entire session (clashes, issues, viewpoints, settings) as a `.ccproject` file and share it with teammates. They import it to see your exact results and continue the work.
- **Viewpoints** — save and restore camera positions with snapshots
- **Dark & light mode** — full theme support
- **Works offline** — PWA with service worker caching, no server required
- **Zero dependencies** — single HTML file, no build step, no node_modules

## What's new

- **Run Detection modal + clustered triage** — one surface for clash setup (quick presets, scope picker, project standards); results collapse into Sentry/Linear-style cluster cards with keyboard triage (J/K/T/R/X) instead of a wall of duplicate hits
- **Real-world placement** — drop the model onto a satellite/OSM basemap from its IFC georeferencing, and load point clouds (LAS/PLY/PCD/XYZ) as reference layers
- **IFC4 georeferencing** — reads `IfcMapConversion` / `IfcProjectedCRS` (EPSG, offset, rotation) for context, with a pre-run placement check that warns when federated models don't share a coordinate base
- **Lighter & faster** — Int8 normals (~630 MB saved on large federations) and instanced rendering for repetitive geometry

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

## Privacy & data security

**Your IFC stays in your browser.** The viewer, the clash engine, the BCF export — all of it runs locally in your tab via WebAssembly (`web-ifc`). Your file is never uploaded to a server. There is no "upload your model" step because there is no server-side processing of models.

Full security architecture, what data optionally goes where, self-host instructions, and the AI provenance audit-trail: **[Security & Privacy →](https://www.clashcontrol.io/security/)**

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

## Smart Bridge security

The optional **Smart Bridge** binary opens a local server on `127.0.0.1:19802` (WebSocket) and `127.0.0.1:19803` (REST). Both sockets are bound to the loopback interface — they are **not** reachable from other machines on your network.

The REST and WebSocket layers enforce an **origin allow-list**: only `https://www.clashcontrol.io`, `https://clashcontrol.io`, and `localhost` / `127.0.0.1` (any port) may connect. CORS is echoed per-request, never wildcarded. A `Host` header check blocks DNS-rebinding attacks. Request bodies are capped at 1 MB. The LLM config file (`~/.clashcontrol/llm-config.json`) is written with `0600` permissions so the API key is not world-readable on multi-user systems. These checks address the 2026 MCP CVE roundup (path-traversal + unauthenticated UI injection + OAuth-token concentration in widely copied reference servers).

## AI governance

Every AI-touched decision carries provenance: model name, source endpoint, timestamp. Surfaced as an "AI" chip in the Issues panel (hover for the model + when it ran), persisted on each clash. The built-in NL assistant is intentionally basic — clash-resolution escalates to your own LLM via the Smart Bridge Connector. No shared foundation-model monoculture, no opaque agent decisions. This is the audit-trail layer Day called out as missing from current agentic-BIM platforms (AEC Magazine, April 2026).

## Tech

Single-file app built with Preact, Three.js, and web-ifc. No build tools, no bundler — just open and go. See [CLAUDE.md](CLAUDE.md) for architecture details and [OPEN_SOURCE_COMPONENTS.md](OPEN_SOURCE_COMPONENTS.md) for all third-party libraries used.

## License

See [LICENSE](LICENSE) for details.
