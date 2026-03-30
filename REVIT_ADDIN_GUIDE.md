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

---

## Geometry Extraction

### Overview
For each Revit element, extract triangulated mesh data (vertices + indices + normals) and encode as base64 binary arrays.

### Coordinate Conversion — CRITICAL
Revit uses **feet, Z-up**. ClashControl uses **meters, Y-up**.

```csharp
// Revit XYZ → ClashControl (meters, Y-up)
float x_out = (float)(point.X * 0.3048);   // feet → meters
float y_out = (float)(point.Z * 0.3048);   // Revit Z → ClashControl Y (up)
float z_out = (float)(-point.Y * 0.3048);  // Revit Y → ClashControl -Z (into screen)
```

Same transform applies to normals (but without the 0.3048 scale — normals are unit vectors):
```csharp
float nx_out = (float)normal.X;
float ny_out = (float)normal.Z;
float nz_out = (float)(-normal.Y);
```

### Extraction Algorithm

```csharp
public static ElementGeometry ExtractGeometry(Element element)
{
    var positions = new List<float>();
    var indices = new List<uint>();
    var normals = new List<float>();

    var options = new Options
    {
        ComputeReferences = true,
        DetailLevel = ViewDetailLevel.Fine
    };

    var geomElement = element.get_Geometry(options);
    if (geomElement == null) return null;

    uint vertexOffset = 0;
    ProcessGeometry(geomElement, Transform.Identity, positions, indices, normals, ref vertexOffset);

    if (positions.Count == 0) return null;

    return new ElementGeometry
    {
        Positions = Convert.ToBase64String(FloatListToBytes(positions)),
        Indices = Convert.ToBase64String(UIntListToBytes(indices)),
        Normals = Convert.ToBase64String(FloatListToBytes(normals))
    };
}

private static void ProcessGeometry(GeometryElement geomElement, Transform transform,
    List<float> positions, List<uint> indices, List<float> normals, ref uint vertexOffset)
{
    foreach (var geomObj in geomElement)
    {
        switch (geomObj)
        {
            case Solid solid:
                if (solid.Volume > 0)
                    ProcessSolid(solid, transform, positions, indices, normals, ref vertexOffset);
                break;

            case GeometryInstance instance:
                var instanceGeom = instance.GetInstanceGeometry();
                // GetInstanceGeometry() already applies the instance transform
                if (instanceGeom != null)
                    ProcessGeometry(instanceGeom, Transform.Identity, positions, indices, normals, ref vertexOffset);
                break;
        }
    }
}

private static void ProcessSolid(Solid solid, Transform transform,
    List<float> positions, List<uint> indices, List<float> normals, ref uint vertexOffset)
{
    foreach (Face face in solid.Faces)
    {
        Mesh mesh = face.Triangulate();
        if (mesh == null) continue;

        int meshVertCount = mesh.Vertices.Count;

        // Compute face normal (use first triangle's normal for flat faces)
        XYZ faceNormal = face.ComputeNormal(new UV(0.5, 0.5));
        XYZ transformedNormal = transform.IsIdentity ? faceNormal : transform.OfVector(faceNormal);

        // Normals: Revit Z-up → Y-up
        float nx = (float)transformedNormal.X;
        float ny = (float)transformedNormal.Z;
        float nz = (float)(-transformedNormal.Y);

        // Add vertices
        for (int i = 0; i < meshVertCount; i++)
        {
            XYZ pt = mesh.Vertices[i];
            XYZ transformed = transform.IsIdentity ? pt : transform.OfPoint(pt);

            // Convert: feet Z-up → meters Y-up
            positions.Add((float)(transformed.X * 0.3048));
            positions.Add((float)(transformed.Z * 0.3048));
            positions.Add((float)(-transformed.Y * 0.3048));

            // Per-vertex normals (use face normal for all vertices of this face)
            normals.Add(nx);
            normals.Add(ny);
            normals.Add(nz);
        }

        // Add triangle indices
        for (int i = 0; i < mesh.NumTriangles; i++)
        {
            MeshTriangle tri = mesh.get_Triangle(i);
            indices.Add(vertexOffset + (uint)tri.get_Index(0));
            indices.Add(vertexOffset + (uint)tri.get_Index(1));
            indices.Add(vertexOffset + (uint)tri.get_Index(2));
        }

        vertexOffset += (uint)meshVertCount;
    }
}
```

### Base64 Encoding Helpers

```csharp
private static byte[] FloatListToBytes(List<float> list)
{
    var bytes = new byte[list.Count * 4];
    Buffer.BlockCopy(list.ToArray(), 0, bytes, 0, bytes.Length);
    return bytes;
}

private static byte[] UIntListToBytes(List<uint> list)
{
    var bytes = new byte[list.Count * 4];
    Buffer.BlockCopy(list.ToArray(), 0, bytes, 0, bytes.Length);
    return bytes;
}
```

