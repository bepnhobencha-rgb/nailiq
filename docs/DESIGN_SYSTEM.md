# NailIQ Design System — Foundation & Layout

**Role:** Visual operating specification for production SaaS.  
**Audience:** Product, design, engineering.  
**Scope:** Spatial rhythm, type scale, radii, elevation, stacking order, breakpoints, and operational grid rules only.

**Out of scope here:** Color definitions (`COLOR_TOKENS.md`), component API (`COMPONENT_RULES.md`), motion (`ANIMATION_RULES.md`).

**Alignment:** Extends patterns established in the global stylesheet and shared token module. This document must not introduce parallel naming systems or decorative trends that conflict with `docs/UX_PRINCIPLES.md`.

**Product context:** Operational, receptionist-first, touch-first, dark-first, long-session software. Goals: calm, premium, stable, fast, trustworthy, **low cognitive load**. Clarity before beauty. Not marketing chrome, not game HUD, not glass-heavy novelty.

---

## 1. Spacing System

### Base unit

**4px** is the atomic step. All spacing values are multiples of 4 unless a documented exception (e.g. safe-area synthesis) requires mixing with device env insets.

### Token naming

Use **`space-1` … `space-9`** as the canonical names for the locked scale below.

| Token    | Value |
| -------- | ----- |
| `space-1`  | 4px   |
| `space-2`  | 8px   |
| `space-3`  | 12px  |
| `space-4`  | 16px  |
| `space-5`  | 24px  |
| `space-6`  | 32px  |
| `space-7`  | 48px  |
| `space-8`  | 64px  |
| `space-9`  | 96px  |

### When to use each level

- **`space-1`–`space-2`:** Tight internal padding inside dense controls (chip gaps, icon–text pairs, stacked meta lines). Use sparingly on touch surfaces so hit regions stay independent.
- **`space-3`–`space-4`:** Default **intra-group** rhythm—labels to fields, rows in a compact list, timeline cell internals.
- **`space-5`:** **Between** related groups in an operational pane (e.g. toolbar block vs. first row of content).
- **`space-6`–`space-7`:** Section breaks within a page, or breathing room around primary panes on tablet/desktop.
- **`space-8`–`space-9`:** Major layout separation (hero-to-content in marketing-only contexts, rare large empties in dashboard shells). Avoid on receptionist grid chrome—large empty gaps steal scan bandwidth.

### Density rules

- **Compact operational zones** (timeline, queue rows, desk toolbars): default to **`space-2`–`space-4`** horizontal and vertical rhythm; increase to **`space-5`** only when touch ambiguity appears.
- **Relaxed settings / setup flows:** allow **`space-5`–`space-6`** between sections so low-tech users can infer grouping without reading every label.
- **Touch-safe spacing:** spacing must not collapse interactive targets below **44×44px** (minimum tappable area per UX contract). Padding around a control is additive to its intrinsic size, not a substitute for target size.

### Operational dashboard philosophy

The desk is a **throughput surface**. Spacing is a **lane marking** tool: consistent gutters train muscle memory (queue always aligns to the same vertical rhythm; timeline headers align to staff rows). Inconsistent spacing forces re-scanning and raises eye fatigue during long shifts.

### Why consistency matters operationally

Under rush conditions, receptionists **parse layout, not copy**. Stable vertical and horizontal increments make “where did that button move?” a non-issue, reduce mis-taps, and keep peripheral vision reliable when glancing between clients and screen. Spacing drift is a **latency tax**—every unexpected gap forces a conscious read instead of a reflex.

---

## 2. Typography Scale

### Primary family

**Primary sans:** the application’s loaded sans face, wired in the global stylesheet as the default UI stack.  
**Fallback stack:** system UI sans (`system-ui`, `-apple-system`, generic `sans-serif`) to preserve legibility before font load and on constrained devices.

**Monospace:** reserved for machine-readable strings (codes, raw phone fragments in dev tooling if any)—not for body copy.

