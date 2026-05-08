# NailIQ — Component Rules (Governance)

**Role:** Operational contract for every UI component.  
**Audience:** Engineering (human and AI-assisted), design, product.  
**Scope:** Philosophy, reuse order, inventory contracts, composition, creation gates, naming, accessibility, animation policy.  

**Out of scope here:** Color definitions (`COLOR_TOKENS.md`), spacing and typography (`DESIGN_SYSTEM.md`), motion timing and easing values (`ANIMATION_RULES.md`).

**Read before:** creating, modifying, extending, or inventing UI primitives.

**Product context:** NailIQ is **operational software**—receptionist-first, touch-first, dark-mode primary, used under **pressure** and interruption. This is **not** a generic component library. The system optimizes **predictability**, **reuse**, **scan speed**, **operational consistency**, and **low cognitive load**.

**Violation cost:** inconsistent UI, duplicated logic, operational confusion, and long-term refactor debt.

---

## 1. Component philosophy

### Why a shared component system exists

Shared components are **floor infrastructure**: they encode how staff complete work **safely**, **quickly**, and **the same way** every shift. They are not a catalog for one-off experimentation.

### Why consistency matters operationally

Under rush conditions, users **infer** location and affordance from **learned repetition**. Divergent controls increase **mis-taps**, **double submissions**, **hesitation**, and **training burden**. Operational consistency is a **risk control**.

### Why AI-assisted development increases duplication risk

Accelerated authoring favors **locally optimal** snippets: similar buttons, cards, or overlays recreated with minor drift. Without this contract, **duplication compounds** silently and normalization becomes expensive.

### Why uncontrolled variants destroy UI consistency

Each variant multiplies **state combinations**, **test surface**, and **cognitive mappings** (“Which button applies here?”). Variants without a documented job become **semantic noise** and undermine scan speed.

### Why primitives must stay stable

Upstream features compose on primitives; **changing primitive contracts** fractures the product tree. Primitive APIs evolve **narrowly** and **deliberately**—never as a dumping ground for screen-specific quirks.

### Mandatory decision order

The only acceptable sequence:

1. **REUSE** — Use an existing component as documented.
2. **EXTEND** — Add a **documented** variant or prop **only** if it preserves one clear semantic job.
3. **CREATE NEW** — Only when reuse and composition are exhausted **and** the checklist in §4 passes.

Creating a new component is the **last** option—not the default shortcut.

### Failure modes this order prevents

| Failure | Effect |
| -------- | ------ |
| **Duplicate patterns** | Same job, different interaction; bugs fixed in one place only. |
| **Component drift** | Visually similar controls behave differently under stress. |
| **Variant explosion** | Unbounded prop matrices; QA and comprehension collapse. |
| **Operational inconsistency** | Training doc ≠ product; reception throughput drops. |

**Tone enforcement:** Prefer **fewer**, **clearer** building blocks over breadth. If a proposal reads like a component-library textbook demo, reject it unless it survives the operational framing in `docs/UX_PRINCIPLES.md`.

---

## 2. Shared component inventory

**Global rules for every listed component:**

- **Purpose is singular.** Do not grow a primitive until it absorbs unrelated jobs (no “Swiss Army knife” surfaces).
- **States are explicit** where users depend on outcome (saved, failed, busy, immutable).
- **Touch:** primary interactive zones meet or exceed **44×44 CSS pixels** on touch paths (aligned with UX principles).
- **Low-tech usability:** Prefer **visible labels** for critical outcomes; icon-only chrome requires an **accessible name** and operational justification.
- **Pressure usability:** Feedback must arrive **without** burying truth behind extra taps or nested depth.

Below: **purpose (one sentence)**, variants, sizes, states, interaction, touch, do / do-not, problems solved, **when to use / when not**.

---

### Button

**Purpose:** Execute a discrete, intentional action with clear commitment level.

**Allowed variants:** `primary`, `secondary`, `ghost`, `danger`.  
No additional variants without design-system amendment and inventory update.

**Allowed sizes:** `sm`, `md`, `lg`.

**Required states:**

- Default, hover/focus-visible, active (pressed), disabled, loading (`loading` as the authoritative busy state), focus ring behavior consistent with accessibility contract (§6).

**Interaction behavior:**

- One primary affirmative action per focused surface where possible (`docs/UX_PRINCIPLES.md`).
- Loading **implies** disabled; do not trigger duplicate submissions.
- Destructive flows use **`danger`**; never repurpose affirmative styling for destructive semantics.