---

## Property Extraction

### IFC GlobalId Generation

ClashControl uses 22-character IFC GlobalIds as join keys. Convert Revit's GUID:

```csharp
public static class GlobalIdEncoder
{
    private static readonly char[] Base64Chars =
        "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$".ToCharArray();

    public static string ToIfcGlobalId(Guid guid)
    {
        var bytes = guid.ToByteArray();

        // Rearrange bytes to match IFC encoding order
        var num = new byte[16];
        num[0] = bytes[3]; num[1] = bytes[2]; num[2] = bytes[1]; num[3] = bytes[0];
        num[4] = bytes[5]; num[5] = bytes[4];
        num[6] = bytes[7]; num[7] = bytes[6];
        Array.Copy(bytes, 8, num, 8, 8);

        var result = new char[22];
        int offset = 0;

        // Encode 16 bytes (128 bits) into 22 base64 characters (132 bits, 4 padding)
        result[offset++] = Base64Chars[(num[0] & 0xFC) >> 2];
        result[offset++] = Base64Chars[((num[0] & 0x03) << 4) | ((num[1] & 0xF0) >> 4)];

        for (int i = 1; i < 15; i += 3)
        {
            if (i + 2 < 16)
            {
                result[offset++] = Base64Chars[((num[i] & 0x0F) << 2) | ((num[i + 1] & 0xC0) >> 6)];
                result[offset++] = Base64Chars[num[i + 1] & 0x3F];
                result[offset++] = Base64Chars[(num[i + 2] & 0xFC) >> 2];
                if (i + 3 < 16)
                    result[offset++] = Base64Chars[((num[i + 2] & 0x03) << 4) | ((num[i + 3] & 0xF0) >> 4)];
                else
                    result[offset++] = Base64Chars[(num[i + 2] & 0x03) << 4];
            }
            else if (i + 1 < 16)
            {
                result[offset++] = Base64Chars[((num[i] & 0x0F) << 2) | ((num[i + 1] & 0xC0) >> 6)];
                result[offset++] = Base64Chars[num[i + 1] & 0x3F];
            }
            else
            {
                result[offset++] = Base64Chars[(num[i] & 0x0F) << 2];
            }
        }

        return new string(result, 0, 22);
    }

    public static string FromElement(Element element)
    {
        // element.UniqueId is "{GUID}-{suffix}" — extract the GUID part
        string uniqueId = element.UniqueId;
        // The GUID is typically the first 36 characters (with dashes)
        // but Revit UniqueIds can be more complex. Parse the episode GUID:
        if (Guid.TryParse(uniqueId.Substring(0, Math.Min(36, uniqueId.Length)), out var guid))
            return ToIfcGlobalId(guid);

        // Fallback: hash the UniqueId
        using (var md5 = System.Security.Cryptography.MD5.Create())
        {
            var hash = md5.ComputeHash(System.Text.Encoding.UTF8.GetBytes(uniqueId));
            return ToIfcGlobalId(new Guid(hash));
        }
    }
}
```

### Revit Category → IFC Type Mapping

```csharp
private static readonly Dictionary<string, string> CategoryToIfcType =
    new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
{
    {"Walls",                    "IfcWall"},
    {"Floors",                   "IfcSlab"},
    {"Roofs",                    "IfcRoof"},
    {"Ceilings",                 "IfcCovering"},
    {"Doors",                    "IfcDoor"},
    {"Windows",                  "IfcWindow"},
    {"Columns",                  "IfcColumn"},
    {"Structural Columns",       "IfcColumn"},
    {"Structural Framing",       "IfcBeam"},
    {"Structural Foundations",   "IfcFooting"},
    {"Stairs",                   "IfcStair"},
    {"Railings",                 "IfcRailing"},
    {"Ramps",                    "IfcRamp"},
    {"Curtain Panels",           "IfcPlate"},
    {"Curtain Wall Mullions",    "IfcMember"},
    {"Generic Models",           "IfcBuildingElementProxy"},
    {"Ducts",                    "IfcDuctSegment"},
    {"Pipes",                    "IfcPipeSegment"},
    {"Flex Ducts",               "IfcDuctSegment"},
    {"Flex Pipes",               "IfcPipeSegment"},
    {"Duct Fittings",            "IfcDuctFitting"},
    {"Pipe Fittings",            "IfcPipeFitting"},
    {"Duct Accessories",         "IfcDuctFitting"},
    {"Pipe Accessories",         "IfcPipeFitting"},
    {"Mechanical Equipment",     "IfcFlowTerminal"},
    {"Plumbing Fixtures",        "IfcSanitaryTerminal"},
    {"Electrical Equipment",     "IfcElectricDistributionBoard"},
    {"Electrical Fixtures",      "IfcElectricDistributionBoard"},
    {"Cable Trays",              "IfcCableCarrierSegment"},
    {"Conduits",                 "IfcCableSegment"},
    {"Lighting Fixtures",        "IfcLightFixture"},
    {"Fire Alarm Devices",       "IfcAlarm"},
    {"Sprinklers",               "IfcFireSuppressionTerminal"},
    {"Furniture",                "IfcFurnishingElement"},
    {"Furniture Systems",        "IfcFurnishingElement"},
};

public static string GetIfcType(Element element)
{
    var catName = element.Category?.Name;
    if (catName != null && CategoryToIfcType.TryGetValue(catName, out var ifcType))
        return ifcType;
    return "IfcBuildingElementProxy";
}
```

