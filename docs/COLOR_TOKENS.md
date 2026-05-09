# NailIQ — Color Tokens

**Role:** Canonical color specification for production. Operational SaaS, dark-first, reception-desk conditions.  
**Audience:** Product, design, engineering.  
**Scope:** Intent, palette, semantic mappings, status and booking colors, brand gold, enforceable usage rules.  

**Alignment:** Extends the locked values documented in the global stylesheet (`#0B0C10` app background, `#111214` surface, `#FFFFFF` primary text, `#A1A1AA` muted text, `#D4AF37` accent gold). This document does not replace that contract; it names and organizes it for disciplined use.

---

## 1. Design Intent

Color in NailIQ is **instrumentation**, not ornament. The product is used for **long shifts**, under **bright ambient light**, and during **high-stakes moments** when mistakes are socially and economically costly.

**Restraint matters** because every extra hue competes for attention. Surplus color turns the desk into a dashboard of distractions; restraint preserves **scan bandwidth** for people, times, and queue pressure.

**Dark mode requires controlled contrast**, not maximum contrast everywhere. Pure white at full area on deep black creates **halation and fatigue**; sustained use needs stepped neutrals and controlled accents. Contrast spikes are reserved for **meaning**, not decoration.

**Status clarity matters** because “almost right” color reads as “uncertain state” under time pressure. If two operational outcomes look like siblings, the team will slow down or mis-tap.

**Color must reduce thinking** by staying **predictable**: the same family of meanings should read the same way across views. Novelty without operational payoff is rejected.

**Premium does not mean flashy.** Premium here reads as **calm, precise, and trustworthy**—the same signals as serious tools in finance or clinical workflows, adapted for salons. Loud gradients and chromatic noise read as **cheap attention hacking**, not luxury service.

**Tone for this system:** strict, practical, operational.

---

## 2. Base Palette

**Neutral scale (50–950)** — charcoal family, **slightly warm** to pair with gold accent without yellowing the UI. Optimized for **dark UI**: lower steps are usable as background and surface steps; upper steps support readable text and disabled readability. **Not pure black** as the primary app canvas; **not muddy** mids; **not** blue-gray neutrals.

| Step | Hex | Dark-UI role (typical) |
|------|-----|-------------------------|
| 50 | `#F4F4F5` | Rare highlight / inverse-primary text territory |
| 100 | `#E4E4E7` | Strong inverse text on dark; high-importance labels on inverse surfaces |
| 200 | `#C8C9CE` | Secondary text on inverse; strong dividers on light overlays |
| 300 | `#A1A2AA` | Muted-but-readable on dark when paired with weight; near locked muted band |
| 400 | `#86878F` | Icon stroke default on mid surfaces |
| 500 | `#6B6D76` | Disabled-readable text candidate (still paired with reduced weight); borders on subtle controls |
| 600 | `#4A4C54` | Strong structure lines; pressed borders |
| 700 | `#2E3038` | Default hairline neighbor; inset separators |
| 800 | `#1C1D22` | Elevated surface; dense lists |
| 900 | `#121317` | Secondary surface step |
| 950 | `#0B0C10` | **App canvas** (locked brand direction) |

**Locked reference points** (must remain coherent with the neutral scale above):

| Role | Hex |
|------|-----|
| App canvas | `#0B0C10` (= neutral-950) |
| Primary surface | `#111214` (between 900–800; canonical primary surface floor) |
| Primary text | `#FFFFFF` |
| Canonical muted text | `#A1A1AA` (aligns with neutral-300 band) |

**Public / depth navy** (distinct layer for customer-facing glass contexts; **not** the dashboard neutral stack):

| Role | Hex |
|------|-----|
| Navy deep fill | `#0F172A` |
| Navy glass | `rgba(15, 23, 42, 0.58)` |

---

## 3. Semantic Tokens

Mappings below are **meaning-first**. Use the **hex** values; semantic names are the stable product vocabulary.

### Background

| Token | Hex / value | Meaning |
|-------|----------------|---------|
| `background.app` | `#0B0C10` | Full viewport canvas; lowest elevation |
| `background.surface` | `#111214` | Primary working plane for main content regions |
| `background.elevated` | `#1C1D22` | One step above surface (sticky header bands, nested layers) |
| `background.overlay` | `rgba(11, 12, 16, 0.72)` | Scrim over operational context; must preserve depth without whitening the UI |

### Border

| Token | Hex / value | Meaning |
|-------|----------------|---------|
| `border.subtle` | `rgba(255, 255, 255, 0.06)` | Hairlines between similar surfaces |
| `border.default` | `rgba(255, 255, 255, 0.10)` | Standard separation; readable in bright rooms |
| `border.strong` | `rgba(255, 255, 255, 0.16)` | Emphasis dividers; draggable edges |
| `border.focus` | `rgba(212, 175, 55, 0.65)` | Focus ring core color (gold family); always paired with non-color cues where required |

