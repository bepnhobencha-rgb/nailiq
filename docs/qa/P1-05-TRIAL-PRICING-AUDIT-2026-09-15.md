# P1-05 — Trial, pricing and manual billing acceptance

Date: 2026-09-15

Production baseline at audit start: `d03dfabb829cd12385df61d4e27f22b57bc802fd`

Worktree: `/Users/huytran/nailiq-p1-05-trial-pricing-20260915`

Branch: `audit/p1-05-trial-pricing-20260915`

## Result

**LOCAL, HOSTED QA AND PUBLIC PREVIEW PASS. PR CI IS PENDING; PRODUCTION IS
UNCHANGED AND NOT VERIFIED.**

The approved V1 policy is now implemented locally: a 14-day trial, a seven-day
continuity window for appointments created before expiry, then read-only core
operations. Core is $39 CAD/month, Studio is $99 CAD/month, V1 activation is
manual, and trial expiry never deletes salon data.

No Production data, live-salon configuration, provider, payment, email, SMS or
call was changed. The candidate is isolated in PR #1411; it has not been
merged or deployed to Production.

## Existing before this task

| Area | Existing behavior | Evidence |
| --- | --- | --- |
| Trial creation | New self-service salons received a server-authored 14-day window and `free` / `trialing` state. | `completeSalonRegistrationAction.ts`, `trial.ts` |
| Prices | Canonical catalog exposed Core $39 and Studio $99. Production landing displayed Core $39 after a 14-day no-card trial. | `pricingCatalog.ts`; read-only browser check on `nailiq.ca` |
| V1 billing | Automated checkout, Customer Portal and subscription event processing were fail-closed. Settings directed owners to NailIQ. | `v1IntegrationScope.ts`, `stripeActions.ts`, `PricingPanel.tsx` |
| Trial UX | Dashboard showed remaining trial days, but expiry was copy only. | `dashboard/[slug]/layout.tsx` |
| Paid recovery | `past_due` had a separate atomic payment-grace pause. | `pause_tenant_if_payment_grace_expired` |

## Root cause

Trial dates were registration metadata and banner copy, not a shared
entitlement state. At expiry, `trialDaysRemaining()` returned zero while the
tenant remained `trialing`. Public booking, desk mutations, cron workers,
AI/voice and outbound paths had no common resolver for active trial,
continuity and read-only states. The public promise that paid features pause
therefore did not match runtime behavior.

## Implemented locally

1. Added a typed resolver for `legacy`, `active_trial`, `trial_continuity`,
   `trial_read_only`, `active`, `past_due`, `canceled`, `archived`, `locked`
   and `unknown`, with narrow capability booleans.
2. Added the versioned `trial_expiry_policy_version = 1` receipt only to newly
   registered salons. Existing tenants, including both live Hi-Lite tenants,
   are not bulk-enrolled or changed by the migration.
3. Added database enforcement for new bookings, core operational writes and
   new charge-operation claims. The booking boundary returns SQLSTATE `NITRL`
   with `trial_new_booking_paused`; refunds remain available.
4. Preserved exact idempotent booking replays before the expiry gate. A request
   already committed remains recoverable without a duplicate insert.
5. Added the public boolean-only booking capability RPC. Anonymous callers
   cannot read internal trial or billing metadata.
6. Mapped expiry into individual, group, sequence, walk-in and desk booking
   flows with friendly English and Vietnamese copy.
7. Paused autonomous AI, booking chat, voice, marketing campaigns, manual
   client messages and card-link sends after expiry. Transactional reminders
   remain available only for bookings created before expiry during continuity.
8. Added truthful dashboard banners for continuity and read-only states.
9. Kept manual V1 billing and the existing canonical prices unchanged.

## Policy behavior

| State | New bookings | Existing bookings | Reminders | AI/voice/marketing | New charge claim | Data |
| --- | --- | --- | --- | --- | --- | --- |
| Active trial | Allowed | Allowed | Allowed | Allowed when separately enabled | Allowed when separately authorized | Read/write |
| Continuity, day 0–7 | Blocked | Pre-expiry appointments can be completed, canceled or rescheduled | Pre-expiry appointments only | Blocked | Blocked | Core operational catalog paused |
| Read-only, day 7+ | Blocked | View only | Blocked | Blocked | Blocked | Retained and view/export available |
| Existing unmarked tenant | Existing behavior | Existing behavior | Existing behavior | Existing behavior | Existing behavior | No migration enrollment |

Archived and superadmin-locked states always override the legacy marker and
remain closed. A malformed enrolled trial date fails closed to read-only while
keeping data visible.

## Verification evidence

### Unit and contract tests

- Full suite: **836 files passed, 6 skipped; 6,332 tests passed, 65 skipped;
  0 failed**.
- Final focused regression set after the last race/error mapping change:
  **194 passed, 0 failed**.
- The full suite exposed four regressions during implementation. They were
  corrected: malformed archive/lock state is fail-closed, booking chat receives
  trial metadata, and the Coco registration contract expects the composed
  feature flags.