### Full Property Extraction

```csharp
public static ElementData ExtractProperties(Element element, Document doc)
{
    var data = new ElementData();

    data.GlobalId = GlobalIdEncoder.FromElement(element);
    data.ExpressId = element.Id.IntegerValue;
    data.RevitId = element.Id.IntegerValue;
    data.Name = element.Name ?? "";
    data.Category = GetIfcType(element);

    // Level
    if (element.LevelId != ElementId.InvalidElementId)
    {
        var level = doc.GetElement(element.LevelId) as Level;
        data.Level = level?.Name ?? "";
    }

    // Type name
    var typeId = element.GetTypeId();
    if (typeId != ElementId.InvalidElementId)
    {
        var type = doc.GetElement(typeId);
        data.Type = type?.Name ?? "";
    }

    // Materials
    var materialIds = element.GetMaterialIds(false);
    data.Materials = materialIds
        .Select(id => doc.GetElement(id))
        .Where(m => m != null)
        .Select(m => m.Name)
        .Distinct()
        .ToList();

    // Parameters — grouped by ParameterGroup
    data.Parameters = new Dictionary<string, Dictionary<string, object>>();
    foreach (Parameter param in element.Parameters)
    {
        if (!param.HasValue) continue;
        string groupName = LabelUtils.GetLabelFor(param.Definition.ParameterGroup);
        if (string.IsNullOrEmpty(groupName)) groupName = "Other";

        if (!data.Parameters.ContainsKey(groupName))
            data.Parameters[groupName] = new Dictionary<string, object>();

        object value = null;
        switch (param.StorageType)
        {
            case StorageType.String:
                value = param.AsString();
                break;
            case StorageType.Integer:
                value = param.AsInteger();
                break;
            case StorageType.Double:
                // Convert internal units to display units
                value = Math.Round(UnitUtils.ConvertFromInternalUnits(
                    param.AsDouble(), param.GetUnitTypeId()), 4);
                break;
            case StorageType.ElementId:
                var refElem = doc.GetElement(param.AsElementId());
                value = refElem?.Name;
                break;
        }

        if (value != null)
            data.Parameters[param.Definition.Name] = new Dictionary<string, object>
            {
                [param.Definition.Name] = value
            };
        // Simplified: just add to the group dict directly
        data.Parameters[groupName][param.Definition.Name] = value;
    }

    return data;
}
```

---

## Host Relationships (Clash Suppression)

ClashControl suppresses clashes between host elements and their children (e.g., a wall and its door). Extract these relationships:

```csharp
public static class RelationshipExporter
{
    public static (Dictionary<string, string> hostIds,
                   Dictionary<string, List<string>> hostRelationships,
                   Dictionary<string, bool> relatedPairs)
    BuildRelationships(IList<Element> elements, Document doc)
    {
        var hostIds = new Dictionary<string, string>();           // childGid → hostGid
        var hostRelationships = new Dictionary<string, List<string>>(); // hostGid → [childGids]
        var relatedPairs = new Dictionary<string, bool>();

        // Build GlobalId lookup by ElementId
        var eidToGid = new Dictionary<int, string>();
        foreach (var el in elements)
            eidToGid[el.Id.IntegerValue] = GlobalIdEncoder.FromElement(el);

        foreach (var element in elements)
        {
            if (!(element is FamilyInstance fi)) continue;

            // Get host element (wall, floor, ceiling, etc.)
            var host = fi.Host;
            if (host == null) continue;

            if (!eidToGid.TryGetValue(host.Id.IntegerValue, out var hostGid)) continue;
            var childGid = eidToGid[fi.Id.IntegerValue];

            hostIds[childGid] = hostGid;

            if (!hostRelationships.ContainsKey(hostGid))
                hostRelationships[hostGid] = new List<string>();
            hostRelationships[hostGid].Add(childGid);

            // Add relatedPair (both directions for safety)
            relatedPairs[$"{hostGid}:{childGid}"] = true;
            relatedPairs[$"{childGid}:{hostGid}"] = true;
        }

        return (hostIds, hostRelationships, relatedPairs);
    }
}
```

