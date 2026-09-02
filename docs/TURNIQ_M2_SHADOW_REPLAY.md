# TurnIQ M2 Shadow and Replay

Status: `implemented locally` and `tested locally`. It is not wired into the
live Receptionist Center, applied to QA/Production, committed, pushed, deployed,
or enabled for any salon.

## Shadow adapter

`src/shared/turniq/shadowAdapter.ts` converts the existing
`ReceptionistCenterData` read model into a TurnIQ decision input without
modifying that read model or any booking.

The adapter reuses:

- staff availability and active/offline state;
- selected-day bookings and each technician's next appointment;
- service catalog and staff-service capability rows;
- assigned resource state supplied by the resource reader;
- server-owned observation timestamp and salon-local business date.

It does not reuse Receptionist workload as fairness credit. Shift/check-in,
queue, break/hold, refusal/safety state, service credit, and fairness baseline
must come from the TurnIQ ledger. Missing check-in means not checked in. Legacy
`capabilityRows = null` fails closed as incomplete capability data rather than
using the old all-staff-capable fallback.

The snapshot fingerprint excludes customer name, phone, email, notes, tips,
payment, and provider material. Changing synthetic customer name or phone does
not change the snapshot fingerprint.

## Shadow comparison

`src/shared/turniq/shadowReplay.ts` compares one recommendation with the human
assignment and records one of:

- matched recommendation;
- explained or unexplained divergence;
- actual assignee was ineligible in the captured snapshot;
- no safe recommendation;
- actual assignment still pending (in-memory only).

Baseline metrics include recommendation acceptance, assignment latency,
owner-intervention count, pending decisions, and explained/unexplained
divergence. Pending decisions are excluded from the acceptance denominator.

## Deterministic Replay

Replay sorts cases by stable case ID, re-runs the same historical snapshot under
the current and proposed fairness policies, and returns:

- changed or unchanged recommended technician;
- current/proposed decision fingerprints;
- current/proposed human-assignment comparison;
- current/proposed aggregate metrics;
- one deterministic run fingerprint.

The proposed policy is simulated as effective on each historical business day.
The result is explicitly `readOnly: true`; input cases and historical objects
are never mutated.

## Persistence boundary

Migration `20260901224527_add_turniq_shadow_replay.sql` adds four private,
append-only tables:

- `turniq_shadow_decisions` — PII-minimized engine input/output evidence;
- `turniq_shadow_comparisons` — later actual assignment comparison; absence of
  a row means the human assignment is still pending;
- `turniq_replay_runs` — current-versus-proposed summary and fingerprint;
- `turniq_replay_cases` — immutable per-case comparison.

All four tables use forced RLS, deny `PUBLIC`, `anon`, and `authenticated`, and
grant only `SELECT, INSERT` to `service_role`. Cross-salon policy, booking,
staff, decision, and replay references are rejected by database triggers.

## Rollback and non-mutation proof

1. Keep `turniq_trust_engine_enabled` absent or `false`.
2. Do not invoke a future shadow capture scheduler/action.
3. Preserve shadow/replay evidence for audit.
4. Existing bookings, resources, staff, Receptionist Center, and turn order are
   unchanged because neither M2 migration installs triggers on them.

M2 local PASS is not Production verification or pilot evidence. Runtime shadow
capture, Owner Replay UI, and a real salon baseline still require later,
separately authorized milestones.
