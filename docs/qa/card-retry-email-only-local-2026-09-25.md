# Card retry email-only — local implementation

Scope approved: implement and test locally; no deployment or real messages.

## Implemented locally

- Explicit `channel: email_only` server action; conflicting/unknown channel rejected.
- Existing SMS-plus-email caller behavior preserved.
- Email-only checks salon membership, role, entitlement, salon email/protection settings,
  booking tenant, future active status, card requirement, and non-ambiguous card state.
- Missing email never falls back to SMS. Email-only skips AI drafting.
- Strict email acceptance requires a provider message ID; not proof of inbox delivery.
- EN/VI email-only button in booking drawer; synchronous ref lock prevents double taps
  while pending; success disables that button for the mounted booking component.
- No booking state, policy or payment changes. A later local-only additive receipt migration is described below.

## Verification

- `npx vitest run src/shared/dashboard/__tests__/sendSaveCardLinkChannel.spec.ts src/shared/lib/sendCustomerLinkEmail.spec.ts src/shared/dashboard/__tests__/addEmailDeliveryTruth.spec.ts`: **28 PASS**, synthetic mocked dependencies only.
- `npm run typecheck`: PASS after fixing one local UI key reference (`booking` -> `deskEdit.booking`). The initial typecheck failure is retained here; no release occurred.
- `npm run build`: PASS on final code (outbound suppression flags set); existing Edge Runtime deprecation warning remains.
- Targeted ESLint and `git diff --check`: PASS. No provider delivery test.

## Initial release gaps (historical; superseded in part below)

- Browser UI interaction tests and isolated Preview validation still required.
- This does **not** implement durable cross-session/concurrent-send idempotency.
  Ref lock is only an in-component guard. Do not describe it as exactly-once delivery.
- Provider acceptance ID is checked but not persisted as a new delivery receipt by this change.
- Email-only creates a fresh short-lived management capability via the existing generator;
  safe reuse of the previously prepared recovery links needs validation before using it for the four live exceptions.
- No real customer email sent, no Production changes, no commit/push/deploy.

Readiness: local channel isolation PASS; end-to-end recovery-email rollout NOT PROVEN.

## Follow-up: UI and shared guard

- 30 mocked unit tests PASS (two additional guard tests: blocked retry and eight contenders with one mock claim winner). This is not a real database race test.
- Added existing DB-backed fixed-window limiter: one email-only attempt per salon/booking per 1200-second bucket, fail closed on limiter outage. No migration.
- Important: this is NOT a rolling 20-minute cooldown and NOT exactly-once delivery. Adjacent buckets can allow two close attempts. Durable delivery receipts/idempotency remain a release gap.
- Chrome computer-use on development-only loopback fixture using the actual SaveCardButton: EN success, EN failure, VI success (keyboard Enter), VI failure all verified. Four mock calls were all `email_only`; pending buttons disabled, success disabled email-only, failures did not claim success. No provider called.
- Initial fixture load failed because local Supabase URL/key were absent; rerun used localhost plus a synthetic non-service key, not QA/Production credentials. This is a fixture configuration failure, not a product regression.
- Fixture route denies non-development or non-loopback access. Browser tab and local server closed after tests.

## Durable receipt follow-up — 2026-09-25

Implemented locally, **not deployed**:

- Replaced the fixed-window limiter in email-only with a dedicated service-only receipt.
- Migration `20260925191112_add_card_retry_email_receipts.sql`, generated with Supabase CLI 2.118.0, adds a unique salon/booking claim, actor and recipient fingerprint, fenced completion, provider acceptance ID and explicit unknown state. No contact address or capability token is stored in this ledger.
- Claim revalidates membership/role, booking tenant, contact fingerprint, future active status, card eligibility and salon settings in a short transaction. RLS is enabled; anon/authenticated cannot read or execute; no security-definer function added.
- Claim never expires automatically. Concurrent/reloaded attempts cannot dispatch after a claim, acceptance or uncertain outcome. Accepted duplicates currently show the generic check-delivery warning, not a new-send success.
- Provider receives a stable idempotency key. Successful UI result requires both provider ID and acknowledged receipt persistence. Unknown/lost provider or DB response never initiates automatic redispatch.
- Email-only respects non-production runtime, outbound email kill-switch (`1/true/yes`), demo guards and durable recipient suppression lookup. Strict provider errors omit raw payload logging. Legacy SMS+email path is unchanged.

