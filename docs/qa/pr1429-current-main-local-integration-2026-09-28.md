# PR #1429 — current-main local integration checkpoint

Date: 2026-09-28 (Vancouver). This is local evidence only, not a release decision.

## Exact inputs and isolation

- Current Production/main code: `e9e5ca33cec5ee736dfbdc908a90203ae47a8ec4` (PR #1436).
- Draft PR #1429 head: `3b1f0134854d52c17a3d6bad61129c9971cb5b98`.
- Common ancestor: `e719aa7c323fec539863ad59cb2c3adcf1ca422a`.
- Isolated worktree: `/private/tmp/nailiq-pr1429-current-main-qa-20260928`.
- At this verification checkpoint, `git merge --no-commit --no-ff` completed automatically. The result was not yet committed or pushed; this document records that pre-publication state, not the later GitHub state.
- The PR-specific delta from the ancestor contains 22 files. This does not imply the GitHub PR's displayed diff has already been rebased onto current main.

## Local verification on the combined tree

- `git diff --cached --check`: PASS.
- Focused email-only, receipt and release-schema-contract Vitest files: 56 PASS.
- `npm run typecheck`: PASS.
- `npm run build -- --webpack` with outbound email/SMS/call and payment flags disabled: PASS. Existing Edge Runtime warnings remain.
- Touched TypeScript/TSX ESLint: PASS.
- `npm run check:i18n`: 0 errors, 13 existing warnings.
- First full Vitest attempt: 7,237 PASS, 79 SKIP, 4 FAIL because the sandbox denied `listen 127.0.0.1` for the local Mailpit stub (`EPERM`). This failure is retained, not called application PASS.
- Exact Mailpit-stub file rerun with localhost permission: 9 PASS.
- Entire Vitest suite rerun with localhost permission: **7,241 PASS, 79 SKIP, 0 FAIL** across 878 passing files and 7 skipped files.
- Isolated Unix-socket PostgreSQL receipt contract: PASS. Twelve concurrent claims produced one winner; tenant, role, ACL, RLS, fenced completion, accepted replay and unknown-outcome blocking passed. The first attempt could not initialize shared memory inside the sandbox (`shmget EPERM`); the identical test passed with local-process permission. The script removed only its own temporary cluster. This uses a minimal synthetic schema, not the full Supabase migration chain.
- In that first verification stage, no provider credentials were present and no provider call, email, SMS, payment or booking was made. The later WebKit gate below creates only disposable local synthetic bookings and cleans them up.

## Disposable QA database and WebKit closeout (same combined tree)

- Hosted Supabase QA project `uhpzafoiifupyypkcwln` was verified as the QA target; Production `fshmobzyjhmtvndobwsy` was not touched. The three card-retry receipt changes were **already present** in QA under QA-generated migration versions, so no duplicate migration was applied in this run. Read-only metadata verified receipt RLS enabled, no anon/authenticated table read or claim execute, service-role access, and built-in `pg_catalog.sha256` in the claim function. Baseline receipt count was zero.
- Ran `supabase/tests/card_retry_email_receipts_qa.sql` on hosted QA inside its own `BEGIN`/`ROLLBACK`: PASS for service-role claim, replay, completion, actor/recipient fencing. Postcheck: zero receipt rows and zero synthetic salon/user rows. Security advisor reported the receipt table as `rls_enabled_no_policy` INFO, consistent with service-role-only access; other advisor findings did not name this receipt table. This is **not** a new hosted migration rehearsal.
- Started an isolated local Supabase 2.109.1 stack on ports 64321/64322 in a dedicated Colima profile. Applied the folded baseline and all 280 forward migrations from this combined tree: PASS. `npx tsx scripts/check-schema-parity.ts`: PASS (249 tables, 225 RLS policies, 613 functions, 169 triggers). The full-schema transactional receipt fixture: PASS. The local stack is disposable and is not Production.
- Rebuilt with local-only Supabase URL/keys, local site origin, SMS/email/call kill switches and blank provider keys. `npx tsx scripts/assert-e2e-not-production.ts`: PASS. Ran the two `e2e/booking.spec.ts` mobile WebKit booking-submit cases with `--repeat-each=10 --retries=0` against the built app and disposable DB: **20/20 PASS** in 1.4 minutes. This includes ten ordinary booking-success cases and ten held-request-ID-Web-Lock cases. These are synthetic local bookings, not real-salon bookings.
- `npx tsx scripts/e2e-sweep.ts` removed zero residual rows; a direct count of matching synthetic salon slugs was zero. The localhost Next server, local Supabase stack (`stop --no-backup`) and dedicated Colima VM were stopped. Another existing Colima profile was left untouched.
- `agent-browser` was not installed in this environment, so the required browser gate used the repository's Playwright WebKit suite rather than an additional interactive browser pass. The historical PR-only CI run with one booking-success timeout/page crash remains an unresolved reliability signal despite this green 20-case local run.
- Before publication, Vercel's branch-scoped Preview environment was checked without displaying secret values: the public/internal Supabase URLs and expected refs matched hosted QA; disposable mode, SMS/email/call suppression and card-save dispatch disablement were active; payment worker and Square ingestion were disabled; Twilio, Resend, Square, Stripe and AI provider credentials were absent. This verifies configuration at that moment, **not** the environment baked into a future deployment.

## Gates still open

1. At this checkpoint, PR #1429 had not yet been updated. After publication, obtain CI and Preview evidence on the exact new head. The earlier PR-only CI failure must stay visible.
2. An **exact-version hosted QA migration rehearsal** remains unproven because the equivalent schema was already installed under QA-generated versions. The isolated local stack did apply the exact repository chain; hosted QA metadata/ACL/advisors and the transaction fixture passed.
3. Provider acceptance and actual inbox delivery remain separate, unproven gates. They require a separately authorized, controlled test.

Status at this checkpoint: **PASS for current-main local integration and disposable local 20-case WebKit gate; hosted QA receipt contract PASS; NOT READY for merge or Production.** No Production migration, provider call or real notification was performed. This evidence file is a pre-publication snapshot; GitHub/Preview status must be verified separately after any push.

## Post-publication CI reliability finding (2026-09-28)

- Draft PR #1429 head `7500cf4c743d3a800f881529266aaee78f49fe7d` was built as Vercel Preview `dpl_4ADZV5cHwMQvU44SWi6VEQvCbJSd` (READY, Preview only). This does not establish provider delivery or Production behavior.
- GitHub E2E run `36455072511`, attempt 1: **FAIL**. The synthetic card-retry email-only UI job, required smoke, visual regression, and the other E2E shards passed. In the non-RC shard, the 20-case mobile WebKit booking-submit stress gate had **19 pass, 1 fail**; the aggregate E2E gate failed as a consequence.
- The failed case was ordinary `Complete booking end-to-end`, repeat 3. Its `booking-success` element was absent after 15 seconds. The sanitized network diagnostic recorded HTTP 200 for `create_public_booking`, card capability, and Wix create. The video still showed `Submitting...` after the booking RPC. A `page-crash` event was recorded later, after the assertion timeout. This proves a customer-visible success-state failure in this run, but neither the HTTP statuses nor the later crash prove the root cause or whether the booking was fully committed.
- Source-path review narrows, but does not settle, the failure: the Wix create request is fire-and-forget immediately before `submitPublicBooking` returns; the caller then starts best-effort request-ID cleanup and sets the success step. Observing the Wix request indicates execution reached this late post-commit path, but does not prove the function returned, React rendered the success step, or the database committed. Do not attribute the timeout to the later page crash without a timestamped causal trace.
- PR #1429 does not change the production booking-submit implementation relative to current `main`; it adds the card-retry feature and expands the existing WebKit gate from 10 ordinary repeats to 10 ordinary plus 10 held-Web-Lock repeats. Current-main E2E run `36411245025` passed, and the isolated local 20-case gate above passed. Historical PR #1434 evidence also retained a 9/10 WebKit result with a page crash before a later 10/10 pass. These comparisons suggest intermittent behavior, not proof that this PR caused or fixed it.
- Attempt 2 was started as a single failed-job rerun with the same head. It uses the workflow's disposable local Supabase and empty provider credentials; attempt 1 remains preserved. A green retry must not be presented as a root-cause fix.
- Attempt 2 of run `36455072511` completed **SUCCESS** on the same head. The non-RC E2E job passed its 178-test main suite and the mobile WebKit booking-submit stress step passed **20/20** (10 ordinary plus 10 held-Web-Lock). The overall workflow concluded success; the MQA-0148 and AI Triage jobs were skipped. The server log also contained `The destination stream closed early` during later test cleanup; the job still passed, and this log line alone is not evidence of a customer-facing failure. This second-attempt result is a reliability observation, not a code fix or proof of real provider delivery.

Decision at this finding: **FAILED first CI attempt, PASSED second attempt on unchanged code; root cause NOT PROVEN; do not merge or deploy Production on the strength of a retry alone.**

## Local-only WebKit failure diagnostics follow-up

- Re-read the attempt-1 trace. The synthetic booking RPC, card-capability and Wix-create requests returned HTTP 200 within roughly half a second of one another. The browser console showed no JavaScript error, only a Supabase multiple-GoTrueClient warning before submission. The `booking-success` assertion remained pending; later trace evaluation reported `Target crashed`. These observations narrow the sequence but do not prove the durable booking outcome or a browser-versus-application root cause.
- Added a test-only, read-only count of bookings for the freshly seeded salon, recorded only if either mobile booking-submit test fails. The E2E DB helper already rejects Production at module load. Diagnostic output contains only a count or `unavailable`, never booking/customer IDs, phone, email, request body or credentials. A two-second deadline keeps this supplemental read from replacing the original assertion error.
- Verification on this local change: `npx vitest run e2e/helpers/bookingSubmissionDiagnostics.unit.spec.ts` **3/3 PASS** (including a failed diagnostic read that preserves the original assertion); `npm run typecheck` PASS; targeted ESLint PASS. The count callback was unit-tested, but an actual failed WebKit run with a disposable database has **not** yet exercised the new DB read. At this pre-publication checkpoint, this instrumentation was not yet in PR #1429 or its Preview; any later publication must be checked by its exact new head.
- A fresh local Supabase 2.118.0 stack in the dedicated `nailiq-pr1429-qa` Colima profile applied the repository migrations and passed health checks. Using keys obtained only in memory from local CLI status, with the E2E production guard and an independently pinned local service-role key, `countSyntheticSalonBookings` returned **0** for an unused random salon ID: PASS. This validates the actual read path against disposable PostgREST, but not the callback under an intermittent failed WebKit booking or the outcome of the historical failed booking. No salon/booking was inserted for this check and no provider was called.
- A subsequent attempt to run a longer local WebKit stress gate was blocked **before any browser test**: after the disposable stack was stopped without backup, a fresh start under Supabase CLI 2.118.0 failed at the first migration (`20260427120000`) with `schema_migrations_pkey` duplicate. Repeating from a separate minimal local workdir with a distinct project ID and no linked-project metadata produced the same error; the already-cached CLI 2.109.1 did too. Failed starts pruned their local Docker volumes. This is an unresolved local bootstrap issue, not evidence that a browser test failed or that Production schema changed. The repository checkout's `supabase/.temp/project-ref` names Production, so no `db reset` was run from that checkout. The older 20/20 local WebKit PASS and the CI first-attempt FAIL/second-attempt PASS remain the actual browser evidence.
