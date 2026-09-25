# P1-01 Reminder Recovery — hosted QA preflight

## Scope and identity

- PR #1427 remains Draft; tested commit `438d46f0217ca14e45fdb265acaf6d9f7b402b8a`.
- QA only: Supabase `uhpzafoiifupyypkcwln`.
- Preview `dpl_GzZuAcv3E5EaXXGWb8iFCP2jDLqN`, READY.
- URL: https://nailiq-gff2ouaoa-bepnhobencha-2588s-projects.vercel.app
- Production target unchanged before/after deployment and requests.
- No migration, real booking, customer notification, or provider request.

## Safety and credential handling

Verified branch-only QA URL and internal URL, SMS/email/call kill switches,
payment workers OFF, and card dispatch disabled. Provider/AI credentials were
explicitly empty in deployment overrides. Existing Preview access credential
was used without changing protection/WAF. Random cron secret was supplied only
to this Preview deployment, retained in process memory for the requests, never
printed or written to a local file, and discarded on process exit. The secret
remains configured on that Preview; it has NOT been revoked. No Production or
shared branch cron secret was changed.

## Observed results

1. Previous app-equivalent Preview: root HEAD 200 through existing authorized
   Preview access; unauthenticated reminder GET returned 401 `unauthorized`.
2. Fresh QA read-only preflight immediately before worker invocation:
   zero pending/confirmed bookings in the next 25 hours; zero failed claims
   with remaining attempts and no provider receipt in the same interval.
3. New Preview authenticated reminder GET, first call: HTTP 200, `ok=true`,
   `sent24h=0`, `sent3h=0`, `errors=0`, `recoverySettled=0`.
4. Second call: same HTTP status and zero counters.

The worker records its normal QA cron run/heartbeat metadata; no fixture or
booking was created. These are manual worker calls, NOT evidence that Vercel's
scheduled trigger fired. The two zero-work calls do NOT prove recovery delivery,
concurrency, or idempotency of a real claim.

## Deployment diagnostic retained

Two create requests were rejected with HTTP 400: API `target: preview` is not a
valid target value. Removing that parameter, as in the previously reviewed
Preview deployment script, created the deployment above. No application change
was made to address this CLI/API request problem.

## Remaining acceptance

Follow-up: hosted synthetic recovery/suppression, skip guards, concurrent
execution and cleanup are now covered in
`p1-01-reminder-hosted-synthetic-2026-09-25.md`. The bullets below preserve what
was outstanding when this preflight was recorded; provider and scheduled-trigger
proof remain outstanding.

- Hosted synthetic failed-claim recovery, group/member behavior, simultaneous
  worker execution, cancelled/rescheduled/unknown-outcome skip and cleanup.
- Provider delivery and actual hosted scheduler execution remain NOT PROVEN.
- 14 local database tests use mocked providers and remain separate evidence.
- CI completion must be checked independently; no merge/Ready authorization
  is inferred from this preflight.

Result: PASS for hosted QA connectivity/authentication/empty-worker execution;
NOT PROVEN for full hosted reminder recovery acceptance.
