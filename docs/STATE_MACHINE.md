# NailIQ — Booking State Machine (Governance)

**Role:** Single source of truth for the booking lifecycle.
**Audience:** Product, design, engineering (human and AI-assisted).
**Scope:** States, transitions, forbidden moves, auto-transitions, permissions, and per-state UI behavior.

**Out of scope here:** Color values (`COLOR_TOKENS.md`), spacing and typography (`DESIGN_SYSTEM.md`), component APIs (`COMPONENT_RULES.md`), motion timing (`ANIMATION_RULES.md`), database schema, implementation code.

**Read before:** changing booking state, adding a new state, adding a new transition, adjusting drawer actions, surfacing booking status anywhere in the product.

**Architectural rule (non-negotiable):**
**All booking state transitions must go through server actions.** Client code must **never** mutate booking state directly. Optimistic UI is permitted only when the server action is in flight and rollback is wired on failure. This rule is enforced before any other rule below.

---

## 1. Why a State Machine

### The cost of uncontrolled state

A booking is the unit of revenue, the unit of time, and the unit of trust at a salon. When booking state is allowed to drift freely, the consequences compound:

- **Data corruption** — a booking marked `completed` then re-opened to `in_progress` makes revenue, payroll, and analytics lie.
- **Lost revenue** — a `cancelled` booking re-armed from the client without going through cancellation rules can be billed twice or not at all.
- **Operational confusion** — receptionists see contradictory states across surfaces because two clients raced to set state.
- **Phantom conflicts** — overlapping states (e.g. two `in_progress` rows for the same staff at the same time) silently corrupt the timeline.
- **Audit failure** — without a defined transition graph, "what happened to this booking?" becomes unanswerable.

### Why explicit transitions prevent bugs

A defined state machine forces every change through a **named transition**:

- The set of valid next states is finite and inspectable.
- Invalid moves are rejected at the **server boundary**, not "noticed later" in analytics.
- Each transition has a single owner (a server action), so logging, validation, and side-effects are centralized.
- Permissions and auto-transitions are modeled, not improvised per surface.
- New states cannot leak into the system without amending this document and the transition graph.

### Architectural posture

- Bookings have **one** authoritative state at any moment.
- Transitions are **atomic** and **auditable**.
- The client is a **renderer of state** and a **requester of transitions** — never an owner of state.
- Any code path that writes booking state without going through a sanctioned server action is a defect.

---

## 2. Booking States

Each state below has: a name, its meaning, who can see it, and its visual indicator. Visual indicators reference `COLOR_TOKENS.md` §5 (Booking Status Colors). No new color is defined here.

### `pending`

- **Meaning:** A booking has been requested but is not yet committed. Awaiting confirmation by the salon (or by automated rules).
- **Who can see it:** Customer (their own request), receptionists, seniors, owners.
- **Visual indicator:** `pending` family per `COLOR_TOKENS.md` §5 — yellow main with subtle background; pair with the textual label "Pending."

### `confirmed`

- **Meaning:** The booking is committed for a specific staff, service, and time. The chair is held.
- **Who can see it:** Customer, receptionists, seniors, owners; assigned nail tech sees their own.
- **Visual indicator:** `confirmed` family — cool blue, signaling trust and commitment. Always paired with the textual label "Confirmed."

### `arrived`

- **Meaning:** The customer is physically on-premise but has not yet been seated. The booking has been checked in.
- **Who can see it:** Receptionists, seniors, owners; assigned nail tech.
- **Visual indicator:** `arrived` family — teal, distinct from completed green and confirmed blue. Pair with the label "Arrived."

### `waiting`

- **Meaning:** The customer is checked in and queued, waiting for their chair or staff to free up. Active queue pressure.
- **Who can see it:** Receptionists, seniors, owners; assigned nail tech.
- **Visual indicator:** `waiting` family — orange, signaling "needs motion." Pair with the label "Waiting" and a wait-time hint where layout allows.

### `in_progress`

