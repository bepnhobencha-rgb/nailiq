# TurnIQ M1B Trust Foundation

Status: `implemented locally`; database syntax/security verification is local
only. This migration has not been applied to QA or Production, committed,
pushed, or deployed. TurnIQ remains default OFF for every salon.

## Feature boundary

`turniq_trust_engine` is a controlled beta feature backed by
`salons.feature_flags.turniq_trust_engine_enabled`. Its registry default is
`false`, and the generic release editor cannot enable or reset it.

The migration is inert: it does not add triggers to bookings, redirect an
existing Receptionist Center write, call a provider, or send a notification.

## Authoritative entities

- `turniq_policy_versions`: immutable, versioned salon rules with next-local-day
  activation by default and a reason-required same-day emergency path.
- `turniq_shift_sessions`: check-in order, queue position, holds/breaks, baseline
  opportunity credit, completed turns, and service credit since check-in.
- `turniq_assignments`: current recommendation/assignment lifecycle with
  requested-technician provenance, privacy-safe explanation, and a private
  internal trace.
- `turniq_events`: immutable aggregate-versioned domain ledger.
- `turniq_command_receipts`: immutable device-command idempotency receipts.
- `turniq_fairness_receipts`: one durable explanation record per confirmed or
  overridden assignment.
- `turniq_exceptions` and `turniq_disputes`: owner-action and staff-trust work
  queues without rewriting original evidence.

## Tenant and privacy boundary

Every row is salon-scoped. Composite foreign keys protect references among
TurnIQ tables. A database trigger additionally verifies that referenced staff,
booking, segment, service, and resource rows belong to the same salon.

All eight tables have RLS enabled and forced. `PUBLIC`, `anon`, and
`authenticated` have no direct access. Only `service_role` receives the minimum
table privileges needed for later server commands. No browser-facing TurnIQ RPC
or policy exists in M1B, so a technician cannot inspect peer credit, revenue, or
tips.

## Fairness and business truth

`opportunity_credit_cents` is fairness-only catalog/list price plus permitted
add-ons before tax and tip. Actual service revenue, tax, and tip are separate
nullable business-truth fields and are not ranking inputs.

`staff_entered` request provenance is constrained to
`customer_claim_recorded`; the database cannot silently relabel it as verified
customer intent.

## Rollback boundary

1. Keep `turniq_trust_engine_enabled` absent or `false`.
2. Stop future TurnIQ server readers/writers.
3. Preserve policy, command, event, and fairness receipt rows as audit evidence.
4. Leave existing booking, walk-in, scheduling, and Receptionist Center paths
   unchanged.

Do not drop the ledger during an incident. A destructive cleanup, if ever
needed, requires a separately reviewed retention migration.

## Not included yet

- shadow persistence or historical replay;
- online atomic confirm/override/start/complete RPCs;
- Staff PIN/check-in UI or Live Board;
- group constrained matching;
- offline write authority and reconciliation;
- QA/Production application or salon activation.

Passing M1B local tests is not deployment, Production verification, or pilot
proof.