**Touch target:** Meeting minimum height per size tier; full-width stacking permitted on narrow viewports where it prevents miss-taps.

**Do:** Use for form submits, confirmations, and explicit destructive commits. Pair **Cancel** (typically `ghost`) **left**, primary **right** on modal/drawer footers where that pattern applies.

**Do NOT:**

- Invent one-off styled `<button>` for form actions
- Duplicate spinners outside `Button`
- Bypass `loading` for async work

**Problem solved:** Reliable, reachable commitment control under interruption.

**When to use:** Any confirmed mutation, navigational commitment, or irreversible choice.

**When NOT to use:**

- Pure navigation that is not submission-like
- Inline icon-only toolbar controls without label policy
- Textual links that should read as lightweight navigation (different pattern—not a fake button)

---

### Card

**Purpose:** Group related content within a bounded, readable region.

**Allowed variants:** **Structural only** via composition (header/body/footer slots)—not cosmetic variant sprawl. If a second visual “genre” appears, escalate to primitive vs feature decision (§4).

**Allowed sizes:** **Content-driven**—no unrelated size enum unless documented as a semantic choice (e.g. dashboard tile vs setup panel).

**Required states:**

- Default; optional **selected** only if selection is real state, not decoration.

**Interaction behavior:**

- Interactive cards must behave like **one predictable target** or expose **explicit sub-controls**—never ambiguous “whole card clickable” alongside nested inputs without clear hierarchy.

**Touch target:** Targets inside cards inherit per-control rules; the card shell is not a substitute for adequate child targets.

**Do:** Hold summaries, grouped fields, onboarding panels consistent with spatial rhythm in `DESIGN_SYSTEM.md`.

**Do NOT:**

- Nest blocking overlays
- Embed unrelated analytics blocks into reception-critical cards
- Stack multiple competing primary actions inside one card without hierarchy

**Problem solved:** Chunking information for scan and grouping without scattering chrome.

**When to use:** Settings sections, summaries, bounded forms, marketing shells where explicitly in scope.

**When NOT to use:**

- Timeline cells that are not informational “cards”—use booking/queue primitives
- Anything that becomes a dumping ground for mixed unrelated modules

---

### Modal

**Purpose:** Block peripheral context briefly for **short** decisions requiring explicit confirmation or unavoidable focus.

**Allowed variants:** **Semantic**, not stylistic—for example **confirm**, **destructive confirm**, **short form**—each maps to documented layout shells, not arbitrary styling forks.

**Allowed sizes:** Bounded **small-to-medium** operational widths; large explorations belong in drawers or routed views.

**Required states:**

- Open/closed, focus trap active while open, **Escape** dismiss policy consistent with destructive risk, primary action disabled while async `loading`, error surfaced without dismissing silently.

**Interaction behavior:**

- **Single blocking layer.** Opening another modal over an open modal is **prohibited** (composition rules §3).
- Primary action aligns with **`Button`** semantics; destructive confirms require explicit copy and **`danger`**.

**Touch target:** Footer actions meet touch minimums; avoid dense multi-column forms in modals on desk unless tested on target hardware.

**Do:**

- Interrupt once for irreversible or rare configuration choices
- Keep copy short; expose outcome and next step
- Route focus into modal on open; restore on close per §6

**Do NOT:**

- Host long operational workflows
- Embed nested overlays
- Use modals where a drawer preserves desk spatial context (`docs/UX_PRINCIPLES.md`)

**Problem solved:** Force attention for high-risk or blocking choices without navigation churn.

**When to use:** Confirmations, short auth/demo gates, unavoidable blocking notices.

**When NOT to use:**

- Booking detail review
- Timelines
- Queue triage
- Repeated hourly tasks better served by drawers/panels

---

### Drawer

**Purpose:** Present **extended operational context** while preserving sense of place on the underlying desk surface.

**Allowed variants:** **Anchoring edge** (e.g. trailing for LTR desks) documented per surface; **not** arbitrary placement enums per screen.

**Allowed sizes:** Clamp to viewport and design-system targets for desk panes—no ad-hoc free resizing unless productized.

**Required states:**

- Open/closed, **scrim** behavior, scroll isolation, sticky footer/tool regions if documented, **`loading`** on primary actions via **`Button`**, error visible without losing model context.

**Interaction behavior:**