**Gold-tint hairline** (locked accent direction, **sparse**): `rgba(212, 175, 55, 0.18)` — use only when a **luxury edge** is intentional, not for every box.

### Text

| Token | Hex | Meaning |
|-------|-----|---------|
| `text.primary` | `#FFFFFF` | Primary reading and identifiers |
| `text.secondary` | `#E4E4E7` | Emphasized secondary lines |
| `text.muted` | `#A1A1AA` | Metadata, timestamps, helper lines |
| `text.inverse` | `#0B0C10` | Text on gold fills and light inverse compact fills |
| `text.disabled` | `#6B6D76` | De-emphasized but **still legible**; never identical to canvas |

### Interactive

States assume a **default dark control fill** of `#1C1D22` or surface `#111214` depending on density.

| Token | Hex / value | Meaning |
|-------|----------------|---------|
| `interactive.default` | `rgba(255, 255, 255, 0.08)` | Rest border on controls |
| `interactive.hover` | `rgba(255, 255, 255, 0.12)` | Hover border/overlay |
| `interactive.active` | `rgba(255, 255, 255, 0.16)` | Pressed state |
| `interactive.disabled` | `rgba(255, 255, 255, 0.05)` fill + `text.disabled` | Clearly inert |

**Primary affirmative action fill** (locked brand): `#D4AF37` with foreground `text.inverse`. This is **not** a general “interactive default”; it is **high-commitment forward action only**.

---

## 4. Status Colors

Each status ships as a **system**: main, foreground-on-main, subtle background tint, border tint. Use **tints** large; use **main** small (icon shape, keyline stroke, compact indicator).

### Success

| Role | Hex / value |
|------|----------------|
| Main | `#22C55E` |
| Foreground on main | `#0B0C10` |
| Subtle background | `rgba(34, 197, 94, 0.12)` |
| Border tint | `rgba(34, 197, 94, 0.35)` |

### Warning

| Role | Hex / value |
|------|----------------|
| Main | `#D97706` |
| Foreground on main | `#0B0C10` |
| Subtle background | `rgba(217, 119, 6, 0.14)` |
| Border tint | `rgba(217, 119, 6, 0.38)` |

**Note:** This warning is **warm amber**, distinct from brand gold. It signals **operational urgency**, not luxury CTA.

### Danger

| Role | Hex / value |
|------|----------------|
| Main | `#EF4444` |
| Foreground on main | `#FFFFFF` |
| Subtle background | `rgba(239, 68, 68, 0.12)` |
| Border tint | `rgba(239, 68, 68, 0.40)` |

### Info

| Role | Hex / value |
|------|----------------|
| Main | `#3B82F6` |
| Foreground on main | `#FFFFFF` |
| Subtle background | `rgba(59, 130, 246, 0.12)` |
| Border tint | `rgba(59, 130, 246, 0.38)` |

### VIP

| Role | Hex / value |
|------|----------------|
| Main | `#D4AF37` |
| Foreground on main | `#0B0C10` |
| Subtle background | `rgba(212, 175, 55, 0.14)` |
| Border tint | `rgba(212, 175, 55, 0.45)` |

**VIP discipline:** gold reads **metallic calm**, not neon yellow. Pair VIP surfaces with **dark text** and **tight usage**—never flood large fields in saturated gold.

---

## 5. Booking Status Colors

These colors map to **booking states** in the product state machine. The machine itself is defined elsewhere; this section is **visual encoding only**.

**Global rule:** Under pressure, **never rely on hue alone.** Pair color with **label text**, **icon shape**, and **layout position**. Saturation budgets still apply.

| State | Main | Subtle background | Text / foreground | Usage intent |
|-------|------|-------------------|-------------------|--------------|
| `pending` | `#CA8A04` | `rgba(202, 138, 4, 0.14)` | `#FDE68A` | Awaiting confirmation; **cautious optimism**—distinct from operational warning amber |
| `confirmed` | `#3B82F6` | `rgba(59, 130, 246, 0.12)` | `#FFFFFF` | Committed timehold; **cool/trust** |
| `arrived` | `#14B8A6` | `rgba(20, 184, 166, 0.14)` | `#CCFBF1` | On-premise presence; **teal** separates from completed green |
| `waiting` | `#EA580C` | `rgba(234, 88, 12, 0.14)` | `#FFEDD5` | Queue pressure; **orange** reads as “needs motion” vs pending yellow |
| `in_progress` | `#22C55E` | `rgba(34, 197, 94, 0.12)` | `#FFFFFF` | Active chair time; **success green** signals progressive forward motion (chair filled, revenue accruing) |
| `completed` | `#6B6D76` | `rgba(107, 109, 118, 0.16)` | `#FFFFFF` | Closed-success residue; **neutral muted** — low arousal, distinct from `cancelled` slate by being neutral rather than blue-gray |
| `cancelled` | `#64748B` | `rgba(100, 116, 139, 0.14)` | `#E2E8F0` | Terminated/neutralized; **low-arousal slate** |
| `no_show` | `#DC2626` | `rgba(220, 38, 38, 0.14)` | `#FECACA` | Absence with consequence; **deeper red** than generic danger for scan distinction at a glance |
| `late` | `#F59E0B` | `rgba(245, 158, 11, 0.16)` | `#0B0C10` on compact filled indicators; `#FEF3C7` on dark surfaces | Time risk; **bright amber** for **clock visibility** in glare; pair with lateness label |

