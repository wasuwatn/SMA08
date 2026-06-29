# Sage Design System

> Minimal, premium, pastel olive. Clean form. Quiet luxury.

A considered design system built around a warm olive palette, editorial serif typography, and generous whitespace. The visual language draws from botanical minimalism and quiet luxury — deliberate, refined, unhurried.

## Sources

Generated from brand brief: **"minimal, pastel premium, pastel olive, clean."**  
No external Figma links, codebase, or logo assets were provided — all visual decisions originate from this description alone.

**Outstanding items (requires your input):**
- Logo file(s) → place in `assets/`
- Custom font files → update `tokens/fonts.css` with local `@font-face` (see Fonts Note below)
- Product screenshots or Figma for UI kit expansion

---

## Brand Identity

| | |
|---|---|
| **Name** | Sage |
| **Voice** | Calm, considered, uncluttered |
| **Vibe** | Premium naturals × editorial minimalism |
| **References** | Aesop, Kinfolk, The Row, Scandinavian craft |

---

## Content Fundamentals

### Tone
- **Quiet authority** — the brand does not shout; it invites.
- **Considered, not verbose** — fewer words carry more weight.
- **Warm but measured** — approachable without being informal.
- Full sentences; avoid fragments in body copy.
- No exclamation marks in primary copy.
- No superlatives ("best", "revolutionary") — show, don't claim.

### Casing
| Context | Rule |
|---|---|
| Headlines | Sentence case |
| UI button labels | ALL CAPS, wide tracking |
| Tags / metadata | Sentence case or lowercase |
| Navigation | Sentence case |
| Input labels | ALL CAPS, wide tracking (handled by component) |

### Voice — I vs You
- Address the user directly in **second person**: "your workspace", "you can…"
- Brand speaks in first person plural when necessary: "we believe…"

### Emoji
- Not used in product UI copy.
- Permitted in informal social/community contexts only.

### Examples
| Context | ✗ | ✓ |
|---|---|---|
| CTA | `Click Here!` | `Explore the collection` |
| Error | `Oops! Something went wrong 😬` | `Something went wrong. Please try again.` |
| Success | `Awesome, you're all set!` | `Your changes were saved.` |
| Headline | `The Most Powerful Tool For Teams` | `Designed for how teams work` |
| Empty state | `Nothing here yet!` | `Nothing here yet. Start by adding an item.` |

---

## Visual Foundations

### Colour
Three scales, all in OKLCH for perceptual uniformity:

| Scale | Hue | Role |
|---|---|---|
| **Olive** | 100° | Primary brand — actions, headings, key moments |
| **Sage** | 148° | Secondary accent — success states, soft fills |
| **Stone** | 75° | Neutral — all backgrounds, text, structure |

- **Pastels dominate.** Steps 50–200 are used heavily for backgrounds, fills, and tints.
- **Dark olive** (600–900) for text and primary interactive elements.
- **Pure white** (`--white`) as card surfaces against the warm canvas.
- No gradients. Flat colour only.

### Typography
| Role | Typeface | Notes |
|---|---|---|
| Display | Cormorant Garant | Elegant high-contrast serif; headlines, hero, editorial |
| Body | DM Sans | Clean geometric sans; UI, body, labels |
| Mono | DM Mono | Data labels, code, token names |

- Display type uses tight leading (`1.2`) and negative tracking (`-0.02em`).
- Button and input labels: `xs`/`sm` uppercase, `0.04em` letter-spacing.
- Body: `base` (16px), `leading-normal` (1.5).

### Spacing
4 px base grid. `--space-1` = 4 px.  
Component internals: `space-3`–`space-6` (12–24 px).  
Section/page gaps: `space-16`–`space-32` (64–128 px).

### Backgrounds & Surfaces
- Page canvas: `--bg-canvas` (stone-50, warm off-white)
- Section alternation: `--bg-subtle` (stone-100)
- Cards: `--surface-default` (pure white)
- No full-bleed photography backgrounds; no gradients

### Animation
- **Minimal** — transitions for state changes only; never decorative.
- `--duration-normal` (200 ms) for colour/border; `--duration-slow` (300 ms) for entrance.
- Easing: `--ease-out` for most; `--ease-natural` for entrances and slides.
- Always honour `prefers-reduced-motion`.

### Hover & Press States
- Hover: one step darker on the colour scale (e.g. olive-600 → olive-700).
- No scale transforms on hover — too energetic for this brand.
- Active/press: two steps darker; no shrink.
- Transition: `--transition-color`, 200 ms.

### Borders
- Default: 1 px solid `--border-default` (stone-200) — barely present.
- Strong: `--border-strong` for focused/active states.
- Accent: `--border-accent` (olive-400) for brand moments.
- No decorative borders; borders are purely structural.

### Shadows
- Warm-tinted (hue ~75°), very low opacity (6–12%).
- Cards: `--shadow-xs` or `--shadow-sm` (barely perceptible lift).
- Modals: `--shadow-xl`.
- Never coloured or harsh.

### Corner Radii
- Inputs, buttons: `--radius-sm` (4 px) – `--radius-md` (6 px)
- Cards: `--radius-xl` (12 px)
- Pills, badges, avatars: `--radius-full`
- Avoid `--radius-3xl` on non-circular elements.

### Cards
Background `--surface-default` (white), shadow `--shadow-xs`, optional 1 px `--border-default`, `--radius-xl`, padding `space-6` (24 px) default.

### Transparency & Blur
Minimal. Transparency reserved for overlays. Blur (8–12 px) only behind overlay backdrops. No glass/frost effects on primary UI.

### Imagery
- Warm natural tones (botanical, earth, craft).
- Avoid cold blue-filtered photography.
- Shallow depth of field, natural light preferred.
- Minimal grain acceptable.

---

## Iconography

**No custom icon set provided.** Use **Lucide** (https://lucide.dev):
- 1.5 px stroke weight, rounded line caps — matches brand register.
- Load from CDN (see `assets/README.md`).
- Sizes: 16 px (compact), 20 px (standard), 24 px (prominent).
- Always stroke; never fill.
- Do not use emoji as icons in product UI.

See `assets/README.md` for setup instructions.

---

## Fonts Note

⚠️ **Substitution in use.** Cormorant Garant and DM Sans are served from Google Fonts CDN.  
For production, supply `.woff2` files and add `@font-face` blocks to `tokens/fonts.css`.  
Offline and PPTX export will not render correctly without local font files.

---

## File Index

```
styles.css                       ← Link this one file in consumers
tokens/
  fonts.css                      ← @import Google Fonts + family vars
  colors.css                     ← Olive / Sage / Stone scales + semantic layer
  typography.css                 ← Size, weight, leading, tracking
  spacing.css                    ← 4px-base spacing scale (space-1 … space-64)
  radius.css                     ← Border radius tokens
  shadows.css                    ← Warm shadow system + ring-focus
  motion.css                     ← Duration + easing + composite transitions
components/
  actions/
    Button.jsx                   ← solid | outline | ghost | soft; sm/md/lg
  surfaces/
    Card.jsx                     ← default | elevated | bordered | soft | ghost
  data-display/
    Badge.jsx                    ← Status/label pill (non-interactive)
    Tag.jsx                      ← Category chip, optionally dismissible
    Avatar.jsx                   ← Photo or initials, xs→2xl
  forms/
    Input.jsx                    ← Label + helper + error + sizes
guidelines/                      ← Foundation specimen cards (Design System tab)
assets/                          ← Place logos, icons, imagery here
readme.md                        ← This file
SKILL.md                         ← Agent skill definition
```
