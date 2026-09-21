# Scoped daily digest recovery

## Scope and safety

Recover only an explicitly selected salon/report date to its configured digest
recipients. No manager-cron invocation, AI call, recipient/flag/configuration
change, booking mutation, or database migration. Server Action requires an
active platform operator session AND target-salon owner/admin membership.

The existing claim RPC serializes attempts by salon/date. Claims remain after
ambiguous failures; operators must reconcile provider/receipt evidence before
any manual recovery. Only yesterday or today after 22:00 salon-local is eligible.
Regular cron dedupes by report date, not the day the recovery email was delivered.
The recovered summary explicitly describes currently stored booking records,
not a historical snapshot or verified payment revenue.

## Local evidence

- `npm run test:unit`: 6,446 passed, 65 skipped (840 passed suites).
- `npm run typecheck`: passed.
- ESLint for touched source/tests/fixture: passed.
- `git diff --check`: passed.
- `npm run build -- --webpack` with dummy Supabase values and outbound SMS/email
  disabled: passed. Default Turbopack local build is blocked by the shared
  node_modules symlink outside its filesystem root; fresh-install CI remains
  required.
- UI fixture build and Playwright commands in `qa/digest-backfill/README.md`:
  2 passed (desktop Chromium and iPhone WebKit), no database/provider calls.

Focused regression coverage includes authorization, target tenant, strict input,
auditing before send, configured recipient pinning, date/DST eligibility,
truncated statistics, previous delivery, concurrent/retried claims, provider
ambiguity, failed receipt persistence, and next-day regular-cron dedupe.

## Release / recovery boundary

At the time of this local report, commit, CI, Preview, Production deployment and
real delivery are not yet proven. Verify the deployed SHA before operating the
card. Check the selected date and configured recipient count, then confirm once.
Inspect the receipt/provider ID afterward. An accepted provider response is not
proof of inbox delivery.

Rollback code to previous Production SHA
`0b946cff436e284858c22d13ea8b553b32d4b464` if required. Preserve execution claims,
audit logs and delivery receipts; rollback does not unsend an email and must not
erase dedupe evidence. No schema rollback is needed.