- **Meaning:** The customer is in the chair. Service is actively being performed.
- **Who can see it:** Receptionists, seniors, owners; assigned nail tech.
- **Visual indicator:** `in_progress` family — indigo, signaling "in progress" without colliding with informational blue. Pair with the label "In service."

### `completed`

- **Meaning:** The service has finished successfully. Terminal state. Revenue and analytics treat this as closed.
- **Who can see it:** Receptionists, seniors, owners; assigned nail tech; customer (in their history).
- **Visual indicator:** `completed` family — green. Must not use brand gold (gold is VIP only). Pair with the label "Completed."

### `cancelled`

- **Meaning:** The booking was abandoned before service began. Terminal state.
- **Who can see it:** Receptionists, seniors, owners; assigned nail tech (read-only); customer (in their history).
- **Visual indicator:** `cancelled` family — slate, low arousal. Pair with the label "Cancelled."

### `no_show`

- **Meaning:** The customer did not arrive within the allowed threshold and did not cancel. Terminal state, distinct from `cancelled` because it carries operational consequence (policy, reputation, possible deposit forfeiture).
- **Who can see it:** Receptionists, seniors, owners.
- **Visual indicator:** `no_show` family — deeper red than the generic danger family, for scan distinction. Pair with the label "No-show."

### `late`

- **Meaning:** The booking has exceeded an expected time threshold (start time passed without arrival, or service time overrun). A **flag overlay** on the booking, not a replacement for its underlying operational state.
- **Who can see it:** Receptionists, seniors, owners; assigned nail tech.
- **Visual indicator:** `late` family — bright amber for clock visibility under glare. Pair with the textual label "Late" and the underlying state (e.g. "Confirmed · Late", "In service · Late").

### `rescheduled`

- **Meaning:** The booking was moved. The original slot is released; the new slot is held under a new commitment cycle. A short-lived transitional state that resolves to `confirmed` once the new slot is locked in.
- **Who can see it:** Receptionists, seniors, owners; customer (notified of the new time).
- **Visual indicator:** Treat as a transitional badge using the `cancelled` slate family for the released slot's residue and the `confirmed` family for the new slot once resolved. Always paired with the label "Rescheduled."

---

## 3. Allowed Transitions

The **only** valid transitions are listed here. Any move not in this list is forbidden by default.

### Transition table

| From          | To             | Trigger                                     |
| ------------- | -------------- | ------------------------------------------- |
| `pending`     | `confirmed`    | Salon confirms the request.                 |
| `pending`     | `cancelled`    | Customer or salon abandons before commit.   |
| `confirmed`   | `arrived`      | Receptionist checks the customer in.        |
| `confirmed`   | `cancelled`    | Customer or salon cancels a held booking.   |
| `confirmed`   | `rescheduled`  | Time/staff is moved before arrival.         |
| `confirmed`   | `no_show`      | Threshold exceeded without arrival.         |
| `arrived`     | `waiting`      | Customer queued for staff or chair.         |
| `arrived`     | `in_progress`   | Customer seated directly without queuing.   |
| `arrived`     | `cancelled`    | Customer leaves before service begins.      |
| `waiting`     | `in_progress`   | Staff picks up the customer.                |
| `waiting`     | `cancelled`    | Customer leaves the queue.                  |
| `in_progress`  | `completed`    | Service ends successfully.                  |
| `in_progress`  | `late`         | **System only** — time threshold exceeded.  |
| `in_progress`  | `cancelled`    | Service aborted mid-way (rare, exceptional).|
| `late`        | `in_progress`   | Late condition resolved; service resumes.   |
| `late`        | `no_show`      | Late condition escalates to absence.        |
| `late`        | `cancelled`    | Late condition resolved by cancellation.    |
| `rescheduled` | `confirmed`    | New slot is locked.                         |
| `rescheduled` | `cancelled`    | Reschedule abandoned.                       |
| `completed`   | —              | **Terminal.** No transitions allowed.       |
| `cancelled`   | —              | **Terminal.** No transitions allowed.       |
| `no_show`     | —              | **Terminal.** No transitions allowed.       |

### Transition rules in prose

