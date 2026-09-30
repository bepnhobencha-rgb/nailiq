# Auth component browser fixture

Standalone Next app rendering the real owner/SuperAdmin password-reset forms,
SuperAdmin login/recovery forms and headers, and `SocialAuthButtons`, with the
product CSS and shared language provider.

Run from the repository root, without Auth credentials or a database:

```sh
npx next build qa/password-reset-form --webpack
npx playwright test -c qa/password-reset-form/playwright.config.ts
```

The existing `password-reset-form` CI job runs all three specs. The suite has
95 cases per engine (Chromium desktop and WebKit iPhone), 190 executions in
total, with retries disabled:

- `form.spec.ts`: 82 reset-form response recovery executions, including both
  languages for both owner and SuperAdmin forms.
- `readiness.spec.ts`: 26 login, signup, email-link and compact-form executions.
  It holds the actual Next scripts before hydration, checks disabled fields,
  starts filling without a test-side hydration wait, then releases the scripts
  and checks the submitted arguments. It also covers bilingual error recovery,
  compact-form autofocus, repeated Enter while pending and unavailable JavaScript.
- `language.spec.ts`: 82 executions covering server-rendered and hydrated copy,
  saved-language disagreement, live language changes with drafts/errors/pending
  responses, generic login failures, recovery notices and success, 320px layout,
  and consistent colors. Expected copy is literal, independent of the dictionaries.

The fixture replaces the real Auth action modules and browser client with
inert stubs. All specs verify the build's exact seven-action manifest before
running. Unexpected action references fail closed. The stubs throw if called;
they cannot send email, contact OAuth or mutate Auth data.

Browser tests intercept mutation requests and block external destinations.
The language controls and cookie-based initial language exist only in this
fixture; it never imports the production session resolver or protected pages.
Language-preference writes receive a local synthetic response. These controls
are not new product UI.

The readiness tests return a synthetic 503 after recording only fictional
credentials; form/language tests use synthetic action responses. Passing them
does not prove real authentication, email delivery, saved-password autofill,
production session behavior, translated browser metadata, or all 784 features.

The server binds to `127.0.0.1:3113`; `reuseExistingServer: false` prevents
silently testing a stale process. Rebuild the fixture after product changes.
