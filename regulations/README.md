# Country packs

ClashControl's core is **IFC-neutral**: it holds no country's building code,
national data standard, coordinate system, map service or naming
convention. Everything country-specific lives in a *country pack* — one JSON
file per region in this directory, pure data, never code. Copy
`_template.json`, fill in what you can cite, add it to `manifest.json`, open
a PR (or use the issue-upload flow, below).

`nl.json` is the reference pack (accessibility thresholds, the ILS / NL-SfB
and RVB data standards, RD New, the PDOK 3D layer, Dutch name words, the
NL-SfB classification table). `be.json`, `ch.json` and `gb.json` only carry a
national coordinate system.

## Which pack applies

The pack follows the **model**, never the UI language. With no choice saved
in Settings ("Regional code"), ClashControl resolves it from the loaded
models (`window._ccResolveCountry`), in this order:

1. `IfcPostalAddress.Country` of `IfcSite.SiteAddress` / `IfcBuilding.BuildingAddress`,
   matched against the pack's `region`, `name` and `geo.countryNames`;
2. the `IfcProjectedCRS` of an `IfcMapConversion`: its EPSG code, or a name
   matching an alias, in the pack's `geo.crs`;
3. the `IfcSite` RefLatitude / RefLongitude inside one of the pack's
   `geo.bounds` boxes (the smallest containing box wins; two countries with
   the same box give no answer).

A resolved pack is activated automatically **without** being saved, like the
browser-language auto-detect for locale packs. A pick in Settings is saved and
always wins; "None (IFC-neutral), never automatic" turns resolution off. With
no pack active, only IFC-neutral checks run: no accessibility thresholds, no
national data standard counted as issues, no national CRS default, no
national 3D layer.

## Requirements for a pack to be accepted

- **`source` is required**, even for a draft. Cite the actual regulation text
  or standard (a specific article / section, not just "the building code").
  Data standards and classification tables carry their own `source` too.
- **`verified: false`** until someone with real familiarity with that
  region's rules has checked the values; the app shows "(unverified)" next to
  the pack. Maintainers flip it to `true` in review once confident.
- Only include values you can cite. Leave a section or key out rather than
  guess a number.
