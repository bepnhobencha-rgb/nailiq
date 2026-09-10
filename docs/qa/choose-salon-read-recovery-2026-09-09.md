# Choose-salon read recovery — 2026-09-09

## Scope and cause

Phase 1 authentication / salon selection, inventory item 43 (multi-salon picker).
Base: `e940731d07b771d2354cd45d68d9598f35578e9a`.

An authenticated visit to `/choose-salon` called `redirect('/login')` when either
`salon_members` or `salons` returned a query error. A temporary read failure was
therefore treated as a reason to leave the picker, without an inline explanation
or retry. The session was not explicitly signed out. The proxy also has its own
signed-in login redirects; this finding does not assert that users always see the
login form or that an infinite redirect loop has been proven.

The fix returns the existing picker with no cards and a localized unavailable
message. Its shared Button refreshes the Server Component in a transition, shows
busy state, and becomes usable again if the read still fails. Only successful
server reads can restore cards. Sign-out and retry cannot run concurrently from
these controls.

Existing no-user, zero-membership, unresolved-salon and single-salon role routing
remain unchanged. No SQL, schema, RLS, provider configuration, mutation action or
session policy changes. No raw database error is passed into the client.

## Regression evidence

- Baseline: 4 failing recovery cases, 12 passing existing access/routing cases.
  Both query stages were tested with no data and with partial data plus an error.
- Fixed: 16/16 focused unit cases pass, including authenticated user filtering,
  salon ID scoping and single-salon routing for all five roles plus unknown/null
  roles falling back to nail-tech access.
- Complete unit suite: 4,587 passed, 1 skipped; 739 files passed, 1 skipped.
- Production build (`next build --webpack`): passed using synthetic loopback env.
- Touched-file ESLint: passed with no warnings/errors.
- Typecheck: passed after the build.
- Browser acceptance: 8/8 passed; 0 page errors, 0 attempted browser writes.
  Both failing and recovered screenshots were saved for all 8 scenarios.
- Visual second pass: inspected Chromium EN failure, Chromium VI recovery,
  and WebKit EN failure; no clipping or inconsistent new color tokens found.
- Test fixture corrections: scoped the error locator to `main` because Next.js
  adds its own route-announcer alert; this was a test selector error, not an
  application failure.

## Browser method and limitations

The actual Next production server and Supabase SDK run against an isolated HTTP
fixture at `127.0.0.1:54321`. User, session and salon data are synthetic. The fixture
returns 503 for the chosen page query; the proxy's separate coarse membership
read succeeds. This isolates recovery inside the picker, rather than claiming
coverage of every proxy/auth failure. The only implemented POST is the fake
session-active RPC; no provider, account or customer write is implemented.
Browser non-GET/HEAD requests and off-origin requests are blocked.

Acceptance matrix: Chromium 320px and WebKit iPhone 13, each EN/VI, at both query
failure stages. Check error copy, absent cards, preserved session cookie, a >=44px
retry target, no horizontal overflow, a failed retry followed by successful retry
in the same browser context, correct owner/receptionist card links, and no browser
page errors or writes. Screenshots cover failure and recovery states.

An initial baseline browser fixture attempt did not complete because redirect
handling exercised additional proxy/setup queries outside that fixture. It is not
counted as a passing baseline browser run. The baseline failure is established by
the real page unit tests; fixed browser results are recorded separately.

Artifacts: `/Users/huytran/nailiq-audit-results-20260907/choose-salon-recovery/`.
The fixture and browser runner are `route-browser.cjs`; complete suite output is
`all-unit.log`; narrow before/after output is `baseline-unit.log` and
`focused-unit.log`.

## Release boundary

This report records the local acceptance checkpoint before publication. PR checks
and deployment status must be verified separately against the published SHA. It
does not certify all 784 features or live salon/RLS/provider behavior. CI, Preview,
Production, real multi-account access and device hardware acceptance remain
unproven for this candidate. Unexpected thrown exceptions outside the SDK's typed
query-error response contract remain outside this patch.
