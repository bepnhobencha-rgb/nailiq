# TurnIQ M4K — Customer Status ETA Integration

Status: **implemented and tested locally only**. Not committed, not deployed,
not QA-proven, not production-verified, and not pilot-proven.

## Outcome

M4K connects the pure M4J conservative ETA projection to the existing
capability-token booking status path:

- `/booking/status?token=...` remains the only customer surface;
- `/api/booking/status` validates and rate-limits the status capability before
  any TurnIQ read;
- the validated `salonId`, `bookingId`, and optional `groupId` scope all ledger
  queries server-side;
- `turniq_trust_engine_enabled` must be on for the salon and the explicit
  platform rollout flag must also be on;
- when the flag is off, the TurnIQ ledger is not queried;
- when ETA data is missing, stale, malformed, or temporarily unavailable, the
  canonical appointment status still succeeds and `turnIqEta` is `null`;
- no booking, salon, staff, resource, queue, peer-money, tip, or internal
  snapshot identifier is returned in the ETA payload.

## Single and group behavior

For a single booking, a matching salon-scoped TurnIQ assignment is required.
The customer sees a rounded, conservative range derived from the current
booking start and service duration. Terminal assignment state wins over a wait
estimate.

For a group, a confirmed salon-scoped group plan and a matching group-plan item
are required. The member sees their own rounded start range and a separate
range for when the whole party is expected to have started. Exact internal wave
order, technicians, resources, and fairness values remain private.

## Connection and retry truth

The page polls every 30 seconds. A temporary network failure preserves the last
confirmed booking snapshot. Once an ETA passes `refreshBy`, the page removes the
range and says it is updating; it never keeps presenting stale precision as
current truth.

## Rollback boundary

Keep either the salon TurnIQ flag or platform TurnIQ flag off. The existing
booking status response continues without TurnIQ ETA. No migration or provider
integration is introduced by M4K.

## Local verification

- pure M4J ETA projection tests;
- M4K repository/feature-off/group/single/failure tests;
- capability-route order and PII-safe response tests;
- presentation expiry and limited-connection tests;
- static tenant-scope/provider/mutation boundary tests;
- full unit, typecheck, lint, and production build gates.
