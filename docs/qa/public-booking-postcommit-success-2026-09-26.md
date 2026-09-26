# Public booking — committed result must reach Success

Date: 2026-09-26. Local branch `fix/booking-success-after-commit-20260926`,
based on `origin/main` at `67e3fb6b`. This is a focused follow-up to the
booking-submit WebKit gate, not evidence that PR #1429 caused that failure.

## Evidence and boundary

- PR #1429's non-RC E2E run `36188450412` completed 9/10 repeated WebKit
  booking submissions. In the failed trace, the create RPC and later
  card-capability/Wix requests returned HTTP 200, but `booking-success` was
  absent before the assertion timed out. A `page-crash` event was recorded
  later; the trace does not prove whether the crash caused or followed the
  missing Success view. PR #1433's separate 10/10 PASS does not erase the
  earlier failure or prove its cause was fixed.
- Source inspection found two optional post-commit awaits in the individual
  flow: browser-local request-ID cleanup (which may wait on a Web Lock) and
  Try-On attachment (which may wait on network). Both ran before `setStep("done")`.
- Two focused tests reproduced indefinite pending after a synthetic committed
  booking: one for each await. Both timed out before the code change and PASS
  after it. No database, payment, SMS, email, or provider was called.

## Change

Start best-effort request-ID cleanup without awaiting it. Start optional
Try-On attachment in a guarded background task. Preserve the authoritative
create result, idempotency key, exact cleanup material, card-management truth,
and existing Try-On failure logging. Never convert a failed/unknown create to
Success; only a resolved `submitPublicBooking` result enters Done.

The card-management source-contract test now accepts either awaited or
non-awaited cleanup initiation before the Done view. The new behavioral test
requires non-blocking Success, so this is not merely a relaxed assertion.

## Local verification

- Red tests before fix: both new pending-cleanup and pending-Try-On cases
  timed out at 2 seconds.
- Focused Vitest: 33/33 PASS across four files.
- Full Vitest: 7,175 PASS, 79 skipped, 0 failed; first run exposed the older
  source-contract assertion, which was updated and the full suite rerun.
- `npm run typecheck`: PASS.
- `npm run build`: PASS (61/61 static pages). Existing Edge Runtime warning.
- ESLint on touched booking source and tests: 0 errors, 3 existing warnings.
- `git diff --check`: PASS.

## Not proven / next gate

This is local code and synthetic unit evidence, not a reproduced diagnosis of
the Linux WebKit native crash. Run the isolated booking-submit 10-repeat
WebKit gate and inspect trace if it fails, then verify a QA Preview on the
exact SHA with outbound channels disabled. Do not count a green retry as proof
that the historical native crash is gone. At this local checkpoint, no commit,
push, PR, migration, Preview, Production change, provider call, or real
notification had been made; publication evidence must be tracked separately.

Rollback: revert the two non-blocking post-commit scheduling changes and their
tests only; no schema or durable receipt changes exist in this batch.
