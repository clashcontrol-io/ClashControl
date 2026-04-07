# Design System: ClashControl

ClashControl is a free, open-source IFC clash-detection web app that lives
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
- **Themes:** dark (`:root`) is the default; light (`[data-theme=light]`) is a
  full peer with mirrored tokens.

---

## 2. Color Palette & Roles

All colors below live as CSS custom properties in `index.html` `:root` (dark)
and `[data-theme=light]`. **Never** hand-pick a hex in component code; pull
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
| `--accent`         | `#2563eb` | `#2563eb` | Primary action, focus ring       |
| `--accent-hover`   | `#3b82f6` | `#3b82f6` | Hover state                      |
| `--accent-subtle`  | `#93c5fd` | `#2563eb` | Tinted text on dark surfaces     |
| `--accent-bg`      | `#1e3a5f` | `#eff6ff` | Soft fill                        |
| `--accent-bg-deep` | `#172554` | `#dbeafe` | Pressed / selected fill          |

### Borders
| Token              | Dark      | Light     | Purpose                          |
|--------------------|-----------|-----------|----------------------------------|
| `--border`         | `#334155` | `#d1d5db` | Strong dividers, modal edges     |
| `--border-subtle`  | `#1e293b` | `#e2e8f0` | List rows, internal separators   |

### Status (semantic — always use these for success/warning/danger/info)
| Role        | `--color-{role}` | `--color-{role}-fg` | `--color-{role}-bg` | `--color-{role}-border`             |
|-------------|------------------|---------------------|---------------------|-------------------------------------|
| `success`   | `#22c55e`        | `#34d399`           | `#052e16`           | `rgba(34,197,94,.35)`               |
| `warning`   | `#f59e0b`        | `#fbbf24`           | `#422006`           | `rgba(245,158,11,.35)`              |
| `danger`    | `#ef4444`        | `#fca5a5`           | `#450a0a`           | `rgba(239,68,68,.4)`                |
| `info`      | `#3b82f6`        | `#93c5fd`           | `#172554`           | `rgba(59,130,246,.35)`              |

(Light theme provides equivalents that swap fg/bg lightness to remain legible.)

### Scene & overlays
| Token                 | Purpose                                |
|-----------------------|----------------------------------------|
| `--scene-bg`          | Three.js viewport background           |
| `--grid-line` / `--grid-center` | Reference grid colors        |
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

- **Gradient:** `--logo-gradient` =
  `linear-gradient(135deg, #00e5ff 0%, #7c3aed 100%)` (cyan → purple).
- **Soft variant:** `--logo-gradient-soft` for tinted backgrounds at ~18%
  alpha.
- The "CC" wordmark sits on the gradient in white, set in `Syne` (`var
  (--font-display)`) at weight 800 with `letter-spacing: -.02em`.
- Drop shadow: `0 4px 12px rgba(124,58,237,.3)` for small marks; bump to
  `0 8px 24px rgba(124,58,237,.35)` for hero/boot/error-screen marks.
- Used in: favicon, boot screen, header, left rail, error boundary, welcome
  popup gradient header.

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
| Success   | `var(--color-success-bg)`        | `var(--color-success-fg)` | `1px solid var(--color-success-border)`       |
| Info      | `var(--color-info-bg)`           | `var(--color-info-fg)` | `1px solid var(--color-info-border)`             |

**States:** `:hover` lightens background by one step; `:focus-visible` adds a
2px `--accent` outline (`outline-offset: 2px`); `:active` applies
`translateY(1px)`; `:disabled` drops opacity to ~0.5 and changes cursor.

### Inputs (`S_INPUT`)

```js
S_INPUT = {
  width: '100%',
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
`var(--text-primary)`. Hover transitions over `var(--duration-fast)`.

### Toggles (`Toggle` component in SettingsModal)

`38×22` track, `18×18` thumb, `var(--radius-pill)` corners. Track color is
`var(--accent)` when on, `var(--text-faint)` when off. Thumb slides over
`var(--duration-base) var(--ease-standard)`. `role="switch"` with
`aria-checked` and Enter/Space keyboard support.

---

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
   `:root` *and* `[data-theme=light]` first.
3. **Reuse `S_BTN`, `S_INPUT`, `S_LIST_ROW`, `S_BACKDROP`, `S_MODAL_*`,
   `S_OVERLAY`, `cc-status-pill`, `cc-overlay-chrome`** before composing
   anything new.
4. **Apply ARIA** as described in the Accessibility contract.
5. **Test both themes** (dark + light) and reduced-motion.
6. **Update this `DESIGN.md`** when you introduce a new component family.
