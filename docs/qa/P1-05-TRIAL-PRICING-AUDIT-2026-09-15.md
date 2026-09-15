# P1-05 — Trial, pricing and manual billing acceptance

Date: 2026-09-15

Production baseline at audit start: `d03dfabb829cd12385df61d4e27f22b57bc802fd`

Worktree: `/Users/huytran/nailiq-p1-05-trial-pricing-20260915`

Branch: `audit/p1-05-trial-pricing-20260915`

## Result

**LOCAL IMPLEMENTATION PASS. QA PREVIEW AND PRODUCTION ARE NOT YET VERIFIED.**

The approved V1 policy is now implemented locally: a 14-day trial, a seven-day
continuity window for appointments created before expiry, then read-only core
operations. Core is $39 CAD/month, Studio is $99 CAD/month, V1 activation is
manual, and trial expiry never deletes salon data.

No Production data, live-salon configuration, provider, payment, email, SMS or
call was changed. Nothing in this worktree has been committed, pushed, merged
or deployed.

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

### Build gates

- `npm run lint`: **0 errors**, 40 existing repository warnings.
- `npm run build`: **PASS** with Next.js 16.3.4 production build.
- `npm run typecheck` after the build: **PASS**.
- `npm ci`: 452 packages audited, **0 vulnerabilities**.

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

- Commit/push and PR review: not done.
- CI: not run on this candidate.
- Disposable hosted QA migration: not applied.
- Vercel Preview desktop/mobile browser acceptance: not run.
- Production deploy and both-live-salon verification: not done.

## Classification

- Existing before task: verified.
- Implemented locally: **PASS**.
- Local disposable database: **PASS**.
- Full unit/lint/build/typecheck: **PASS**.
- Hosted QA tested: **NOT YET**.
- Preview verified: **NOT YET**.
- Deployed: **NO**.
- Production verified: **NO**.
- P1-05 release-ready now: **FAIL until PR CI and hosted Preview acceptance pass**.
