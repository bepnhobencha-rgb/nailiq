# TurnIQ M3H3 — Consented Swap and Correction History

Status: `LOCAL_TESTED_ONLY`

TurnIQ remains behind `turniq_trust_engine_enabled`; the flag remains OFF for
every salon. This milestone does not call a provider, send a notification, or
create a real booking.

## Product truth

A pre-service technician swap has three explicit stages:

1. An affected technician or desk user proposes the transfer with a reason.
2. The currently assigned technician and proposed technician each consent for
   themselves. Nobody, including the Owner, may consent on their behalf.
3. A desk user applies the ready swap. Booking and TurnIQ assignment move to
   the new technician atomically; the original Fairness Receipt stays intact.

The assignment cannot start while a swap is pending or ready. A swap is
revalidated against current assignment, booking, shift and busy-state truth at
application time. In-progress handoffs remain fail-closed until M4 can allocate
work and credit across multiple technicians safely.

After completion, Owner/Admin may correct the technician who actually
performed the work. The correction:

- preserves the original Fairness Receipt and business revenue;
- moves the consumed turn and applied opportunity credit from the previously
  recorded shift to the actual technician's matching shift;
- updates current booking/assignment performer truth;
- appends immutable before/after evidence, command receipt and event.

## Atomic contract

`apply_turniq_swap_command_v1` supports request, self-consent and desk apply
under one idempotent command boundary. Both consents are append-only. Applying
the swap updates the booking, assignment, swap status, command receipt and
event in one transaction.

`apply_turniq_assignment_correction_v1` is Owner/Admin-only. It locks the
completed assignment and both shifts, validates that the actual technician had
a matching shift covering the service, transfers turn and credit totals,
updates current performer truth and appends the immutable correction atomically.

Both RPCs are `SECURITY INVOKER` and service-role-only. New tables have RLS
enabled and forced; browser roles have no direct table or RPC access.

## Local evidence

- Migration syntax applied to disposable local full-schema PostgreSQL: PASS.
- All 6 TurnIQ synthetic SQL files: PASS. M3H3 covers two self-consents, no
  proxy consent, pending-start guard, atomic swap, immutable receipt,
  correction transfer, business-truth preservation, exact retry and ACL.
- Focused TypeScript/UI/security: 23 files and 147 tests PASS.
- Full unit suite: 654 files and 4,016 tests PASS; one file/test remains skipped
  and 7 tests remain todo outside this milestone.
- Focused ESLint and repository query-grammar injection guard: PASS.
- TypeScript strict check: PASS.
- Next.js production build: PASS. Existing Edge Runtime deprecation/static
  generation warnings remain unchanged.
- Metadata proof: all 3 new tables have RLS enabled and forced; both new RPCs
  are `SECURITY INVOKER`, executable by `service_role` only, and denied to
  `anon` and `authenticated`.

## Not included yet

- In-progress or multi-technician handoff allocation.
- Group constrained matching and customer ETA.
- Realtime push, offline writes, QA, Preview, Production or pilot proof.
