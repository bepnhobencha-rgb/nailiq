# NailIQ — Front Desk Dashboard Layout Rules

**Role:** Architectural contract for the **Receptionist Center** (Front Desk) shell—how the three primary zones behave, reflow, and stay stable under pressure.  
**Audience:** Product, design, engineering.  
**Scope:** Structure, zones, responsiveness, presets, module-driven reflow, scroll behavior, and performance layout expectations.

**Alignment:** Implements the operational intent of `docs/UX_PRINCIPLES.md`, spatial priorities in `docs/DESIGN_SYSTEM.md` (grid philosophy and breakpoint *names* as device classes only), and compositional discipline in `docs/COMPONENT_RULES.md`. Numeric spacing, typography steps, color, motion timing, and implementation are **out of scope** here—those live in their respective system documents or code.

**Product context:** The Front Desk is the highest-stakes surface in NailIQ. Receptionists use it continuously, often while talking to clients and handling interruptions. Layout is **safety equipment**: wrong or unstable layout increases mis-taps, schedule errors, and training cost.

---

## 1. Layout philosophy

### Why layout stability matters operationally

Under rush conditions, staff **parse geometry before they read labels**. If panes jump, collapse unexpectedly, or resize when data arrives, every glance becomes a conscious re-orientation instead of a reflex. That directly competes with **floor-speed** and **trust**: hesitation at the desk often becomes duplicate actions or wrong-row edits.

Stable layout reduces **latency tax**—the cumulative seconds lost when the eye must re-find controls that moved. It also supports **correctness**: the timeline is the source of truth for “who is in the chair when”; the queue is the source of truth for **intake pressure**. Those truths must stay in predictable places.

### Why the three-zone structure is non-negotiable

Three **locked** zones define the Front Desk mental model:

1. **Left — Staff column:** *Who* is working (identity and row anchor).
2. **Center — Timeline booking grid:** *When* things happen (duration-accurate schedule truth).
3. **Right — Queue / Quick Add:** *What is waiting* and *how to add work* without leaving the floor picture.

Splitting these through modes, tabs, or sequential screens forces **working memory** to hold state that the layout should externalize. For reception, **adjacent context** beats depth: walk-ins and assignments are verified against the grid without navigation.

No feature should require **hiding** one of these three zones as the default “today” experience on hardware intended for desk use. Optional overlays, drawers, and narrow-viewport compromises may **temporarily obscure** supporting chrome, but the three-zone **job structure** remains: staff axis + time grid + intake lane.

### Muscle memory and spatial consistency

- **Left-to-right priority** (LTR): staff identity → clock/time truth → bookings → queue/adjunct. Mirror logically for RTL if product supports it; do not rearrange per feature whim.
- **Same job, same real estate:** queue actions and quick add stay in the **right** lane; booking blocks stay in the **center**; staff rows stay **row-locked** to the grid.
- **No surprise relocations:** toggling non-layout modules must not shuffle the three zones’ **roles**—only density, optional bands, or transient overlays.

---

## 2. Three-zone architecture

### LEFT ZONE — Staff column

**Purpose:** Row identity for the timeline—who this horizontal swimlane represents.

**Width constraints (min / max)**

- **Minimum:** The narrowest width that still supports **legible** staff names (with predictable truncation), role or status affordances, and touch-safe row targets per the UX contract. Below this floor, the pattern is wrong—do not compensate by illegible type or stripped identity.
- **Maximum:** A modest fixed upper bound so the column never **consumes** the timeline’s horizontal budget. Identity is compact; the **day horizon** is more valuable than a wide roster gutter.

**Must always show**

- **Staff identity** for each active row (name and consistent avatar/initial treatment per component rules).
- **Row alignment** with the corresponding grid row—no vertical drift between name and cells.
- **Operational signals** tied to the row (e.g. busy/available) when the product exposes them, without crowding out the name.

**Scroll behavior**