**Marketing-only note:** a public landing experience may pair a display family for hero emphasis; **operational surfaces (dashboard, receptionist, setup)** stay on the primary sans stack only so desk and owner views share one readable voice.

### Size scale (semantic)

Sizes are listed as **font size / line height** intent. Line height prioritizes scan lines and multi-line safety in dark mode.

| Step   | Size (px) | Line height (px) |
| ------ | --------- | ---------------- |
| `xs`   | 12        | 16               |
| `sm`   | 14        | 20               |
| `base` | 16        | 24               |
| `lg`   | 18        | 28               |
| `xl`   | 20        | 30               |
| `2xl`  | 24        | 32               |
| `3xl`  | 30        | 36               |

### Weight rules

- **Regular:** long body, secondary descriptions.
- **Medium:** emphasized body, some navigation labels.
- **Semibold:** section titles within a pane, key labels that must win over body.
- **Bold:** rare—page-level headings and numeric emphasis only where hierarchy requires it.

Avoid bolding entire sentences in operational paths; it destroys scan structure.

### Line-height rules

- **`xs`–`sm`:** keep generous line height relative to size (see table) to protect descenders and diacritics in EN/VI.
- **`base`–`lg`:** default reading band for desk UI; never tighten below the paired line height for multi-line fields.
- **Display steps (`2xl`–`3xl`):** short lines only (headings, KPI shells). If wrapping exceeds two lines, drop one step in size rather than crushing line height.

### Tracking

- Default **normal** tracking for almost all UI.
- **Slight tight tracking** is acceptable on large single-line headings only; do not apply to `sm` or `xs` (hurts distance readability).

### Usage categories (intent)

| Category        | Typical step        | Weight        | Intent |
| --------------- | ------------------- | ------------- | ------ |
| Heading (pane)  | `lg`–`xl`           | semibold      | Frame a workspace without shouting. |
| Heading (page)  | `2xl`–`3xl`         | semibold–bold | Rare in ops; settings hub only. |
| Body            | `base`              | regular       | Primary reading band. |
| Label           | `sm`                | medium        | Field names, table-like rows. |
| Caption / meta  | `xs`–`sm`           | regular       | Timestamps, hints, secondary status. |
| KPI number      | `xl`–`2xl`          | semibold      | Short, high-contrast; pair with `sm` label. |
| Booking title   | `sm`–`base`         | semibold      | Client-facing clarity in blocks. |
| Queue metadata  | `xs`–`sm`           | regular       | Wait time, service name, urgency hints. |

### Readability goals

- **Distance / glance:** desk screens are often arm’s length; `xs` is for **non-critical** meta only. Anything tied to money, time, or conflict stays **`sm`+** with adequate weight contrast.
- **Scan speed:** predictable step ladder (no ad-hoc intermediate sizes) lets the eye slide vertically down columns.
- **Low eye fatigue:** dark-mode long sessions favor **softer contrast for secondary text** (handled in color tokens), **not** microscopic type. If hierarchy breaks, adjust size before relying on opacity alone.

---

## 3. Border Radius System

### Tokens

| Token  | Radius | Role |
| ------ | ------ | ---- |
| `none` | 0      | Structural dividers, full-bleed panels, grid edges flush to viewport. |
| `sm`   | 6px    | Small controls, compact badges, dense chips. |
| `md`   | 10px   | Default interactive (secondary buttons, inline pills). |
| `lg`   | 16px   | Inputs, cards inside panes, queue tiles. |
| `xl`   | 20px   | Large cards, prominent panels—still restrained. |
| `full` | pill   | Primary CTAs, status capsules, avatars. |

### Philosophy

Roundedness signals **containment and interaction**, not playfulness. Sharp (`none`) communicates **system structure** (grid boundaries, split panes). Softer radii communicate **things you tap or drag**. The desk should never read as a toy UI: avoid “bubble” radii on large structural regions.

### Operational meaning

- **Hard edges:** timeline shell, full-width headers bonded to edges, split separators.
- **Softer edges:** booking blocks, drawer surfaces, form fields—areas touched or edited.
- **Pill (`full`):** singular forward actions and compact state indicators—not entire layouts.