**Confusion guards:**

- `pending` vs `warning.status`: pending uses **more yellow**; system warning uses **DE amber** (`#D97706`). If both appear adjacent, **enforce text labels**.
- `confirmed` vs `in_service`: blue vs indigo—if indistinguishable in sunlight, **thicken keyline** or add **icon**.
- `completed` vs VIP: completed is **green family only**; VIP is **gold only**.

---

## 6. Brand Color

**Primary brand color:** `#D4AF37` (metallic gold).

### Tints and shades

| Role | Hex |
|------|-----|
| Soft tint (large backgrounds only) | `#F5E6B8` |
| Primary | `#D4AF37` |
| Deep shade (gradient endpoints, borders) | `#8A7318` |
| Controlled hairline / ring | `rgba(212, 175, 55, 0.18)` |

### Usage rules

- Gold is for **trust-forward actions**, **VIP**, **sparse luxury edges**, and **focus affordance**. It is **not** a fill color for wide data surfaces.
- Gold signals **commitment and value**, not generic emphasis. If the message is informational, use **info blue**. If hazardous, use **danger red**.
- Gold must stay **muted in glow**: no high-frequency sparkle language on operational surfaces.
- Pair gold fills with **`text.inverse`** for readable lockup.

**Banned brand reads:** neon yellow, children’s-app playfulness, casino jackpots, “flash sale” urgency, rainbow gradients on operational chrome.

---

## 7. Usage Rules

### When to use color

- Communicate **outcome** (success, failure, risk).
- Communicate **progress** in a workflow (booking state, queue urgency tier).
- Mark **VIP** value tier without implying completion.
- Provide **focus** and **selection** (single accent per focal region).

### When to avoid color

- Purely decorative backgrounds.
- Multiple saturated families competing in one **glance band** (e.g., one dense operational row).
- Replacing **typographic hierarchy** or **spacing grouping**.
- “Making it pop” without operational reason.

### Meaning, not decoration

**Every strong chroma choice must answer:** What mistake does this prevent? What decision does this speed up? If there is no answer, use neutrals.

### Never color-only differentiation

For operational outcomes and booking states: **text label + color** minimum; **icon** where space allows. Patterns must remain distinguishable in **sunlight** and for **color-uncertain vision**.

### Saturation budget

- **One** dominant accent region per viewport section (adjacent layout regions may diverge only when their operational states differ).
- Avoid **more than three** saturated hues visible in a single dense row; prioritize state and hazard colors over decorative accents.

### Dark mode contrast minimums

- **Body text** vs local background: target **WCAG AA** minimum **4.5:1** for normal text; prefer higher for **`text.muted`** when used for operational data, not fluff.
- **UI components and graphics**: **3:1** minimum against adjacent colors for non-text essential boundaries (AA for UI components).
- **Focus**: visible against both `background.surface` and `background.elevated`.

### Bright salon environment

Assume **glare**, **reflection**, and **warm overhead lighting**. Test implied lightness: **raise border.default** confidence before pumping saturation; prefer **stronger keylines** over louder fills.

### Long-session eye fatigue

- Limit **full-white large fields** adjacent to **true-black** illusions; keep large areas on **surface/elevated** neutrals.
- Prefer **tinted status backgrounds** over neon fills for persistent status highlights.
- Muted text must stay **readable**, not **disappearing**.

### Destructive vs brand

**Destructive actions never use brand gold** as the primary signal. Use **danger** family. Gold may appear only in **neutral chrome** (non-destructive).

### Success vs VIP

**Success is green** (`#22C55E` family). **VIP is gold** (`#D4AF37` family). Do not substitute one for the other.

### Warning vs pending

**System warning** (`#D97706`) and **booking pending** (`#CA8A04`) must not be **interchangeable without labels**. If both appear, differentiate with **iconography** and **copy**.

### Disabled readability

Disabled elements must read as **inactive** but still **parseable** (labels remain understandable at a glance). Do not collapse disabled text into the canvas color.

---

*This document is enforceable: proposals that introduce ornamental palettes, hue-only encoding, or gold in destructive semantics must be rejected or amended before shipping.*
