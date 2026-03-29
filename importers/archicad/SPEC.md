# ClashControl Exporter — ArchiCAD

Target: produce the same four-file bundle as the Revit exporter so ClashControl
can load ArchiCAD models at full speed without IFC STEP parsing.

See `exporters/revit/SPEC.md` for the complete file format reference.

---

## Files to produce

| File | How |
|------|-----|
| `<name>.glb` | Export via **Twinmotion Direct Link**, **Grasshopper** (Rhino.Inside), or the ArchiCAD **3D Document → Save as glTF** option (ArchiCAD 26+) |
| `<name>.ifcmeta` | Generate via ArchiCAD Python API or GDL script (see below) |
| `<name>.ifcprops` | Generate via ArchiCAD Python API or GDL script (see below) |
| `<name>.ifc` | Standard ArchiCAD IFC export — optional, only needed as fallback |

---

## GLB export

ArchiCAD 26+ can export glTF 2.0 directly:
`File → Save As → glTF 2.0 (*.glb)`

**Coordinate system**: glTF 2.0 mandates Y-up. ArchiCAD's GLB/glTF exporter handles the Z-up→Y-up conversion automatically. No rotation is applied by ClashControl on load.

**Node naming**: Each mesh node must be named with the element's IFC GlobalId.
ArchiCAD writes GlobalIds into IFC exports. When exporting GLB, check whether
the exporter preserves node names — if not, a post-processing step (e.g. via
Blender Python or Three.js GLTFLoader) may be needed to inject them from a
parallel IFC export.

---

## Generating `.ifcmeta` via the ArchiCAD Python API

ArchiCAD 26+ exposes a [JSON API](https://archicadapi.graphisoft.com/) and
a Python binding (`archicad` package). A basic script outline:

```python
from archicad import ACConnection

conn = ACConnection.connect()
acc = conn.acc

elements = acc.GetAllElements()
output = {"elements": {}, "storeys": [], "storeyData": []}

for el in elements:
    guid = str(el.elementId.guid)
    props = acc.GetPropertyValuesOfElements([el], [...])  # fetch desired properties
    classification = acc.GetClassificationsOfElements([el])

    output["elements"][guid] = {
        "name": ...,           # element name from properties
        "ifcType": ...,        # IFC classification
        "objectType": ...,     # element type name
        "storey": ...,         # home story name
        "material": ...,       # building material name
        "quantities": {},
        "psets": {}
    }

# Fetch storeys
stories = acc.GetStoryList()
output["storeys"] = [s.name for s in stories]
output["storeyData"] = [{"name": s.name, "elevation": s.level} for s in stories]

import json
with open("model.ifcmeta", "w") as f:
    json.dump(output, f)
```

Useful API calls:
- `GetAllElements()` — all element IDs
- `GetPropertyValuesOfElements()` — property values by property definition
- `GetClassificationsOfElements()` — IFC type / classification
- `GetStoryList()` — floor/storey list with elevations
- `GetBuildingMaterialPhysicalProperties()` — material data

---

## Generating `.ifcprops` via the ArchiCAD Python API

`.ifcprops` is a superset of `.ifcmeta` — all parameters grouped by parameter group.

```python
output_props = {"elements": {}}

for el in elements:
    guid = str(el.elementId.guid)
    # Group all properties by their group name
    parameters = {}
    for prop_val in acc.GetPropertyValuesOfElements([el], all_prop_defs):
        group = prop_val.propertyId.group or "General"
        if group not in parameters:
            parameters[group] = {}
        parameters[group][prop_val.propertyId.name] = prop_val.propertyValue.value

    output_props["elements"][guid] = {
        "name": ...,
        "category": ...,   # maps to ifcType in ClashControl
        "type": ...,        # element type name
        "level": ...,       # home story name
        "materials": [...], # list of material names
        "parameters": parameters
    }

with open("model.ifcprops", "w") as f:
    json.dump(output_props, f)
```

---

## Alternative: Grasshopper / Rhino.Inside

If a Grasshopper workflow is preferred:
1. Use **Rhino.Inside.Revit** (or ArchiCAD's Grasshopper Live Connection)
2. Query element data with native Grasshopper components
3. Use a Python or C# script component to write the JSON sidecar files
4. Export GLB via the Rhino GLB exporter

---

## Notes

- ArchiCAD GlobalIds in GLB node names must match those in `.ifcmeta`/`.ifcprops`
- ArchiCAD does not have `workset`, `designOption`, or `phase` in the same sense as Revit — omit those fields or map to ArchiCAD equivalents (renovation status, layer)
- Layers in ArchiCAD composite structures: use `GetBuildingMaterialPhysicalProperties` and the composite wall skin structure
