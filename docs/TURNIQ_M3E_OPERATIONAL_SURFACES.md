# TurnIQ M3E — Operational Surfaces

Status: `IMPLEMENTED_LOCAL + TESTED_LOCAL`. Not committed, not
deployed, not QA-proven, not production-proven, and not pilot-proven. The
per-salon `turniq_trust_engine_enabled` flag remains default OFF.

## What M3E adds

- Front-desk team list includes every active technician, with checked-in staff
  ordered by authoritative queue position and remaining staff clearly marked
  `not_checked_in`.
- One-tap check-in, approved break, return, and release-hold controls reuse the
  existing atomic `apply_turniq_shift_command_v1` command.
- Confirmed assignments can be started and in-progress assignments can be
  completed through the existing atomic assignment command.
- A technician receives a privacy-safe Staff View containing only their own
  queue state, turn count, opportunity credit, current assignment and receipts.
- Owner/Admin sees a quiet Exception Inbox. Routine work explicitly needs no
  owner action; only open or acknowledged real exceptions are shown.
- Ambiguous transport retries reuse the exact command ID/device/sequence. Once
  a command succeeds, a later read-refresh failure cannot change that committed
  success into a retry prompt.

## Security and integrity boundary

- Browser input still contains only IDs, policy version and the requested
  command. Salon membership, feature flag, actor role and assignment ownership
  are re-read server-side.
- Service-role access remains in the `server-only` DAL. Browser roles have no
  direct access to the TurnIQ ledger.
- Shift and assignment mutations remain transactional and idempotent. The M3E
  migration replaces the existing shift RPC in place so a new-day check-in can
  atomically close an earlier open shift and append a rollover event; it adds no
  browser-callable RPC.
- The team list reads only active, non-deleted staff. Technician projections
  never expose peer opportunity credit, revenue, tax, tips or fingerprints.

## Deliberate limits

- TurnIQ disputes have an additive tenant-safe table but no audited create and
  resolution RPC yet. M3E does not display a fake dispute button or write rows
  directly; that is the next reviewable milestone.
- Check-out, temporary-hold creation, refusal, redo and swap need their own
  reason/confirmation UX before exposure.
- The Exception Inbox is read-only until acknowledge/resolve commands can append
  immutable events atomically.
- No realtime subscription, group matching, customer ETA, offline mutation or
  pilot activation is included.

## Local verification evidence

- Focused TurnIQ read-model, action, Live Board, Operations Panel and security
  tests: 26/26 passed.
- Full unit suite: 649 files passed, 1 skipped; 3,980 tests passed, 1 skipped,
  7 todo.
- TypeScript strict check, focused ESLint and Next.js production build passed.
- A throwaway PostgreSQL 17 database rebuilt all 472 migrations. The local
  harness needed a synthetic `supabase_realtime` publication because plain
  PostgreSQL does not install Supabase Realtime metadata.
- Transactional synthetic rollover passed: earlier open shift closed with an
  immutable event, next-day check-in joined today's queue, identical retry
  replayed without duplicates, same-day duplicate was rejected, and function
  ACL remained denied to `anon`/`authenticated` and granted only to
  `service_role`.
- No QA/Production data, booking, provider, payment or notification was used.

## Rollback boundary

1. Keep `turniq_trust_engine_enabled` absent or false.
2. Remove `TurnIqOperationsPanel` from Receptionist Center.
3. Restore the M3A definition of `apply_turniq_shift_command_v1` only if the
   rollover behavior must be removed.
4. Preserve existing TurnIQ shifts, events, assignments, receipts and exceptions
   as evidence.