### ElementData Class

```csharp
public class ElementData
{
    [JsonProperty("globalId")] public string GlobalId { get; set; }
    [JsonProperty("expressId")] public int ExpressId { get; set; }
    [JsonProperty("category")] public string Category { get; set; }
    [JsonProperty("name")] public string Name { get; set; }
    [JsonProperty("level")] public string Level { get; set; }
    [JsonProperty("type")] public string Type { get; set; }
    [JsonProperty("revitId")] public int RevitId { get; set; }
    [JsonProperty("materials")] public List<string> Materials { get; set; }
    [JsonProperty("parameters")] public Dictionary<string, Dictionary<string, object>> Parameters { get; set; }
    [JsonProperty("hostId")] public string HostId { get; set; }
    [JsonProperty("hostRelationships")] public List<string> HostRelationships { get; set; }
    [JsonProperty("geometry")] public ElementGeometry Geometry { get; set; }
}

public class ElementGeometry
{
    [JsonProperty("positions")] public string Positions { get; set; }   // base64 Float32Array
    [JsonProperty("indices")] public string Indices { get; set; }       // base64 Uint32Array
    [JsonProperty("normals")] public string Normals { get; set; }       // base64 Float32Array
    [JsonProperty("color")] public float[] Color { get; set; }          // [r, g, b, a] 0-1
}

---

## WebSocket Server

Uses built-in `System.Net.HttpListener` with WebSocket upgrade. No third-party dependencies needed.

```csharp
public class WsServer : IDisposable
{
    private HttpListener _listener;
    private CancellationTokenSource _cts;
    private WebSocket _client;          // single client at a time
    private readonly object _lock = new object();
    private readonly int _port;

    public bool IsClientConnected => _client?.State == WebSocketState.Open;

    public event Action<string> OnMessage;  // fires on background thread

    public WsServer(int port = 19780)
    {
        _port = port;
    }

    public void Start()
    {
        _cts = new CancellationTokenSource();
        _listener = new HttpListener();
        _listener.Prefixes.Add($"http://localhost:{_port}/");
        _listener.Start();
        Task.Run(() => AcceptLoop(_cts.Token));
        Debug.WriteLine($"[CC] WebSocket server started on ws://localhost:{_port}");
    }

    private async Task AcceptLoop(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var context = await _listener.GetContextAsync();

                if (!context.Request.IsWebSocketRequest)
                {
                    context.Response.StatusCode = 400;
                    context.Response.Close();
                    continue;
                }

                var wsContext = await context.AcceptWebSocketAsync(null);

                // Close previous client if any
                lock (_lock)
                {
                    if (_client?.State == WebSocketState.Open)
                    {
                        try { _client.CloseAsync(WebSocketCloseStatus.NormalClosure, "New client", CancellationToken.None).Wait(1000); }
                        catch { }
                    }
                    _client = wsContext.WebSocket;
                }

                Debug.WriteLine("[CC] Client connected");
                await ReceiveLoop(wsContext.WebSocket, ct);
            }
            catch (Exception ex) when (!ct.IsCancellationRequested)
            {
                Debug.WriteLine($"[CC] Accept error: {ex.Message}");
                await Task.Delay(1000, ct);
            }
        }
    }

    private async Task ReceiveLoop(WebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[1024 * 64]; // 64KB buffer
        try
        {
            while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                var result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);

                if (result.MessageType == WebSocketMessageType.Close)
                {
                    await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None);
                    break;
                }

                if (result.MessageType == WebSocketMessageType.Text)
                {
                    // Handle fragmented messages
                    var ms = new MemoryStream();
                    ms.Write(buffer, 0, result.Count);
                    while (!result.EndOfMessage)
                    {
                        result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct);
                        ms.Write(buffer, 0, result.Count);
                    }

                    var text = Encoding.UTF8.GetString(ms.ToArray());
                    OnMessage?.Invoke(text);
                }
            }
        }
        catch (WebSocketException) { }
        catch (OperationCanceledException) { }

        Debug.WriteLine("[CC] Client disconnected");
    }

    public async Task SendAsync(string json)
    {
        WebSocket ws;
        lock (_lock) { ws = _client; }
        if (ws?.State != WebSocketState.Open) return;

        var bytes = Encoding.UTF8.GetBytes(json);

        // For large messages, send in 64KB frames
        int offset = 0;
        while (offset < bytes.Length)
        {
            int chunkSize = Math.Min(bytes.Length - offset, 64 * 1024);
            bool isLast = (offset + chunkSize) >= bytes.Length;
            await ws.SendAsync(
                new ArraySegment<byte>(bytes, offset, chunkSize),
                WebSocketMessageType.Text,
                isLast,
                CancellationToken.None);
            offset += chunkSize;
        }
    }

    public void Stop()
    {
        _cts?.Cancel();
        lock (_lock)
        {
            try { _client?.CloseAsync(WebSocketCloseStatus.NormalClosure, "Server stopping", CancellationToken.None).Wait(1000); }
            catch { }
            _client = null;
        }
        try { _listener?.Stop(); _listener?.Close(); }
        catch { }
        Debug.WriteLine("[CC] WebSocket server stopped");
    }

    public void Dispose() => Stop();
}
```

---

## App.cs — Entry Point

```csharp
public class App : IExternalApplication
{
    private static WsServer _server;
    private static UIControlledApplication _uiApp;
    private static ExternalEvent _externalEvent;
    private static RevitCommandHandler _commandHandler;

