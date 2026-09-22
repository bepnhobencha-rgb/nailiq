# Daily digest watchdog schema incident — 2026-09-21

## Production evidence

- Vercel invoked `/api/cron/manager` at 21:00 salon-local time.
- The run failed before provider delivery for both salons with Unified Digest
  enabled. The durable worker run recorded two digest failures.
- Neither salon had a same-day `ai_digest_deliveries` receipt or verified
  provider message ID. This report does not claim inbox delivery.
- Production metadata shows `public.watchdog_alerts` has `title` and `body`; it
  does not have a `summary` column.

## Root cause

`getTodayWatchdogAlerts` requested `kind, summary, severity`. PostgREST rejected
the nonexistent `summary` column, so `runDigest` stopped with
`digest_alerts_unavailable` before email delivery. The same stale field also
appeared in the Cancellation Radar alert insert, where the returned database
error was not checked.

The manager previously attempted Unified Digest only at 21:00. A safe failure
therefore had no same-day automatic catch-up even though the manager cron runs
hourly.

## Local implementation

- Read the deployed watchdog contract as `kind, title, severity` and render the
  alert title in the digest context.
- Remove the nonexistent `summary` field from Cancellation Radar writes and
  fail honestly if the alert cannot be stored.
- Give Unified Digest a bounded delivery window at 21:00, 22:00 and 23:00
  salon-local time. `runDigest` retains the durable same-day receipt check and
  stable provider idempotency key, so an accepted report is a no-op on later
  hourly runs.
- Add regression coverage that ties both code paths to the deployed schema and
  verifies catch-up, outside-window behavior and already-delivered no-op.

## Verification

All verification used outbound email and SMS disabled. No provider call or real
email was made.

```text
Focused regression: 126/126 PASS (12 files)
TypeScript: PASS
ESLint touched files: PASS
Production-style Next build: PASS (61/61 static pages)
git diff --check: PASS
```

The build emitted the existing non-blocking Edge Runtime/static-generation
warnings. No migration is required.

## Release boundary

This is a local candidate only. It is not committed, pushed, deployed or
Production-verified. Tomorrow is not protected until the exact candidate passes
CI/Preview and is deployed to Production before the 21:00 salon-local run.

Sending a replacement report for 2026-09-21 is a separate external action. It
must first re-check the delivery receipt and reviewed recipients and requires
explicit approval; this fix did not send one.

Rollback is code-only: revert this hotfix. Do not delete delivery receipts,
provider evidence, worker history or operational exceptions during rollback.
