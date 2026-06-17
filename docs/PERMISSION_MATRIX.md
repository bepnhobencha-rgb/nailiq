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

Architecture note: NailIQ evolves **additive roles** (`manager`, `trainee`, `viewer`, `accounting`, …). The matrix is written so new roles can extend rows without rewriting owner/admin/senior/receptionist/nail\_tech semantics.

---

## 1. Permission philosophy

### Role hierarchy

NailIQ has **5 salon-scoped roles**, ordered from highest to lowest authority:

```
owner  >  admin  >  senior  >  receptionist  >  nail_tech
```

### The core principle: admin = owner minus billing and ownership

**`admin` is `owner` with two capabilities removed:**

1. **Billing and payment infrastructure** — Stripe subscription, Stripe Connect setup, and anything that touches the commercial relationship between the salon and NailIQ. These are ownership-level commitments.
2. **Structural / ownership operations** — changing the salon's vertical, granting the `admin` role to others (no self-replication of elevated access), archiving the salon, or transferring ownership.

Everything else an owner can do day-to-day — booking operations, client management, staff management (except role escalation), all settings, reports, AI, brand, domain — `admin` can also do. The intent is that a salon owner can hand the shop keys to a trusted manager (`admin`) without handing over the business itself.

**`receptionist` is the front-desk operator role.** It covers the full booking and queue lifecycle — creating, editing, cancelling, completing, handling no-shows, managing the walk-in queue, and searching clients. It does not touch settings, reports, or client profile editing (VIP flags, notes). A receptionist keeps the desk running without needing access to anything that shapes the business.

**`senior`** sits between `admin` and `receptionist`: full desk powers plus access to reports and the ability to edit past bookings. Still locked out of settings.

**`nail_tech`** is read-only plus own schedule consumption.

### Server-first enforcement

**Authoritative permission** is resolved **on the server** from the signed-in identity's **membership in the target salon**. The client may hide or disable controls for speed and clarity, but **must not** be the only layer that prevents harm.

**Row-level security** and other platform controls are a **backstop** (defense in depth). They do not replace explicit membership + role checks in mutating entry points.

### UI hiding vs server enforcement

| Layer | Purpose |
| --- | --- |
| **UI (hide / disable)** | Reduces wrong taps, trains staff on scope, keeps dense surfaces calmer. |
| **Server (enforce)** | Guarantees correctness when actions are replayed, scripted, or triggered from outdated clients. |

**Rule:** If an action is **No** in the matrix for a role, the server path must **fail closed** with a typed outcome (see §7), not "succeed quietly" or "fail ambiguously."

---

## 2. Role definitions

Roles here are **salon membership roles** (what the account may do **for that salon**). They are distinct from **directory labels** used for roster display (e.g. job titles on staff cards).

### `owner`

- **Who in a real salon:** The business owner or single accountable partner for P&L, policy, and legal relationship with NailIQ for that location.
- **Typical actions:** Configure services and hours, manage staff records, manage billing and Stripe Connect, review revenue and utilization, set desk modules, resolve escalations, grant/revoke admin roles, change vertical, transfer or archive salon.
- **Must never access:** Another tenant's data; member-only owner actions should not be available to non-owners (see matrix).

### `admin`

- **Who in a real salon:** Trusted floor manager, head receptionist, or co-owner without P&L responsibility — someone who runs daily operations but doesn't hold the business relationship with NailIQ.
- **Typical actions:** All booking and client operations, staff management (except role escalation), full settings management (services, hours, brand, domain, AI, no-show protection, referrals), reports, analytics.
- **Must never access:** Billing / Stripe management, granting the `admin` role, changing the salon vertical, archiving or transferring the salon.

### `senior`

- **Who in a real salon:** Lead receptionist, floor lead, or senior tech trusted to run the **desk** without altering business configuration.
- **Typical actions:** Full booking and queue operations for the day — add walk-ins, assign, reschedule, cancel, move queue, advance chair flow — plus access to reports. Cannot change salon settings.
- **Must never access:** Settings (any), billing, role management.

