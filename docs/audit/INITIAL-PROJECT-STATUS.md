# NailIQ — Initial Project Status (pre-security-audit baseline)

**Date:** 2026-07-13
**Repo:** https://github.com/bepnhobencha-rgb/nailiq
**Scope:** read-only health check. No source changes, no DB changes, no migrations, no deploy, no merge.

---

## 1. Environment & branch

| Item | Value |
|---|---|
| Audit branch | `audit/security-production-readiness` |
| Branched from | `origin/main` @ `e70b049` (`feat(booking): make the SMS opt-in disclosure satisfy Twilio at a glance (#737)`) |
| Working location | `/Users/huytran/nailiq-audit` (git worktree) |
| Node | v24.15.0 |
| npm | 11.12.1 |

### Deviation from the requested steps (and why)

The plan called for `git pull origin main` + `git checkout -b …` inside `~/nailiq`. That was **not** done, because `~/nailiq` was on branch `feat/user-language-per-account` with **uncommitted work in progress**:

- modified: `src/components/BookingFlowPhonePanel.tsx`
- untracked: `scripts/reoptin-preview.ts`, `scripts/reoptin-test-send.ts`

Pulling/branching there would have dragged that work onto the audit branch and risked mixing it with unrelated changes. Instead the audit branch was created in a **separate worktree** off `origin/main` — clean tree, zero impact on the in-progress work. Net effect is identical for audit purposes.

---

## 2. Check results

| Check | Command | Result |
|---|---|---|
| Install | `npm ci` | ✅ **PASS** — 602 packages, lockfile honoured, not regenerated |
| Lint | `npm run lint` (`eslint`) | ❌ **FAIL** — exit 1; **84 errors, 101 warnings** |
| TypeScript | `npm run typecheck` (`tsc --noEmit`) | ✅ **PASS** — 0 errors |
| Unit test | `npm run test:unit` (`vitest run`) | ✅ **PASS** — 1 file, 8/8 tests, 774 ms |
| Build | `npm run build` (`next build`) | ✅ **PASS** — exit 0, full route manifest emitted |
| E2E | `npm run test:e2e` (Playwright) | ⏸️ **NOT RUN — deliberately skipped** (see §4) |

Note: `package.json` has no `test` script. The real names are `test:unit` (vitest) and `test:e2e` (playwright); those were used.

---

## 3. Important findings

### 🔴 P0 — Next.js 16.2.4 carries Middleware/Proxy **bypass** CVEs, and NailIQ gates tenant auth in middleware

`npm audit` reports `next` as **high severity**. Among the 13 advisories against the installed version, these are the dangerous ones for this app:

