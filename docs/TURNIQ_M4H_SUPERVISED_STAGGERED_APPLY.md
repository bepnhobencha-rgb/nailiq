# TurnIQ M4H — Supervised Staggered Apply

Status: `IMPLEMENTED_AND_TESTED_LOCAL_NOT_DEPLOYED`

TurnIQ remains behind `turniq_trust_engine_enabled`; every salon remains OFF.
This milestone did not commit, push, apply QA/Production, mutate a real booking,
call a provider or send a notification.

## Outcome

The Receptionist Center can now turn one M4F timing simulation into a supervised
M4G plan without trusting assignment facts from the browser:

1. The desk compares `Arrive together`, `Leave together` and `Smart Wave` from
   one server-owned snapshot.
2. A feasible option has `Choose this plan`. This first action records a review
   plan only; it does not move or assign any booking.
3. The server reloads the salon-scoped group, policy, staff, shifts, skills,
   schedule and resources; recomputes the selected option; and verifies the
   exact snapshot version, deterministic simulation UUID and full SHA-256
   fingerprint shown by the comparison.
4. The saved plan displays every guest, technician, resource, start/end and
   wave, plus an explicit all-or-nothing warning.
5. A separate `Apply and confirm all guests` action supplies the expected plan
   state version to the M4G transaction. One conflict rolls back the whole
   group.

## Trust and retry boundary

- Browser input contains identifiers, bounded timing preferences, displayed
  simulation identity and idempotent command envelope only. It cannot nominate
  staff/resources or submit fairness values, PII or internal traces.
- A comparison expires after five minutes. The original comparison timestamp
  is pinned during trusted recomputation so unchanged facts reproduce the exact
  fingerprint; changed facts fail closed.
- Record and confirm use separate command IDs. The same ID is retained across a
  network retry.
- Command-receipt replay happens before freshness/state rejection. A committed
  success remains success even when the comparison later expires, the plan is
  already confirmed or UI refresh fails.
- Offline disables compare, save and confirm. No provider or notification path
  exists in either action.
- Deterministic simulation IDs are now RFC-4122-shaped UUIDs compatible with
  the M4G database contract; the full SHA-256 fingerprint remains authoritative.

## Local evidence

- M4H focused component, projection, engine and security-boundary tests: 32/32
  PASS.
- TypeScript: PASS.
- Full unit: 669 files passed, 1 skipped; 4,086 tests passed, 1 skipped and
  7 todo.
- Lint: 0 errors; 42 pre-existing warnings outside the M4H files.
- Next.js production build: PASS; existing Edge Runtime warnings remain.
- M4G's prior disposable-PostgreSQL atomic confirmation rehearsal remains the
  database evidence; no database schema changed in M4H.

## Not included yet

- QA, Preview, Production, live-salon or pilot proof.
- Customer approval and notifications for a changed group time.
- Multi-service segments or in-progress multi-technician handoff.
- Realtime push or offline mutation.

Next safe milestone is M4I: add a synthetic browser story for compare → choose →
review → atomic confirm against disposable QA, still default OFF and without
provider calls or real notifications. That requires separate QA authorization.