- **Replace** conflicting overlays—never stack with modal (§3).
- Close affordance always discoverable; back gesture must not conflict with destructive defaults.

**Touch target:** Footer actions and frequent chips meet minimums; avoid precision drag as the only path for common actions.

**Do:**

- Booking detail, editable fields, lists that reference the grid/queue anchor
- Operational “drill-in” on desk

**Do NOT:**

- Mount a second drawer over the first for the same task chain
- Hide destructive actions only in fine-print footers

**Problem solved:** Deep context without ripping the user out of the floor picture.

**When to use:** Detail-and-edit workflows adjacent to timelines or queues.

**When NOT to use:**

- Tiny yes/no confirmations
- One-line alerts—toasts/lightweight confirmations

---

### Badge

**Purpose:** Compress **labeled status metadata** inline without implying a commitment action.

**Allowed variants:** `default`, `success`, `danger`, `muted`.

**Allowed sizes:** Single compact tier; escalate to richer component if “badge” wants paragraphs.

**Required states:**

- Default; **`selected`** not standard—selection belongs to list/toggle primitives.

**Interaction behavior:**

- **Non-interactive** by default. If clickable, it must be **upgraded** to **button** semantics with explicit contract—do not fake interactivity on `<span>` without keyboard parity.

**Touch target:** If made interactive, meet **44×44** minimum or expand hit region invisibly.

**Do:**

- Status labels, counts, lightweight qualifiers
- Pair with text—never rely on hue alone for operational meaning (`COLOR_TOKENS.md` intent)

**Do NOT:**

- Use as page title
- Stand in for **Button**
- Encode booking lifecycle alone without accompanying label where principles require

**Problem solved:** Fast status scan in dense rows.

**When to use:** Secondary labels adjacent to names, services, or timestamps.

**When NOT to use:**

- Primary call to action
- Large narrative blocks

---

### Toggle

**Purpose:** Flip a **binary on/off setting** with immediate clarity of current state.

**Allowed variants:** **On/off** semantic only—not tri-state disguised as binary without explicit mixed/indeterminate handling.

**Allowed sizes:** **`sm`** and **`md`** at most unless touch testing warrants one documented desk size.

**Required states:**

- On, off, disabled, **`loading`** when change is async (control frozen or skeleton—pick one documented pattern).

**Interaction behavior:**

- State change follows predictable directionality; prefers **immediate** optimistic feedback **only** with rollback surfaced on failure.
- Must not silently fail.

**Touch target:** Entire control meets **44×44** inclusive of label hit region where paired.

**Do:**

- Pair with visible **`label`** and optional terse helper for low-tech clarity
- Use native semantics (`role="switch"`, checked state) when applicable

**Do NOT:**

- Hide critical payroll/legal toggles behind icon-only rows
- Use toggle for mutually exclusive navigation (that is segmented control/routing—not toggle)

**Problem solved:** Fast binary configuration without modal overhead.

**When to use:** Feature flags exposed to salons, preferences, pause/resume class switches.

**When NOT to use:**

- Multi-option choice
- Destructive commit (needs confirm + **Button**)

---

### KPIWidget

**Purpose:** Surface **one** high-signal metric with label context for owner/overview scanning.

**Allowed variants:** **Trend hint** (`up` | `down` | `flat` | none) **only** if encoded without decorative noise—never as chart substitute.

**Allowed sizes:** **`compact`** (dense dashboard band) and **`standard`** overview—two tiers maximum unless PM extends inventory.

**Required states:**

- Default, **loading** (skeleton or explicit busy), **error** (recover/retry hint), optional **empty** when data legitimately absent.

**Interaction behavior:**

- Mostly read-only; if drill-down exists, single obvious tap target—not the entire widget unless contract says so consistently across all KPIs.

**Touch target:** Drill affordance meets minimums; no “hover-only” disclosure on touch paths.

**Do:**

- One number + one label + optional micro context
- Language aligned with reception terms

**Do NOT:**

- Pack multiple unrelated metrics into one widget
- Embed sparkline galleries by default
- Flood with brand accent

**Problem solved:** Owners grasp **today** without entering configuration depth.

**When to use:** Dashboard summaries answering “how are we doing right now?”

**When NOT to use:**

- Receptionist throughput surfaces
- Desk timeline decoration

---

### QueueChip

**Purpose:** Represent **one walk-in or queue participant** compactly for reorder, scan, and status glance.

