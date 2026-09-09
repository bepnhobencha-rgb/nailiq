# Local country phone fixture

Standalone QA app importing the real product component, stylesheet and theme
builder. No database, authentication, OTP or provider integration. Do not deploy
this fixture as the NailIQ application.

From the repository root, use the project's Node runtime:

```sh
node node_modules/next/dist/bin/next build qa/booking-country-phone --webpack
node node_modules/@playwright/test/cli.js test -c qa/booking-country-phone/playwright.config.ts
```

The Playwright config starts and stops the prebuilt fixture on port 3115. It
checks 32 combinations across Chromium and WebKit, EN/VI, light/dark and four
viewport widths. The CI job runs the same commands without database credentials.

For manual inspection, start the fixture with
`node node_modules/next/dist/bin/next start qa/booking-country-phone -H 127.0.0.1 -p 3115`.
Set `COUNTRY_PHONE_EXTERNAL_SERVER=1` only when testing that existing local
server. Historical before/after artifacts are listed in
`docs/qa/booking-country-select-contrast-2026-09-09.md`.
