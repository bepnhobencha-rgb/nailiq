# SuperAdmin Guide

Operator-facing playbook for the NailIQ platform console at `/superadmin/*`.
This is the **how-to**; the contract and rationale live in
[`PERMISSION_MATRIX.md` §8](./PERMISSION_MATRIX.md) and the flag model lives in
[`FEATURE_FLAGS.md`](./FEATURE_FLAGS.md). Read those for the "why"; read this
for the "how I do X today".

> **Audience.** NailIQ operators (founder, ops, support, billing, AI, analyst).
> A human can be both a salon `owner` *and* a platform superadmin — the two
> role axes are independent (see §8 intro).

---

## 1. Roles at a glance

Full definitions: [`PERMISSION_MATRIX.md` §8.2](./PERMISSION_MATRIX.md). Quick map:

| Role | Can do | Cannot do |
| --- | --- | --- |
| `founder` | Everything, incl. **impersonation** | — |
| `ops_admin` | Operations + Support (flags, incidents, health, rollouts), audit logs | Billing, AI ops, impersonation |
| `support_admin` | Salons + Support, **audit logs** | Impersonation (V1), billing mutations |
| `billing_admin` | Billing routes | Salon data mutations |
| `ai_admin` | AI Ops routes | Mutate operational data |
| `readonly_analyst` | Analytics + **audit logs** (read) | Any mutation |

Audit-log viewer is gated to `founder`, `ops_admin`, `support_admin`,
`readonly_analyst`. `billing_admin` / `ai_admin` get `forbidden`.

The role gate runs **server-side** in every page and server action — the proxy
only handles the unauthenticated `/superadmin → /superadmin/login` redirect.
Revoked rows (`revoked_at IS NOT NULL`) are treated as "not a superadmin".

---

## 2. Bootstrapping a superadmin

There is **no public registration** — operator rows are created out-of-band via
the service-role key. Two steps: create the auth user, then grant the role.

### 2.1 First founder (cold start)

