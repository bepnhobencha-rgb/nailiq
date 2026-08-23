# NailIQ 1.0.0-rc.1 release record

## Decision and ownership

| Field | Value |
|---|---|
| Product version | `1.0.0-rc.1` |
| QA Lead | John |
| Engineering / Release Owner | John |
| Decision date | 2026-08-21 America/Vancouver |
| Current state | `LOCAL_CANDIDATE_NOT_IMMUTABLE` |

### Product scope decision — 2026-08-22

The Product Owner selected **option 2: full-feature launch required**. AI,
Google Analytics and Facebook attribution, tips/commission, multi-location,
and Square payment/loyalty/gift-card/inventory remain mandatory release scope.
None may be marked not applicable or excluded merely to reach Pilot V1.

This makes the current candidate `NO_GO` until each included feature has its
required local, sandbox/provider, deployment and production-like evidence. The
scope decision does not authorize commit, push, merge, deploy, provider calls,
outbound messages, payments or production/live-salon mutations.

The version and owners were explicitly approved by the product owner. This
record assigns the release-candidate identity locally; it does not claim that
the dirty worktree is an immutable artifact, deployed, or production-approved.

### Multi-location product decision — 2026-08-22

The Product Owner approved an explicit **salon-chain organization model**.
Unlinked salons remain isolated; existing salons and customer profiles are
never auto-shared. Within one explicit organization, staff identity, actively
consented customer profiles, chain loyalty, and branch/organization reporting
may be shared. The local fail-closed schema and concurrency contract are
`PASS_LOCAL` for MQA-0050 and MQA-0183 through MQA-0186. No chain-management UI,
remote migration, provider synchronization, or deployed acceptance is claimed.

### Tip and commission product decision — 2026-08-22

The Product Owner approved verified tips as 100% staff-owned, split across
multiple staff in proportion to after-discount service value. Commission is an
estimate only—not payroll or payout—and is calculated from after-discount
service revenue excluding tax and tips. Rates are salon-owner configured and
effective-dated; no product default is inferred. Refunds and manual adjustments
are immutable audited reversal entries.

### Inventory product decision — 2026-08-22

The Product Owner approved Square `CatalogItemVariation` and `InventoryCount`
as the source of truth for retail products and bound-location quantities.
NailIQ may mirror that provider state, but each retail mapping requires explicit
salon confirmation. V1 does not automatically deduct service ingredients and
does not model recipes or bundles. This decision does not enable provider calls
or authorize sandbox, production or live-salon mutations.

The candidate branch is `audit/guided-p0-batch-20260819-resume`. Its current
committed base is `de4c6bcd1459bd372fd31239d2be606d6efc8173`, but the release
candidate includes uncommitted changes and therefore has no exact candidate SHA
yet. Production remains on the known-good rollback target
`dpl_8DDqNon5zMDgX3c81WwWWzNWwL5J` / `9b4edbcf8b18fbf3394dd927bc22cc4395ffd4f2`.

No commit, push, merge, migration, provider call, outbound message, or deploy is
authorized by this record.

## Candidate database delta

The local working candidate contains 30 new migration files beyond
`origin/main` (nine are still untracked because no commit is authorized):

1. `20260820055259_complete_existing_owner_registration_setup.sql`
2. `20260820062352_harden_setup_catalog_mutation_rls.sql`
3. `20260820064326_protect_guided_admin_setup_rollout_flag.sql`
4. `20260820083748_authorize_public_booking_pricing.sql`
5. `20260820105820_authorize_group_booking_pricing.sql`
6. `20260820123000_add_booking_confirmation_retry_contract.sql`
7. `20260820131500_add_customer_booking_transition_email_outbox.sql`
8. `20260820140000_add_action_scoped_booking_management_capabilities.sql`
9. `20260820143000_add_action_scoped_waitlist_claim_capabilities.sql`
10. `20260820150000_add_authoritative_booking_payment_operations.sql`
11. `20260820180036_add_authoritative_booking_service_sequences.sql`
12. `20260820211503_add_authoritative_financial_report_contract.sql`
13. `20260820223000_add_square_capability_operations.sql`
14. `20260820230000_add_current_auth_session_validation.sql`
15. `20260820233000_harden_authenticated_salon_column_access.sql`
16. `20260820234500_add_durable_sms_consent_suppression.sql`
17. `20260821000752_enforce_booking_vacation_and_resource_capacity.sql`
18. `20260821003000_add_immutable_booking_confirmation_dispatch_envelopes.sql`
19. `20260821003932_add_durable_staff_action_notification_outbox.sql`
20. `20260821012837_revoke_browser_table_control_privileges.sql`
21. `20260821014500_harden_guided_admin_setup_qa_rollout.sql`
22. `20260821223033_enable_bookings_realtime.sql`
23. `20260822001500_realtime_availability_revisions.sql`
24. `20260822023000_batch_edge_rate_limit_buckets.sql`
25. `20260822155809_add_salon_organization_multilocation.sql`
26. `20260822163246_add_authoritative_tip_commission_evidence.sql`
27. `20260822165659_add_square_loyalty_reconciliation.sql`
28. `20260822172547_add_square_gift_card_reconciliation.sql`
29. `20260822174938_add_square_inventory_reconciliation.sql`
30. `20260822181000_add_durable_wix_writeback_operations.sql`

