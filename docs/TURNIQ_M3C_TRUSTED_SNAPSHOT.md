# TurnIQ M3C — Trusted Snapshot + Live Board

Status: `IMPLEMENTED_LOCAL + TESTED_LOCAL`; not committed, not deployed,
not QA-proven, not production-proven, not pilot-proven. Every salon remains
OFF because `turniq_trust_engine_enabled` is default OFF.

## What M3C adds

- A pure trusted-snapshot adapter that converts salon-scoped booking, policy,
  open shift, staff, capability, appointment-gap and resource truth into the
  deterministic single-customer engine contract.
- A Server Action whose browser input contains identifiers only: salon slug,
  booking ID, command ID, device ID and local sequence. The browser cannot
  submit a technician, policy, resource, fairness value, provenance label,
  decision trace or actor.
- Exact command-receipt replay happens before mutable booking reload. Concurrent
  retries use a stable command-intent fingerprint, so the same command cannot
  create a duplicate recommendation merely because snapshot time changed.
- A server-only loader that authenticates membership, checks the salon flag and
  desk role, loads every decision input with service-role access, re-runs the
  deterministic engine, and then uses the M3A idempotent recommendation RPC.
- A privacy-safe TurnIQ Live Board in Receptionist Center. It shows the next
  technician, explanation, skipped operational reasons and whether an owner
  exception exists. It exposes no customer PII, peer revenue, peer tips or
  internal decision trace.
- The board refreshes through the existing Receptionist Center reload path.
  Feature-OFF salons do not load or render it.

## Fail-closed boundaries

M3C refuses to produce a live recommendation when any of these are true:

- booking is not a same-day, single-customer, `schedule_model='single'` row;
- booking is already assigned to a technician;
- booking uses `booking_addons` rows that the current M3A opportunity-credit
  RPC does not yet include;
- an active policy, service catalog row, shift, capability truth or required
  resource cannot be verified;
- a service lists multiple alternative resource kinds, because the current
  engine contract treats required kinds conjunctively;
- an assigned resource is conflicting or cannot be reconciled;
- the booking is stale, terminal, deleted, cross-salon or outside the current
  salon-local business day.

Legacy `staff_requested_by_client + staff_id` can be represented by the pure
adapter as `legacy_unknown` for replay and is never granted requested-tech
precedence. The live recommendation action currently rejects all preassigned
bookings, so it cannot silently compete with an existing assignment.

## Safety boundary completed by M3D

M3C itself remains a read-only snapshot milestone. M3D adds the atomic
capability, shift-version, catalog, daily-capacity, appointment-gap and resource
revalidation required before the supervised Confirm/Override controls are
shown. See `docs/TURNIQ_M3D_SUPERVISED_CONFIRMATION.md`.

Refusal penalties also need a dedicated active-state contract. Temporary and
safety holds are represented by the current shift state; M3C does not invent an
active refusal penalty from historical events.

## Verification

Focused commands:

```bash
npx vitest run \
  src/shared/turniq/__tests__/trustedSnapshot.spec.ts \
  src/shared/security/__tests__/turniqTrustedSnapshotBoundary.spec.ts \
  src/shared/security/__tests__/turniqServerBoundary.spec.ts \
  src/components/receptionist/__tests__/TurnIqLiveBoard.spec.ts
npx tsc --noEmit --pretty false
npx eslint <M3C changed TypeScript and TSX files>
git diff --check
```

Focused result: 17 tests PASS; typecheck PASS; focused lint PASS; diff check
PASS. Full suite: 646 files / 3,968 tests PASS, 1 file / 1 test skipped,
7 todo. Next.js production build PASS (the repository's existing Edge Runtime
deprecation/static-generation warnings remain warnings).

## Rollback boundary

Keep `turniq_trust_engine_enabled` OFF. Removing the Live Board props and the
identifier-only recommendation action restores the pre-M3C product surface.
M3C adds no migration and makes no provider call or notification.
