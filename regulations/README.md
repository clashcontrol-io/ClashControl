# Regional regulation presets

A regulation pack is a single JSON file of numeric thresholds for one or more
check engines (today: `accessibility`) — no code, ever. Copy `_template.json`,
fill in the values for your region's building code, add yourself to
`manifest.json`, open a PR.

`manifest.json` starts empty on purpose: these numbers are safety-relevant
(door widths, ramp slopes, turning clearances), and shipping a guessed or
unverified regional preset could mislead someone into a false compliance
result. We'd rather have zero regional presets than a wrong one.

## Requirements for a pack to be accepted

- **`source` is required**, even for a draft. Cite the actual regulation text
  or standard your thresholds come from (e.g. a specific building-code
  article/section, not just "the building code").
- **`verified: false`** until someone with real familiarity with that
  region's building code has checked the values — the Settings panel shows
  an "unverified" indicator for these. Maintainers will flip it to `true`
  in review once confident, or on confirmation from a domain-knowledgeable
  reviewer.
- Only include threshold values you can actually cite. Leave an engine key
  out entirely rather than guess a number for it.

## Adding a pack

1. Copy `_template.json` to `<region>.json` (e.g. `jp.json` for Japan — use
   the [ISO 3166-1 alpha-2](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2)
   country code, or a more specific code like `jp-tokyo` if the rule is
   local rather than national).
2. Fill in `name`, `contributor`, `source`, and the `engines.accessibility`
   thresholds (metres, or ratio for slope — see `_template.json` comments
   inline).
3. Add an entry to `manifest.json`: `{"region": "...", "file": "...", "name": "...", "contributor": "...", "verified": false}`.
4. Open a PR. If you'd rather not use git directly, see the repo's
   "Contribute a regulation pack" issue template instead — attach your file
   and a maintainer will open the PR for you.

## Classification tables (optional `classifications` section)

A country pack can also ship classification-code tables (a national element
table, Uniclass, OmniClass …) that tell ClashControl which MEP trade or role
an element belongs to from its `IfcClassificationReference` codes — and from
codes written in parentheses inside system names, e.g. `(57.51) Toevoer`.
They are registered from **every** pack that declares them (a model's codes
say which table they come from, not the user's region setting). A pack may
carry tables without any building-code thresholds: leave `engines` empty and
it is kept out of the Settings region picker.

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
- List the table names in the pack's `manifest.json` entry
  (`"classifications": ["NL-SfB"]`) and set `"thresholds": false` when
  `engines` is empty — the issue-upload flow writes both for you.
