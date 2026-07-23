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