    public static WsServer Server => _server;

    public Result OnStartup(UIControlledApplication application)
    {
        _uiApp = application;

        // Register ExternalEvent for thread marshalling
        _commandHandler = new RevitCommandHandler();
        _externalEvent = ExternalEvent.Create(_commandHandler);
        RevitCommandHandler.Event = _externalEvent;

        // Start WebSocket server
        _server = new WsServer(19780);
        _server.OnMessage += HandleMessage;
        _server.Start();

        // Listen for document changes (live updates)
        application.ControlledApplication.DocumentChanged += OnDocumentChanged;
        application.ControlledApplication.DocumentOpened += OnDocumentOpened;
        application.ControlledApplication.DocumentClosing += OnDocumentClosing;

        // Create ribbon tab & button
        try
        {
            application.CreateRibbonTab("ClashControl");
            var panel = application.CreateRibbonPanel("ClashControl", "Connector");

            var buttonData = new PushButtonData(
                "ClashControlToggle",
                "ClashControl\nConnector",
                Assembly.GetExecutingAssembly().Location,
                typeof(ToggleCommand).FullName);

            buttonData.ToolTip = "Toggle ClashControl live connection (ws://localhost:19780)";
            // buttonData.LargeImage = new BitmapImage(new Uri("pack://...icon.png"));

            panel.AddItem(buttonData);
        }
        catch (Exception ex)
        {
            Debug.WriteLine($"[CC] Ribbon error: {ex.Message}");
        }

        return Result.Succeeded;
    }

    public Result OnShutdown(UIControlledApplication application)
    {
        application.ControlledApplication.DocumentChanged -= OnDocumentChanged;
        application.ControlledApplication.DocumentOpened -= OnDocumentOpened;
        application.ControlledApplication.DocumentClosing -= OnDocumentClosing;
        _server?.Stop();
        return Result.Succeeded;
    }

    private static void HandleMessage(string json)
    {
        try
        {
            var msg = JObject.Parse(json);
            var type = msg["type"]?.ToString();

            switch (type)
            {
                case "ping":
                    _ = _server.SendAsync("{\"type\":\"pong\"}");
                    break;

                case "export":
                    var categories = msg["categories"]?.ToObject<List<string>>() ?? new List<string> { "all" };
                    RevitCommandHandler.Enqueue(app => ExportModel(app, categories));
                    break;

                case "highlight":
                    var globalIds = msg["globalIds"]?.ToObject<List<string>>() ?? new List<string>();
                    RevitCommandHandler.Enqueue(app => HighlightElements(app, globalIds));
                    break;

                case "push-clashes":
                    var clashes = msg["clashes"]?.ToObject<List<JObject>>() ?? new List<JObject>();
                    RevitCommandHandler.Enqueue(app => HandlePushClashes(app, clashes));
                    break;
            }
        }
        catch (Exception ex)
        {
            _ = _server.SendAsync(JsonConvert.SerializeObject(new { type = "error", message = ex.Message }));
        }
    }

    // ── Export ─────────────────────────────────────────────────

