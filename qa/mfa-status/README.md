# MFA status browser fixture

Runs the real `MfaManager` and `MfaChallengeForm` against local Next Server Action stubs. Webpack replaces the entire MFA action module. No Supabase/Auth/database credentials are used. Each spec allows only same-origin GET/HEAD and its exact built stub action IDs: `getMfaStatus` for status tests, `verifyMfaChallenge` for challenge tests. All other actions and external traffic are blocked. The test fails if any such request occurs. Challenge success and sign-in routes are inert QA destinations, not authenticated application pages.

```sh
npx next build qa/mfa-status --webpack
npx playwright test -c qa/mfa-status/playwright.config.ts
```

45 checks across Chromium desktop, 320px Chromium and iPhone WebKit:

- 18 status checks: slow ON/OFF reads, aborted requests, HTTP 503, typed read errors and unauthorized responses; visible error, no unconfirmed ON/OFF or mutation buttons, keyboard retry, duplicate-submit prevention and recovery.
- 27 challenge checks: abort, HTTP 503, lost response after the stub completes, thrown server error, typed unavailable response, invalid code, expired session with working sign-in link, pending duplicate submissions and incomplete input. Recoverable errors keep the form and code, never navigate automatically, and allow a manual keyboard retry. Screenshots contain fake state only.

CI places the JSON report under the uploaded `test-results/` directory using `PLAYWRIGHT_JSON_OUTPUT_NAME`.

This fixture proves component response recovery. Separate unit tests exercise the real `getMfaStatus` and `verifyMfaChallenge` actions with a stubbed request-scoped Auth client. It does not certify real TOTP enrollment, code verification, factor removal, MFA login enforcement, every SuperAdmin role, or Production behavior.
