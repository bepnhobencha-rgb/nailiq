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
