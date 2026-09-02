# TurnIQ M0 Contracts and Safety Boundary

Status: `implemented locally`; no runtime integration, database migration,
deployment, feature activation, provider call, notification, or live-data
mutation.

## Reuse boundary

TurnIQ may read existing salon-scoped staff, services, `staff_services`,
recurring shifts/unavailability, bookings, service segments, and resources.
Existing booking and resource exclusion constraints remain authoritative for
capacity safety.

TurnIQ must not treat these existing concepts as fairness truth:

- Receptionist workload counts;
- walk-in priority or VIP labels;
- the best-effort `booking_events` audit trail;
- `staff_requested_by_client` or free-text staff notes as verified provenance;
- the legacy empty-capability fallback that considers every staff member
  capable;
- the current greedy group scheduler as a constrained fairness solver.

## Versioned contract

The M0 TypeScript contract lives in `src/shared/turniq/contracts.ts` and is
runtime-independent. Its inputs contain no customer name, phone, email, tip, or
payment-provider material. Money used by the fairness policy is integer CAD
cents.

The future engine must return:

- policy identity and version;
- salon-local business date and immutable snapshot version;
- deterministic decision timestamp and fingerprint;
- every eligible and skipped candidate with machine-readable reason codes;
- a privacy-safe one-line explanation;
- a separately authorized internal trace.

Historical staff-request records without trustworthy source evidence use
`legacy_unknown`. They must never be relabelled as independently verified
customer intent.

## Live eligibility boundary

Shadow mode may report incomplete staff capability data. Supervised/live mode
must fail closed with `CAPABILITY_DATA_INCOMPLETE`; it must not use NailIQ's
legacy all-staff-capable compatibility fallback.

Booking/resource truth is rechecked inside the future atomic database command.
A recommendation calculated from a snapshot is never permission to mutate a
booking by itself.

## Planned authoritative write boundary

M1 database design will use namespaced, additive entities such as
`turniq_policy_versions`, `turniq_shift_sessions`, `turniq_assignments`,
`turniq_events`, `turniq_command_receipts`, `turniq_fairness_receipts`,
`turniq_exceptions`, and `turniq_disputes`.

Browser clients will not write the ledger directly. Confirmation, override,
start, and completion will use salon-scoped, role-checked, idempotent commands
that atomically commit booking state, assigned staff, resource occupancy,
fairness state, immutable event, and command receipt.

## Rollback boundary

The future feature key is `turniq_trust_engine_enabled`, stored per salon and
defaulted to `false`. Until M3 passes, no trigger or default path may redirect
existing booking/walk-in writes into TurnIQ. Rollback is therefore:

1. keep the salon flag off;
2. remove the TurnIQ UI/read adapter;
3. preserve additive ledger records for audit rather than dropping them;
4. leave legacy booking and Receptionist Center behavior unchanged.

## M0 exit gate

M0 is complete only when:

- the authoritative TurnIQ documents are source-controlled in the active
  checkout;
- the TypeScript contracts compile without server or database dependencies;
- the 12-technician Salon A fixture is deterministic and PII-free;
- all M0 tests use the repository-discovered `.spec.ts` convention;
- typecheck, focused lint, focused tests, and diff review pass.

Passing M0 is not evidence of a deployed, production-verified, or pilot-proven
TurnIQ system.
