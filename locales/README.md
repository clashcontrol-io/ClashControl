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
