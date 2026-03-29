# ClashControl Loader Guide — for Ifc2Ifc

This document describes exactly how ClashControl loads models and what it expects
from the files Ifc2Ifc produces. Use this as a reference when changing the exporter.

---

## How to import files

### Drag and drop
The easiest method. Select all files for a model in your file explorer and drag them
onto the ClashControl window. You can drop multiple models at once — ClashControl
loads them sequentially and adds each as a separate model layer.

### File picker
Click the **Load IFC** button in the left sidebar. The file dialog accepts `.ifc`
files. To load a GLB bundle, drag and drop is the recommended approach since the
file picker is currently filtered to `.ifc` only.

### Grouping rule
Files are grouped by **base name** (everything before the last `.`). All files
in a group are loaded together as one model:

```
Building.glb        ┐
Building.ifcprops   ├─ loaded as one model named "Building"
Building.ifcmeta    ┘

Structure.glb       ┐
Structure.ifcprops  ├─ loaded as one model named "Structure"
Structure.ifcmeta   ┘
```

You can drop both groups at the same time — ClashControl will correctly separate
them by base name.

### What to drop for the Ifc2Ifc bundle
Drop all three files together:

```
MyModel.glb
MyModel.ifcprops
MyModel.ifcmeta     (optional but recommended)
```

All three files must share exactly the same base name. If the names differ,
ClashControl will not recognise them as a bundle and will try to load each file
independently.

### Multiple models
Clash detection works across models. The typical workflow is:

1. Drop the architectural model → it loads as model A
2. Drop the MEP model → it loads as model B
3. Open the **Clashes** tab → run detection between A and B

Each model gets an auto-detected discipline (Architectural / Structural / MEP)
and a color assigned on load. Both can be changed in the model sidebar.

---

## Load paths

ClashControl detects which load path to use based on which files are dropped together.
Files are grouped by **base name** (filename without extension), so `Building.glb` +
`Building.ifcprops` + `Building.ifcmeta` are treated as one bundle.

| Files present | Function | IFC STEP parsed? |
|---|---|---|
| `.ifc` only | `loadIFC` | Yes — web-ifc WASM |
| `.glb` + `.ifc` | `joinGLBWithIFC` | Yes — metadata only, no geometry stream |
| `.glb` + `.ifcmeta` | `joinGLBWithSidecar` | No |
| `.glb` + `.ifcprops` (± `.ifcmeta`) | `joinGLBWithProps` | No |

**Priority rule**: if `.ifcprops` is present, it is always used and the `.ifc` file
(if also dropped) is ignored entirely. `.ifcmeta` can accompany any path as a sidecar
for extra fields.

---

## The GLB file

### Node naming
Every mesh node whose `node.name` is a 22-character IFC GlobalId gets picked up as
a distinct element. This is the join key between the GLB and the metadata files.

```
node.name = "0YWZuEBiT1LvTnpJhBs3FV"   ← IFC GlobalId, base64-encoded, exactly 22 chars
```

Nodes with any other name (or no name) produce meshes that go into the global mesh
array but cannot be associated with element metadata.

### Empty nodes
Non-mesh nodes whose name is a 22-character GlobalId are also registered as
**metadata-only entries** (`meshByGid[gid] = []`). This covers elements that exist
in Revit but have no exportable solid geometry (stair flights, landings, ramp flights).
They appear in the element list with full properties but nothing in the viewer.

### Material handling
ClashControl **replaces every GLB material** with its own `THREE.MeshPhongMaterial`
to ensure consistent rendering across all load paths. The following rules apply:

| Condition | Behaviour |
|---|---|
| Geometry has `COLOR_0` vertex color attribute | `color = white`, `vertexColors = THREE.VertexColors` — vertex colors render unmodified |
| Material color is near-black (r,g,b < 0.05) | Replaced with neutral gray `(0.65, 0.65, 0.65)` |
| Material has `opacity < 0.99` | `transparent = true`, opacity preserved |
| All meshes | `side = THREE.DoubleSide` (until Ifc2Ifc v2 guarantees correct winding) |

After creating the mesh, `geometry.computeVertexNormals()` is called unconditionally
to fix any flipped normals introduced by Revit's left-to-right-hand coordinate
conversion.

### Coordinate space
glTF 2.0 is Y-up. ClashControl does **not** apply any additional scene rotation.
Ifc2Ifc must output Y-up geometry (flip Z↔Y, negate the original Z).

---

## The .ifcprops file

A flat JSON object keyed by IFC GlobalId. Each entry carries the element's
properties. This is the fastest load path — no WASM, no STEP parsing.

### Required fields

| Field | Type | Used for |
|---|---|---|
| `expressId` | integer | Internal element ID, picking, clash keys |
| `globalId` | string (22 chars) | Join key with GLB |
| `category` | string | IFC type name e.g. `"IfcWall"`, `"IfcBeam"` |
| `name` | string | Element label in the UI |

### Recommended fields

| Field | Type | Notes |
|---|---|---|
| `level` | string | Storey name e.g. `"L3"` — used for storey filter |
| `type` | string | Revit type/family name (shown as objectType) |
| `description` | string | Optional free text |
| `materials` | string or string[] | Material name(s) |
| `quantities` | object | `{Area, Volume, Length, …}` — shown in properties panel |
| `parameters` | object | Revit instance parameters shown under IDENTITY DATA |

