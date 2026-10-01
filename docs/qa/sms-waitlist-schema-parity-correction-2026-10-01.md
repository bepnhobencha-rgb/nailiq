# SMS / Waitlist release schema contract correction

Date: 2026-10-01. Scope: existing Draft PR #1441, isolated QA/Preview only.

## Initial published evidence retained

Published head `31e137ab964f3230cbe5baeed166df6126f51718`:

- CI run `36851794388`, attempt 1: SUCCESS, including Build & Type Check and Security Audit.
- E2E run `36851794439`, attempt 1: FAILURE. Smoke and real-database jobs failed; i18n, visual regression and AI triage passed; MQA-0148 was skipped.
- Migration History Rehearsal run `36851794422`, attempt 1: FAILURE after applying migrations, at exact schema-parity verification.

The fresh migration rehearsal and E2E smoke database measured the additive SMS ledger, but the release contract still expected the prior counts. This correction is new code, not a rerun of the failing head. Earlier failures remain evidence and are not erased or reclassified as PASS. Downstream E2E results require a new complete run; passing the count gate alone cannot establish browser PASS.

## Exact contract, not a relaxed threshold

| Dimension | Previous expected | Fresh CI measured / corrected expected |
| --- | ---: | ---: |
| Tables | 248 | 249 |
| Columns, including views | 3824 | 3831 |
| Policies | 225 | 225 |
| Application functions | 611 | 614 |
| Triggers | 169 | 170 |
| Indexes | 1022 | 1024 |

The signed SMS receipt migration accounts for exactly one table, seven columns, three functions, one immutable trigger and two indexes. The three capacity migrations replace definitions without adding objects. Exact equality remains mandatory. The direct table reachability contract is unchanged: anon 57, authenticated 79, service_role 236.

A pre-existing owned local integration database measured 250 tables / 3841 columns / 616 functions / 1026 indexes and service_role reachability 237 because it contains additional ahead-of-batch contracts. It was not used as the release-count oracle, modified to force equality, or presented as a fresh blank rehearsal. Its ledger metadata was used only for the scoped boundary fault tests below.

## Stronger read-only security gate

`scripts/security/check-inbound-sms-ledger-boundary.sql` runs immediately after parity in migration-history CI. It checks:

- The receipt is a base table with RLS and FORCE RLS.
- PUBLIC, anon, authenticated and service_role have no direct table or column grants.
- The BEFORE UPDATE/DELETE immutable trigger remains enabled and bound to the intended function.
- The three exact function signatures exist, with the intended definer mode and empty search path.
- Only the signed cancellation RPC is executable by service_role; browser roles cannot execute it and service_role cannot execute either helper directly.

The gate itself is read-only metadata SQL. It creates no fixtures or bookings, changes no database object, and calls no provider.

Six real PostgreSQL cases passed on the owned synthetic local integration database: baseline; reject a direct service-role SELECT grant; reject anon RPC EXECUTE; reject service-role helper EXECUTE; reject removed FORCE RLS; reject a disabled immutable trigger. Fault injections ran in transactions that rolled back. ACL/RLS/function/trigger snapshots and row counts were identical after each case. This is local database proof, not hosted provider delivery.

## Local correction verification

Clean checkout contains only the published SMS/Waitlist batch and this correction, excluding unrelated staged pilot/Square work. No hosted credentials or dotenv files were imported; the network fence permits loopback only.

- Full unit suite: `node node_modules/vitest/vitest.mjs run` — 7,385 PASS, 227 skipped; 888 files PASS, 10 skipped (artifact B77).
- Typecheck: `node node_modules/typescript/bin/tsc --noEmit` — PASS (B78).
- Default build: `node node_modules/next/dist/bin/next build` — PASS, default Turbopack, 61/61 static pages (B79).
- Focused ESLint on the four changed TypeScript files — PASS, zero errors and warnings.
- `git diff --check` — PASS.
- Ledger boundary fault harness — 6/6 PASS, all mutations rolled back.
- Local root database remained empty before and after verification.

## Preview / QA boundary

The previous published-head Preview `dpl_9Nu5yfnAJ2fLerQi5Wxv9Uyxf8k6` is READY at exact head `31e137ab`. Authenticated `/api/health` returned HTTP 200 and that version. This proves liveness only; it does not query the database or prove a positive SMS callback.

The four migrations were applied only to the disposable QA project. The prior hosted report records 16 SQL cases PASS, preserved data fingerprints, and unchanged advisor WARN groups. Nineteen branch-only provider kill switches remain disabled; the atomic inbound adapter is not enabled. The new correction has not yet completed remote CI or deployed Preview at the time this record was written.

Production, live-salon data, provider credentials and provider dispatch were not changed. No real bookings, SMS or email were created. Keep PR Draft. Masterplan Day 22 and whole-plan acceptance remain NOT PROVEN until the outstanding hosted runtime, actual scheduler/provider, physical-device and human-pilot gates have their own evidence.