---

## 4. Shadow System

### Tokens

| Token  | Role |
| ------ | ---- |
| `none` | Default for most dark surfaces; rely on borders/separators for structure. |
| `sm`   | Minimal lift: small controls, subtle separation from same-plane neighbors. |
| `md`   | Raised cards, dropdown-like surfaces, inline panels that must read “above” background. |
| `lg`   | High emphasis only: **floating** shells that obscure context (panel above scrim), rare luxury emphasis. |

### Elevation philosophy

Dark UI loses hierarchy when every layer glows. Elevation communicates **one thing at a time**: if two adjacent surfaces both claim `lg`, the UI feels muddy and anxious. Default to **`none` + border**; escalate shadow only when depth resolves **affordance** (floating, draggable, or modal).

### When borders beat shadows

- Adjacent **operational** panes (timeline vs. queue) should separate with **1px hairline borders** or background step—not stacked shadow.
- Dense grids: shadows on every cell create noise; prefer inset dividers or selection outlines (color from tokens).

### Dark-mode discipline

- Avoid wide, soft blurs that turn charcoal into smoke.
- Avoid competing glows on siblings; **one** gold-adjacent halo metaphor per viewport region max.
- Preserve **contrast of edges** over simulated light physics.

### Overlays, drawers, floating surfaces

- **Overlay scrim:** dims context; stays visually flat (`none` or tokenized scrim opacity)—no hero shadow.
- **Drawer / side panel:** `md`–`lg` shadow on the **panel edge** only, as needed for separation from dimmed content; interior stays calm.
- **Floating errors / toasts:** `md` shadow max; they are transient, not monuments.

### Depth restraint

If a surface is not interactive and not floating, **do not shadow it**. Depth is for **actionability and stacking**, not decoration.

---

## 5. Z-Index Layers

**Policy:** deterministic stacking only. Aligns with **Zero popup stacking** (one depth crisis at a time; replace or dismiss—never modal-on-modal).

### Named layers and values

| Layer     | Value |
| --------- | ----- |
| `base`    | 0     |
| `sticky`  | 10    |
| `overlay` | 40    |
| `drawer`  | 50    |
| `modal`   | 60    |
| `toast`   | 70    |
| `tooltip` | 80    |

### Philosophy

- **Operational predictability:** the receptionist should never wonder which layer “won.” Fixed increments leave room for future intermediate needs without renumbering chaos.
- **Sticky below overlay:** persistent chrome peels under dimmers—not through them.
- **Drawer vs. modal:** prefer drawer for desk work; if a modal exists, it occupies **`modal`** alone, not atop an open drawer (resolve by closing/replacing).
- **Toast above blocking layers:** undo and critical feedback must remain visible, but **Golden Rule still applies**—avoid opening a second blocking layer while toast is resolving actionable state; design flows so one clears the other.
- **Tooltip highest:** ephemeral clarification must not sit under semi-persistent UI.

---

## 6. Responsive Breakpoints

Breakpoints are **min-width** thresholds (mobile-first).

| Token | Min width | Primary devices |
| ----- | --------- | ---------------- |
| `sm`  | 640px     | Large phones, small tablets entering two-column hybrids. |
| `md`  | 768px     | **iPad portrait**, small laptops split-screen. |
| `lg`  | 1024px    | **iPad landscape**, desktop reception station. |
| `xl`  | 1280px    | Wide desktop, second monitor, manager overview. |

### Density adjustments

- **Below `md`:** prioritize **one primary column**; reduce simultaneous chrome; keep the **timeline readable** over accessory panels.
- **`md`–`lg`:** introduce **side-by-side** only when horizontal real estate prevents touch errors; maintain minimum pane widths (see Grid System).
- **`xl`+:** add **visible adjacent context** (more staff rows visible, optional secondary column) rather than shrinking type.

### Information visibility strategy

