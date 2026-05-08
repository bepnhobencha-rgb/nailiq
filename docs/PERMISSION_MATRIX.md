# NailIQ — Permission Matrix

**Role:** Access-control contract for **salon-scoped** tools (dashboard, receptionist desk, settings, reporting).  
**Audience:** Product, engineering, support.  
**Scope:** What each **membership role** may do, how the UI should behave, and what every mutating server path must guarantee.  
**Out of scope:** Implementation code, storage layout, styling systems, and public guest booking (unauthenticated) except where it intersects desk policy.

**Companion docs:** `docs/UX_PRINCIPLES.md` (operational priorities: safety, reception throughput, clear errors). Booking lifecycle and allowed status transitions remain **single sources of truth on the server**, not inferred from any client shortcut.

Legend for tables below:

- **Yes** — Allowed once the viewer is authenticated, belongs to the target salon via membership lookup, and any feature flags/modules are satisfied.
- **No** — Not allowed by policy even if incidental UI leakage exists until gated.
- **Partial** — Allowed only under stated constraints or pending product differentiation (future-safe row).

Architecture note: NailIQ evolves **additive roles** (`manager`, `trainee`, `viewer`, `accounting`, …). The matrix is written so new roles can extend rows without rewriting owner/senior/nail\_tech semantics.

---

## 1. Permission philosophy

### Why role-based access matters operationally

NailIQ runs at the **live counter**. Mistakes propagate as social cost: double-books, wrongful cancels, and silent denials fracture trust between reception, technicians, and clients. Roles model **who is accountable on the floor**—not ornamental titles.

Operational roles separate:

- **Strategic ownership** — policy, commerce configuration, staffing authority, integrations, and tenancy risk.
- **Desk execution** — moving the timeline and queue accurately under time pressure (see personas in `docs/UX_PRINCIPLES.md`).
- **Chair-side consumption** — read-mostly clarity for technicians (“who’s next, how long, what service”).

### Server-first enforcement

**Authoritative permission** is resolved **on the server** from the signed-in identity’s **membership in the target salon**. The client may hide or disable controls for speed and clarity, but **must not** be the only layer that prevents harm.

**Row-level security** and other platform controls are a **backstop** (defense in depth). They do not replace explicit membership + role checks in mutating entry points.

### UI hiding vs server enforcement

| Layer | Purpose |
| --- | --- |
| **UI (hide / disable)** | Reduces wrong taps, trains staff on scope, keeps dense surfaces calmer. |
| **Server (enforce)** | Guarantees correctness when actions are replayed, scripted, or triggered from outdated clients. |

**Rule:** If an action is **No** in the matrix for a role, the server path must **fail closed** with a typed outcome (see §7), not “succeed quietly” or “fail ambiguously.”

---

## 2. Current role definitions

Roles here are **salon membership roles** (what the account may do **for that salon**). They are distinct from **directory labels** used for roster display (e.g. job titles on staff cards).

### `owner`

- **Who in a real salon:** The business owner or single accountable partner for P&L, policy, and legal relationship with NailIQ for that location.
- **Typical actions:** Configure services and hours, manage staff records, review revenue and utilization, set desk modules, resolve escalations, transfer leadership when staff change.
- **Must never access:** Another tenant’s data; member-only owner actions should not be available to non-owners (see matrix).

### `senior`

- **Who in a real salon:** Lead receptionist, floor lead, or senior tech trusted to run the **desk** without altering business configuration.
- **Typical actions:** Full booking and queue operations for the day—add walk-ins, assign, reschedule, cancel, move queue, advance chair flow—without changing core catalog or ownership.
- **Must never access:** Ownership-only configuration (modules, permissions, staff membership administration, profile-of-record changes) per policy table.

### `nail_tech`

- **Who in a real salon:** Service provider primarily working from the chair; may glance at assignments between clients.
- **Typical actions:** Read schedules and assignments; optionally assist with **low-risk intake** only where policy explicitly permits (today: favor **read-only** schedule mutations; destructive or calendar-defacing actions belong to desk roles).
- **Must never access:** Destructive schedule edits, cancellations, salon configuration, financial administration, exports, or permission management—anything that reallocates accountability away from designated desk/owner roles.