- **Vertical:** Staff column scrolls **in lockstep** with the timeline rows for that view—no independent vertical scroll that desynchronizes row mapping.
- **Horizontal:** The staff column does **not** participate in timeline horizontal scrolling; it remains the fixed row index.

**Sticky rules**

- The staff column is **sticky on the leading edge** of the grid during horizontal exploration of the day, so row labels remain visible when the receptionist pans forward in time.
- Stacking order must keep the sticky column **below** blocking overlays (scrims, modals) and consistent with the global elevation policy—labels never visually punch through intentional dimming.

---

### CENTER ZONE — Timeline grid

**Purpose:** Timeboxed truth for the day—bookings, gaps, and conflicts in **spatial** form.

**Width**

- **Fluid:** Occupies **all horizontal space remaining** after the staff column and the queue sidebar (or their narrow-viewport equivalents). This zone is **dominant**; accessory modules yield to it first.

**Horizontal scroll rules**

- Horizontal scrolling is **expected and acceptable** for full-day coverage; compressing slots until the grid lies is worse than scroll.
- **Only the timeline body** (time rails + booking cells) participates in horizontal pan; the staff column stays fixed as the row key.
- Scroll affordances should be obvious enough that low-tech staff do not assume the day **ends** at the first visible hour.

**Time column behavior**

- The **time rail** is the absolute clock reference—always visible **within the horizontally scrolled region** as a first-class column (not an afterthought header that detaches from row truth).
- Slot granularity aligns with product scheduling semantics; **minimum slot width** is governed by touch reliability and scan legibility in the design system grid—it must not be violated to avoid scroll.

**NOW line positioning**

- A **current-time indicator** spans staff rows in the **center zone** at the correct offset for “now” in the salon’s business day context.
- The NOW line is **always meaningful** on “today” views; on historical or future dates, it must **not** pretend to be live-time truth (behavior may dim, hide, or label context per product rules).
- Invoking “jump to now” must bring the NOW position into view **without** collapsing zone roles.

**Booking block overflow rules**

- Blocks are **grid-constrained**: duration maps to width; stacked or overlapping states follow the booking state machine, not arbitrary layout.
- **Text and meta** inside blocks truncate on **predictable** rules—no unstable multi-line growth that reshapes neighbor rows mid-shift.
- **No ornamental parallax** or horizontal effects tied to scroll; operational grids prioritize steady geometry.

---

### RIGHT ZONE — Queue sidebar

**Purpose:** Walk-in / waitlist pressure **adjacent** to the grid, plus **Quick Add** intake without leaving the desk context.

**Width constraints**

- **Target band:** A readable list width that fits **queue rows** (names, status, compact meta) without pathological wrapping; **capped maximum** so ultra-wide monitors don’t turn the queue into a billboard.
- **Hard floor:** If the viewport cannot provide a **usable inner width** for queue content, the product **changes pattern** (e.g. overlay drawer or stacked lane)—never crush queue text into unusable fragments.

**When it collapses (breakpoint)**

- On **tablet portrait** and similarly constrained widths, the right zone may leave **dedicated column** layout in favor of a **reachable overlay** or equivalent pattern—see §4.
- On **tablet landscape** and **desktop** widths, the queue is a **persistent adjacent column** when “today” context is active (per reception-first rules in the design system’s dashboard behavior).

**Collapsed behavior (overlay vs hidden)**

- **Prefer overlay / sheet** with scrim over **silent removal** of queue functionality: the receptionist must always have a **discoverable path** to queue and quick add on narrow widths.
- **Do not** imply “today’s waiters” on dates where queue context is invalid—layout may widen the grid legitimately in those contexts; that is **semantic hiding**, not a collapsed zone cheat.

**Quick Add panel position**

- Quick Add is **anchored to the queue lane** (top of right zone or clearly nested within that stack) so intake and triage share one muscle-memory column.
- Quick Add must not float into the **timeline header** in a way that competes with date/day context or time controls.

---

## 3. Workspace preset layout rules