| Advisory | CVSS | Why it matters here |
|---|---|---|
| Middleware/Proxy bypass via dynamic route parameter injection ([GHSA-492v-c6pp-mqqv](https://github.com/advisories/GHSA-492v-c6pp-mqqv)) | **8.1** | Could let a request reach `/dashboard/[slug]/…` without passing the gate |
| SSRF via WebSocket upgrades ([GHSA-c4j6-fc7j-m34r](https://github.com/advisories/GHSA-c4j6-fc7j-m34r)) | **8.6** | Server-side request forgery from the app host |
| Middleware/Proxy bypass via segment-prefetch routes ([GHSA-267c-6grr-h53f](https://github.com/advisories/GHSA-267c-6grr-h53f), [GHSA-26hh-7cqf-hhc6](https://github.com/advisories/GHSA-26hh-7cqf-hhc6)) | 7.5 | Same gate, second bypass class |
| DoS — Server Components / Cache Components / Image Optimization | 7.5 / 7.5 / 5.9 | Availability |
| XSS with CSP nonces; cache poisoning in RSC responses | 4.7 / 5.4 | Integrity of responses |

**Why this is P0 and not just an audit line item:** `src/proxy.ts` is not decorative — it is the enforcement point for

- the `/dashboard/[slug]` auth gate and **cross-tenant isolation** (`dashSlugMatch`, ~line 233; comment at ~243 explicitly says it exists to stop "being abused to access any tenant's dashboard"),
- the auth-attempt **rate limit** (~line 190) and Vercel WAF rule hookup.

A middleware-bypass class of vulnerability lands squarely on that file's guarantees. Multi-tenant data isolation is the single highest-stakes property of this product.

**Fix is cheap:** `next` 16.2.4 → **16.2.10**, flagged `isSemVerMajor: false` (patch-level bump, same major). This should be the first item of the security audit, not the last.
*Not applied — this session is read-only. Recommend a dedicated PR + regression check.*

### 🟠 P1 — two more high-severity transitive deps

- `ws` ≤8.20.1 — memory-exhaustion DoS (CVSS 7.5) + uninitialized memory disclosure. Fix available.
- `fast-uri` ≤3.1.1 — path traversal via percent-encoded dot segments (7.5) + host confusion (7.5). Fix available.

Totals: **14 vulnerabilities — 3 high, 9 moderate, 2 low.**

### 🟡 P2 — Lint is red: 84 errors

Build and typecheck are green, so none of these break the app today. Breakdown by rule:

| Count | Rule |
|---|---|
| 28 | `@typescript-eslint/no-explicit-any` |
| 27 | `react-hooks/set-state-in-effect` |
| 5 | `react/no-unescaped-entities` |
| 5 | `react-hooks/purity` |
| 5 | `react-hooks/immutability` |
| 3 | `prefer-const` |
| 3 | `react-hooks/preserve-manual-memoization` |
| 3 | `react-hooks/refs` |
| 3 | `react-hooks/static-components` |
| 2 | `@next/next/no-html-link-for-pages` |

Security-relevant subset: the **28 `no-explicit-any`** matter for an audit, because `any` at a trust boundary (server action input, webhook payload, API route body) is exactly where validation gets silently skipped. Worth grepping specifically for `any` in server actions / webhook handlers rather than treating all 84 as cosmetic.

Files with errors seen during the run include `src/shared/lib/UserLanguageContext.tsx`, `src/shared/loyalty/loyaltyActions.ts`, `src/shared/noshow/handleBookingProtection.ts`, and Supabase Edge Functions (`supabase/functions/reschedule-sms/index.ts`, `supabase/functions/scrape-website/index.ts`).

### ℹ️ Note — unit-test coverage is thin

`vitest run` executes **1 test file / 8 tests** against a ~105K-LOC codebase. The suite is green, but it provides almost no regression safety net. Any security fix (including the Next bump above) must be verified by build + targeted manual/E2E checks, not by "unit tests still pass".

---

## 4. Why E2E was not run

Skipped on purpose, per the stated constraints ("no production credentials", "do not change the database"):

- `playwright.config.ts` loads `.env.local` / `.env.test.local`, which require `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and **`SUPABASE_SERVICE_ROLE_KEY`**.
- NailIQ has **one shared Supabase project** — there is no separate test database. The E2E helpers **seed real rows** (`seedDeskBooking`, fixture salons/staff/services).
- Therefore running the suite (77 spec files, 2 projects: chromium + mobile) would **write to the production database** with a service-role key, and would likely exceed the 15-minute budget.

To run E2E safely later, it needs an isolated Supabase project (or branch DB) — that is itself an audit finding worth raising.

---

## 5. Verdict

- **Does the project build?** **Yes.** `npm ci` → `tsc --noEmit` → `next build` all pass cleanly on `origin/main`, with no `.env.local` present.
- **Can the security audit proceed?** **Yes.** The codebase is in a healthy, buildable, type-clean state. Nothing blocks the audit.
- **Where the audit should start:** the Next.js middleware-bypass CVEs (§3, P0), because they attack `src/proxy.ts` — the file that enforces cross-tenant dashboard isolation. Then the `any`-typed trust boundaries, then `ws` / `fast-uri`.

---

## 6. Constraints honoured

No source code modified · no tests modified · no migrations touched · no `supabase db push` / `db reset` / `migration repair` · no Vercel env changes · no deploy · no merge to `main` · `package-lock.json` untouched · next audit group not started.

The only file written by this session is this report.
