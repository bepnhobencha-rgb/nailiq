# Daily report recovery UI fixture

Synthetic only: the page injects a mock Server Action, never a database or email
provider. It exercises the production recovery card on desktop Chromium and
iPhone WebKit. It is a separate Next application, not a Production route.

Run from the repository root, sequentially:

```sh
NEXT_TELEMETRY_DISABLED=1 npx next build qa/digest-backfill --webpack
npx playwright test -c qa/digest-backfill/playwright.config.ts
```

Coverage: empty-date guard, read-only check, explicit send confirmation, accepted
receipt versus unverified inbox, resend prevention, date-reset, failure guard,
mobile overflow. Fixtures do not prove actual Production email delivery.