**Allowed variants:** **Urgency or state** tiers documented with **copy + color**, not hue alone (`COLOR_TOKENS.md` pairing intent).

**Allowed sizes:** **Single compact tier**—density is contractual; escalation breaks queue scan.

**Required states:**

- Default, **selected/active** row, disabled when action not allowed, **error** on failed transition (inline, not silent).

**Interaction behavior:**

- Primary actions (check-in, cancel, assign) must not require precision gestures; drag-to-reorder—if present—must have non-drag fallback where feasible.

**Touch target:** Row/chip hit areas meet desk minimums; neighboring rows must not create ambiguous overlap.

**Do:**

- Keep text truncatable predictably
- Maintain **compact** discipline

**Do NOT:**

- Embed forms
- Expand into timeline detail
- Inline unrelated KPIs or storytelling paragraphs

**Problem solved:** Walk-in pressure visible and actionable without stealing grid focus.

**When to use:** Queue columns, compact waitlists, staff assignment lists at desk density.

**When NOT to use:**

- Full booking editor
- Client marketing tiles

---

### BookingCard

**Purpose:** Encode **one scheduled appointment slice** within the timeline grid—who, when span, status, at-a-glance.

**Allowed variants:** **Status visual treatment** strictly aligned to booking state machine semantics (`COLOR_TOKENS.md` booking section intent)—no ad-hoc palette forks per screen.

**Allowed sizes:** **Grid-cell constrained**—height/width dictated by slot geometry, not freeform “cards.”

**Required states:**

- Default, hover/active for precision pointers only if desktop secondary, **selected** when detail drawer/route targets this booking, **disabled**/`loading` proxies when mutation in flight mirrors row state machine.

**Interaction behavior:**

- Tap opens **`Drawer`** detail pattern for desk—not nested modals. Conflicts/errors bubble per central patterns (toast/detail), not per-cell carnivals (`docs/UX_PRINCIPLES.md`).

**Touch target:** Cell must satisfy minimum interactive region or expand hit-testing—slot grids must not rely on hairline taps.

**Do:**

- Maintain **spatial truth** matching schedule duration
- Show client/service/staff cues per scan priority

**Do NOT:**

- Host analytics
- Embed payment capture
- Hide destructive controls only in latent menus without label policy

**Problem solved:** Timeboxed truth on the timeline—foundation of scheduling trust.

**When to use:** Staff timeline grids, day views with duration-accurate blocks.

**When NOT to use:**

- Marketing carousels
- Table-style reporting rows unrelated to time geometry

---

### StaffAvatar

**Purpose:** Identify **staff** at row or chip scale with recognizable marker when photo absent.

**Allowed variants:** **Photo**, **initials fallback**, **`busy`/presence overlay** variants **only** if meaning is standardized app-wide—no decorative rings.

**Allowed sizes:** **`sm`** (dense grid), **`md`** (lists), **`lg`** (profile headers)—three stops maximum.

**Required states:**

- Default, inactive/disabled roster member, **`busy`** concurrent state if productized, **`error`** broken image fallback to initials.

**Interaction behavior:**

- Non-interactive in grid unless opening staff-specific actions—a tap must not surprise; prefer row-level consistency.

**Touch target:** If interactive wrapper exists, meets **44×44** inclusive padding.

**Do:**

- Stable mapping name ↔ avatar across views
- Plain fallback when images fail

**Do NOT:**

- Animate distractingly
- Use avatar as lone channel for hazardous status
- Encode booking state on avatar—it belongs on **BookingCard**

**Problem solved:** Instant **who** recognition parallel to timeline.

**When to use:** Staff axis, assignments, mentions in operational lists.

**When NOT to use:**

- Customer-facing booking marketing hero
- Client profile (different identity rules)

---

## 3. Composition rules

### How components combine

- **Layouts compose primitives**—pages do not re-style primitives wholesale.
- **Operational flows** favor **Drawer + Button** over **Modal + custom chrome** for repetitive desk tasks (`docs/UX_PRINCIPLES.md`).

### Allowed nesting examples

- **Drawer** contains **Cards** for grouped sections (**Card** holds static grouping; **`Button`** in footer executes).
- **`QueueChip`** rows may expose **`Badge`** metadata.
- **`BookingCard`** may carry **`Badge`** for secondary flags only when it does not obscure status semantics.

### Hierarchy rules