1. **`pending → confirmed`** — only after the salon has accepted the request and the slot is locked.
2. **`confirmed → arrived`** — only at check-in; never inferred from time alone.
3. **`confirmed → cancelled`** — allowed at any time before arrival, subject to the salon's cancellation policy.
4. **`confirmed → rescheduled`** — when time or staff is changed. The booking exits `rescheduled` only by becoming `confirmed` (new slot locked) or `cancelled` (abandoned).
5. **`arrived → waiting`** — when the chair or staff is not yet free.
6. **`arrived → in_progress`** — when the customer is seated immediately without queuing.
7. **`waiting → in_progress`** — when staff picks up the customer.
8. **`in_progress → completed`** — the only success-path exit from `in_progress`.
9. **`in_progress → late`** — **system only**, applied as an overlay flag when the service exceeds its expected window. The booking remains operationally `in_progress`; `late` is a flag layer, not a replacement state, and is cleared on `completed`.
10. **`in_progress → cancelled`** — exceptional. Reserved for service aborted after seating (e.g. customer leaves mid-service). Requires explicit cancellation flow.
11. **`late → in_progress`** — clears the late flag once the underlying condition resolves.
12. **`late → no_show`** — escalation when the late threshold passes without arrival or contact.
13. **`late → cancelled`** — when the late state is resolved by an explicit cancellation (customer cancels late).
14. **`rescheduled → confirmed`** — the only constructive exit from `rescheduled`.
15. **`rescheduled → cancelled`** — abandonment of the reschedule attempt.
16. **`completed`, `cancelled`, `no_show`** — terminal. To "undo" a terminal state, create a **new** booking; do not mutate the terminal record.

### Late-cancellation fee integrity across reschedules

- A customer-controlled reschedule (public manage link or AI receptionist) does
  **not** reset an already-entered late-cancellation window. The server snapshots
  the applicable fee from the original slot in the same transaction that moves
  the booking, and later customer reschedules preserve that snapshot.
- Staff reschedules remain discretionary and do not create this lock. Owners can
  still disable the salon's self-cancel fee policy as an emergency stop.
- The AI receptionist may charge an individual late-cancellation fee only after
  identity verification, exact fee disclosure, and a trusted explicit customer
  acknowledgement. Group cancellations that could create multiple charges fail
  closed to staff review.
- A failed payment never becomes a false success: cancellation and charge outcome
  are logged separately. No customer path may claim a fee was collected unless
  the payment provider returned success.

---

## 4. Forbidden Transitions

The following moves are **never** permitted. Server actions must reject them; clients must never request them.

### Terminal violations

- **`completed → any`** — completed is closed. To redo a service, create a new booking.
- **`cancelled → any`** — cancelled is closed. To re-book, create a new booking.
- **`no_show → any`** — no-show is closed. To re-book, create a new booking.

### Skip violations (must pass through intermediate states)

- **`pending → in_progress`** — must pass through `confirmed` and either `arrived` or `arrived → waiting`.
- **`pending → arrived`** — must pass through `confirmed` first.
- **`pending → completed`** — multiple required intermediate states.
- **`confirmed → completed`** — must pass through `in_progress`.
- **`confirmed → in_progress`** — must pass through `arrived` (and optionally `waiting`).
- **`confirmed → waiting`** — must pass through `arrived`.
- **`waiting → completed`** — must pass through `in_progress`.
- **`arrived → completed`** — must pass through `in_progress`.

### Reverse violations

- **`in_progress → waiting`** — bookings do not return to the queue once seated.
- **`in_progress → arrived`** — bookings do not retreat to "checked in but unseated."
- **`waiting → arrived`** — arrived is a one-way checkpoint.
- **`arrived → confirmed`** — check-in cannot be undone by state alone; cancel and rebook if needed.
- **`confirmed → pending`** — confirmation is not a draft state.

### Cross-graph violations

- Any transition not listed in §3 — denied by default.
- Any transition that would result in two simultaneous `in_progress` rows for the same staff at the same time — denied by the server (conflict check governs).
- Any transition initiated by a client that bypasses a server action — **prohibited at the architectural level**, regardless of which transition is being attempted.

