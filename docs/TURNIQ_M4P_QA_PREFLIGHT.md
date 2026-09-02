# TurnIQ M4P — Disposable QA preflight

Status: disposable QA database and branch Preview verification complete on
2026-09-02. The ordered 13-migration TurnIQ chain was applied only to QA. No
salon was enabled, and Production/providers were not touched.

## Exact target

- Parent Production project: `fshmobzyjhmtvndobwsy` (`NailIQOS`).
- Disposable QA branch: `qa-booking-certification-20260829`.
- QA project ref: `osdqutwunokiielbairj`.
- Current branch status: `ACTIVE_HEALTHY`.
- Latest QA migration: `20260901203512`, the remote history entry corresponding
  to the service/resource ACL boundary.

The QA project does not appear in the top-level project list because it is a
Supabase branch. It is still present and healthy under the Production parent.

## Read-only findings

- All required pre-TurnIQ relations exist: salons, salon members, staff,
  services, bookings, booking service segments, salon resources, staff shifts,
  and staff-service capabilities.
- Required booking/salon/staff/service/resource columns and types match the
  migration assumptions.
- `extensions.gen_random_uuid()` exists.
- Before the approved run, zero `turniq_%` relations existed in QA, proving
  TurnIQ was not partially applied.
- Zero QA salons currently have `turniq_trust_engine_enabled = true`.
- The current advisor baseline contains 60 security notices and 423 performance
  notices, with zero notices referring to TurnIQ. These are pre-existing QA
  baseline notices and must be diffed after migration rather than falsely
  attributed to TurnIQ.
- Current Supabase breaking changes do not affect these migrations: they do not
  alter the locked `realtime` schema, pin extension versions, or depend on the
  removed Management API logs endpoint.
- The checkout is linked to Vercel project `nailiq`, but the local branch has no
  remote head. Therefore no Preview can represent the current uncommitted
  TurnIQ tree until a separately approved commit/push/Preview step.

## Important scope correction

Applying only the M4M customer check-in migration would not safely verify the
current Preview. The current branch includes the complete TurnIQ M1–M4 server
and Receptionist surfaces behind the same salon feature flag. Turning that flag
on for a synthetic QA salon while the earlier ledger/RPC migrations are absent
would produce a misleading or broken test.

The safe QA verification unit is therefore the ordered 13-migration TurnIQ
chain, not one isolated migration:

1. `20260901222628_add_turniq_trust_foundation.sql`
2. `20260901224527_add_turniq_shadow_replay.sql`
3. `20260901225714_add_turniq_atomic_online_commands.sql`
4. `20260902001545_add_turniq_atomic_assignment_revalidation.sql`
5. `20260902005103_turniq_business_day_shift_rollover.sql`
6. `20260902011857_turniq_dispute_exception_commands.sql`
7. `20260902020118_turniq_why_not_me_skip_reviews.sql`
8. `20260902021809_turniq_refusal_safety_boundary.sql`
9. `20260902023503_turniq_redo_repair_policy_boundary.sql`
10. `20260902030008_turniq_consented_swap_correction_history.sql`
11. `20260902034830_turniq_atomic_group_plan_ledger.sql`
12. `20260902042500_turniq_atomic_staggered_group_plan.sql`
13. `20260902124728_add_turniq_customer_checkin_shadow_ledger.sql`

## QA verification result

All 13 migrations above applied sequentially without an error. Remote migration
history contains exactly 13 new TurnIQ entries; no unrelated migration was
applied.

Post-migration checks:

1. PASS — all 20 authoritative TurnIQ tables exist with both RLS and FORCE RLS.
2. PASS — `anon` and `authenticated` have no direct TurnIQ table privileges.
3. PASS — browser roles have zero TurnIQ function execute grants; 23 designed
   service-role functions are present.
4. PASS — all nine transaction-wrapped SQL fixtures ran against QA. A schema
   parity issue in four fixtures was corrected by inserting the canonical
   synthetic `other` service category inside each transaction. All fixture data
   rolled back: zero synthetic salons, zero synthetic auth users, and zero rows
   across all TurnIQ tables remain.
5. PASS — security advisors moved from 60 to 80 notices only because the 20
   private TurnIQ tables are intentionally reported as RLS-enabled without
   browser policies. All 20 are INFO; TurnIQ introduced zero WARN/ERROR notices.
   See the [Supabase RLS advisor explanation](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).
6. PASS — performance advisors currently contain 87 TurnIQ INFO notices (39
   unindexed foreign-key suggestions and 48 unused-index observations) and zero
   TurnIQ WARN/ERROR notices. These are optimization signals, not a Preview
   blocker, and should be re-evaluated with pilot query evidence rather than by
   removing integrity indexes pre-emptively.
7. PASS — zero QA salons have `turniq_trust_engine_enabled = true`; platform and
   salon flags remain OFF.

## Vercel Preview result

- PASS — branch `feat/turniq-m0-contracts` has a Vercel Preview at the stable
  branch alias:
  `https://nailiq-git-feat-turniq-m0-contracts-bepnhobencha-2588s-projects.vercel.app`.
- PASS — 26 branch-scoped environment variables are stored as sensitive. The
  runtime points to disposable QA `osdqutwunokiielbairj`.
- PASS — outbound SMS, email and calls are disabled. Payment workers, approved
  fee dispatch, Square payment webhook ingestion, Smart Checkout webhook
  ingestion and all QA Square recovery triggers are disabled.
- PASS — `/api/health` and `/api/ready` return HTTP 200; database schema and
  cron authentication checks both pass.
- PASS — a capability-free `/turniq/check-in` request returns the expected
  fail-closed 404 without creating a customer check-in or any other data.
- PASS — the branch working tree is clean after the evidence commit.

This is deployed to QA Preview only. It is not merged, Production-deployed,
enabled for a salon, or pilot-proven.

## Rollback boundary

Because the target is a disposable Supabase branch, a failed partial chain must
not be repaired ad hoc. Stop, preserve the failing migration/error, and use a
separately approved branch reset/recreation before retrying from the verified QA
prefix. Never drop TurnIQ tables in place to imitate rollback, and never merge
the QA branch into Production.
