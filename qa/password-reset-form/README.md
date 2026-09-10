# Auth component browser fixture

Standalone Next app rendering the real owner/SuperAdmin password-reset forms
and `SocialAuthButtons`, with the product CSS and language provider.

Run from the repository root, without Auth credentials or a database:

```sh
npx next build qa/password-reset-form --webpack
npx playwright test -c qa/password-reset-form/playwright.config.ts
```

The existing `password-reset-form` CI job runs both specs. The suite has 44
cases per engine (Chromium desktop and WebKit iPhone), 88 executions in total,
with retries disabled:

- `form.spec.ts`: 62 reset-form response recovery executions.
- `readiness.spec.ts`: 26 login, signup, email-link and compact-form executions.
  It holds the actual Next scripts before hydration, checks disabled fields,
  starts filling without a test-side hydration wait, then releases the scripts
  and checks the submitted arguments. It also covers bilingual error recovery,
  compact-form autofocus, repeated Enter while pending and unavailable JavaScript.

The fixture replaces the real Auth action modules and browser client with
inert stubs. Both specs verify the build's exact five-action manifest before
running. Unexpected action references fail closed. The stubs throw if called;
they cannot send email, contact OAuth or mutate Auth data.

Browser tests intercept mutation requests and block external destinations.
The readiness tests return a synthetic 503 after recording only fictional
credentials, so passing them does not prove real authentication, delivery,
saved-password autofill or a deployed production session.

The server binds to `127.0.0.1:3113`; `reuseExistingServer: false` prevents
silently testing a stale process. Rebuild the fixture after product changes.
