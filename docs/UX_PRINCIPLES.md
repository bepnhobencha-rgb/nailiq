# NailIQ — UX Principles

Operational SaaS for nail salons in Canada. Primary use: **reception counter** on **iPad and desktop** during live service. This document is the UX contract for product and engineering decisions—**principles only**, no implementation detail.

---

## 1. Core philosophy

NailIQ must feel **calm, direct, and dependable** under real salon conditions: noise, interruptions, and simultaneous walk-ins.

- **Operational first:** The product is a **tool**, not a showcase. Clarity and predictability beat novelty.
- **Floor-speed:** A receptionist should complete frequent tasks with **minimal steps** and **no guesswork**.
- **Trust through feedback:** State changes (saved, failed, waiting) are **explicit**; the system never feels silent or “stuck.”
- **Professional restraint:** Visual design supports **task success**—it does not compete with the work on the floor.

---

## 2. NailIQ Golden Rules (non-negotiable)

1. **One action = one primary CTA** — Each screen or step has a single obvious next action. Secondary actions are visually and cognitively subordinate.
2. **Reception flow first, always** — Desk workflows (queue, timeline, booking detail, quick add) take precedence over owner analytics, marketing polish, or edge-case elegance.
3. **No decorative animation** — Motion is allowed only when it **communicates state** (e.g. loading, transition between two meaningful views). No motion for atmosphere.
4. **Large touch targets only (min 44px)** — All primary interactive controls meet or exceed **44×44 CSS pixels** on touch surfaces. Dense “desktop-only” hit areas are not acceptable at the desk.
5. **Information hierarchy > beauty** — Scannability, labels, grouping, and consistent placement win over visual flourish.
6. **Fast under pressure** — Interactions must feel **immediate** at busy times; avoid flows that require precision, tiny controls, or multi-step navigation for common tasks.
7. **Every screen usable by low-tech staff** — Copy is plain; patterns repeat across the app; no reliance on hidden gestures or expert knowledge.
8. **No hidden critical actions** — Check-in, status changes, cancel, save, and “go back” must not live only in overflow menus, long-press, or undiscoverable icons without labels where space allows.
9. **Zero popup stacking** — Do not open a modal on top of a modal (or equivalent). Resolve depth with **one** overlay layer or **replace** the current surface.
10. **Drawer > modal for operations** — Prefer **side drawers / panels** for operational context (booking details, edits, lists) so the desk retains **spatial context** of the grid or queue.
11. **Performance budget** — Under **100 ms** perceived response for primary taps and toggles; under **1 s** to usable content after navigation; **60 fps** scrolling on timeline and queue surfaces.

---

## 3. What NailIQ must NEVER feel like

- **A marketing site** — No hero-first layouts, scroll storytelling, or “impressive” empty chrome in logged-in tools.
- **A game or toy** — No celebratory distractions during core workflows; delights must not interrupt service.
- **A puzzle** — No cryptic icons-only chrome for critical paths; no “figure out where it moved” redesigns without migration affordances.
- **Fragile or laggy** — No jank scroll, hesitant buttons, or ambiguous loading that forces double-taps and duplicate bookings.
- **Overbuilt admin software** — No dense tables-as-default for front-desk tasks; no configuration-first screens blocking the queue.

---

## 4. User personas

### Receptionist (primary)

- **Context:** Standing or leaning at counter; **touch** use; multitasking with clients and phones.
- **Goals:** Move the queue, seat clients, resolve conflicts, take walk-ins, reschedule without drama.
- **Constraints:** Variable digital literacy; high time pressure; errors are socially costly (angry clients, double books).
- **Design bias:** **Bigger targets, fewer modals, obvious labels, one clear next step.**

### Salon owner (secondary)

- **Context:** Checks performance between appointments or off-hours; mixes phone and laptop.
- **Goals:** Confidence in **today**, revenue and utilization, staff and policy control, fewer fires.
- **Constraints:** Interrupted schedule; wants **summaries** and **drill-down** without mastering a complex app.
- **Design bias:** **High-signal metrics**, short paths to actions that affect operations, parity with reception reality (same terms, same statuses).

### Nail tech

- **Context:** Moves between stations; may glance at schedule or assignment.
- **Goals:** Know **who’s next**, appointment length, and service expectations; minimize admin.
- **Constraints:** Hands busy; limited patience for navigation.
- **Design bias:** **Read-heavy, glanceable** views; minimal required input; avoids tech support burden on receptionists.

---

## 5. Decision framework (conflict resolution)

When tradeoffs collide, apply in **this order**:

1. **Safety and correctness** — Prevent double bookings, ambiguous states, and destructive mistakes.
2. **Reception throughput** — Favor what keeps the desk moving today.
3. **Clarity** — Reduce cognitive load before visual refinement.
4. **Speed vs beauty → speed** — Choose faster comprehension and interaction over ornamental layout.
5. **Consistency vs novelty → consistency** — Reuse patterns; novelty must earn its cost.
6. **Depth vs breadth → depth on core flows** — Perfect the handful of hourly tasks before expanding peripheral features.

If still stuck: **simulate a Friday 5:45 PM rush** — the winning option is the one that stays usable when the salon is noisy and the receptionist is alone.

---

## 6. Accessibility baseline

- **Keyboard** — Operational surfaces remain **logically reachable** without a mouse where feasible; focus order matches reading order.
- **Contrast** — Text and icons meet readable contrast for **busy, bright** environments—not only technical minimums but **visual clarity under glare**.
- **Motion** — Respect **prefers-reduced-motion**; Golden Rule “no decorative animation” already limits motion noise.
- **Targets** — **44px minimum** on touch aligns with ergonomic and accessibility expectations.
- **Labels** — Prefer visible text for critical actions; use **accessible names** for icon-only controls when unavoidable.
- **Errors** — Clear messages; next steps actionable; failures do not strand users in blank states.

---

## 7. Language rules

- **English** is the **primary** product language: default copy, primary terminology, and internal consistency anchor.
- **Vietnamese** is **secondary**: full parity for supported areas; professional, plain wording (no slang that confuses mixed-age staff).
- **Tone:** Short, courteous, instructional where needed—not playful in operational paths.
- **Terminology:** One term per concept across EN/VI (e.g. same word for status names in manuals, labels, and training).
- **Locale:** Respect salon context (Canada-first operations, multilingual staff); numbering, phone, and business copy should not assume a single geography in user-facing explanations when product supports multiple regions.

---

*Operational software is judged when everything goes wrong at once. NailIQ is built for that moment.*
