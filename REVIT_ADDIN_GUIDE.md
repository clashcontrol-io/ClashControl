# ClashControl Connector for Revit — Build Guide

> **Purpose**: This document is a self-contained specification for building a Revit add-in that connects to [ClashControl](https://github.com/clashcontrol-io/clash-control) via WebSocket. Drop this file into a Claude Code session to build the entire plugin.

## What It Does

A Revit plugin that:
1. **Runs a WebSocket server** on `localhost:19780` inside Revit
2. **Exports geometry + properties** of the active model to ClashControl (browser app) over WebSocket
3. **Pushes live updates** when the Revit model changes (DocumentChanged event)
4. **Receives clash results** from ClashControl and highlights clashing elements in Revit
5. **Highlights elements on selection** — when the user clicks a clash in ClashControl, the corresponding elements light up in Revit

No cloud server, no internet required. Everything runs on the user's local machine.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│                 User's PC                   │
│                                             │
│  ┌──────────────┐   WebSocket    ┌────────────────┐
│  │   Revit      │  localhost     │   Browser       │
│  │   + Plugin   │◄─────────────►│   ClashControl  │
│  │              │   :19780      │                  │
│  └──────────────┘               └────────────────┘
│                                             │
└─────────────────────────────────────────────┘
```

- The plugin starts an HTTP listener on `localhost:19780` that accepts WebSocket upgrade requests
- ClashControl (in the browser) connects to `ws://localhost:19780`
- The connection is bidirectional: the plugin sends geometry/properties, the browser sends commands and clash data
- All Revit API calls happen on Revit's main thread via `ExternalEvent`

---

## Project Structure

```
ClashControlConnector/
├── ClashControlConnector.sln
├── ClashControlConnector/
│   ├── ClashControlConnector.csproj          — .NET Framework 4.8 (Revit 2024) or .NET 8 (Revit 2025+)
│   ├── ClashControlConnector.addin           — Revit add-in manifest
│   ├── App.cs                                — IExternalApplication entry point
│   ├── Commands/
│   │   └── ToggleCommand.cs                  — Ribbon button to start/stop connector
│   ├── Core/
│   │   ├── WebSocketServer.cs                — HTTP listener + WebSocket server on localhost
│   │   ├── GeometryExporter.cs               — Extracts triangulated meshes from Revit elements
│   │   ├── PropertyExporter.cs               — Extracts parameters, levels, materials, types
│   │   ├── RelationshipExporter.cs           — Builds host/void/fill relatedPairs
│   │   └── GlobalIdEncoder.cs                — Converts Revit GUID to 22-char IFC GlobalId
│   ├── Protocol/
│   │   ├── Messages.cs                       — Message types + JSON serialization
│   │   └── ElementData.cs                    — Element data transfer object
│   └── Resources/
│       └── icon.png                          — 32x32 ribbon icon
```

---

## Dependencies

### NuGet Packages
- `Newtonsoft.Json` 13.x — JSON serialization
- No WebSocket NuGet needed — use built-in `System.Net.WebSockets` + `System.Net.HttpListener`

### Revit API References (do NOT Copy Local)
- `RevitAPI.dll` — from Revit install directory (e.g., `C:\Program Files\Autodesk\Revit 2024\`)
- `RevitAPIUI.dll` — same directory
- Set **Copy Local = false** for both

### Target Framework
- Revit 2022–2024: `.NET Framework 4.8`
- Revit 2025+: `.NET 8` (net8.0-windows)

---

## Add-in Manifest

File: `ClashControlConnector.addin`

```xml
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>ClashControl Connector</Name>
    <Assembly>ClashControlConnector.dll</Assembly>
    <FullClassName>ClashControlConnector.App</FullClassName>
    <AddInId>C1A5C0D1-CC01-4F7A-B2E3-901234567890</AddInId>
    <VendorId>ClashControl</VendorId>
    <VendorDescription>ClashControl — Free IFC Clash Detection</VendorDescription>
  </AddIn>
</RevitAddIns>
```

### Installation Path
Copy `.addin` + `ClashControlConnector.dll` + `Newtonsoft.Json.dll` to:
- Revit 2024: `%APPDATA%\Autodesk\Revit\Addins\2024\`
- Revit 2025: `%APPDATA%\Autodesk\Revit\Addins\2025\`

---

## Thread Safety — CRITICAL

Revit's API is **single-threaded**. The WebSocket server runs on a background thread. You MUST marshal all Revit API calls back to the main thread.

### Pattern: ExternalEvent + ConcurrentQueue

```csharp
public class RevitCommandHandler : IExternalEventHandler
{
    private static readonly ConcurrentQueue<Action<UIApplication>> _queue
        = new ConcurrentQueue<Action<UIApplication>>();

    public static ExternalEvent Event { get; set; }

    public static void Enqueue(Action<UIApplication> action)
    {
        _queue.Enqueue(action);
        Event?.Raise();
    }

    public void Execute(UIApplication app)
    {
        while (_queue.TryDequeue(out var action))
        {
            try { action(app); }
            catch (Exception ex) { Debug.WriteLine($"[CC] Error: {ex.Message}"); }
        }
    }

    public string GetName() => "ClashControlCommandHandler";
}
```

**Rule**: When a WebSocket message arrives on a background thread, enqueue the work and call `Event.Raise()`. Revit will call `Execute()` on its main thread.

---

## Message Protocol

All messages are JSON objects with a `type` field. Geometry data is base64-encoded binary.

### Browser → Plugin

#### `ping` — Keepalive
```json
{"type":"ping"}
```
Response: `{"type":"pong"}`

#### `export` — Request model export
```json
{"type":"export","categories":["all"]}
```
Or filtered:
```json
{"type":"export","categories":["Walls","Doors","Floors"]}
```

#### `highlight` — Highlight elements in Revit
```json
{"type":"highlight","globalIds":["0K7w7jYlXCpOJN0oo5MIAN","3Ax9mWqLz1B0OvE3pQdT7k"]}
```
The plugin should find these elements and color them red using `OverrideGraphicSettings` in the active view, and optionally select them via `uidoc.Selection.SetElementIds()`.

#### `push-clashes` — Clash/issue data from ClashControl
```json
{
  "type":"push-clashes",
  "clashes":[
    {
      "id":"ABC123",
      "status":"open",
      "priority":"high",
      "type":"hard",
      "point":{"x":1.2,"y":3.4,"z":5.6},
      "elementA":{"globalId":"...","name":"Basic Wall","ifcType":"IfcWall","revitId":123456},
      "elementB":{"globalId":"...","name":"Round Duct","ifcType":"IfcDuctSegment","revitId":789012}
    }
  ],
  "issues":[
    {
      "id":"ISS001",
      "title":"Duct through beam",
      "status":"open",
      "priority":"critical",
      "description":"Duct penetrates structural beam without sleeve",
      "elementIds":[{"globalId":"...","name":"...","revitId":456}]
    }
  ]
}
```

The plugin should:
1. Color clashing elements using `OverrideGraphicSettings` (red for hard clashes, orange for clearance)
2. Optionally place marker family instances at clash `point` coordinates
3. Write shared parameters on elements: `CC_ClashID`, `CC_Status`, `CC_Priority`
4. Optionally create a filtered 3D view showing only clashing elements

**Coordinate conversion for `point`**: ClashControl uses Y-up meters. Convert back to Revit:
- `x_revit = x / 0.3048`
- `y_revit = -z / 0.3048`
- `z_revit = y / 0.3048`

### Plugin → Browser

#### `pong` — Keepalive response
```json
{"type":"pong"}
```

#### `status` — Connection status
```json
{"type":"status","connected":true,"documentName":"MyProject.rvt"}
```
Send this immediately after WebSocket connection is established.

#### `model-start` — Begin model export
```json
{"type":"model-start","name":"MyProject.rvt","elementCount":1234}
```

#### `element-batch` — Batch of elements (50–100 per message)
```json
{
  "type":"element-batch",
  "elements":[
    {
      "globalId":"0K7w7jYlXCpOJN0oo5MIAN",
      "expressId":1,
      "category":"IfcWall",
      "name":"Basic Wall: Generic - 200mm:123456",
      "level":"Level 1",
      "type":"Generic - 200mm",
      "revitId":123456,
      "materials":["Concrete","Plaster"],
      "parameters":{
        "Constraints":{"Base Constraint":"Level 1","Top Constraint":"Up to level: Level 2"},
        "Dimensions":{"Length":5000.0,"Area":15.0,"Volume":3.0},
        "Identity Data":{"Type Name":"Generic - 200mm"}
      },
      "hostId":null,
      "hostRelationships":["3Ax9mWqLz1B0OvE3pQdT7k"],
      "geometry":{
        "positions":"<base64 Float32Array — x,y,z vertex triplets>",
        "indices":"<base64 Uint32Array — triangle index triplets>",
        "normals":"<base64 Float32Array — nx,ny,nz per vertex>"
      }
    }
  ]
}
```

#### `model-end` — Export complete
```json
{
  "type":"model-end",
  "storeys":["Level 1","Level 2","Roof"],
  "storeyData":[
    {"name":"Level 1","elevation":0.0},
    {"name":"Level 2","elevation":3000.0}
  ],
  "relatedPairs":{
    "globalIdA:globalIdB":true
  }
}
```

#### `element-update` — Live model change
```json
{"type":"element-update","action":"modified","elements":[...same shape as element-batch...]}
```
```json
{"type":"element-update","action":"deleted","globalIds":["0K7w..."]}
```

#### `error` — Error message
```json
{"type":"error","message":"No document open in Revit"}
```
