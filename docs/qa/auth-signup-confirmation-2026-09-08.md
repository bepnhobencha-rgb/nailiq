# New-account email confirmation — 2026-09-08

Status: PASS_LOCAL for the scoped resend fix; CI/Preview/Production pending.
Base: `61dfc975d44459d8bda1bc9f2753370ee6379abb`.
Master Plan scope: Phase 1 P0, email/password signup through a private 14-day trial salon.

## Reproduced defect

On a fresh production build of the base commit, create an unconfirmed account through `/register`, wait for the real 60-second resend cooldown, request another email, and follow the new Mailpit link. Both Chromium and WebKit reach `/login?error=session` with Auth tokens in the URL fragment, instead of completing setup. The original signup link works. The isolated regression run failed 2/2, with no retry.

The installed Auth client's `resend` call sends no PKCE challenge. The application's server callback requires a code to exchange and cannot read a browser fragment. The retry action now requests a fresh PKCE email link using `signInWithOtp` with `shouldCreateUser: false`. The existing account is confirmed through Auth; this action cannot provision an account. Input validation, synthetic-address rejection, the hashed durable limiter, provider error classification, session cookie security, and salon permissions remain enforced.

No schema, hosted Auth configuration, email template, trial policy, payment, or UI style change is included.

## Acceptance coverage

The new browser spec uses real local Auth and Mailpit, with email confirmation enabled and demo disabled:

- EN and VI: new user is unconfirmed, owns no salon, and cannot enter setup before confirmation. A real email link opens setup with Secure session cookies; reload preserves the session. Creating a salon yields an owner membership, a private workspace and exactly 14 days of trial, with no Stripe customer, subscription or payment provider and outbound salon email/SMS disabled. Continue into its dashboard.
- Resend: the button enforces its cooldown, a second real email is received, its link confirms the account, Secure session cookies persist, the URL contains no fragment tokens, and setup survives reload.
- Different browser: the original email confirms the account but displays the PKCE restart explanation; the original password signs in and setup survives reload.

Each scenario runs in Chromium and WebKit. Mail links in the same browser open a new tab, preserving the PKCE cookie. Auth and application requests are real; only the loopback HTTPS transport is a test fixture. Every created user, salon and exact-recipient Mailpit message is cleaned up. Test guards reject hosted targets.

CI shard 4 explicitly includes the spec and enables `[auth.email].enable_confirmations` only in its disposable stack before startup. Other local defaults are unchanged; admin-seeded confirmed accounts remain valid. The workflow configuration edit was executed against a temporary copy and checked to change exactly one TOML value.

## Initial-run findings retained as evidence

- Fast same-tab test navigation can cancel a homepage RSC prefetch and produce a WebKit access-control page error. A wait for network idle did not eliminate this in every run. Opening the email in a new tab models an ordinary mail journey without cancelling the source page; page-error assertions remain strict on both pages. Same-tab rapid navigation is not certified by the final test.
- Repeated scenarios sharing one loopback IP exhausted the real proxy limit (HTTP 429). The page displayed the existing generic reload recovery screen. New tests isolate rate-limit fixtures between cases, matching the existing disposable salon cleanup convention; no rate limits are disabled within a scenario or in product code. Friendly inline recovery after actual proxy quota exhaustion remains an open UX issue, outside this resend patch.
- The original local server logged two cookie-write warnings from a Server Component. They did not block successful signup and do not establish a new cause. Final-run logs are recorded separately.

## Verification results

Final browser run: 8/8 passed. Existing real-auth/settings compatibility suite with confirmation enabled: 100/100 passed. Both runs used Chromium and WebKit, with zero failures, skips, flaky results or retries. Focused unit checks: 17/17 passed after the patch, with two failures against the old resend implementation. Full unit suite: 4,532 passed, 1 skipped. Production build, sequential typecheck, focused lint and diff check passed.

Visual inspection of all four EN/VI desktop/mobile confirmation screens found consistent dark/gold styling and no visible overlap. This is not a full theme, accessibility, device or 784-feature certification.

The final server log contains 37 generic `The destination stream closed early` entries (digest `3403657780`) across the final local runs, with no associated failing browser case or request-level cause established. These remain NOT_PROVEN, not a diagnosed auth regression or a claim of clean runtime logs. No cookie-persist warning or TypeError was recorded in that final server log.

Cleanup verification found zero Auth users, salons, memberships, bookings, client profiles and Mailpit messages in the disposable stack.

CI, Preview, hosted delivery (including spam filtering), Google OAuth and Production signup are not proven by these local tests. No real customer, booking, payment, email or SMS was mutated or sent.

Evidence: `/Users/huytran/nailiq-audit-results-20260907/auth-signup-confirmation/`.
