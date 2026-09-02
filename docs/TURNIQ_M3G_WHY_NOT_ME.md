# TurnIQ M3G — Privacy-safe “Why not me?”

Status: `IMPLEMENTED_LOCAL + TESTED_LOCAL`. Not committed, not deployed, not
QA-proven, not production-proven, and not pilot-proven. The per-salon
`turniq_trust_engine_enabled` flag remains default OFF.

## What M3G adds

- Staff View explains a technician's own persisted skip reason in plain,
  deterministic language without exposing peer revenue, tips, rank inputs, or
  the internal decision trace.
- A skipped technician can request review only when their active staff identity
  appears in that assignment's immutable `skipped_candidates` evidence.
- The review atomically creates one skip-target dispute, one quiet Owner/Admin
  exception, one idempotent command receipt, and immutable dispute/exception
  events.
- Owner/Admin resolves or dismisses the review through the existing M3F command;
  the linked exception closes in the same transaction and the original decision
  is never rewritten.
- Exact command retry returns the committed result and cannot create a duplicate
  active review for the same assignment and technician.

## Security and integrity boundary

- Browser input contains only assignment/policy IDs, review category/reason, and
  the idempotency envelope. Salon, actor, role, and active staff identity are
  re-read server-side.
- The database checks feature flag, tenant membership, active policy, assignment
  ownership, and the actor's presence in the persisted skip trace in one short
  transaction.
- `create_turniq_skip_dispute_v1` is `SECURITY INVOKER`, callable only by
  `service_role`. `anon` and `authenticated` have no execute grant. The dispute
  table keeps forced RLS and its private table grants.
- A typed `target_type` distinguishes `fairness_receipt` from `skip_decision`;
  constraints prevent an invalid nullable receipt combination and a partial
  unique index permits only one active skip review per technician/assignment.
- No queue, assignment, booking, resource, payment, provider, or notification
  state is changed.

## Local verification evidence

- Focused action-core, read-model, Operations Panel, and security tests: 22/22
  passed.
- The migration applied after M3F on the existing throwaway full-schema
  PostgreSQL rehearsal database. M3F regression SQL and M3G synthetic SQL both
  passed.
- Synthetic SQL proved own-skip enforcement, non-skipped technician denial,
  exact retry replay, no duplicate review, linked exception creation, atomic
  resolution, immutable event count, target constraints, forced RLS, and RPC ACL.
- Full unit suite: 651 files passed, 1 skipped; 3,994 tests passed, 1 skipped,
  7 todo. TypeScript strict check, focused ESLint, full ESLint (42 pre-existing
  warnings, zero errors), and Next.js production build passed.
- No QA/Production data, booking, provider, payment, or notification was used.

## Deliberate limits

- Refresh still uses the existing Receptionist Center pull; realtime push is not
  included.
- M3G explains and reviews a persisted decision. It does not change the queue or
  automatically correct a service capability; Owner/Admin records the outcome.
- Refusal, redo, swap, group matching, customer ETA, offline mutation, and pilot
  activation remain later milestones.

## Rollback boundary

1. Keep `turniq_trust_engine_enabled` absent or false.
2. Stop invoking `create_turniq_skip_dispute_v1` and hide the Staff View review
   control.
3. Preserve existing disputes, exceptions, command receipts, and events as trust
   evidence.
4. Do not remove `target_type` or restore `fairness_receipt_id` to `NOT NULL`
   while any skip-decision review exists.
