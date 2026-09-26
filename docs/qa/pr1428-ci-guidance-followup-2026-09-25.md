# PR #1428 — CI guidance follow-up

## Evidence retained

- Base head: `d6fce9910c4e56770d4dbe6d37bb430d254aafeb`.
- Run `36110989082`, attempt 1: PASS.
- Run `36110989084`, attempt 1: FAIL. Non-RC: 177 passed, 2 failed, 2 skipped.
- Both failures in `noshow-confirm.spec.ts` expected the retired `Link Unavailable` heading (also failed the configured test retry).
- Explicit non-RC workflow paths omitted `management-link-guidance.spec.ts`; its seven local passes were not CI coverage.
- Separate WebKit booking-submit diagnostics: 10/10 passed. This does not negate the two failures.

## Local correction

- Use exact consumed/missing capability headings and verify actionable guidance.
- Assert no repeat-confirmation control; consumed capability does not display a confirmed-outcome heading.
- Add management-link-guidance to the existing non-RC CI path list. No runtime, database, provider, or Production changes.

## Verification

- `eslint e2e/noshow-confirm.spec.ts e2e/management-link-guidance.spec.ts`: PASS.
- `npm run typecheck`: PASS.
- `git diff --check`: PASS.
- `playwright test --config playwright.management-guidance.config.ts --output test-results-management-guidance-ci-fix`: 7/7 PASS, zero retries, API mocked, existing local production build.
- Local server initially blocked by sandbox EPERM; started with approved execution access, loopback-only synthetic Supabase config and outbound suppression.
- Full database-backed noshow suite and new CI execution: NOT PROVEN in this local batch. No claim that the previous CI failure is now green.
- No new build: only test/workflow changes; application build unchanged.
- Hosted valid-token flow and actual scheduled/provider delivery remain NOT PROVEN by these mocked tests. Day 7 is not closed.
