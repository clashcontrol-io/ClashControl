# Desktop (Tauri) Plan — one codebase, browser + installable

**Goal:** an installable desktop version that breaks through the browser's
large-federation ceilings, while `www.clashcontrol.io` keeps working exactly
as it does today — same `index.html`, no fork, no bundler in dev.

## Why Tauri fits this codebase

Tauri renders a system WebView (WebView2 / WKWebView / WebKitGTK) around our
existing single-file app and adds a Rust backend in the same process. That
matches two facts about ClashControl:

1. The app is already a static `index.html` — Tauri can serve it as-is.
2. The performance-critical native code **already exists in Rust**
   (`engine/` — BVH + tri-tri + spatial hash, currently compiled to WASM).
   In Tauri it runs natively: full multithreading, SIMD, no WASM 4 GB
   memory ceiling, no copy-in/copy-out of triangle buffers.

## What the desktop version actually lifts (and what it doesn't)

| Ceiling | Browser today | Tauri desktop |
|---|---|---|
| Tab OOM kill (~3–4 GB heap) | Hard wall; tab dies | Process uses machine RAM; geometry can live on the Rust side |
| File read | Whole `ArrayBuffer` in JS | Streamed chunked reads from Rust (`std::fs`), source buffer never fully in JS |
| Geometry cache | IndexedDB (quota, eviction) | Plain files in app data dir — no quota, instant project switch |
| Clash narrow phase | WASM (1 thread, 4 GB) | Native Rust, rayon-parallel across cores |
| localhost LLM / bridges | Mixed-content blocked → separate Connector download | WebView talks to localhost directly; bridge can be **built in** |
| Rendering draw calls | Three.js/WebGL limits | **Unchanged** — same WebView GPU path; LOD/instancing still matter |
| web-ifc parsing memory | WASM 4 GB heap | Unchanged short-term (web-ifc stays in the WebView); mitigated by streamed loads + aggressive disposal; native parser is a later option |

Realistic outcome: 300–500 MB federations that currently kill the tab become
workable; multi-GB parity with Navisworks is **not** promised by the shell
alone — it additionally needs the Phase 3 parsing/streaming work.

## Coexistence rules (non-negotiable)

- **One `index.html`.** No desktop fork. Desktop capabilities arrive through
  a new `addons/tauri-bridge.js`, loaded like every other addon and inert in
  the browser. Detection: `typeof window.__TAURI__ !== 'undefined'`.
- **The existing addon law applies:** the web app must work when the addon
  is absent; the desktop app must degrade to web behaviour when a native
  call fails. Same `typeof window._ccFoo === 'function'` guards.
- Public surface goes on `window.ClashControl.*` per CLAUDE.md.
- `sw.js` / PWA registration is skipped inside Tauri (assets are local;
  `pwa.js` already no-ops gracefully when SW registration fails).
- CDN dependencies are vendored into the desktop bundle at **build time**
  (small script rewrites the CDN URLs to local copies — pinned versions +
  SRI hashes make this mechanical). Dev workflow stays CDN-based.

## Phases

### Phase 0 — Shell (1–2 days)
- `desktop/` directory: `cargo tauri init`, `tauri.conf.json` with
  `frontendDist` pointing at the repo root (or a build step that copies
  `index.html` + `addons/` + `icons/` + vendored CDN files into `desktop/dist`).
- CSP: extend the meta CSP for `tauri:` / `ipc:` schemes (Tauri injects its
  own; verify no conflict with ours).
- GitHub Action `release-desktop.yml` modeled on `release-smart-bridge.yml`:
  matrix build (Windows NSIS, macOS dmg, Linux AppImage/deb) on
  `desktop-version.json` bump. Unsigned at first; signing is a later
  certificate/notarization chore, not a blocker for testing.
- **Exit criterion:** installer opens, loads an IFC, runs detection — identical
  to the website.

### Phase 1 — Native quick wins (~1 week)
`addons/tauri-bridge.js` + Rust commands:
- **Native file open/save** (file dialogs, `.ifc`/`.ccproject`/`.bcf` file
  associations, drag-drop of huge files without the browser's File cloning).
- **Streamed model reads**: Rust reads the IFC in chunks; JS receives the
  bytes it needs and releases them (kills the "2× file size in heap during
  load" spike).
- **Disk geometry cache**: replace the IndexedDB geo-cache path with app-data
  files behind the same `idbSaveGeoCache`-shaped interface (guarded swap).
- **Built-in Smart Bridge**: register the existing bridge endpoints
  (`/llm/autodetect`, MCP server) as Tauri commands / a local listener —
  desktop users get Ollama/Claude/MCP with **zero extra installs**, retiring
  the separate Connector download on desktop.

### Phase 2 — Native clash engine (~1 week)
- Wire `engine/` directly as Tauri commands: `mesh_intersect`,
  `mesh_min_distance`, `batch_intersect` + a new `detect_pairs` that takes the
  broad-phase pair list and fans out across cores with rayon.
- JS side: publish the same `window._ccWasmIntersect`-shaped functions from
  `tauri-bridge.js` (the core clash loop already prefers them when present —
  the exact mechanism the WASM addon uses today). WASM remains the web path.
- Geometry transfer: keep world-space triangle buffers cached on the Rust
  side keyed by element id, so repeat runs send ids, not floats.
- **Exit criterion:** `_ccBenchEngine()` desktop vs web on the same model
  shows the multicore win; detection on a 10k+ element federation stays
  responsive.

### Phase 3 — Big-model loading (research → ~2 weeks, the real ceiling-breaker)
- Storey-/discipline-scoped loading: parse the full IFC on the Rust side once
  (native web-ifc build or IfcOpenShell via FFI — decision point), persist a
  tiled geometry cache, stream only visible scopes into the WebView.
- This is where multi-GB federations become honest. Decouple from Phases 0–2;
  ship value before this lands.

### Ongoing
- Auto-update via the Tauri updater (feeds from GitHub releases).
- `desktop-version.json` versioned independently of the web `version.json`
  (web ships continuously; desktop ships in releases).

## Risks
- **WebView variance:** WebGL2 perf differs (WebKitGTK on Linux is the weak
  spot). Mitigation: desktop is an enhancement layer; anything broken falls
  back to the web code path. Test matrix = the 3 OS WebViews.
- **Two release artifacts** to keep green. Mitigation: the browser smoke test
  (`tests/browser/smoke.mjs`) runs against the same `index.html` both ship;
  add a desktop smoke job later using `tauri-driver`.
- **Scope creep toward a fork.** The addon boundary is the defense — if a
  change requires `if (isTauri)` inside core `index.html` beyond the addon
  loader, it's designed wrong.

## Decision needed before Phase 0
- Product name/positioning (e.g. "ClashControl Desktop") and whether the
  website nudges large-model users toward it (the new memory guardrail toast
  is the natural hook).