These migrations mix additive contracts with security restrictions. A previous
application deployment must not be assumed compatible with the migrated schema.

## Candidate-specific rollback plan

### Required capture before any release action

The Release Owner must record all of the following for one immutable candidate:

- exact Git SHA and Vercel deployment ID;
- exact migration list and schema/application-contract fingerprint;
- pre-migration backup/PITR identifier, retention and restore target;
- current production deployment/SHA and feature-flag snapshot;
- confirmation that outbound SMS, calls, email and payment paths remain disabled
  for the disposable acceptance tenant;
- named rollback decision owner and observation window.

If any field is missing, the candidate is `NO_GO`.

### Rollback decision tree

1. **Application regression before database migration:** repoint the alias to
   the captured known-good deployment, then verify the production version and
   health endpoints plus representative read-only salon routes.
2. **Database migrations applied, compatibility with the previous app proven:**
   repoint only to the explicitly certified compatible deployment. Never infer
   compatibility from HTTP 200 or from additive-looking SQL.
3. **Database migrations applied, compatibility not proven:** do not repoint the
   old app alone. Freeze rollout, keep new/default-off features disabled, stop
   provider work, and restore the captured application-and-database pair in a
   coordinated recovery window. If a safe restore cannot meet the recovery
   objective, fix forward using the smallest reviewed migration.
4. **Security restriction involved:** do not re-grant anonymous/authenticated
   access or remove a tenant/authorization guard merely to make an old build
   work. Use the coordinated restore or a reviewed compatibility fix.
5. **Payment/notification outcome is unknown:** do not replay a charge, refund,
   SMS or email. Reconcile the durable operation/receipt first.

### Migration recovery classes

- **Setup, RLS, auth and privilege hardening:** use their checked rollback
  rehearsals only in a disposable database. In production prefer fix-forward or
  a full captured restore; never weaken the boundary ad hoc.
- **Pricing, group booking and service sequences:** restore the pre-migration
  application/database pair if the canonical RPC contract cannot be served.
  Preserve committed booking/idempotency evidence during reconciliation.
- **Notification outboxes and dispatch envelopes:** additive rows may remain
  inert during an app rollback, but no pending or unknown delivery may be sent
  again until claims and provider receipts reconcile.
- **Payment and Square operation ledgers:** keep charge/refund/provider features
  off. Never delete an operation ledger to simulate rollback.
- **Financial reporting:** disable the report surface or fix forward; do not
  rewrite historical booking/payment evidence.
- **Vacation/resource capacity:** do not bypass overlap or vacation guards. Use
  coordinated restore or a compatible forward patch.

### Restoration acceptance

Rollback is successful only when all applicable checks pass against the restored
pair:

- `/api/version`, `/api/health` and `/api/ready` identify the intended artifact;
- login and signed-out dashboard/superadmin gates behave correctly;
- public pages for representative salons render read-only without changing data;
- a disposable tenant completes public booking and Front Desk smoke with all
  outbound providers suppressed;
- tenant-isolation and capability/RPC grant checks pass;
- schema, RLS/grant/function and application-contract fingerprints match the
  captured target;
- no new HTTP 500, stale Server Action, duplicate booking, payment, SMS or email
  evidence appears in the observation window.

Production execution of this plan still requires fresh action-time approval.

## Existing rehearsal evidence and remaining gap

- Vercel application rollback to the current known-good deployment was exercised
  in production on 2026-08-21 under explicit approval.
- Disposable PostgreSQL backup/restore previously matched schema, data and
  application-contract fingerprints with zero leftovers.