The auth user usually already exists (Huy's own login). To grant it:

```sql
-- Run against the project's Postgres with the service role (Supabase SQL editor
-- or psql). Replace the email.
insert into public.superadmins (user_id, role)
select id, 'founder'
from auth.users
where email = 'you@nailiq.ca'
on conflict (user_id) do update set role = excluded.role, revoked_at = null;
```

### 2.2 Add another operator

```sql
-- 1. Create the auth user with a password (Supabase dashboard → Authentication
--    → Add user, or the admin API). They sign in with email + password.
-- 2. Grant the role:
insert into public.superadmins (user_id, role, created_by)
values ('<new-user-uuid>', 'support_admin', '<your-user-uuid>');
```

Valid roles: `founder`, `ops_admin`, `support_admin`, `billing_admin`,
`ai_admin`, `readonly_analyst`.

### 2.3 Revoke an operator

Soft delete — keeps the audit trail intact:

```sql
update public.superadmins set revoked_at = now() where user_id = '<uuid>';
```

The role cache has a ≤5-min TTL, so a revoke takes effect within ~5 minutes (or
immediately on the next cold render).

---

## 3. Signing in

1. Go to **`/superadmin/login`**.
2. Enter email + password (operators use password auth, *not* the salon OTP
   flow). On success you land on `/superadmin`.
3. Forgot password → **`/superadmin/forgot-password`** sends a reset link;
   complete it at `/superadmin/reset-password`.

> Anti-enumeration: a wrong password and "this email isn't an operator" both
> show the same generic "Sign-in failed." A salon owner who wanders to this URL
> just sees the form — never a hint that the console exists.

---

## 4. Toggling feature flags

NailIQ has **two** independent flag layers. Know which one you want.

### 4.1 Platform-wide flags — affect *every* salon

**Route:** `/superadmin/operations/feature-flags` (founder, ops_admin).
Toggling saves immediately and writes an audit row (`platform_flag_set`).

| Key | Effect when ON | Notes |
| --- | --- | --- |
| `demo_otp_enabled` | Bypasses real OTP (demo) | ⚠️ **DANGER** — asks for confirm; never enable in production |
| `stripe_billing_enabled` | Enables Stripe checkout / subscriptions | Billing |
| `sms_enabled` | Enables SMS transport (Twilio) | |
| `email_enabled` | Enables transactional email (Resend) | |
| `new_salon_registration` | Allows `/register` signup | Turn OFF to freeze new signups |

How to toggle: open the page, flip the switch on the flag's row. A "Saved ✓"
confirmation appears on success; a failure rolls the switch back and shows the
error. Danger flags pop a `window.confirm()` before enabling — check you're in
the right environment.

### 4.2 Per-salon flags — affect one salon

**Route:** `/superadmin/salons/[salonId]` → *Salon override* card. Writes an
audit row (`salon_flags_set`). This is where you force a Beta feature ON for a
single pilot salon (e.g. `group_booking_enabled: true`) or a Base feature OFF.
The full flag registry, override precedence, and key mapping are documented in
[`FEATURE_FLAGS.md`](./FEATURE_FLAGS.md) — read it before flipping per-salon
keys so you know which store (`feature_flags` JSONB vs `voice_ai_enabled`
column vs `plan_override`) each feature reads from.

### 4.3 Release features (resolved) — read-only

Directly below the override card on the same salon page sits a **read-only**
*Release features (resolved)* card. It has **no controls** — it just shows the
effective state of every release surface for this salon so you can confirm what
the overrides above actually resolve to. Each row shows the **resolved ON/OFF**,
the registry **default**, a **source** badge (`jsonb` / `column` / `plan` /
`registry`), and an **Override** badge when the salon diverges from the default.
Rows are grouped **Base**, **Beta**, and **Plan / Column-controlled**.

> Reminder shown on the card: *release flags control product visibility, not
> billing.* To actually change a value, use the Overrides card above (§4.2).

---

## 5. Reading the audit log

**Route:** `/superadmin/support/audit-logs`. An append-only, newest-first trail
of every mutating SuperAdmin action — the system is **audit-or-rollback**: if
the audit write fails, the mutation does not proceed (§8.5).

What's recorded today (`KNOWN_AUDIT_ACTIONS`):

`impersonate_enter` · `impersonate_exit` · `impersonate_expire` ·
`salon_flags_set` · `record_restore` · `platform_flag_set` · `category_add` ·
`category_update` · `category_delete`.

Each row shows **when** (UTC + relative), **actor** (email + role snapshot),
**action**, **target**, **reason**, and an expandable **View diff** showing the
before → after field changes. Filter by action verb, actor, target kind, or
date range; paginate 50 rows at a time.

> Unknown action verbs (shipped before the label list is updated) still render
> — just without a colour accent. A `NULL` actor shows "(deleted user)".

**Verifying a change you just made:** toggle a flag, then open the audit log —
the newest `platform_flag_set` (or `salon_flags_set`) row should carry your
email and a diff whose `enabled` (or flag key) flips to the value you set.

---

## 6. Impersonation (founder only)

Logging in as a salon owner for support is the highest-risk action and is
governed strictly — read [`PERMISSION_MATRIX.md` §8.4](./PERMISSION_MATRIX.md)
before using it. Key guarantees: server-side cookie swap (no fake JWTs), a
non-dismissable banner while active, a 30-minute hard expiry, an optional
read-only mode, and an audit row on every enter/exit. If the audit insert
fails, impersonation **does not start** (fail-closed).

---

## 7. How this is tested

- **Release-flag resolver + read-only panel helper** (unit):
  `src/shared/features/__tests__/featureRegistry.test.ts` — run
  `npx tsx src/shared/features/__tests__/featureRegistry.test.ts`. Covers the
  resolver and `describeReleaseFeatureForSalon` / `describeReleaseFeaturesForSalon`.
- **Read-only salon release-features panel** (e2e):
  `e2e/superadmin/salon-release-features.spec.ts` — seeds a salon with two
  overrides, logs in as a founder, and asserts the panel, groups, copy, and
  override badges render.
- **Per-salon route gating** (e2e): `e2e/feature-flags/route-gating.spec.ts`.
- **Platform-flag toggle + audit trail** (e2e):
  `e2e/superadmin/feature-flag-toggle.spec.ts` — logs in as a seeded founder,
  toggles `sms_enabled` ON then OFF, asserts `platform_flags` persistence, the
  `platform_flag_set` audit rows, and that the viewer surfaces them with a diff.
- **Auth + service-role readers** for superadmin specs:
  `e2e/helpers/superadmin.ts` (`seedTestSuperadmin`, `loginAsSuperadmin`,
  `getPlatformFlag`, `getLatestAuditLog`, …). Reuse these for any new
  authenticated superadmin e2e.

Run the superadmin e2e suite:

```bash
npx playwright test e2e/superadmin --project=chromium
```

> ⚠️ **Platform-flag E2E mutates global state.** `feature-flag-toggle.spec.ts`
> flips a platform-wide flag (`sms_enabled`) that affects **every** salon.
> Use a **staging Supabase project** for routine E2E. The test is **skipped by
> default on the production DB** (detected via `VERCEL_ENV=production` or the
> prod project ref in `NEXT_PUBLIC_SUPABASE_URL`). To run it against production
> deliberately, set `ALLOW_PROD_PLATFORM_FLAG_E2E=true` — it still
> capture-and-restores the original flag value, but you assume the
> brief-window risk on live data.
