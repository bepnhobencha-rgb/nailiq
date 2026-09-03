# TurnIQ M4Q — Multi-technician handoff planner

Status: `LOCAL_TESTED_PURE_ENGINE_ONLY`

TurnIQ remains behind `turniq_trust_engine_enabled`. This milestone does not
change the database, booking, provider, notification, QA, Preview, Production,
or any salon rollout stage.

## Product boundary

M4Q closes the pure-decision gap for one customer whose authoritative
multi-service booking has two to five fixed service segments. Booking remains
the owner of segment timing and the resource allocation. TurnIQ recommends the
technician for each segment without silently rescheduling the customer.

- Overlapping segments cannot use the same technician.
- Non-overlapping segments may use the same technician when that person is
  qualified and appointment-safe.
- A shared chair, bed, or room is accepted only with a server-derived resource
  policy fingerprint and sufficient same-customer parallel capacity.
- A technician must be checked in, active, available, qualified, outside a
  hold/break/refusal penalty, and able to finish before the next appointment.
- Trusted requested-technician provenance ranks before appointment safety,
  fairness, queue order, and the stable tie-break. An unavailable request is
  visible as a fallback and requires owner action.
- Search is complete and deterministic within a bounded state count. If a
  complete safe plan cannot be proven, the result contains no partial plan.

## Turn and credit truth

The result groups segments by the person who will actually perform them.
Each performer receives exactly one future turn for this customer after all of
their attributed work is completed, and only the catalog/list price plus
permitted add-ons for their own segments. Tax and tip are absent from the
fairness decision. A single technician who performs two sequential segments
receives one turn, not two.

The pure result does not consume a turn or write money. The next database
milestone must commit the segment assignments, performer credit, resource
occupancy, immutable events, command receipt, and one Fairness Receipt per
performer atomically.

## Explainability and privacy

The decision returns machine-readable candidate eligibility and skip reasons
per segment, plus the deterministic objective score in an Owner/Admin-only
internal trace. The customer/staff-safe explanation contains neither peer money
nor the fairness formula.

## Local evidence

- Simultaneous manicure + pedicure with two technicians on one certified shared
  chair: PASS.
- Sequential services by one technician aggregate to one turn and exact credit:
  PASS.
- Planned opportunity credit re-ranks later sequential work: PASS.
- Appointment-gap protection, requested-tech fallback, resource-capacity
  rejection, no-partial-plan behavior, and privacy-safe copy: PASS.
- Thirty candidate/availability/resource permutations preserve the same
  fingerprint, complete plan, non-overlapping staff, and exact credit: PASS.

## Not included yet

- Trusted server adapter for `booking_service_segments` and parallel-policy
  rows.
- Additive schema/RPC changes needed to permit multiple active TurnIQ
  assignments for one booking safely.
- Atomic confirm/start/complete, Fairness Receipts, Receptionist Center UI,
  offline replay, QA, Preview, Production, or pilot evidence.

The next boundary is M4R: design and test the additive ledger/RPC contract in a
disposable local database before any QA migration or salon activation.