- Candidate migration families have focused transactional rollback, concurrency
  and boundary rehearsals under `scripts/security/`.

The exact immutable `1.0.0-rc.1` application/database pair does not exist yet,
so a combined restore rehearsal and deployed post-rollback acceptance remain
`NOT_PROVEN` until commit/deploy approval is granted.

## Local gate refresh — 2026-08-22

The current dirty local candidate passed all executable release gates run in
this checkpoint:

- TypeScript: PASS.
- ESLint: PASS with 0 errors and 47 warnings.
- i18n: PASS with 0 errors and 13 warnings.
- Vitest: 474 files passed, 1 skipped; 2,729 tests passed, 1 skipped,
  7 todo.
- Optimized production build: PASS; 57/57 static pages generated.
- High-severity dependency audit: 0 vulnerabilities.
- Migration deploy-ready audit: 377 unique local versions; all 267 production
  rows match the exact prefix; 0 duplicate versions, production-only versions,
  or name mismatches.
- Folded migration-history rehearsal: 377 SQL files generated in a throwaway
  `/private/tmp` directory.
- Local production-build probes: `/api/version` returned
  `1.0.0-rc.1`; `/api/health` returned `ok`; `/api/ready` returned `ready`
  with database-schema and cron-authorization checks both `ok`.

Structured evidence is retained at
`/Users/huytran/.codex/checkpoints/nailiq-20260820-183925/evidence/rc1-local-release-gates-20260822.json`.
These results do not change `LOCAL_CANDIDATE_NOT_IMMUTABLE`: the worktree still
has no exact candidate SHA and no remote CI, deployment, provider acceptance or
release sign-off is claimed.

### Multi-location local gate — 2026-08-22

The explicit salon-chain foundation passed a fresh no-seed local database
reset; two-location tenant/consent/staff/loyalty/reporting rehearsal; simultaneous
booking and loyalty races; exact schema/grant parity; zero missing foreign-key
indexes; Supabase security advisor; 135 security test files / 774 tests;
TypeScript; touched-file ESLint; and diff-check. Structured evidence is retained
at
`/Users/huytran/.codex/checkpoints/nailiq-20260820-183925/evidence/mqa-0050-0183-0186-multilocation-local.json`.
This proof remains local and did not touch a provider, production, or a live
salon.

### Tip and commission local gate — 2026-08-22

The approved policy passed a fresh no-seed local database reset; exact-cent tip
allocation; effective-dated commission-rate replacement; partial and cumulative
refund clawback; replay and concurrent over-reversal protection; legacy report
compatibility; transactional rollback; forced-RLS/least-privilege checks;
schema parity; Supabase security advisor; parser/presentation tests; TypeScript;
touched-file ESLint; and diff-check. The commission figure is deliberately
labeled as an estimate, not payroll or payout. Structured evidence is retained
at
`/Users/huytran/.codex/checkpoints/nailiq-20260820-183925/evidence/mqa-0116-0118-tip-commission-local.json`.
No provider, production, payroll system, outbound message or live salon was
used.

### Square Loyalty local foundation — 2026-08-22

MQA-0124 moved from `FAIL` to `BETA_NOT_PROVEN`, not PASS. The local candidate
now has PII-free Square account/event/reward mirrors, provider-receipt-bound
subject hashes, immutable event adoption and atomic cursor advancement. Fresh
reset, behavior, out-of-order concurrency, legacy Square rollback/compatibility,
schema/grant parity, FK-index checks, security advisor, security/Square tests,
typecheck and lint passed. A server-only optional-product webhook worker is now
cron-wired behind the hard-off Loyalty application contract, with local proof
for zero dispatch while off, claim/apply, ambiguous lease retry and poison-event
failure. Current combined parity is 161/2343/195/307/71/578 with grants
56/77/166, and 156 security/Square/Wix files with 879 tests pass. Historical
57-page build evidence remains valid, but this worker delta has no new build PASS
because Turbopack remains environment-blocked. The application capability
remains hard OFF; there was no Square API call, sandbox receipt/reconciliation,
remote migration, production proof or live-salon activity. Structured evidence is retained at
`/Users/huytran/.codex/checkpoints/nailiq-20260820-183925/evidence/mqa-0124-square-loyalty-local-foundation.json`.

### Square Gift Card local foundation — 2026-08-22