### ifcType / category values
ClashControl reads `category` as the IFC type name. Use the exact IFC class name —
do **not** use Revit category names like `"Rooms"` or `"Walls"`.

```json
"category": "IfcWall"       ✓
"category": "Walls"         ✗  (Revit category — won't be recognized)
"category": "IfcSpace"      ✓  (room — geometry will be stripped automatically)
```

Non-physical types are stripped from the 3D view but kept in the element list:

| ifcType | Reason |
|---|---|
| `IfcSpace` | Room volume — solid box, not a physical element |
| `IfcVirtualElement` | Room separation lines — thin planes, cause false clashes |
| `IfcAnnotation` | 2D annotations extruded to 3D |
| `IfcGrid` | Reference grid lines |
| `IfcOpeningElement` | Void cutters — filtered out entirely (not shown in list either) |

### Minimal example

```json
{
  "0YWZuEBiT1LvTnpJhBs3FV": {
    "expressId": 12345,
    "globalId": "0YWZuEBiT1LvTnpJhBs3FV",
    "category": "IfcWall",
    "name": "Basic Wall: Generic - 200mm",
    "level": "L1",
    "type": "Generic - 200mm",
    "materials": "Concrete",
    "quantities": { "Area": 18.5, "Volume": 3.7, "Length": 9.25 },
    "parameters": {
      "Mark": "W-001",
      "Fire Rating": "60 min"
    }
  }
}
```

---

## The .ifcmeta sidecar file

An optional companion to `.ifcprops` (or to `.glb` alone). Carries model-level
data that does not fit in `.ifcprops`: spatial structure, storey list, clash
suppression pairs, and Revit-specific per-element extras.

### Top-level structure

```json
{
  "storeys": ["B1", "L1", "L2", "L3", "Roof"],
  "storeyData": [ { "name": "L1", "elevation": 0.0 }, ... ],
  "spatialHierarchy": { ... },
  "relatedPairs": {
    "globalIdA:globalIdB": true,
    ...
  },
  "elements": {
    "0YWZuEBiT1LvTnpJhBs3FV": { ... per-element sidecar fields ... }
  }
}
```

### relatedPairs
A map of `"globalIdA:globalIdB": true` entries. Pairs listed here are **suppressed
from clash results** — they will never be reported as a clash regardless of geometry
overlap. Use this for intentional relationships:

- Door leaf inside its host wall opening
- Window inside its host wall
- Structural insert into host slab

GlobalId pairs are preferred over expressId pairs because they survive re-exports.
When a sidecar `relatedPairs` is present, any pairs derived from the IFC STEP file
are discarded in favour of the sidecar.

Additionally, ClashControl derives pairs automatically from `hostId` /
`hostRelationships` fields on each element (see below).

### Per-element sidecar fields

These are merged on top of `.ifcprops` data when both files are present.

| Field | Type | Notes |
|---|---|---|
| `expressId` | integer | Overrides .ifcprops value if present |
| `ifcType` | string | IFC type — same as `category` in .ifcprops |
| `revitId` or `revit_element_id` | integer | Revit ElementId for round-tripping |
| `phase` | string | Revit phase name |
| `workset` | string | Revit workset name |
| `designOption` | string | Revit design option name |
| `hostId` | string (GlobalId) | Host element GlobalId — generates a relatedPair automatically |
| `hostRelationships` | string[] | Additional hosted-element GlobalIds |
| `layers` | object[] | Material layer stack |
| `flipState` | object | `{facingFlipped, handFlipped}` for doors/windows |
| `constraints` | object | Revit constraint data |

### Storey data
`storeys` is a flat ordered list of storey names used to populate the storey filter
dropdown. `storeyData` is optional detail used for section-by-storey features.

---

## Element shape (internal)

After joining, every element in ClashControl has this shape:

```js
{
  expressId: 12345,          // integer — primary key for picking, clash keys, BCF
  meshes: [ THREE.Mesh ],    // may be empty for metadata-only elements
  box: THREE.Box3,           // world-space AABB (empty box if no meshes)
  props: {
    globalId: "...",         // 22-char IFC GlobalId
    ifcType: "IfcWall",      // IFC class name
    name: "...",
    description: "...",
    objectType: "...",       // Revit type/family name
    storey: "L1",
    material: "Concrete",
    quantities: {},
    psets: {},
    // optional Revit extras:
    revitId, phase, workset, designOption,
    hostId, hostRelationships, layers, flipState, constraints
  }
}
```

---

## Clash suppression — relatedPairs

Clashes between two elements are suppressed if their expressId pair appears in
the model's `relatedPairs` map: `{ "12345:67890": true }`.

ClashControl builds this map from three sources (in priority order):

1. **Sidecar `relatedPairs`** (GlobalId pairs, resolved to expressIds at load time) —
   preferred, stable across re-exports
2. **IFC STEP `IfcRelVoidsElement` / `IfcRelFillsVoid`** — used only if no sidecar
   relatedPairs are present
3. **`hostId` / `hostRelationships`** on each element — merged on top of either source

---

## What ClashControl does NOT use from the GLB

- **Cameras** — ignored
- **Animations** — ignored
- **Skins / morph targets** — ignored
- **Extras / extensions on nodes** — ignored; all metadata must come from .ifcprops/.ifcmeta
- **Multi-material meshes** — the first material's opacity is used; all submeshes get
  the same replacement material
- **Scene hierarchy** — world transforms are baked into each mesh; the node tree is
  discarded after loading
