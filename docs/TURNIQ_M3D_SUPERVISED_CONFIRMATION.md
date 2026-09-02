# TurnIQ M3D — Supervised Confirmation + Fairness Receipt

Status: `IMPLEMENTED_LOCAL + TESTED_LOCAL`; not committed, not deployed,
not QA-proven, not production-proven, and not pilot-proven. The release flag
`turniq_trust_engine_enabled` remains default OFF for every salon.

## What M3D adds

- One-tap confirmation of the current trusted recommendation in the
  Receptionist Center Live Board.
- A reason-required override path that records the technician actually chosen.
- Immediate display of the durable, privacy-safe Fairness Receipt after a
  successful confirmation or override.
- Exact command-envelope reuse after an ambiguous transport failure, so retry
  cannot duplicate a committed confirmation.
- Committed confirmation remains visibly successful even if the later board or
  receipt read refresh fails.
- `policy_version_id` is included in the role-safe Live Board command envelope;
  the server and RPC still revalidate exact salon, membership, role, assignment,
  policy, and feature flag.

## Atomic safety boundary

Migration `20260902001545_add_turniq_atomic_assignment_revalidation.sql`
installs a booking update trigger that is inert unless the booking has one
active TurnIQ recommendation. Before the booking assignment can commit, it
locks/revalidates:

- current salon-local business day and active policy shift;
- active technician and explicit capability for main service and legacy add-on;
- exact booking, service, add-on, resource, catalog, shift-version and daily
  capacity snapshot used by the deterministic recommendation;
- conflicts against both single bookings and authoritative multi-service
  segments;
- conservative catalog duration plus buffer before the next appointment;
- active resource, service resource kind and resource availability.

Any snapshot drift raises a stale/conflict result and rolls back the whole
confirmation. The UI refreshes instead of presenting a partial assignment.
The migration also reconciles the existing generic resource guards with
service resource mode `none`, so resource-free services are not assigned a
physical resource and are not rejected by the later operational guard.

## Local verification evidence

- Focused TurnIQ engine, read-model, action, Live Board and security tests pass.
- TypeScript strict check and focused ESLint pass.
- A throwaway native PostgreSQL 16 database rebuilt all 471 folded-history
  migrations through M3D successfully after the throwaway copy omitted the
  PostgreSQL-17-only dump setting `transaction_timeout` and `MAINTAIN` ACL.
- Synthetic database behavior passed:
  - valid confirmation of a `resource_requirement_mode = 'none'` service;
  - capability drift blocked with no partial booking mutation;
  - new conflicting capacity blocked with no partial booking mutation.
- No customer PII, provider call, payment, booking in QA/Production, email, SMS,
  push, or voice notification was used.

These results are local evidence only. They do not prove QA, Production, a real
salon workflow, realtime behavior, or pilot fairness.

## Deliberate limits

- M3D remains single-customer and `schedule_model = 'single'`; group matching
  belongs to M4.
- Start/complete Staff View, disputes, refusal/redo/swap flows, customer ETA,
  realtime subscriptions and the seeded 60-second demo are not complete.
- The Live Board reloads after each command; push-driven TurnIQ refresh is not
  implemented yet.
- No salon may be enabled until a later explicitly approved QA/pilot rollout.

## Rollback boundary

1. Keep `turniq_trust_engine_enabled` absent or false.
2. Stop importing the confirmation callbacks into the Live Board.
3. Remove only the M3D TurnIQ confirmation trigger/function if necessary.
4. Restore the two generic resource functions from their prior migrations if
   the resource-mode reconciliation must be reverted.
5. Preserve all TurnIQ command, event, exception and Fairness Receipt evidence.