    private static void ExportModel(UIApplication uiApp, List<string> categoryFilter)
    {
        var doc = uiApp.ActiveUIDocument?.Document;
        if (doc == null)
        {
            _ = _server.SendAsync("{\"type\":\"error\",\"message\":\"No document open in Revit\"}");
            return;
        }

        // Collect elements
        var collector = new FilteredElementCollector(doc)
            .WhereElementIsNotElementType()
            .WhereElementIsViewIndependent();

        var elements = collector
            .Where(e => e.Category != null && ShouldExport(e.Category, categoryFilter))
            .Where(e => !IsSkippedCategory(e.Category))
            .ToList();

        // Build relationships
        var (hostIds, hostRelationships, relatedPairs) =
            RelationshipExporter.BuildRelationships(elements, doc);

        // Send model-start
        _ = _server.SendAsync(JsonConvert.SerializeObject(new
        {
            type = "model-start",
            name = doc.Title + ".rvt",
            elementCount = elements.Count
        }));

        // Send element batches (50 per batch)
        int batchSize = 50;
        int expressId = 1;

        for (int i = 0; i < elements.Count; i += batchSize)
        {
            var batch = new List<ElementData>();

            for (int j = i; j < Math.Min(i + batchSize, elements.Count); j++)
            {
                try
                {
                    var el = elements[j];
                    var data = PropertyExporter.ExtractProperties(el, doc);
                    data.ExpressId = expressId++;
                    data.Geometry = GeometryExporter.ExtractGeometry(el)?.ToData();

                    // Attach host relationship info
                    if (hostIds.TryGetValue(data.GlobalId, out var hid))
                        data.HostId = hid;
                    if (hostRelationships.TryGetValue(data.GlobalId, out var hrels))
                        data.HostRelationships = hrels;

                    // Get element color from material
                    data.Geometry ??= new ElementGeometry();
                    data.Geometry.Color = GetElementColor(el, doc);

                    batch.Add(data);
                }
                catch (Exception ex)
                {
                    Debug.WriteLine($"[CC] Skip element {elements[j].Id}: {ex.Message}");
                }
            }

            _ = _server.SendAsync(JsonConvert.SerializeObject(new
            {
                type = "element-batch",
                elements = batch
            }));
        }

        // Collect storeys
        var levels = new FilteredElementCollector(doc)
            .OfClass(typeof(Level))
            .Cast<Level>()
            .OrderBy(l => l.Elevation)
            .ToList();

        var storeys = levels.Select(l => l.Name).ToList();
        var storeyData = levels.Select(l => new
        {
            name = l.Name,
            elevation = Math.Round(l.Elevation * 304.8, 1) // feet → mm
        }).ToList();

        // Send model-end
        _ = _server.SendAsync(JsonConvert.SerializeObject(new
        {
            type = "model-end",
            storeys,
            storeyData,
            relatedPairs
        }));
    }

    private static float[] GetElementColor(Element element, Document doc)
    {
        var matIds = element.GetMaterialIds(false);
        if (matIds.Count == 0) return new float[] { 0.65f, 0.65f, 0.65f, 1.0f };

        var mat = doc.GetElement(matIds.First()) as Material;
        if (mat == null) return new float[] { 0.65f, 0.65f, 0.65f, 1.0f };

        var color = mat.Color;
        return new float[]
        {
            color.Red / 255f,
            color.Green / 255f,
            color.Blue / 255f,
            1.0f - (mat.Transparency / 100f)
        };
    }

    // ── Highlight ─────────────────────────────────────────────

    private static void HighlightElements(UIApplication uiApp, List<string> globalIds)
    {
        var uidoc = uiApp.ActiveUIDocument;
        if (uidoc == null) return;
        var doc = uidoc.Document;

        // Build GlobalId → ElementId lookup
        var elementIds = new List<ElementId>();
        var allElements = new FilteredElementCollector(doc)
            .WhereElementIsNotElementType()
            .WhereElementIsViewIndependent();

        foreach (var el in allElements)
        {
            var gid = GlobalIdEncoder.FromElement(el);
            if (globalIds.Contains(gid))
                elementIds.Add(el.Id);
        }

        if (elementIds.Count == 0) return;

        // Select elements in Revit
        uidoc.Selection.SetElementIds(elementIds);

        // Color them red in the active view
        using (var t = new Transaction(doc, "ClashControl Highlight"))
        {
            t.Start();
            var ogs = new OverrideGraphicSettings();
            ogs.SetProjectionLineColor(new Color(239, 68, 68));  // red
            ogs.SetSurfaceForegroundPatternColor(new Color(239, 68, 68));
            ogs.SetSurfaceTransparency(0);

            var view = doc.ActiveView;
            foreach (var eid in elementIds)
                view.SetElementOverrides(eid, ogs);

            t.Commit();
        }
    }

    // ── Push Clashes Handler ──────────────────────────────────

