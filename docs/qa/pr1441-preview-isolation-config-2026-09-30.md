# PR #1441 — Preview isolation configuration receipt

## Scope

- Authorized target: NailIQ Vercel project, Preview only, branch `qa/masterplan-day21-pilot-kit-20260929`.
- Local hotfix commit: `d5bcd19b0690a3a68645ac1af4013a2f0573a8fe`.
- Approved Supabase QA project: `uhpzafoiifupyypkcwln` (`nailiq-p0-03-qa-20260921`); project listing reported `ACTIVE_HEALTHY`.
- No Production mutation, database migration, application/cron/provider invocation, booking, or notification in this configuration step.
- No secret values are included in this receipt.

## Verified configuration

Created the following 19 branch-scoped Preview configuration entries. Each entry's exact value was independently read back using the decrypted single-entry API endpoint; all 19 matched. Metadata confirmed the exact branch and Preview-only target.

| Configuration key | Verified value |
| --- | --- |
| DISABLE_OUTBOUND_SMS | 1 |
| DISABLE_OUTBOUND_EMAIL | 1 |
| DISABLE_OUTBOUND_CALLS | 1 |
| NAILIQ_CARD_SAVE_DISPATCH_DISABLED | true |
| PAYMENT_LEDGER_WORKERS_ENABLED | false |
| NAILIQ_APPROVED_NO_SHOW_CHARGE_DISPATCH | false |
| NAILIQ_APPROVED_CANCELLATION_FEE_DISPATCH | false |
| NAILIQ_SQUARE_PAYMENT_WEBHOOK_INGESTION | false |
| SMART_CHECKOUT_SANDBOX_WEBHOOK_INGESTION_ENABLED | 0 |
| SMART_CHECKOUT_SANDBOX_DISPATCH_ENABLED | 0 |
| SMART_CHECKOUT_SANDBOX_PROVIDER_READS_ENABLED | 0 |
| SMART_CHECKOUT_SANDBOX_PAIRING_ENABLED | 0 |
| SMART_CHECKOUT_RECONCILIATION_ENABLED | 0 |
| BULK_EMAIL_CAMPAIGN_DISPATCH_ENABLED | false |
| SQUARE_EMAIL_CONSENT_SYNC | 0 |
| SQUARE_EMAIL_CONSENT_SEND | 0 |
| BOOKING_CARD_RECONCILIATION_ENABLED | false |
| BOOKING_CARD_CONTINUATION_RECONCILIATION_ENABLED | false |
| NOSHOW_CARD_NUDGE_ENABLED | 0 |

Production environment metadata comparison before/after these writes was unchanged. This is metadata evidence, not a new Production runtime test.

## Transport diagnosis

- Initial array-shaped POST requests returned HTTP 400 `Invalid JSON`; a follow-up inventory confirmed no branch entries had been created by those attempts.
- The installed CLI serializes object bodies but not array bodies in this API path. Individual object-shaped requests succeeded. No CLI/library modification or protection bypass was performed.
- The list endpoint returned encrypted values even when requesting decryption. Equality failures from that endpoint did not indicate wrong saved values; no entries were rewritten on that assumption.
- `GET /v1/projects/{project}/env/{id}` returned decrypted Config values. Sequential readback completed with exit code 0: `count=19`, `allVerified=true`, `deploymentTriggered=false`.

## Remaining boundary / status

- **Passed:** 19 configuration writes and authoritative readback; branch/Preview scope; unchanged Production metadata.
- **Passed source-key verification:** The user completed Supabase login. The browser showed the approved QA project; existing legacy keys were read into session memory only. Both JWTs had the approved QA `ref`, with roles `anon` and `service_role` respectively. No key/token creation, rotation, file persistence, or printed secret.
- **Blocked:** Chrome Vercel is signed out. Its `Continue with GitHub` action was rejected before execution; explicit approval for the named GitHub account `bepnhobencha-rgb` is pending. It has not been retried or bypassed. The earlier Supabase login block was resolved by the user's login.
- **Not proven:** QA URL/anon/service-role key transfer and matching; deployment runtime environment isolation; all provider-path suppression; hosted MFA regression/CI at the local hotfix head.
- **Not performed:** push, Preview redeployment, Ready/merge, Production deployment, migration, provider call, notification.

Do not push the hotfix or trigger a Preview build until the Supabase QA credentials and target are verified. Existing local test results remain distinct from hosted verification. Preserve the existing untracked MFA diagnostic and test-results directory.

Current GitHub readback: PR #1441 is OPEN/Draft at `87ba36f5b53af0550f84ededcbc38b2a27263bd1`; the MFA browser check remains FAILURE. No new-head CI or live process is pending from this step.
