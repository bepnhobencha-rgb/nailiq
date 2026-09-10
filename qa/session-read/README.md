# Active-session read recovery fixture

This standalone Next app renders the production SessionsPage and SalonSessionsPanel.
Its webpack config replaces only presenceActions and setupActions with inert,
local fixtures. Production does not import this configuration. No Auth, database,
provider credentials, or customer data are required.

The browser tests verify the action manifest and block every off-origin request
and every unknown POST. Successful retries execute the inert Next server action;
failure responses exercise the real client action transport. The initial error
case renders the production server page with a failed read.

Run from the repository root:

```sh
npx next build qa/session-read --webpack
npx playwright test -c qa/session-read/playwright.config.ts
npx vitest run src/shared/dashboard/__tests__/presenceReadRecovery.spec.ts
```

48 browser cases: 8 scenarios × EN/VI × desktop Chromium, 320px Chromium,
and WebKit iPhone 13. Covers initial failure/retry, 503, aborted response,
returned server error, permission denial, missing salon, polling failure with
single-flight recovery, and genuine empty success. Tests capture error screenshots
and check responsive overflow and unhandled page errors in refresh scenarios.

18 unit cases exercise the real read action with mocked Auth/PostgREST boundaries:
all four query failures, thrown transport errors, Next redirects, missing salon,
Auth unavailable/revoked/missing, allowed and denied roles, tenant predicates,
and successful empty data.

These are local component/transport and mocked action results. They do not prove
hosted Auth, live database RLS, actual session revocation, every physical device,
or Production. Presence lists heartbeat users, not all Supabase Auth sessions.
Existing English page/card labels are outside this recovery change; new feedback
and the refresh/retry button follow the saved user language.
