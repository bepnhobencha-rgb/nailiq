# P1-01 / Day 9 — current evidence boundary (2026-09-28)

This is a read-only closeout checkpoint, not a release approval or pilot PASS.
No email, SMS, booking, provider request, Production write, deployment, or
configuration change was made for this checkpoint.

## Production facts verified

- Supabase Production project `fshmobzyjhmtvndobwsy` lists the callback ACL
  migration under applied version `20260928032750` with name
  `20260928024301_allow_own_customer_email_projection_terminal_callbacks`.
  The inspected reconciliation function is `SECURITY DEFINER` owned by
  `postgres`; `anon`, `authenticated`, and `service_role` do not have direct
  execute permission on that signature. This proves the inspected metadata,
  not every callback path.
- At inspection, the reminder claim ledger had 10 `delivered` rows updated in
  the preceding 72 hours (three 24-hour and seven 3-hour reminders). The
  separate aggregate event inspection found applied terminal reminder rows
  without a recorded match error; this audit did not join each of the 10
  claims to its individual event. These are database/provider-callback states,
  **not proof of recipient inbox placement** or of every scheduled reminder.
- Six older `provider_accepted` reminder claims lacked a matching terminal
  callback in the inspected event set. All six were more than 30 days old;
  none was a newly stuck claim from the last 30 days. They were not modified,
  retried, or represented as delivered.
- Vercel Production deployment `dpl_AMPL54VemNGUeGk9EkjGkyRsgyTJ` is READY
  and aliased to `www.nailiq.ca`. A read-only request to `/api/version` on that
  domain returned the same deployment ID. The deployment was created by CLI
  and carries no Git SHA in Vercel metadata; the endpoint also returns the
  deployment ID rather than a commit SHA. Therefore this evidence proves the
  serving deployment identity, **not the exact source commit bundled into it**.
- A fresh connected Vercel deployment read on 28/09 again showed `source=cli`,
  `target=production`, `state=READY`, the live alias, and `meta={}` for that
  deployment. Nearby Preview deployments have Git metadata, but that does not
  establish the source of the separate CLI Production artifact. The connected
  build-log call returned `Tool get_deployment_build_logs not found`, while
  local `vercel inspect --json` returned no data; neither is a successful
  build-log inspection. Source SHA remains **not proven**.

## Distinct unresolved gates

1. PR #1429 remains Draft. Current-main integration, local/disposable WebKit,
   and CI/Preview checks are separate from an authenticated hosted provider
   acceptance plus inbox test for card-retry email. Do not mark it Ready or
   merge solely from green tests.
2. The Day 9 Production database migration and serving deployment identity do
   not, by themselves, establish the exact deployed application source SHA.
   Preserve the clean-checkout-to-deployment receipt for the next manual
   release using the updated `docs/GO-LIVE-RUNBOOK.md`; do not infer a source
   SHA from creation time or a nearby Preview.
3. P1-07 human pilot cannot be scored from automation. The existing
   `docs/qa/day5-human-acceptance-sheet.md` records the five receptionist
   tasks, time and help count; `docs/MASTER_PLAN.md` requires three real salons,
   7–14 days, an older owner and two low-tech receptionists. A copied test
   salon is useful for rehearsal but does not count as a real pilot salon.

## Local consent regression check

- On the isolated current-main + Draft #1429 integration checkout, six focused
  Vitest files covering signed SMS STOP, inbound command classification,
  reminder delivery claims, optional email opt-out, email compliance, and
  reminder runtime passed: **120/120 tests, 6/6 files**. The runtime and sender
  tests mock database/provider calls; this is not a hosted callback, real
  provider, inbox, or Production test. No application code was changed.
- The test checkout is not the deployed Production source identity. Its green
  result must not close the provider/inbox or exact-deployment-SHA gates above.

## Safe next action

Keep PR #1429 and the provider/inbox gate open. Prepare a human pilot only
after the P0/P1 notification and release gates are evidenced; obtain named
salon and participant consent before any real-salon test. Do not send, retry,
backfill, or change the six historical claims as part of this read-only audit.