### Architectural prohibitions

- **Direct client-side state mutation** — the client never writes booking state to the database, to local cache, or to global stores in a way that is treated as authoritative.
- **Optimistic state without server intent** — the client may render a transitional state during a pending server action, but the booking is not considered to be in the new state until the server confirms.
- **Bulk state edits without a transition path** — even bulk operations must apply individual valid transitions; "set all of these to completed" is not a primitive.

---

## 5. Auto-Transitions (System Only)

Some transitions are not user-initiated. The **system** triggers them based on time, configuration, and policy. Auto-transitions are still server-side; the "system" actor is a server-side scheduler, not the client.

### `in_progress + time exceeded → late` (overlay flag)

- **Trigger:** Service duration exceeds the configured expected window for the booked service(s) by the salon's late threshold.
- **Actor:** System scheduler (server-side, runs against booking records on a recurring cadence).
- **Effect:** Sets the `late` overlay flag. The underlying state remains `in_progress`. Receptionist surfaces show "In service · Late" with the `late` color family overlaid.
- **Clearing:** Cleared automatically when the booking transitions to `completed` (success), or to `cancelled` (abort), or when the system observes the condition no longer applies and applies `late → in_progress`.

### `confirmed + no arrival by threshold → no_show candidate`

- **Trigger:** A `confirmed` booking has passed its scheduled start time by the salon's no-show threshold without a check-in.
- **Actor:** System scheduler.
- **Effect:** Marks the booking as a **no-show candidate** (an internal flag suggesting `no_show`). The state does **not** auto-flip to `no_show` without a human acknowledgment, because no-show carries policy consequences (deposit forfeiture, reputation marks).
- **Resolution:** A receptionist, senior, or owner confirms the no-show (transition `confirmed → no_show`) or cancels it instead (`confirmed → cancelled`). The candidate flag is cleared on either resolution.

### `late → no_show` (escalation)

- **Trigger:** A booking already flagged `late` has remained late beyond a secondary escalation threshold without resolution.
- **Actor:** System scheduler.
- **Effect:** Marks the booking as a no-show candidate (per above). Does **not** auto-flip to `no_show` without human acknowledgment.

### Auto-transition rules

- Auto-transitions execute on the server only. The client cannot request them.
- Auto-transitions log who/what triggered the change ("system: scheduler") for audit.
- Thresholds (late, no-show) are **per-salon configuration**, not hard-coded constants in product copy.
- Auto-transitions **respect the same transition graph** in §3 — the system cannot auto-apply a forbidden transition.
- A receptionist or owner can **override** an auto-applied flag (e.g. dismiss a no-show candidate) through an explicit user-initiated transition; the override is logged.

---

## 6. Permission Rules Per Transition

Roles per `CLAUDE.md`: `owner`, `senior`, `nail_tech`, plus the `system` actor for scheduler-driven moves and the `customer` actor for self-service requests.

| Transition                        | owner | senior | nail_tech | system | customer |
| --------------------------------- | :---: | :----: | :-------: | :----: | :------: |
| `pending → confirmed`             |   ✓   |   ✓    |     —     |   ✓¹   |    —     |
| `pending → cancelled`             |   ✓   |   ✓    |     —     |   —    |    ✓²    |
| `confirmed → arrived`             |   ✓   |   ✓    |    ✓³     |   —    |    —     |
| `confirmed → cancelled`           |   ✓   |   ✓    |     —     |   —    |    ✓²    |
| `confirmed → rescheduled`         |   ✓   |   ✓    |     —     |   —    |    ✓²    |
| `confirmed → no_show`             |   ✓   |   ✓    |     —     |   —    |    —     |
| `arrived → waiting`               |   ✓   |   ✓    |    ✓³     |   —    |    —     |
| `arrived → in_progress`            |   ✓   |   ✓    |    ✓³     |   —    |    —     |
| `arrived → cancelled`             |   ✓   |   ✓    |     —     |   —    |    —     |
| `waiting → in_progress`            |   ✓   |   ✓    |    ✓³     |   —    |    —     |
| `waiting → cancelled`             |   ✓   |   ✓    |     —     |   —    |    —     |
| `in_progress → completed`          |   ✓   |   ✓    |    ✓³     |   —    |    —     |
| `in_progress → late` (flag)        |   —   |   —    |     —     |   ✓    |    —     |
| `in_progress → cancelled`          |   ✓   |   ✓    |     —     |   —    |    —     |
| `late → in_progress` (clear flag)  |   ✓   |   ✓    |    ✓³     |   ✓    |    —     |
| `late → no_show`                  |   ✓   |   ✓    |     —     |   ✓⁴   |    —     |
| `late → cancelled`                |   ✓   |   ✓    |     —     |   —    |    —     |
| `rescheduled → confirmed`         |   ✓   |   ✓    |     —     |   —    |    —     |
| `rescheduled → cancelled`         |   ✓   |   ✓    |     —     |   —    |    ✓²    |