---

## 3. Permission matrix — current

Interpretation hints:

- **Desk** refers to Receptionist Center (front desk timeline + queue) and tightly related drawers.
- **Owner home** refers to salon overview surfaces aimed at proprietors when distinct from desk-only chrome.
- **Settings** aggregates profile, hours, services, staff, and permissions UX even if surfaced from multiple routes today.

Where a cell is **Partial**, an italic note explains bounds.

### Bookings — desk / calendar mutations

| Action | owner | senior | nail_tech |
| --- | --- | --- | --- |
| View all bookings (desk scope / tenant bookings the product loads for operations) | Yes | Yes | Yes |
| Create booking _(desk: walk-in / manual intake paths)_ | Yes | Yes | Partial — _intake only if/WHEN explicitly allowed; destructive paths remain desk roles; server must converge to matrix_ |
| Edit booking _(any teammate’s appointment)_ | Yes | Yes | No |
| Edit booking _(own appointments only)_ | Partial — _not differentiated yet; behaves like “edit any”; future `trainee`/scoped tech may use this row_ | Partial — same | Partial — planned future scope; until then treat as **No** |
| Cancel booking | Yes | Yes | No |
| Mark no-show | Yes | Yes | No |
| Reschedule booking | Yes | Yes | No |

Operational alignment: **`nail_tech` is primarily read/consume on the mutable schedule.** Any exception for lightweight intake stays **narrow, explicit, and server-guarded.**

### Queue — walk-ins and ordering

| Action | owner | senior | nail_tech |
| --- | --- | --- | --- |
| Add walk-in | Yes | Yes | Partial — _mirror “create booking”; default **No** until product explicitly adopts tech-assisted intake_ |
| Reorder queue _(manual urgency / drag priority when supported)_ | Yes | Yes | No |
| Assign staff to walk-in / slotting from queue | Yes | Yes | No |

FIFO or algorithmic urgency may order the queue automatically; **manual reorder** remains a privileged desk action under owner/senior.

### Dashboard — workspace & modules

| Action | owner | senior | nail_tech |
| --- | --- | --- | --- |
| View KPI band / condensed stats on surfaces they legitimately route to | Yes | Yes | Yes |
| View revenue _(per-client prices on blocks, totals when enabled)_ | Partial — toggled by salon **desk modules**; visibility obeys module config | Partial — same | Partial — same _(if shown at all on tech surfaces)_ |
| Change workspace preset _(layout density / saved desk arrangement when feature lands)_ | Yes | Partial — may allow **personal** preset vs **salon-wide** preset when distinguished | Partial — read-only or inherit desk default _(product decision)_ |
| Toggle dashboard modules _(salon-wide desk configuration)_ | Yes | No | No |

### Settings — configuration

| Action | owner | senior | nail_tech |
| --- | --- | --- | --- |
| Edit salon profile _(name-in-product, phones, branding fields, closures where applicable)_ | Yes | No | No |
| Edit hours | Yes | No | No |
| Edit services / catalog | Yes | No | No |
| Manage staff roster / capabilities _(CRUD)_ | Yes | No | No |
| View/edit permissions _(assign membership roles)_ | Yes | No | No |

**Policy:** Seniors and technicians should not mutate **salon-wide configuration**. If incidental UI exposes links, guards must return **forbidden**.

### Reporting & export

| Action | owner | senior | nail_tech |
| --- | --- | --- | --- |
| View daily summary _(owner-oriented snapshot)_ | Yes | Partial — _surface-dependent; desk stats OK; owner-only aggregates **No**_ | Partial — _read-only glimpses consistent with routed UI_ |
| View revenue report _(historical aggregates, not just ephemeral desk totals)_ | Yes | Partial — _explicit product decision when reports roll out_; default deny on sensitive slices | No |
| Export data _(CSV/ledger/hand-off)_ | Yes | No | No |

---

## 4. Future role definitions _(planned scope only — not shipped)_

These roles extend the matrix later as **additional columns**. Existing roles stay stable.

### `manager`