MQA-0125 moved from `FAIL` to `BETA_NOT_PROVEN`, not PASS, after the Product
Owner approved Square as the funds/state/balance source of truth. The local
candidate now has a GAN-free card mirror, exact succeeded
create->payment->activation receipt binding, immutable append-only activity
revisions for partial redeem/refund state, and atomic inbox/cursor adoption.
Fresh reset, behavior, four-way out-of-order concurrency, legacy Square
preflight/rollback, schema/grant parity, FK-index checks, 137 security files/789
tests, 7 Square files/44 tests, typecheck, lint and 57/57 historical build
passed. The shared webhook adoption worker is now cron-wired behind the
hard-off Gift Card application contract; current combined parity is
161/2343/195/307/71/578 with grants 56/77/166 and 156 security/Square/Wix files
with 879 tests. A server-only create/payment/activation dispatcher is now also
implemented behind the same hard-off contract. Fresh-reset negative receipt
rehearsal, 15 Square integration/boundary files with 66 tests, the full
491-file/2807-test unit gate, typecheck, scoped clean lint and diff-check pass;
raw payment tokens are not durable and activation is bound to the exact order
and line item. This delta has no new build PASS because Turbopack remains
environment-blocked and the webpack fallback exposes a pre-existing woff2
loader incompatibility. The application capability and local voucher mutations
remain hard OFF, and there was no Square API call, sandbox receipt/reconciliation,
remote migration, production proof or live-salon activity. Structured evidence is retained at
`/Users/huytran/.codex/checkpoints/nailiq-20260820-183925/evidence/mqa-0125-square-gift-card-local-foundation.json`.

### Square Inventory local foundation — 2026-08-22

MQA-0127 moved from `FAIL` to `BETA_NOT_PROVEN`, not PASS, after the Product
Owner approved Square Catalog variations and Inventory counts as the retail
source of truth. The local candidate now has a REGULAR retail-variation mirror,
pending owner/admin-confirmed mappings, immutable count revisions,
deterministic per-location/state snapshots, catalog refresh markers and
receipt-bound Square `latest_time`, resumable page-cursor adoption and a
cron-wired worker whose application contract remains hard OFF. Fresh reset;
catalog/count/mapping/cursor/replay behavior; valid empty deltas; mocked
claim/read/complete/apply and ambiguous-read recovery; four-way out-of-order
concurrency; rollback; schema/grant parity at 161/2343/195/307/71/578 and
56/77/166; zero missing Inventory FK indexes; 156 security/Square/Wix files with
879 tests; typecheck, 0-error lint and diff-check passed. Both normal and
approved local build attempts were environment-blocked by a Turbopack
internal-port EPERM, so no new Inventory build PASS is claimed. The hard-off
worker currently returns before DB construction or provider dispatch. There was
no Square API call, sandbox receipt/reconciliation, remote migration,
production proof or live-salon activity. Structured evidence is retained at
`/Users/huytran/.codex/checkpoints/nailiq-20260820-183925/evidence/mqa-0127-square-inventory-local-foundation.json`.

### Wix create/lifecycle and webhook durability — 2026-08-22

The local MQA-0062 create/lifecycle response-loss and MQA-0109 per-event webhook
durability defects are closed, while both checklist items remain `NOT_PROVEN`
pending connected acceptance. The candidate now sends the
stable NailIQ booking UUID as Wix `externalUserId`, uses a PII-free durable
single-winner operation claim, and turns every expired or ambiguous send into a
read-only provider lookup before atomically binding `bookings.wix_booking_id`.
Confirm, cancel and decline have their own provider-status/revision receipts.
A signature-verified PII-free webhook inbox records event identity and payload
fingerprint before provider fetch, then persists claim/replay/unknown/completion
state without storing the raw body. A missing provider read remains unknown and
never becomes an automatic second Create Booking or lifecycle mutation. Fresh
reset, transactional response-loss/adoption/replay, 8-way create/lifecycle/webhook
races, exact parity at 161/2343/195/307/71/578 with grants 56/77/166, zero missing
ledger FK indexes, 156 security/Square/Wix files with 879 tests, typecheck,
0-error lint and diff-check passed. The current Turbopack build refresh was environment-blocked by an
internal-port EPERM, so no new build PASS is claimed. No Wix call, credential
activation, production/live-salon mutation or deploy occurred. Structured
evidence is retained at
`/Users/huytran/.codex/checkpoints/nailiq-20260820-183925/evidence/mqa-0062-wix-create-writeback-local-foundation.json`
and `evidence/mqa-0109-wix-lifecycle-local-foundation.json`.
