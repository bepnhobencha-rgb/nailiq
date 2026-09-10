# MFA status browser fixture

Runs the real `MfaManager` against local Next Server Action stubs. Webpack replaces the entire MFA action module. No Supabase/Auth/database credentials are used. The browser allows only same-origin GET/HEAD and the exact built `getMfaStatus` action IDs; enrollment, verification, unenrollment and all external traffic are blocked. The test fails if any such request occurs.

```sh
npx next build qa/mfa-status --webpack
npx playwright test -c qa/mfa-status/playwright.config.ts
```

18 checks: six scenarios across Chromium desktop, 320px Chromium and iPhone WebKit. Holds an initial status read for both confirmed ON/OFF outcomes; injects aborted requests, HTTP 503, typed read errors and unauthorized responses; checks visible error, no unconfirmed ON/OFF or mutation buttons, keyboard retry, duplicate-submit prevention, successful recovery and no page errors. Screenshots contain fake state only.

This fixture proves component response recovery. Separate unit tests exercise the real `getMfaStatus` action with a stubbed request-scoped Auth client. It does not certify real TOTP enrollment, code verification, factor removal, MFA login enforcement, every SuperAdmin role, or Production behavior.
