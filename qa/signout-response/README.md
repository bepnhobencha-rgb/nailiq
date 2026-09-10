# Manual sign-out response recovery

Isolated Next.js fixture importing the real choose-salon, dashboard and superadmin sign-out components. Its two server actions only redirect to local fixture pages. Webpack replaces Auth action modules only in this fixture; NailIQ's normal app configuration is unaffected.

```sh
npx next build qa/signout-response --webpack
npx playwright test -c qa/signout-response/playwright.config.ts
```

114 cases: EN/VI, Chromium desktop, Chromium 320px, WebKit iPhone 13; choose-salon, dashboard, expanded and compact superadmin. Covers HTTP 429/503, aborted requests, typed provider failures, disabled pending controls, cancellation, visible error feedback outside clipped sidebars, and explicit retry through a real Next Server Action redirect.

The runner refuses builds containing actions other than the two inert fixture actions. It blocks off-origin traffic and unknown mutations. Failures are injected into Next's response decoder; successful retries execute the inert fixture action. No real credentials, Auth, database, provider, customer, or salon are used. This is local/CI component evidence, not production verification.

Separate unit coverage in `src/shared/auth/__tests__/signOutActions.spec.ts` runs the real server actions against mocked clients and verifies provider failures, preserved global scope, redirect propagation, audit ordering, and best-effort audit/actor lookup.
