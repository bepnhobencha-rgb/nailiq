# AUTH-COOKIE-01 — Shared Auth cookie transport

Base: `e9fe404f4611562678d6b77ddc3fb9dc3e276dfd` (PR #1389).
Branch: `fix/auth-cookie-secure-20260910`. Local verification; unpublished.

## Confirmed failure and cause

The preceding real-Auth MFA acceptance observed session cookies without
`Secure` on HTTPS in both Chromium and mobile WebKit. Its CI also recorded 46
cookie metadata entries with `secure=false`. These were disposable local/CI
sessions, not an inspection of authenticated Production cookies.

The installed `@supabase/ssr` defaults do not set `secure`. The shared server
client, browser client and proxy refresh client used those defaults. The OAuth
callback and some proxy redirects separately forced `Secure` in production,
leaving the policy inconsistent across cookie writers. A regression using the
real installed SSR SDK and synthetic transport fails against the base server
client because the emitted options omit `secure`.

## Change

- Set one transport policy through the SDK's `cookieOptions`, including cookie
  chunks, PKCE verifiers, refreshes and removals.
- Default to Secure for hosted, absent or invalid origins. Only explicitly
  configured HTTP loopback apps may use non-Secure cookies for local QA/dev.
  Vercel server execution always requires Secure.
- Use the actual browser origin. A server HTTPS transport hint may strengthen
  the policy; a forged HTTP/Host/forwarded hint cannot downgrade hosted HTTPS.
- Preserve cookie flags when copying a proxy response to a redirect; apply the
  receiving request's policy when replaying coalesced refresh writes.
- Apply the same transport choice to the existing recovery capability cookie.
  Its HttpOnly flag, lifetime and validation remain unchanged. Auth session
  cookies retain the SDK's browser-readable behavior, names, path and SameSite.

No schema, permissions, provider configuration, salon UI, billing or booking
code changes. Existing sessions do not need a forced logout: the same cookie
names acquire Secure on the next successful write/refresh. Already-stored
cookies are not retroactively rewritten just by deploying this code.

## Verification

Final local acceptance: **PASS**, unpublished.

| Gate | Result |
|---|---|
| Unit tests | 4,742 passed; 1 skipped; 749 files passed, 1 skipped |
| HTTPS browser suite | 74/74 passed |
| Automatic browser refresh | 4/4 passed (2 browser cases, each repeated twice) |
| HTTP app + mixed HTTPS callback configuration | 38/38 passed |
| Final browser execution total | 116 passed, no failed/skipped/flaky cases or retries |
| Production builds | HTTPS and HTTP configurations both passed |
| Typecheck / touched-file lint / diff whitespace | Passed |
| Disposable data cleanup | Auth users/sessions/factors, SuperAdmins, E2E salons/members all zero |
| CI / Preview / Production | Not run / not created / unchanged by this batch |

The 116 browser executions include repeated and cross-configuration checks;
they are not 116 new product functions. Full 784 completion stays undetermined.
The browser tests use throwaway Auth/users/salons, real password forms, real
GoTrue refreshes and local email. Google handoff is intercepted before the
provider and proves browser PKCE cookie creation only, not Google sign-in.
Automatic browser refresh advances browser Date while retaining normal timers,
then waits for the SDK's actual refresh request and changed cookie. A test-only
loopback transport bridge forwards the real request to GoTrue: WebKit otherwise
upgrades the plain-HTTP local Auth listener to unsupported TLS under the HTTPS
CSP (also documented in `next.config.ts`). No session/provider response is
replaced. This is not a test of a hosted Auth endpoint's TLS setup.

`e2e/auth-cookie-security.spec.ts` covers all five salon roles on Chromium and
mobile WebKit. It expires only the SDK's stored expiry metadata, retaining the
original signed access token and refresh token, then inspects the real proxy
response before client JavaScript runs. The MFA and recovery suites also assert
Secure across real session transitions. Cookie values, passwords and TOTP
secrets are excluded from diagnostic attachments.

The new cookie spec is included in CI's disposable HTTPS Auth shard. Local PASS
does not establish CI, Preview, Production, or all 784 functions at 100%.
The separate Square save-card incident still requires provider comparison.

Initial browser-refresh harness failures are retained in `harness-findings.json`:
WebKit loopback TLS failure and an in-flight request racing test cleanup. The
final harness drains callbacks with `behavior: "wait"`; it does not ignore
errors. The successful HTTPS refresh checks are repeated twice per browser.
These infrastructure retries are not counted as additional feature coverage.

## References

- [Supabase SSR advanced guide](https://supabase.com/docs/guides/auth/server-side/advanced-guide)
- [Supabase SSR clients](https://supabase.com/docs/guides/auth/server-side/creating-a-client)
- [Next.js cookies](https://nextjs.org/docs/app/api-reference/functions/cookies)
- Installed Next 16.3.4 `cookies`/`headers` docs and `@supabase/ssr` 0.10.2 source.

Evidence directory (local, not published):
`/Users/huytran/nailiq-audit-results-20260907/auth-cookie-secure`.
