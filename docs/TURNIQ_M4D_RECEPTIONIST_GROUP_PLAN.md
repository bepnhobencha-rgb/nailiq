# TurnIQ M4D — Receptionist Group Plan

Status: `LOCAL_TESTED_NOT_DEPLOYED`

TurnIQ remains default OFF. This milestone did not apply QA/Production,
enable a salon, create a real booking, call a provider, send a message, commit
or push.

## Outcome

Receptionist Center now has a dedicated TurnIQ Group card for today's active
booking groups:

- The server supplies a salon-scoped, PII-free queue of groups requiring work.
- The card shows party size, requested time, service summary and current
  readiness without exposing customer names, phone, email, notes, tips or peer
  financial truth.
- One tap creates the complete deterministic plan; this does not change a
  booking.
- The plan shows every proposed technician, service, resource and safe service
  window plus conservative ETA.
- One further tap confirms the whole group atomically through M4B and surfaces
  durable Fairness Receipt truth.
- An existing recommended plan can be reopened instead of being regenerated.
- An empty queue explicitly says the team can continue without owner action.

## Safety behavior

- Partially assigned groups, mixed start times and unsupported schedule models
  remain visible with a plain-language blocker; the UI cannot submit them.
- Offline mode keeps last-known group truth visible but disables recommendation
  and confirmation.
- A stale response clears the unsafe command and refreshes current truth.
- A transport failure retains the exact command/device/sequence envelope so a
  retry cannot duplicate a plan or confirmation.
- A committed recommendation remains success even if its read-back fails.
- A committed group confirmation remains success even if Fairness Receipt/read
  refresh temporarily fails; the desk is never told to repeat committed work.
- Requested-technician fallback remains blocked for explicit Owner/Admin review.
- The group surface mounts only for today's Day view while the TurnIQ feature
  flag is enabled.

## Local evidence

- Ready four-person group clearly shows party, time, service and one-tap safe
  plan action: PASS.
- Partially assigned group is visible but cannot be planned: PASS.
- Offline state disables mutations while preserving last-known truth: PASS.
- Empty queue explicitly states no owner action is needed: PASS.
- Failed trusted queue never claims an assignment: PASS.
- Static boundary verifies salon scope, PII-free reads, validated Server Actions,
  exact retry envelopes and no service-role code in the client: PASS.

## Not included yet

- Requested-tech provenance at group intake.
- Explicit staggered-wave, arrive-together or finish-together confirmation.
- Multi-resource tasks and in-progress multi-tech handoff.
- Realtime ETA/customer kiosk, offline mutation authority, QA, Preview,
  Production or pilot proof.

M4E now provides formal group timing intent (`start_together`,
`finish_together`, `smart_wave`) as a pure replayable simulation. See
`docs/TURNIQ_M4E_GROUP_TIMING_SIMULATION.md`. Staggered booking mutation remains
out of scope.