Presets tune **density and optional chrome**, not the **three-zone identity**. Staff column + timeline + queue structure **remain**; presets change **what extra layers exist** and **how much vertical room** the grid receives.

### Minimal

- **Highest grid vertical share:** suppress optional summary bands and owner flourishes.
- **Queue + Quick Add** remain present (queue is core).
- **Drawers** preferred over new persistent panes for depth.

### Reception

- **Default balanced layout:** standard tool header (date, navigation, undo surface) + three zones at nominal density.
- **Owner analytics** and training aids stay **off** unless separately enabled.

### Rush Hour

- **Timeline and queue win:** optional modules that steal vertical or horizontal scan from booking blocks are **de-prioritized** or collapsed.
- **Larger effective grid**—achieved by hiding accessory rails, not by shrinking the staff column below its minimums.
- **Conflict and mutation feedback** stay prominent at overlay/toast layers—never as per-cell noise spanning the grid.

### Owner

- **Optional KPI or summary band** may appear **above** the grid when enabled—grid **shrinks vertically** but keeps three-column structure.
- **Drill-down** respects drawer-over-grid patterns; no second competing timeline.

### Training

- **Temporary explanatory or guided regions** may occupy **non-sticky margins** or a dedicated callout band that does not obscure NOW, staff names, or first booking column.
- **Preset must be revertible**—trainees should experience the same eventual layout as Reception.

### TV Mode

- **Maximize distant legibility:** increase effective scale of timeline and queue at the expense of secondary modules; avoid dense meta.
- **Touch precision paths** may be reduced—remote or glance use—but the **three-zone map** remains recognizable from across a room.
- **Drawers** may be inappropriate on shared displays; favor **read-mostly** grid with handoff back to Reception preset for edits (product decision boundary).

---

## 4. Responsive behavior

Device classes below are **descriptive** (tablet portrait / landscape, desktop, wide desktop)—not framework tokens.

### Tablet portrait

- **May collapse** the right zone from a **persistent column** to an **overlay / sheet** pattern with explicit open/close affordance.
- **Staff column + timeline** remain **on screen together** whenever possible—timeline dominance over peripheral analytics.
- **Header** stays compact to preserve vertical pixels for the grid.

### Tablet landscape

- **Optimal three-zone** layout: dedicated staff column, fluid center, fixed-width queue column—matches typical desk hardware posture.

### Desktop

- **Default three-zone** horizontal layout as the canonical Front Desk.
- **Center** remains fluid; **staff** and **queue** obey min/max width discipline from §2.

### Wide desktop

- **Extended timeline**—additional **time horizon visible** or more staff rows in view—**not** ultra-wide booking blocks that stretch arbitrarily.
- Respect a **maximum content shell** so eye travel on large monitors does not degrade scan speed (per grid shell intent in the design system).

---

## 5. Module visibility rules (`dashboard_modules` and layout)

Module keys and defaults are product data; layout rules describe **how the shell reacts** when optional modules toggle.

**When `queue_panel` affects layout**

- If queue is **not presented** as a persistent third column in a given viewport or policy edge case, the **center timeline expands horizontally** into the reclaimed width—staff column width is **unchanged**.
- Product may enforce queue always-on in settings; layout logic still assumes **no phantom third column**: if only two columns render, fluid column takes remainder.

**When `kpi_bar` (or equivalent summary band) is on**

- A **top summary band** appears **above** the three-zone row (or above the grid stack), **not** between staff and cells.
- The **grid shrinks vertically** by the band’s height; horizontal three-zone allocation **does not** change.
- **Reflow discipline:** band height must be **pre-reserved** (see §8) so bookings do not jump when KPIs hydrate.

**`quick_add` off**

- Quick Add chrome **hides inside the right lane**; queue list gains space or compresses header stack—**do not** relocate Quick Add to the timeline header.

**Other toggles** (`ai_suggestions`, `revenue_today`, `wait_time`, `alerts`, `vip_indicators`, `staff_performance`, `timeline_heatmap`, etc.)