### Disposable Supabase QA local

- `supabase db reset --local --no-seed --yes`: PASS from the full migration
  history through `20260915143000`.
- Synthetic SQL acceptance: PASS for active trial, exact expiry continuity,
  day-seven read-only, legacy compatibility, archived-state precedence,
  booking replay/service continuity, booking rejection, operational-write
  rejection and charge rejection.
- Fixture transaction ended in `ROLLBACK`; remaining `qa-trial-*` salon rows:
  **0**.
- RPC permissions: `anon` internal entitlement RPC = **false**; `anon` public
  boolean capability RPC = **true**; `service_role` internal RPC = **true**.
- Database lint: no new error; repository migration history still reports its
  pre-existing warning set.
- The final intentional anonymous `SECURITY DEFINER` allowlist check passed
  after registering the new boolean-only capability RPC. Its grants are
  restricted to `anon` and `service_role`; `authenticated` has no execute
  grant.

### Disposable hosted Supabase QA

- Explicit project ref: `osdqutwunokiielbairj` (QA disposable). Provider
  notifications, SMS, email, calls and payment charge dispatch remained off.
- Migration `20260915143000_add_versioned_trial_entitlement_boundary.sql`:
  applied successfully; five functions and seven enforcement triggers were
  present.
- Synthetic state matrix: active fixture resolved to `active_trial` and
  accepted bookings; expired-by-one-day fixture resolved to
  `trial_continuity` and rejected new bookings; expired-by-eight-days fixture
  resolved to `trial_read_only` and rejected new bookings.
- Marker validation is strict and aligned across TypeScript and SQL: only the
  numeric JSON value `1` enrolls the tenant. The string `"1"` does not.
- Public RPC grants: `anon = true`, `authenticated = false`,
  `service_role = true`.

### Browser acceptance

- Exact candidate Preview for commit `eba60ab4`:
  `https://nailiq-sdk-save-qa-20260912-9x2fhcgsx.vercel.app` (Ready).
- Desktop public active-trial booking loaded the salon and phone step.
- Desktop public continuity booking showed the Vietnamese booking-paused
  state. This check exposed unreadable light-theme text; the component was
  corrected to use booking theme tokens and regression-covered.
- Desktop authenticated dashboard against the hosted QA database showed the
  correct Vietnamese continuity and read-only banners.
- Mobile Chromium at 390 x 844 passed active public booking, paused public
  booking, read-only dashboard and continuity dashboard, with no horizontal
  overflow.
- The hosted Preview login form could not complete because the QA Vercel
  project does not configure the `auth-attempt` rate-limit ID. The security
  gate was not weakened. Authenticated dashboard rendering was therefore
  verified with the local application connected to the disposable hosted QA
  database, not through Preview authentication.

### Build gates

- `npm run lint`: **0 errors**, 40 existing repository warnings.
- `npm run build`: **PASS** with Next.js 16.3.4 production build.
- `npm run typecheck` after the build: **PASS**.
- `npm ci`: 452 packages audited, **0 vulnerabilities**.
- Vercel Preview build and its sequential typecheck: **PASS** for the exact
  `eba60ab4` candidate.

The first build attempt failed because this isolated worktree's `node_modules`
was a symlink outside the Turbopack filesystem root. Replacing it with a local
`npm ci` install fixed the environment; no application workaround or build
setting was changed.

## Deployment and rollback boundary

Migration must be applied before the application build. If the application is
deployed first, the public capability read fails closed and public booking will
appear paused until the RPC exists.

Rollback is additive and bounded:

1. Stop enrollment by reverting the registration marker change.
2. Revert application capability checks.
3. Apply a new reversal migration that drops the P1-05 triggers and functions;
   do not edit an already-applied migration.
4. Do not delete or rewrite tenant data. Existing tenants were never enrolled
   by this migration.

## Remaining release gates

- PR #1411 contains the candidate; final security allowlist update is pending
  commit/push at the time of this audit edit.
- CI must be green on the final head SHA. The prior run correctly rejected the
  new anonymous `SECURITY DEFINER` function until it was registered in the
  reviewed allowlist.
- Preview authentication remains environment-blocked by the missing QA
  rate-limit binding; public Preview and authenticated local-app/hosted-QA
  evidence are recorded separately.
- Production deploy and both-live-salon verification: not done.

## Classification

- Existing before task: verified.
- Implemented locally: **PASS**.
- Local disposable database: **PASS**.
- Full unit/lint/build/typecheck: **PASS**.
- Hosted QA tested: **PASS**.
- Public Preview verified: **PASS**.
- Authenticated dashboard with hosted QA data: **PASS via local app**.
- Authenticated dashboard through Preview login: **NOT PROVEN — QA
  rate-limit configuration blocks sign-in**.
- Deployed: **NO**.
- Production verified: **NO**.
- P1-05 release-ready now: **FAIL until final PR CI passes and the Preview-auth
  infrastructure limitation is accepted or repaired**.
