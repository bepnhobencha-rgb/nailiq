# TurnIQ M4R — Multi-technician handoff ledger

Status: `LOCAL_DATABASE_TESTED_NOT_DEPLOYED`

TurnIQ and every live salon remain unchanged. This milestone adds a local-only,
additive migration and a transaction-wrapped synthetic database rehearsal. It
does not configure QA, Preview, Production, payments, providers, notifications,
or salon rollout state.

## Authoritative boundary

The committed `booking_service_segments` rows remain authoritative for staff,
time, resource, service, and price material. The handoff RPC refuses to record a
plan whose recommendation differs from those rows. It never silently rewrites a
committed appointment. A future booking adapter may use the pure planner before
the sequence is committed; changing an existing sequence still requires the
canonical reschedule/reassignment contract.

The ledger uses three entities:

- `turniq_handoff_plans`: one versioned plan for one multi-service booking;
- `turniq_handoff_performers`: one immutable TurnIQ assignment per actual
  technician/customer, regardless of how many sequential segments they perform;
- `turniq_handoff_plan_items`: one immutable segment-to-performer link with
  exact credit, resource, timing, fingerprint, and requested-tech provenance.

This shape avoids charging a technician two turns when they perform two
sequential services for the same customer. Two technicians serving the same
customer each receive one turn and only their attributed opportunity credit.

## Atomic commands

The service-role-only commands require both the salon feature flag and rollout
stage `SUPERVISED` or `LIVE`:

1. `record_turniq_handoff_plan_v1` records the deterministic plan and assignment
   recommendations without changing booking state.
2. `confirm_turniq_handoff_plan_v1` re-locks and revalidates the booking,
   segments, performers, shifts, skills, resources, prices, and fingerprints;
   then confirms every performer and creates exactly one Fairness Receipt per
   performer in one transaction.
3. `apply_turniq_handoff_performer_command_v1` starts or completes the work
   attributed to one performer. Completion increments that shift exactly once.
   The parent booking completes only after every performer completes.

Every command has an idempotent receipt. Recommendation, confirmation,
start, and completion have immutable TurnIQ events. Requested-technician
fallback requires an Owner/Admin-visible reason. Browser roles have no direct
table or RPC access, and every new table has RLS plus FORCE RLS.

## Local evidence

Applied the full schema through this migration to an exact disposable local
PostgreSQL database and ran every `supabase/tests/turniq_*.test.sql` fixture.

- two overlapping segments, two technicians, two resources: PASS;
- confirmation creates two durable Fairness Receipts: PASS;
- first performer completion does not complete the parent booking: PASS;
- second performer completion closes the booking and plan: PASS;
- exact command replay does not duplicate a turn or receipt: PASS;
- two sequential segments by one technician aggregate to one assignment, one
  receipt, one turn, and the sum of both credits: PASS;
- a proposed technician mismatch cannot rewrite a committed segment: PASS;
- browser ACL denial and service-role execution boundary: PASS;
- all existing TurnIQ SQL fixtures: PASS.

The Supabase CLI database linter could not run because Homebrew PostgreSQL does
not provide the optional `plpgsql_check` extension. Migration execution, SQL
fixtures, schema proof blocks, TypeScript tests, typecheck, lint, and production
build remain the applicable evidence. This is not QA, Production, or pilot proof.

## Next boundary

M4S is the trusted server adapter and supervised UI integration. It must build
the SQL payload from the current booking segment and TurnIQ snapshots, expose
the multi-performer plan on the Live Board, and keep all mutation buttons gated
by rollout stage. QA/Preview verification must follow before any Production
migration or salon activation.