### `receptionist`

- **Who in a real salon:** Front-desk staff whose job is moving clients through the queue accurately and quickly.
- **Typical actions:** Create, edit, cancel, complete, and no-show bookings; manage the walk-in queue; search clients. Stays entirely within the operational desk — no settings, no reports, no profile edits.
- **Must never access:** Settings, reports, client profile editing (VIP status, notes), staff management.

### `nail_tech`

- **Who in a real salon:** Service provider primarily working from the chair; may glance at assignments between clients.
- **Typical actions:** Read schedules and assignments; optionally assist with **low-risk intake** only where policy explicitly permits (today: favor **read-only**; destructive or calendar-defacing actions belong to desk roles).
- **Must never access:** Destructive schedule edits, cancellations, salon configuration, financial administration, exports, or permission management.

---

## 3. Permission matrix

Interpretation hints:

- **Desk** refers to Receptionist Center (front desk timeline + queue) and tightly related drawers.
- **Owner home** refers to salon overview surfaces aimed at proprietors when distinct from desk-only chrome.
- **Settings** aggregates profile, hours, services, staff, and permissions UX even if surfaced from multiple routes today.

Where a cell is **Partial**, an italic note explains bounds.

### 3.1 Quick-reference summary

| Area | owner | admin | senior | receptionist | nail_tech |
| --- | :---: | :---: | :---: | :---: | :---: |
| **Booking operations** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Walk-in queue** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Client search** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Client profile editing** (name, VIP, notes) | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Staff management** (CRUD) | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Grant / revoke admin role** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Booking settings** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Services & pricing** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Voice AI settings** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **No-show protection settings** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Brand & domain** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Public page editor** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Reports & analytics** | ✅ | ✅ | ✅ | ❌ | ❌ |
| **Dashboard modules config** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Change salon vertical** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Billing / Stripe subscription** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Stripe Connect setup** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Archive / transfer salon** | ✅ | ❌ | ❌ | ❌ | ❌ |

---

### 3.2 Booking operations — desk / calendar mutations

