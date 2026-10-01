# Waitlist delivery browser acceptance

Isolated Next.js fixture for the production `OnlineWaitlistPanel`. It renders
synthetic accepted, delivered, failed, suppressed, unknown, and sending states
without a database, provider credentials, outbound message, or server mutation.

Build and run from the repository root:

```sh
node node_modules/next/dist/bin/next build qa/waitlist-delivery --webpack
npx playwright test --config qa/waitlist-delivery/playwright.config.ts
```

The browser test imports the real production panel, blocks every non-local
request, and checks English and Vietnamese in desktop Chromium and iPhone
WebKit viewports. Screenshots are attached to the Playwright result.

## Claim reload recovery

The `/claim` fixture imports the real `WaitlistClaimButton` and its real
sessionStorage request-ID helper. No replacement React handlers or production
API/database routes are installed. Playwright intercepts only the claim POST;
all external traffic and any other mutation are blocked.

```sh
node node_modules/next/dist/bin/next build qa/waitlist-delivery --webpack
npx playwright test --config qa/waitlist-delivery/claim.config.ts
```

Eleven scenarios run with retries disabled on desktop Chromium and WebKit
iPhone SE, Pro Max, and iPad viewports (44 tests). They cover explicit keyboard
confirmation, booked versus reserved truth, lost response/503 followed by
reload and repeated loss, same-intent replay, acknowledgement cleanup, terminal
400/409, malformed success, double activation, missing metadata, token
isolation, and denied storage. The recovery screen also checks WCAG A/AA,
44px touch targets, full visibility, and horizontal overflow.

This is local browser/component evidence with a mocked API. The simulated
receipt map is NOT database, provider, hosted, physical-device, or pilot proof.
See `docs/qa/waitlist-claim-reload-recovery-local-2026-10-01.md` for the separate
real Chrome/Next/PostgreSQL local verification. The existing default delivery
config also discovers this spec in its two projects; the four-project claim
config is the targeted local matrix, not a claim that hosted CI has run it.