**Footnotes:**

1. **`system`** confirms `pending → confirmed` only when auto-confirm policy is enabled by the salon; otherwise human approval is required.
2. **`customer`** can self-cancel or self-reschedule before arrival, subject to the salon's policy window. Customer cancellations route through the same server action as salon-initiated cancellations.
3. **`nail_tech`** can advance their **own** assigned booking through service-floor transitions (`arrived`, `waiting`, `in_progress`, `completed`). They cannot affect other nail techs' bookings.
4. **`system`** marks `late → no_show` as a **candidate** only; the actual transition still requires human confirmation by `owner` or `senior` (see §5).

### Permission rules

- **All transitions verify salon membership** via `salon_members` server-side, regardless of role (per `CLAUDE.md` security rules).
- **Roles are checked server-side** by the server action handling the transition. The client never gates a transition on its own.
- **`nail_tech` scope is bounded to their own bookings.** Attempts to mutate another tech's booking are rejected even if the transition itself is otherwise valid.
- **`customer` scope is bounded to their own bookings** and to transitions explicitly marked customer-permitted above.
- **Owner-only configurations** (late thresholds, no-show policy, auto-confirm) affect the *behavior* of transitions but do not grant non-owners new transition rights.

---

## 7. UI Behavior Per State

UI surfaces (booking drawer, booking blocks on the timeline, queue chips, lists) render state and expose the **valid next transitions** as actions. Disabled actions remain visible enough to communicate "not available now," not hidden.

Visual color mapping is governed by `COLOR_TOKENS.md` §5 — this section describes **which color family** to use, never specific values.

### `pending`

- **Block color:** `pending` family per `COLOR_TOKENS.md` §5.
- **Drawer header:** "Pending" label paired with the family color.
- **Available actions:** Confirm, Cancel.
- **Disabled actions:** Check in, Seat, Start service, Complete, Mark no-show, Reschedule. Disabled with explanatory hint ("Confirm first").
- **Notes:** Customer-facing surfaces show "Awaiting confirmation."

### `confirmed`

- **Block color:** `confirmed` family.
- **Drawer header:** "Confirmed" label.
- **Available actions:** Check in (→ `arrived`), Reschedule (→ `rescheduled`), Cancel (→ `cancelled`), Mark no-show (→ `no_show`, gated by threshold or owner/senior override).
- **Disabled actions:** Seat / Start service / Complete (require check-in first).
- **Notes:** Mark no-show surfaces only when the start time has passed beyond the configured threshold, or for owner/senior with explicit override.

### `arrived`

- **Block color:** `arrived` family.
- **Drawer header:** "Arrived" label.
- **Available actions:** Add to queue (→ `waiting`), Seat now (→ `in_progress`), Cancel (→ `cancelled`).
- **Disabled actions:** Confirm, Check in (already done), Complete, Mark no-show.

### `waiting`

- **Block color:** `waiting` family.
- **Drawer header:** "Waiting" label, with wait-time meta.
- **Available actions:** Seat (→ `in_progress`), Cancel (→ `cancelled`).
- **Disabled actions:** Check in (already done), Complete, Mark no-show.
- **Surfacing:** also rendered as a `QueueChip` in the right zone of the dashboard (per `DASHBOARD_LAYOUT_RULES.md`).

