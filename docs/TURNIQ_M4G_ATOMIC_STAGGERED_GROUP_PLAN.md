# TurnIQ M4G — Atomic Staggered Group Plan

Status: `LOCAL_POSTGRES_TESTED_NOT_DEPLOYED`

TurnIQ remains behind `turniq_trust_engine_enabled`; every salon remains OFF.
This milestone did not add an Apply button, mutate a real booking, call a
provider, send a message, apply QA/Production, commit or push.

## Outcome

The read-only M4E/M4F timing simulation now has a safe database contract for a
future supervised Apply action:

1. `record_turniq_staggered_group_plan_v1` persists one trusted simulation into
   the existing M4B group-plan ledger without changing any booking.
2. It records timing intent, simulation ID/fingerprint, original booking
   windows/fingerprints, proposed windows, wave number, staff, shift and
   resource for every member.
3. `confirm_turniq_staggered_group_plan_v1` locks the entire group and capacity
   namespaces in deterministic order, proves every original fingerprint still
   matches, then moves every booking in one set-based statement.
4. It delegates final staff/resource/skill/gap/capacity confirmation, Fairness
   Receipts, immutable event and command receipt to the already-tested M4B
   atomic confirmation transaction.

No partial success is possible: one stale member, booking trigger rewrite,
resource conflict, appointment conflict or exclusion constraint rolls back the
whole outer transaction. An identical command retry returns the prior M4B
receipt and creates no duplicate booking move, assignment, receipt or event.

## Safety boundary

- No second booking or fairness ledger was introduced.
- Existing booking triggers and exclusion constraints stay enabled.
- Browser roles cannot call either M4G RPC; both are `SECURITY INVOKER` and
  service-role only.
- A new plan is restricted to 2–12 exact active group members, one salon, one
  active policy/business day and a bounded 12-hour timing window.
- Service/add-on duration is recomputed from current catalog truth.
- Existing resource choice is preserved; new choices must be active and match
  the service's resource kind policy.
- The future caller must supply the expected plan state version; stale plans
  fail closed.
- The record RPC never updates `bookings`.
- The confirmation RPC contains no provider, payment or notification call.

## Local evidence

- Full forward migration chain reached M4G successfully on a disposable local
  PostgreSQL database. Reference-data loading later stopped because bare
  PostgreSQL lacks Supabase Storage tables; this happened after all schema
  migrations, so it is not M4G evidence or a Production claim.
- Smart Wave with two guests reused one technician and one chair sequentially,
  then confirmed both bookings atomically: PASS.
- Persisting the selected plan did not move, assign or reserve either booking:
  PASS.
- Retrying the same confirmation returned replay truth and created exactly two
  Fairness Receipts, with no duplicates: PASS.
- Cancelling one member after recommendation rejected confirmation and left the
  other member unmoved/unassigned: PASS.
- Existing M4B exact-time group SQL rehearsal still passes after M4G: PASS.
- Static ACL, invoker-security, deterministic-lock and write-order tests: PASS.

## Not included yet

- Server Action or receptionist Apply/Confirm control for a timing simulation.
- Multi-service segments or technician handoff; M4G still fails closed when a
  booking has `booking_addons` or `booking_service_segments`.
- Customer approval, notifications, realtime ETA or offline mutation.
- QA, Preview, Production, live-salon or pilot proof.

Next safe milestone is M4H: add a supervised receptionist action that reloads
one authoritative snapshot, verifies the selected simulation fingerprint,
records the plan, and exposes one explicit atomic Apply confirmation. It must
remain default OFF and must preserve committed-success receipt truth.