- Never hide **time or staff identity** to show marketing chrome.
- Secondary metrics (prices, decorative modules) yield before **queue state** and **conflict cues**.
- **Progressive disclosure:** collapse modules by importance bands, not by novelty.

### Module collapse behavior

- Below `md`, **non-core** modules stack vertically. The timeline remains **first-class** (full width available after critical header chrome).
- Optional analytics or owner flourishes collapse earlier than queue/timeline.

### Queue as overlay vs. column

- **`md`+ when “today” context is active:** queue becomes a **dedicated adjacent column** with fixed target width (see Grid System)—spatial memory beats hiding walk-ins.
- **Narrow / non-today views:** queue may **unmount or minimize** so the grid gains horizontal scroll budget; do not imply “today’s waiters” on other dates.

### Dashboard operational layout behavior

- Header band: **sticky-friendly** height discipline—small vertical footprint preserves grid pixels.
- **Desk layout:** timeline + staff grid is the **dominant** region; owner settings remain **relaxed density** (wider spacing, fewer tiles per row).

---

## 7. Grid System

### Philosophical ordering

1. **Timeline dominance:** the horizontal day + vertical staff matrix is the **source of truth** for floor reality.
2. **Queue adjacency:** walk-in pressure stays **visible alongside** the grid when today is active—receptionists cross-reference without mode switching.
3. **Detail on demand:** booking depth opens in a **side panel** pattern that preserves grid context (spatial anchoring beats full-screen context loss).

### Information priority zones (left-to-right on LTR layouts)

1. **Staff identity column** — who is working (names, roles, busy state).
2. **Time rail** — absolute clock truth; drives conflict and scheduling trust.
3. **Booking blocks** — who is in the chair next.
4. **Queue / adjunct panels** — intake pressure, not a second timeline.

### Canonical widths (targets)

These are **design targets** matching current desk implementation intent; engineering may clamp widths against viewport and safe areas.

| Zone                 | Target width | Notes |
| -------------------- | ------------ | ----- |
| Staff column         | **140px**    | Minimum for truncated names + status; avoid narrowing below **128px** usable. |
| Timeline slot        | **64px** per **30-minute** cell | Drives horizontal scroll for full day—expected; do not compress below **56px** or slot touch reliability drops. |
| Queue sidebar        | **352px** target; **384px** max cap | Keeps list readable; on thin viewports use `calc(viewport − gutters)` clamps. |
| Booking detail panel | **480px** max on large screens; **90vw** cap on small | Maintains form readability without obscuring entire grid on tablet. |
| Desk content shell   | **1180px** max width centered | Prevents ultra-wide stretching that harms eye travel; aligns with layout tokens. |

### Minimum usable widths

- **Staff column:** hard floor **128px** before redesign, not before micro-shrinking type to illegible.
- **Queue:** if below **280px** usable inner width, switch pattern (stack above grid or icon-first mode)—never wrap queue names into one character per line.
- **Timeline:** horizontal scroll is **acceptable and expected**; vertical scroll for many staff is secondary to **keeping slot width honest**.

### Overflow behavior

- **Horizontal:** timeline scrolls; **sticky staff column** (if used) stays visible so row identity is never orphan-scrolled away.
- **Vertical:** staff rows scroll together with their grid lines—no decoupled vertical mismatches.
- **No ornamental parallax** on operational scroll.

### Wide-screen behavior

- **Do not** stretch booking blocks to cinematic widths; extra space shows **more time horizon** or **more staff rows**, not fatter blocks.
- Maintain **max shell width** so receptionists on 27" displays are not punished with mile-long eye travel.

### Receptionist efficiency goals

- **Multi-staff visibility:** prioritize showing **more rows** over bigger hero padding.
- **Fast scanning:** align text to columns; avoid centered mystery meat in grids.
- **Conflict surfaces:** errors and warnings interrupt **once**, prominently, at toast/overlay layer—not per-cell carnival lights.

---

*This document is enforceable: if a proposal breaks spacing, type, radius, shadow, stacking, breakpoint, or grid rules here, it must be rejected or amended before shipping.*
