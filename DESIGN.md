# Design System: ClashControl

ClashControl is a free, source-available IFC clash-detection web app that lives
inside a single `index.html`. This document is the source of truth for its
visual language. It follows the [Google Stitch
`design.md`](https://stitch.withgoogle.com/docs/design-md/overview/) template
so AI tools and human contributors stay aligned when generating new screens.

The guiding principle, borrowed from Stitch and Material 3: **constrain design
choices to a small reusable token set**. Every styled element should reference
the tokens below rather than introducing one-off colors, sizes, or spacings.

---

## 1. Visual Theme & Atmosphere

- **Mood:** technical, dense, dark-first BIM tooling for desktop power users.
  Calm, navigable, never decorative.
- **Density:** information-rich. List rows default to spacing-2/3, modal forms
  to spacing-3, headers to spacing-4. Tighter than a marketing site, looser
  than a CAD HUD.
- **Philosophy:** single-file, no build step, no design framework. The system
  lives in CSS custom properties at the top of `index.html` and a small set of
  shared style-object constants near `S_BTN`. Components are inline-composed
  with token references — no separate component library.
- **Themes:** light (`:root`) is the default; dark (`[data-theme=dark]`) is a
  full peer with mirrored tokens.

---

## 2. Color Palette & Roles

All colors below live as CSS custom properties in `index.html` `:root` (light)
and `[data-theme=dark]`. **Never** hand-pick a hex in component code; pull
from a token.

### Surfaces
| Token              | Dark      | Light     | Purpose                          |
|--------------------|-----------|-----------|----------------------------------|
| `--bg-primary`     | `#0f172a` | `#f8fafc` | App background, header           |
| `--bg-secondary`   | `#1e293b` | `#ffffff` | Cards, modals, hover state       |
| `--bg-tertiary`    | `#0f172a` | `#f1f5f9` | Inputs, recessed wells           |

### Text
| Token              | Dark      | Light     | Purpose                          |
|--------------------|-----------|-----------|----------------------------------|
| `--text-primary`   | `#e2e8f0` | `#0f172a` | Body, headings                   |
| `--text-secondary` | `#b0bec5` | `#374151` | Sub-content                      |
| `--text-muted`     | `#8b9db5` | `#6b7280` | Captions, labels                 |
| `--text-faint`     | `#6b7f99` | `#9ca3af` | Disabled, hint text              |

### Accent
| Token              | Dark      | Light     | Purpose                          |
|--------------------|-----------|-----------|----------------------------------|
| `--accent`         | `#1a6b4a` | `#4d9e75` | Primary action, focus ring       |
| `--accent-hover`   | `#155c3e` | `#5db086` | Hover state                      |
| `--accent-subtle`  | `#2a6b4a` | `#6aab8a` | Tinted text on dark surfaces     |
| `--accent-bg`      | `#0d2b1e` | `#ecf7f2` | Soft fill                        |
| `--accent-bg-deep` | `#0a2218` | `#d3ede2` | Pressed / selected fill          |

### Borders
| Token              | Dark      | Light     | Purpose                          |
|--------------------|-----------|-----------|----------------------------------|
| `--border`         | `#334155` | `#d1d5db` | Strong dividers, modal edges     |
| `--border-subtle`  | `#1e293b` | `#e2e8f0` | List rows, internal separators   |

### Status (semantic — always use these for success/danger/info)

**No amber anywhere in the UI.** The `warning` role exists for older code
but resolves to the neutral tokens (`--color-warning` → `--text-muted`,
`-fg` → `--text-secondary`, `-bg` → `--bg-tertiary`, `-border` →
`--border`; the same for `--pill-amber*`, `--sev-major`,
`--progress-warn`). Never add an amber/orange/yellow hex to chrome — a
problem is said in words, in a neutral note.

Values as they are in `index.html` (light `:root` / dark `[data-theme=dark]`):

| Role      | `--color-{role}`      | `-fg`                 | `-bg`                 | `-border`                                   |
|-----------|-----------------------|-----------------------|-----------------------|---------------------------------------------|
| `success` | `#16a34a` / `#22c55e` | `#15803d` / `#34d399` | `#f0fdf4` / `#052e16` | `rgba(22,163,74,.2)` / `rgba(34,197,94,.35)` |
| `warning` | neutral (see above)   | neutral               | neutral               | neutral                                     |
| `danger`  | `#dc2626` / `#ef4444` | `#b91c1c` / `#fca5a5` | `#fef2f2` / `#450a0a` | `rgba(220,38,38,.2)` / `rgba(239,68,68,.4)` |
| `info`    | `#1a6b4a` / `#4d9e75` | `#155c3e` / `#6dba8e` | `#ecf7f2` / `#0d2b1e` | `rgba(26,107,74,.2)` / `rgba(77,158,117,.35)` |

`info` is the accent green family, not blue. So it is never a way to tell
something apart from `success`: where two states must read differently next
to "success" (e.g. the model version comparison: added vs changed), use a
neutral text token for the second one — the comparison draws changed
elements in `--text-primary` and its legend uses the same tokens.

### Scene & overlays
| Token                 | Purpose                                |
|-----------------------|----------------------------------------|
| `--scene-bg`          | Three.js viewport background           |
| `--grid-line` / `--grid-center` | Reference grid colors        |
| `--measure`           | Measure lines, dots, magnifier ring    |
| `--overlay-bg`        | Translucent viewer overlay (light)     |
| `--overlay-bg-strong` | Translucent viewer overlay (strong)    |
| `--modal-bg`          | Modal backdrop scrim                   |

### Shadows
| Token         | Dark                       | Purpose                        |
|---------------|----------------------------|--------------------------------|
| `--shadow-sm` | `0 1px 3px rgba(0,0,0,.3)` | Subtle elevation               |
| `--shadow-md` | `0 4px 12px rgba(0,0,0,.3)`| Floating overlays, popovers    |
| `--shadow-lg` | `0 8px 24px rgba(0,0,0,.4)`| Modals, top-level dialogs      |

### Brand mark / logo

- **Mark:** a flat green square keyed to `--accent` (`#1a6b4a` dark /
  `#4d9e75` light), matching the favicon and PWA icons.
- The "CC" wordmark sits on the mark in white, set in `Syne` (`var
  (--font-display)`) at weight 800 with `letter-spacing: -.02em`.
- Shadow: none on small marks; `--shadow-md` for the boot/error-screen mark.
  No coloured glows or gradients.
- Used in: favicon, boot screen, header, left rail, error boundary.

---

## 3. Typography Rules

- **Font families** (loaded via Google Fonts in `<head>`, fallback chain in
  the CSS variables for offline / blocked-CDN scenarios):
  - **Display** — `Syne` (700, 800). Used for the brand wordmark, modal
    titles, hero headings. Token: `--font-display`. Apply via the
    `cc-display` utility class or `fontFamily: 'var(--font-display)'`.
  - **Body** — `DM Sans` (400, 500, 600, 700). Default for everything in the
    app. Token: `--font-body`, applied at the `body` level.
  - **Mono** — `DM Mono` (400, 500). Used for metadata, code-style labels,
    counts, IDs, project keys, settings section headers. Token:
    `--font-mono`. Apply via the `cc-mono` utility or `code`/`kbd`/`pre`/
    `samp` (already wired globally).
- **Type scale** (use these tokens, not raw `rem`/`px` values):

| Token           | Size       | Use                                            |
|-----------------|------------|------------------------------------------------|
| `--text-2xs`    | `.6875rem` | Status pills, micro labels                     |
| `--text-xs`     | `.75rem`   | Captions, helper text, dense list metadata     |
| `--text-sm`     | `.8125rem` | List row titles, secondary buttons, form labels|
| `--text-base`   | `.875rem`  | Default button text                            |
| `--text-md`     | `.9375rem` | Body text, inputs, modal body copy             |
| `--text-lg`     | `1.0625rem`| Modal titles, section headers                  |
| `--text-xl`     | `1.25rem`  | Page titles, modal close glyph                 |
| `--text-2xl`    | `1.5rem`   | Hero / boot screen                             |

- **Line heights:** `--leading-tight: 1.25` for headings & buttons,
  `--leading-base: 1.45` for body, `--leading-relaxed: 1.6` for long-form.
- **Weights:** `--weight-regular: 400`, `--weight-medium: 500` for emphasized
  body, `--weight-semibold: 600` for headings/buttons, `--weight-bold: 700`
  for titles and section uppercase labels.

**Hierarchy contract:**

| Element              | Token combo                                              |
|----------------------|----------------------------------------------------------|
| Modal title          | `--text-lg` / `--weight-semibold` / `--leading-tight`    |
| Section header       | `--text-xs` / `--weight-bold` / uppercase / `.08em`      |
| List row title       | `--text-sm` / `--weight-medium` / `--leading-base`       |
| List row description | `--text-xs` / `--weight-regular` / `--leading-base`      |
| Status pill          | `--text-2xs` / `--weight-semibold` / uppercase / `.04em` |
| Button label         | `--text-base` (default), `--text-xs` for compact rows    |
| Caption / hint       | `--text-xs` / `--text-muted`                             |

---

## 4. Component Stylings

### Buttons (`S_BTN`)

Base shape (defined in `index.html` near the "Shared style objects" block):
```js
S_BTN = {
  border: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
  fontSize: 'var(--text-base)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--space-2) var(--space-4)',
  lineHeight: 'var(--leading-tight)',
  transition: 'background var(--duration-fast) var(--ease-standard), …'
}
```

Variants are applied by spreading `S_BTN` and overriding `background` /
`color` / `border`. Use the `cc-btn-press` class to opt into the pressed
translate-Y micro-interaction.

| Variant   | background                       | color                  | border                                           |
|-----------|----------------------------------|------------------------|--------------------------------------------------|
| Primary   | `var(--accent)`                  | `#fff`                 | none                                             |
| Secondary | `var(--bg-secondary)`            | `var(--text-secondary)`| `1px solid var(--border)`                        |
| Ghost     | `none`                           | `var(--text-muted)`    | none                                             |
| Danger    | `var(--color-danger)`            | `#fff`                 | none                                             |
| Danger (quiet) | `none`                      | `var(--color-danger-fg)` | none — `S_BTN_DANGER_GHOST_SM`, a destructive action in a dense row (Remove a model) |
| Success   | `var(--color-success-bg)`        | `var(--color-success-fg)` | `1px solid var(--color-success-border)`       |
| Info      | `var(--color-info-bg)`           | `var(--color-info-fg)` | `1px solid var(--color-info-border)`             |

**Hierarchy in a panel:** one Primary per panel (Models: "Add model"; Data
quality: "Run checks"). Every other action is Secondary (`S_BTN_SECONDARY_SM`),
undo-type actions (Reset, Remove from map, Hide changes) are Ghost, and an
action keeps the same variant in every state — never a filled slab in one
state and a text link in another.

**States:** `:hover` lightens background by one step; `:focus-visible` adds a
2px `--accent` outline (`outline-offset: 2px`); `:active` applies
`translateY(1px)`; `:disabled` drops opacity to ~0.5 and changes cursor.

### Inputs (`S_INPUT`)

```js
S_INPUT = {
  width: '100%',
  boxSizing: 'border-box',   // padding + border inside the 100%, never wider than its column
  background: 'var(--bg-tertiary)',
  color: 'var(--text-primary)',
  fontSize: 'var(--text-md)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-2) var(--space-3)',
  border: '1px solid var(--border)',
  outline: 'none',
  transition: 'border-color var(--duration-fast) var(--ease-standard), …'
}
```

Focus draws a 2px `--accent` outline plus a border-color change. The same
shape covers `<input>`, `<textarea>` (add `resize: 'vertical'`), and
`<select>`.

### Lists (`S_LIST_ROW` / `cc-list-row`)

Clash and issue rows share `S_LIST_ROW` and add the `cc-list-row` class for
the hover state. Active rows use `S_LIST_ROW_ACTIVE` (a 2px accent left
border and `var(--bg-secondary)` background). Padding is
`var(--space-3) var(--space-3)`; bottom border is `--border-subtle`. Title
uses `--text-sm`/`--weight-medium`; description `--text-xs`/`--text-faint`.

### Inline notes (`S_NOTE`)

- Every inline note — context ("the other sharing mode is in use") or a
  problem to act on (not syncing, records refused, feature unavailable in
  this browser) — is `S_NOTE`: `--text-secondary` on `--bg-tertiary`,
  `--border-subtle`. The words carry the meaning; no amber, no status tint.

### Status pills (`cc-status-pill`)

```css
.cc-status-pill {
  display: inline-flex;
  align-items: center;
  padding: .1rem var(--space-2);
  border-radius: var(--radius-pill);
  font-size: var(--text-2xs);
  font-weight: var(--weight-semibold);
  letter-spacing: .04em;
  text-transform: uppercase;
}
```

Apply the class and pass `background` + `color` from a semantic token pair
(e.g. `--color-success-bg` / `--color-success-fg`).

### Modals (`S_BACKDROP`, `S_MODAL_CARD`, `S_MODAL_HEADER`, `S_MODAL_TITLE`, `S_MODAL_BODY`, `S_MODAL_CLOSE`)

A modal is a `<div>` with `S_BACKDROP` + class `cc-modal-backdrop` (fade-in),
containing a card `<div>` with `S_MODAL_CARD` + class `cc-modal-card`
(scale + lift entrance, `var(--duration-base) var(--ease-decelerate)`).

Required ARIA: `role="dialog"`, `aria-modal="true"`,
`aria-labelledby="<title-id>"`. Every close `×` button must have
`aria-label="Close …"`. Escape closes the modal via a window keydown
listener registered in `useEffect`.

Initial focus: a dialog whose first control is the close `×` focuses its own
card on open (`_ccUseFocusTrap(ref, true, {initialFocus:'container'})`, card
`tabindex="-1"`, no outline), so the × never shows a ring until the user
tabs to it; Tab then moves to the first control.

Card width defaults: 440 (form modals), 480 (settings), 460 (welcome).
Border radius `var(--radius-lg)`, shadow `var(--shadow-lg)`. Body padding
`var(--space-5)`; header padding `var(--space-4) var(--space-5)`.

### Viewer overlays (`cc-overlay-chrome`, `S_OVERLAY`)

Floating overlays inside the 3D viewer share the `cc-overlay-chrome` class:
`var(--overlay-bg-strong)` background, `1px solid var(--border-subtle)`
border, `var(--radius-md)` corner, `var(--shadow-md)` elevation, and an
8px backdrop blur. Default text size is `var(--text-2xs)` /
`var(--text-xs)`.

### Tabs / segmented controls

Active tab gets a 2px `var(--accent)` left border (vertical rail) or bottom
border (horizontal). Inactive tabs use `var(--text-muted)`; active uses
`var(--text-primary)`. Hover transitions over `var(--duration-fast)`. Nothing
else marks the active tab — no dot or glyph before the label. `role="tablist"`
/ `role="tab"` + `aria-selected`.

### Disclosure (`CcDisclosure`)

Anything that opens and closes in place (property sets, Location, a data
quality check's elements, section headers) is a `<button>` with
`aria-expanded` (+ `aria-controls`). Its marker is the text it always had
(▶ / ▼, or ▲ / ▼ in the data-quality panel) — no icon is added for it.
`CcDisclosure` variants: `title` (`S_SUBTITLE`) and `item` (`--text-xs`
semibold, `--text-secondary`).

### Label / value rows

Inspector and model-card rows give the label column one fixed share
(`flex: 0 0 38%`, wrapping) so a long label ("Predefined type") wraps instead
of pushing its value out of line with the rows around it. Values are plain
text; mono only for counts, IDs, keys and measured values.

### Toggles (`Toggle` component in SettingsModal)

`38×22` track, `18×18` thumb, `var(--radius-pill)` corners. Track color is
`var(--accent)` when on, `var(--text-faint)` when off. Thumb slides over
`var(--duration-base) var(--ease-standard)`. `role="switch"` with
`aria-checked` and Enter/Space keyboard support.

### Clash review: bucket bar, filter chips, overview cards

- **Bucket bar** (`BucketBar`): one `--bg-tertiary` row under the clash
  panel header — "132 to review" in `--text-primary`/semibold, then each
  other bucket as an underlined text button ("· 79 only touch (contact)",
  "· 21 adjacent by design (wall–slab, wall–beam …)"). A shown bucket gets
  `--accent-bg` + a 1px `--accent` border and a ✓, and `aria-pressed`.
  Never colour-only. Each entry is set as unbreakable parts ("· 21
  adjacent by design" + "(wall–slab, wall–beam …)"): the row wraps
  left-aligned between entries, or at most before an entry's parenthesis,
  never mid-phrase; "Show all" / "Review only" follows in the same row.
  Under it, the run's one-line summary ("132 clashes ·
  132 open · 0 resolved") as a `--text-xs`/`--text-muted` caption; the
  rest of the run statistics (AI summary, stats/delta chips, model matrix)
  sit in one native `<details>` "Run details", closed by default.
- **Sidebar layout**: everything above the grouping row (bucket bar, run
  caption, left-out notice, Run details, search + `List | Overview N`,
  suggested views) is one region (`[data-cc-clash-head]`) that scrolls on
  its own once taller than its share; the grouping row and the list below
  it always stay in view (the list keeps ≥ 35 % of the panel). The search
  takes the full width when the panel is too narrow for it and the view
  toggle on one line, with a short placeholder ("Filter clashes…"; the
  example query is its tooltip).
- **Sidebar list** while the overview is open: bucket bar, left-out notice,
  search + `List | Overview N`, then the grouping row — the facets live in
  the overview only (one filter surface). Rare list actions (Select
  multiple, Triage focus, Clear all) are behind the grouping row's `⋯`
  button (`aria-label` "More list actions", `role="menu"` at
  `--z-dropdown`, arrow keys + Escape).
- **Filter chips** (`TriageFilterBar`): pill buttons (`--radius-pill`,
  `--text-xs`, `--bg-secondary` + `--border`; pressed = `--accent-bg-deep` +
  `--accent` border, `aria-pressed`), each with its live count in
  `--font-mono`/`--text-2xs`/`--text-muted`. Facet groups are `role="group"`
  rows with a section-header label. Active filters repeat as removable
  pills ("Severity: Critical ×", `aria-label` "Remove filter …"); "shown /
  total" is a `role="status"` live region set as a plain `--text-xs` /
  `--text-muted` caption (body font, tabular numerals — not mono).
  - In the sidebar the facet panel is a native `<details>`.
  - In the overview (`compact`) there is one Suggested chip strip (max 6,
    then "+N more"; saved views follow), one action row (Filters button,
    pills, Reset, Save view…, status, Export BCF…) and the facets in a
    **Filters popover** (`.cc-facet-pop`: `--bg-secondary`, `--border`,
    `--radius-md`, `--shadow-md`, max 60vh, `--z-dropdown`; `role="dialog"`,
    the button carries `aria-expanded`/`aria-controls` and a mono count
    badge). Escape closes the popover (focus back on the button) before it
    closes the overview. On ≤ 768 px the popover is a bottom sheet above the
    mobile nav (`bottom: 56px`, `calc(var(--z-panel) + 4)`), the chip strip
    and the bucket bar scroll sideways, and every control is ≥ 44 px tall
    (`.cc-tap`).
- **Overview cards** (`ClashOverview` / `ClashOverviewCard`): CSS grid
  `repeat(auto-fill, minmax(min(100%, 240px), 1fr))` (one column on
  phones), `--space-3` gap; each card is one `<button>` (`--bg-secondary`,
  `--border`, `--radius-md`, `--shadow-sm`) with a 320×200 snapshot, a
  severity pill (`_ccSeverityPillStyle`: danger/warning/info/neutral bg+fg
  token pairs — the word carries the meaning), a members pill, title
  (`--text-sm` semibold, 2 lines, full text in `title`), the extent line
  ("1 through · 2 partial"), storey (+ model pair only when > 2 models are
  loaded) and an open/assignee line, all `--text-xs`. While the picture is
  pending the snapshot area is a `.cc-skeleton` shimmer (`--bg-tertiary` →
  `--bg-secondary`, 1.2 s, off under reduced motion) with an `sr-only`
  "Picture pending"; the picture fades in over `--duration-base` with
  `alt` "Snapshot of …"; a clash with nothing to draw says "No picture —
  element has no geometry" in `--text-muted`. Roving tabindex; J/K/arrows
  move, Enter opens, Escape returns to the 3D view (the key hint is an
  `sr-only` description of the grid and a row in the `?` shortcuts).
  Empty states: filters matching nothing → "No review items match these
  filters" + Reset; nothing in review → "Nothing to review — N findings
  are filed in other buckets" + "show all".
  `.cc-overview` sits between the floating panels on desktop and is a
  fixed sheet above the panel on phones.
- Group headers in the list use the existing chevron of the model clash
  matrix (rotated 90° when open). A
  root-cause header is the toggle (chevron, title + member count, then a
  `--text-xs` meta line: severity pill, extent, storey, open count) with
  the group actions (Accept all, Set status…) on their own row under it,
  left-aligned with the title; controls wrap rather than cut a label.
- **Clash rows**: title `--text-sm`/`--weight-medium` (two lines max) with
  the status pill (label from the status table, translated) on its first
  line; under it one `--text-xs`/`--text-muted` meta line with the clash
  number and the markers (New, Auto, AI, note) — no line of its own for a
  lone marker. Expand / collapse buttons are the ▼ / ▲ text they always had,
  with an `aria-label`.
- Snapshot pictures themselves are 3D renders, not chrome: the A/B pair
  colours match the viewport's clash-focus colours, the context is a fixed
  light ghost so a BCF/PDF picture looks the same in either theme.

---

### Iconography & button labels

- **No icons added to the UI.** Don't introduce icons — not SVG, not icon
  fonts, not emoji — and don't swap existing text markers (▼ ▶ ✕ ✓ ⚠ …)
  for icons: a control says what it does in words. The icons that are
  already there (toolbar, left rail, header, search / filter / eye in
  lists) stay as they are; nothing new joins them.
- **No emoji in the UI.**
- Button labels are plain language, sentence case, no marketing words
  ("free"/"gratis") — pricing/positioning lives on the website, not in
  chrome. Source or scope goes in parentheses: "3D omgeving — NL (PDOK)".

## 5. Layout Principles

### Spacing scale (4dp grid)

Always use `var(--space-N)`. Never hand-pick `.65rem` or `11px`.

| Token         | Value        |
|---------------|--------------|
| `--space-0`   | `0`          |
| `--space-1`   | `.25rem` (4px)  |
| `--space-2`   | `.5rem` (8px)   |
| `--space-3`   | `.75rem` (12px) |
| `--space-4`   | `1rem` (16px)   |
| `--space-5`   | `1.25rem` (20px)|
| `--space-6`   | `1.5rem` (24px) |
| `--space-8`   | `2rem` (32px)   |

### Radius scale

| Token          | Value     | Use                                  |
|----------------|-----------|--------------------------------------|
| `--radius-xs`  | `4px`     | Pills inside dense rows              |
| `--radius-sm`  | `6px`     | Buttons                              |
| `--radius-md`  | `8px`     | Inputs, popovers, overlay chrome     |
| `--radius-lg`  | `12px`    | Modals                               |
| `--radius-xl`  | `16px`    | Welcome / hero cards                 |
| `--radius-pill`| `999px`   | Status pills, badges                 |

### Motion

| Token              | Value                          | Use                              |
|--------------------|--------------------------------|----------------------------------|
| `--duration-fast`  | `120ms`                        | Hover, focus, button press       |
| `--duration-base`  | `200ms`                        | Modal entrance, panel slide      |
| `--duration-slow`  | `320ms`                        | Long transitions, hero animations|
| `--ease-standard`  | `cubic-bezier(.2,0,0,1)`       | Most transitions                 |
| `--ease-decelerate`| `cubic-bezier(0,0,0,1)`        | Entrances                        |
| `--ease-accelerate`| `cubic-bezier(.3,0,1,1)`       | Exits                            |

A global `@media (prefers-reduced-motion: reduce)` block forces all
animation/transition durations to `~0` and disables modal entrances.

### Shell layout

```
┌─────────────────────────────────────────────────────────┐
│ Header (mobile only on desktop layout, always on small) │
├──────┬──────────┬───────────────────────────┬───────────┤
│ Left │  Side    │                           │  AI chat  │
│ rail │  panel   │       Three.js viewer     │  (float)  │
│      │ (resize) │       + overlays          │           │
└──────┴──────────┴───────────────────────────┴───────────┘
                                                Bottom nav
                                                (mobile)
```

- Left rail uses fixed width with icon-only buttons.
- Side panel is resizable 200–600px.
- Viewer overlays stack in `var(--space-3)` insets from each corner and use
  `cc-overlay-chrome`.
- Modals and the welcome dialog are `position: fixed` with the
  `cc-modal-backdrop` scrim.
- Below 768px the left rail is hidden and a bottom mobile nav takes over.

### Layers (z-index scale)

Fixed/absolute page-level chrome picks **one** of these `:root` tokens —
never a hand-picked number. Tiers are strictly increasing so a surface from
a later tier always wins over an earlier one (e.g. the command palette over
every modal; a modal backdrop over the right panel).

| Token           | Value | Covers |
|-----------------|-------|--------|
| `--z-panel`     | 100   | Persistent side chrome: left rail, left panel, right AI/Details panel, mobile nav |
| `--z-dropdown`  | 400   | Transient popovers/menus: avatar menu, STYLE menu, context menus, toolbar dropdowns |
| `--z-overlay`   | 800   | Floating viewer-adjacent overlays above panels: clash chips, presentation-mode chrome, switching-project veil |
| `--z-modal`     | 2000  | Modal backdrops + cards (`S_BACKDROP`), guided tour, memory-warning dialog |
| `--z-toast`     | 3000  | Banners/toasts: privacy banner, detection-discoverability banner, what's-new, PWA update, operation center, folder-watch badge |
| `--z-palette`   | 4000  | Command palette — above every modal/toast |
| `--z-tooltip`   | 5000  | Custom tooltips, global drag-drop veil, snap marker — must always win |

Within a tier, stack siblings with `calc(var(--z-tier) + N)` (e.g. a
popover's backdrop at `var(--z-dropdown)` and its menu at
`calc(var(--z-dropdown) + 1)`) rather than introducing a new tier.

Elements scoped to their own local stacking context — in-canvas viewer
overlays, sticky list headers, within-panel resize handles — intentionally
keep small ad-hoc numbers (single digits). They only order siblings inside
that ancestor and never compete with page-level chrome, so they're not on
this scale.

### Accessibility contract

- Every icon-only button **must** have `aria-label`.
- Every modal **must** have `role="dialog"`, `aria-modal="true"`, and
  `aria-labelledby` pointing at its title element.
- Focus rings (defined in the global CSS): 2px `var(--accent)` outline with
  `outline-offset: 2px` for buttons; 2px outline + accent border for inputs.
- Escape closes any open modal.
- Keyboard navigation works without a mouse — every interactive element is
  reachable via Tab and operable via Enter/Space.
- Color is never the sole carrier of meaning — pair status colors with text
  labels (`Confirmed`, `Denied`, `Open`, etc.).
- Reduced motion: respected globally via `@media (prefers-reduced-motion: reduce)`.

---

## How to add a new screen or component

1. **Open `index.html`** — that is the only source file.
2. **Pull tokens, don't pick values.** If you need a new token, add it to
   `:root` (light) *and* `[data-theme=dark]` first.
3. **Reuse `S_BTN`, `S_INPUT`, `S_LIST_ROW`, `S_BACKDROP`, `S_MODAL_*`,
   `S_OVERLAY`, `cc-status-pill`, `cc-overlay-chrome`** before composing
   anything new.
4. **Apply ARIA** as described in the Accessibility contract.
5. **Test both themes** (dark + light) and reduced-motion.
6. **Update this `DESIGN.md`** when you introduce a new component family.
