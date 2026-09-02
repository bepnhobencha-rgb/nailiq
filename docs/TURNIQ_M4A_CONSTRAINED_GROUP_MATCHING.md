# TurnIQ M4A — Constrained Group Matching

Status: `LOCAL_TESTED_PURE_ENGINE_ONLY`

TurnIQ remains behind `turniq_trust_engine_enabled`; every salon remains OFF.
This milestone has no database mutation, booking mutation, provider call,
notification, QA, Preview or Production change.

## Product boundary

M4A decides one simultaneous group as one complete plan. It does not greedily
assign the first guest and risk making the remaining guests impossible.

The exact objective order is:

1. prove a complete feasible match;
2. satisfy trusted requested-technician choices when feasible;
3. protect upcoming appointments;
4. minimize maximum and total customer wait;
5. minimize fairness-tier and queue cost;
6. use a stable deterministic tie-break.

Each guest receives one unique technician. Required chairs, beds or rooms are
also unique within this simultaneous plan. A technician who is currently busy
may be considered only when an explicit future availability time is present.
The service plus buffer must finish before that technician's next appointment.

The solver is exact and deterministic for groups up to 12. Search is bounded;
if NailIQ cannot prove an optimal complete plan within that boundary, it returns
no plan and asks for desk review instead of presenting a possibly wrong answer.

## Requested technicians and fairness

Trusted request provenance is preferred before wait or fairness cost. If the
requested technician is not feasible, the engine may produce the safest
complete fallback plan, labels the fallback and requires human review.
`legacy_unknown` does not receive verified-request precedence.

Fairness uses opportunity credit plus the check-in baseline. The late-arrival
baseline therefore prevents a technician with zero same-day service credit from
jumping ahead. No peer money appears in the customer-safe explanation.

## Customer ETA

The result contains a conservative start range rather than a false exact
promise. It combines earliest/latest planned start with deterministic padding
derived from catalog duration. The wording exposes no technician earnings or
internal ranking.

## Local evidence

- Four-person complete matching with unique staff/resources: PASS.
- Greedy-trap fixture that requires reserving the only qualified technician:
  PASS.
- Requested-tech precedence, unavailable fallback, appointment-gap safety,
  resource exhaustion and late-arrival baseline: PASS.
- Twelve-person fully connected exact plan under the bounded search: PASS.
- Thirty seeded permutation/invariant scenarios: PASS.
- 3 focused engine/invariant/security files and 17 tests: PASS.
- All TurnIQ TypeScript tests: 12 files and 99 tests PASS.
- Full unit suite: 657 files and 4,033 tests PASS; one file/test remains
  skipped and 7 tests remain todo outside this milestone.
- Focused ESLint: PASS.
- TypeScript strict check: PASS.
- Next.js production build: PASS. Existing Edge Runtime deprecation/static
  generation warnings remain unchanged.

## Not included yet

- Atomic group-plan persistence or confirmation.
- Revalidation against live booking/resource rows.
- Reusing the same technician/resource across staggered waves.
- Arrive-together versus finish-together multi-stage scheduling.
- QR/kiosk check-in, customer status page, realtime ETA updates or offline.
- QA, Preview, Production or pilot proof.

M4B should bind this plan to the authoritative ledger and revalidate every
staff, skill, appointment, resource and policy fact atomically before confirm.
