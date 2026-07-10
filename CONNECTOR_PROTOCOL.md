# ClashControl Connector Protocol — v1.0

This document describes the open WebSocket protocol that ClashControl (`www.clashcontrol.io`) uses to communicate with a locally-running **Connector** application. Any tool — Revit plugin, Archicad add-on, Rhino script, Python service, etc. — that implements this protocol can act as a live data source for ClashControl.

## Conformance language

The keywords **MUST**, **SHOULD**, and **MAY** in this document are used per RFC 2119
(adopted from Mycelium's `spec/connective-spine.md`, cross-repo learning plan T12 — this
protocol was versioned informally before, with "should" used loosely rather than as a
defined term). Existing prose below predates this section and has not been retrofitted
keyword-by-keyword; new sections and edits should use the keywords deliberately.

## Versioning

Contract semver, matching Mycelium's convention: an **additive** change (a new optional
field, a new message `type`, a new server-push notification) bumps **minor**; a **breaking**
change (removing/renaming a required field, changing a message's shape, changing join/handshake
semantics) bumps **major** and needs a documented migration note in this file. See
[Protocol version](#protocol-version) below for the wire-level compatibility rule this
maps to.

---

## Ports and transport

| Service | Default port | Transport | Direction |
|---------|-------------|-----------|-----------|
| **Connector** | `19780` | WebSocket + HTTP | Connector listens; CC connects |
| Smart Bridge WS | `19802` | WebSocket | CC listens; AI assistant connects |
| Smart Bridge REST | `19803` | HTTP | CC listens; AI assistant calls |

ClashControl dials **`127.0.0.1`** first (explicit IPv4 loopback, avoids the Windows DNS quirk where `localhost` resolves to `[::1]` before `127.0.0.1`). If the socket closes before it ever opens — i.e. immediate `ECONNREFUSED` — CC automatically retries on **`[::1]`** (IPv6 loopback) before starting exponential backoff. This covers both binding configurations without user action.

**Connector binding recommendation:** listen on **both** `127.0.0.1:<port>` (IPv4 loopback) **and** `[::1]:<port>` (IPv6 loopback) — two explicit listeners, not `0.0.0.0` or `::`. Binding to `0.0.0.0`/`::` would expose the server on every network interface (LAN, Wi-Fi), which is unintended for a local desktop tool. Dual-loopback gives reachability on both IPv4 and IPv6 with no network exposure. The same recommendation applies to the Smart Bridge server (ports 19802/19803).

---

## Smart Bridge server (ports 19802 and 19803)

The **Smart Bridge** is a locally-running binary (`clashcontrol-smart-bridge`) that bridges CC to AI assistants (Claude Desktop/Code via MCP, ChatGPT via REST, or any function-calling LLM). Unlike the Connector (which CC dials), the Smart Bridge **owns the server** on two ports:

| Port | Transport | Role |
|------|-----------|------|
| `19802` | WebSocket | Smart Bridge listens; CC dials in as client |
| `19803` | HTTP REST | Smart Bridge listens; CC polls `/status`, `/llm-config`, `/update`, `/chat` |

CC probes `http://<host>:19803/status` on a 500 ms timeout to detect whether the binary is running, then opens `ws://<host>:19802`. It applies the same `127.0.0.1` → `[::1]` fallback as for the Connector.

### Smart Bridge REST endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/status` | Returns `{ version, ...}`. Used as a liveness probe. |
| `GET` | `/update` | Returns `{ update_available, version }`. |
| `POST` | `/update` | Triggers self-update: binary downloads latest release and restarts. |
| `GET` | `/llm-config` | Returns stored LLM provider config. |
| `POST` | `/llm-config` | Saves LLM provider config. Body: `{ provider, model, baseUrl, apiKey }`. |
| `GET` | `/llm/autodetect` | Auto-detects running local LLM servers. Returns `{ found: [...] }`. |
| `POST` | `/chat` | Forwards a user message to the configured LLM. Body: `{ message, history }`. |

### Smart Bridge WebSocket protocol

CC connects to `ws://127.0.0.1:19802` (with `[::1]` fallback). On `onopen` CC sends a `tool_manifest` frame:

```json
{ "type": "tool_manifest", "tools": [ { "name": "get_status", "description": "...", "inputSchema": { ... } } ] }
```

The bridge forwards tool calls from the AI as:

```json
{ "id": "abc123", "action": "get_status", "params": {} }
```

CC executes the handler and replies:

```json
{ "id": "abc123", "result": { ... } }
```

Server-push notifications from the bridge to CC:

| `type` | Meaning |
|--------|---------|
| `update_available` | A newer bridge binary is available. Fields: `version`, `url`. |
| `update_downloading` | Bridge is downloading its own update. |
| `update_installed` | Update complete; bridge is about to restart. |
| `mcp_config_installed` | Claude Desktop config file was written on request. |

### Smart Bridge binding recommendation

The binary should listen on **both** `127.0.0.1:19802` (IPv4 loopback) **and** `[::1]:19802` (IPv6 loopback) — two explicit listeners. Do **not** bind to `0.0.0.0` or `::`: that would expose ports 19802/19803 on every network interface (LAN, Wi-Fi), allowing anyone on the same network to call CC tools. Dual-loopback is localhost-only and reachable on both address families. Apply the same to port 19803.

---

## HTTP health check

ClashControl probes `http://127.0.0.1:19780` with a `GET` in `no-cors` mode at startup to detect whether a Connector is present without opening a WebSocket. A Connector should respond with any HTTP 2xx (or simply accept the TCP connection). This probe has a 2-second client-side timeout.

---

## WebSocket handshake

1. ClashControl opens `ws://127.0.0.1:<port>` (default `19780`).
2. Once the socket is open, CC sends `{"type":"ping"}`.
3. The Connector responds with `{"type":"pong", ...}` (see below).
4. Protocol is now active.

CC enforces a **5-second handshake timeout** — if the socket is accepted at TCP level but the WebSocket upgrade never completes, CC closes the socket and retries with exponential backoff (1 s → 2 s → 4 s … capped at 30 s).

**Origin validation:** Connectors should validate the `Origin` header against an allow-list of ClashControl origins (plus common localhost dev ports). The literal string `"null"` is **deliberately accepted**: browsers send `Origin: null` for pages opened from `file://`, and being able to run a local dev copy of `index.html` straight from disk is a supported workflow. Requests with no `Origin` header at all (non-browser clients) are also accepted.

---

## Protocol version

Both sides carry a version string in `"1.0"` (semver major.minor).

- **Same major** → compatible; minor mismatches are logged but not fatal.
- **Different major** → CC shows a version-warning banner and some features may not work.

The Connector should report its protocol version in the `pong` / `status` message:

```json
{ "type": "pong", "version": "1.0", "documentName": "Project.rvt" }
```

CC's expected version constant: `EXPECTED_PROTOCOL_VERSION = '1.0'`.

---

## Message reference

All messages are JSON objects sent as WebSocket text frames. Binary frames are not used.

### CC → Connector

#### `ping`
Sent immediately after the WebSocket opens.

```json
{ "type": "ping" }
```

---

#### `export`
Request a geometry export. The Connector streams back `export-start` → `model-start` → `element-batch` (×N) → `model-end` → `export-end`.

```json
{
  "type": "export",
  "categories": ["all"],
  "projectId": "optional-project-key",
  "modelFilter": {
    "exclude": ["LinkModel.rvt"]
  },
  "knownElements": {
    "<globalId>": "<contentHash>",
    "...": "..."
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `categories` | string[] | Revit/tool categories to include. `["all"]` means everything. |
| `projectId` | string? | Optional project scoping key. |
| `modelFilter` | object? | `{ exclude: string[] }` — raw model names (exactly as announced in `model-start.name`) the Connector must skip sending. Matched by **exact** name, so excluding `"Arch.rvt"` does not also exclude `"Arch.rvt (2)"`. A legacy include-by-name form (a `{name}` object, a bare string, or an array of either — only listed models export, matched case-insensitively) is also accepted for back-compat. Honored by the reference Connector since v0.1.8; older Connectors may ignore this field, and CC also filters on receive. |
| `knownElements` | object? | Content-addressable delta cache: a map of `globalId → contentHash` for elements CC already has. The Connector should only stream elements whose hash has changed. Omitted on a first-time pull. Capped at 20 000 entries by CC. |

---

#### `cancel-export`
Abort an in-progress export.

```json
{ "type": "cancel-export" }
```

---

#### `resume-session`
Sent on reconnect when CC has cached element hashes from a previous session, to request a delta rather than a full re-export.

```json
{
  "type": "resume-session",
  "knownElements": { "<globalId>": "<contentHash>", "...": "..." }
}
```

If the Connector's cache is gone (e.g. the host app restarted), it replies with `session-expired` and CC will follow up with a full `export`.

---

#### `push-clashes`
Push open clashes and issues back to the Connector so they can be visualised / annotated in the authoring tool.

```json
{
  "type": "push-clashes",
  "clashes": [
    {
      "id": "clash-uid",
      "status": "open",
      "priority": "high",
      "type": "hard",
      "point": { "x": 1.2, "y": 3.4, "z": 5.6 },
      "elementA": {
        "globalId": "3g7k...",
        "name": "Pipe 150mm",
        "ifcType": "IfcFlowSegment",
        "revitId": 123456
      },
      "elementB": {
        "globalId": "9a1m...",
        "name": "Beam UC254",
        "ifcType": "IfcBeam",
        "revitId": 789012
      }
    }
  ],
  "issues": [
    {
      "id": "issue-uid",
      "title": "Pipe crosses beam",
      "status": "open",
      "priority": "normal",
      "description": "Needs routing change",
      "elementIds": [
        { "globalId": "3g7k...", "name": "Pipe 150mm", "revitId": 123456 }
      ]
    }
  ]
}
```

Only clashes with status `open`, `confirmed`, or `in_progress` are sent. The Connector should reply with `push-clashes-ack`.

---

#### `highlight`
Tell the Connector to highlight specific elements in the authoring tool view.

```json
{ "type": "highlight", "globalIds": ["3g7k...", "9a1m..."] }
```

---

#### `clear-highlights`
Remove all highlights from the authoring tool view.

```json
{ "type": "clear-highlights" }
```

---

#### `camera-sync` (CC → Connector)
Synchronise the CC viewport camera to the authoring tool. Sent at most 5 times per second when camera sync is enabled by the user.

```json
{
  "type": "camera-sync",
  "position": [x, y, z],
  "target": [x, y, z],
  "up": [x, y, z],
  "fov": 60
}
```

All coordinates are in the same world-space metre units used for element geometry (see [Coordinate system](#coordinate-system) below).

---

### Connector → CC

#### `pong` / `status`
Reply to `ping`, or an unsolicited status update.

```json
{
  "type": "pong",
  "version": "1.0",
  "connectorVersion": "0.1.8",
  "documentName": "Project.rvt",
  "projectUniqueId": "8a3f...",
  "connected": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Protocol version (e.g. `"1.0"`). |
| `connectorVersion` | string? | Connector application version (e.g. `"0.1.8"`). CC checks GitHub for updates. |
| `documentName` | string? | Human-readable name of the open document. |
| `projectUniqueId` | string? | Stable project identity (used to match a session across reconnects). |
| `connected` | bool? | Optional connected flag. |

---

#### `export-start`
Signals the beginning of a multi-model export sequence.

```json
{
  "type": "export-start",
  "totalModels": 3,
  "totalElements": 12500,
  "projectUniqueId": "8a3f..."
}
```

---

#### `model-start`
One per model (host + each linked file). CC creates a separate model entry for each.

```json
{
  "type": "model-start",
  "name": "Architecture.rvt",
  "documentName": "Architecture.rvt",
  "isLinked": false,
  "elementCount": 4200,
  "docVersion": "20240601.01",
  "numberOfSaves": 42
}
```

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Model display name (document filename). |
| `isLinked` | bool? | `true` for Revit linked models / XREFs. Also accepted as `isLink`. |
| `elementCount` | number? | Expected total elements; used for progress bar. |
| `docVersion` | string? | Document version string (for freshness tracking). |
| `numberOfSaves` | number? | Save count, stored in model stats. |

---

#### `element-batch`
One or more batches of elements following a `model-start`.

```json
{
  "type": "element-batch",
  "batchIndex": 0,
  "totalBatches": 25,
  "elements": [
    {
      "globalId": "3g7k...",
      "uniqueId": "8a3f-...-4e9c",
      "revitId": 123456,
      "name": "Basic Wall 200mm",
      "description": "",
      "category": "IfcWall",
      "type": "Basic Wall",
      "level": "Level 1",
      "materials": ["Concrete - Cast-in-Place"],
      "visible": true,
      "parameters": {
        "Pset_WallCommon": { "LoadBearing": true, "FireRating": "REI60" }
      },
      "quantities": { "Length": 4.2, "Area": 12.6, "Volume": 2.52, "Thickness": 0.2 },
      "hostId": "parentGlobalId",
      "linkName": "Structure.rvt",
      "linkInstanceId": "inst-001",
      "geometry": {
        "positions": "<base64 Float32Array>",
        "indices": "<base64 Uint32Array>",
        "normals": "<base64 Float32Array>",
        "color": [0.65, 0.65, 0.65, 1.0],
        "groups": [
          { "start": 0, "count": 120, "color": [0.65, 0.65, 0.65, 1.0] },
          { "start": 120, "count": 48, "color": [0.6, 0.8, 1.0, 0.15] }
        ],
        "transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]
      }
    }
  ]
}
```

**Element fields:**

| Field | Type | Description |
|-------|------|-------------|
| `globalId` | string | IFC GlobalId (22-character base64 GUID). Primary identifier. |
| `uniqueId` | string? | Revit UniqueId — stable across saves, the reliable cross-document join key. |
| `revitId` | number? | Revit ElementId (document-local; changes on reload). |
| `name` | string? | Element name. |
| `category` | string? | IFC type or Revit category name (e.g. `"IfcWall"`, `"Walls"`). |
| `type` | string? | Revit family type name. |
| `level` | string? | Level / storey name. |
| `materials` | string[]? | Material names. |
| `visible` | bool? | `false` to suppress non-renderable elements (grids, rooms, etc.). CC also filters by `hidden`/`isHidden`. *Reserved — not emitted by the reference Connector (it omits non-renderable elements instead).* |
| `parameters` | object? | IFC property sets, grouped by Pset name: `{ "Pset_WallCommon": { ... } }`. |
| `quantities` | object? | Quantity values. The reference Connector (v0.1.8+) emits a **flat map of common quantities in SI units** (m / m² / m³): `Length`, `Area`, `Volume`, `Width`, `Height`, `Thickness` — only the ones present on the element. Qset-grouped maps from other connectors are stored as-is. |
| `hostId` | string? | GlobalId of the host element (for hosted elements like doors in walls). *Reserved — the reference Connector delivers host/child pairs via `model-end.relatedPairs` instead.* |
| `hostRelationships` | string[]? | GlobalIds of child elements hosted by this element. *Reserved — not emitted by the reference Connector; see `model-end.relatedPairs`.* |
| `linkName` | string? | Source linked-file name. If present, CC creates a separate model entry for this link. Also accepted as `linkDocumentName`. *Reserved — the reference Connector streams each linked file as its own `model-start` instead.* |
| `linkInstanceId` | string? | Link instance id — distinguishes multiple placements of the same linked file. Also accepted as `linkInstance`. *Reserved — not emitted by the reference Connector.* |
| `description` | string? | Element description (emitted by the reference Connector since v0.1.8: instance description, falling back to the type's). Omitted when empty. |

**Geometry fields (`geometry` object):**

| Field | Type | Description |
|-------|------|-------------|
| `positions` | string | Base64-encoded `Float32Array` of XYZ vertex positions in world coordinates (metres). Three floats per vertex. |
| `indices` | string | Base64-encoded `Uint32Array` of triangle indices. Three indices per triangle. |
| `normals` | string? | Base64-encoded `Float32Array` of per-vertex normals. Computed by CC if absent. |
| `color` | [r,g,b,a]? | RGBA colour in 0–1 range. Defaults to `[0.65, 0.65, 0.65, 1.0]` (mid-grey). |
| `groups` | object[]? | Per-material draw ranges into the index buffer: `{ start, count, color:[r,g,b,a] }`, where `start`/`count` are index offsets (triangles × 3). Present only when an element has more than one material (e.g. a window's frame + glass) so transparent sections render correctly; single-material elements use the flat `color`. Opaque groups come before transparent ones. Emitted by the reference Connector since v0.1.7. |
| `transform` | number[16]? | Column-major 4×4 transform matrix. Applied on top of the geometry if provided. When absent, positions must already be in world space. *Reserved — not emitted by the reference Connector (it bakes link placements into positions).* |

> **Important:** CC does not reproject geometry. Positions must be in a consistent world-space coordinate system in **metres**, with the same origin across all models in a session.

**Elements to omit:** Do not send elements the authoring tool never shows in 3D: grids, levels, reference planes, rooms, areas, scope boxes, cameras, base points, section boxes, and viewports. Alternatively, set `visible: false` or `hidden: true` on them and CC will skip them.

---

#### `model-end`
Signals the end of one model's element stream.

```json
{
  "type": "model-end",
  "storeys": ["Level 1", "Level 2", "Roof"],
  "storeyData": [
    { "name": "Level 1", "elevation": 0.0 }
  ],
  "grids": [
    { "name": "A", "pts": [0, 0, 10, 0] }
  ],
  "relatedPairs": {},
  "elementHashes": { "<globalId>": "<contentHash>", "...": "..." },
  "unchanged": ["<globalId>", "..."]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `storeys` | string[]? | Ordered storey names. Derived from element levels if absent. |
| `storeyData` | object[]? | `{ name, elevation }` per storey. |
| `grids` | object[]? | Structural grid lines `{ name, pts:[x1,z1,x2,z2,...] }` in metres (ground-plane). Display only. *Reserved — not emitted by the reference Connector.* |
| `relatedPairs` | object? | Host/child element pairs `{ "hostGlobalId:childGlobalId": true }`. |
| `elementHashes` | object? | Content hashes for delta-export caching. Stored locally by CC and sent back on the next `export` request. |
| `unchanged` | string[]? | GlobalIds of elements that were not re-sent because their hash matched `knownElements`. CC merges them from its existing model. |

---

#### `export-end`
Signals the end of the entire multi-model export.

```json
{ "type": "export-end" }
```

CC dismisses the loading overlay at this point.

---

#### `model-sync`
Notify CC that the project was synced to central (e.g. Revit sync-to-central). CC will re-request an `export`.

```json
{ "type": "model-sync" }
```

---

#### `model-error`
Report a non-fatal export error.

```json
{
  "type": "model-error",
  "message": "Out of memory during geometry extraction",
  "elementsSent": 1200
}
```

If `elementsSent > 0`, CC offers to keep the partial model.

---

#### `push-clashes-ack`
Acknowledgement of a `push-clashes` message.

```json
{
  "type": "push-clashes-ack",
  "clashesApplied": 15,
  "issuesApplied": 3,
  "errors": []
}
```

---

#### `element-update`
Incremental update — one or more elements changed, were deleted, or had their properties updated without geometry change. Avoids a full re-export.

```json
{
  "type": "element-update",
  "action": "modified",
  "elements": [ /* same schema as element-batch elements */ ]
}
```

```json
{
  "type": "element-update",
  "action": "deleted",
  "globalIds": ["3g7k...", "9a1m..."],
  "revitIds": [123456]
}
```

```json
{
  "type": "element-update",
  "action": "properties-only",
  "elements": [
    {
      "globalId": "3g7k...",
      "parameters": { "Pset_WallCommon": { "FireRating": "REI90" } }
    }
  ]
}
```

| `action` | Effect |
|----------|--------|
| `modified` | Replace full geometry + properties for the listed elements. |
| `deleted` | Remove elements by `globalIds` and/or `revitIds`. |
| `properties-only` | Merge updated properties; GPU geometry is untouched. |

---

#### `selection-changed`
Notify CC of a selection change in the authoring tool. CC will ghost non-selected elements and fly to the selection.

```json
{
  "type": "selection-changed",
  "globalIds": ["3g7k...", "9a1m..."]
}
```

An empty array deselects everything.

---

#### `camera-sync` (Connector → CC)
Synchronise the authoring tool camera to the CC viewport.

```json
{
  "type": "camera-sync",
  "position": [x, y, z],
  "target": [x, y, z],
  "up": [x, y, z],
  "fov": 60
}
```

---

#### `session-expired`
Reply to `resume-session` when the Connector's cache is gone. CC clears its local hash cache and sends a full `export` request.

```json
{ "type": "session-expired" }
```

---

#### `error`
Generic error message.

```json
{ "type": "error", "message": "Something went wrong" }
```

---

## Coordinate system

All geometry must be in a **right-handed, Y-up coordinate system in metres**, matching Three.js world space. The typical mapping from Revit / IFC is:

| Revit | Three.js / CC |
|-------|--------------|
| X (East) | X |
| Z (Up) | Y |
| −Y (North) | Z |

The model is not repositioned by CC after loading, so all models in a session must share the **same world origin**. For federated models, bake the shared-coordinate system transforms before sending.

---

## Typical message sequence

```
CC                                      Connector
──                                      ─────────
                     open ws://127.0.0.1:19780
  ping           →
                 ←   pong  { version, documentName }

  export { categories:["all"] }  →
                 ←   export-start { totalModels:2, totalElements:8000 }
                 ←   model-start  { name:"Arch.rvt", elementCount:5000 }
                 ←   element-batch (×N)
                 ←   model-end   { storeys, elementHashes, unchanged }
                 ←   model-start  { name:"MEP.rvt", isLinked:true, elementCount:3000 }
                 ←   element-batch (×N)
                 ←   model-end
                 ←   export-end

  push-clashes { clashes:[…], issues:[…] }  →
                 ←   push-clashes-ack { clashesApplied:12 }

  highlight { globalIds:[…] }  →
                 ←   (no reply required)
```

---

## Delta-export sequence (reconnect)

```
CC                                      Connector
──                                      ─────────
  resume-session { knownElements:{…} }  →
                 ←   export-start
                 ←   model-start
                 ←   element-batch  (only changed elements)
                 ←   model-end { unchanged:[…], elementHashes:{…} }
                 ←   export-end
```

Or, if the Connector's cache is gone:

```
  resume-session { knownElements:{…} }  →
                 ←   session-expired
  export { categories:["all"] }  →
                 ←   (full export sequence)
```

---

## Versioning this spec

The protocol version is `1.0`. Breaking changes (removed fields, changed semantics) require a major bump. Additive changes (new optional fields, new message types) are minor bumps and remain backward-compatible.

Connector implementations are encouraged to report `"version": "1.0"` in their `pong` message and to ignore unknown message types gracefully.

---

## Reference implementation

The ClashControl Revit Connector is the reference implementation of this protocol. Source: [github.com/clashcontrol-io/ClashControlConnector](https://github.com/clashcontrol-io/ClashControlConnector).

The ClashControl side of the protocol lives in `addons/revit-bridge.js` in this repository.