    private static void HandlePushClashes(UIApplication uiApp, List<JObject> clashes)
    {
        var uidoc = uiApp.ActiveUIDocument;
        if (uidoc == null) return;
        var doc = uidoc.Document;

        // Build revitId → ElementId lookup for fast resolution
        var revitIdLookup = new Dictionary<int, ElementId>();
        var allElements = new FilteredElementCollector(doc)
            .WhereElementIsNotElementType()
            .WhereElementIsViewIndependent();

        foreach (var el in allElements)
            revitIdLookup[el.Id.IntegerValue] = el.Id;

        using (var t = new Transaction(doc, "ClashControl: Mark Clashes"))
        {
            t.Start();

            var hardOgs = new OverrideGraphicSettings();
            hardOgs.SetProjectionLineColor(new Color(239, 68, 68));      // red
            hardOgs.SetSurfaceForegroundPatternColor(new Color(239, 68, 68));

            var clearanceOgs = new OverrideGraphicSettings();
            clearanceOgs.SetProjectionLineColor(new Color(245, 158, 11));   // amber
            clearanceOgs.SetSurfaceForegroundPatternColor(new Color(245, 158, 11));

            var view = doc.ActiveView;

            foreach (var clash in clashes)
            {
                var clashType = clash["type"]?.ToString() ?? "hard";
                var ogs = clashType == "clearance" ? clearanceOgs : hardOgs;

                // Color element A
                var revitIdA = clash["elementA"]?["revitId"]?.ToObject<int?>() ?? 0;
                if (revitIdA > 0 && revitIdLookup.TryGetValue(revitIdA, out var eidA))
                    view.SetElementOverrides(eidA, ogs);

                // Color element B
                var revitIdB = clash["elementB"]?["revitId"]?.ToObject<int?>() ?? 0;
                if (revitIdB > 0 && revitIdLookup.TryGetValue(revitIdB, out var eidB))
                    view.SetElementOverrides(eidB, ogs);
            }

            t.Commit();
        }

        Debug.WriteLine($"[CC] Highlighted {clashes.Count} clashes in Revit");
    }

    // ── Live Updates (DocumentChanged) ────────────────────────

    private static void OnDocumentChanged(object sender, DocumentChangedEventArgs e)
    {
        if (!_server.IsClientConnected) return;

        var doc = e.GetDocument();

        // Deleted elements
        var deletedIds = e.GetDeletedElementIds();
        if (deletedIds.Count > 0)
        {
            // We can't resolve GlobalIds for deleted elements (they're gone),
            // so send the Revit ElementIds and let ClashControl match by revitId
            var deletedRevitIds = deletedIds.Select(id => id.IntegerValue).ToList();
            _ = _server.SendAsync(JsonConvert.SerializeObject(new
            {
                type = "element-update",
                action = "deleted",
                revitIds = deletedRevitIds
            }));
        }

        // Modified + Added elements
        var modifiedIds = e.GetModifiedElementIds()
            .Concat(e.GetAddedElementIds())
            .ToList();

        if (modifiedIds.Count > 0)
        {
            var elements = modifiedIds
                .Select(id => doc.GetElement(id))
                .Where(el => el?.Category != null && !IsSkippedCategory(el.Category))
                .ToList();

            if (elements.Count == 0) return;

            var batch = new List<ElementData>();
            foreach (var el in elements)
            {
                try
                {
                    var data = PropertyExporter.ExtractProperties(el, doc);
                    data.Geometry = GeometryExporter.ExtractGeometry(el)?.ToData();
                    data.Geometry ??= new ElementGeometry();
                    data.Geometry.Color = GetElementColor(el, doc);
                    batch.Add(data);
                }
                catch { }
            }

            if (batch.Count > 0)
            {
                _ = _server.SendAsync(JsonConvert.SerializeObject(new
                {
                    type = "element-update",
                    action = "modified",
                    elements = batch
                }));
            }
        }
    }

    private static void OnDocumentOpened(object sender, DocumentOpenedEventArgs e)
    {
        if (!_server.IsClientConnected) return;
        _ = _server.SendAsync(JsonConvert.SerializeObject(new
        {
            type = "status",
            connected = true,
            documentName = e.Document.Title + ".rvt"
        }));
    }

    private static void OnDocumentClosing(object sender, DocumentClosingEventArgs e)
    {
        if (!_server.IsClientConnected) return;
        _ = _server.SendAsync(JsonConvert.SerializeObject(new
        {
            type = "status",
            connected = true,
            documentName = ""
        }));
    }

    // ── Category Filters ──────────────────────────────────────

    private static readonly HashSet<BuiltInCategory> ExportCategories = new HashSet<BuiltInCategory>
    {
        BuiltInCategory.OST_Walls,
        BuiltInCategory.OST_Floors,
        BuiltInCategory.OST_Roofs,
        BuiltInCategory.OST_Ceilings,
        BuiltInCategory.OST_Doors,
        BuiltInCategory.OST_Windows,
        BuiltInCategory.OST_Columns,
        BuiltInCategory.OST_StructuralColumns,
        BuiltInCategory.OST_StructuralFraming,
        BuiltInCategory.OST_StructuralFoundation,
        BuiltInCategory.OST_Stairs,
        BuiltInCategory.OST_StairsRailing,
        BuiltInCategory.OST_Ramps,
        BuiltInCategory.OST_CurtainWallPanels,
        BuiltInCategory.OST_CurtainWallMullions,
        BuiltInCategory.OST_GenericModel,
        BuiltInCategory.OST_DuctCurves,
        BuiltInCategory.OST_PipeCurves,
        BuiltInCategory.OST_FlexDuctCurves,
        BuiltInCategory.OST_FlexPipeCurves,
        BuiltInCategory.OST_DuctFitting,
        BuiltInCategory.OST_PipeFitting,
        BuiltInCategory.OST_DuctAccessory,
        BuiltInCategory.OST_PipeAccessory,
        BuiltInCategory.OST_MechanicalEquipment,
        BuiltInCategory.OST_PlumbingFixtures,
        BuiltInCategory.OST_ElectricalEquipment,
        BuiltInCategory.OST_ElectricalFixtures,
        BuiltInCategory.OST_CableTray,
        BuiltInCategory.OST_Conduit,
        BuiltInCategory.OST_LightingFixtures,
        BuiltInCategory.OST_FireAlarmDevices,
        BuiltInCategory.OST_Sprinklers,
        BuiltInCategory.OST_Furniture,
        BuiltInCategory.OST_FurnitureSystems,
    };