- **Secondary modules** attach to **non-core gutters**: optional strips above grid, inline queue meta, or bounded overlays—never evict staff names, time rail, or NOW line from default view.
- Turning modules on/off must **not** reorder the three primary zones—only adds/removes **satellite** rows or column internals.

**Avoiding layout “jump”**

- Reserve space for known conditional bands; **animate** only per global animation policy—layout contracts here care about **final geometry stability**, not effect style.

---

## 6. Information hierarchy

### Must always be visible (default desk view, “today”)

- **NOW line** (when today is active and time context applies).
- **Staff names** (or equivalent primary identity) for visible rows—never scrolled away horizontally from their row.
- **Time scale** sufficiently to interpret **which hour column** is under interaction (labels may scroll with grid, but must remain findable—see §7).

### May scroll out of view

- **Historical hours** off-screen left/right in the timeline (by horizontal pan).
- **Staff rows** above/below viewport (by vertical pan) **with** synchronized staff-timeline scroll.
- **Secondary booking meta** inside blocks after primary title/status exceed density.

### Must never be hidden behind unscoped scroll

- **Global desk actions** required every few minutes (date change, queue access on narrow layouts—when queue is overlay, the **invocation control** must remain in a **stable header/tool strip**).
- **Undo / critical mutation feedback** that prevents duplicate commits—must surface at appropriate overlay priority, not only inside a scrolled sub-pane.
- **Staff–row coupling**—never leave booking cells vertically aligned to the wrong name because one pane scrolled independently.

---

## 7. Scrolling rules

### Vertical scroll: full page vs zone-locked

- **Primary operational pattern:** **zone-locked vertical scroll** for the **staff + grid + queue stack**—the body that grows with roster size scrolls as a unit beneath a **compact sticky header** band.
- **Full-page** miscellaneous scroll is acceptable for rare overflow (e.g. training callouts), but **must not** be the default driver for timeline interaction—nested scroll traps cause lost context.

### Horizontal scroll: timeline only

- **Timeline body** (time + cells) scrolls horizontally.
- **Queue** does not horizontally pan with the day except for **internal** narrow lists; queue is not a second timeline.

### Scroll sync rules between zones

- **Vertical:** Staff column and grid rows stay **pixel-aligned**—single scroll owner or rigorously synced equivalents; **forbid** desynchronized row mapping.
- **Horizontal:** Only the center zone’s time/cell region participates; staff column **fixed**.

### Sticky header behavior

- Desk **header** (salon context, date, primary nav/back affordances) remains **sticky top** with minimal vertical footprint.
- **Do not** stack multiple independent sticky bars that **compete** for the same vertical strip without documented priority—one primary sticky operational header.

---

## 8. Performance layout rules

### No layout shift on load

- The shell reserves **final** widths for the three zones before detail data paints—no flash where the queue snaps in after first paint.
- Optional modules (KPI band, alerts strip) reserve **their collapsed or expanded footprint** predictably—no late reflow that moves the row under a finger.

### Skeleton must match exact final layout

- **Placeholder geometry** uses the **same column structure** as loaded state: staff column present, timeline gutter present, queue lane present (or the narrow-viewport overlay **invoker** in the same place).
- **Slot widths** in skeleton match live slot widths—no pseudo-narrow grid that **expands** on hydrate.

### No reflow after data loads

- Booking fetch completion fills cells **inside existing grid geometry**; row count may grow but **column widths and sticky behavior** do not change.
- Realtime updates **mutate content**, not **frame contracts**—avoid re-measuring layout-altering text beyond stable truncation rules.

---

*This document is enforceable for Front Desk layout decisions. Proposals that hide a locked zone by default on intended desk hardware, desynchronize staff–grid scroll, or collapse operational truth into mode switches must be rejected or amended in favor of adjacent, stable three-zone geometry.*

---

## 9. App-shell sidebar navigation

