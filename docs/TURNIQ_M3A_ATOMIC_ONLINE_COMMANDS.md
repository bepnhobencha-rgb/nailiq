# TurnIQ M3A Atomic Online Commands

Status: `implemented locally` and `tested locally`. Nothing in this milestone
has been committed, pushed, applied to QA/Production, deployed, or enabled for
any salon. TurnIQ remains default OFF.

## What M3A adds

`src/shared/turniq/onlineCommandEngine.ts` is the pure transition contract for:

- staff check-in, approved break, return, temporary safety hold, hold release,
  and check-out;
- recommendation confirmation, reason-required override, service start, and
  service completion;
- turn and opportunity-credit consumption only at completion.

The transition engine does not read Supabase, mutate a booking, call a provider,
or expose peer financial data.

Migration `20260901225714_add_turniq_atomic_online_commands.sql` adds
service-role-only, security-invoker RPCs:

- `apply_turniq_shift_command_v1`;
- `record_turniq_recommendation_v1`;
- `apply_turniq_assignment_command_v1`.

Every committed command verifies the salon feature flag, exact membership role,
policy/salon binding, salon-local business date, and command fingerprint. A
transaction-scoped advisory lock serializes duplicate command IDs. Retrying the
same command returns the original result and does not duplicate a turn, event,
or Fairness Receipt.

## Atomic truth

For the supported single-service path, confirm/start/complete locks the TurnIQ
assignment, booking, and shift before changing them. The same transaction
commits:

- booking staff/status truth;
- TurnIQ assignment lifecycle and version;
- shift turn count and opportunity credit at completion;
- immutable TurnIQ event;
- idempotent command receipt;
- exactly one Fairness Receipt at confirmation or override.

Actual service revenue and tax are derived from the authoritative booking
snapshot at completion. Tax and tip never affect fairness ranking. Tip remains
null until a later checkout integration supplies authoritative business truth.

## Permission boundary

- `owner`, `admin`, `senior`, and `receptionist` may record, confirm, and
  override a recommendation.
- A `nail_tech` may change only their own shift and may start/complete only the
  TurnIQ assignment bound to their own active staff row.
- A receptionist/senior self-assignment against the recommendation is not
  silently accepted. It creates one audited `self_assignment_override`
  Exception and requires Owner/Admin confirmation.
- Browser roles have no RPC execution grant and no direct TurnIQ table grant.

## Local verification evidence

- Pure transition/security tests passed.
- M1B plus M3A migrations applied to an isolated Postgres 16 database.
- Synthetic `check-in → recommend → confirm → start → complete` passed.
- Replaying the confirm command returned the same assignment and Fairness
  Receipt with no duplicate receipt, event, or turn.
- A synthetic receptionist self-assignment override remained uncommitted,
  created exactly one open Exception, and replayed without duplication.

These are local synthetic results, not QA, Production, or pilot proof.

## Deliberate limitations

- Only `schedule_model = 'single'` is supported in M3A. Group and multi-service
  constrained matching belong to M4.
- No Server Action, Live Board, Staff View, Exception Inbox, or realtime
  subscription calls these RPCs yet.
- Add-service, swap, refusal, redo, dispute resolution, and offline writes are
  not implemented by this milestone.
- Existing Receptionist Center mutations remain unchanged while TurnIQ is OFF.
- No SMS, email, push, voice, payment, Square, or Stripe action is called.

## Rollback boundary

1. Keep `turniq_trust_engine_enabled` absent or false.
2. Stop future callers of the three M3A RPCs.
3. Preserve command/event/receipt/exception evidence.
4. Continue using the existing Receptionist Center booking lifecycle.

Do not drop the TurnIQ ledger during an incident. A destructive retention action
requires separate review and approval.