- **Scope intent:** Multi-shift floor manager: full desk powers like `senior`, plus **delegated subset** of owner tasks (not full tenancy transfer)—e.g., staff overrides, approvals, refunds when POS lands, curated reports.

### `trainee`

- **Scope intent:** Probationary desk access—**paired actions**, limited cancellation/reschedule powers, immutable audit trail of overrides; optionally **scoped “own edits only”**.

### `viewer`

- **Scope intent:** Accountant, partner, auditor—read dashboards/reports/export **within granted slices**, **no** mutations, **no** PII-heavy exports unless explicitly toggled later.

### `accounting`

- **Scope intent:** Finance role with **reporting/export** privileges and separation from chair/desk throughput tools; explicitly **non-operational**.

---

## 5. Transition rules

### Assignment

- **Changing** a member’s salon role is an **ownership-level** privilege (explicit owner-only tooling or supervised admin flows).
- Invitations and onboarding may create membership, but role elevation above baseline staff must still satisfy owner policy.

### One role per user per salon

- A single user carries **exactly one** membership role **per salon**.
- Users may belong to **multiple salons** with **different** roles in each—that is not multiple roles within one salon.

### Ownership transfer

- Transfer is a **destructive-privilege sequence**: designate a **single** new owner, demote outgoing owner to a non-owning role (commonly `manager`/`senior`/`viewer`), and re-run permission caches if applicable.
- Invariant: **at least one** `owner` (or contractual successor documented in product/legal) before outgoing owner loses owner powers.
- Sensitive exports and integration secrets should rotate or be re-affirmed during transfer (**policy**, not UX detail).

---

## 6. UI enforcement rules

### Hidden vs disabled vs visible‑but‑locked

| Pattern | Use when |
| --- | --- |
| **Hidden** | Action is meaningless or unsafe for role; avoids clutter (**prefer** over disabled for rare/destructive items). |
| **Disabled (+ explanation)** | User should know capability exists salon-wide but **not for them**, or dependencies block it (hours closed, conflicting state)—pair with textual reason. |
| **Visible-but-locked** | Training mode / upgrade path / rare discoverability (“Ask owner”)—still needs clear affordance explaining **why** |

### Error when unauthorized attempted

Follow `docs/UX_PRINCIPLES.md §6 (Errors)` and **`Trust through feedback`**:

- Prefer **explicit** failure over silent no-ops when a server action rejects.
- Message pattern: short **cause** (“You don’t have permission to cancel bookings.”) + **next step** (“Ask an owner or lead reception.”)—localized copy via product i18n.

### No silent failures

Blocked writes, suppressed buttons that still enqueue network work, optimistic UI that cannot reconcile—all violate operational trust.

---

## 7. Server action contract _(mutating entry points)_

Every **mutating** server-side entry handler (conceptually: booking/queue/catalog/settings/export triggers) MUST:

1. **Verify membership** — caller is authenticated and tied to **the salon targeted by the invocation** via authoritative membership resolution (never trust identifiers alone without membership join).
2. **Check role** — compare resolved role against §3 Permission matrix (this document evolves as source of intent).
3. **Return typed errors** using exactly:
   - **`unauthorized`** — caller could not be established as an eligible member **for this salon/context** session (wrong tenant target, spoofed linkage, revoked session—**product maps all to humane copy**, not ambiguous empty success).
   - **`forbidden`** — membership verified, **role insufficient** for the action.

   Stable string codes survive UI refactors so clients map consistently to localization keys.

4. **Never trust client-supplied role** — role hints from the browser are informational only; authoritative role is always **derived server-side**.

5. **Idempotency-conscious outcomes** — where duplicate taps are likely at the desk (`docs/UX_PRINCIPLES.md`: fast under pressure), return deterministic errors instead of ambiguous empty success.

Recommended extension points for future roles: central **pure policy functions** keyed by `{ actionId, role }` so matrices and audits stay coherent as columns accrue (`manager`, `trainee`, `viewer`, `accounting`, …).

---

*Operational software fails loudly at the boundaries of authority; NailIQ’s desk depends on predictable enforcement under Friday-evening pressure.*