**Scope clarification.** This section governs the **app-shell chrome** that wraps every `/dashboard/[slug]/*` route. It is **not** a fourth zone of the Front Desk three-zone layout in §2 — the sidebar lives **outside** the receptionist center's main content area. Inside that area, the staff column / timeline / queue contract from §2 is unchanged and inviolable.

**Why a sidebar.** The dashboard hosts more than the Front Desk: setup wizards, settings, clients, reports, owner dashboard. A persistent sidebar gives those routes one stable navigation surface and frees the Front Desk header from carrying global navigation responsibilities. Cross-route muscle memory beats per-page nav rows.

### 9.1 Geometry

- **Expanded width:** **240px** (15rem).
- **Collapsed (icon-only) width:** **64px** (4rem).
- **Position:** `fixed` to the leading edge of the viewport on `md` and wider; main content shifts right by exactly the active sidebar width (no layout-shift on collapse — width transitions instantly via CSS variable; bookings inside Front Desk do not re-measure).
- **Z-index:** Below modal scrims, above the page background. Never punches through an active modal/drawer scrim.

### 9.2 Visibility breakpoints

- **`md` (≥ 768px) and wider:** sidebar visible as the persistent left rail. Bottom tab bar hidden.
- **Below `md`:** sidebar hidden. **Bottom tab bar** (5 primary tabs) takes over for primary navigation. Main content reserves bottom padding for the bar (height + iPhone safe area).
- **Tablet portrait** uses the sidebar at expanded width by default; the receptionist may collapse it to reclaim grid horizon when running rush-hour preset.

### 9.3 Color, state, and interaction

- **Sidebar background:** `bg-nq-surface` (= `#111214`, per `COLOR_TOKENS.md` §3).
- **Active item:** `bg-nq-primary/15` + `text-nq-primary` (gold accent on the one item matching `usePathname()`). Pair color with text label so the active state is never hue-only (per `COLOR_TOKENS.md` §7).
- **Hover (non-active):** `bg-nq-surface/80`.
- **Focus-visible:** standard `ring-nq-primary/45` per `COLOR_TOKENS.md`.
- **Disabled (placeholder routes):** `opacity-50`, `cursor-not-allowed`, no anchor — render as a `<span>` so screen readers don't announce a fake link.
- **Touch target:** every nav row `min-h-11` (44 CSS px) per `UX_PRINCIPLES.md` §2 rule 4.

### 9.4 Collapse persistence

Collapse state persists in `localStorage` under the key **`nailiq-sidebar-collapsed`** (`"1"` = collapsed, anything else = expanded). The hook reads on first mount only; switching tabs does not force re-sync (the user's last choice on this device wins). Mobile (where the bar takes over) does not write this key.

### 9.5 Content vs. shell separation

- The sidebar may carry **labels + icons** for cross-route navigation, queue/messages **count badges**, salon switcher, and viewer identity.
- The sidebar **must not** host operational mutation actions (cancel booking, advance status, queue triage). Those stay inside the relevant zone of the Front Desk per §2.
- The sidebar **must not** duplicate the in-page primary CTA. Removing redundant link buttons from `SalonOwnerDashboardMain` after the sidebar lands is required, not optional.

### 9.6 Mobile bottom tab bar

- **Height:** **56px** baseline + iPhone home-indicator safe area (`pb-[env(safe-area-inset-bottom)]`).
- **Tabs (5, fixed order):** Front Desk, Walk-in Queue, Clients, Reports, Settings.
- **Background:** `bg-nq-surface` with a hairline top border `border-nq-border`.
- **Active:** `text-nq-primary`. Inactive: `text-nq-muted`.
- **One-handed reach:** thumb-priority. Any feature that does not fit the 5-tab cap goes into a sub-page reachable from a tab — no overflow menu.

### 9.7 Out of scope for this section

Sidebar visual specifics not enumerated here (icon weight, divider hairline opacity) inherit from `COLOR_TOKENS.md` and `COMPONENT_RULES.md`. Animation timing for the collapse transition follows `ANIMATION_RULES.md` (no inline ms literals).

---
