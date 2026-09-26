# Fee collection confirmation browser fixture

Standalone Next application rendering the three production fee approval queues and
production Modal/Button. It is not imported or routed by the deployed NailIQ app.
Webpack replaces only their six fee server actions with inert cookie-only actions.
There are no provider, Auth or database calls and no credentials are required.
The browser verifies the action manifest, blocks off-origin requests and rejects
unknown POST actions. No payment or customer record is created.

Run from the repository root:

```sh
npx next build qa/fee-confirmation --webpack
npx playwright test -c qa/fee-confirmation/playwright.config.ts
```

84 cases cover three fee queues, English/Vietnamese and desktop Chromium/mobile
WebKit (390px): explicit amount/card confirmation; Cancel and Escape; pending
single-flight/double-click; disabled dismissal while pending; receipt status and
reload; simulated decline, unknown (including stale props) and response loss; separate approval copy.
The mobile checks reject horizontal overflow. Unknown/response-loss cases cannot
offer another Collect on stale client props. Square Sandbox integration and
Production readiness require separate evidence; these are component/transport
regressions with a mocked provider boundary.
