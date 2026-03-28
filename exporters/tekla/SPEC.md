# ClashControl Exporter — Tekla Structures

Target: produce the same four-file bundle as the Revit exporter so ClashControl
can load Tekla models at full speed without IFC STEP parsing.

See `exporters/revit/SPEC.md` for the complete file format reference.

---

## Files to produce

| File | How |
|------|-----|
| `<name>.glb` | Export via Trimble Connect, or IFC → Blender → GLB pipeline (see below) |
| `<name>.ifcmeta` | Generate via Tekla Open API (.NET) |
| `<name>.ifcprops` | Generate via Tekla Open API (.NET) |
| `<name>.ifc` | Standard Tekla IFC export — optional, only needed as fallback |

---

## GLB export

Tekla Structures does not export GLB natively. Options:

**Option A — via Trimble Connect**
1. Publish model to Trimble Connect
2. Download as glTF from the Trimble Connect viewer
3. Rename `.gltf`/`.glb` to match the base name of the sidecar files

**Option B — via IFC + Blender**
1. Export IFC from Tekla
2. Open in Blender with the **BlenderBIM** add-on
3. Export as GLB (`File → Export → glTF 2.0`)
4. Ensure node names preserve the IFC GlobalId (BlenderBIM does this automatically)

**Option C — via custom .NET exporter**
Use the Tekla Open API `ModelObject` geometry export to write mesh data directly.
This gives full control over GLB node naming.

**Coordinate system**: glTF 2.0 mandates Y-up. Ensure your GLB export pipeline (Trimble Connect, Blender, or custom exporter) converts Tekla's Z-up to Y-up. No rotation is applied by ClashControl on load.

---

## Generating `.ifcmeta` via Tekla Open API (.NET)

Tekla Structures exposes a full .NET API (`Tekla.Structures.Model`).
A macro or application can iterate all objects and dump the sidecar JSON.

```csharp
using Tekla.Structures.Model;
using Tekla.Structures.Model.UI;
using Newtonsoft.Json;

var model = new Model();
var selector = new ModelObjectSelector();
var objects = model.GetModelObjectSelector().GetAllObjectsWithType(
    ModelObject.ModelObjectEnum.BEAM |
    ModelObject.ModelObjectEnum.CONTOURPLATE |
    ModelObject.ModelObjectEnum.COLUMN
);

var elements = new Dictionary<string, object>();

while (objects.MoveNext())
{
    var obj = objects.Current as ModelObject;
    if (obj == null) continue;

    // Get IFC GlobalId
    string guid = "";
    obj.GetReportProperty("IFC_GUID", ref guid);

    string name = "", profile = "", material = "", phase = "", assemblyPhase = "";
    obj.GetReportProperty("NAME", ref name);
    obj.GetReportProperty("PROFILE", ref profile);
    obj.GetReportProperty("MATERIAL", ref material);
    obj.GetReportProperty("PHASE_NAME", ref phase);

    // Get storey / floor
    string storey = "";
    obj.GetReportProperty("ASSEMBLY_POS", ref storey); // adjust to your workflow

    // Get all user-defined attributes for psets
    var psets = new Dictionary<string, object>();
    var udaNames = new List<string>(); // populate from your UDA list
    foreach (var uda in udaNames)
    {
        string val = "";
        if (obj.GetUserProperty(uda, ref val))
            psets[uda] = val;
    }

    elements[guid] = new {
        name = name,
        ifcType = GetIfcType(obj),   // map Tekla type to IFC type
        objectType = profile,
        storey = storey,
        material = material,
        phase = phase,
        quantities = new {},
        psets = psets
    };
}

var output = new { elements };
File.WriteAllText("model.ifcmeta", JsonConvert.SerializeObject(output, Formatting.None));
```

Useful API entry points:
- `ModelObjectSelector.GetAllObjectsWithType()` — iterate all structural objects
- `obj.GetReportProperty("IFC_GUID", ref guid)` — IFC GlobalId
- `obj.GetReportProperty("PROFILE", ref val)` — cross-section profile
- `obj.GetReportProperty("MATERIAL", ref val)` — steel/concrete grade
- `obj.GetUserProperty(name, ref val)` — user-defined attributes (UDAs)
- `Phase` class — construction phase data
- `obj.GetChildren()` — sub-objects (welds, bolts, etc.)

---

## Generating `.ifcprops` via Tekla Open API

Same loop as `.ifcmeta` but groups all report properties and UDAs by category:

```csharp
var parameters = new Dictionary<string, Dictionary<string, object>>();

// Standard dimensions group
parameters["Dimensions"] = new Dictionary<string, object>();
double length = 0; obj.GetReportProperty("LENGTH", ref length);
parameters["Dimensions"]["Length"] = length;

// Material group
parameters["Material"] = new Dictionary<string, object>();
parameters["Material"]["Grade"] = material;

// User-defined attributes
parameters["UDA"] = new Dictionary<string, object>();
foreach (var uda in udaNames)
{
    string val = "";
    if (obj.GetUserProperty(uda, ref val))
        parameters["UDA"][uda] = val;
}

elements[guid] = new {
    name = name,
    category = GetIfcType(obj),
    type = profile,
    level = storey,
    materials = new[] { material },
    parameters = parameters
};
```

---

## IFC type mapping (Tekla → IFC)

| Tekla type | IFC type |
|---|---|
| `BEAM` | `IfcBeam` |
| `COLUMN` | `IfcColumn` |
| `CONTOURPLATE` | `IfcPlate` |
| `PAD_FOOTING` | `IfcFooting` |
| `STRIP_FOOTING` | `IfcFooting` |
| `BOLTED_GUSSET` | `IfcMember` |
| `REINFORCEMENT` | `IfcReinforcingBar` |

---

## Notes

- Tekla's native IFC export already writes GlobalIds — use `IFC_GUID` report property to ensure consistency between the GLB node name and the sidecar keys
- Tekla does not have `workset` or `designOption` — omit those fields
- Phase in Tekla = construction sequence phase (integer or name) — map to `phase` string field
- For composite slabs, iterate slab components for layer data