- Patterns are **strings**, at most 200 characters, with no nested
  quantifiers (`(a+)+`), backreferences or lookbehind. URLs must be `https://`
  on an allow-list of hosts the app may contact (see `URL_HOSTS` in
  `country-pack-core.js`; adding a host also needs the app's CSP).
- `node scripts/validate-regulation.js regulations/<region>.json` must pass
  (CI runs it on every pack; the rules live in `country-pack-core.js`).

## Schema

Required top-level keys: `region` (lower-case ISO 3166-1 alpha-2, or a more
specific code like `jp-tokyo`), `name`, `contributor`, `verified`, `source`,
`engines` (may be `{}` when the pack carries another section). Every other
section is optional.

### `engines` — check-engine values

```json
"engines": {
  "accessibility": { "doorClearWidth": 0.85, "corridorWidth": 1.20, "turningDiameter": 1.50, "thresholdHeight": 0.02, "rampSlope": 0.0833 },
  "visibility": { "presets": { "workplace-window-view-XX": { "label": "…", "viewer": {…}, "target": {…}, "maxRange": 6, "mode": "obstruction" } } }
}
```

- `accessibility`: metres (`rampSlope` is rise/run). The Accessibility panel
  has **no built-in numbers** — without a pack it asks the user to choose one
  or enter thresholds; a check without a threshold does not run.
- `visibility.presets`: national sight-line presets, offered while the pack is
  active. `viewer` / `target` / `obstructer` take `types` (IFC classes),
  `namePattern` (a pattern string) and `sampling` (`{mode: grid|centroid,
  eyeHeight, stride}`).

### `geo` — location, coordinate systems, 3D context

```json
"geo": {
  "countryNames": ["Netherlands", "Nederland", "NLD"],
  "bounds": [[50.7, 3.2, 53.7, 7.3]],
  "crs": { "28992": { "label": "Amersfoort / RD New", "def": "+proj=sterea …", "aliases": ["rd new", "amersfoort"] } },
  "defaultCrs": "28992",
  "tiles3d": [{ "id": "nl-pdok", "label": "…", "title": "…", "url": "https://api.pdok.nl/…", "attribution": "…", "heightOffsetM": 43 }]
}
```

- `bounds`: `[latMin, lonMin, latMax, lonMax]` boxes.
- `crs`: proj4 definitions keyed by EPSG code (placement-grade). The core
  itself only knows WGS84, Web Mercator and generic UTM zones (EPSG 326xx /
  327xx / 258xx). `defaultCrs` is preselected in "Place from CRS" when the
  model's own CRS isn't recognised.
- `tiles3d`: keyless 3D Tiles layers shown as buttons while the pack is
  active. `heightOffsetM` is the local geoid offset (the tileset's ellipsoidal
  heights vs the national height datum).

### `dataQuality` — national data standards

A standard is declared as data and run by the generic engine in
`addons/data-quality.js`; each one becomes its own Data Quality section and
Quality Score category.

```json
"dataQuality": {
  "standards": [{
    "id": "ils", "label": "ILS / NL-SfB", "title": "…", "source": "…", "note": "…",
    "scope": "elements",
    "headline": "adoption", "adoptionMin": 0.2, "badge": true,
    "elementTypes": ["IfcWall", "IfcDoor", "…"],
    "classification": { "name": "NL/SfB", "keys": ["nl-sfb", "nlsfb"], "psetContains": "sfb", "psetKeys": ["code"],
      "objectTypePatterns": ["\\((\\d{2})\\)"], "formatPattern": "^\\d{2}(?:\\.\\d\\d?)*$", "groupPattern": "^(\\d{2})",
      "groups": { "21": "Buitenwanden" }, "expected": { "IfcWall": ["21", "22"] },
      "unknownGroupLabel": "Onbekend", "noCodeLabel": "(geen code)", "distLabel": "…" },
    "compliance": { "minorMax": 2, "label": "ILS Compliance" },
    "checks": [{ "id": "doorNaming", "kind": "elementName", "ifcTypes": ["IfcDoor"], "pattern": "^D\\d{3}", "label": "…", "sev": "info", "cat": "naming" }]
  }],
  "idsSpecs": [{ "name": "…", "description": "…", "rules": [{ "desc": "…", "applicability": { "ifcType": "IfcWall" }, "requirement": { "property": { "pset": "", "name": "X", "pattern": ".+" } }, "severity": "error" }] }]
}
```

- `scope`: `elements` (per-element checks on `elementTypes`) or `models`
  (project / site / building / zone / storey metadata).
- `headline`: whether the standard counts toward the headline Quality Score:
  `adoption` (only once at least `adoptionMin` of the elements carry a code of
  its classification), `always` or `never` (shown for visibility only).
  `badge: false` keeps it out of the panel's top "N issues" badge.
- A standard **applies** (counts as issues) when its pack is the active
  regional code, or when the project uses its classification; otherwise it is
  listed under "National standards that don't apply here" with a "check
  anyway" button.
- Check kinds: `classificationMissing`, `classificationFormat` (`detail`
  template with `{code}`), `classificationExpected` (`{code}`, `{ifcType}`,
  `{expected}`), `requiredProps` (`props`: IFC class → property names),
  `attribute` (`attr`, optional `notEqualAttr`), `entityName` / `elementName`
  (`ifcTypes`, `pattern`, `flags`, `emptyDetail`), `spaceCompleteness`
  (`attrs`, `props`, `quantities: [{label, pattern}]`), `propertyPattern`
  (`prop`, `pattern`, `detail` with `{value}`), `requiredWhen` (`when` a
  boolean property is true, `require` another), `materialPattern` (`when`,
  `pattern`), `propertyValue` (`props`, first found wins, `pattern`,
  `missingDetail`), and for `models` scope `spatialEntity` (`entity`:
  project / site / building / zone / storey, `require`: name /
  georefLatLon / georefElevation / objectType / elevation). Every check has
  `id`, `label`, `sev` (error / warn / info), `cat`, optional `weight` (its
  share of the per-element compliance tally) and `report: false` for checks
  that only feed that tally.
- Labels are translatable through locale packs under the key
  `country.<region>.<standard id>.<check id>`.
- `idsSpecs`: extra built-in IDS rule sets offered in the IDS panel.

### `naming` — words in model and element names

```json
"naming": {
  "spaceRoles": { "corridor": "corridor|gang|\\bhal\\b", "sanitary": "toilet|\\bwc\\b|badkamer" },
  "visibilityTerms": { "exit": ["uitgang"], "reception": ["balie"] },
  "revitDisciplineHints": { "mep": ["leiding"], "structural": ["constructie"], "architectural": ["bouwkund"] },
  "classificationKeys": [{ "system": "NL-SfB", "keys": ["nlsfb", "sfb"], "objectTypePatterns": ["\\((\\d\\d(?:\\.\\d\\d?)*)\\)"] }],
  "codeKeys": ["nummer"]
}
```

- `spaceRoles` (patterns): which IfcSpace names the accessibility corridor /
  turning-circle checks treat as corridors / sanitary rooms; replaces the
  English defaults while the pack is active.
- `visibilityTerms` (words; groups `exit`, `desk`, `nurse`, `patientRoom`,
  `reception`, `entrance`, `camera`, `smoke`), `revitDisciplineHints` and
  `classificationKeys` / `codeKeys` apply from **every** registered pack: they
  describe the language of model names, which doesn't follow the regional
  code.

### `format` (reserved)

`{decimal, group, dateLocale}` is validated but not used yet: display
formatting follows the user's UI language.

## Classification tables (`classifications`)

A country pack can also ship classification-code tables (a national element
table, Uniclass, OmniClass …) that tell ClashControl which MEP trade or role
an element belongs to from its `IfcClassificationReference` codes — and from
codes written in parentheses inside system names, e.g. `(57.51) Toevoer`.
They are registered from **every** pack that declares them (a model's codes
say which table they come from, not the user's region setting).

```json
"classifications": [{
  "id": "nl-sfb",
  "name": "NL-SfB",
  "aliases": ["NLSfB"],
  "codePattern": "^([0-9]{1,2}(\\.[0-9]{1,3})?|[0-9]-)$",
  "source": "Citation of the published table (required)",
  "map": { "57": "mep.ventilation", "65.1": "mep.fire", "52": "mep.plumbing" }
}]
```

- `map` keys are code **prefixes** (the longest matching prefix wins); values
  are `"<discipline>"`, `"mep.<ventilation|heating|plumbing|fire|electrical|piping>"`
  or `"role:<provision|zone>"`.
- A reference is matched to a table by its classification name (`name` or
  an alias). Many exporters write the wrong source name (e.g. NL-SfB codes
  labelled "Uniformat"), so when no table matches by name, a table whose
  `codePattern` matches the code is used — the provenance shown in the app
  says so ("code format; source says …").
- `codePattern` must be a simple regular expression (max 200 characters, no
  nested quantifiers). `source` is required for every table.

## Adding a pack

1. Copy `_template.json` to `<region>.json` and delete the sections you
   can't cite.
2. Add an entry to `manifest.json`: `{"region": "...", "file": "...", "name": "...", "contributor": "...", "verified": false}`
   — plus `"thresholds": false` when the pack has no `engines.accessibility`,
   and `"classifications": ["<table name>"]` when it ships tables.
3. Run `node scripts/validate-regulation.js regulations/<region>.json`, open a PR.

If you'd rather not use git, use the "Contribute a country pack" issue
template: attach your file and a maintainer will open the PR (the
`contribution:review-passed` label runs `scripts/apply-contributed-pack.js`,
which validates the pack and writes the manifest entry for you).