| Action | owner | admin | senior | receptionist | nail_tech |
| --- | --- | --- | --- | --- | --- |
| View all bookings (desk scope / tenant bookings the product loads for operations) | Yes | Yes | Yes | Yes | Yes |
| Create booking _(desk: walk-in / manual intake paths)_ | Yes | Yes | Yes | Yes | Partial — _intake only if/WHEN explicitly allowed; server must converge to matrix_ |
| Edit booking _(any teammate's appointment)_ | Yes | Yes | Yes | Yes | No |
| Edit **past** booking _(after the appointment end time)_ | Yes | Yes | Yes | No | No |
| Cancel booking | Yes | Yes | Yes | Yes | No |
| Mark no-show | Yes | Yes | Yes | Yes | No |
| Reschedule booking | Yes | Yes | Yes | Yes | No |
| Complete booking | Yes | Yes | Yes | Yes | No |

Operational alignment: **`nail_tech` is primarily read/consume on the mutable schedule.** Any exception for lightweight intake stays **narrow, explicit, and server-guarded.**

`receptionist` has full forward-facing desk authority (create / edit / cancel / no-show / complete) but cannot retroactively edit past bookings — that requires `senior` or above.

---

### 3.3 Queue — walk-ins and ordering

| Action | owner | admin | senior | receptionist | nail_tech |
| --- | --- | --- | --- | --- | --- |
| Add walk-in | Yes | Yes | Yes | Yes | Partial — _mirror "create booking"; default **No** until product explicitly adopts tech-assisted intake_ |
| Reorder queue _(manual urgency / drag priority when supported)_ | Yes | Yes | Yes | Yes | No |
| Assign staff to walk-in / slotting from queue | Yes | Yes | Yes | Yes | No |

FIFO or algorithmic urgency may order the queue automatically; **manual reorder** remains a desk action. Both `receptionist` and `senior`+ can do this.

---

### 3.4 Client management

| Action | owner | admin | senior | receptionist | nail_tech |
| --- | --- | --- | --- | --- | --- |
| Search / look up client | Yes | Yes | Yes | Yes | No |
| View client profile (booking history, spend) | Yes | Yes | Yes | Partial — _booking history view only; no VIP/notes/spend tabs_ | No |
| Edit client name / phone on profile | Yes | Yes | Yes | Yes | No |
| Edit VIP status / notes on client profile | Yes | Yes | Yes | Yes | No |
| View client spend / lifetime value | Yes | Yes | Yes | No | No |

---

### 3.5 Staff management

| Action | owner | admin | senior | receptionist | nail_tech |
| --- | --- | --- | --- | --- | --- |
| View staff list | Yes | Yes | Yes | No | No |
| Add / remove staff | Yes | Yes | No | No | No |
| Edit staff services / capabilities | Yes | Yes | No | No | No |
| Invite staff (send onboarding) | Yes | Yes | No | No | No |
| Grant / revoke `senior` or `receptionist` or `nail_tech` role | Yes | Yes | No | No | No |
| Grant / revoke **`admin`** role | Yes | **No** | No | No | No |
| Transfer ownership | Yes | No | No | No | No |

`admin` can do all staff management **except** elevating someone to `admin` or higher. This prevents role self-replication.

---

### 3.6 Dashboard — workspace & modules

| Action | owner | admin | senior | receptionist | nail_tech |
| --- | --- | --- | --- | --- | --- |
| View KPI band / condensed stats on surfaces they legitimately route to | Yes | Yes | Yes | Yes | Yes |
| View revenue _(per-client prices on blocks, totals when enabled)_ | Partial — _toggled by salon desk modules_ | Partial — _same_ | Partial — _same_ | Partial — _same_ | Partial — _same_ |
| Change workspace preset _(layout density / saved desk arrangement)_ | Yes | Yes | Partial — _personal preset only_ | Partial — _personal preset only_ | Partial — _read-only or inherit desk default_ |
| Toggle **salon-wide** dashboard modules | Yes | Yes | No | No | No |
| Activity feed & audit log | Yes | Yes | No | No | No |

---

### 3.7 Settings — booking & operations configuration

| Action | owner | admin | senior | receptionist | nail_tech |
| --- | --- | --- | --- | --- | --- |
| Booking lead time / OTP / verification mode | Yes | Yes | No | No | No |
| No-show protection settings | Yes | Yes | No | No | No |
| Walk-in queue settings | Yes | Yes | No | No | No |
| Win-back / segments / referral program | Yes | Yes | No | No | No |
| Voice AI settings (persona, features) | Yes | Yes | No | No | No |

---

### 3.8 Settings — catalog & business configuration

| Action | owner | admin | senior | receptionist | nail_tech |
| --- | --- | --- | --- | --- | --- |
| Edit salon profile _(name, phones, branding fields, closures)_ | Yes | Yes | No | No | No |
| Edit hours | Yes | Yes | No | No | No |
| Edit services / catalog | Yes | Yes | No | No | No |
| Edit pricing | Yes | Yes | No | No | No |
| Brand color + theme mode | Yes | Yes | No | No | No |
| Domain connection | Yes | Yes | No | No | No |
| Public page editor (sections, content) | Yes | Yes | No | No | No |
| **Change salon vertical** _(nail salon → head spa → etc.)_ | Yes | **No** | No | No | No |

---

### 3.9 Settings — permissions & role management

| Action | owner | admin | senior | receptionist | nail_tech |
| --- | --- | --- | --- | --- | --- |
| View membership list | Yes | Yes | No | No | No |
| Assign `senior` / `receptionist` / `nail_tech` role | Yes | Yes | No | No | No |
| Assign `admin` role | Yes | **No** | No | No | No |
| Archive salon | Yes | **No** | No | No | No |

---

### 3.10 Billing & payment infrastructure

| Action | owner | admin | senior | receptionist | nail_tech |
| --- | --- | --- | --- | --- | --- |
| View billing / subscription status | Yes | **No** | No | No | No |
| Change plan / manage subscription | Yes | **No** | No | No | No |
| Stripe Connect setup / disconnect | Yes | **No** | No | No | No |
| View payment processing settings | Yes | **No** | No | No | No |

All rows in this section are **owner-only without exception.**

---

### 3.11 Reporting & export

| Action | owner | admin | senior | receptionist | nail_tech |
| --- | --- | --- | --- | --- | --- |
| View daily summary | Yes | Yes | Yes | Partial — _desk stats only; no revenue_ | Partial — _read-only glimpses consistent with routed UI_ |
| View revenue report _(historical aggregates)_ | Yes | Yes | Yes | No | No |
| View utilization / booking-source report | Yes | Yes | Yes | No | No |
| Export data _(CSV / ledger / hand-off)_ | Yes | Yes | No | No | No |

---

## 4. Future role definitions _(planned scope only — not shipped)_

These roles extend the matrix later as **additional columns**. Existing roles stay stable.

### `manager`

- **Scope intent:** Multi-shift floor manager: full desk powers like `senior`, plus **delegated subset** of owner tasks (not full tenancy transfer) — e.g., staff overrides, approvals, refunds when POS lands, curated reports. Likely sits between `admin` and `senior` once differentiated.

### `trainee`

- **Scope intent:** Probationary desk access — **paired actions**, limited cancellation/reschedule powers, immutable audit trail of overrides; optionally **scoped "own edits only"**.

### `viewer`

- **Scope intent:** Accountant, partner, auditor — read dashboards/reports/export **within granted slices**, **no** mutations, **no** PII-heavy exports unless explicitly toggled later.

### `accounting`

- **Scope intent:** Finance role with **reporting/export** privileges and separation from chair/desk throughput tools; explicitly **non-operational**.

---

## 5. Transition rules

### Assignment

- **Changing** a member's salon role is an **ownership-level** privilege (explicit owner-only tooling or supervised admin flows).
- `admin` may assign roles up to and including `senior` — they cannot self-replicate `admin` or higher.
- Invitations and onboarding may create membership, but role elevation above `senior` must satisfy owner policy.

### One role per user per salon

- A single user carries **exactly one** membership role **per salon**.
- Users may belong to **multiple salons** with **different** roles in each — that is not multiple roles within one salon.

### Ownership transfer

- Transfer is a **destructive-privilege sequence**: designate a **single** new owner, demote outgoing owner to a non-owning role (commonly `admin`/`senior`/`viewer`), and re-run permission caches if applicable.
- Invariant: **at least one** `owner` (or contractual successor documented in product/legal) before outgoing owner loses owner powers.
- Sensitive exports and integration secrets should rotate or be re-affirmed during transfer (**policy**, not UX detail).

---

## 6. UI enforcement rules

### Hidden vs disabled vs visible‑but‑locked

| Pattern | Use when |
| --- | --- |
| **Hidden** | Action is meaningless or unsafe for role; avoids clutter (**prefer** over disabled for rare/destructive items). |
| **Disabled (+ explanation)** | User should know capability exists salon-wide but **not for them**, or dependencies block it (hours closed, conflicting state) — pair with textual reason. |
| **Visible-but-locked** | Training mode / upgrade path / rare discoverability ("Ask owner") — still needs clear affordance explaining **why** |

### Error when unauthorized attempted

Follow `docs/UX_PRINCIPLES.md §6 (Errors)` and **`Trust through feedback`**:

- Prefer **explicit** failure over silent no-ops when a server action rejects.
- Message pattern: short **cause** ("You don't have permission to cancel bookings.") + **next step** ("Ask an owner or admin.") — localized copy via product i18n.

### No silent failures

Blocked writes, suppressed buttons that still enqueue network work, optimistic UI that cannot reconcile — all violate operational trust.

---

## 7. Server action contract _(mutating entry points)_

Every **mutating** server-side entry handler (conceptually: booking/queue/catalog/settings/export triggers) MUST:

1. **Verify membership** — caller is authenticated and tied to **the salon targeted by the invocation** via authoritative membership resolution (never trust identifiers alone without membership join).
2. **Check role** — compare resolved role against §3 Permission matrix (this document evolves as source of intent).
3. **Return typed errors** using exactly:
   - **`unauthorized`** — caller could not be established as an eligible member **for this salon/context** session (wrong tenant target, spoofed linkage, revoked session — **product maps all to humane copy**, not ambiguous empty success).
   - **`forbidden`** — membership verified, **role insufficient** for the action.

   Stable string codes survive UI refactors so clients map consistently to localization keys.

4. **Never trust client-supplied role** — role hints from the browser are informational only; authoritative role is always **derived server-side**.

5. **Idempotency-conscious outcomes** — where duplicate taps are likely at the desk (`docs/UX_PRINCIPLES.md`: fast under pressure), return deterministic errors instead of ambiguous empty success.

Recommended extension points for future roles: central **pure policy functions** keyed by `{ actionId, role }` so matrices and audits stay coherent as columns accrue (`manager`, `trainee`, `viewer`, `accounting`, …).

---

## 8. Superadmin roles _(platform-level, added 2026-05-10)_

**Scope clarification.** Sections §1–§7 govern **salon-scoped** roles: `owner`, `admin`, `senior`, `receptionist`, `nail_tech`. Those control what a member can do **inside one salon**. This §8 introduces a separate, **platform-scoped** role axis for internal NailIQ operators: support staff, billing analysts, founders. A single human may carry both — Huy is simultaneously `owner` of his pilot salon **and** `founder` of NailIQ — but the two axes are evaluated independently.

Foundation lands incrementally; this section names the stable contract so future routes do not relitigate it.

### 8.1 Storage

PR #82 (2026-05-10) shipped `public.superadmins` as a binary membership table — presence of a row grants access to `/superadmin/*`. Foundation V1 evolves this **additively**:

- **Add column `role text not null default 'founder'`** with `CHECK (role IN ('founder', 'ops_admin', 'support_admin', 'billing_admin', 'ai_admin', 'readonly_analyst'))`.
- **Add column `revoked_at timestamptz`** — soft delete; non-null rows are inert.
- **Add column `created_by uuid references auth.users(id)`** — audit who promoted.
- Existing rows (Huy) are backfilled to `role = 'founder'`.
- RLS unchanged: `superadmins_self_read` still gates `select` to `auth.uid()` only. Writes remain service-role-only.

The companion table `superadmin_audit_logs` (Phase 1A migration) records every mutating `/superadmin/*` action and every impersonation enter/exit.

### 8.2 Role definitions

| Role | Purpose | Scope |
| --- | --- | --- |
| `founder` | Full platform access. The **only** role permitted to impersonate (see §8.4) during Foundation V1. | All `/superadmin/*` routes, all mutations, impersonation. |
| `ops_admin` | Day-to-day operations: incidents, system health, feature flags, rollouts. | Operations + Support routes; no billing, no AI ops, no impersonation. |
| `support_admin` | Salon-facing support: read salon health, view audit logs, message owners. | Salons + Support routes; **no** impersonation in Foundation V1 (granted via amendment after PM review). |
| `billing_admin` | Subscription state, MRR, billing overrides, refund coordination. | Billing routes only; no salon data mutations. |
| `ai_admin` | AI prompts, performance metrics, cost ceilings. | AI Ops routes; read-only on operational data. |
| `readonly_analyst` | Platform analytics dashboards. | Analytics routes; **no** mutations anywhere. |

### 8.3 Route gate

Every page and server action under `/superadmin/*` MUST resolve the caller's superadmin role server-side via `getSuperadminRole(userId): SuperadminRole | null`. The contract:

- `null` → caller is not a superadmin. Page returns 404 (do not leak existence). Server action returns `unauthorized`.
- Role string → caller is a superadmin of that tier. Cross-check against the route's allowed-roles list. Mismatch → server action returns `forbidden`.
- `revoked_at IS NOT NULL` → treated as `null` (revoked).
- Cache: process-local Map with TTL ≤ 5 min, identical to the existing `isSuperAdmin` cache pattern. `clearSuperadminCache(userId)` invalidates on role change.

The proxy's existing `/superadmin → /login` redirect for unauthenticated users stays. The role check happens **inside** server components and server actions, not in the proxy — keeping membership logic in one canonical place per `CLAUDE.md`.

### 8.4 Impersonation (login-as-salon)

A `founder` may impersonate any salon `owner` for support purposes. This is the highest-risk operation on the platform and is governed strictly.

- **Server-side cookie swap only.** A dedicated server action issues a new Supabase session cookie bound to the target salon's owner `auth.users.id`, via the service-role client. **No client-side hacks. No fake JWT mint.** The receptionist/owner dashboard sees a real owner session.
- **Audit row on every transition.** Enter and exit each insert into `superadmin_audit_logs` with `actor_user_id`, `action ∈ {'impersonate_enter', 'impersonate_exit'}`, `target_salon_id`, `target_user_id`, `started_at`, `ended_at`, `reason` (free text, founder-supplied).
- **Persistent banner required.** While impersonating, every page under `/dashboard/[slug]/*` renders a top-of-viewport banner: `You are viewing <salon-name> as <role>` plus an explicit Exit button. Banner cannot be dismissed without exiting. Banner z-index sits above sticky chrome and below modal scrims (see `DASHBOARD_LAYOUT_RULES.md` §10.5).
- **Time-limited.** Impersonation cookie carries a 30-minute hard expiry. After expiry, the next mutating action fails with `forbidden` and prompts re-impersonation.
- **Read-only mode option.** A boolean flag on the impersonation action that gates all mutating server actions to return `unauthorized` while the flag is set. Useful for "just want to see what they see, do not touch."
- **`founder`-only initially.** No other role may invoke impersonation in Foundation V1. Extension to `support_admin` is a deliberate future amendment, not a permission creep.
- **No silent impersonation.** If the audit log insert fails for any reason, the impersonation **does not proceed**. The system fails closed.

### 8.5 Server action contract _(additive to §7)_

Every mutating server action under `/superadmin/*` MUST:

1. **Verify superadmin membership** via `getSuperadminRole(userId)`. `null` → `unauthorized`.
2. **Verify role tier** against the action's allowed-roles list. Mismatch → `forbidden`.
3. **Verify target tenant** when the action mutates a salon: confirm the salon exists; in impersonation paths confirm an `owner` exists for the target salon.
4. **Write an audit row to `superadmin_audit_logs`** before returning. Schema: `id`, `actor_user_id`, `actor_role`, `action`, `target_kind` (`salon` / `user` / `flag` / `announcement` / …), `target_id`, `before_jsonb`, `after_jsonb`, `created_at`. If the audit write fails, the mutation **does not proceed** — superadmin actions are audit-or-rollback.
5. **Never bypass `salon_members`** when reading salon data. Service-role bypass is reserved for the impersonation cookie swap itself and for audit-log inserts.

### 8.6 UI gating

- Sidebar navigation items the current role cannot reach are **disabled, not hidden** (see `DASHBOARD_LAYOUT_RULES.md` §10.3 disabled-module pattern). Hiding obscures the roadmap; disabling teaches the role boundary.
- Mutating buttons under a role's reach but for which the **target state** disallows the action (e.g. impersonating a salon that has `superadmin_locked_at` set) remain visible and disabled, with explanatory copy per §6.

### 8.7 Out of scope for Foundation V1

The following are deliberately deferred to Phase 2 or later amendments:

- Multi-role-per-user mixing (`founder + billing_admin` blends): one role per superadmin row.
- Time-windowed roles (auto-revoke after N days): manual `revoked_at` only.
- Role-aware impersonation (`support_admin` impersonation): `founder`-only until separate PM review.
- Audit log read API for non-superadmins: audit log is superadmin-internal.

---

*Operational software fails loudly at the boundaries of authority; NailIQ's desk depends on predictable enforcement under Friday-evening pressure. The platform tier depends on predictable enforcement under audit.*