- **One focal blocking layer:** scrim-backed **Modal** **or** **Drawer**, not both for the same user intent chain.
- **Primary CTA cardinality:** respect **One action = one primary CTA** at the focal level (`docs/UX_PRINCIPLES.md`).
- **Information hierarchy:** timeline and queue trump accessory analytics visibility—do not bury **BookingCard** / **QueueChip** scan behind embellishment (`DESIGN_SYSTEM.md` intent).

### Structural consistency rules

- **BookingCard** does **not** embed unrelated analytics modules, cross-sells, or owner KPI streams.
- **QueueChip** stays **compact**—no expandable essay; open detail surfaces instead.
- **Card** avoids hosting another **Modal** launcher as its main affordance unless documentedly exceptional—prefer escalating to Drawer/route.

### Information density rules

- **Operational bands** stay compact per design-system density bands; relaxed spacing is for settings/setup, not timeline chrome.
- **Two-line preference** caps for **`QueueChip`** primary text unless expanded mode is explicitly a new primitive (§4).

### Operational readability rules

- Stable column alignment beats centered ornament.
- **Badge** / **BookingCard** status must pair **text** where principles demand—not color-alone.

### Nesting depth guidance

- Prefer **maximum two** levels of actionable nesting inside a Drawer body (containers + controls)—deeper chains imply a **missing route or step decomposition**.

### Explicit prohibitions

- **Popup stacking:** no modal-on-modal; no Drawer-on-modal for the same task; no duplicated scrims controlling competing layers.
- **Recursive overlays:** a surface opened from an overlay must **replace** or **close** the prior blocker—never accumulate.
- **Deeply nested interaction flows:** multi-step dialogs inside drawers inside modals—the default answer is **restructure**.

---

## 4. Creation rules

### Exact allowance

Creating a **new component file** is allowed **only if all** mandatory checks below pass **and** the change is anchored in **`docs/UX_PRINCIPLES.md`** / **`DESIGN_SYSTEM.md`** alignment.

### Mandatory checklist (all must be “yes”)

1. **`src/components/ui/`** Does an existing primitive or sibling already encode this interaction pattern?
2. **Variant** Can an existing component absorb this as a **documented** variant without breaking singularity of purpose?
3. **Composition** Can composition of existing inventory (§2) solve it without a new file?
4. **Reusable primitive** Is this truly cross-feature—or is it a one-screen special?
5. **Approval** Has **PM/design** signed off on a **new primitive** or new **feature component** class when the former is not justified?

If any item is “no,” **stop**—return to REUSE or EXTEND.

### Primitive vs feature component

| Type | Definition | Home |
| ---- | ----------- | ---- |
| **Primitive** | Single semantic job, app-wide stability, minimal domain nouns | Typically `src/components/ui/` after checklist |
| **Feature component** | Encodes domain workflow (receptionist, booking, setup) | Feature folder; composes primitives; **not** a dumping ground for copy-paste UI |

### Reusable vs one-off UI

- **Reusable:** appears or will appear in **two** distinct routes/flows with the **same** semantics.
- **One-off UI:** single occurrence—**inline in the page** until a second use proves extraction.

### Strong discouragement (default reject)

- **One-screen-only primitives** masquerading as shared UI
- **Duplicated wrappers** that differ only in padding or title text
- **Cosmetic-only variants** (visual skins without semantic or operational difference)

---

## 5. Naming conventions

### File naming

- React components: **`PascalCase.tsx`**
- Non-component modules: **`camelCase.ts`** (helpers only—**not** alternate component naming)

### Export naming

- **`PascalCase`** export matching file primary component
- **Model/prop types** suffixed: `SomethingProps`, `SomethingModel` where pattern already exists in codebase

### Prop naming

- **Variants:** `variant="primary"` (string union—no magic numbers)
- **Sizes:** `size="md"`
- **Booleans:** `isLoading`, `isDisabled`, `isOpen` ( **`is*`** prefix for clarity )
- **Handlers:** `onOpenChange`, `onClose`, `onSubmit`—**`on*`** + verb
- **Controlled patterns:** mirror Radix-style `open` + `onOpenChange` when applicable for overlays

### Event naming

- Prefer **`onActionName`** describing user outcome, not DOM implementation detail alone.

### Variant naming

- **Semantic** names (`primary`, `danger`, `muted`)—not theme flavor names (`sunset`, `fancy`).

### Consistency and readability

