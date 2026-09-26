# Group recovery component browser QA

Standalone local Next fixture reusing actual recipient and sender components. The webpack alias replaces only groupSlotRecoveryActions with inert cookie-backed outcomes. No credentials, database, provider, notifications or production calls. Playwright blocks all off-origin traffic. This proves UI behavior only, not database correctness or actual replacement completion.

Build sequentially with other Next builds:

`node node_modules/next/dist/bin/next build qa/group-recovery --webpack`

`npx playwright test -c qa/group-recovery/playwright.config.ts`

Covers EN/VI, Chromium/WebKit mobile, required own agreement, double click guard, reload, same request after uncertain outcome, expired/card-required blocks and sender explicit share workflow.