Verification:

- `npx vitest run src/shared/dashboard/__tests__/sendSaveCardLinkChannel.spec.ts src/shared/lib/sendCustomerLinkEmail.spec.ts src/shared/notifications/cardRetryEmailReceipt.spec.ts src/shared/dashboard/__tests__/addEmailDeliveryTruth.spec.ts`: **48 PASS**, provider mocked.
- `node scripts/test-card-retry-email-receipts-local.mjs`: **PASS** against PostgreSQL in an isolated local disposable database. Twelve concurrent connections produced one claim and eleven blocks. Checked wrong tenant (including a member of both salons), role, contact mismatch, seven booking-ineligibility cases, RLS/ACL metadata, wrong completion salon/attempt, immutable accepted completion, and unknown outcome remaining blocked after 48 hours.
- Test uses a **minimal synthetic schema**, not the complete migration chain. It created and dropped only `card_retry_receipts_20260925`; existing local QA database untouched.
- Final `npm run typecheck`, targeted `npx eslint` (six touched TypeScript source/test files), `npm run build` with outbound suppression flags, and `git diff --check`: **PASS** after the completion-branch simplification. Existing Vite config and Edge Runtime deprecation warnings remain.
- Current work did not repeat computer-use UI; the four earlier UI cases remain mocked UI evidence only.

Remaining gates, **NOT PROVEN**:

1. Full-schema QA migration rehearsal/advisors, hosted authenticated role/race/retry tests and UI-to-database proof.
2. Capability expiry/reuse and safe retry for the four previously identified live exceptions. This still uses the existing capability generator; do not assume old prepared links remain valid.
3. Deliberate one-recovery-email-per-booking boundary: no automated retry or lease reclamation, even for a pre-provider crash. Operator reconciliation/new-send authorization is required; a repeat-send recovery workflow is not implemented here.
4. This ledger covers only the new email-only action, not all historical SMS/cron email senders. Do not claim system-wide exactly-once delivery.
5. Provider acceptance is not inbox delivery. No real provider or delivery test was performed.

Rollback: disable/revert the new email-only application path first; retain receipt rows for investigation. Do not delete receipts or restart uncertain attempts to force a retry.

No commit, push, PR update, QA/Production migration, deployment or real customer message in this follow-up.

## Approved hosted QA follow-up — 2026-09-25

Huy approved QA migration and isolated Preview verification with no real email.

### Completed on QA

- Verified project `uhpzafoiifupyypkcwln`, `nailiq-p0-03-qa-20260921`, ACTIVE_HEALTHY; no Production SQL was executed.
- Applied `add_card_retry_email_receipts`: local file version `20260925191112`, QA Management API recorded version `20260925193857`. These are the same submitted SQL, different migration-history timestamps; do not blindly replay against QA.
- Performance advisor found missing booking FK index. Created additive local migration `20260925195024_index_card_retry_email_booking.sql`, applied to QA as `20260925195100`.
- RLS true; anon/authenticated have no table SELECT and no RPC EXECUTE. Both RPCs are SECURITY INVOKER; service_role can execute.
- Executed `supabase/tests/card_retry_email_receipts_qa.sql` on full hosted QA schema, including actual `SET LOCAL ROLE service_role` for the new RPCs: PASS. Tested actor rejection, recipient mismatch, first claim, blocked replay, wrong completion attempt, accepted completion/replay, immutable accepted result and one receipt.
- Synthetic auth user, salon, service, staff, booking and receipt were rolled back in the same transaction. Follow-up counts: zero synthetic users/salons/receipts remaining. No provider or cron was invoked.
- Security advisors: no new WARN. Existing WARN counts remain 13 anon-definer, 7 authenticated-definer and 1 leaked-password-protection. INFO `rls_enabled_no_policy` increased 75→76 intentionally for a service-only table with all public grants revoked. Reference: https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy
- Missing FK-index finding resolved. New index has expected INFO `unused_index` on an empty QA receipt table; this is not a permission defect. Reference: https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index