- **One concept → one prop name** across components (`loading` vs `isLoading`: pick one family per component; do not mix in the same surface).
- **Operational clarity** beats cleverness: if a receptionist trainer cannot say the name aloud, rename it.

### Avoid

- Ambiguous props (`type`, `mode` without enum discipline)
- Visually encoded prop values that encode design tokens in names
- Inconsistent disabled semantics (`disabled` vs `isReadOnly` confusion)

---

## 6. Accessibility requirements

This section is the **minimum contract**; legal or regional standards may demand more—**exceed** this baseline when required.

### Global

- **Keyboard:** All interactive inventory reachable in **meaningful tab order** matching visual reading order on operational surfaces.
- **Focus visibility:** Focus states are perceptible against app **surface** and **elevated** backgrounds—color specifics live in **`COLOR_TOKENS.md`**; here the rule is **non-negotiable visibility**.
- **aria-label:** Icon-only operational controls expose **accessible names**; destructive actions include **risk** in name or immediately adjacent text strategy.
- **Touch targets:** **44×44 CSS px** minimum for touch paths; overlaps forbidden when they cause ambiguity under gloves / nail length constraints.
- **Screen readers:** Live regions for async outcomes where silence would mislead (save failures, mutation errors)—do not rely on color flash alone.
- **Disabled clarity:** **`disabled`** controls remain **parseable**; never remove labels or collapse into background undifferentiated blobs.
- **Contrast:** Operational text meets intent in **`COLOR_TOKENS.md`** and **`DESIGN_SYSTEM.md`**; verify under glare assumptions.

### Overlays (**Modal**, **Drawer**)

- **Modal focus trap:** While open, **tab cycles within** modal; backdrop inert except explicit close/scrim behavior.
- **Drawer focus:** Focus moves into drawer on open; on close **returns** to invoking element **or** the next sensible focus owner if invoking element unmounted—**no lost focus**.
- **Escape:** **Escape** closes **non-destructive** overlays by default; destructive closes require explicit low-friction acknowledgment path—never strand with no undo.
- **Scroll:** Background scroll locking policy must be intentional; avoid scroll chaining confusion on touchpads.

### Motion sensitivity

- Honor **`prefers-reduced-motion`** at product level (`docs/UX_PRINCIPLES.md`); primitives must not rely on motion to communicate essential state **alone**.

### Operational usability extensions

Software must remain usable:

- Under **acute time pressure**
- With **hands impaired** by salon work (**larger targets**, forgiving spacing per **`DESIGN_SYSTEM.md`**—not redefined here)
- On **touch-first** reception hardware
- By **low-tech staff** (**plain copy**, repeatable patterns—not clever UI)

---

## 7. Animation contract

### Source of truth

- All durations, easing curves, distances, and spring parameters **must** follow **`ANIMATION_RULES.md`**.
- **No inline motion constants** inside components unless **`ANIMATION_RULES.md`** explicitly authorizes shared tokens—as a rule: **consume the shared contract**, do not duplicate numbers.

### Engine

- **Framer Motion** is the sanctioned animation layer for transitional UI semantics requiring programmatic control.
- **CSS keyframes** **must not** drive **interaction-critical** behaviors (entrances tied to unblock, dismissal tied to undo timing). Reserve CSS motion for benign, non-blocking flourishes **only if** **`ANIMATION_RULES.md`** allows—when in doubt, **omit**.

### Emotional profile

Motion is **calm** and **fast**—supports comprehension, never competes with the task. Avoid bounce, elastic exaggeration, or playful overshoot unless **`ANIMATION_RULES.md`** carves an explicit rare exception.

### When motion is allowed

- Spatial continuity (drawer/sheet enter/exit) **without** delaying **first interaction**
- Skeleton ↔ content crossfade conveying **progress**
- Subtle positional reinforcement that clarifies hierarchy—**never** delaying confirm actions

### When motion must be avoided

- **Decorative loops** unrelated to task state
- **Mandatory waits** artificially lengthened for delight
- **Blocking animations** ahead of confirming dangerous operations

### Operational interruption rules

- If receptionist invokes a second tap because motion obscured readiness, **the motion failed**.
- Reduced-motion users must perceive **immediate** semantic change—no gated truth behind animation completion.

---

*This document is enforceable governance. Cursor and Claude Code must treat it as a gate, not suggestions. Proposals violating reuse order, stacking rules, naming, accessibility minima, or animation sourcing must not ship.*
