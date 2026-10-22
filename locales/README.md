# Language packs

A locale pack is a single JSON file — no code, ever. Copy `_template.json`,
translate the `strings` values, add yourself to `manifest.json`, open a PR.

- Partial packs are fine. Any key you don't translate falls back to English
  automatically (`window._cc_t(key, englishFallback)`) — nothing breaks.
- The `strings` key list will grow over time as more of the UI is wired up
  to go through `_cc_t()`. Untranslated new keys just show English until
  someone (you, or anyone else) adds them.
- Do not include HTML tags, `<script`, `javascript:`, or `on*=` attributes in
  any string value — these are rendered as plain text in the UI and will be
  rejected by CI if present.

## Adding a pack

1. Copy `_template.json` to `<lang>.json` (e.g. `de.json` for German — use
   the language's [BCP 47](https://en.wikipedia.org/wiki/IETF_language_tag)
   primary subtag).
2. Fill in `name` (the language's own name for itself), your `contributor`
   credit, and as many `strings` entries as you can.
3. Add an entry to `manifest.json`: `{"lang": "...", "file": "...", "name": "...", "contributor": "..."}`.
4. Open a PR. If you'd rather not use git directly, see the repo's
   "Contribute a translation" issue template instead — attach your file and
   a maintainer will open the PR for you.

## Discipline name hints (optional `disciplineHints` section)

A pack can also teach ClashControl to recognise disciplines, MEP trades and
element roles from names written in your language — file names
("Bouwkundig.ifc"), system names ("Zuluft 1.OG"), type and element names
("Sparing 300x300"). It is data only; the engine (`clash-discipline-core.js`)
reads stated IFC data first (systems, classification codes, PredefinedType,
type objects) and uses names only when the file itself says nothing.

```json
"disciplineHints": {
  "disciplines":    { "architectural": [], "structural": [], "mep": [], "civil": [] },
  "subDisciplines": { "ventilation": [], "heating": [], "plumbing": [], "fire": [], "electrical": [] },
  "roles":          { "provision": [], "zone": [] }
}
```

- Every key is optional; each list holds up to 200 lower- or mixed-case tokens
  of at most 40 characters.
- A token matches the **start of a word** ("lüftung" matches "Lüftungskanal",
  "ark" does not match "mark"). A token containing a space, hyphen, dot or
  underscore — or written in a script without word spacing (Japanese,
  Chinese, Korean) — matches anywhere in the name.
- `roles.provision`: reservations / sleeves / provision-for-void volumes;
  `roles.zone`: fire compartments and other zone volumes. Role names only
  apply to generic elements (proxies, spatial zones), never to walls or slabs.
- The hints of **every** installed pack apply, whatever language the UI is in
  (a German model reviewed on a Dutch UI still matches the German tokens).
  Flag the pack with `"disciplineHints": true` in `manifest.json` so the app
  fetches it for its hints (the issue-upload flow does this for you).