### `in_progress`

- **Block color:** `in_progress` family.
- **Drawer header:** "In service" label.
- **Available actions:** Complete (→ `completed`), Cancel (→ `cancelled`, exceptional — confirm dialog with `danger` styling per `COMPONENT_RULES.md`).
- **Disabled actions:** Check in, Seat, Start service (already in progress).
- **Notes:** If the system has applied the `late` overlay, the block also carries the `late` family treatment (see below).

### `late` (overlay flag, not a standalone block state)

- **Block color:** `late` family overlaid on the underlying state's color (e.g. an `in_progress` block gains a `late` keyline or label badge).
- **Drawer header:** "<Underlying state> · Late" — never replaces the underlying state label.
- **Available actions:** All actions valid for the underlying state, **plus** Mark no-show (when applicable per §3 and the late→no_show rule).
- **Notes:** The `late` flag clears automatically on `completed`/`cancelled` and may be cleared by `late → in_progress` when the system confirms the condition is resolved.

### `completed`

- **Block color:** `completed` family. Must not use brand gold (gold is VIP only, per `COLOR_TOKENS.md` §6).
- **Drawer header:** "Completed" label.
- **Available actions:** **None** that mutate state. Read-only fields (notes, summary, receipt where supported).
- **Disabled actions:** All transitions. Disabled controls remain labeled and parseable; do not collapse them into the canvas.
- **Notes:** Terminal. To "undo" or correct, create a new booking.

### `cancelled`

- **Block color:** `cancelled` family.
- **Drawer header:** "Cancelled" label, with cancellation reason if recorded.
- **Available actions:** None. Read-only.
- **Disabled actions:** All transitions.
- **Notes:** Terminal. Cancelled blocks may be hidden from the default timeline view depending on preset (per `DASHBOARD_LAYOUT_RULES.md`).

### `no_show`

- **Block color:** `no_show` family.
- **Drawer header:** "No-show" label, with policy consequence noted (e.g. deposit forfeit) where applicable.
- **Available actions:** None. Read-only.
- **Disabled actions:** All transitions.
- **Notes:** Terminal. Distinct from cancelled to preserve operational history (policy, repeat-offender tracking).

### `rescheduled`

- **Block color:** Released slot residue uses `cancelled` family treatment; new slot uses `confirmed` family once locked.
- **Drawer header:** "Rescheduled" label, with the new time and (if changed) staff.
- **Available actions:** Confirm new slot (→ `confirmed`), Abandon reschedule (→ `cancelled`).
- **Disabled actions:** Check in, Seat, Start service, Complete (the new slot must be locked first).
- **Notes:** Transitional — should not persist long. If a `rescheduled` booking lingers past a threshold, surface it as needing attention.

### Cross-state UI rules

- **Pair color with text label** for every status surface. Hue alone is never sufficient (per `COLOR_TOKENS.md` §7 and `UX_PRINCIPLES.md`).
- **Disabled actions remain labeled.** A grayed-out "Complete" button still says "Complete." Do not hide the action; the receptionist learns the state machine through the visible action set.
- **Destructive transitions** (Cancel, Mark no-show) use the `danger` button variant (per `COMPONENT_RULES.md`) and require an explicit confirm step where appropriate.
- **Auto-applied state changes** (system-driven) appear in place without modal interruption, but produce live-region announcements where outcome would otherwise be silent (per `COMPONENT_RULES.md` §6).
- **Optimistic UI** during an in-flight transition shows the requested target state with a clear pending indicator; on server failure the UI rolls back to the prior authoritative state and surfaces the error.

---

*This document is enforceable. Any code path that introduces a new state, a new transition, an unlisted move, or a client-side state mutation must amend this file before merging. The transition graph in §3 is the contract; §4 is the closed list of denials; §5 names the only system-driven moves; §6 names the only role gates; §7 names the only UI affordances per state.*
