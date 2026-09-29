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

### Phase 2 — Native clash engine (status: implemented, unit/integration-tested; NOT yet exercised in a packaged installer on all 3 OSes)
What exists (all verified in CI-style runs, see "Verified" below):
- `engine/` has an off-by-default `native` cargo feature (`engine/src/native.rs`,
  rayon). `NativeEngine` wraps the SAME `Engine` (cached BVHs) the WASM build
  uses — no second algorithm — and adds `register_many` (parallel BVH build)
  and `detect_pairs(pairs, Hard|MinDist)` returning results in input order.
  cargo tests assert f64-bit equality with the single-pair free functions on
  randomized and dense meshes, 1 and N threads. The wasm-pack output
  (`addons/wasm-engine-pkg/`) is byte-identical with the feature off
  (the additions sit at the end of `lib.rs` so panic-location line numbers,
  which end up in the wasm, do not move).
- `desktop/src-tauri/src/engine_cmds.rs`: Tauri commands `register_meshes`,
  `register_mesh`, `unregister_mesh`, `clear_meshes`, `intersect_batch`,
  `min_dist_batch`, `engine_info`. Payloads are raw little-endian bytes
  (`InvokeBody::Raw` in, `ipc::Response` out; layouts in `native::wire`), not
  JSON float arrays. Commands are `async` (off the UI thread); the rayon pool
  uses `cores - 1` threads. Only these commands are allowed: `build.rs`
  declares them and `capabilities/default.json` grants exactly those
  `allow-*` permissions (no `core:*` plugin permissions; a unit test keeps
  build.rs, the handler list and the capability file in sync). `csp` stays
  `null` as before.
- `addons/tauri-bridge.js` (loaded only when `__TAURI_INTERNALS__`/`__TAURI__`
  exists — the core does not even fetch it in the browser). On start it runs
  a self-check of the native commands against `window._ccJsMeshIntersectRef`
  (hit/miss, every raw point, depth, min-distance + closest pair, batch order,
  unknown-id handling); only if everything matches does it publish
  `window._ccNativeNarrow = {api, createPool, info}`. `index.html`'s
  `_ccNarrowPoolCreate` uses it (guarded hook) in place of the Web Worker
  pool: the bridge returns a pool with the worker pool's interface
  (`addWindow`/`results`/`terminate`/`fail`), registers each element's world
  triangles once (keyed by array identity, so a repeat run sends ids, not
  floats), and hands back the same per-pair records the workers produce; the
  core keeps doing post-processing, ordering, filtering on the main thread, so
  output is identical by construction. Any invoke/decode/protocol error drops
  the run's pool (the core finishes the remaining pairs on the main thread
  with WASM/JS) and unpublishes the native path for the session. A pair whose
  id the native side does not know gets no record (main thread computes it) —
  never a silent "no clash". The per-pair sync `_meshesIntersect` is untouched
  (IPC is async).
- `addons/local-engine.js`: with the native engine active it no longer shows
  Install/Download prompts (the panel says the Python engine isn't needed;
  "Connect to a running engine" stays available and never triggers a
  download); the Run-panel engine label shows "Native engine".

Verified: `cargo test` (36) and `cargo test --features native` (41) in
`engine/`; wasm-pack rebuild byte-identical; `cargo test`/`check`/`build` in
`desktop/src-tauri` (commands exercised directly incl. the wire codec and
the capability/build.rs consistency test); the built debug app was run under
`xvfb-run` and its real webview called the real commands through the real
bridge (self-check passed, 576 pairs compared with the JS reference:
0 mismatches, second run sent 0 floats); `node --test tests/tauri-bridge.test.js`
(mocked invoke: inert in browser, self-check gate, fallback on error);
`tests/browser/office-clash-parity.mjs` has a `native` mode (real bridge,
in-page mock commands) proving identical ordered clash output.

Not done / honest limits:
- No multicore win has been measured END TO END inside the app on a real
  federation yet. Engine-level numbers only (`cargo test --release --features
  native bench_parallel -- --ignored --nocapture`, 48 dense meshes / 1128
  pairs, 4-core box: hard 24 ms on 1 thread -> 10 ms on 3 threads; the
  stateless free functions take 847 ms for the same pairs because they
  rebuild BVHs per pair). The post-processing / clash building still runs on
  the JS main thread, so Amdahl applies; `_ccBenchEngine()` desktop vs web on
  a 10k+ element federation is still to do.
- Triangles are duplicated in Rust memory (f32 copy per registered element,
  reset above ~384 MB; garbage-collected elements are unregistered lazily).
  Geometry still originates in the WebView (web-ifc); Rust-side geometry
  ownership belongs to Phase 3.
- Windows/macOS were not built or run; only Linux (WebKitGTK) was.
- CI (`release-desktop.yml`) does not yet run the desktop cargo tests.

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
