# P1-01 Reminder Recovery — hosted synthetic QA

## Identity and scope

- PR #1427, Draft; commit `438d46f0217ca14e45fdb265acaf6d9f7b402b8a`.
- Supabase QA `uhpzafoiifupyypkcwln`; no Production database changes.
- Final tested Preview `dpl_4GRC2as8yA4fxy31mPxzfpMcZrem`, READY:
  https://nailiq-rbe3fejje-bepnhobencha-2588s-projects.vercel.app
- Earlier partial run: `dpl_3kK5abiS5BpeYqoFPxDq7RKnkhxH`, same commit.
- Existing Preview access credential used; no WAF/protection changes.
- All deployment SMS/email/call kill switches remain ON; payment workers OFF;
  provider/AI secrets explicitly blank. No provider called or email/SMS sent.
- Temporary cron credentials lived in process memory and the respective QA
  deployment overrides, not local files/output. Process copies discarded on
  exit; credentials still configured in those Previews, NOT claimed revoked.

## Fixture and verification method

Created a dedicated `e2e-reminder-hosted-20260925` synthetic QA salon. Initial
fixture had 11 bookings/10 existing claims. A second fresh batch of four
bookings/claims tested concurrency; no existing claim was reset to retry it.
Total: 15 synthetic bookings, 14 claims, 15 staff, one service/category.

Recipient was `.invalid`; a synthetic permanent suppression record was seeded
and its RPC result verified before invocation. Its synthetic message identifier
was fixture data, not a provider receipt. The actual hosted handler, PostgREST,
claim RPC, suppression lookup, capability minting and completion RPC ran.
Sending wrappers/provider delivery were deliberately not exercised.

Preflight asserted zero non-fixture pending/confirmed bookings or potentially
recoverable claims in the next 25 hours. No real salon was used.

## Results

| Scenario | Observed result |
| --- | --- |
| Failed 24-hour email claim | `suppressed`, attempt 1 → 2, no provider ID |
| Failed 3-hour email claim | Same |
| Group organizer recovery | Own claim settled; no new member claim or shared marker |
| Group member with existing shared marker | Own claim settled; existing marker retained |
| Cancelled booking | Failed claim remained attempt 1 |
| Unknown provider outcome | `unknown`, attempt 1 unchanged |
| Rescheduled occurrence | Old claim remained attempt 1 |
| Three-attempt cap | Failed claim remained attempt 3 |
| Recovery deadline already expired | Failed claim remained attempt 1 |
| Late booking without a previous claim | No claim created |
| Group member SMS claim | No SMS recovery; failed attempt 1 unchanged |
| Repeated worker call after settlement | HTTP 200, zero errors, zero recoverySettled |
| Two concurrent workers on four fresh claims | Both HTTP 200 / zero errors; recoverySettled 4 and 0 |
| Replay after concurrent run | HTTP 200, zero errors, zero recoverySettled |

Independent SQL assertions passed: exactly 14 total claims; eight eligible
email claims each suppressed at attempt 2 with no provider ID; six skipped
claims unchanged; no claim for the late first-send case; no new shared marker;
the two seeded member markers retained. No duplicate claim or extra attempt.

### Failed test transport retained

The first attempted concurrent pair on the earlier Preview ended with client
`fetch failed`. Vercel logs showed one HTTP 200 invocation at 06:37:46 UTC;
database inspection showed all four eligible claims settled exactly once.
The pair is NOT counted as a successful concurrency test, and the underlying
transport failure is not claimed fixed. The runner was changed to capture
individual transport outcomes without discarding the in-memory key immediately.
The fresh four-claim pair on the final Preview then passed. This does not erase
the earlier failure or prove its network cause.

## CI

- Runs `36101862146` and `36101862180`: success, attempt 1.
- 21 successful GitHub CheckRuns plus successful Vercel status context.
- Two skipped jobs: dispatch-only MQA-0148 and AI Triage after successful E2E.
- CI monitor `nailiq-pr1427-group-test-ci` removed after completion.
- 14 local DB tests with mocked providers remain separate evidence.

## Cleanup and release boundary

After assertions, stopped the authenticated runner and deleted only the exact
owned synthetic salon/category. Verified zero remaining salon, booking, claim,
suppression, staff, service and category rows for this fixture. Normal QA cron
run/audit metadata is retained, not erased. Synthetic data was deleted, not
archived; this is not a backup of the fixture.

Production target unchanged before and after testing. No migration, merge,
Ready transition, new commit or push in this test session.

**PASS:** hosted synthetic recovery/suppression, skip guards, repeated calls,
fresh concurrent execution and fixture cleanup.

**NOT PROVEN:** provider delivery, actual scheduled Vercel cron firing, real
customer receipt, unsuppressed sender path, full Production/pilot acceptance.
Do not label this report 100% of the Master Plan or complete reminder delivery.
