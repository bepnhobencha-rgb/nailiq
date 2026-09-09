# Auth callback error feedback — 2026-09-08

Status: PASS_LOCAL for the scoped fix; CI/Preview/Production pending.

Base: `d9ec2825f9f4bbcd04d21fcb0d5da3f84f46d5c1` (Production after PR #1342).

## Reproduced problem and fix

A signed-out visit to `/auth/callback?error=access_denied&error_description=QA_AUTH_CANCELLED` on Production returned `/login?error=QA_AUTH_CANCELLED`. Both Chromium and WebKit displayed the login form with no readable error. The callback forwarded arbitrary provider text, but the login page recognizes only `session` and `pkce_restart`.

The callback now returns the recognized `session` code for provider errors (including empty descriptions), missing codes, and exchanges with no verified user. Existing localized retry copy is reused. The missing-PKCE explanation, session cookie security, membership resolution, permissions, and successful routing are unchanged. No schema, provider configuration, or style changes.

## Verification

- Regression first: 6 of 9 focused unit cases failed on the old callback; 9/9 passed after the fix. Full unit: 4,532 passed, 1 skipped.
- Production build, typecheck, focused lint and diff check passed.
- Final browser run: 26 passed, 0 skipped/fail/flaky/retry. This comprises 16 callback-error scenarios (EN/VI × four error forms × two browsers), six real local email/PKCE scenarios, and four existing registration-success guard checks.
- Real Auth scenarios: user without membership reaches setup and survives reload; owner reaches their own salon and survives reload; reused email link displays an error; wrong-browser link displays the PKCE restart explanation. Session cookies are explicitly asserted Secure; no demo cookie is accepted.
- CI matrix explicitly includes the new spec in shard 4 with demo disabled and both Chromium/WebKit, including PR runs. Workflow wiring checked locally; execution in CI remains pending.
- Local Supabase 2.117.0, Node 20.20.2, real Auth with Mailpit, disposable baseline plus forward migrations, schema parity passed. No hosted Auth mail, Google sign-in, customer booking or payment was performed.

## Test-environment findings

Initial email cases failed because the test used the wrong Mailpit delete endpoint. Cleanup now uses `DELETE /api/v1/messages` with exact message IDs, and user cleanup still runs if mail cleanup fails. Those failed runs are retained in the evidence folder.

WebKit rejected Secure callback cookies over the initial local HTTP transport. A test-only HTTPS fixture now forwards only loopback app/Auth traffic, preserves Set-Cookie unchanged and rewrites loopback redirect origins. Ephemeral TLS keys are removed at worker shutdown. Production cookie security was not loosened. Chromium/WebKit both pass through this HTTPS transport.

## Visual and runtime limits

Inspected EN desktop and VI mobile screenshots show the existing dark/gold form and readable retry banner without visible overlap. All four EN/VI desktop/mobile measurements found no horizontal overflow. Axe contrast checks passed on desktop; WebKit returned incomplete because a decorative blurred background prevents its color determination, with no reported contrast violation. Do not call mobile contrast automatically certified.

One local `The destination stream closed early` entry (digest `880932584`) has no exact request/full stack and remains NOT_PROVEN. Expected missing-PKCE warnings occur in negative tests. This report does not assert globally clean runtime logs or certify real Google OAuth, hosted email delivery, all salon roles, or all 784 inventory items.

Evidence: `/Users/huytran/nailiq-audit-results-20260907/auth-email-callback/`.
