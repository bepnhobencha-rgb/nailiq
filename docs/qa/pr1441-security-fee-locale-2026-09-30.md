# PR #1441 — Security and fee-locale CI closeout

## Scope and retained evidence

Base: `85832354012b409cfbedb241f42bd8c0fcb7133e`, Draft PR #1441.
This batch changes dependencies/lockfiles and an isolated browser test, not fee
actions, booking semantics, tenant permissions, database or live-salon settings.

- CI run `36746043270`, attempt 1: **FAIL**, 10 successful jobs / 2 failed jobs.
- Fee job `109992378386`: **87 passed / 1 failed**, WebKit VI no-show amount
  expected `1,00`, received `$1.00` inside Vietnamese confirmation copy.
- Security job `109995010983`: **FAIL**, critical advisory
  [GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j).
- Separate E2E run `36746043216`, attempt 1, same base: **SUCCESS**, 10 successful
  jobs / 2 conditional skipped jobs. This does not erase the CI failures.
- Its non-RC job `109992603177` recorded 177 main tests, 6 guided setup, 1 reports
  hydration, 6 superadmin, 7 capability, 3 registration, 10 booking-submit WebKit
  repetitions and 18 group-placeholder cases passed. Server logs also contain
  destination-stream-closed diagnostics; do not equate test success with zero
  runtime diagnostics or a proven fix for prior native WebKit crashes.
- Group recovery 32 tests and MFA status 141 tests passed on this base; they are
  not new-head or complete Master Plan proof.

## Changes

1. Pin Next and eslint-config-next from `16.3.4` to the official `16.3.8` patch;
   regenerate both npm and pnpm lockfiles. React/React DOM remain `19.2.8`.
   No force audit fix, major migration, codemod, runtime or config change.
   [Official release](https://github.com/vercel/next.js/releases/tag/v16.3.8).
2. Fee fixture SSR starts English; the saved localStorage preference is applied
   after hydration. The old bilingual Collect/Approve locator could activate
   English UI and capture the English amount before VI labels appeared. Use
   language-specific action locators as the interaction precondition instead.
   Keep exact amount/card/type assertions, request guards, 30s timeout and zero
   retries. Source analysis supports this race; the precise CI event ordering
   was not independently captured. Do not claim a real charge was incorrect.
3. Correct fixture documentation to the actual 88 cases, including consent-cap
   cases. No production UI or server action was edited.

The advisory concerns Node ImageResponse with attacker-controlled SVG values.
The public OG image uses Edge; the dashboard icon uses Node with HTML-style
markup. An installed affected version is not proof of exploitability or an
incident. No exploit or Production probe was performed.

## Verification

Commands ran in this worktree. Builds use an empty inherited environment, fake
Supabase placeholders, telemetry disabled and the documented 19 outbound/payment
kill switches. The fee fixture replaces six actions with cookie-only outcomes
and rejects off-origin/unknown POST requests; no provider/DB/payment is contacted.

| Check | Actual result |
| --- | --- |
| `npm install --ignore-scripts` | PASS, 5 packages changed, audit 0 vulnerabilities |
| `npm audit --package-lock-only --audit-level=high` | Initial DNS failure; authorized network read succeeded, 0 vulnerabilities |
| `npx --yes pnpm@10.34.5 install --lockfile-only --ignore-scripts` | PASS; changes restricted to the Next patch family |
| Same pnpm install with `--frozen-lockfile` | PASS |
| `npx --yes pnpm@10.34.5 audit --audit-level=high` | PASS, no known vulnerabilities |
| `npm run typecheck` | PASS before app build |
| `npx eslint qa/fee-confirmation/confirmation.spec.ts` | PASS |
| `next build qa/fee-confirmation --webpack` | PASS, Next 16.3.8 |
| `playwright test -c qa/fee-confirmation/playwright.config.ts` | PASS 88/88, 2.2m, Chromium/WebKit, EN/VI, retries 0; initial sandbox server bind EPERM retained |
| Full Vitest with blanket email/call suppression | First: 3 files / 10 tests failed plus 4 localhost bind errors; authorized localhost run: 2 files / 6 tests failed because guard overrides preempt mocked provider branches |
| Full Vitest, clean credential-free unit-test environment, SMS suppressed, email/call providers mocked | PASS 878 files / 7 skipped; 7245 tests / 79 skipped, 16.23s. Test-only environment change, not Preview flag changes |
| Default `next build` (Turbopack) | NOT PROVEN locally: remained at compilation for over 5 minutes; verified own lock-holding process stopped with TERM, exit 143 |
| `next build --webpack`, same clean/fake/kill-switch environment | PASS, compiled 21.7s, TypeScript 19.5s, 61/61 static pages |
| `npm run lint` after local fixture builds | FAIL, scanned generated nested `.next` bundles and unrelated untracked diagnostics: 271 errors / 10044 warnings. Not a clean-checkout CI lint result |
| Full ESLint excluding generated `.next`/test-results and the preserved untracked hydration diagnostic only | PASS, 2787 source/config files, 0 errors / 39 warnings; no source rules disabled |
| Post-build `npm run typecheck` and `git diff --check` | PASS |

Local diff review confirms only the Next family, matched lockfiles, fee test and
its documentation changed. New-head CI/Preview remain pending at this checkpoint.
Webpack PASS is not default Turbopack PASS.
Warnings about deprecated Edge runtime/ESLint are not silently repaired by this
scoped security batch.

## Release boundary

Local results are not Production/pilot/provider proof. Keep PR Draft. No Ready,
merge, Production deployment, migration, configuration/data mutation, booking,
SMS/email/call/payment or real customer action occurred. Two Hi-Lite pilots,
human 7–14-day observations, physical iPhone and provider terminal delivery
remain separate gates. Unrelated diagnostics/test artifacts remain untracked.