### Preview gate — BLOCKED, not tested

- Existing source Preview branch has correct QA URL/anon key, email/SMS/calls OFF and tested provider credential values blank.
- Correction to intermediate diagnosis: service-role key is **Sensitive**, so `vercel env run` omits it. Its absence in the local process does NOT prove the deployed key is missing. Verified access to the actual QA project's API keys through the authenticated Supabase CLI; no values logged or saved.
- Prepared clean local clone `/private/tmp/nailiq-card-retry-preview.pcz3qX`, branch `qa/card-retry-email-receipts-20260925`; no source overlay, commit or push performed there yet.
- Batch env API attempt failed `Invalid JSON (400)`. CLI alternative gave the decisive blocker: `branch_not_found` in the connected Git repository.
- Checked new-branch environment count after attempts: **0**. No new Preview deployment created. Temporary configuration helper was removed after diagnosis; no credentials were written to files.
- Production target before/after remained `dpl_93ZAvNVmmdpf48sMpLuifg3cTSVf`, SHA `006da9b322d3da154cb2f4bc36a491616957a631`.
- Next approval boundary: commit/push this scoped change on its own branch and create PR/Preview (not PR1428). Then configure only that Preview for QA and run hosted UI suppression/role tests. No merge/Production or real email authorization implied.

Status: hosted QA migration/DB contract PASS; hosted UI/Preview NOT PROVEN. Four real recovery emails remain unsent.

## Approved separate PR packaging — 2026-09-25

- User approved commit/push and a separate Draft PR/Preview, not merge or Production.
- Clean publishing branch `fix/card-retry-email-only-20260925` is based on current main `006da9b322d3da154cb2f4bc36a491616957a631`, not PR1428. Only the scoped card-email changes were copied; unrelated dirty files remain untouched in the original worktree.
- Repeated on this exact branch: 48 unit tests PASS, typecheck PASS, targeted ESLint PASS, production build PASS with outbound suppression, diff check PASS. Providers mocked; no live email sent.
- Production still points to `dpl_93ZAvNVmmdpf48sMpLuifg3cTSVf` at the same main SHA before publishing.
- Hosted Preview isolation and browser verification must be recorded separately after deployment. A Git-generated Preview before branch-specific QA configuration is not QA-safe evidence.

## PR1429 first hosted/CI attempt

- Published scoped commit `7565f592`; PR1429 remains Draft.
- Configured 60 branch-only Preview variables; QA ref `uhpzafoiifupyypkcwln`, no provider credentials, dispatch/email/SMS/calls disabled. Secrets transferred in memory only. Unrelated environment metadata and Production target unchanged.
- CLI deployment `dpl_HMLwoi3Nje9HNE6uqzS469Gua2Kj` lacked Git branch metadata: not accepted as QA isolation evidence; no login submitted there.
- Redeployed Git-backed commit as `dpl_CdpfNmXHSdA2rvcM22AMUeYhwqYH`, READY, exact SHA/branch verified. URL: https://nailiq-kwne382ow-bepnhobencha-2588s-projects.vercel.app . This deployment is BEFORE the parity-only correction below.
- Initial CI attempt FAILED at schema parity before E2E: actual 247 tables / 3813 columns / 602 functions / 1015 indexes and service_role reachability 235, versus stale 246 / 3803 / 600 / 1012 / 234. This matches the exact additive migration delta. Preserve run `36183910672` and folded-history run `36183910580`; a transient image-pull rate limit also appeared but did not explain the final parity failure.
- Corrected release-shape counts and added an explicit service-only receipt/RPC security assertion rather than relaxing browser-role counts. QA read-only verification confirmed RLS, browser denial, service grants and two invoker RPCs.
- First CI build/typecheck, security audit, visual regression, i18n and focused browser jobs passed. Full E2E was blocked by parity, not passed. Follow-up CI must run on the corrected commit.
