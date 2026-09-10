# Booking mobile submission: investigation and CI diagnostics

Date: 2026-09-09 America/Vancouver (test artifacts use 2026-09-10 UTC).

## Verdict

Application defect/root cause: **NOT_PROVEN**. Diagnostics patch: **LOCAL PASS**.
No application code, database schema, existing retry setting, or booking assertion
deadline was changed. This is not a claim that the intermittent booking failure is fixed,
or that the 784-function inventory is complete.

## Observed CI failure

Base: `c31a8bc64b4f473217cdb17aeb2b39f74c509ae7`.
[Main E2E run 34424620839](https://github.com/bepnhobencha-rgb/nailiq/actions/runs/34424620839),
job `102707180002`: `Booking Flow / Complete booking end-to-end`, mobile WebKit,
failed its 15-second `booking-success` assertion on attempt 0 and passed retry 1.

The trace records HTTP 200 and `success: true, code: booked` from
`create_public_booking`, followed by HTTP 200 from card capability. This is the
RPC response, not an independent database read. The last captured frame shows
Submitting, but the trace does not show the entire subsequent assertion window.
No recorded 5xx or page error explains the failure. Web Lock/digest timing is a
hypothesis only; the existing successful release is not established as its cause.

## Patch

Wrap only the complete-booking test in passive diagnostics. Attach elapsed
request/response events for fixed submission endpoint paths, page error/crash/
close counts, final UI state, Web Locks availability, and booking-lock counts.
Do not record raw URLs, headers, response/request bodies, error messages, lock
names, or booking/customer identifiers. HTTP 200 alone does not prove business
success; retain the original assertions and Playwright trace for that evidence.

The browser snapshot has a two-second diagnostic deadline and reports unavailable
or timed out when it cannot be read. Diagnostic errors do not replace the original
test failure. Event listeners are removed afterward. No application APIs or
browser primitives are patched by the shipped helper.

PR non-RC tests otherwise run this case only in Chromium. Add a scoped WebKit
step for the same complete-booking case, repeated 10 times with retries disabled,
using the existing isolated CI database. Preserve the main shard report by writing
the new HTML/JSON report under `booking-submit-webkit`. Existing cleanup remains
unconditional. Local test discovery verifies that the command selects exactly
the intended 10 executions.

## Local evidence

Disposable Supabase project: `nailiq-booking-submit-20260909`; localhost only.
Pinned Supabase CLI 2.109.1, tracked E2E baseline, schema parity PASS. Local
production build uses Webpack; GitHub uses the workflow's default build path.
macOS WebKit is not the same runtime as Linux WebKit on CI.

| Check | Result |
| --- | --- |
| Original complete-booking mobile test, retry 0, repeat 10 | 10 PASS |
| Temporary digest/lock timing probe, same case, repeat 10 | 10 PASS |
| Original full booking spec, both projects, retry 0 | 6 PASS |
| Full booking spec with final diagnostics, retry 0 | 6 PASS |
| Temporary controlled-failure/privacy/closed-page checks, both projects | 4 PASS |
| TypeScript `tsc --noEmit` | PASS |
| ESLint for both changed TypeScript files | PASS, no warnings |
| Production build `next build --webpack` | PASS, before test-only edits |
| `git diff --check` | PASS |

These are repeated test executions, not 36 distinct product features. Temporary
probe/validation specs are archived as evidence and excluded from this patch.
The final helper recorded successful UI state and zero held/pending booking
locks on both browsers; Web Locks were available in both. Earlier probe runs
recorded fast digests but no lock events, which does not establish absence of
Web Locks or a cause of the CI failure.

After the final sweep, the disposable DB contained zero auth users, salons,
bookings, and client profiles. Local Mailpit contained zero messages. The local
server and disposable database are stopped after verification. No Production
customer data or external providers were used in this investigation.

## Evidence and next gate

Local artifacts: `/Users/huytran/nailiq-audit-results-20260907/booking-mobile-submit/`.
Key files: `baseline-repeat.json`, `diagnostic-repeat.json`,
`booking-full-baseline.json`, `booking-with-diagnostics.json`,
`diagnostics-failure-validation.json`, `typecheck.log`, `lint.log`,
`build-baseline.log`, `schema-parity.log`, and `cleanup-counts.txt`.
Original CI trace is preserved under the adjacent `signup-reload-prefetch/`
artifact folder, with the summary `MAIN_C31_BOOKING_FLAKY.md`.

Branch: `fix/booking-mobile-submit-20260909`. User approved commit/push and a PR
for this diagnostics-only patch; the scoped WebKit step supplies the missing
PR engine coverage. CI/Preview results are pending publication at this checkpoint.
If the failure recurs, use the new attachment plus the trace to locate
the stalled phase before changing application behavior. Publishing diagnostics
does not itself resolve the intermittent failure or authorize a Production release.