    private static readonly HashSet<BuiltInCategory> SkipCategories = new HashSet<BuiltInCategory>
    {
        BuiltInCategory.OST_Rooms,             // IfcSpace — solid volumes, not physical
        BuiltInCategory.OST_Areas,              // Area boundaries
        BuiltInCategory.OST_Grids,              // Reference grids
        BuiltInCategory.OST_Levels,             // Level datums
        BuiltInCategory.OST_ReferencePlanes,    // Reference planes
        BuiltInCategory.OST_DetailComponents,   // 2D detail items
        BuiltInCategory.OST_Lines,              // Model/detail lines
    };

    private static bool ShouldExport(Category cat, List<string> filter)
    {
        if (filter.Contains("all")) return ExportCategories.Contains((BuiltInCategory)cat.Id.IntegerValue);
        return filter.Any(f => cat.Name.Equals(f, StringComparison.OrdinalIgnoreCase));
    }

    private static bool IsSkippedCategory(Category cat)
    {
        return SkipCategories.Contains((BuiltInCategory)cat.Id.IntegerValue);
    }
}
```

---

## ToggleCommand (Ribbon Button)

```csharp
[Transaction(TransactionMode.Manual)]
public class ToggleCommand : IExternalCommand
{
    public Result Execute(ExternalCommandData commandData, ref string message, ElementSet elements)
    {
        if (App.Server == null)
        {
            TaskDialog.Show("ClashControl", "Connector is not initialized.");
            return Result.Failed;
        }

        if (App.Server.IsClientConnected)
        {
            TaskDialog.Show("ClashControl",
                "ClashControl Connector is running on ws://localhost:19780\n\n" +
                "A browser client is connected.\n" +
                "Open ClashControl and click 'Connect to Revit' in the Revit Bridge panel.");
        }
        else
        {
            TaskDialog.Show("ClashControl",
                "ClashControl Connector is running on ws://localhost:19780\n\n" +
                "No browser client connected.\n" +
                "Open ClashControl and click 'Connect to Revit' in the Revit Bridge panel.\n\n" +
                "Port: 19780 (default)");
        }

        return Result.Succeeded;
    }
}
```

---

## Error Handling Rules

1. **No document open**: Send `{"type":"error","message":"No document open in Revit"}`
2. **Element export fails**: Skip the element, log warning, continue with next element. Do NOT abort the entire export.
3. **WebSocket disconnects**: Keep the server running. Accept new connections. Do not crash.
4. **Large models**: Use batched sending (50 elements per `element-batch`). This prevents WebSocket frame size issues and lets ClashControl show progress.
5. **Thread safety violations**: ALWAYS use `RevitCommandHandler.Enqueue()` for any Revit API call from the WebSocket message handler. Direct calls from background threads WILL crash Revit.

---

## Testing

1. Build the project in Visual Studio (Release mode)
2. Copy `ClashControlConnector.dll`, `ClashControlConnector.addin`, and `Newtonsoft.Json.dll` to `%APPDATA%\Autodesk\Revit\Addins\2024\` (or your Revit version)
3. Open Revit — the plugin auto-starts the WebSocket server
4. Open ClashControl in a browser
5. Click the Revit Bridge button (lightning bolt) in the left sidebar
6. Under "Direct Connection (Live Link)", click **Connect**
7. Click **Pull Model** — the model should stream into ClashControl
8. Run clash detection in ClashControl
9. Click **Push Clashes** — clashing elements should highlight in Revit
10. Click a clash in ClashControl — the two elements should auto-highlight in Revit

### Quick WebSocket Test (without ClashControl)
Open browser console and run:
```javascript
var ws = new WebSocket('ws://localhost:19780');
ws.onopen = () => { ws.send('{"type":"ping"}'); };
ws.onmessage = (e) => { console.log(JSON.parse(e.data)); };
```
You should see `{type: "status", connected: true, documentName: "..."}` followed by `{type: "pong"}`.
```
