# TurnIQ M3F — Dispute & Exception Commands

Status: `IMPLEMENTED_LOCAL + TESTED_LOCAL`. Not committed, not deployed, not
QA-proven, not production-proven, and not pilot-proven. The per-salon
`turniq_trust_engine_enabled` flag remains default OFF.

## What M3F adds

- A technician can flag a concern only from their own durable Fairness Receipt.
- Creating a dispute atomically writes the dispute, a quiet owner exception, an
  idempotent command receipt, and immutable dispute/exception events.
- Owner/Admin can acknowledge any actionable exception, then resolve or dismiss
  it with a required reason.
- Resolving a staff dispute atomically resolves or dismisses its linked owner
  exception. The original receipt and original events are never rewritten.
- Staff View shows only the technician's own dispute reason and outcome. It does
  not expose peer revenue, tips, fingerprints, or internal traces.
- Owner Exception Inbox shows the privacy-safe dispute reason and provides
  one-tap acknowledge plus reasoned resolve/dismiss controls.
- Ambiguous retries reuse the exact command envelope. A committed mutation stays
  successful even if the following read refresh fails.

## Security and integrity boundary

- Browser input carries only the receipt/dispute/exception ID, policy version,
  requested command, and idempotency envelope. Salon, actor, role, and active
  staff identity are re-read server-side.
- The database rechecks feature flag, tenant membership, policy ownership, actor
  role, and own-receipt ownership inside the same transaction.
- All three RPCs are `SECURITY INVOKER`, callable only by `service_role`, with no
  direct browser grant. TurnIQ tables keep forced RLS and private grants.
- State transitions use row locks and monotonic `state_version`; command IDs use
  transaction-scoped advisory locks and immutable receipts.
- The migration does not touch bookings, payments, resources, providers, or
  notification dispatch.

## Deliberate limits

- “Why not me?” for a technician who was skipped has no receipt-backed dispute
  target yet; that needs a privacy-safe skip receipt or dedicated query contract.
- Exception/dispute updates refresh with the existing Receptionist Center pull;
  realtime push is not included.
- Refusal, redo, swap, group matching, customer ETA, offline mutation, and pilot
  activation remain later milestones.

## Local verification evidence

- Focused action-core, read-model, Operations Panel, and security tests: 21/21
  passed.
- The M3F migration applied to a throwaway PostgreSQL database containing the
  preceding TurnIQ schema. Synthetic tests proved create, exact retry replay,
  no duplicate dispute, linked exception, atomic dispute resolution, exception
  acknowledge/resolve, immutable event versions, and RPC ACL.
- Full unit suite: 650 files passed, 1 skipped; 3,988 tests passed, 1 skipped,
  7 todo. TypeScript strict check, focused ESLint, full ESLint (existing warnings
  only), and Next.js production build passed.
- No QA/Production data, booking, provider, payment, or notification was used.

## Rollback boundary

1. Keep `turniq_trust_engine_enabled` absent or false.
2. Stop invoking the three M3F RPCs and remove the dispute/exception controls.
3. Preserve existing disputes, exceptions, command receipts, and events as trust
   evidence.
4. Do not drop `state_version` columns or command types while any M3F evidence
   references them.
